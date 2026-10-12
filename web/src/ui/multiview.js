/*
 * WebMIX - Multiview.
 *
 * OBS shows every scene in a grid in its own window (View > Multiview). There is
 * no window to open here, so this renders the same grid as a full-screen overlay:
 * OBS composes the tiles and streams them as one MJPEG stream
 * (`/api/preview/multiview.mjpg`), which is drawn with WebGPU when available and
 * otherwise handed straight to an <img> - browsers decode multipart JPEG
 * streams natively.
 *
 * Scene labels are HTML positioned over the grid, using the same layout maths
 * as the server so the two always line up.
 */
import { h, clear, setClass } from '../dom.js';
import { WebGpuPreview, openMjpegStream } from '../webgpu-preview.js';

const STREAM_FPS = 10;

/** Grid geometry shared with the server's composition. */
export function gridLayout(count) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))));
  const rows = Math.max(1, Math.ceil(Math.max(1, count) / columns));
  return { columns, rows };
}

/**
 * Open the multiview overlay.
 * @param {object} options
 * @param {import('../store.js').Store} options.store
 * @param {(text: string, kind?: string) => void} [options.onStatus]
 * @returns {Promise<{close: () => void}>}
 */
export async function openMultiview({ store, onStatus }) {
  const frame = h('div.obs-multiview-frame');
  const labels = h('div.obs-multiview-labels');
  const status = h('div.obs-multiview-status.obs-muted');
  const closeButton = h('button.obs-btn.obs-multiview-close', { type: 'button', text: 'Close' });
  const overlay = h('div.obs-multiview', {}, [
    h('div.obs-multiview-bar', {}, [
      h('span.obs-multiview-title', { text: 'Multiview' }),
      status,
      closeButton,
    ]),
    h('div.obs-multiview-body', {}, [frame]),
  ]);
  /* The labels live inside the frame: they are positioned in percentages of
   * the grid, so they have to share its box. */
  frame.appendChild(labels);
  document.body.appendChild(overlay);

  let closed = false;
  let renderer = null;
  let media = null;
  let abort = null;
  let pending = null;
  let streamCount = 0;

  const sceneNames = () => store.state.scenes.map((scene) => scene.sceneName);

  /** (Re)draw the label grid and, if needed, restart the stream. */
  const renderLabels = () => {
    const scenes = sceneNames();
    const { columns, rows } = gridLayout(scenes.length);
    const program = store.state.currentProgramScene;

    clear(labels);
    scenes.forEach((name, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const cell = h('div.obs-multiview-label', {
        text: name,
        raw: true,
        style: {
          left: `${(column * 100) / columns}%`,
          top: `${(row * 100) / rows}%`,
          width: `${100 / columns}%`,
          height: `${100 / rows}%`,
        },
      });
      if (name === program) {
        cell.appendChild(h('span.obs-badge.live', { text: 'PROGRAM' }));
      }
      labels.appendChild(cell);
    });

    fitFrame();
  };

  /*! Width over height of the whole grid: tiles have the canvas's shape. */
  const gridAspect = () => {
    const { columns, rows } = gridLayout(sceneNames().length);
    const video = store.state.video ?? {};
    const tile = (video.baseWidth || 1920) / (video.baseHeight || 1080);
    return (columns * tile) / rows;
  };

  /*! Give the frame the largest size of that shape the overlay has room for. */
  const fitFrame = () => {
    const body = frame.parentElement;
    if (!body) return;
    const style = getComputedStyle(body);
    const roomWidth = body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const roomHeight = body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (roomWidth <= 0 || roomHeight <= 0) return;
    const aspect = gridAspect();
    const width = Math.min(roomWidth, roomHeight * aspect);
    frame.style.width = `${Math.floor(width)}px`;
    frame.style.height = `${Math.floor(width / aspect)}px`;
  };

  /** Start the multiview stream (size chosen for the overlay's pixel budget). */
  const startStream = async () => {
    const scenes = sceneNames();
    if (!scenes.length) {
      status.textContent = 'No scenes to show';
      return;
    }

    const { columns } = gridLayout(scenes.length);
    /* Enough for the screen it is shown on, in the grid's own shape - a
     * square picture squeezed 16:9 tiles into letterboxes. */
    const width = Math.min(1920, Math.max(480 * columns, Math.ceil(frame.clientWidth / 160) * 160));
    const height = Math.round(width / gridAspect());
    streamCount = scenes.length;
    const url =
      `api/preview/multiview.mjpg?width=${width}&height=${height}` +
      `&fps=${STREAM_FPS}&quality=80`;

    /* WebGPU renders into a canvas; without it the <img> below decodes the
     * multipart stream natively. */
    const canvas = h('canvas.obs-multiview-canvas');
    frame.replaceChildren(canvas, labels);
    renderer = await WebGpuPreview.create(canvas);
    if (renderer) {
      abort = new AbortController();
      openMjpegStream(url, {
        signal: abort.signal,
        onFrame: async (jpeg) => {
          if (closed || pending) return; // drop rather than queue
          pending = true;
          let bitmap = null;
          try {
            bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
            renderer.resize();
            renderer.draw(bitmap);
            status.textContent = `${width}x${height} - WebGPU`;
          } catch (err) {
            status.textContent = `stream error: ${err?.message ?? err}`;
          } finally {
            const previous = media;
            media = bitmap;
            previous?.close?.();
            pending = false;
          }
        },
        onError: () => {
          if (!closed) status.textContent = 'Multiview stream stopped';
        },
      });
      return;
    }

    /* No WebGPU: let the browser decode the multipart stream directly. */
    const img = h('img.obs-multiview-image', { src: url, alt: 'Multiview' });
    frame.replaceChildren(img, labels);
    status.textContent = `${width}x${height}`;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    abort?.abort();
    media?.close?.();
    renderer?.destroy?.();
    unsubscribe?.();
    window.removeEventListener('resize', fitFrame);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);

  /* The picture's shape follows the number of scenes; when that changes the
   * stream has to be reopened at the new size, or the old grid is stretched
   * under the new labels. */
  const unsubscribe = store.subscribe(() => {
    renderLabels();
    if (closed || sceneNames().length === streamCount) return;
    abort?.abort();
    renderer?.destroy?.();
    renderer = null;
    startStream();
  });
  window.addEventListener('resize', fitFrame);

  renderLabels();
  await startStream();
  onStatus?.('Multiview opened', 'info');

  return { close };
}
