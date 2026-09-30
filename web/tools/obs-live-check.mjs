#!/usr/bin/env node
/*
 * WebMIX live check.
 *
 * Drives the REAL built OBS (started with --web) in headless Chromium and
 * verifies the whole stack end to end:
 *
 *   OBS (no window, obs-websocket + embedded web server)  ->  browser UI
 *
 * Unlike tools/browser-smoke.mjs this uses no mocks: it connects to a running
 * `obs --web` instance and exercises the live obs-websocket protocol, then
 * checks the embedded server's control endpoints (including shutdown).
 *
 * Usage: node tools/obs-live-check.mjs [--url http://127.0.0.1:4460/] [--shutdown]
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE = getArg('url', 'http://127.0.0.1:4460/');
const SCREENSHOT = getArg('screenshot', '/tmp/webmix-live.png');
const DO_SHUTDOWN = args.includes('--shutdown');
const CDP_PORT = Number(getArg('cdp-port', 9355));
const PROFILE_DIR = join(tmpdir(), 'webmix-live-chrome');

const CHROMIUM_CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

function findChromium() {
  for (const name of CHROMIUM_CANDIDATES) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
  }
  return null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const fn of this.handlers.get(message.method) ?? []) fn(message.params);
      }
    };
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 20000);
    });
  }
}

async function waitForTarget(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await delay(150);
  }
  throw new Error('Chromium DevTools target did not appear');
}

const checks = [];
const check = (label, condition) => {
  checks.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
};

const chromium = findChromium();
if (!chromium) {
  console.log('SKIP: no chromium/chrome found.');
  process.exit(0);
}

// The OBS instance under test must already be running (started by the caller).
try {
  const status = await (await fetch(`${BASE}api/status`)).json();
  if (status.webmix !== true) throw new Error('not a WebMIX host');
  console.log(`target: ${BASE} (OBS ${status.version}, web root ${status.webRoot})`);
} catch (err) {
  console.error(`No WebMIX host at ${BASE}: ${err.message}`);
  process.exit(1);
}

rmSync(PROFILE_DIR, { recursive: true, force: true });
const browser = spawn(
  chromium,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--enable-unsafe-webgpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1600,900',
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let exitCode = 1;
let socket = null;
try {
  const target = await waitForTarget(CDP_PORT);
  socket = new WebSocket(target);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('could not attach to Chromium'));
  });

  const cdp = new Cdp(socket);
  const pageErrors = [];
  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.exception?.description ?? 'exception'));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // No query parameters: the UI must discover everything from the host.
  await cdp.send('Page.navigate', { url: BASE });
  await delay(7000);

  const { result: stateResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      host: window.webmix ? 'exposed' : 'missing',
      connected: window.webmix?.client?.connected ?? false,
      url: window.webmix?.client?.url ?? null,
      status: window.webmix?.store?.state?.connection?.status ?? 'unknown',
      scenes: (window.webmix?.store?.state?.scenes ?? []).map(s => s.sceneName),
      program: window.webmix?.store?.state?.currentProgramScene ?? null,
      inputs: Object.keys(window.webmix?.store?.state?.inputs ?? {}).length,
      docks: document.querySelectorAll('.obs-dock').length,
      version: window.webmix?.store?.state?.version?.obsVersion ?? null,
      appHidden: document.getElementById('app')?.hidden ?? null,
      connectScreenHidden: document.getElementById('connect-screen')?.hidden ?? null,
    })`,
    returnByValue: true,
  });
  let state = {};
  try {
    state = JSON.parse(stateResult.value ?? '{}');
  } catch { /* ignore */ }

  console.log(`  state: ${JSON.stringify(state)}`);

  check('UI booted', state.host === 'exposed');
  check('auto-connected to the real OBS', state.connected === true);
  check('connected to the obs-websocket port', String(state.url ?? '').includes('4461'));
  check('OBS reports its version', typeof state.version === 'string' && state.version.length > 0);
  check('real OBS returned its default scene', (state.scenes ?? []).length >= 1);
  check('program scene set', typeof state.program === 'string' && state.program.length > 0);
  check('6 docks rendered', state.docks === 6);
  check('app shell visible', state.appHidden === false);
  check('connect screen hidden', state.connectScreenHidden === true);

  // Exercise the live protocol: create a scene through the UI's API, then check
  // OBS really created it (this is the real thing, not a mock).
  const { result: created } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const api = window.webmix.api;
      const name = 'WebMIX Live Test';
      try { await api.createScene(name); } catch (e) { return 'error: ' + e.message; }
      const scenes = (await api.request('GetSceneList')).scenes.map(s => s.sceneName);
      return JSON.stringify(scenes);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  let scenes = [];
  try {
    scenes = JSON.parse(created.value ?? '[]');
  } catch { /* ignore */ }
  check('created a real scene in OBS', scenes.includes('WebMIX Live Test'));

  // Clean up so repeated runs stay idempotent.
  await cdp.send('Runtime.evaluate', {
    expression: `window.webmix.api.removeScene('WebMIX Live Test').catch(() => {})`,
    awaitPromise: true,
  });

  // Bridge operations: scene order, transition management and hotkey rebinding
  // have no obs-websocket request at all, so they run through the embedded
  // server. Each assertion checks the effect on OBS itself.
  const { result: bridgeResult } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const api = window.webmix.api;
      const out = {};
      const post = async (path) => (await fetch(path, { method: 'POST' })).json();
      const sceneNames = () => window.webmix.store.state.scenes.map((s) => s.sceneName);
      const transitionNames = async () =>
        (await api.request('GetSceneTransitionList')).transitions.map((t) => t.transitionName);

      for (const name of ['Live A', 'Live B', 'Live C']) {
        try { await api.createScene(name); } catch { /* exists */ }
      }
      await api.refreshScenes();
      const before = sceneNames();
      const from = before.indexOf('Live A');
      out.move = await post('api/scenes/move?from=' + from + '&to=0');
      await api.refreshScenes();
      const after = sceneNames();
      out.sceneFrom = from;
      out.sceneBefore = before.slice(0, 3);
      out.sceneAfter = after.slice(0, 3);
      out.sceneMoved = from > 0 && after[0] === 'Live A';
      out.sceneBadIndex = await post('api/scenes/move?from=0&to=999');

      out.add = await post('api/transitions/add?kind=fade_to_color_transition&name=Live%20Wipe');
      out.added = (await transitionNames()).includes('Live Wipe');
      out.addDuplicate = await post('api/transitions/add?kind=fade_to_color_transition&name=Live%20Wipe');
      out.rename = await post('api/transitions/rename?name=Live%20Wipe&newName=Live%20Wipe%202');
      out.renamed = (await transitionNames()).includes('Live Wipe 2');
      out.remove = await post('api/transitions/remove?name=Live%20Wipe%202');
      out.removed = !(await transitionNames()).includes('Live Wipe 2');

      out.bind = await post('api/hotkeys/bind?name=OBSBasic.StartRecording&key=OBS_KEY_F9&modifiers=control');
      const hotkeys = await (await fetch('api/hotkeys')).json();
      out.binding = hotkeys.hotkeys.find((h) => h.name === 'OBSBasic.StartRecording')?.bindings ?? [];
      out.badKey = await post('api/hotkeys/bind?name=OBSBasic.StartRecording&key=OBS_KEY_NOPE&modifiers=');
      out.clear = await post('api/hotkeys/clear?name=OBSBasic.StartRecording');
      const after2 = await (await fetch('api/hotkeys')).json();
      out.cleared = (after2.hotkeys.find((h) => h.name === 'OBSBasic.StartRecording')?.bindings ?? []).length === 0;

      for (const name of ['Live A', 'Live B', 'Live C']) {
        try { await api.removeScene(name); } catch { /* ignore */ }
      }
      return JSON.stringify(out);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  let bridge = {};
  try {
    bridge = JSON.parse(bridgeResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  bridge ops: ${JSON.stringify(bridge)}`);

  check('scene reorder works through the bridge', bridge.move?.ok === true && bridge.sceneMoved === true);
  check('scene reorder rejects out-of-range indices', bridge.sceneBadIndex?.ok === false);
  check('transition created in OBS', bridge.add?.ok === true && bridge.added === true);
  check('duplicate transition name rejected', bridge.addDuplicate?.ok === false);
  check('transition renamed in OBS', bridge.rename?.ok === true && bridge.renamed === true);
  check('transition removed from OBS', bridge.remove?.ok === true && bridge.removed === true);
  check(
    'hotkey rebound in OBS',
    bridge.bind?.ok === true && (bridge.binding ?? []).some((b) => /F9/.test(b))
  );
  check('unknown key rejected', bridge.badKey?.ok === false);
  check('hotkey cleared', bridge.clear?.ok === true && bridge.cleared === true);

  // Preview rendering: with the embedded server the OBS frames are streamed and
  // drawn by WebGPU, so check the backend really is the GPU one and that frames
  // are arriving (not just that a canvas exists).
  const { result: gpuResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      backend: window.webmix?.ui?.preview?.backend ?? null,
      surfaces: window.webmix?.ui?.preview?.surfaces?.length ?? 0,
      frames: window.webmix?.ui?.preview?.surfaces?.[0]?.renderer?.frames ?? 0,
      canvas: document.querySelectorAll('canvas.obs-preview-gpu').length,
      img: document.querySelectorAll('img.obs-preview-image').length,
    })`,
    returnByValue: true,
  });
  let gpu = {};
  try {
    gpu = JSON.parse(gpuResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  preview: ${JSON.stringify(gpu)}`);

  check('preview uses the WebGPU backend', gpu.backend === 'webgpu');
  check('preview draws into a GPU canvas', gpu.canvas >= 1 && gpu.img === 0);
  check('preview received streamed frames', gpu.frames >= 3);

  // The compositor does not always include WebGPU canvas contents in headless
  // screenshots, so verify the pipeline by rendering a real OBS frame and
  // reading the result back from the GPU.
  const { result: pixelResult } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const gpu = window.webmix?.WebGpuPreview;
      if (!gpu) return JSON.stringify({ ok: false, error: 'WebGpuPreview not exposed' });
      const scene = window.webmix?.store?.state?.currentProgramScene ?? '';
      const result = await gpu.selfTest({ source: scene, width: 480, height: 270 });
      // Keep the payload small: report the palette, not all 130k pixels.
      if (result.pixels) {
        window.__webmixGpuPixels = result.pixels;
        delete result.pixels;
      }
      return JSON.stringify(result);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  let pixels = {};
  try {
    pixels = JSON.parse(pixelResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  gpu self-test: ${JSON.stringify(pixels)}`);
  const dominant = (pixels.top ?? [])[0]?.[0]?.split(',').map(Number) ?? [];
  check('GPU pipeline renders an OBS frame', pixels.ok === true);
  check(
    'GPU output shows the green test source',
    dominant.length === 3 && dominant[1] > 100 && dominant[1] > dominant[0] + 50 && dominant[1] > dominant[2] + 50
  );

  // Write the GPU frame to a PNG as visual evidence.
  const { result: pngResult } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const pixels = window.__webmixGpuPixels;
      if (!pixels) return null;
      const width = ${pixels.size?.[0] ?? 480};
      const height = ${pixels.size?.[1] ?? 270};
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(width, height);
      image.data.set(pixels);
      ctx.putImageData(image, 0, 0);
      return canvas.convertToBlob({ type: 'image/png' }).then((blob) => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      }));
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (typeof pngResult?.value === 'string' && pngResult.value.startsWith('data:image/png')) {
    const gpuPath = SCREENSHOT.replace(/\.png$/, '-gpu-frame.png');
    writeFileSync(gpuPath, Buffer.from(pngResult.value.split(',')[1], 'base64'));
    console.log(`GPU frame written: ${gpuPath}`);
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot: ${SCREENSHOT} (${existsSync(SCREENSHOT) ? 'written' : 'MISSING'})`);

  // File access: a headless box has no file manager, so recordings and logs
  // must be listable and downloadable from the browser - and traversal refused.
  const { result: filesResult } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const out = {};
      const list = await (await fetch('api/files/list?kind=logs')).json();
      out.logPath = list.path ?? null;
      out.logCount = (list.entries ?? []).length;
      // Use the OLDEST log: the newest one is being written to right now, so
      // its size changes between the listing and the download.
      const files = (list.entries ?? []).filter((entry) => !entry.isDirectory);
      const stable = files[files.length - 1];
      out.newest = stable?.name ?? null;
      if (stable) {
        const response = await fetch('api/files/download?kind=logs&path=' + encodeURIComponent(stable.name));
        const bytes = await response.arrayBuffer();
        out.downloadStatus = response.status;
        out.downloadBytes = bytes.byteLength;
        out.declaredBytes = stable.size;
        out.disposition = response.headers.get('content-disposition');
        const text = await (await fetch('api/files/text?kind=logs&path=' + encodeURIComponent(stable.name) + '&limit=2048')).text();
        out.textLooksLikeLog = /\\d\\d:\\d\\d:\\d\\d/.test(text);
      }
      out.traversal = [];
      for (const candidate of ['../logs', '..%2f..%2fetc%2fpasswd', '/etc/passwd', 'sub/dir']) {
        const response = await fetch('api/files/download?kind=logs&path=' + candidate);
        out.traversal.push(response.status);
      }
      return JSON.stringify(out);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  let files = {};
  try {
    files = JSON.parse(filesResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  files: ${JSON.stringify({ ...files, textLooksLikeLog: files.textLooksLikeLog })}`);

  check('log directory is listable', (files.logCount ?? 0) >= 1 && /logs$/.test(files.logPath ?? ''));
  check('log file downloads intact', files.downloadStatus === 200 && files.downloadBytes === files.declaredBytes);
  check(
    'download sets a readable attachment name',
    typeof files.disposition === 'string' &&
      files.disposition.includes('attachment') &&
      files.disposition.includes("filename*=UTF-8''")
  );
  check('log text can be read in the browser', files.textLooksLikeLog === true);
  check('file traversal is refused', (files.traversal ?? []).every((status) => status === 404));

  // The menu items that used to say "desktop UI only" now open the browser.
  await cdp.send('Runtime.evaluate', {
    expression: `window.webmix.ui.dispatch('showRecordings')`,
    awaitPromise: true,
  });
  await delay(900);
  const { result: recordingsResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      dialog: [...document.querySelectorAll('.obs-dialog-title')].some((t) => t.textContent.includes('Recordings')),
      rows: document.querySelectorAll('.obs-files-table tbody tr').length,
      path: document.querySelector('.obs-files-path')?.textContent ?? '',
    })`,
    returnByValue: true,
  });
  let recordings = {};
  try {
    recordings = JSON.parse(recordingsResult.value ?? '{}');
  } catch { /* ignore */ }
  check('Show Recordings opens a browser dialog', recordings.dialog === true && recordings.rows >= 1);
  console.log(`  recordings dialog: ${JSON.stringify(recordings)}`);

  const filesShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SCREENSHOT.replace(/\.png$/, '-files.png'), Buffer.from(filesShot.data, 'base64'));

  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('.obs-modal-backdrop .obs-dialog-close')?.click()`,
  });
  await delay(200);

  // Help > View Current Log opens the newest log inline.
  await cdp.send('Runtime.evaluate', {
    expression: `window.webmix.ui.dispatch('viewCurrentLog')`,
    awaitPromise: true,
  });
  await delay(1200);
  const { result: logViewResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      viewer: !!document.querySelector('.obs-file-viewer'),
      chars: document.querySelector('.obs-file-viewer')?.textContent.length ?? 0,
    })`,
    returnByValue: true,
  });
  let logView = {};
  try {
    logView = JSON.parse(logViewResult.value ?? '{}');
  } catch { /* ignore */ }
  check('View Current Log renders the log inline', logView.viewer === true && logView.chars > 100);
  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.obs-modal-backdrop .obs-dialog-close').forEach((b) => b.click())`,
  });
  await delay(200);

  // Multiview: OBS composes the grid server-side. Verify from the browser that
  // the tiles land where the scene order says they should.
  const { result: multivewResult } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const scenes = window.webmix.store.state.scenes.map((s) => s.sceneName);
      const response = await fetch('api/preview/multiview.jpg?width=640&height=360&quality=92');
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
      const columns = Math.ceil(Math.sqrt(scenes.length));
      const rows = Math.ceil(scenes.length / columns);
      const tiles = [];
      for (let i = 0; i < Math.min(scenes.length, 4); i++) {
        const cx = Math.floor(((i % columns) + 0.5) * (bitmap.width / columns));
        const cy = Math.floor((Math.floor(i / columns) + 0.5) * (bitmap.height / rows));
        tiles.push({ scene: scenes[i], rgb: at(cx, cy) });
      }
      // A scene with a colour source renders a saturated tile.
      const saturated = tiles.filter((t) => {
        const [r, g, b] = t.rgb;
        return Math.max(r, g, b) > 100;
      }).length;
      return JSON.stringify({ status: response.status, scenes: scenes.length, columns, rows, tiles, saturated });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  let multiview = {};
  try {
    multiview = JSON.parse(multivewResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  multiview: ${JSON.stringify(multiview)}`);
  check('multiview frame is served', multiview.status === 200 && multiview.scenes >= 3);
  check('multiview grid matches the scene count', multiview.columns >= 2 && multiview.rows >= 1);
  check('multiview tiles show scene content', (multiview.saturated ?? 0) >= 2);

  // The multiview overlay renders labels for every tile.
  await cdp.send('Runtime.evaluate', {
    expression: `window.webmix.ui.dispatch('openMultiview')`,
    awaitPromise: true,
  });
  await delay(1500);
  const { result: overlayResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      overlay: !!document.querySelector('.obs-multiview'),
      labels: [...document.querySelectorAll('.obs-multiview-label')].map((el) => el.textContent.trim()),
      canvas: !!document.querySelector('.obs-multiview-frame canvas'),
      status: document.querySelector('.obs-multiview-status')?.textContent ?? '',
    })`,
    returnByValue: true,
  });
  let overlay = {};
  try {
    overlay = JSON.parse(overlayResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  multiview overlay: ${JSON.stringify(overlay)}`);
  check('multiview overlay opens with a label per scene', overlay.overlay === true && overlay.labels.length >= 3);
  check('multiview overlay draws on the GPU', overlay.canvas === true);

  const multiviewShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SCREENSHOT.replace(/\.png$/, '-multiview.png'), Buffer.from(multiviewShot.data, 'base64'));

  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('.obs-multiview-close')?.click()`,
  });
  await delay(300);

  // Colours: OBS uses 0xAABBGGRR, so red is 0x0000FF in the low byte. A swap
  // here would show every colour picker in the UI with red and blue exchanged.
  const { result: colourResult } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      // The colour lives on the source inside the scene, not the scene itself.
      const inputs = Object.keys(window.webmix.store.state.inputs);
      const source = inputs.find((name) => /^MV A/.test(name));
      if (!source) return JSON.stringify({ skipped: true, inputs });
      const props = await (await fetch('api/properties/source?name=' + encodeURIComponent(source))).json();
      const value = props.values?.color;
      // The dialog passes withAlpha for colour_alpha properties (this one is).
      const definition = (props.properties ?? []).find((p) => p.name === 'color');
      const withAlpha = definition?.alpha === true;
      const hex = window.webmix.properties.colorIntToHex(value, withAlpha);
      const back = window.webmix.properties.hexToColorInt(hex, withAlpha);
      return JSON.stringify({ source, value, withAlpha, hex, back, roundTrips: back === value });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  let colour = {};
  try {
    colour = JSON.parse(colourResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  colour: ${JSON.stringify(colour)}`);
  // A red source must read back as red: with the byte order wrong this would
  // be '#0000ff...' and every colour picker would show red and blue swapped.
  check(
    'OBS colour renders as its real colour in the UI',
    typeof colour.hex === 'string' && colour.hex.startsWith('#ff0000')
  );
  check('colour conversions round-trip against OBS', colour.roundTrips === true);

  // Output settings: the Simple mode choices must come from OBS, with the
  // localised names it uses, and round-trip through the active profile.
  const { result: outputResult } = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const out = {};
      const encoders = await (await fetch('api/encoders')).json();
      out.streamValues = (encoders.videoStreaming ?? []).map((e) => e.value);
      out.available = (encoders.videoStreaming ?? []).filter((e) => e.available).map((e) => e.value);
      out.hasLocalisedLabels = (encoders.videoStreaming ?? []).every((e) => typeof e.label === 'string' && e.label.length > 0);
      out.formats = (encoders.recordingFormats ?? []).map((f) => f.value);
      out.qualities = (encoders.recordingQualities ?? []).map((q) => q.value);
      out.audioValues = (encoders.audio ?? []).map((a) => a.value);
      // The values the UI offers must be the values OBS stores in the profile,
      // otherwise the dialog would silently fall back to a "(current)" entry.
      out.storedFormat = await window.webmix.api.getProfileParameter('SimpleOutput', 'RecFormat2');
      out.storedAudio = await window.webmix.api.getProfileParameter('SimpleOutput', 'StreamAudioEncoder');

      // Write through the same API the dialog uses, then read back from OBS.
      const original = await window.webmix.api.getProfileParameter('SimpleOutput', 'VBitrate');
      await window.webmix.api.setProfileParameter('SimpleOutput', 'VBitrate', '4321');
      out.readBack = await window.webmix.api.getProfileParameter('SimpleOutput', 'VBitrate');
      await window.webmix.api.setProfileParameter('SimpleOutput', 'VBitrate', original || '2500');
      out.restored = await window.webmix.api.getProfileParameter('SimpleOutput', 'VBitrate');
      return JSON.stringify(out);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  let output = {};
  try {
    output = JSON.parse(outputResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  output settings: ${JSON.stringify(output)}`);
  check('OBS offers its encoder list', (output.streamValues ?? []).includes('x264') && (output.streamValues ?? []).length >= 5);
  check('encoder names are localised by OBS', output.hasLocalisedLabels === true);
  check('at least one encoder is available here', (output.available ?? []).length >= 1);
  check('recording formats and qualities listed', (output.formats ?? []).includes('mkv') && (output.qualities ?? []).includes('HQ'));
  check(
    'offered values match what OBS stores',
    (output.formats ?? []).includes(output.storedFormat) &&
      (output.audioValues ?? []).includes(output.storedAudio)
  );
  check('profile parameters round-trip through OBS', output.readBack === '4321' && output.restored !== '4321');

  // The Settings dialog must render those as real controls.
  await cdp.send('Runtime.evaluate', {
    expression: `window.webmix.ui.dispatch('openSettings')`,
    awaitPromise: true,
  });
  await delay(800);
  await cdp.send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.obs-tab')].find((t) => t.textContent.trim() === 'Output')?.click()`,
  });
  await delay(900);
  const { result: outputUiResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      selects: document.querySelectorAll('.obs-settings-body select').length,
      numbers: document.querySelectorAll('.obs-settings-body input[type=number]').length,
      firstEncoder: [...document.querySelectorAll('.obs-settings-body select')]
        .flatMap((s) => [...s.options].map((o) => o.value))
        .includes('x264'),
    })`,
    returnByValue: true,
  });
  let outputUi = {};
  try {
    outputUi = JSON.parse(outputUiResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  output page: ${JSON.stringify(outputUi)}`);
  check('Output page renders selectors and numbers', (outputUi.selects ?? 0) >= 3 && (outputUi.numbers ?? 0) >= 3);
  check('Output page offers the OBS encoders', outputUi.firstEncoder === true);

  const outputShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SCREENSHOT.replace(/\.png$/, '-output-settings.png'), Buffer.from(outputShot.data, 'base64'));
  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('.obs-modal-backdrop .obs-dialog-close')?.click()`,
  });
  await delay(300);

  // Settings > Hotkeys must show the bindings OBS actually has (via the
  // bridge), not just hotkey names.
  await cdp.send('Runtime.evaluate', {
    expression: `window.webmix.ui.dispatch('openSettings')`,
    awaitPromise: true,
  });
  await delay(700);
  await cdp.send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.obs-tab')].find((t) => t.textContent.trim() === 'Hotkeys')?.click()`,
  });
  await delay(900);
  const { result: hotkeyTabResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      table: !!document.querySelector('.obs-hotkey-table'),
      rows: document.querySelectorAll('.obs-hotkey-table tbody tr').length,
      headers: [...document.querySelectorAll('.obs-hotkey-table thead th')].map((th) => th.textContent.trim()),
      hasObsColumn: [...document.querySelectorAll('.obs-hotkey-table tbody tr')]
        .some((row) => /OBS_KEY|\\u2014|n\\/a/.test(row.children[1]?.textContent ?? '')),
      hasBindButtons: [...document.querySelectorAll('.obs-hotkey-table button')].some((b) => b.textContent.trim() === 'Bind'),
    })`,
    returnByValue: true,
  });
  let hotkeyTab = {};
  try {
    hotkeyTab = JSON.parse(hotkeyTabResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  hotkeys tab: ${JSON.stringify(hotkeyTab)}`);
  check('hotkeys tab renders every hotkey', hotkeyTab.table === true && hotkeyTab.rows >= 20);
  check(
    'hotkeys tab separates OBS bindings from browser shortcuts',
    (hotkeyTab.headers ?? []).includes('In OBS') && (hotkeyTab.headers ?? []).includes('Browser')
  );
  check('hotkeys tab offers rebinding', hotkeyTab.hasBindButtons === true);

  const hotkeyShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SCREENSHOT.replace(/\.png$/, '-hotkeys.png'), Buffer.from(hotkeyShot.data, 'base64'));

  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('.obs-modal-backdrop .obs-dialog-close')?.click()`,
  });
  await delay(200);

  check('no uncaught page exceptions', pageErrors.length === 0);
  check('no console errors', consoleErrors.length === 0);
  if (pageErrors.length) console.log(pageErrors.slice(0, 5).join('\n'));
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 5).join('\n'));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} live checks passed`);
  exitCode = failed.length ? 1 : 0;

  if (DO_SHUTDOWN) {
    const response = await fetch(`${BASE}api/shutdown`, { method: 'POST' });
    console.log(`shutdown endpoint: ${response.status} ${await response.text()}`);
  }
} catch (err) {
  console.error(`live check error: ${err.message}`);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { browser.kill('SIGKILL'); } catch { /* ignore */ }
}

process.exit(exitCode);
