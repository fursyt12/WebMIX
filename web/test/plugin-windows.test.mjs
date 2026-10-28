/*
 * The windows plugins open from the Tools menu: where their entries go in the
 * menu, and which changes to a mirrored window are patched in place rather
 * than drawn again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MENU_TREE } from '../src/ui/menu.js';
import {
  toolsMenuItems,
  shapeOf,
  findNode,
  menuEntries,
  noticeText,
  TOOL_ACTION_PREFIX,
} from '../src/ui/plugin-windows.js';

const toolsMenu = () => MENU_TREE.find((menu) => menu.id === 'tools').items;
const ids = (items) => items.map((item) => (item.type === 'separator' ? '---' : item.id));

test('without OBS serving the page the Tools menu stays as it is', () => {
  const items = toolsMenu();
  assert.equal(toolsMenuItems(items, null), items);
  assert.equal(toolsMenuItems(items, { items: undefined }), items);
});

test("plugins' entries go below the separator, in OBS's order, before WebMIX's own", () => {
  const tools = {
    items: [
      { id: 1, text: 'Automatic Scene Switcher', enabled: true },
      { id: 7, text: 'WebSocket Server Settings', enabled: true, replacement: 'webSocketSettings' },
      { id: 3, text: 'DistroAV NDI® Settings', enabled: true },
    ],
    pluginManager: 4,
  };
  const items = toolsMenuItems(toolsMenu(), tools);
  assert.deepEqual(ids(items), [
    'autoConfigure',
    'actionOpenPluginManager',
    '---',
    `${TOOL_ACTION_PREFIX}1`,
    'webSocketSettings',
    `${TOOL_ACTION_PREFIX}3`,
    'webInterfaceAccess',
  ]);
  const distroav = items.find((item) => item.id === `${TOOL_ACTION_PREFIX}3`);
  assert.equal(distroav.label, 'DistroAV NDI® Settings');
  assert.equal(distroav.action, `${TOOL_ACTION_PREFIX}3`);
  /* obs-websocket's entry keeps the page's own dialog, under the plugin's name. */
  const websocket = items.find((item) => item.id === 'webSocketSettings');
  assert.equal(websocket.action, 'webSocketSettings');
  assert.equal(websocket.label, 'WebSocket Server Settings');
});

test('entries for plugins OBS did not load are left out', () => {
  const items = toolsMenuItems(toolsMenu(), { items: [] });
  assert.deepEqual(ids(items), ['autoConfigure', 'actionOpenPluginManager', '---', 'webInterfaceAccess']);
});

test('disabled, checkable and submenu entries keep what they are', () => {
  const items = toolsMenuItems(toolsMenu(), {
    items: [
      { id: 5, text: 'Off', enabled: false },
      { id: 6, text: 'Toggle', enabled: true, checkable: true, checked: true },
      { id: 8, text: 'More', enabled: true, items: [{ id: 9, text: 'Inner', enabled: true }] },
    ],
  });
  const find = (id) => items.find((item) => item.id === `${TOOL_ACTION_PREFIX}${id}`);
  assert.equal(find(5).disabled, true);
  assert.equal(find(6).type, 'check');
  assert.equal(find(6).checked, true);
  assert.deepEqual(find(8).items.map((item) => item.action), [`${TOOL_ACTION_PREFIX}9`]);
});

const window = (overrides = {}) => ({
  t: 'box',
  dir: 'v',
  items: [
    {
      t: 'group',
      id: 2,
      title: 'Main Output',
      checkable: true,
      checked: false,
      body: {
        t: 'grid',
        cells: [
          { r: 0, c: 0, rs: 1, cs: 1, item: { t: 'label', id: 3, parts: [{ text: 'Name' }] } },
          { r: 0, c: 1, rs: 1, cs: 1, item: { t: 'text', id: 4, value: 'OBS', disabled: true } },
        ],
      },
    },
    { t: 'combo', id: 5, items: ['A', 'B'], index: 0 },
    {
      t: 'list',
      id: 6,
      columns: ['Name'],
      rows: [{ r: 0, cells: ['one'] }],
    },
    ...(overrides.extra ?? []),
  ],
});

test('a window whose widgets only hold other values has the same shape', () => {
  const before = window();
  const after = window();
  after.items[0].checked = true;
  after.items[0].title = 'Main Output (on)';
  after.items[0].body.cells[1].item.value = 'Studio';
  delete after.items[0].body.cells[1].item.disabled;
  after.items[0].body.cells[0].item.parts = [{ text: 'Output name' }];
  after.items[1].items = ['A', 'B', 'C'];
  after.items[1].index = 2;
  after.items[2].rows = [{ r: 0, cells: ['one'] }, { r: 1, cells: ['two'], selected: true }];
  assert.equal(shapeOf(after), shapeOf(before));
});

test('a widget appearing, or a tab switch, changes the shape', () => {
  const base = shapeOf(window());
  assert.notEqual(shapeOf(window({ extra: [{ t: 'check', id: 9, text: 'x', checked: false }] })), base);

  const box = window();
  box.dir = 'h';
  assert.notEqual(shapeOf(box), base);

  const tabs = (current) => ({ t: 'tabs', id: 1, tabs: [{ title: 'a' }, { title: 'b' }], current, body: { t: 'label', id: 2 } });
  assert.notEqual(shapeOf(tabs(0)), shapeOf(tabs(1)));
});

test('nodes are found wherever the layout puts them', () => {
  const body = window();
  assert.equal(findNode(body, 4).value, 'OBS');
  assert.equal(findNode(body, 2).title, 'Main Output');
  assert.equal(
    findNode({ t: 'form', rows: [{ label: { t: 'label', id: 7 }, field: { t: 'text', id: 8 } }] }, 8).t,
    'text'
  );
  assert.equal(findNode(body, 99), null);
});

test("a button's menu becomes context menu entries that trigger the plugin's actions", () => {
  const triggered = [];
  const entries = menuEntries(
    [
      { id: 10, text: 'Add' },
      { sep: true },
      { id: 11, text: 'Show', checkable: true, checked: true },
      { id: 12, text: 'More', items: [{ id: 13, text: 'Deeper', disabled: true }] },
    ],
    (id) => triggered.push(id)
  );
  assert.equal(entries.length, 5);
  assert.equal(entries[1].separator, true);
  assert.equal(entries[2].checked, true);
  assert.equal(entries[3].disabled, true); /* the submenu's own title */
  assert.equal(entries[4].disabled, true);
  assert.match(entries[4].label, /Deeper$/);
  entries[0].action();
  entries[2].action();
  assert.deepEqual(triggered, [10, 11]);
});

test('notices say what OBS showed, and why nobody was asked', () => {
  const startup = noticeText({ kind: 'startup', title: 'DistroAV', text: 'NDI Runtime not found.' });
  assert.equal(startup.title, 'DistroAV');
  assert.deepEqual(startup.lines, ['NDI Runtime not found.', 'WebMix.Notice.StartupAnswered']);

  /* An untitled window still has a title. */
  assert.equal(noticeText({ kind: 'startup', text: 'x' }).title, 'OBS');
});
