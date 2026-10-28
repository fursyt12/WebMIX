/*
 * WebMIX - the windows plugins open, drawn in the browser.
 *
 * A plugin's Tools menu entry opens a Qt window: DistroAV's NDI output
 * settings, the Output Timer, the Scripts window... In web mode OBS opens it
 * for real but keeps it off screen, and describes its widgets
 * (frontend/webmix/WebMixPluginUi.cpp); this module draws the same form and
 * hands every edit and click back to the widget it came from. The plugin fills,
 * checks and applies its own window, so nothing here knows about any plugin.
 *
 * A window opens in the page that asked for it (`session`), and follows the
 * real one as it changes: a label the plugin updates, a field it enables, the
 * message box it opens when OK is pressed.
 */
import { h, clear } from '../dom.js';
import { t } from '../i18n.js';
import { openDialog, dialogButtons, showContextMenu } from './dialog.js';
import { fetchPluginTools, fetchPluginWindows, triggerPluginTool, actOnPluginWindow } from '../bridge.js';

/** The event OBS sends when a mirrored window opens, closes or changes. */
export const PLUGIN_WINDOWS_EVENT = 'WebMixPluginWindowsChanged';

/** Action ids of the Tools menu entries plugins added. */
export const TOOL_ACTION_PREFIX = 'plugin-tool:';

/* Entries the static menu carries for plugins OBS may or may not have loaded.
 * When OBS serves the page they come from the loaded plugins, or not at all. */
const PLUGIN_ENTRIES = new Set(['actionScripts', 'webSocketSettings']);

/* Links a label may open in a new tab; anything else is the plugin's to handle. */
const SAFE_LINK = /^(https?:|mailto:)/i;
const SAFE_IMAGE = /^data:image\//;

/**
 * The Tools menu with the plugins' entries where OBS puts them: below the
 * separator, in the order the plugins added them, then WebMIX's own. Without
 * OBS serving the page (`tools` null) the menu stays as it is. An entry the
 * page has its own dialog for (obs-websocket's) opens that dialog.
 */
export function toolsMenuItems(items, tools) {
  if (!Array.isArray(tools?.items)) return items;
  const split = items.findIndex((item) => item.type === 'separator');
  const head = (split < 0 ? items : items.slice(0, split + 1)).filter((item) => !PLUGIN_ENTRIES.has(item.id));
  const own = split < 0 ? [] : items.slice(split + 1);
  const byAction = new Map(own.map((item) => [item.action, item]));

  const toItem = (tool) => {
    const replaced = tool.replacement ? byAction.get(tool.replacement) : null;
    if (replaced) return { ...replaced, label: tool.text || replaced.label };
    const item = { id: `${TOOL_ACTION_PREFIX}${tool.id}`, label: tool.text, action: `${TOOL_ACTION_PREFIX}${tool.id}` };
    if (tool.enabled === false) item.disabled = true;
    if (tool.checkable) {
      item.type = 'check';
      item.checked = !!tool.checked;
    }
    if (Array.isArray(tool.items)) item.items = tool.items.map(toItem);
    return item;
  };

  return [...head, ...tools.items.map(toItem), ...own.filter((item) => !PLUGIN_ENTRIES.has(item.id))];
}

/**
 * A window's layout without what its widgets hold. Two descriptions of the same
 * shape are patched in place - so typing, focus and scrolling survive the
 * plugin updating a label beside them; another shape is drawn again.
 */
