#!/usr/bin/env node
/*
 * WebMIX native browser check.
 *
 * The end-to-end proof of the architecture: a real browser loads the real UI
 * from a real OBS and drives it through the in-process control service. No
 * mock, no obs-websocket - and the page must not open a websocket at all.
 *
 *   1. OBS (started with --web) serves the page and advertises obsControl
 *   2. the UI autoconnects over HTTP + SSE and reports the native transport
 *   3. the page constructed no WebSocket
 *   4. the docks render from data that came out of libobs
 *   5. a UI action changes OBS and comes back as an event-driven store update
 *   6. audio meters flow, and the embedded preview server answers
 *   7. nothing throws and nothing is logged as an error
 *
 * Usage:
 *   obs --web --web-port 4470 &
 *   node tools/native-browser-check.mjs [--base http://127.0.0.1:4470/]
 */
import { rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { attach, createChecks, findChromium, launchChromium, profileDir } from './cdp.mjs';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE = getArg('base', process.env.WEBMIX_BASE ?? 'http://127.0.0.1:4470/');
const CDP_PORT = Number(getArg('cdp-port', 9344));
const WAIT_MS = Number(getArg('wait', 6000));
const SCREENSHOT = getArg('screenshot', '/tmp/webmix-native.png');
const SCENE_NAME = 'WebMIX browser check';

/** Poll an expression in the page until it is truthy. */
async function waitForExpression(cdp, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(expression);
    if (last) return last;
    await delay(150);
  }
  return last;
}

