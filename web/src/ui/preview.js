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
import { icon, iconButton } from './icons.js';
import { t } from '../i18n.js';
import { HANDLES, boxOf, toScene, contains, bounds, snapLines, move, stretch, crop, rotate } from '../scene-transform.js';
import { WebGpuPreview, webgpuAvailable, openMjpegStream } from '../webgpu-preview.js';
import { selectors } from '../store.js';
import {
  boxToPosition,
  boxToTransform,
  clientToScene,
  itemBox,
  moveBox,
  overlayRect,
  pointInCanvas,
  resizeBox,
  streamFrameSize,
  sceneToPane,
  snapMoveBox,
  snapResizeBox,
} from '../scene-geometry.js';

/* The most the page asks for. OBS only makes a frame when it has rendered one,
 * so the rate actually delivered is OBS's own (30 or 60), never above it. */
const PREVIEW_FPS = 60;

/* How long a pane may go without a frame before its stream is reopened. The
 * host sends a still picture again once a second, so several seconds of
 * silence means the connection is gone, not that nothing moved. */
const STREAM_STALL_MS = 4000;
const STREAM_RETRY_MS = [250, 500, 1000, 2000, 4000];

/* The stream frame is requested at the size the pane actually shows, rounded up
 * to this step. Asking for the full canvas regardless meant decoding and
 * uploading ~2 megapixels per frame for a picture a fraction of that size,
 * which is what capped the preview well below OBS's own frame rate. */
const STREAM_SIZE_STEP = 160;

/* JPEG quality for the preview stream. 91 is where the encoder switches to
 * 4:4:4 chroma (no colour subsampling), which is what makes coloured text and
 * UI edges look like the native preview instead of a smeared approximation;
 * below it, colour is stored at a quarter of the resolution. */
const STREAM_QUALITY = 92;

/* How close, in *screen* pixels, an edge has to be before it sticks to the
 * canvas edge or centre. Converting it to scene units at drag time keeps the
 * feel the same however far the preview is zoomed out. */
