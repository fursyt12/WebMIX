#!/usr/bin/env node
/*
 * WebMIX browser smoke test.
 *
 * Boots the mock obs-websocket server + the static file server, then drives
 * the real web UI in headless Chromium over the DevTools protocol:
 *
 *   - autoconnects to the mock OBS
 *   - waits for the OBS shell to render and populate
 *   - asserts on the dock layout, scene list, source list, mixer strips,
 *     transitions, controls, status bar and menu bar
 *   - fails on any uncaught page exception or console error
 *   - writes a screenshot for visual inspection
 *
 * Usage: node tools/browser-smoke.mjs [--screenshot path.png] [--keep]
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { startMockObs } from '../test/helpers/mock-obs.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const SCREENSHOT = getArg('screenshot', '/tmp/webmix-smoke.png');
const APP_PORT = Number(getArg('app-port', 8123));
const CDP_PORT = Number(getArg('cdp-port', 9333));
const WAIT_MS = Number(getArg('wait', 5000));

const CHROMIUM_CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
const PROFILE_DIR = join(tmpdir(), 'webmix-chrome-profile');

function findChromium() {
  for (const name of CHROMIUM_CANDIDATES) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
  }
  return null;
}

/** Minimal DevTools-protocol client over the page target's websocket. */
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

async function waitForHttp(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* retry */
    }
    await delay(120);
  }
  return false;
}

const chromium = findChromium();
if (!chromium) {
  console.log('SKIP: no chromium/chrome found; browser smoke test not run.');
  process.exit(0);
}

const checks = [];
const check = (label, condition) => {
  checks.push({ label, ok: Boolean(condition) });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
};