export function shapeOf(node) {
  if (node === null || typeof node !== 'object') return '';
  const parts = [node.t, node.id ?? ''];
  switch (node.t) {
    case 'box':
      parts.push(node.dir, node.buttons ? 'b' : '', ...(node.items ?? []).map(shapeOf));
      break;
    case 'grid':
      for (const cell of node.cells ?? []) parts.push(`${cell.r},${cell.c},${cell.rs},${cell.cs}`, shapeOf(cell.item));
      break;
    case 'form':
      for (const row of node.rows ?? []) parts.push(shapeOf(row.label), shapeOf(row.field), shapeOf(row.span));
      break;
    case 'spacer':
      parts.push(node.grow ? 'g' : '');
      break;
    case 'group':
      parts.push(node.checkable ? 'c' : '', shapeOf(node.body));
      break;
    case 'tabs':
      parts.push((node.tabs ?? []).length, node.current, shapeOf(node.body));
      break;
    case 'button':
      parts.push(node.menu ? 'm' : '', node.menuOnly ? 'o' : '');
      break;
    case 'check':
      parts.push(node.tristate ? 't' : '');
      break;
    case 'text':
      parts.push(node.password ? 'p' : '');
      break;
    case 'combo':
      parts.push(node.editable ? 'e' : '');
      break;
    case 'list':
      parts.push(node.columns ? node.columns.length : '-', node.multi ? 'm' : '');
      break;
    default:
      break;
  }
  return `(${parts.join('|')})`;
}

