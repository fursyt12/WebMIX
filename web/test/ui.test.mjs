/*
 * Structural tests for the web UI: the menu tree must match OBS's menu bar,
 * and every UI module must import cleanly in a plain Node environment (which
 * catches broken imports and import-time DOM access).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { MENU_TREE, plain } from '../src/ui/menu.js';

test('menu bar matches the OBS menu order', () => {
  assert.deepEqual(
    MENU_TREE.map((m) => plain(m.label)),
    ['File', 'Edit', 'View', 'Docks', 'Profile', 'Scene Collection', 'Tools', 'Help']
  );
});

test('menu tree ids are unique and every item carries an action', () => {
  const ids = new Set();
  const walk = (items, path) => {
    for (const item of items) {
      if (item.type === 'separator') continue;
      assert.ok(item.id, `item in ${path} has an id`);
      assert.ok(!ids.has(item.id), `duplicate menu id ${item.id}`);
      ids.add(item.id);
      if (item.items) walk(item.items, `${path} > ${item.id}`);
      else if (!item.hidden) {
        assert.ok(item.action, `${item.id} has an action`);
        assert.equal(typeof item.label, 'string');
      }
    }
  };
  for (const menu of MENU_TREE) walk(menu.items, plain(menu.label));
  assert.ok(ids.size > 70, `expected the full OBS menu tree, got ${ids.size} items`);
});

test('key OBS menu entries are present with their shortcuts', () => {
  const find = (id) => {
    let found = null;
    const walk = (items) => {
      for (const item of items) {
        if (item.id === id) found = item;
        if (item.items) walk(item.items);
      }
    };
    for (const menu of MENU_TREE) {
      if (menu.id === id) found = menu;
      walk(menu.items);
    }
    return found;
  };

  assert.equal(find('action_Settings').label, '&Settings');
  assert.equal(find('actionE_xit').shortcut, 'Ctrl+Q');
  assert.equal(find('actionEditTransform').shortcut, 'Ctrl+E');
  assert.equal(find('actionMainUndo').shortcut, 'Ctrl+Z');
  assert.equal(find('actionAdvAudioProperties').label, '&Advanced Audio Properties');
  assert.equal(find('toggleStatusBar').checked, true);
  assert.equal(find('resetUI').label, '&Reset UI');
  assert.equal(find('stats').label, 'Stats');
  assert.equal(plain(find('docks').label), 'Docks');
});

test('all UI modules import cleanly without a DOM', async () => {
  const modules = [
    '../src/dom.js',
    '../src/hash.js',
    '../src/protocol.js',
    '../src/obs-client.js',
    '../src/store.js',
    '../src/api.js',
    '../src/fader.js',
    '../src/hotkeys.js',
    '../src/host.js',
    '../src/ui/icons.js',
    '../src/ui/menu.js',
    '../src/ui/dialog.js',
    '../src/ui/dock.js',
    '../src/ui/scenes.js',
    '../src/ui/sources.js',
    '../src/ui/mixer.js',
    '../src/ui/transitions.js',
    '../src/ui/controls.js',
    '../src/ui/statusbar.js',
    '../src/ui/preview.js',
    '../src/ui/source-toolbar.js',
    '../src/ui/stats.js',
    '../src/ui/custom-docks.js',
    '../src/ui/dialogs.js',
    '../src/ui/files.js',
    '../src/ui/remux.js',
    '../src/ui/multiview.js',
  ];
  for (const path of modules) {
    const mod = await import(path);
    assert.ok(Object.keys(mod).length > 0, `${path} exports something`);
  }
});

test('every api.<method>() the UI calls exists on ObsApi', async () => {
  const { ObsApi } = await import('../src/api.js');
  const sourceDir = fileURLToPath(new URL('../src', import.meta.url));
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) files.push(path);
    }
  };
  walk(sourceDir);

  // A call site that names a method ObsApi does not implement fails only at
  // runtime, in the browser, where nothing catches it (SetRecordDirectory was
  // missing for exactly that reason).
  const missing = new Set();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)) {
      if (typeof ObsApi.prototype[match[1]] !== 'function') {
        missing.add(`${match[1]}() in ${relative(sourceDir, file)}`);
      }
    }
  }
  assert.deepEqual([...missing], []);
});

test('stats rows cover the OBS Stats dock figures', async () => {
  const { statsRows } = await import('../src/ui/stats.js');
  const state = {
    stats: {
      cpuUsage: 12.34,
      memoryUsage: 512.5,
      availableDiskSpace: 1024,
      activeFps: 59.94,
      averageFrameRenderTime: 1.5,
      renderSkippedFrames: 1,
      renderTotalFrames: 100,
      outputSkippedFrames: 2,
      outputTotalFrames: 200,
      webSocketSessionIncomingMessages: 7,
      webSocketSessionOutgoingMessages: 8,
    },
    video: { baseWidth: 1920, baseHeight: 1080, outputWidth: 1280, outputHeight: 720, fpsNumerator: 60, fpsDenominator: 1 },
    outputs: { streaming: { active: true, skippedFrames: 2, totalFrames: 200 }, recording: { active: false } },
  };
  const rows = Object.fromEntries(statsRows(state));
  assert.equal(rows['CPU Usage'], '12.3%');
  assert.equal(rows['Memory Usage'], '512.5 MB');
  assert.equal(rows['Active FPS'], '59.94');
  assert.equal(rows['Target FPS'], '60.00');
  assert.equal(rows['Base Resolution'], '1920x1080');
  assert.equal(rows['Output Resolution'], '1280x720');
  assert.equal(rows['Skipped Frame Percentage'], '1.00%');
  assert.equal(rows['Streaming'], 'active');
  assert.equal(rows['Recording'], 'inactive');
  assert.ok(Object.keys(rows).length >= 15);
});

test('stats rows tolerate a disconnected state', async () => {
  const { statsRows } = await import('../src/ui/stats.js');
  const rows = Object.fromEntries(statsRows({}));
  assert.equal(rows['CPU Usage'], '0.0%');
  assert.equal(rows['Target FPS'], '-');
  assert.equal(rows['Base Resolution'], '-');
});

test('custom dock URLs are normalised like OBS', async () => {
  const { normalizeUrl } = await import('../src/ui/custom-docks.js');
  assert.equal(normalizeUrl('example.com/chat'), 'https://example.com/chat');
  assert.equal(normalizeUrl('  twitch.tv/embed/x/chat  '), 'https://twitch.tv/embed/x/chat');
  assert.equal(normalizeUrl('http://localhost:8080/panel'), 'http://localhost:8080/panel');
  assert.equal(normalizeUrl('https://a.b/c'), 'https://a.b/c');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(null), '');
});

test('dom helpers expose the documented API', async () => {
  const dom = await import('../src/dom.js');
  for (const name of ['h', 'append', 'qs', 'qsa', 'clear', 'setText', 'setClass', 'setProp', 'reconcile', 'debounce', 'clamp', 'parseTimecode', 'mulToDb', 'dbToMul']) {
    assert.equal(typeof dom[name], 'function', `dom.${name} is a function`);
  }
});

test('parseTimecode converts OBS timecodes', async () => {
  const { parseTimecode } = await import('../src/dom.js');
  assert.equal(parseTimecode('00:00:00.000'), 0);
  assert.equal(parseTimecode('01:02:03.500'), 3723500);
  assert.equal(parseTimecode('10:00:00'), 36000000);
  assert.equal(parseTimecode('nonsense'), 0);
  assert.equal(parseTimecode(null), 0);
});

test('icons module provides every glyph the panels use', async () => {
  const { ICON_NAMES, icon } = await import('../src/ui/icons.js');
  const used = [
    'plus', 'minus', 'up', 'down', 'filter', 'gear', 'trash', 'eye', 'eyeOff',
    'lock', 'unlock', 'pause', 'play', 'save', 'camera', 'refresh', 'grid',
    'list', 'mic', 'headphones', 'interact', 'close', 'properties', 'folder',
  ];
  for (const name of used) assert.ok(ICON_NAMES.includes(name), `icon "${name}" exists`);
  assert.equal(typeof icon, 'function');
});

test('multiview grid geometry matches the server composition', async () => {
  const { gridLayout } = await import('../src/ui/multiview.js');
  // ceil(sqrt(n)) columns, matching CaptureMultiview().
  assert.deepEqual(gridLayout(1), { columns: 1, rows: 1 });
  assert.deepEqual(gridLayout(2), { columns: 2, rows: 1 });
  assert.deepEqual(gridLayout(3), { columns: 2, rows: 2 });
  assert.deepEqual(gridLayout(4), { columns: 2, rows: 2 });
  assert.deepEqual(gridLayout(5), { columns: 3, rows: 2 });
  assert.deepEqual(gridLayout(6), { columns: 3, rows: 2 });
  assert.deepEqual(gridLayout(9), { columns: 3, rows: 3 });
  assert.deepEqual(gridLayout(10), { columns: 4, rows: 3 });
  // Degenerate input still yields a usable grid.
  assert.deepEqual(gridLayout(0), { columns: 1, rows: 1 });
});
