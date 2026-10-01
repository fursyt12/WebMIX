/*
 * WebMIX - preview / program canvas.
 *
 * Rendering has two backends:
 *
 *  - **WebGPU** (preferred): OBS streams JPEG frames over one HTTP connection
 *    (`/api/preview.mjpg`, served by the embedded WebMIX server) and they are
 *    decoded with `createImageBitmap` and drawn as an aspect-fitted quad by a
 *    WGSL shader.  Scaling, zoom and letterboxing happen on the GPU.
 *  - **Screenshots** (fallback): when the UI is served by an external static
 *    server (no preview endpoint) or WebGPU is unavailable, frames come from
 *    the obs-websocket `GetSourceScreenshot` request and are painted into an
 *    `<img>`.
 *
 * In Studio Mode OBS shows Preview (left) and Program (right); the same layout
 * is reproduced here.
 */
import { h, clear, setClass } from '../dom.js';
import { showContextMenu } from './dialog.js';
import { WebGpuPreview, webgpuAvailable, openMjpegStream } from '../webgpu-preview.js';

const PREVIEW_FPS = 15;

export class PreviewPanel {
  /**
   * @param {object} options
   * @param {import('../store.js').Store} options.store
   * @param {import('../api.js').ObsApi} options.api
   * @param {HTMLElement} options.canvas
   * @param {HTMLElement} options.labels
   * @param {HTMLElement} options.placeholder
   * @param {object} [options.host]  result of detectHost(): enables the stream endpoint
   * @param {(action: string, payload?: any) => void} options.onContextAction
   */
  constructor({ store, api, canvas, labels, placeholder, onContextAction, host = {} }) {
    this.store = store;
    this.api = api;
    this.canvas = canvas;
    this.labels = labels;
    this.placeholder = placeholder;
    this.onContextAction = onContextAction;
    this.host = host;

    this.fps = 5; // screenshot fallback rate
    this.streamFps = PREVIEW_FPS;
    this.scaling = 'window'; // window | canvas | output
    this.zoom = 1;
    this.locked = false;
    this.running = false;
    this.timer = null;
    this.errorCount = 0;
    this.useWebgpu = false;
    this.surfaces = []; // [{ kind, scene, img?, canvas?, renderer?, abort?, busy? }]

    this.onVisibility = () => this.#schedule(0);
    this.onResize = () => this.#resizeSurfaces();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('resize', this.onResize);

    this.#buildSurfaces();
  }

  /** Decide the backend once, before the first frame is drawn. */
  async init() {
    this.useWebgpu = Boolean(this.host?.previewStream) && (await webgpuAvailable());
    this.#buildSurfaces();
    return this.useWebgpu;
  }

  get backend() {
    return this.useWebgpu ? 'webgpu' : 'screenshot';
  }