/** The node `id` in a window body, or null. */
export function findNode(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.id === id) return node;
  const children = [
    ...(node.items ?? []),
    ...(node.cells ?? []).map((cell) => cell.item),
    ...(node.t === 'form' ? (node.rows ?? []).flatMap((row) => [row.label, row.field, row.span]) : []),
    node.body,
  ];
  for (const child of children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** A menu a plugin's button opens, flattened for the context menu. */
export function menuEntries(menu, trigger, depth = 0) {
  const entries = [];
  for (const item of menu ?? []) {
    if (item.sep) {
      entries.push({ separator: true });
      continue;
    }
    const label = `${' '.repeat(depth)}${item.text ?? ''}`;
    if (Array.isArray(item.items)) {
      entries.push({ label, disabled: true });
      entries.push(...menuEntries(item.items, trigger, depth + 1));
      continue;
    }
    entries.push({
      label,
      checked: item.checkable ? !!item.checked : undefined,
      disabled: !!item.disabled,
      action: () => trigger(item.id),
    });
  }
  return entries;
}

function newSession() {
  /* Not crypto.randomUUID(): a page from another computer is plain HTTP, and
   * that is only there in a secure context. */
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `page-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/* ------------------------------------------------------------- one window */

/**
 * The form for one window. Each widget registers how to show a new state of
 * itself, so a description of the same shape only changes values.
 */
class WindowView {
  constructor(windowId, act) {
    this.windowId = windowId;
    this.act = act;
    this.updaters = new Map();
    this.shape = '';
  }

  render(body) {
    this.updaters.clear();
    this.shape = shapeOf(body);
    return this.#node(body) ?? h('div.webmix-pw-empty');
  }

  /** Show a new state; false when the window's shape changed and it has to be drawn again. */
  patch(body) {
    if (shapeOf(body) !== this.shape) return false;
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.id !== undefined) this.updaters.get(node.id)?.(node);
      for (const item of node.items ?? []) visit(item);
      for (const cell of node.cells ?? []) visit(cell.item);
      if (node.t === 'form') {
        for (const row of node.rows ?? []) {
          visit(row.label);
          visit(row.field);
          visit(row.span);
        }
      }
      visit(node.body);
    };
    visit(body);
    return true;
  }

  #bind(node, update) {
    this.updaters.set(node.id, update);
    update(node);
  }

  #node(node) {
    if (!node || typeof node !== 'object') return null;
    switch (node.t) {
      case 'box':
        return this.#box(node);
      case 'grid':
        return this.#grid(node);
      case 'form':
        return this.#form(node);
      case 'spacer':
        return h(`div.webmix-pw-spacer${node.grow ? '.is-grow' : ''}`);
      case 'group':
        return this.#group(node);
      case 'tabs':
        return this.#tabs(node);
      case 'label':
        return this.#label(node);
      case 'image':
        return this.#image(node);
      case 'check':
        return this.#check(node);
      case 'radio':
        return this.#radio(node);
      case 'button':
        return this.#button(node);
      case 'text':
        return this.#text(node);
      case 'textarea':
        return this.#textarea(node);
      case 'combo':
        return node.editable ? this.#editableCombo(node) : this.#combo(node);
      case 'number':
        return this.#number(node);
      case 'slider':
        return this.#slider(node);
      case 'progress':
        return this.#progress(node);
      case 'list':
        return this.#list(node);
      case 'separator':
        return h(`hr.webmix-pw-sep${node.dir === 'v' ? '.is-v' : ''}`);
      case 'unsupported':
        return h('div.webmix-pw-unsupported.obs-muted', {
          text: t('WebMix.PluginUi.Unsupported', node.cls ?? '?'),
          raw: true,
        });
      default:
        return null;
    }
  }

  #box(node) {
    const el = h(`div.webmix-pw-box.is-${node.dir === 'h' ? 'h' : 'v'}${node.buttons ? '.is-buttons' : ''}`);
    for (const item of node.items ?? []) {
      const child = this.#node(item);
      if (child) el.appendChild(child);
    }
    return el;
  }

  #grid(node) {
    const el = h('div.webmix-pw-grid');
    let columns = 1;
    for (const cell of node.cells ?? []) {
      const child = this.#node(cell.item);
      if (!child) continue;
      const wrap = h('div.webmix-pw-cell', {}, [child]);
      wrap.style.gridRow = `${cell.r + 1} / span ${cell.rs}`;
      wrap.style.gridColumn = `${cell.c + 1} / span ${cell.cs}`;
      columns = Math.max(columns, cell.c + cell.cs);
      el.appendChild(wrap);
    }
    /* Labels take what they need; the last column takes the rest, as a Qt
     * grid with a stretching field column does. */
    el.style.gridTemplateColumns = columns > 1 ? `repeat(${columns - 1}, auto) minmax(0, 1fr)` : 'minmax(0, 1fr)';
    return el;
  }

  #form(node) {
    const el = h('div.webmix-pw-form');
    for (const row of node.rows ?? []) {
      if (row.span) {
        const child = this.#node(row.span);
        if (child) el.appendChild(h('div.webmix-pw-span', {}, [child]));
        continue;
      }
      el.appendChild(h('div.webmix-pw-form-label', {}, [this.#node(row.label)]));
      el.appendChild(h('div.webmix-pw-cell', {}, [this.#node(row.field)]));
    }
    return el;
  }

  #group(node) {
    const title = h('span');
    const legend = h('legend.webmix-pw-legend');
    let input = null;
    if (node.checkable) {
      input = h('input.obs-checkbox', { type: 'checkbox' });
      input.addEventListener('change', () => this.act(node.id, 'set', input.checked));
      legend.appendChild(h('label.obs-checkbox', {}, [input, title]));
    } else {
      legend.appendChild(title);
    }
    const el = h('fieldset.webmix-pw-group', {}, [legend, this.#node(node.body)]);
    this.#bind(node, (next) => {
      title.textContent = next.title ?? '';
      if (input) {
        input.checked = !!next.checked;
        input.disabled = !!next.disabled;
      }
      el.classList.toggle('is-disabled', !!next.disabled);
      el.title = next.tip ?? '';
    });
    return el;
  }

  #tabs(node) {
    const bar = h('div.webmix-pw-tabbar', { role: 'tablist' });
    const el = h('div.webmix-pw-tabs', {}, [bar]);
    const body = this.#node(node.body);
    if (body) el.appendChild(h('div.webmix-pw-tabpage', {}, [body]));
    this.#bind(node, (next) => {
      clear(bar);
      (next.tabs ?? []).forEach((tab, index) => {
        if (tab.hidden) return;
        const active = index === next.current;
        bar.appendChild(
          h(`button.webmix-pw-tab${active ? '.is-active' : ''}`, {
            type: 'button',
            role: 'tab',
            'aria-selected': String(active),
            disabled: !!tab.disabled || !!next.disabled,
            text: tab.title ?? '',
            raw: true,
            on: { click: () => !active && this.act(node.id, 'tab', index) },
          })
        );
      });
    });
    return el;
  }

  #label(node) {
    const el = h('div.webmix-pw-label');
    let drawn = null;
    this.#bind(node, (next) => {
      const parts = JSON.stringify(next.parts ?? []);
      if (parts !== drawn) {
        drawn = parts;
        clear(el);
        for (const part of next.parts ?? []) el.appendChild(this.#part(part, next));
      }
      el.classList.toggle('is-wrap', !!next.wrap);
      el.classList.toggle('is-disabled', !!next.disabled);
      el.style.textAlign = next.align ?? '';
      el.title = next.tip ?? '';
    });
    return el;
  }

  #part(part, node) {
    const text = part.text ?? '';
    if (!part.href) return part.bold ? h('strong', { text, raw: true }) : document.createTextNode(text);
    const external = !!node.external && SAFE_LINK.test(part.href);
    return h('a.webmix-pw-link', {
      href: external ? part.href : '#',
      target: external ? '_blank' : null,
      rel: external ? 'noopener noreferrer' : null,
      text,
      raw: true,
      on: {
        click: (event) => {
          if (external) return;
          event.preventDefault();
          this.act(node.id, 'link', part.href);
        },
      },
    });
  }

  #image(node) {
    const img = h('img.webmix-pw-image', { alt: '' });
    this.#bind(node, (next) => {
      if (SAFE_IMAGE.test(next.src ?? '') && img.getAttribute('src') !== next.src) img.src = next.src;
      if (next.w) img.width = next.w;
      if (next.h) img.height = next.h;
      img.title = next.tip ?? '';
    });
    return img;
  }

  #check(node) {
    const input = h('input.obs-checkbox', { type: 'checkbox' });
    const text = h('span');
    const el = h('label.obs-checkbox.webmix-pw-check', {}, [input, text]);
    let current = node;
    input.addEventListener('change', () => {
      /* A three-state box goes to its next state, as a click does in Qt. */
      const value = current.tristate ? ((Number(current.checked) || 0) + 1) % 3 : input.checked;
      this.act(node.id, 'set', value);
    });
    this.#bind(node, (next) => {
      current = next;
      if (next.tristate) {
        input.indeterminate = next.checked === 1;
        input.checked = next.checked === 2;
      } else {
        input.checked = !!next.checked;
      }
      input.disabled = !!next.disabled;
      text.textContent = next.text ?? '';
      if (next.label) input.setAttribute('aria-label', next.label);
      el.title = next.tip ?? (next.text ? '' : next.label ?? '');
    });
    return el;
  }

  #radio(node) {
    const input = h('input.obs-radio', { type: 'radio' });
    const text = h('span');
    const el = h('label.obs-radio-label.webmix-pw-check', {}, [input, text]);
    input.addEventListener('change', () => input.checked && this.act(node.id, 'set', true));
    this.#bind(node, (next) => {
      input.checked = !!next.checked;
      input.disabled = !!next.disabled;
      text.textContent = next.text ?? '';
      el.title = next.tip ?? '';
    });
    return el;
  }

  #button(node) {
    const el = h('button.obs-btn.webmix-pw-button', { type: 'button' });
    let current = node;
    el.addEventListener('click', () => {
      if (current.menu && current.menuOnly) this.#openMenu(current, el);
      else this.act(node.id, 'click');
    });
    const arrow =
      node.menu && !node.menuOnly
        ? h('button.obs-btn.webmix-pw-menu-arrow', {
            type: 'button',
            text: '▾',
            on: { click: () => this.#openMenu(current, arrow) },
          })
        : null;
    this.#bind(node, (next) => {
      current = next;
      clear(el);
      if (next.icon && SAFE_IMAGE.test(next.icon)) el.appendChild(h('img.webmix-pw-icon', { src: next.icon, alt: '' }));
      if (!next.iconOnly && next.text) el.appendChild(h('span', { text: next.text, raw: true }));
      if (next.menuOnly) el.appendChild(h('span.webmix-pw-caret', { text: '▾' }));
      el.title = next.tip ?? (next.iconOnly ? next.text ?? '' : '');
      el.disabled = !!next.disabled;
      el.classList.toggle('primary', !!next.default);
      el.classList.toggle('toggled', !!next.checked);
      if (next.checkable) el.setAttribute('aria-pressed', String(!!next.checked));
      else el.removeAttribute('aria-pressed');
      if (arrow) arrow.disabled = !!next.disabled;
    });
    return arrow ? h('span.webmix-pw-split', {}, [el, arrow]) : el;
  }

  async #openMenu(node, anchor) {
    /* Plugins that fill a menu as it opens fill it now; the reply has it. */
    const reply = await this.act(node.id, 'menu');
    const window = (reply?.windows ?? []).find((win) => win.id === this.windowId);
    const fresh = (window && findNode(window.body, node.id)) ?? node;
    const rect = anchor.getBoundingClientRect();
    showContextMenu(
      { x: rect.left, y: rect.bottom },
      menuEntries(fresh.menu, (id) => this.act(id, 'trigger'))
    );
  }

  /** A text field that keeps what is being typed while the plugin's state arrives. */
  #editable(input, node, toValue) {
    let typing = false;
    let sent = null;
    const commit = (submit) => {
      typing = false;
      if (!submit && input.value === sent) return;
      sent = input.value;
      this.act(node.id, 'set', toValue(input.value, submit));
    };
    input.addEventListener('input', () => {
      typing = true;
    });
    input.addEventListener('change', () => commit(false));
    if (input.tagName === 'INPUT') {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(true);
        }
      });
    }
    return (value) => {
      if (typing && document.activeElement === input) return;
      typing = false;
      if (input.value !== value) input.value = value;
      sent = value;
    };
  }

  #text(node) {
    const input = h('input.obs-input.webmix-pw-text', { type: node.password ? 'password' : 'text' });
    const show = this.#editable(input, node, (text, submit) => ({ text, submit }));
    this.#bind(node, (next) => {
      show(next.value ?? '');
      input.readOnly = !!next.readonly;
      input.disabled = !!next.disabled;
      input.placeholder = next.placeholder ?? '';
      input.title = next.tip ?? '';
    });
    return input;
  }

  #textarea(node) {
    const area = h('textarea.obs-input.webmix-pw-textarea.obs-scroll', { rows: 6 });
    const show = this.#editable(area, node, (text) => text);
    this.#bind(node, (next) => {
      const atEnd = area.scrollTop + area.clientHeight >= area.scrollHeight - 4;
      show(next.value ?? '');
      /* A log view keeps following its end. */
      if (atEnd) area.scrollTop = area.scrollHeight;
      area.readOnly = !!next.readonly;
      area.disabled = !!next.disabled;
      area.title = next.tip ?? '';
    });
    return area;
  }

  #combo(node) {
    const select = h('select.obs-select.webmix-pw-combo');
    select.addEventListener('change', () => this.act(node.id, 'set', { index: select.selectedIndex }));
    let drawn = null;
    this.#bind(node, (next) => {
      const items = JSON.stringify(next.items ?? []);
      if (items !== drawn) {
        drawn = items;
        clear(select);
        for (const text of next.items ?? []) select.appendChild(h('option', { text, raw: true }));
      }
      select.selectedIndex = next.index ?? -1;
      select.disabled = !!next.disabled;
      select.title = next.tip ?? '';
    });
    return select;
  }

  #editableCombo(node) {
    const list = h('datalist', { id: `webmix-pw-${this.windowId}-${node.id}` });
    const input = h('input.obs-input.webmix-pw-text', { type: 'text', list: list.id });
    const show = this.#editable(input, node, (text) => ({ text }));
    let drawn = null;
    this.#bind(node, (next) => {
      const items = JSON.stringify(next.items ?? []);
      if (items !== drawn) {
        drawn = items;
        clear(list);
        for (const text of next.items ?? []) list.appendChild(h('option', { value: text }));
      }
      show(next.value ?? '');
      input.disabled = !!next.disabled;
      input.title = next.tip ?? '';
    });
    return h('span.webmix-pw-editable-combo', {}, [input, list]);
  }

  #number(node) {
    const input = h('input.obs-input.webmix-pw-number', { type: 'number' });
    const prefix = h('span.webmix-pw-affix');
    const suffix = h('span.webmix-pw-affix');
    let decimals = 0;
    const show = this.#editable(input, node, (text) => Number(text));
    this.#bind(node, (next) => {
      decimals = Number(next.decimals) || 0;
      input.min = String(next.min);
      input.max = String(next.max);
      input.step = String(decimals > 0 ? next.step || 10 ** -decimals : next.step || 1);
      show(Number(next.value ?? 0).toFixed(decimals));
      input.readOnly = !!next.readonly;
      input.disabled = !!next.disabled;
      input.title = next.tip ?? next.special ?? '';
      prefix.textContent = next.prefix ?? '';
      suffix.textContent = next.suffix ?? '';
    });
    return h('span.webmix-pw-number-wrap', {}, [prefix, input, suffix]);
  }

  #slider(node) {
    const input = h('input.obs-range.webmix-pw-slider', { type: 'range' });
    input.addEventListener('change', () => this.act(node.id, 'set', Number(input.value)));
    this.#bind(node, (next) => {
      input.min = String(next.min);
      input.max = String(next.max);
      input.step = String(next.step || 1);
      if (document.activeElement !== input) input.value = String(next.value);
      input.disabled = !!next.disabled;
      input.title = next.tip ?? '';
    });
    return input;
  }

  #progress(node) {
    const bar = h('progress.webmix-pw-progress');
    const text = h('span.webmix-pw-progress-text');
    this.#bind(node, (next) => {
      const span = Math.max(0, (next.max ?? 0) - (next.min ?? 0));
      /* min == max is Qt's "busy" bar. */
      if (span > 0) {
        bar.max = span;
        bar.value = Math.min(span, Math.max(0, (next.value ?? 0) - (next.min ?? 0)));
      } else {
        bar.removeAttribute('value');
      }
      text.textContent = next.text ?? '';
    });
    return h('div.webmix-pw-progress-row', {}, [bar, text]);
  }

  #list(node) {
    const head = h('thead');
    const body = h('tbody');
    const wrap = h('div.webmix-pw-list.obs-scroll', {}, [h('table.obs-table.webmix-pw-table', {}, [head, body])]);
    this.#bind(node, (next) => {
      const scroll = wrap.scrollTop;
      clear(head);
      if (next.columns) head.appendChild(h('tr', {}, next.columns.map((name) => h('th', { text: name, raw: true }))));
      clear(body);
      const usable = !next.disabled;
      for (const row of next.rows ?? []) {
        const tr = h(`tr.webmix-pw-row${row.selected ? '.is-selected' : ''}${row.disabled ? '.is-disabled' : ''}`);
        (row.cells ?? []).forEach((cell, index) => {
          const td = h('td');
          if (index === 0 && row.check !== undefined) {
            const box = h('input.obs-checkbox', { type: 'checkbox', disabled: !usable || row.disabled });
            box.checked = row.check === 2;
            box.indeterminate = row.check === 1;
            box.addEventListener('change', () => this.act(node.id, 'check', { row: row.r, checked: box.checked }));
            td.appendChild(box);
          }
          if (cell && typeof cell === 'object') {
            const child = this.#node(cell);
            if (child) td.appendChild(child);
          } else {
            td.appendChild(document.createTextNode(String(cell ?? '')));
          }
          tr.appendChild(td);
        });
        const own = (event) => !event.target.closest('button, input, select, textarea, a');
        tr.addEventListener('click', (event) => {
          if (usable && !row.disabled && own(event)) {
            this.act(node.id, 'select', { row: row.r, toggle: !!(next.multi && (event.ctrlKey || event.metaKey)) });
          }
        });
        tr.addEventListener('dblclick', (event) => {
          if (usable && !row.disabled && own(event)) this.act(node.id, 'activate', { row: row.r });
        });
        body.appendChild(tr);
      }
      const shown = (next.rows ?? []).length;
      if (next.total > shown) {
        body.appendChild(
          h('tr.webmix-pw-more', {}, [
            h('td.obs-muted', {
              colspan: String(Math.max(1, (next.columns ?? next.rows?.[0]?.cells ?? [0]).length)),
              text: t('WebMix.PluginUi.MoreRows', next.total - shown),
              raw: true,
            }),
          ])
        );
      }
      wrap.scrollTop = scroll;
      wrap.classList.toggle('is-disabled', !usable);
      wrap.title = next.tip ?? '';
    });
    return wrap;
  }
}

/* ------------------------------------------------------- all the windows */

/** The session of windows nobody asked for (OBS's own error box, a plugin's
 *  warning) and of notices: every page shows them. */
export const EVERYONE = '*';

/** The event OBS sends instead of opening a link or folder on its computer. */
export const OPEN_URL_EVENT = 'WebMixOpenUrl';

/** What a notice says: `{title, lines}`. */
export function noticeText(notice) {
  switch (notice?.kind) {
    case 'startup':
      return {
        title: notice.title || 'OBS',
        lines: [notice.text, t('WebMix.Notice.StartupAnswered')].filter(Boolean),
      };
    default:
      return { title: notice?.title || 'OBS', lines: [notice?.text].filter(Boolean) };
  }
}

const SESSION_KEY = 'webmix.pluginWindowsSession';

/* The page's session survives a reload of the tab, so a window it opened comes
 * back with it instead of being left open where nobody sees it. */
function pageSession() {
  try {
    const known = sessionStorage.getItem(SESSION_KEY);
    if (known) return known;
  } catch {
    /* storage refused: a new session each load is fine */
  }
  const session = newSession();
  try {
    sessionStorage.setItem(SESSION_KEY, session);
  } catch {
    /* as above */
  }
  return session;
}

export class PluginWindows {
  constructor({ onStatus } = {}) {
    this.onStatus = onStatus;
    this.session = pageSession();
    /** `{items, pluginManager}` when OBS serves the page, else null. */
    this.tools = null;
    this.views = new Map();
    this.closing = new Set();
    this.notices = new Map();
    this.refreshing = null;
  }

  async loadTools() {
    const tools = await fetchPluginTools();
    this.tools = Array.isArray(tools?.items) ? tools : null;
    return this.tools;
  }

  /** Open a Tools menu entry; `label` names it if it opens nothing. */
  async trigger(id, label = '') {
    const result = await triggerPluginTool(id, this.session);
    if (!result?.ok) {
      this.onStatus?.(result?.error ?? t('WebMix.PluginUi.Failed'), 'error');
      return;
    }
    this.handle(result);
    if (result.opened === false && !(result.open ?? []).length) {
      this.onStatus?.(t('WebMix.PluginUi.NoWindow', label), 'info');
    }
  }

  /**
   * A state from OBS: the windows of this page, or of every page (`*`), and
   * the ones that changed. A reply carries both (`everyone`).
   */
  handle(payload, { refetch = true } = {}) {
    if (!payload) return;
    if (payload.everyone) this.handle(payload.everyone, { refetch });
    const owner = payload.session;
    if (owner !== this.session && owner !== EVERYONE) return;

    const open = new Set(payload.open ?? []);
    for (const [id, view] of [...this.views]) {
      if (view.owner === owner && !open.has(id)) this.#close(id);
    }
    for (const win of payload.windows ?? []) {
      if (open.has(win.id) && !this.closing.has(win.id)) this.#show(win, owner);
    }
    if (owner === EVERYONE && Array.isArray(payload.notices)) this.#showNotices(payload.notices);
    /* Open, but never seen here (the page missed the event that had it). */
    if (refetch && [...open].some((id) => !this.views.has(id) && !this.closing.has(id))) this.refresh();
  }

  /** Ask for every window this page shows: after a reconnect, or a missed event. */
  refresh() {
    if (!this.refreshing) {
      this.refreshing = fetchPluginWindows(this.session)
        .then((state) => {
          if (state?.ok) this.handle(state, { refetch: false });
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  /**
   * A link or folder a plugin opened: here, not on the computer running OBS.
   * A new tab needs the click that led to it, which may be spent by now, so a
   * blocked one becomes a link to click.
   */
  openUrl(payload) {
    if (!payload || (payload.session !== this.session && payload.session !== EVERYONE)) return;
    if (payload.url && SAFE_LINK.test(payload.url)) {
      const opened = window.open(payload.url, '_blank', 'noopener');
      if (opened) return;
      const dialog = openDialog({
        title: 'WebMIX',
        width: 460,
        body: [
          h('div.webmix-pw-notice', { text: t('WebMix.PluginUi.OpenLink'), raw: true }),
          h('a.webmix-pw-link', {
            href: payload.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: payload.url,
            raw: true,
            on: { click: () => dialog.close('ok') },
          }),
        ],
        footer: dialogButtons([{ label: 'OK', primary: true, action: () => dialog.close('ok') }]),
      });
      return;
    }
    if (payload.path) {
      this.onStatus?.(t('WebMix.PluginUi.OpenFolder', payload.path), 'info');
    }
  }

  #show(win, owner) {
    const known = this.views.get(win.id);
    if (known) {
      known.owner = owner;
      if (known.title !== win.title) {
        known.title = win.title;
        const title = known.dialog.el.querySelector('.obs-dialog-title')?.firstChild;
        if (title?.nodeType === Node.TEXT_NODE) title.nodeValue = win.title || 'WebMIX';
      }
      if (!known.view.patch(win.body)) {
        const scroll = known.dialog.body.scrollTop;
        clear(known.dialog.body);
        known.dialog.body.appendChild(known.view.render(win.body));
        known.dialog.body.scrollTop = scroll;
      }
      return;
    }

    const view = new WindowView(win.id, (widget, action, value) => this.#act(win.id, widget, action, value));
    const body = view.render(win.body);
    const width = Math.min(Math.max((win.width ?? 480) + 32, 320), Math.max(320, window.innerWidth - 32));
    const dialog = openDialog({
      title: win.title || 'WebMIX',
      body,
      width,
      className: 'webmix-plugin-window',
      onClose: (reason) => {
        if (this.views.get(win.id)?.dialog !== dialog) return;
        this.views.delete(win.id);
        if (reason !== 'server') this.#requestClose(win.id);
      },
    });
    this.views.set(win.id, { view, dialog, title: win.title, owner });
  }

  #close(id) {
    const known = this.views.get(id);
    if (!known) return;
    this.views.delete(id);
    known.dialog.close('server');
  }

  /* Each notice once, until a page dismisses it; then it goes everywhere. */
  #showNotices(list) {
    const current = new Set(list.map((notice) => notice.id));
    for (const [id, dialog] of [...this.notices]) {
      if (!current.has(id)) {
        this.notices.delete(id);
        dialog.close('server');
      }
    }
    for (const notice of list) {
      if (this.notices.has(notice.id)) continue;
      const { title, lines } = noticeText(notice);
      const dialog = openDialog({
        title,
        width: 480,
        className: 'webmix-plugin-notice',
        body: lines.map((line) => h('div.webmix-pw-notice', { text: line, raw: true })),
        footer: dialogButtons([{ label: 'OK', primary: true, action: () => dialog.close('ok') }]),
        onClose: (reason) => {
          if (this.notices.get(notice.id) !== dialog) return;
          this.notices.delete(notice.id);
          if (reason !== 'server') this.#dismiss(notice.id);
        },
      });
      this.notices.set(notice.id, dialog);
    }
  }

  async #dismiss(id) {
    const result = await actOnPluginWindow({ session: this.session, action: 'dismiss', value: id });
    if (result?.ok) this.handle(result);
  }

  /* Closed here: the plugin's window is asked to close, and stays if it says no. */
  async #requestClose(id) {
    this.closing.add(id);
    const result = await actOnPluginWindow({ session: this.session, window: id, action: 'close' });
    this.closing.delete(id);
    if (result?.ok) this.handle(result);
  }

  async #act(windowId, widget, action, value) {
    const result = await actOnPluginWindow({ session: this.session, window: windowId, widget, action, value });
    if (!result?.ok) {
      this.onStatus?.(result?.error ?? t('WebMix.PluginUi.Failed'), 'warning');
      this.refresh();
      return result;
    }
    this.handle(result);
    return result;
  }
}
