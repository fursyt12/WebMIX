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