  #sceneFor(kind) {
    const state = this.store.state;
    return kind === 'preview' ? state.currentPreviewScene : state.currentProgramScene;
  }

  #buildSurfaces() {
    this.#stopStreams();
    clear(this.canvas);
    this.surfaces = [];

    const state = this.store.state;
    const studio = state.studioMode;
    const kinds = studio ? ['preview', 'program'] : ['program'];

    for (const kind of kinds) {
      const scene = this.#sceneFor(kind);
      let frame;
      if (this.useWebgpu) {
        frame = h('canvas.obs-preview-image.obs-preview-gpu', { width: '640', height: '360' });
      } else {
        frame = h('img.obs-preview-image', { alt: '', draggable: 'false' });
        frame.addEventListener('error', () => pane.classList.add('is-broken'));
      }

      const label = h('div.obs-preview-label', {
        class: kind === 'program' ? 'is-program' : 'is-preview',
        text: kind === 'program' ? 'Program' : 'Preview',
      });
      if (!studio) label.hidden = true;

      const pane = h(`div.obs-preview-pane.is-${kind}`, {}, [label, frame]);
      this.canvas.appendChild(pane);

      const surface = { kind, scene, pane, img: this.useWebgpu ? null : frame, canvas: this.useWebgpu ? frame : null };
      this.surfaces.push(surface);

      if (this.useWebgpu) {
        WebGpuPreview.create(frame).then((renderer) => {
          if (!renderer) {
            // WebGPU disappeared between the probe and now: fall back.
            this.useWebgpu = false;
            this.#buildSurfaces();
            this.#schedule(0);
            return;
          }
          surface.renderer = renderer;
          this.#startStream(surface);
          this.#watchWebgpu(surface);
        });
      } else {
        frame.addEventListener('click', () => {
          if (this.locked || !surface.scene) return;
          this.api.setProgramScene(surface.scene).catch((err) => this.#report(err));
        });
      }
    }

    this.labels.hidden = true;
    this.canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.#openContextMenu(event);
    });

    this.#applyScaling();
    this.render();
    if (this.running) this.#schedule(0);
  }

  #stopStreams() {
    for (const surface of this.surfaces) {
      surface.abort?.abort();
      surface.abort = null;
      surface.renderer?.destroy?.();
    }
  }

  /**
   * Open the MJPEG stream for one pane. Frames are dropped while the previous
   * one is still being decoded, so a slow decoder never builds a backlog.
   */
  #startStream(surface) {
    const scene = this.#sceneFor(surface.kind);
    if (!scene || !surface.renderer) return;

    surface.abort?.abort();
    surface.abort = new AbortController();
    surface.scene = scene;
    surface.busy = false;

    const state = this.store.state;
    const video = state.video ?? {};
    const targetWidth = Math.max(160, Math.min(1920, video.baseWidth || 1280));
    const targetHeight = Math.round((targetWidth * (video.baseHeight || 720)) / (video.baseWidth || 1280));

    const url =
      `api/preview.mjpg?source=${encodeURIComponent(scene)}` +
      `&width=${targetWidth}&height=${targetHeight}&fps=${this.streamFps}&quality=75`;

    openMjpegStream(url, {
      signal: surface.abort.signal,
      onFrame: async (jpeg) => {
        surface.received = (surface.received ?? 0) + 1;
        if (surface.busy) {
          surface.dropped = (surface.dropped ?? 0) + 1;
          return; // drop the frame rather than queue it
        }
        surface.busy = true;
        let bitmap = null;
        try {
          bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
          if (!surface.renderer) throw new Error('renderer gone');
          surface.lastSize = [bitmap.width, bitmap.height];
          surface.renderer.resize?.();
          surface.renderer.draw(bitmap);
          surface.drawn = (surface.drawn ?? 0) + 1;
          surface.pane.classList.remove('is-empty', 'is-broken');
        } catch (err) {
          surface.lastError = String(err?.message ?? err);
        } finally {
          /* Close the *previous* frame, not this one: closing an ImageBitmap
           * before the GPU has executed the texture copy makes
           * copyExternalImageToTexture fail. A one-frame delay is enough. */
          const previous = surface.bitmap;
          surface.bitmap = bitmap;
          previous?.close?.();
          surface.busy = false;
        }
      },
      onError: (err) => {
        if (this.running) this.#report(err, true);
      },
    });
  }

  /*!
   * Some browsers create a WebGPU device and then paint nothing - the preview
   * stays empty with no error anywhere. If no frame has been drawn a few
   * seconds after the stream started, drop to the screenshot backend, which
   * needs no GPU at all.
   */
  #watchWebgpu(surface) {
    setTimeout(() => {
      if (!this.useWebgpu || !this.surfaces.includes(surface)) return;
      if ((surface.drawn ?? 0) > 0) return;
      console.warn(
        '[WebMIX] WebGPU drew no frames; falling back to the screenshot preview',
        surface.lastError ?? ''
      );
      this.useWebgpu = false;
      this.#buildSurfaces();
      this.#schedule(0);
    }, 3000);
  }

  #restartStreamsIfNeeded() {
    if (!this.useWebgpu) return;
    for (const surface of this.surfaces) {
      const scene = this.#sceneFor(surface.kind);
      if (scene !== surface.scene) this.#startStream(surface);
    }
  }

  #resizeSurfaces() {
    for (const surface of this.surfaces) surface.renderer?.resize?.();
    this.#applyScaling();
  }

  #openContextMenu(event) {
    const state = this.store.state;
    showContextMenu(
      { x: event.clientX, y: event.clientY },
      [
        { label: 'Enable Preview', hidden: !state.previewDisabled, action: () => this.onContextAction?.('enablePreview') },
        { label: 'Lock Preview', checked: this.locked, action: () => this.onContextAction?.('lockPreview') },
        { separator: true },
        { label: 'Screenshot Preview', disabled: !state.currentProgramScene, action: () => this.onContextAction?.('screenshotPreview') },
        { label: 'Screenshot Source', disabled: !state.currentProgramScene, action: () => this.onContextAction?.('screenshotSource') },
        { label: 'Screenshot Scene', disabled: !state.currentProgramScene, action: () => this.onContextAction?.('screenshotScene') },
        { separator: true },
        { label: 'Scale to Window', checked: this.scaling === 'window', action: () => this.onContextAction?.('scaleWindow') },
        { label: 'Scale to Canvas', checked: this.scaling === 'canvas', action: () => this.onContextAction?.('scaleCanvas') },
        { label: 'Scale to Output', checked: this.scaling === 'output', action: () => this.onContextAction?.('scaleOutput') },
        { separator: true },
        { label: 'Zoom In', action: () => this.onContextAction?.('previewZoomIn') },
        { label: 'Zoom Out', action: () => this.onContextAction?.('previewZoomOut') },
        { label: 'Reset Zoom', action: () => this.onContextAction?.('previewResetZoom') },
        { separator: true },
        { label: `Renderer: ${this.backend === 'webgpu' ? 'WebGPU' : 'Screenshots'}`, disabled: true },
      ]
    );
  }

  setFps(fps) {
    this.fps = Math.max(0, Math.min(30, fps));
    this.#schedule(0);
  }

  setLocked(locked) {
    this.locked = locked;
  }

  setScaling(mode) {
    this.scaling = mode;
    this.#applyScaling();
  }

  setZoom(zoom) {
    this.zoom = Math.max(0.1, Math.min(8, zoom));
    this.#applyScaling();
  }

  zoomIn() {
    this.setZoom(this.zoom * 1.25);
  }
  zoomOut() {
    this.setZoom(this.zoom / 1.25);
  }
  resetZoom() {
    this.setZoom(1);
  }

  #applyScaling() {
    const state = this.store.state;
    const video = state.video ?? {};
    let base = null;
    if (this.scaling === 'canvas') base = { w: video.baseWidth, h: video.baseHeight };
    if (this.scaling === 'output') base = { w: video.outputWidth, h: video.outputHeight };

    for (const surface of this.surfaces) {
      const element = surface.canvas ?? surface.img;
      if (!element) continue;

      if (surface.renderer) {
        // The GPU path handles aspect fitting in the shader; zoom is folded
        // into the same transform.
        surface.renderer.zoom = this.zoom;
        surface.renderer.scaling = this.scaling;
        surface.renderer.baseSize = base;
        surface.renderer.resize?.();
        continue;
      }

      element.style.transform = this.zoom !== 1 ? `scale(${this.zoom})` : '';
      if (base?.w && base?.h) {
        element.style.maxWidth = 'none';
        element.style.maxHeight = 'none';
        element.style.width = `${base.w}px`;
        element.style.height = `${base.h}px`;
        surface.pane.style.overflow = 'auto';
      } else {
        element.style.width = '';
        element.style.height = '';
        element.style.maxWidth = '100%';
        element.style.maxHeight = '100%';
        surface.pane.style.overflow = 'hidden';
      }
    }
  }

  /** Rebuild the DOM (studio mode toggles, scene changes). */
  render() {
    const state = this.store.state;
    const expected = state.studioMode ? 2 : 1;
    if (this.surfaces.length !== expected) {
      this.#buildSurfaces();
      return;
    }

    for (const surface of this.surfaces) {
      surface.scene = this.#sceneFor(surface.kind);
    }
    this.#restartStreamsIfNeeded();

    const anyScene = Boolean(state.currentProgramScene || state.currentPreviewScene);
    this.placeholder.hidden = anyScene;
    setClass(this.canvas, 'is-empty', !anyScene);
    this.placeholder.replaceChildren(
      h('div.obs-preview-empty-title', {
        text: state.connection.status === 'connected' ? 'No scenes' : 'Not connected',
      }),
      h('div.obs-muted', {
        text:
          state.connection.status === 'connected'
            ? 'Add a scene to start previewing'
            : 'Connect to OBS to see the preview',
      })
    );
  }

  start() {
    this.running = true;
    this.#schedule(0);
    if (this.useWebgpu) {
      for (const surface of this.surfaces) this.#startStream(surface);
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.#stopStreams();
  }

  destroy() {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onResize);
  }

  #schedule(delay) {
    clearTimeout(this.timer);
    if (!this.running || this.useWebgpu) return;
    const interval = this.fps > 0 ? Math.round(1000 / this.fps) : 1000;
    this.timer = setTimeout(() => this.#tick(), Math.max(delay, interval));
  }

  async #tick() {
    if (!this.running || this.useWebgpu) return;
    if (document.hidden || !this.api.connected || this.fps === 0) {
      this.#schedule(500);
      return;
    }
    await this.#captureAll();
    this.#schedule(0);
  }

  async #captureAll() {
    const state = this.store.state;
    const video = state.video ?? {};
    const targetW = Math.max(160, Math.min(1280, video.baseWidth || 1280));
    const targetH = Math.round((targetW * (video.baseHeight || 720)) / (video.baseWidth || 1280));

    for (const surface of this.surfaces) {
      const scene = this.#sceneFor(surface.kind);
      if (!scene) {
        surface.img?.removeAttribute('src');
        surface.pane.classList.add('is-empty');
        continue;
      }
      surface.scene = scene;
      try {
        const dataUrl = await this.api.getSourceScreenshot(scene, {
          format: 'jpg',
          width: targetW,
          height: targetH,
          quality: 70,
        });
        if (dataUrl && surface.img) {
          surface.img.src = dataUrl;
          surface.pane.classList.remove('is-empty', 'is-broken');
        }
        this.errorCount = 0;
      } catch (err) {
        this.errorCount++;
        if (this.errorCount === 3) this.#report(err, true);
      }
    }
  }

  #report(err, quiet = false) {
    const message = err?.message ?? String(err);
    if (!quiet) console.warn('[preview]', message);
    this.store.notify('ui');
    this.onContextAction?.('previewError', message);
  }
}
