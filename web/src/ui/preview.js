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
import { selectors } from '../store.js';

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
  constructor({ store, api, canvas, labels, placeholder, onContextAction, onSelectSource, host = {} }) {
    this.store = store;
    this.api = api;
    this.canvas = canvas;
    this.labels = labels;
    this.placeholder = placeholder;
    this.onContextAction = onContextAction;
    this.onSelectSource = onSelectSource;
    this.host = host;

    /* Source selected in the preview: the name, and the item being dragged. */
    this.selected = null;
    this.drag = null;

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

      const selection = h(
        'div.obs-preview-selection',
        { hidden: true },
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((dir) =>
          h(`div.obs-preview-handle.is-${dir}`, { dataset: { handle: dir } })
        )
      );
      const pane = h(`div.obs-preview-pane.is-${kind}`, {}, [label, frame, selection]);
      this.canvas.appendChild(pane);

      const surface = { kind, scene, pane, frame, selection,
        img: this.useWebgpu ? null : frame, canvas: this.useWebgpu ? frame : null };
      this.surfaces.push(surface);
      this.#wireSelection(surface);

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

  /* ------------------------------------------------- preview interaction */

  /** Selected source, e.g. when the Sources dock changes the selection. */
  select(name) {
    this.selected = name ?? null;
    this.#renderSelection();
  }

  /*! Client coordinates -> scene pixels, or null when the point is outside. */
  #scenePoint(surface, event) {
    const box = surface.frame.getBoundingClientRect();
    if (!box.width || !box.height) return null;

    const video = this.store.state.video ?? {};
    const baseWidth = video.baseWidth || 1920;
    const baseHeight = video.baseHeight || 1080;

    /* The frame is drawn with object-fit: contain, so the picture can be
     * letterboxed inside the element; work in the picture's box. */
    const scale = Math.min(box.width / baseWidth, box.height / baseHeight);
    /* A pane that has not been laid out yet would turn a pixel of movement into
     * hundreds of scene units; ignore the interaction instead. */
    if (!(scale > 0.05)) return null;
    const drawnWidth = baseWidth * scale;
    const drawnHeight = baseHeight * scale;
    const left = box.left + (box.width - drawnWidth) / 2;
    const top = box.top + (box.height - drawnHeight) / 2;

    const x = (event.clientX - left) / scale;
    const y = (event.clientY - top) / scale;
    if (x < 0 || y < 0 || x > baseWidth || y > baseHeight) return null;
    return { x, y, scale, left, top, drawnWidth, drawnHeight };
  }

  /*! The item's transform: from the store when OBS reported a change, else the
   *  one this panel fetched (GetSceneItemList carries no transforms). */
  #transformFor(surface, item) {
    const cached = this.transforms?.get(`${surface.scene}:${item.sceneItemId}`);
    return item.sceneItemTransform ?? cached ?? null;
  }

  /*! Ask OBS for the transforms of this scene's items, once per item. */
  #ensureTransforms(surface) {
    this.transforms ??= new Map();
    this.transformPending ??= new Set();
    for (const item of selectors.sceneItems(this.store.state, surface.scene)) {
      if (item.sceneItemTransform) continue;
      const key = `${surface.scene}:${item.sceneItemId}`;
      if (this.transformPending.has(key)) continue;
      this.transformPending.add(key);
      this.api
        .getSceneItemTransform(surface.scene, item.sceneItemId)
        .then((transform) => {
          if (transform) {
            this.transforms.set(key, transform);
            this.#renderSelection();
          }
        })
        .catch(() => { /* removed meanwhile */ })
        .finally(() => this.transformPending.delete(key));
    }
  }

  /*! The item's box in scene coordinates (rotation and crop are ignored). */
  #itemBox(surface, item) {
    const t = this.#transformFor(surface, item);
    if (!t) return null;
    const width = Math.abs(t.width * t.scaleX);
    const height = Math.abs(t.height * t.scaleY);
    const anchorX = t.alignment & 1 ? 0 : t.alignment & 2 ? 1 : 0.5;
    const anchorY = t.alignment & 4 ? 0 : t.alignment & 8 ? 1 : 0.5;
    return { left: t.positionX - anchorX * width, top: t.positionY - anchorY * height, width, height, anchorX, anchorY, transform: t };
  }

  #sceneItems(surface) {
    return selectors.sceneItems(this.store.state, surface.scene);
  }

  /** Top-most item under a scene point (index 0 is the top of the list). */
  #hitTest(surface, point) {
    for (const item of this.#sceneItems(surface)) {
      const box = this.#itemBox(surface, item);
      if (!box || !item.sceneItemEnabled) continue;
      if (point.x >= box.left && point.x <= box.left + box.width && point.y >= box.top && point.y <= box.top + box.height) {
        return item;
      }
    }
    return null;
  }

  #wireSelection(surface) {
    const { pane } = surface;

    pane.addEventListener('pointerdown', (event) => {
      // A failure here must never break the preview (or the click-to-switch
      // scene behaviour that also lives on this element).
      try {
        this.#beginDrag(surface, event);
      } catch (err) {
        console.warn('[WebMIX] preview interaction failed', err);
      }
    });

    pane.addEventListener('pointermove', (event) => {
      try {
        this.#moveDrag(surface, event);
      } catch (err) {
        console.warn('[WebMIX] preview drag failed', err);
        this.drag = null;
      }
    });

    const finish = (event) => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.drag = null;
      try { pane.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    };
    pane.addEventListener('pointerup', finish);
    pane.addEventListener('pointercancel', finish);
    pane.addEventListener('dblclick', () => this.onContextAction?.('transform', { source: this.selected }));
  }

  #beginDrag(surface, event) {
    if (this.locked || event.button !== 0) return;
    {
      const point = this.#scenePoint(surface, event);
      if (!point) return;
      this.#ensureTransforms(surface);

      const handle = event.target.closest('.obs-preview-handle')?.dataset.handle;
      const item = handle
        ? this.#sceneItems(surface).find((i) => i.sourceName === this.selected)
        : this.#hitTest(surface, point);
      if (!item) {
        this.selected = null;
        this.#renderSelection();
        return;
      }

      this.selected = item.sourceName;
      this.onSelectSource?.(item.sourceName);
      this.#renderSelection();

      const box = this.#itemBox(surface, item);
      if (!box) return;
      this.drag = {
        surface,
        pointerId: event.pointerId,
        handle: handle ?? null,
        sceneItemId: item.sceneItemId,
        startX: point.x,
        startY: point.y,
        box,
        pending: null,
        sent: 0,
      };
      try {
        surface.pane.setPointerCapture(event.pointerId);
      } catch {
        /* Synthetic or already-released pointers cannot be captured; the pane
         * still receives the move events. */
      }
      event.preventDefault();
    }
  }

  #moveDrag(surface, event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    {
      const point = this.#scenePoint(surface, event);
      if (!point) return;

      const dx = point.x - drag.startX;
      const dy = point.y - drag.startY;
      const patch = drag.handle ? this.#resizePatch(drag, dx, dy) : { positionX: drag.box.transform.positionX + dx, positionY: drag.box.transform.positionY + dy };

      /* Draw immediately, then tell OBS; the next store update confirms it. */
      drag.pending = patch;
      this.#applyDrag(surface, drag);
    }
  }

  /*! New scale/position for a handle drag, keeping the opposite side fixed. */
  #resizePatch(drag, dx, dy) {
    const { box, handle } = drag;
    const t = box.transform;
    let left = box.left;
    let top = box.top;
    let width = box.width;
    let height = box.height;

    if (handle.includes('w')) {
      width = Math.max(4, box.width - dx);
      left = box.left + (box.width - width);
    } else if (handle.includes('e')) {
      width = Math.max(4, box.width + dx);
    }
    if (handle.includes('n')) {
      height = Math.max(4, box.height - dy);
      top = box.top + (box.height - height);
    } else if (handle.includes('s')) {
      height = Math.max(4, box.height + dy);
    }

    return {
      scaleX: (width / t.width) * Math.sign(t.scaleX || 1),
      scaleY: (height / t.height) * Math.sign(t.scaleY || 1),
      positionX: left + box.anchorX * width,
      positionY: top + box.anchorY * height,
    };
  }

  /*! Send a drag patch, at most a few times per second. */
  #applyDrag(surface, drag) {
    const now = performance.now();
    if (drag.sent && now - drag.sent < 33) return;
    drag.sent = now;
    const patch = drag.pending;
    if (!patch) return;
    this.api
      .setSceneItemTransform(surface.scene, drag.sceneItemId, { ...patch })
      .catch((err) => this.#report(err, true));

    /* Keep the overlay in step without waiting for the round trip. */
    const item = this.#sceneItems(surface).find((i) => i.sceneItemId === drag.sceneItemId);
    if (item?.sceneItemTransform) {
      Object.assign(item.sceneItemTransform, patch);
      this.#renderSelection();
    }
  }

  /** Draw the selection rectangle and its handles over the selected item. */
  #renderSelection() {
    for (const surface of this.surfaces) {
      const { selection, pane, frame } = surface;
      if (!selection) continue;

      const item = this.selected
        ? this.#sceneItems(surface).find((i) => i.sourceName === this.selected)
        : null;
      const box = item && this.#itemBox(surface, item);
      const frameBox = frame.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      if (!box || !frameBox.width) {
        selection.hidden = true;
        continue;
      }

      const video = this.store.state.video ?? {};
      const scale = Math.min(frameBox.width / (video.baseWidth || 1920), frameBox.height / (video.baseHeight || 1080));
      const offsetX = frameBox.left - paneBox.left + (frameBox.width - (video.baseWidth || 1920) * scale) / 2;
      const offsetY = frameBox.top - paneBox.top + (frameBox.height - (video.baseHeight || 1080) * scale) / 2;

      selection.hidden = false;
      selection.style.left = `${offsetX + box.left * scale}px`;
      selection.style.top = `${offsetY + box.top * scale}px`;
      selection.style.width = `${Math.max(2, box.width * scale)}px`;
      selection.style.height = `${Math.max(2, box.height * scale)}px`;
    }
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
    for (const surface of this.surfaces) this.#ensureTransforms(surface);
    this.#renderSelection();

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
