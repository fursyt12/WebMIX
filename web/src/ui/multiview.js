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
    h('div.obs-multiview-body', {}, [frame, labels]),
  ]);
  document.body.appendChild(overlay);

  let closed = false;
  let renderer = null;
  let media = null;
  let abort = null;
  let pending = null;

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

    frame.style.aspectRatio = `${columns} / ${rows}`;
    void rows;
  };

  /** Start the multiview stream (size chosen for the overlay's pixel budget). */
  const startStream = async () => {
    const scenes = sceneNames();
    if (!scenes.length) {
      status.textContent = 'No scenes to show';
      return;
    }

    const { columns, rows } = gridLayout(scenes.length);
    const width = Math.min(1920, 320 * columns);
    const height = Math.round((width * rows) / columns);
    const url =
      `api/preview/multiview.mjpg?width=${width}&height=${height}` +
      `&fps=${STREAM_FPS}&quality=80`;

    /* WebGPU renders into a canvas; without it the <img> below decodes the
     * multipart stream natively. */
    const canvas = h('canvas.obs-multiview-canvas');
    clear(frame);
    frame.appendChild(canvas);
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
    clear(frame);
    frame.appendChild(img);
    status.textContent = `${width}x${height}`;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    abort?.abort();
    media?.close?.();
    renderer?.destroy?.();
    unsubscribe?.();
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

  const unsubscribe = store.subscribe(() => renderLabels());

  renderLabels();
  await startStream();
  onStatus?.('Multiview opened', 'info');

  return { close };
}