const SNAP_PIXELS = 8;

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
  constructor({ store, api, canvas, labels, placeholder, controls = null, onContextAction, onSelectSource, host = {} }) {
    this.store = store;
    this.api = api;
    this.canvas = canvas;
    this.controls = controls;
    this.labels = labels;
    this.placeholder = placeholder;
    this.onContextAction = onContextAction;
    this.onSelectSource = onSelectSource;
    this.host = host;

    /* Source selected in the preview: the name, and the item being dragged. */
    this.selected = null;
    this.drag = null;

    this.fps = 15; // screenshot fallback rate (no preview endpoint available)
    this.streamFps = PREVIEW_FPS;
    this.scaling = 'window'; // window | canvas | output
    this.zoom = 1;
    this.locked = false;
    this.running = false;
    this.timer = null;
    this.errorCount = 0;
    this.useWebgpu = false;
    this.useNativeStream = false;
    this.streamGeneration = 0;
    this.surfaces = []; // [{ kind, scene, img?, canvas?, renderer?, abort?, busy? }]

    this.onVisibility = () => {
      this.#schedule(0);
      /* A hidden tab still reads its streams, so OBS would keep rendering and
       * encoding for nobody. Close them and reopen on return. */
      if (!this.running || (!this.useWebgpu && !this.useNativeStream)) return;
      if (document.hidden) {
        this.#pauseStreams();
      } else {
        for (const surface of this.surfaces) this.#startStream(surface);
      }
    };
    this.onResize = () => this.#resizeSurfaces();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.canvas.addEventListener('keydown', (event) => this.#nudge(event));
    window.addEventListener('resize', this.onResize);

    this.#buildControls();
    this.#buildSurfaces();
  }

  /* ------------------------------------------- zoom row and studio column */

  /*! The row under the preview: zoom out, the scale in percent, zoom in and
   *  the scaling mode - the desktop window's own controls. */
  #buildControls() {
    if (!this.controls) return;
    this.scaleLabel = h('span.obs-preview-scale', { text: '100%' });
    this.scaleMode = h('select.obs-preview-scaling-mode', {
      'aria-label': 'Preview Scaling',
      on: { change: () => this.setScaling(this.scaleMode.value) },
    });
    this.controls.replaceChildren(
      iconButton('minus', { title: 'Zoom Out', size: 10, className: 'obs-preview-zoom', onClick: () => this.zoomOut() }),
      this.scaleLabel,
      iconButton('plus', { title: 'Zoom In', size: 10, className: 'obs-preview-zoom', onClick: () => this.zoomIn() }),
      this.scaleMode
    );
    this.#updateControls();
  }

  /*! How large the picture is drawn, relative to the canvas. */
  #displayScale() {
    const video = this.store.state.video ?? {};
    const baseWidth = video.baseWidth || 1920;
    const baseHeight = video.baseHeight || 1080;
    if (this.scaling === 'canvas') return this.zoom;
    if (this.scaling === 'output') return ((video.outputWidth || baseWidth) / baseWidth) * this.zoom;
    const pane = this.surfaces[0]?.pane;
    if (!pane) return this.zoom;
    const style = getComputedStyle(pane);
    const width = pane.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
    const height = pane.clientHeight - parseFloat(style.paddingTop || 0) - parseFloat(style.paddingBottom || 0);
    if (width <= 0 || height <= 0) return this.zoom;
    return Math.min(width / baseWidth, height / baseHeight) * this.zoom;
  }

  #updateControls() {
    if (!this.controls || !this.scaleMode) return;
    const video = this.store.state.video ?? {};
    const sizes = `${video.baseWidth || 1920}x${video.baseHeight || 1080}/${video.outputWidth || 0}x${video.outputHeight || 0}`;
    if (this.scaleMode.dataset.sizes !== sizes) {
      this.scaleMode.dataset.sizes = sizes;
      this.scaleMode.replaceChildren(
        h('option', { value: 'window', text: t('Basic.MainMenu.Edit.Scale.Window') }),
        h('option', {
          value: 'canvas',
          text: t('Basic.MainMenu.Edit.Scale.Canvas', video.baseWidth || 1920, video.baseHeight || 1080),
        }),
        h('option', {
          value: 'output',
          text: t('Basic.MainMenu.Edit.Scale.Output', video.outputWidth || 1280, video.outputHeight || 720),
        })
      );
    }
    this.scaleMode.value = this.scaling;
    this.scaleLabel.textContent = `${Math.round(this.#displayScale() * 100)}%`;
  }

  /*! Studio Mode's centre column, between the two panes: Transition and its
   *  options menu, the quick transition buttons and the T-bar. */
  #buildStudioColumn() {
    const run = (promise) => promise.catch((err) => this.onContextAction?.('previewError', err?.message ?? String(err)));

    const transition = h('button.obs-btn.obs-studio-transition', {
      type: 'button',
      text: t('Transition'),
      on: { click: () => run(this.api.triggerStudioTransition()) },
    });
    const options = iconButton('dotsV', {
      className: 'obs-btn obs-studio-options',
      onClick: (event) => this.#openStudioOptions(event),
    });
    this.quickList = h('div.obs-studio-quick');
    this.tbar = h('input.obs-range.obs-tbar', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.001',
      value: '0',
      'aria-label': 'T-Bar',
      on: {
        input: () => this.api.setTBarPosition(Number(this.tbar.value), false).catch(() => {}),
        change: () => {
          run(this.api.setTBarPosition(Number(this.tbar.value), true));
          /* Released: OBS finishes or reverts the transition, and the bar
           * goes back to rest for the next one. */
          setTimeout(() => { if (this.tbar) this.tbar.value = '0'; }, 400);
        },
      },
    });

    this.#refreshStudioState();
    return h('div.obs-studio-column', {}, [
      h('div.obs-studio-row', {}, [transition, options]),
      h('div.obs-studio-row.obs-studio-quick-title', {}, [h('span', { text: t('QuickTransitions') })]),
      this.quickList,
      this.tbar,
    ]);
  }

  /*! Ask OBS for its quick transitions and Studio Mode options. */
  async #refreshStudioState() {
    if (!this.host?.obsControl) return;
    try {
      this.studioState = await this.api.request('GetStudioModeState');
    } catch {
      this.studioState = null;
    }
    if (!this.quickList) return;
    const quick = this.studioState?.quickTransitions ?? [];
    this.quickList.replaceChildren(
      ...quick.map((entry) =>
        h('button.obs-btn.obs-studio-quick-btn', {
          type: 'button',
          text: entry.name,
          raw: true,
          on: {
            click: () =>
              this.api
                .request('TriggerQuickTransition', { quickTransitionId: entry.id })
                .catch((err) => this.onContextAction?.('previewError', err?.message ?? String(err))),
          },
        })
      )
    );
  }

  /*! The three toggles behind the menu button next to Transition. */
  async #openStudioOptions(event) {
    await this.#refreshStudioState();
    const state = this.studioState ?? {};
    const toggle = (optionName) => async () => {
      try {
        await this.api.request('SetStudioModeOption', { optionName, optionEnabled: !state[optionName] });
      } catch (err) {
        this.onContextAction?.('previewError', err?.message ?? String(err));
      }
    };
    const rect = event.currentTarget.getBoundingClientRect();
    showContextMenu({ x: rect.left, y: rect.bottom }, [
      { label: t('QuickTransitions.DuplicateScene'), checked: !!state.duplicateScene, action: toggle('duplicateScene') },
      {
        label: t('QuickTransitions.EditProperties'),
        checked: !!state.duplicateSources,
        disabled: !state.duplicateScene,
        action: toggle('duplicateSources'),
      },
      { label: t('QuickTransitions.SwapScenes'), checked: !!state.swapScenes, action: toggle('swapScenes') },
    ]);
  }

  /*! "Preview: Scene" / "Program: Scene" above the panes. */
  #updateLabels() {
    for (const surface of this.surfaces) {
      if (!surface.label) continue;
      const scene = this.#sceneFor(surface.kind) ?? '';
      surface.label.textContent =
        surface.kind === 'program' ? t('StudioMode.ProgramSceneName', scene) : t('StudioMode.PreviewSceneName', scene);
    }
  }

  /** Decide the backend once, before the first frame is drawn. */
  async init() {
    const servedByObs = Boolean(this.host?.previewStream);
    this.useWebgpu = servedByObs && (await webgpuAvailable());
    /* Without WebGPU the multipart JPEG is still worth having: an <img> decodes
     * and paints it natively, with no JavaScript and no round trip per frame.
     * Polling GetSourceScreenshot is the last resort, for a page served by a
     * plain static host. */
    this.useNativeStream = servedByObs && !this.useWebgpu;
    this.#buildSurfaces();
    return this.useWebgpu;
  }

  get backend() {
    if (this.useWebgpu) return 'webgpu';
    return this.useNativeStream ? 'stream' : 'screenshot';
  }

  /*! How the preview is being drawn, in words.
   *
   * This is the first thing to look at when the preview feels slow, so it has
   * to name all three backends: a two-way label here once reported
   * "Screenshots" while the native stream was running. */
  get backendLabel() {
    if (this.backend === 'webgpu') return 'WebGPU';
    if (this.backend === 'stream') return 'Native stream';
    return 'Screenshots (slow - no stream endpoint)';
  }

  /*! The frame size to ask OBS for: what the pane shows, not the whole canvas.
   *
   * Rounded up to a step so dragging a splitter does not reopen the stream on
   * every pixel, and never larger than the canvas itself. */
  #streamSize(surface) {
    /* Measured on the pane, not the picture: an <img> has no size until its
     * first frame arrives, so measuring it asked for the whole canvas and the
     * fallback preview streamed full resolution into a pane a third the size.
     * Pixel-exact scaling modes are the exception - they do show every pixel. */
    const rect = surface.pane.getBoundingClientRect();
    const style = getComputedStyle(surface.pane);
    /* Zooming in magnifies the picture, so it needs the pixels to match. */
    const zoom = Math.max(1, this.zoom);
    const room = {
      width: (rect.width - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0)) * zoom,
      height: (rect.height - parseFloat(style.paddingTop || 0) - parseFloat(style.paddingBottom || 0)) * zoom,
    };
    return streamFrameSize(
      this.scaling === 'window' ? room : { width: 0, height: 0 },
      this.store.state.video,
      Math.min(window.devicePixelRatio || 1, 2),
      STREAM_SIZE_STEP
    );
  }

  /*! The scene a pane shows. Through the selectors, because Studio Mode can
   *  be switched on from anywhere (another tab, a hotkey) and until OBS names
   *  a preview scene the preview pane shows the program scene - reading the
   *  raw field left that pane empty. */
  #sceneFor(kind) {
    const state = this.store.state;
    return kind === 'preview' ? selectors.previewPaneScene(state) : selectors.programPaneScene(state);
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
        /* Deliberately does not give up on the stream here: replacing an <img>
         * src aborts the multipart request that is still in flight, and the
         * browser reports that abort as an error on the very element we just
         * pointed at the new stream. Reacting to it dropped the native stream
         * on the floor on the first resize. Whether the stream works is decided
         * once, by #watchNativeStream. */
        frame.addEventListener('error', () => {
          pane.classList.add('is-broken');
          if (!this.useNativeStream) return;
          /* A dead stream is worth retrying: most often the host restarted and
           * the connection died with it, which used to leave the pane blank
           * until the page was reloaded by hand. Guarded because swapping the
           * src aborts the previous request, and that abort lands here too. */
          if (performance.now() - (surface.lastStreamStart ?? 0) < 2000) return;
          this.#startStream(surface);
        });
        /* Swapping the src aborts the in-flight stream and marks the element
         * broken for a moment; the overlay has to come off again when the new
         * stream delivers its first frame. */
        frame.addEventListener('load', () => pane.classList.remove('is-broken'));
      }

      const label = h('div.obs-preview-label', {
        class: kind === 'program' ? 'is-program' : 'is-preview',
      });
      if (!studio) label.hidden = true;

      const selection = h(
        'div.obs-preview-selection',
        { hidden: true },
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((dir) =>
          h(`div.obs-preview-handle.is-${dir}`, { dataset: { handle: dir } })
        )
      );
      /* Snap guides: at most one line per axis, drawn for as long as the drag
       * is stuck to that line. */
      const guideX = h('div.obs-preview-guide.is-x', { hidden: true });
      const guideY = h('div.obs-preview-guide.is-y', { hidden: true });

      const pane = h(`div.obs-preview-pane.is-${kind}`, {}, [label, frame, guideX, guideY, selection]);
      setClass(pane, 'has-label', studio);
      this.canvas.appendChild(pane);

      /* The centre column sits between the two panes. */
      if (studio && kind === 'program') this.canvas.insertBefore(this.#buildStudioColumn(), pane);

      const surface = { kind, scene, pane, frame, label, selection, guideX, guideY, guides: null,
        img: this.useWebgpu ? null : frame, canvas: this.useWebgpu ? frame : null };
      this.surfaces.push(surface);
      this.#wireSelection(surface);

      /* A splitter drag changes the pane without a window resize, so the
       * stream has to follow the pane's own size. */
      this.resizeObserver ??= new ResizeObserver(() => this.#resizeSurfaces());
      this.resizeObserver.observe(pane);

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

    if (!studio) {
      this.quickList = null;
      this.tbar = null;
    }
    this.#updateLabels();
    this.#applyScaling();
    this.render();
    /* The native stream is a plain <img src>, so it has to be pointed at the
     * endpoint once - there is no renderer callback to do it later. */
    if (this.useNativeStream) {
      for (const surface of this.surfaces) this.#startStream(surface);
    }
    if (this.running) this.#schedule(0);
  }

  #stopStreams() {
    for (const surface of this.surfaces) {
      clearTimeout(surface.retryTimer);
      surface.abort?.abort();
      surface.abort = null;
      surface.pending = null;
      surface.bitmap?.close?.();
      surface.bitmap = null;
      surface.renderer?.destroy?.();
      surface.renderer = null;
      surface.stopped = true;
    }
  }

  /**
   * Open the MJPEG stream for one pane. Frames are dropped while the previous
   * one is still being decoded, so a slow decoder never builds a backlog.
   */
  /*! The multipart-JPEG URL for a pane, at the size the pane shows. */
  #streamUrl(surface) {
    const { width, height } = this.#streamSize(surface);
    surface.streamWidth = width;
    /* The program pane shows what is going out - the texture OBS has already
     * rendered, transitions included - so it needs no scene name and no new
     * stream when the scene changes. */
    const what = this.#isProgramView(surface)
      ? 'view=program'
      : `source=${encodeURIComponent(this.#sceneFor(surface.kind))}`;
    return `api/preview.mjpg?${what}&width=${width}&height=${height}&fps=${this.streamFps}&quality=${STREAM_QUALITY}`;
  }

  #isProgramView(surface) {
    return surface.kind === 'program' && Boolean(this.host?.previewProgram);
  }

  /*! Close every stream without tearing the panes down (hidden tab). */
  #pauseStreams() {
    for (const surface of this.surfaces) {
      clearTimeout(surface.retryTimer);
      surface.abort?.abort();
      surface.abort = null;
      surface.streamScene = null;
      if (this.useNativeStream) surface.img?.removeAttribute('src');
    }
  }

  #startStream(surface) {
    const scene = this.#sceneFor(surface.kind);
    if (!scene) return;

    if (this.useNativeStream) {
      /* Hand the whole thing to the browser: it fetches the multipart stream
       * and paints each JPEG as it arrives, which is how browsers have shown
       * MJPEG for decades and costs this code nothing per frame. */
      surface.scene = scene;
      surface.streamScene = scene;
      surface.lastStreamStart = performance.now();
      if (surface.img) {
        surface.img.src = this.#streamUrl(surface);
        surface.pane.classList.remove('is-empty', 'is-broken');
        this.#watchNativeStream(surface);
      }
      return;
    }

    if (!this.useWebgpu || !surface.renderer) return;
    if (document.hidden) return; // reopened by onVisibility

    clearTimeout(surface.retryTimer);
    surface.abort?.abort();
    const abort = new AbortController();
    surface.abort = abort;
    surface.scene = scene;
    surface.streamScene = scene;
    surface.pending = null;
    surface.lastFrameAt = performance.now();

    /* Whatever ends the stream - the host restarting, a proxy cutting it, a
     * refusal - the pane must come back by itself, and without involving the
     * rest of the page: a failed stream used to notify the store, which
     * re-rendered the panel, which reopened the streams, which failed again. */
    const retry = (reason) => {
      if (surface.abort !== abort || !this.running || !this.surfaces.includes(surface)) return;
      surface.lastError = reason;
      surface.failures = (surface.failures ?? 0) + 1;
      const wait = STREAM_RETRY_MS[Math.min(surface.failures, STREAM_RETRY_MS.length) - 1];
      clearTimeout(surface.retryTimer);
      surface.retryTimer = setTimeout(() => {
        if (surface.abort === abort && this.running && this.surfaces.includes(surface)) this.#startStream(surface);
      }, wait);
    };

    openMjpegStream(this.#streamUrl(surface), {
      signal: abort.signal,
      onFrame: (jpeg) => {
        surface.received = (surface.received ?? 0) + 1;
        surface.lastFrameAt = performance.now();
        surface.failures = 0;
        /* Only the newest frame is worth decoding: one that arrives while the
         * decoder is busy replaces the one that was waiting. */
        if (surface.pending) surface.dropped = (surface.dropped ?? 0) + 1;
        surface.pending = jpeg;
        if (!surface.busy) this.#drainFrames(surface);
      },
      onEnd: () => retry('stream ended'),
      onError: (err) => retry(String(err?.message ?? err)),
    });
    this.#watchStall();
  }

  /*! Decode and draw whatever frame is waiting, newest first and only. */
  async #drainFrames(surface) {
    surface.busy = true;
    try {
      while (surface.pending && surface.renderer) {
        const jpeg = surface.pending;
        surface.pending = null;
        let bitmap = null;
        try {
          bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
          if (!surface.renderer) break;
          surface.lastSize = [bitmap.width, bitmap.height];
          surface.renderer.resize?.();
          surface.renderer.draw(bitmap);
          surface.drawn = (surface.drawn ?? 0) + 1;
          this.#sampleFps(surface);
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
        }
      }
    } finally {
      surface.busy = false;
    }
  }

  /*! Reopen a stream that has gone quiet: a connection can die without the
   *  browser ever reporting an end or an error (a suspended laptop, a dropped
   *  Wi-Fi link). One timer watches every pane. */
  #watchStall() {
    if (this.stallTimer) return;
    this.stallTimer = setInterval(() => {
      if (!this.running || !this.useWebgpu || document.hidden) return;
      const now = performance.now();
      for (const surface of this.surfaces) {
        if (!surface.abort || !surface.streamScene) continue;
        if (now - (surface.lastFrameAt ?? now) > STREAM_STALL_MS) this.#startStream(surface);
      }
    }, 1000);
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
      /* No frames *received* is a stream that has nothing to show yet (no
       * scene, host busy) - not a broken GPU, and not a reason to take the
       * other pane down with it. */
      if ((surface.received ?? 0) === 0) return;
      console.warn(
        '[WebMIX] WebGPU drew no frames; falling back to the screenshot preview',
        surface.lastError ?? ''
      );
      this.useWebgpu = false;
      this.useNativeStream = Boolean(this.host?.previewStream);
      this.#buildSurfaces();
      this.#schedule(0);
    }, 3000);
  }

  /* ------------------------------------------------- preview interaction */

  /** Selected source, e.g. when the Sources dock changes the selection. */
  select(name) {
    this.selected = name ?? null;
    this.#clearGuides();
    this.#renderSelection();
  }

  /*! Client coordinates -> scene pixels, or null when the point is outside. */
  #scenePoint(surface, event) {
    return clientToScene(surface.frame.getBoundingClientRect(), this.store.state.video, event);
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

  /*! The item's box (size, anchor, rotation), or null before its transform
   *  is known. */
  #itemBox(surface, item) {
    const transform = this.#transformFor(surface, item);
    return transform ? boxOf(transform) : null;
  }

  /*! The scene's items, front first - the order they cover each other in. */
  #sceneItems(surface) {
    return selectors.sceneItemsTopFirst(this.store.state, surface.scene);
  }

  /** The front-most item under a scene point. */
  #hitTest(surface, point) {
    for (const item of this.#sceneItems(surface)) {
      /* A hidden source is not there; a locked one is not selectable in OBS's
       * preview either, and the click falls through to what is behind it. */
      if (!item.sceneItemEnabled || item.sceneItemLocked) continue;
      const box = this.#itemBox(surface, item);
      if (box && contains(box, point)) return item;
    }
    return null;
  }

  /*! OBS's snapping options ([BasicWindow] in the user config). */
  async #loadSnapping() {
    this.snapping = { enabled: true, screen: true, sources: true, center: false, distance: 10 };
    try {
      Object.assign(this.snapping, await this.api.request('GetPreviewSnapping'));
    } catch {
      /* a host without the request: OBS's defaults */
    }
  }

  /*! The lines a drag may stick to: the canvas, and every other visible item. */
  #snapLinesFor(surface, sceneItemId) {
    const video = this.store.state.video ?? {};
    const canvas = { baseWidth: video.baseWidth || 1920, baseHeight: video.baseHeight || 1080 };
    const others = [];
    for (const item of this.#sceneItems(surface)) {
      if (item.sceneItemId === sceneItemId || !item.sceneItemEnabled) continue;
      const box = this.#itemBox(surface, item);
      if (box) others.push(bounds(box));
    }
    return snapLines(canvas, others, this.snapping ?? {});
  }

  #wireSelection(surface) {
    const { pane } = surface;

    pane.addEventListener('pointerdown', (event) => {
      // A failure here must never break the preview.
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
      drag.surface.guides = null;
      /* The last position is the one that counts: send it even if the
       * throttle swallowed it a moment ago. */
      if (drag.pending) this.#send(drag, true);
      this.#renderSelection();
      try { pane.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    };
    pane.addEventListener('pointerup', finish);
    pane.addEventListener('pointercancel', finish);
    pane.addEventListener('dblclick', () => this.onContextAction?.('transform', { source: this.selected }));
  }

  #beginDrag(surface, event) {
    if (this.locked || event.button !== 0) return;
    /* In Studio Mode only the preview is edited; the program pane shows what
     * is going out and cannot be touched, as on the desktop. */
    if (this.store.state.studioMode && surface.kind === 'program') return;
    if (event.target.closest('button, select, input')) return;

    const point = this.#scenePoint(surface, event);
    if (!point) return;
    this.#ensureTransforms(surface);
    if (!this.snapping) this.#loadSnapping();

    const handleName = event.target.closest('[data-handle]')?.dataset.handle ?? null;
    const item = handleName
      ? this.#sceneItems(surface).find((i) => i.sourceName === this.selected)
      : this.#hitTest(surface, point);
    if (!item || item.sceneItemLocked) {
      this.selected = null;
      this.onSelectSource?.(null);
      this.#renderSelection();
      return;
    }

    this.selected = item.sourceName;
    this.onSelectSource?.(item.sourceName);
    this.#renderSelection();

    const transform = this.#transformFor(surface, item);
    if (!transform) return;
    const start = { ...transform };
    const handle = HANDLES[handleName] ?? null;
    /* Where on the handle it was grabbed: the handle follows the pointer by
     * that offset instead of jumping to it. */
    const grabbed = handle ? toScene(boxOf(start), handle.hu, handle.hv) : null;

    surface.guides = null;
    this.drag = {
      surface,
      pointerId: event.pointerId,
      mode: handleName === 'rot' ? 'rotate' : handle ? 'handle' : 'move',
      handle,
      sceneItemId: item.sceneItemId,
      start,
      startX: point.x,
      startY: point.y,
      grabX: grabbed ? point.x - grabbed.x : 0,
      grabY: grabbed ? point.y - grabbed.y : 0,
      lines: this.#snapLinesFor(surface, item.sceneItemId),
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
    this.canvas.focus?.({ preventScroll: true });
  }

  /*! One step of a drag, by OBS's rules:
   *    body    move; sticks to the canvas, its centre and other sources
   *    corner  scale, keeping proportions (Shift: freely)
   *    edge    stretch one dimension
   *    Alt     crop instead of scaling
   *    knob    rotate (Shift: in steps of 15 degrees)
   *    Ctrl    no snapping for this drag */
  #moveDrag(surface, event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = this.#scenePoint(surface, event);
    if (!point) return;

    const snapping = this.snapping ?? { enabled: true, distance: 10 };
    const snap = snapping.enabled !== false && !event.ctrlKey;
    const threshold = snap ? (snapping.distance || 10) / point.scale : 0;
    const lines = snap ? drag.lines : null;
    const pulled = { x: point.x - drag.grabX, y: point.y - drag.grabY };

    let result;
    if (drag.mode === 'rotate') {
      result = rotate(drag.start, point, { step: event.shiftKey ? 15 : 0 });
    } else if (drag.mode === 'handle') {
      result = event.altKey
        ? crop(drag.start, drag.handle, pulled)
        : stretch(drag.start, drag.handle, pulled, { free: event.shiftKey, lines, threshold });
    } else {
      let dx = point.x - drag.startX;
      let dy = point.y - drag.startY;
      /* Shift keeps the move on one axis. */
      if (event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      result = move(drag.start, dx, dy, lines, threshold);
    }

    drag.pending = result.patch;
    surface.guides = result.guides;
    /* Draw at once; the traffic to OBS is what gets throttled. */
    this.#previewTransform(surface, drag.sceneItemId, result.patch);
    this.#renderSelection();
    this.#send(drag, false);
  }

  /*! Tell OBS, at most about thirty times a second while dragging. */
  #send(drag, force) {
    const patch = drag.pending;
    if (!patch) return;
    const now = performance.now();
    if (!force && drag.sent && now - drag.sent < 33) return;
    drag.sent = now;
    drag.pending = null;
    this.api
      .setSceneItemTransform(drag.surface.scene, drag.sceneItemId, { ...patch })
      .catch((err) => this.#report(err, true));
  }

  /*! Arrow keys nudge the selected source by a pixel (Shift: ten). */
  #nudge(event) {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!step || this.locked || !this.selected || event.target.closest?.('input, select, textarea')) return;
    const surface = this.surfaces.find((s) => !(this.store.state.studioMode && s.kind === 'program'));
    const item = surface && this.#sceneItems(surface).find((i) => i.sourceName === this.selected);
    const transform = item && !item.sceneItemLocked ? this.#transformFor(surface, item) : null;
    if (!transform) return;
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    const patch = {
      positionX: (transform.positionX || 0) + step[0] * amount,
      positionY: (transform.positionY || 0) + step[1] * amount,
    };
    this.#previewTransform(surface, item.sceneItemId, patch);
    this.#renderSelection();
    this.api.setSceneItemTransform(surface.scene, item.sceneItemId, patch).catch((err) => this.#report(err, true));
  }

  /*! Apply a pending drag to the local copy of the item's transform. */
  #previewTransform(surface, sceneItemId, patch) {
    const cached = this.transforms?.get(`${surface.scene}:${sceneItemId}`);
    if (cached) Object.assign(cached, patch);
    const item = this.#sceneItems(surface).find((i) => i.sceneItemId === sceneItemId);
    if (item?.sceneItemTransform) Object.assign(item.sceneItemTransform, patch);
  }

  /** Draw the selection frame (turned with the item), its handles, the
   *  rotation knob and any snap guides. */
  #renderSelection() {
    for (const surface of this.surfaces) {
      const { selection, pane, frame } = surface;
      if (!selection) continue;
      if (this.store.state.studioMode && surface.kind === 'program') {
        selection.hidden = true;
        continue;
      }
      this.#renderGuides(surface);

      const item = this.selected
        ? this.#sceneItems(surface).find((i) => i.sourceName === this.selected)
        : null;
      /* A locked source has no transform box, as in OBS. */
      const box = item && !item.sceneItemLocked ? this.#itemBox(surface, item) : null;
      const frameBox = frame.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      if (!box || !frameBox.width) {
        selection.hidden = true;
        continue;
      }

      if (!selection.querySelector('.obs-preview-rotate')) {
        selection.appendChild(h('div.obs-preview-rotate', { dataset: { handle: 'rot' } }));
      }

      const video = this.store.state.video;
      const corner = toScene(box, 0, 0);
      const origin = sceneToPane(corner.x, corner.y, frameBox, paneBox, video);
      const unit = sceneToPane(corner.x + 1, corner.y, frameBox, paneBox, video);
      const scale = unit.x - origin.x;

      selection.hidden = false;
      setClass(selection, 'is-locked', !!item.sceneItemLocked);
      selection.style.left = `${origin.x}px`;
      selection.style.top = `${origin.y}px`;
      selection.style.width = `${Math.max(1, Math.abs(box.width) * scale)}px`;
      selection.style.height = `${Math.max(1, Math.abs(box.height) * scale)}px`;
      /* Turned with the item, and mirrored with a flipped one, so each handle
       * stays on the corner it pulls. */
      selection.style.transform =
        `rotate(${box.rotation}deg) scale(${box.width < 0 ? -1 : 1}, ${box.height < 0 ? -1 : 1})`;
    }
  }

  /*! Show the canvas lines the item is currently stuck to. */
  #renderGuides(surface) {
    const { guides, guideX, guideY } = surface;
    const frameBox = surface.frame.getBoundingClientRect();
    const paneBox = surface.pane.getBoundingClientRect();

    const place = (element, axis) => {
      const value = guides?.[axis];
      if (value === null || value === undefined || !frameBox.width) {
        element.hidden = true;
        return;
      }
      const point = sceneToPane(
        axis === 'x' ? value : 0,
        axis === 'y' ? value : 0,
        frameBox,
        paneBox,
        this.store.state.video
      );
      element.hidden = false;
      if (axis === 'x') element.style.left = `${point.x}px`;
      else element.style.top = `${point.y}px`;
    };

    place(guideX, 'x');
    place(guideY, 'y');
  }

  /*! Notice a native stream that never produced a frame, and switch to polling.
   *
   * A browser that does not implement multipart JPEG in an <img> fails quietly:
   * no error, just an image that never arrives. Three seconds is well past the
   * time the first frame needs over loopback.
   */
  #watchNativeStream(surface) {
    const generation = ++this.streamGeneration;
    setTimeout(() => {
      if (!this.useNativeStream || generation !== this.streamGeneration) return;
      if (!this.surfaces.includes(surface) || surface.img?.naturalWidth) return;
      console.warn('[WebMIX] the native preview stream produced no frame; polling screenshots instead');
      this.#abandonNativeStream();
    }, 3000);
  }

  #abandonNativeStream() {
    this.useNativeStream = false;
    for (const surface of this.surfaces) {
      surface.img?.removeAttribute('src');
      surface.streamScene = null;
    }
    this.#buildSurfaces();
    this.#schedule(0);
  }

  /*! Forget the guides, e.g. when nothing is being dragged. */
  #clearGuides() {
    for (const surface of this.surfaces) {
      if (surface.guides) surface.guides = null;
    }
  }

  /*! Ask the host how many frames it has sent, twice, to learn the rate.
   *
   * A multipart JPEG stream is painted by the browser itself, so there is no
   * per-frame hook in JavaScript; the only honest number is the one the host
   * can count. The counter is process-wide, so a second viewer would inflate
   * it - good enough for "is the host keeping up at all", which is the
   * question this answers.
   */
  async measureDelivery(sampleMs = 1200) {
    if (!this.useNativeStream) return null;
    let streams = 1;
    const read = async () => {
      try {
        const response = await fetch('api/status', { cache: 'no-store' });
        const data = await response.json();
        /* The counter covers every open stream (two panes in Studio Mode,
         * other tabs); the rate of one stream is what the user is asking. */
        streams = Math.max(1, data?.preview?.streams ?? this.surfaces.length);
        return typeof data?.previewFrames === 'number' ? data.previewFrames : null;
      } catch {
        return null;
      }
    };
    const first = await read();
    if (first === null) return null;
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
    const second = await read();
    if (second === null || second < first) return null;
    this.deliveredFps = Math.round(((second - first) / (sampleMs / 1000) / streams) * 10) / 10;
    return this.deliveredFps;
  }

  /*! Remember when a frame reached the screen, so the achieved rate can be
   *  reported. Two seconds of history is enough to be stable to read. */
  #sampleFps(surface) {
    const now = performance.now();
    surface.fpsSamples ??= [];
    surface.fpsSamples.push({ t: now, drawn: surface.drawn });
    while (surface.fpsSamples.length > 1 && now - surface.fpsSamples[0].t > 2000) {
      surface.fpsSamples.shift();
    }
  }

  /*! Frames per second actually painted, or null before there is enough
   *  history to say. */
  #achievedFps(surface) {
    const samples = surface?.fpsSamples;
    if (!samples || samples.length < 2) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const seconds = (last.t - first.t) / 1000;
    if (!(seconds > 0.2)) return null;
    return Math.round(((last.drawn - first.drawn) / seconds) * 10) / 10;
  }

  #restartStreamsIfNeeded() {
    if (!this.useWebgpu && !this.useNativeStream) return;
    for (const surface of this.surfaces) {
      /* `surface.scene` tracks what the overlay is showing and render() keeps it
       * in step; the stream has its own field, or a scene change would look
       * like a no-op and leave the <img> on the old scene. */
      const scene = this.#sceneFor(surface.kind);
      if (scene === surface.streamScene) continue;
      if (surface.streamScene && scene && this.#isProgramView(surface) && surface.abort) {
        surface.streamScene = scene;
        continue;
      }
      this.#startStream(surface);
    }
  }

  #resizeSurfaces() {
    for (const surface of this.surfaces) {
      surface.renderer?.resize?.();
      if (!surface.scene) continue;
      if (!this.useWebgpu && !this.useNativeStream) continue;
      const { width } = this.#streamSize(surface);
      if (surface.streamWidth && Math.abs(width - surface.streamWidth) >= STREAM_SIZE_STEP) {
        this.#startStream(surface);
      }
    }
    this.#applyScaling();
  }

  /*! What the preview is actually doing, for "is this as smooth as OBS?". */
  #fpsLabel() {
    const surface = this.surfaces.find((s) => s.renderer) ?? this.surfaces[0];

    if (this.useNativeStream) {
      const size = surface?.streamWidth ? `${surface.streamWidth}px wide` : 'size pending';
      const delivered = this.deliveredFps === undefined ? null : this.deliveredFps;
      return delivered === null
        ? `Preview: native stream, ${size}, ${this.streamFps} fps requested`
        : `Preview: native stream, ${size}, ${delivered} fps delivered`;
    }

    const fps = this.#achievedFps(surface);
    const size = surface?.lastSize ? `${surface.lastSize[0]}\u00d7${surface.lastSize[1]}` : 'no frame yet';
    if (fps === null) {
      const asked = this.useWebgpu ? `${this.streamFps} fps stream` : `${this.fps} fps poll`;
      return `Preview: waiting for frames (${asked}, ${size})`;
    }
    const dropped = surface?.dropped ?? 0;
    return `Preview: ${fps} fps (${size}${dropped ? `, ${dropped} dropped` : ''})`;
  }

  #openContextMenu(event) {
    const state = this.store.state;
    showContextMenu(
      { x: event.clientX, y: event.clientY },
      [
        { label: 'Enable Preview', hidden: !state.previewDisabled, action: () => this.onContextAction?.('enablePreview') },
        { label: 'Lock Preview', checked: this.locked, action: () => this.onContextAction?.('lockPreview') },
        { separator: true },
        { label: this.#fpsLabel(), disabled: true },
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
        { label: `Renderer: ${this.backendLabel}`, disabled: true },
      ]
    );
  }

  setFps(fps) {
    this.fps = Math.max(0, Math.min(60, fps));
    this.#schedule(0);
  }

  setLocked(locked) {
    this.locked = locked;
  }

  setScaling(mode) {
    this.scaling = mode;
    this.#resizeSurfaces();
  }

  setZoom(zoom) {
    this.zoom = Math.max(0.1, Math.min(8, zoom));
    this.#resizeSurfaces();
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
    this.#updateControls();
  }

  /** Rebuild the DOM (studio mode toggles, scene changes). */
  render() {
    const state = this.store.state;
    /* A reconnect means the previous streams died with the connection; they
     * have to be started again, or the pane stays blank. Only the *change* to
     * connected counts: this runs on every store update, and reopening the
     * streams each time is what made the preview stutter whenever anything
     * in a scene changed. */
    const connected = state.connection?.status === 'connected';
    if (connected && this.wasConnected === false) {
      for (const surface of this.surfaces) this.#startStream(surface);
    }
    this.wasConnected = connected;
    const expected = state.studioMode ? 2 : 1;
    if (this.surfaces.length !== expected) {
      this.#buildSurfaces();
      return;
    }

    for (const surface of this.surfaces) {
      surface.scene = this.#sceneFor(surface.kind);
    }
    this.#updateLabels();
    this.#updateControls();
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
      /* stop() released the renderers; a restart needs new ones. */
      if (this.surfaces.some((surface) => !surface.renderer && surface.stopped)) {
        this.#buildSurfaces();
        return;
      }
      for (const surface of this.surfaces) this.#startStream(surface);
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    clearInterval(this.stallTimer);
    this.stallTimer = null;
    this.#stopStreams();
  }

  destroy() {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onResize);
  }

  #schedule(delay) {
    clearTimeout(this.timer);
    if (!this.running || this.useWebgpu || this.useNativeStream) return;
    const interval = this.fps > 0 ? Math.round(1000 / this.fps) : 1000;
    this.timer = setTimeout(() => this.#tick(), Math.max(delay, interval));
  }

  async #tick() {
    if (!this.running || this.useWebgpu || this.useNativeStream) return;
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
    const baseWidth = video.baseWidth || 1280;
    const baseHeight = video.baseHeight || 720;
    const targetW = Math.min(1280, Math.max(STREAM_SIZE_STEP, Math.round(baseWidth / 2)));
    const targetH = Math.round((targetW * baseHeight) / baseWidth);

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
          quality: STREAM_QUALITY,
        });
        if (dataUrl && surface.img) {
          surface.img.src = dataUrl;
          surface.drawn = (surface.drawn ?? 0) + 1;
          this.#sampleFps(surface);
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