const mock = await startMockObs();
// A fresh profile keeps localStorage (layout, docks, hotkeys) deterministic.
rmSync(PROFILE_DIR, { recursive: true, force: true });
const appServer = spawn(process.execPath, ['server.mjs', '--port', String(APP_PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
});
const browser = spawn(
  chromium,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1600,900',
    // An isolated profile is required: without it Chromium hands the request to
    // an already-running instance and never opens the debugging port.
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const cleanup = () => {
  try { browser.kill('SIGKILL'); } catch { /* ignore */ }
  try { appServer.kill('SIGTERM'); } catch { /* ignore */ }
  mock.close();
};

let exitCode = 1;
let socket = null;
try {
  console.log("starting app server + chromium...");
  if (!(await waitForHttp(`http://127.0.0.1:${APP_PORT}/health`))) {
    throw new Error('static server did not start');
  }
  console.log("attaching to chromium...");
  const target = await waitForTarget(CDP_PORT);
  socket = new WebSocket(target);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('could not attach to Chromium'));
  });

  const cdp = new Cdp(socket);
  const pageErrors = [];
  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails;
    pageErrors.push(details.exception?.description ?? details.text ?? 'unknown exception');
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error') return;
    consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const url =
    `http://127.0.0.1:${APP_PORT}/?host=127.0.0.1&port=${mock.port}&autoconnect=1`;
  await cdp.send('Page.navigate', { url });
  await delay(WAIT_MS);

  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'document.documentElement.outerHTML',
    returnByValue: true,
  });
  const dom = result.value ?? '';

  const { result: stateResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      connected: window.webmix?.client?.connected ?? false,
      status: window.webmix?.store?.state?.connection?.status ?? 'unknown',
      scenes: (window.webmix?.store?.state?.scenes ?? []).map(s => s.sceneName),
      program: window.webmix?.store?.state?.currentProgramScene ?? null,
      inputs: Object.keys(window.webmix?.store?.state?.inputs ?? {}),
      docks: document.querySelectorAll('.obs-dock').length,
      strips: document.querySelectorAll('.obs-mixer-strip').length,
      appHidden: document.getElementById('app')?.hidden ?? null,
    })`,
    returnByValue: true,
  });
  let appState = {};
  try {
    appState = JSON.parse(stateResult.value ?? '{}');
  } catch { /* leave empty */ }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot: ${SCREENSHOT} (${existsSync(SCREENSHOT) ? 'written' : 'MISSING'})`);

  check('connected to the mock OBS', appState.connected === true);
  check('app shell visible', appState.appHidden === false);
  check('6 docks rendered (Stats hidden by default)', appState.docks === 6);
  check('scenes loaded from OBS', (appState.scenes ?? []).length === 2);
  check('inputs loaded from OBS', (appState.inputs ?? []).length === 2);
  check('mixer strips rendered', appState.strips >= 1);

  for (const title of ['Scenes', 'Sources', 'Scene Transitions', 'Controls', 'Audio Mixer']) {
    check(`dock "${title}" rendered`, dom.includes(`>${title}<`));
  }
  check('scene "Scene 2" listed', dom.includes('data-scene-name="Scene 2"'));
  check('program scene marked LIVE', /obs-badge live">LIVE</.test(dom));
  check('source "Display Capture" listed', dom.includes('data-source-name="Display Capture"'));
  check('source "Text (GDI+)" listed', dom.includes('data-source-name="Text (GDI+)"'));
  check('mixer shows the audio source', dom.includes('data-input-name="Display Capture"'));
  // Text sources have no OBS_SOURCE_AUDIO flag, so OBS keeps them out of the mixer.
  check('mixer omits the non-audio text source', !dom.includes('obs-mixer-strip" data-input-name="Text (GDI+)'));
  check('volume sliders rendered', (dom.match(/obs-volume-slider/g) ?? []).length >= 1);
  check('meters rendered', (dom.match(/class="obs-meter"/g) ?? []).length >= 1);
  check('transition combo populated', dom.includes('>Fade<'));
  check('Start Streaming button', dom.includes('Start Streaming'));
  check('Start Recording button', dom.includes('Start Recording'));
  check('Studio Mode button', dom.includes('Studio Mode'));
  check('status bar rendered', dom.includes('obs-statusbar-inner'));
  check('status bar shows FPS', dom.includes('FPS'));
  for (const label of ['File', 'Edit', 'View', 'Docks', 'Profile', 'Scene Collection', 'Tools', 'Help']) {
    check(`menu "${label}" present`, dom.includes(`>${label}</button>`));
  }

  // Docks menu: OBS's dock toggles plus the Custom Browser Docks entry.
  const docksMenu = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      window.webmix.ui.menuBar.open('docks', document.querySelector('[data-menu-id="docks"]'));
      return [...document.querySelectorAll('#menu-root .obs-menu-item')].map((b) => b.textContent.trim());
    })()`,
    returnByValue: true,
  });
  const dockItems = (docksMenu.result.value ?? []).map((t) => t.replace(/^\u2713\s*/, ''));
  check('Docks menu lists the Stats dock', dockItems.some((t) => t.startsWith('Stats')));
  check('Docks menu lists Custom Browser Docks...', dockItems.some((t) => t.includes('Custom Browser Docks')));
  check('Docks menu lists the main docks', ['Scenes', 'Sources', 'Audio Mixer', 'Controls'].every((t) => dockItems.some((i) => i.startsWith(t))));

  // Toggle the Stats dock on from the menu and verify it renders figures.
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const item = [...document.querySelectorAll('#menu-root .obs-menu-item')].find((b) => b.textContent.trim().startsWith('Stats'));
      item?.click();
    })()`,
  });
  await delay(600);
  const { result: statsResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const dock = document.querySelector('.obs-dock[data-dock-id="stats"]');
      const rect = dock?.getBoundingClientRect();
      return {
        // Width matters: the dock can be unhidden yet laid out at zero width.
        visible: !!dock && !dock.hidden && dock.style.display !== 'none' && (rect?.width ?? 0) > 40,
        width: Math.round(rect?.width ?? 0),
        rows: document.querySelectorAll('.obs-dock[data-dock-id="stats"] .obs-stats-table tr').length,
        hasCpu: document.querySelector('.obs-dock[data-dock-id="stats"]')?.textContent.includes('CPU Usage') ?? false,
      };
    })())`,
    returnByValue: true,
  });
  let statsDock = {};
  try {
    statsDock = JSON.parse(statsResult.value ?? '{}');
  } catch { /* ignore */ }
  check('Stats dock becomes visible and laid out', statsDock.visible === true);
  check('Stats dock has a usable width', (statsDock.width ?? 0) > 100);
  check('Stats dock renders figures', statsDock.rows >= 10 && statsDock.hasCpu === true);

  const statsShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const statsPath = SCREENSHOT.replace(/\.png$/, '-stats-dock.png');
  writeFileSync(statsPath, Buffer.from(statsShot.data, 'base64'));
  console.log(`stats dock screenshot: ${statsPath}`);

  // Settings > Hotkeys: the browser-side binding UI must render.
  await cdp.send('Runtime.evaluate', {
    expression: `window.webmix.ui.dispatch('openSettings')`,
    awaitPromise: true,
  });
  await delay(700);
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const tab = [...document.querySelectorAll('.obs-tab')].find((t) => t.textContent.trim() === 'Hotkeys');
      tab?.click();
    })()`,
  });
  await delay(700);
  const { result: hotkeyResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      dialogs: document.querySelectorAll('.obs-dialog').length,
      tabs: [...document.querySelectorAll('.obs-tab')].map((t) => t.textContent.trim()),
      table: !!document.querySelector('.obs-hotkey-table'),
      rows: document.querySelectorAll('.obs-hotkey-table tbody tr').length,
      bindButtons: [...document.querySelectorAll('.obs-hotkey-table button')].filter((b) => b.textContent.trim() === 'Bind').length,
      bodyText: (document.querySelector('.obs-settings-body')?.textContent ?? '').slice(0, 120),
    })`,
    returnByValue: true,
  });
  let hotkeys = {};
  try {
    hotkeys = JSON.parse(hotkeyResult.value ?? '{}');
  } catch { /* ignore */ }
  console.log(`  settings dialog: ${JSON.stringify({ dialogs: hotkeys.dialogs, tabs: hotkeys.tabs, body: hotkeys.bodyText })}`);
  check('Settings dialog opened', hotkeys.dialogs >= 1 && (hotkeys.tabs ?? []).includes('Hotkeys'));
  check('Hotkeys tab renders the binding table', hotkeys.table === true && hotkeys.rows >= 2);
  check('Hotkeys tab offers a Bind button per hotkey', hotkeys.bindButtons === hotkeys.rows);

  // Close the settings dialog before the error assertions below.
  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('.obs-modal-backdrop .obs-dialog-close')?.click()`,
  });
  await delay(200);

  // Custom Browser Docks: manage a dock through the dialog and verify it renders.
  await cdp.send('Runtime.evaluate', {
    expression: `window.webmix.ui.dispatch('manageCustomDocks')`,
    awaitPromise: true,
  });
  await delay(500);
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      [...document.querySelectorAll('.obs-dialog-footer button')].find((b) => b.textContent.trim() === 'Add')?.click();
      const [name, url] = [...document.querySelectorAll('.obs-custom-dock-fields input')];
      if (name) { name.value = 'Test Dock'; name.dispatchEvent(new Event('input', { bubbles: true })); }
      if (url) { url.value = 'about:blank'; url.dispatchEvent(new Event('input', { bubbles: true })); }
      [...document.querySelectorAll('.obs-dialog-footer button')].find((b) => b.textContent.trim() === 'OK')?.click();
    })()`,
  });
  await delay(700);
  const { result: customResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      frames: document.querySelectorAll('#dock-right iframe').length,
      columnVisible: !document.getElementById('dock-right').hidden,
      title: document.querySelector('#dock-right .obs-dock-title-text')?.textContent ?? '',
    })`,
    returnByValue: true,
  });
  let custom = {};
  try {
    custom = JSON.parse(customResult.value ?? '{}');
  } catch { /* ignore */ }
  check('custom dock creates an iframe', custom.frames === 1);
  check('custom dock column becomes visible', custom.columnVisible === true);
  check('custom dock uses the given name', custom.title === 'Test Dock');

  const customShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SCREENSHOT.replace(/\.png$/, '-custom-dock.png'), Buffer.from(customShot.data, 'base64'));

  check('no uncaught page exceptions', pageErrors.length === 0);
  check('no console errors', consoleErrors.length === 0);

  // Studio Mode: OBS splits the canvas into Preview (left) and Program (right)
  // and shows the T-bar + Transition button in the Scene Transitions dock.
  await cdp.send('Runtime.evaluate', {
    expression: 'window.webmix.api.setStudioMode(true)',
    awaitPromise: true,
  });
  await delay(1200);
  const { result: studioResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      studioMode: window.webmix.store.state.studioMode,
      panes: document.querySelectorAll('.obs-preview-pane').length,
      labels: [...document.querySelectorAll('.obs-preview-pane .obs-preview-label')]
        .map(el => ({ text: el.textContent, hidden: el.hidden })),
      tbar: !!document.querySelector('.obs-tbar'),
      transitionButton: !!document.querySelector('.obs-studio-transition'),
    })`,
    returnByValue: true,
  });
  let studio = {};
  try {
    studio = JSON.parse(studioResult.value ?? '{}');
  } catch { /* ignore */ }

  check('studio mode enabled', studio.studioMode === true);
  check('studio mode shows two preview panes', studio.panes === 2);
  check(
    'studio panes labelled Preview + Program',
    studio.labels?.length === 2 &&
      studio.labels[0].text === 'Preview' &&
      studio.labels[1].text === 'Program' &&
      studio.labels.every((l) => l.hidden === false)
  );
  check('studio mode shows the T-bar', studio.tbar === true);
  check('studio mode shows the Transition button', studio.transitionButton === true);

  const studioShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const studioPath = SCREENSHOT.replace(/\.png$/, '-studio.png');
  writeFileSync(studioPath, Buffer.from(studioShot.data, 'base64'));
  console.log(`studio screenshot: ${studioPath}`);

  if (pageErrors.length) {
    console.log('\npage exceptions:');
    for (const error of pageErrors.slice(0, 8)) console.log(`  - ${String(error).split('\n')[0]}`);
  }
  if (consoleErrors.length) {
    console.log('\nconsole errors:');
    for (const error of consoleErrors.slice(0, 8)) console.log(`  - ${error}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error(`browser smoke test error: ${err.message}`);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  cleanup();
}

process.exit(exitCode);
