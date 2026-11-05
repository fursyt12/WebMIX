/*
 * Unit and integration tests for the browser-only OBS-style self-updater.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  formatBytes,
  isUpdateBusy,
  shouldAutoOpenUpdateDialog,
  parseInlineTokens,
  parseChangelogBlocks,
  UpdaterController,
} from '../src/ui/updater.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function parseIniKeys(path) {
  const map = new Map();
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

test('formatBytes formats byte sizes cleanly', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10.0 MB');
});

test('shouldAutoOpenUpdateDialog respects skipped and reminded versions', () => {
  const base = {
    state: 'ready',
    updateAvailable: true,
    latestVersion: '0.9.0',
    skippedVersion: '',
    manualCheck: false,
  };
  assert.equal(shouldAutoOpenUpdateDialog(base), true);

  // Skipped version does not pop up automatically on startup...
  assert.equal(
    shouldAutoOpenUpdateDialog({ ...base, skippedVersion: '0.9.0', manualCheck: false }),
    false
  );
  // ...but DOES open when the user explicitly chose Help > Check For Updates.
  assert.equal(
    shouldAutoOpenUpdateDialog({ ...base, skippedVersion: '0.9.0', manualCheck: true }),
    true
  );

  // Reminded version stays quiet for the rest of the session.
  assert.equal(
    shouldAutoOpenUpdateDialog(base, { remindedVersions: new Set(['0.9.0']) }),
    false
  );

  // Active download/install/restart always shows progress.
  assert.equal(isUpdateBusy('downloading'), true);
  assert.equal(isUpdateBusy('installing'), true);
  assert.equal(isUpdateBusy('restarting'), true);
  assert.equal(isUpdateBusy('ready'), false);
  assert.equal(
    shouldAutoOpenUpdateDialog(
      { ...base, state: 'installing' },
      { remindedVersions: new Set(['0.9.0']) }
    ),
    true
  );
});

test('parseChangelogBlocks and parseInlineTokens parse release notes safely without HTML injection', () => {
  const md = [
    '## WebMIX 0.9.0',
    '',
    '- **Browser updater**: check, view changelog, and auto-restart on `--web-port`',
    '  with SHA-256 verification.',
    '- Docs at [Releases](https://github.com/fursyt12/WebMIX/releases) and unsafe [bad](javascript:alert(1)).',
    '',
    '---',
    '',
    '```bash',
    'webmix --web-port 4456',
    '```',
  ].join('\n');

  const blocks = parseChangelogBlocks(md);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks[0], { type: 'heading', level: 2, text: 'WebMIX 0.9.0' });
  assert.equal(blocks[1].type, 'list');
  assert.equal(blocks[1].items.length, 2);
  assert.match(blocks[1].items[0], /with SHA-256 verification\.$/);
  assert.deepEqual(blocks[2], { type: 'hr' });
  assert.deepEqual(blocks[3], { type: 'codeblock', text: 'webmix --web-port 4456' });

  const inline = parseInlineTokens(blocks[1].items[1]);
  assert.ok(inline.some((tok) => tok.type === 'link' && tok.href === 'https://github.com/fursyt12/WebMIX/releases'));
  // javascript: URLs are never turned into clickable links.
  assert.ok(!inline.some((tok) => tok.type === 'link' && tok.href.startsWith('javascript:')));
});

test('en-US and ru-RU locales define every WebMix.Updater.* string', () => {
  const en = parseIniKeys(join(repoRoot, 'frontend/data/locale/en-US.ini'));
  const ru = parseIniKeys(join(repoRoot, 'frontend/data/locale/ru-RU.ini'));

  const expected = [
    'WebMix.Updater.Badge',
    'WebMix.Updater.VersionSummary',
    'WebMix.Updater.Checking',
    'WebMix.Updater.Prefetching',
    'WebMix.Updater.Ready',
    'WebMix.Updater.Downloading',
    'WebMix.Updater.Installing',
    'WebMix.Updater.Restarting',
    'WebMix.Updater.Updated',
    'WebMix.Updater.CheckFailed',
    'WebMix.Updater.InstallFailed',
    'WebMix.Updater.SudoPrompt',
    'WebMix.Updater.SudoPlaceholder',
    'WebMix.Updater.SudoInvalid',
    'WebMix.Updater.SudoRequired',
    'WebMix.Updater.ActiveOutputsConfirm',
    'WebMix.Updater.ActiveRemuxConfirm',
    'WebMix.Updater.ManualDownloadHint',
    'WebMix.Updater.OpenReleasePage',
  ];
  for (const key of expected) {
    assert.ok(en.has(key), `en-US.ini defines ${key}`);
    assert.ok(ru.has(key), `ru-RU.ini defines ${key}`);
  }
});

/* Minimal fake DOM so UpdaterController's full dialog/install/restart lifecycle
 * can be exercised in plain Node without a browser. */