async function main() {
  const status = await (await fetch(new URL('api/status', BASE))).json().catch(() => null);
  if (!status?.obsControl) {
    console.error(`No native OBS control channel at ${BASE}. Start OBS with --web, or pass --base.`);
    process.exit(2);
  }

  const chromium = findChromium();
  if (!chromium) {
    console.log('SKIP: no chromium/chrome found; native browser check not run.');
    process.exit(0);
  }

  const checks = createChecks();

  const obsRequest = async (requestType, requestData = {}) =>
    fetch(new URL('api/obs/request', BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType, requestData }),
    })
      .then((response) => response.json())
      .catch(() => null);

  /* Every block below creates a scene and a source. A block that throws before
   * its own cleanup - a failed assertion is fine, but an evaluate that rejects
   * is not - would otherwise leave both behind in someone's OBS, so everything
   * created is registered here and swept in the outer finally. */
  const created = { scenes: new Set(), inputs: new Set() };
  const sweep = async () => {
    for (const scene of created.scenes) {
      const list = await obsRequest('GetSceneList');
      const others = (list?.responseData?.scenes ?? [])
        .map((entry) => entry.sceneName)
        .filter((name) => !created.scenes.has(name));
      // A scene that is still the program scene cannot be removed.
      if (others.length) await obsRequest('SetCurrentProgramScene', { sceneName: others[0] });
      await obsRequest('RemoveScene', { sceneName: scene });
    }
    for (const input of created.inputs) await obsRequest('RemoveInput', { inputName: input });
    created.scenes.clear();
    created.inputs.clear();
  };

  /* Blocks restore the program scene they found, but they run one after
   * another, so the value drifts. Remember the real starting point and put it
   * back at the very end. */
  const programBefore = await obsRequest('GetSceneList')
    .then((r) => r?.responseData?.currentProgramSceneName ?? null)
    .catch(() => null);

  /* Studio mode splits the preview into two panes and redirects a program
   * switch to the preview scene, which would silently invalidate everything
   * below. Remember it, assert it is off for the run, restore it at the end. */
  const studioBefore = await fetch(new URL('api/obs/request', BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'GetStudioModeEnabled' }),
  })
    .then((r) => r.json())
    .then((r) => r.responseData?.studioModeEnabled === true)
    .catch(() => false);
  if (studioBefore) {
    await fetch(new URL('api/obs/request', BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'SetStudioModeEnabled', requestData: { studioModeEnabled: false } }),
    }).catch(() => {});
  }
  const restoreStudio = async () => {
    if (!studioBefore) return;
    await fetch(new URL('api/obs/request', BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'SetStudioModeEnabled', requestData: { studioModeEnabled: true } }),
    }).catch(() => {});
  };
  const dir = profileDir('native');
  rmSync(dir, { recursive: true, force: true });
  const browser = launchChromium(chromium, { port: CDP_PORT, profileDir: dir });

  let socket = null;
  let exitCode = 1;
  try {
    const attached = await attach(CDP_PORT);
    socket = attached.socket;
    const { cdp } = attached;

    const pageErrors = [];
    const consoleErrors = [];
    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails;
      pageErrors.push(details.exception?.description ?? details.text ?? 'unknown exception');
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /* Count WebSocket constructions before any page script runs: the whole
     * point of this check is that the UI never needs one. */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__webmixWebSockets = 0;
        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = function (...args) {
          window.__webmixWebSockets++;
          return new OriginalWebSocket(...args);
        };
        window.WebSocket.prototype = OriginalWebSocket.prototype;
      `,
    });

    await cdp.send('Page.navigate', { url: BASE });

    /* The UI autoconnects because /api/status advertises the native channel. */
    const connected = await waitForExpression(
      cdp,
      'Boolean(window.webmix?.client?.connected)',
      15000
    );
    checks.check('the page autoconnects to OBS', connected);

    await waitForExpression(cdp, '(window.webmix?.store?.state?.scenes?.length ?? 0) > 0', 10000);
    await delay(WAIT_MS);

    const state = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        status: window.webmix?.store?.state?.connection?.status ?? 'unknown',
        native: window.webmix?.store?.state?.connection?.native === true,
        url: window.webmix?.client?.url ?? '',
        hasSocket: 'socket' in (window.webmix?.client ?? {}),
        scenes: (window.webmix?.store?.state?.scenes ?? []).map((s) => s.sceneName),
        program: window.webmix?.store?.state?.currentProgramScene ?? null,
        inputs: Object.keys(window.webmix?.store?.state?.inputs ?? {}),
        audioWithLevels: Object.values(window.webmix?.store?.state?.audio ?? {}).filter((a) => (a.levels ?? []).length > 0).length,
        websockets: window.__webmixWebSockets ?? -1,
        appHidden: document.querySelector('#app')?.hidden ?? true,
        connectHidden: document.querySelector('#connect-screen')?.hidden ?? false,
      })`)
    );

    checks.check('the store reports a connected native session', state.status === 'connected' && state.native);
    checks.check('the client is the native one (no websocket client in use)', state.hasSocket === false);
    checks.check('the page constructed no WebSocket at all', state.websockets === 0);
    checks.check('the OBS shell replaced the connect screen', state.appHidden === false && state.connectHidden === true);

    /* The status bar has to name the backend the browser chose: it is the one
     * line that tells a user with a slideshow preview what is going on. */
    const announced = await cdp.evaluate(
      `document.querySelector('#statusbar')?.textContent ?? ''`
    );
    checks.check(
      'the status bar names the preview backend',
      /Preview:\s*(Native stream|WebGPU|Screenshots)/.test(announced),
      announced.slice(0, 120)
    );

    /* Cross-check the store against OBS itself: the UI must be showing what
     * libobs reports, not something a mock produced. */
    const obs = await (
      await fetch(new URL('api/obs/request', BASE), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'GetSceneList' }),
      })
    ).json();
    const obsScenes = (obs.responseData?.scenes ?? []).map((scene) => scene.sceneName);
    checks.check(
      `the UI shows the scenes libobs reports (${state.scenes.length})`,
      obsScenes.length > 0 && obsScenes.every((name) => state.scenes.includes(name))
    );
    checks.check('the program scene matches libobs', state.program === obs.responseData?.currentProgramSceneName);

    const obsInputs = await (
      await fetch(new URL('api/obs/request', BASE), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'GetInputList' }),
      })
    ).json();
    const inputNames = (obsInputs.responseData?.inputs ?? []).map((input) => input.inputName);
    checks.check(
      `the mixer has a strip per libobs input (${state.inputs.length})`,
      inputNames.length > 0 && inputNames.every((name) => state.inputs.includes(name))
    );

    const docks = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        scenes: document.querySelectorAll('.obs-scene-item, [data-scene-name]').length,
        mixer: document.querySelectorAll('.obs-mixer-strip, [data-input-name]').length,
        transitions: Boolean(document.querySelector('.obs-transition-select, select.obs-select')),
        statusbar: (document.querySelector('#statusbar')?.textContent ?? '').trim().length,
        menus: document.querySelectorAll('.obs-menu-title, .obs-menubar > *').length,
      })`)
    );
    checks.check('the Scenes dock rendered scene rows', docks.scenes > 0);
    checks.check('the Audio Mixer dock rendered strips', docks.mixer > 0);
    checks.check('the status bar has content', docks.statusbar > 0);
    checks.check('the menu bar rendered', docks.menus > 0);

    /* Audio meters are the highest-volume path (a 60 Hz SSE stream); they prove
     * the event channel is genuinely live rather than replayed. */
    const meters = await waitForExpression(
      cdp,
      `Object.values(window.webmix?.store?.state?.audio ?? {}).some((a) => (a.levels ?? []).length > 0)`,
      8000
    );
    checks.check('live audio levels reach the UI', Boolean(meters));

    /* The embedded preview server is part of the same in-process service. */
    const previewSource = state.program;
    const preview = await cdp.evaluate(
      `fetch('api/preview.jpg?source=' + encodeURIComponent(${JSON.stringify(previewSource)}) + '&width=320&height=180')
        .then((r) => r.ok ? r.arrayBuffer().then((b) => b.byteLength) : -r.status)
        .catch(() => -1)`,
      { awaitPromise: true }
    );
    checks.check('the embedded preview server renders a frame for the program scene', preview > 1000);

    /* Is the preview actually live? Show a colour source, read the pixel in the
     * middle of the pane, change the colour, read it again. This catches a
     * preview that is merely showing a stale frame - and it is the only way to
     * measure the native <img> stream, which JavaScript never touches. */
    const live = await cdp.evaluate(
      `(async () => {
        const api = window.webmix.api;
        const suffix = Date.now().toString(36);
        const scene = 'WebMIX live check ' + suffix;
        const source = 'WebMIX live ' + suffix;
        const previous = window.webmix.store.state.currentProgramScene;

        const sample = () => {
          const pane = document.querySelector('.obs-preview-pane.is-program');
          const el = pane?.querySelector('.obs-preview-image');
          if (!el) return null;
          const canvas = new OffscreenCanvas(3, 3);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(el, 0, 0, 3, 3);
          const d = ctx.getImageData(1, 1, 1, 1).data;
          return { r: d[0], g: d[1], b: d[2] };
        };
        const settle = async (ms) => new Promise((r) => setTimeout(r, ms));
        /* Wait for the stream to have a frame for this scene: a src swap (the
         * pane size is corrected on the first layout) briefly leaves the
         * element with no image at all. */
        const settleImage = async (timeout = 6000) => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const img = document.querySelector('.obs-preview-pane.is-program .obs-preview-image');
            if (img?.naturalWidth && img.currentSrc.includes(encodeURIComponent(scene))) return true;
            await settle(100);
          }
          return false;
        };

        try {
          await api.createScene(scene);
          const itemId = await api.createInput(scene, source, 'color_source_v3', {
            color: 0xff0000ff, width: 1920, height: 1080,
          });
          await api.setProgramScene(scene);
          await settleImage();
          await settle(600);
          const red = sample();

          await api.setInputSettings(source, { color: 0xffff0000 }, true);
          await settle(1200);
          const blue = sample();

          return {
            scene, source, previous, itemId,
            backend: window.webmix.ui.preview.backend,
            src: (document.querySelector('.obs-preview-pane.is-program .obs-preview-image')?.currentSrc ?? '').slice(0, 140),
            naturalWidth: document.querySelector('.obs-preview-pane.is-program .obs-preview-image')?.naturalWidth ?? -1,
            natural: (() => { const i = document.querySelector('.obs-preview-pane.is-program .obs-preview-image'); return i ? [i.naturalWidth, i.naturalHeight, i.complete] : null; })(),
            program: window.webmix.store.state.currentProgramScene,
            surfaceScene: window.webmix.ui.preview.surfaces[0]?.scene,
            useNative: window.webmix.ui.preview.useNativeStream,
            useWebgpu: window.webmix.ui.preview.useWebgpu,
            red, blue,
          };
        } catch (error) {
          return { scene, source, previous, error: String(error?.message ?? error) };
        } finally {
          if (previous) await api.setProgramScene(previous).catch(() => {});
          await api.removeScene(scene).catch(() => {});
          await api.removeInput(source).catch(() => {});
        }
      })()`,
      { awaitPromise: true }
    );

    if (live.scene) created.scenes.add(live.scene);
    if (live.source) created.inputs.add(live.source);
    console.log('     (preview backend: ' + JSON.stringify({ backend: live.backend, src: live.src, naturalWidth: live.naturalWidth, error: live.error }) + ')');
    checks.check(
      'without WebGPU the preview uses the native MJPEG stream',
      live.backend === 'stream' && /api\/preview\.mjpg/.test(live.src),
      { backend: live.backend, src: live.src, error: live.error }
    );
    checks.check(
      'the preview shows the source colour',
      live.red && live.red.r > 150 && live.red.b < 90,
      live.red
    );
    checks.check(
      'and follows a change made in OBS without a reload',
      live.blue && live.blue.b > 150 && live.blue.r < 90,
      live.blue
    );

    /* The selection frame is what the user drags, so it has to land exactly on
     * the source. Create a source at a known, non-unit scale and compare the
     * overlay against OBS's own transform mapped onto the pane: a frame that
     * ignored the scale, or applied it twice, is half or double size here. */
    const geometry = await cdp.evaluate(
      `(async () => {
        const api = window.webmix.api;
        const suffix = Date.now().toString(36);
        const scene = 'WebMIX geometry check ' + suffix;
        const source = 'WebMIX geometry ' + suffix;
        const previous = window.webmix.store.state.currentProgramScene;
        try {
          // Start from a clean slate: a run killed mid-flight would otherwise
          // fail on the next one with "a source already exists".
          await api.removeScene(scene).catch(() => {});
          await api.createScene(scene);
          const itemId = await api.createInput(scene, source, 'color_source_v3', {});
          await api.setSceneItemTransform(scene, itemId, {
            positionX: 480, positionY: 270, scaleX: 0.5, scaleY: 0.5, alignment: 5,
          });
          await api.setProgramScene(scene);
          await new Promise((r) => setTimeout(r, 400));

          const t = await api.getSceneItemTransform(scene, itemId);
          window.webmix.ui.preview.select(source);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

          const pane = document.querySelector('.obs-preview-pane.is-program');
          const frame = pane.querySelector('.obs-preview-image');
          const selection = pane.querySelector('.obs-preview-selection');
          if (selection.hidden) {
            const state = window.webmix.store.state;
            const preview = window.webmix.ui.preview;
            return {
              error: 'the selection frame stayed hidden',
              storeScene: state.currentProgramScene,
              surfaceScene: preview.surfaces[0]?.scene,
              selected: preview.selected,
              items: (state.sceneItems[scene] ?? []).map((i) => ({ n: i.sourceName, hasTransform: !!i.sceneItemTransform })),
              cached: preview.transforms ? [...preview.transforms.keys()] : null,
              itemId,
            };
          }

          const fr = frame.getBoundingClientRect();
          const pr = pane.getBoundingClientRect();
          const sr = selection.getBoundingClientRect();
          const video = window.webmix.store.state.video ?? {};
          const baseWidth = video.baseWidth || 1920;
          const baseHeight = video.baseHeight || 1080;
          const scale = Math.min(fr.width / baseWidth, fr.height / baseHeight);
          const pictureLeft = fr.left + (fr.width - baseWidth * scale) / 2;
          const pictureTop = fr.top + (fr.height - baseHeight * scale) / 2;

          return {
            sourceWidth: t.sourceWidth,
            scaleX: t.scaleX,
            reportedWidth: t.width,
            frameOverflowsPane: fr.width > pr.width + 1 || fr.height > pr.height + 1,
            // alignment LEFT|TOP anchors the item at its position.
            expected: [pictureLeft + t.positionX * scale, pictureTop + t.positionY * scale,
                       Math.abs(t.width) * scale, Math.abs(t.height) * scale],
            actual: [sr.left, sr.top, sr.width, sr.height],
          };
        } finally {
          if (previous) await api.setProgramScene(previous).catch(() => {});
          await api.removeScene(scene).catch(() => {});
          // Removing a scene does not always destroy a source created inside
          // it, and a check must not leave anything in the user's OBS.
          await api.removeInput(source).catch(() => {});
        }
      })()`,
      { awaitPromise: true }
    );

    if (geometry.scene) created.scenes.add(geometry.scene);
    if (geometry.source) created.inputs.add(geometry.source);
    if (geometry.error) {
      console.log('     (geometry setup: ' + JSON.stringify(geometry) + ')');
      checks.check('the selection frame is shown for a selected source', false);
    } else {
      checks.check(
        'OBS reports the item width with the scale already applied',
        Math.abs(geometry.reportedWidth - geometry.scaleX * geometry.sourceWidth) < 0.5
      );
      checks.check('the picture never overflows the element it is drawn in', geometry.frameOverflowsPane === false);
      const drift = geometry.expected.map((value, index) => Math.abs(value - geometry.actual[index]));
      checks.check(
        `the selection frame matches the source (max drift ${Math.max(...drift).toFixed(2)}px)`,
        Math.max(...drift) <= 1.5
      );
    }

    /* Snapping: drag an item so its centre ends up a few units off the canvas
     * centre and require it to land exactly on it, with the guide showing while
     * it is stuck. Alt must leave it wherever the pointer put it. */
    const setup = await cdp.evaluate(
      `(async () => {
        const api = window.webmix.api;
        const suffix = Date.now().toString(36);
        const scene = 'WebMIX snap check ' + suffix;
        const source = 'WebMIX snap ' + suffix;
        const previous = window.webmix.store.state.currentProgramScene;
        await api.createScene(scene);
        const itemId = await api.createInput(scene, source, 'color_source_v3', {});
        await api.setSceneItemTransform(scene, itemId, {
          positionX: 200, positionY: 200, scaleX: 0.25, scaleY: 0.25, alignment: 5,
        });
        await api.setProgramScene(scene);
        await new Promise((r) => setTimeout(r, 400));
        window.webmix.ui.preview.select(source);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        const pane = document.querySelector('.obs-preview-pane.is-program');
        const frame = pane.querySelector('.obs-preview-image');
        const selection = pane.querySelector('.obs-preview-selection');
        const fr = frame.getBoundingClientRect();
        const sr = selection.getBoundingClientRect();
        const video = window.webmix.store.state.video ?? {};
        const baseWidth = video.baseWidth || 1920;
        const baseHeight = video.baseHeight || 1080;
        return {
          scene, source, itemId, previous, baseWidth, baseHeight,
          scale: Math.min(fr.width / baseWidth, fr.height / baseHeight),
          item: { left: sr.left, top: sr.top, width: sr.width, height: sr.height },
          transform: await api.getSceneItemTransform(scene, itemId),
        };
      })()`,
      { awaitPromise: true }
    );

    /** Drag the pointer from one client point to another, optionally held Alt. */
    const drag = async (from, to, modifiers = 0) => {
      const common = { button: 'left', buttons: 1, modifiers, clickCount: 1 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, ...common });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, ...common });
      await delay(60);
      const guides = await cdp.evaluate(`(() => {
        const pane = document.querySelector('.obs-preview-pane.is-program');
        return {
          x: !pane.querySelector('.obs-preview-guide.is-x').hidden,
          y: !pane.querySelector('.obs-preview-guide.is-y').hidden,
        };
      })()`);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, modifiers, clickCount: 1,
      });
      return guides;
    };

    /** The item's centre in scene units, straight out of OBS. */
    const centreOf = async () =>
      cdp.evaluate(
        `window.webmix.api.getSceneItemTransform(${JSON.stringify(setup.scene)}, ${setup.itemId})
           .then((t) => JSON.stringify({ x: t.positionX + t.width / 2, y: t.positionY + t.height / 2 }))`,
        { awaitPromise: true }
      ).then(JSON.parse);

    const start = {
      x: setup.item.left + setup.item.width / 2,
      y: setup.item.top + setup.item.height / 2,
    };
    // Aim the centre 5 scene units short of each canvas centre line: close
    // enough to stick, far enough that landing there would be a coincidence.
    const near = { x: setup.baseWidth / 2 - 5, y: setup.baseHeight / 2 - 5 };
    const before = await centreOf();
    const guides = await drag(
      start,
      { x: start.x + (near.x - before.x) * setup.scale, y: start.y + (near.y - before.y) * setup.scale }
    );
    const snappedTo = await centreOf();

    checks.check(
      'dragging near the canvas centre sticks to it',
      Math.abs(snappedTo.x - setup.baseWidth / 2) < 0.5 && Math.abs(snappedTo.y - setup.baseHeight / 2) < 0.5,
      { wanted: [setup.baseWidth / 2, setup.baseHeight / 2], got: snappedTo }
    );
    checks.check('a guide is drawn on each snapped axis', guides.x === true && guides.y === true, guides);
    created.scenes.add(setup.scene);
    created.inputs.add(setup.source);

    // And Alt puts it exactly where the pointer left it. The first drag moved
    // the item, so the press point has to be read from the overlay again.
    const held = await cdp.evaluate(`(() => {
      const r = document.querySelector('.obs-preview-pane.is-program .obs-preview-selection').getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`).then(JSON.parse);
    const off = await drag(held, { x: held.x + 5 * setup.scale, y: held.y + 5 * setup.scale }, 1 /* Alt */);
    const unsnapped = await centreOf();
    checks.check(
      'holding Alt keeps the item off the snap lines',
      Math.abs(unsnapped.x - setup.baseWidth / 2) > 1 || Math.abs(unsnapped.y - setup.baseHeight / 2) > 1,
      { got: unsnapped }
    );
    checks.check('and Alt shows no guides', off.x === false && off.y === false, off);

    await cdp.evaluate(
      `(async () => {
        const api = window.webmix.api;
        if (${JSON.stringify(setup.previous)}) await api.setProgramScene(${JSON.stringify(setup.previous)}).catch(() => {});
        await api.removeScene(${JSON.stringify(setup.scene)}).catch(() => {});
        await api.removeInput(${JSON.stringify(setup.source)}).catch(() => {});
      })()`,
      { awaitPromise: true }
    );

    /* Every edge must stick - while moving *and* while resizing - and a locked
     * source must not be draggable at all. Each case starts from the same box
     * so one failure cannot push the item somewhere the next case cannot use. */
    const edge = await cdp.evaluate(
      `(async () => {
        const api = window.webmix.api;
        const suffix = Date.now().toString(36);
        const scene = 'WebMIX edge check ' + suffix;
        const source = 'WebMIX edge ' + suffix;
        const previous = window.webmix.store.state.currentProgramScene;
        await api.createScene(scene);
        const itemId = await api.createInput(scene, source, 'color_source_v3', {});
        await api.setProgramScene(scene);
        await new Promise((r) => setTimeout(r, 500));
        window.webmix.ui.preview.select(source);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        const pane = document.querySelector('.obs-preview-pane.is-program');
        const fr = pane.querySelector('.obs-preview-image').getBoundingClientRect();
        const v = window.webmix.store.state.video ?? {};
        const baseWidth = v.baseWidth || 1920, baseHeight = v.baseHeight || 1080;
        return JSON.stringify({
          scene, source, itemId, previous, baseWidth, baseHeight,
          scale: Math.min(fr.width / baseWidth, fr.height / baseHeight),
        });
      })()`,
      { awaitPromise: true }
    ).then(JSON.parse);

    created.scenes.add(edge.scene);
    created.inputs.add(edge.source);

    /** The item box in scene units, straight out of OBS. */
    const boxNow = async () =>
      cdp.evaluate(
        `window.webmix.api.getSceneItemTransform(${JSON.stringify(edge.scene)}, ${edge.itemId}).then((t) => JSON.stringify({
           left: t.positionX, top: t.positionY,
           right: t.positionX + t.width, bottom: t.positionY + t.height,
           width: t.width, height: t.height }))`,
        { awaitPromise: true }
      ).then(JSON.parse);

    /** Put the item back in the middle of the canvas, selected and settled. */
    const reset = async () => {
      await cdp.evaluate(
        `window.webmix.api.setSceneItemTransform(${JSON.stringify(edge.scene)}, ${edge.itemId},
           { positionX: 700, positionY: 400, scaleX: 0.2, scaleY: 0.2, alignment: 5 }).then(() => true)`,
        { awaitPromise: true }
      );
      await delay(150);
      await cdp.evaluate(`(window.webmix.ui.preview.select(${JSON.stringify(edge.source)}), true)`);
      await delay(120);
    };

    /** Where the overlay, or one of its handles, is on screen right now. */
    const screenPoint = async (handle) =>
      cdp.evaluate(
        `(() => {
          const pane = document.querySelector('.obs-preview-pane.is-program');
          const el = ${handle ? `pane.querySelector('.obs-preview-handle.is-${handle}')` : `pane.querySelector('.obs-preview-selection')`};
          if (!el || el.hidden) return 'null';
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) return 'null';
          return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        })()`
      ).then((raw) => (raw === 'null' ? null : JSON.parse(raw)));

    /**
     * Drag so that `sceneX`/`sceneY` becomes, for a move, the item's centre and
     * for a handle, the point the handle moves.
     */
    const dragTo = async (sceneX, sceneY, { handle = null } = {}) => {
      const from = await screenPoint(handle);
      if (!from) return false;
      const box = await boxNow();
      const anchor = handle
        ? {
            x: handle.includes('w') ? box.left : handle.includes('e') ? box.right : box.left + box.width / 2,
            y: handle.includes('n') ? box.top : handle.includes('s') ? box.bottom : box.top + box.height / 2,
          }
        : { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const to = { x: from.x + (sceneX - anchor.x) * edge.scale, y: from.y + (sceneY - anchor.y) * edge.scale };
      const common = { button: 'left', buttons: 1, clickCount: 1 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, ...common });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, ...common });
      await delay(80);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
      });
      await delay(150);
      return true;
    };

    /* Moving: aim the item's centre so the named edge lands 3 units short. */
    const moves = [
      { edge: 'right', aim: (b) => [edge.baseWidth - 3 - b.width / 2, b.top + b.height / 2], read: (b) => b.right, want: () => edge.baseWidth },
      { edge: 'left', aim: (b) => [3 + b.width / 2, b.top + b.height / 2], read: (b) => b.left, want: () => 0 },
      { edge: 'bottom', aim: (b) => [b.left + b.width / 2, edge.baseHeight - 3 - b.height / 2], read: (b) => b.bottom, want: () => edge.baseHeight },
      { edge: 'top', aim: (b) => [b.left + b.width / 2, 3 + b.height / 2], read: (b) => b.top, want: () => 0 },
    ];

    for (const test of moves) {
      await reset();
      const before = await boxNow();
      const [x, y] = test.aim(before);
      const started = await dragTo(x, y);
      const got = test.read(await boxNow());
      checks.check(
        `moving: the ${test.edge} edge sticks to the canvas`,
        started && Math.abs(got - test.want()) < 0.5,
        { got, want: test.want(), started }
      );
    }

    /* Resizing: the dragged edge is aimed directly at the canvas edge. */
    const resizes = [
      { handle: 'e', aim: () => [edge.baseWidth - 3, 0], read: (b) => b.right, want: () => edge.baseWidth },
      { handle: 'w', aim: () => [3, 0], read: (b) => b.left, want: () => 0 },
      { handle: 's', aim: () => [0, edge.baseHeight - 3], read: (b) => b.bottom, want: () => edge.baseHeight },
      { handle: 'n', aim: () => [0, 3], read: (b) => b.top, want: () => 0 },
    ];

    for (const test of resizes) {
      await reset();
      const before = await boxNow();
      const [x, y] = test.aim(before);
      const started = await dragTo(x, y, { handle: test.handle });
      const after = await boxNow();
      const got = test.read(after);
      const anchored =
        test.handle === 'e' ? Math.abs(after.left - before.left) < 0.5
        : test.handle === 'w' ? Math.abs(after.right - before.right) < 0.5
        : test.handle === 's' ? Math.abs(after.top - before.top) < 0.5
        : Math.abs(after.bottom - before.bottom) < 0.5;
      checks.check(
        `resizing: the ${test.handle} handle sticks its edge to the canvas`,
        started && Math.abs(got - test.want()) < 0.5 && anchored,
        { got, want: test.want(), anchored, started }
      );
    }

    /* A locked source behaves like a locked source in OBS: no transform box, no
     * picking it up, no resizing it. */
    await reset();
    await cdp.evaluate(
      `window.webmix.api.request('SetSceneItemLocked', { sceneName: ${JSON.stringify(edge.scene)}, sceneItemId: ${edge.itemId}, sceneItemLocked: true }).then(() => true)`,
      { awaitPromise: true }
    );
    await delay(200);
    const lockedBefore = await boxNow();
    const lockState = await cdp.evaluate(`JSON.stringify({
      hidden: document.querySelector('.obs-preview-pane.is-program .obs-preview-selection').hidden,
      inStore: (window.webmix.store.state.sceneItems[${JSON.stringify(edge.scene)}] ?? [])[0]?.sceneItemLocked,
      selected: window.webmix.ui.preview.selected,
    })`).then(JSON.parse);
    const boxHidden = lockState.hidden;
    await cdp.evaluate(
      `document.querySelector('.obs-preview-pane.is-program .obs-preview-image').dispatchEvent(
         new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, clientX: 800, clientY: 320 }))`
    );
    await delay(100);
    const lockedMove = await cdp.evaluate(
      `(() => { const p = window.webmix.ui.preview; return JSON.stringify({ drag: Boolean(p.drag), selected: p.selected }); })()`
    ).then(JSON.parse);
    checks.check('a locked source shows no transform box', boxHidden === true, lockState);
    checks.check('and cannot be picked up in the preview', lockedMove.drag === false, lockedMove);

    await cdp.evaluate(`(window.webmix.ui.preview.select(${JSON.stringify(edge.source)}), true)`);
    const lockedDrag = await dragTo(lockedBefore.left + lockedBefore.width / 2 + 240, lockedBefore.top + lockedBefore.height / 2 + 140);
    const lockedAfter = await boxNow();
    checks.check(
      'a locked source cannot be moved in the preview',
      Math.abs(lockedAfter.left - lockedBefore.left) < 0.5 && Math.abs(lockedAfter.top - lockedBefore.top) < 0.5,
      { before: [lockedBefore.left, lockedBefore.top], after: [lockedAfter.left, lockedAfter.top], lockedDrag }
    );

    await cdp.evaluate(
      `(async () => {
        const api = window.webmix.api;
        if (${JSON.stringify(edge.previous)}) await api.setProgramScene(${JSON.stringify(edge.previous)}).catch(() => {});
        await api.removeScene(${JSON.stringify(edge.scene)}).catch(() => {});
        await api.removeInput(${JSON.stringify(edge.source)}).catch(() => {});
      })()`,
      { awaitPromise: true }
    );

    created.scenes.add(SCENE_NAME);

    /* Drive OBS from the UI and require the change to come back through the
     * event stream: this is the round trip the whole architecture exists for. */
    await cdp.evaluate(`window.webmix.api.createScene(${JSON.stringify(SCENE_NAME)}).catch(() => {})`);
    const appeared = await waitForExpression(
      cdp,
      `(window.webmix?.store?.state?.scenes ?? []).some((s) => s.sceneName === ${JSON.stringify(SCENE_NAME)})`,
      8000
    );
    checks.check('a scene created from the UI reaches the store through the event stream', Boolean(appeared));

    await cdp.evaluate(`window.webmix.api.removeScene(${JSON.stringify(SCENE_NAME)}).catch(() => {})`);
    const disappeared = await waitForExpression(
      cdp,
      `!(window.webmix?.store?.state?.scenes ?? []).some((s) => s.sceneName === ${JSON.stringify(SCENE_NAME)})`,
      8000
    );
    checks.check('removing it again is reflected too', Boolean(disappeared));

    checks.check('no uncaught page exceptions', pageErrors.length === 0);
    checks.check('no console errors', consoleErrors.length === 0);

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SCREENSHOT, Buffer.from(data, 'base64'));
    console.log(`screenshot: ${SCREENSHOT}`);

    console.log(`\n${checks.passed}/${checks.passed + checks.failed} checks passed`);
    exitCode = checks.failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(error.stack ?? String(error));
  } finally {
    await sweep().catch(() => {});
    if (programBefore) await obsRequest('SetCurrentProgramScene', { sceneName: programBefore }).catch(() => {});
    await restoreStudio().catch(() => {});
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  process.exit(exitCode);
}

main();