function installMiniDom() {
  class MiniNode {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.id = '';
      this.textContent = '';
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.style = {};
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
      this.listeners = new Map();
      const self = this;
      this.classList = {
        add(...names) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          for (const n of names) set.add(n);
          self.className = [...set].join(' ');
        },
        remove(...names) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          for (const n of names) set.delete(n);
          self.className = [...set].join(' ');
        },
        contains(n) {
          return self.className.split(/\s+/).includes(n);
        },
      };
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
    }
    getAttribute(k) {
      return this.attributes.get(k) ?? null;
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n == null) continue;
        this.appendChild(typeof n === 'string' ? new MiniText(n) : n);
      }
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
    }
    remove() {
      this.parentNode?.removeChild(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this.listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
    click() {
      if (this.disabled) return;
      for (const fn of [...(this.listeners.get('click') ?? [])]) fn({ preventDefault() {}, stopPropagation() {} });
    }
    focus() {}
    select() {}
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const ch of node.children ?? []) {
          if (ch instanceof MiniNode) {
            if (matches(ch, selector)) out.push(ch);
            visit(ch);
          }
        }
      };
      visit(this);
      return out;
    }
  }
  class MiniText {
    constructor(text) {
      this.nodeValue = String(text);
    }
  }
  function matches(node, selector) {
    for (const part of selector.split(',').map((s) => s.trim())) {
      if (part.startsWith('#') && node.id === part.slice(1)) return true;
      if (part.startsWith('.') && node.classList.contains(part.slice(1))) return true;
      if (!part.startsWith('#') && !part.startsWith('.') && !part.includes(':')) {
        if (node.tagName === part.toUpperCase()) return true;
      }
    }
    return false;
  }

  const root = new MiniNode('body');
  const modalRoot = new MiniNode('div');
  modalRoot.id = 'modal-root';
  const menuRoot = new MiniNode('div');
  menuRoot.id = 'menu-root';
  const badgeSlot = new MiniNode('div');
  root.append(modalRoot, menuRoot, badgeSlot);

  const prevDoc = globalThis.document;
  const prevNode = globalThis.Node;
  const prevSession = globalThis.sessionStorage;

  const sessionMap = new Map();
  globalThis.Node = MiniNode;
  globalThis.sessionStorage = {
    getItem: (k) => sessionMap.get(k) ?? null,
    setItem: (k, v) => sessionMap.set(k, String(v)),
    removeItem: (k) => sessionMap.delete(k),
  };
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new MiniNode(tag),
    createTextNode: (txt) => {
      const n = new MiniNode('#text');
      n.textContent = String(txt);
      return n;
    },
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  };

  return {
    modalRoot,
    badgeSlot,
    sessionMap,
    restore() {
      globalThis.document = prevDoc;
      globalThis.Node = prevNode;
      globalThis.sessionStorage = prevSession;
    },
  };
}

test('UpdaterController opens changelog modal, installs update, waits for new bootId, and reloads', async (t) => {
  const dom = installMiniDom();
  const prevFetch = globalThis.fetch;

  let bootId = 'boot-old';
  let currentVersion = '0.8.0';
  let installCalls = [];
  let updateState = {
    ok: true,
    state: 'ready',
    currentVersion: '0.8.0',
    latestVersion: '0.9.0',
    skippedVersion: '',
    autoCheck: true,
    updateAvailable: true,
    manualCheck: false,
    changelog: '## WebMIX 0.9.0\n\n- Browser-only updater with auto-restart',
    releaseUrl: 'https://github.com/fursyt12/WebMIX/releases/tag/0.9.0',
    assetName: 'webmix_0.9.0_amd64.deb',
    assetSize: 1048576,
    downloadedBytes: 1048576,
    totalBytes: 1048576,
    progress: 100,
    readyToInstall: true,
    prefetching: false,
    canInstall: true,
    needsPassword: false,
    error: '',
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/status') {
        res.end(
          JSON.stringify({
            webmix: true,
            obsControl: true,
            updater: true,
            version: currentVersion,
            bootId,
          })
        );
        return;
      }
      if (req.url === '/api/update' && req.method === 'GET') {
        res.end(JSON.stringify(updateState));
        return;
      }
      if (req.url === '/api/update/install' && req.method === 'POST') {
        installCalls.push(JSON.parse(body || '{}'));
        updateState = { ...updateState, state: 'restarting' };
        res.end(JSON.stringify(updateState));
        // Simulate WebMIX restarting onto a fresh bootId and version 0.9.0.
        setTimeout(() => {
          bootId = 'boot-new';
          currentVersion = '0.9.0';
        }, 120);
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/`;

  globalThis.fetch = (url, opts) => {
    const resolved = String(url).startsWith('http') ? url : baseUrl + String(url).replace(/^\//, '');
    return prevFetch(resolved, opts);
  };

  t.after(async () => {
    globalThis.fetch = prevFetch;
    dom.restore();
    await new Promise((resolve) => server.close(resolve));
  });

  let reloaded = 0;
  let reloadResolve;
  const reloadPromise = new Promise((resolve) => {
    reloadResolve = resolve;
  });

  const store = { state: { outputs: { streaming: { active: false }, recording: { active: false } } } };
  const statusMessages = [];
  const updater = new UpdaterController({
    store,
    badgeSlot: dom.badgeSlot,
    onStatus: (txt, kind) => statusMessages.push({ txt, kind }),
    reload: () => {
      reloaded++;
      reloadResolve();
    },
  });

  await updater.start({ embedded: true, updater: true, bootId: 'boot-old', version: '0.8.0' });

  // 1. Update badge appears in the menubar and the changelog modal auto-opens.
  assert.ok(updater.badgeButton, 'menubar update badge rendered');
  assert.match(updater.badgeButton.textContent, /0\.9\.0/);
  assert.ok(updater.dialogView, 'update changelog dialog opened automatically');

  const changelogEl = dom.modalRoot.querySelector('.obs-update-changelog');
  assert.ok(changelogEl && changelogEl.children.length >= 2, 'changelog blocks rendered in dialog');

  // 2. Click "Update Now": triggers /api/update/install, watches /api/status until bootId changes, and reloads.
  const buttons = dom.modalRoot.querySelectorAll('button');
  const updateNowBtn = buttons.find((b) => b.textContent === 'Update Now');
  assert.ok(updateNowBtn, 'Update Now button exists');
  updateNowBtn.click();

  await reloadPromise;
  assert.equal(installCalls.length, 1);
  assert.equal(reloaded, 1);
  assert.equal(dom.sessionMap.get('webmix.justUpdatedTo'), '0.9.0');

  // 3. On the fresh page load after restart, the "Updated to WebMIX 0.9.0" toast fires once.
  const postReloadUpdater = new UpdaterController({
    store,
    badgeSlot: dom.badgeSlot,
    onStatus: (txt, kind) => statusMessages.push({ txt, kind }),
    reload: () => {},
  });
  updateState = { ...updateState, state: 'up-to-date', updateAvailable: false, currentVersion: '0.9.0' };
  await postReloadUpdater.start({ embedded: true, updater: true, bootId: 'boot-new', version: '0.9.0' });
  assert.ok(
    statusMessages.some((m) => m.kind === 'success' && m.txt.includes('0.9.0')),
    'post-reload toast announces updated version'
  );
  updater.destroy();
  postReloadUpdater.destroy();
});
