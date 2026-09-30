/*
 * WebMIX - Custom Browser Docks.
 *
 * OBS lets you add any URL as a dock (Docks > Custom Browser Docks...), which
 * streamers use for chat, alerts and dashboards.  The web version reproduces
 * the manager dialog and renders each enabled dock as an iframe in a right-hand
 * column.
 *
 * Limitation: OBS uses an embedded browser that ignores X-Frame-Options, while
 * a real browser enforces it (and CSP `frame-ancestors`).  Some sites therefore
 * refuse to load in a dock; the dock reports that instead of showing a blank
 * frame.  Twitch chat works via its `/embed/<channel>/chat?parent=<host>` form.
 */
import { h, clear, setText, setClass } from '../dom.js';
import { openDialog, dialogButtons, confirm } from './dialog.js';
import { Dock } from './dock.js';

const STORAGE_KEY = 'webmix.customDocks';

/** Add a scheme when the user typed a bare host, like OBS does. */
export function normalizeUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `https://${value}`;
}

export function loadCustomDocks() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((d) => d && d.id && d.url) : [];
  } catch {
    return [];
  }
}

export function saveCustomDocks(docks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docks));
  } catch {
    /* storage may be unavailable */
  }
}

let nextId = 1;
const makeId = () => `dock-${Date.now().toString(36)}-${nextId++}`;

export class CustomDocksPanel {
  /**
   * @param {object} options
   * @param {HTMLElement} options.column  the right-hand column element
   * @param {(text: string, kind?: string) => void} [options.onStatus]
   * @param {(dock: object) => void} [options.onLoadError]
   */
  constructor({ column, onStatus, onLoadError }) {
    this.column = column;
    this.onStatus = onStatus;
    this.onLoadError = onLoadError;
    this.docks = loadCustomDocks();
    this.rendered = new Map(); // id -> { dock: Dock, iframe, entry }
  }

  get entries() {
    return this.docks;
  }

  isEnabled(id) {
    const entry = this.docks.find((d) => d.id === id);
    return entry ? entry.enabled !== false : false;
  }

  setEnabled(id, enabled) {
    const entry = this.docks.find((d) => d.id === id);
    if (!entry) return;
    entry.enabled = enabled;
    this.#persist();
    this.render();
  }

  #persist() {
    saveCustomDocks(this.docks);
  }

  /** Rebuild the dock column from the stored list. */
  render() {
    const enabled = this.docks.filter((d) => d.enabled !== false);

    // Remove docks that are gone or disabled.
    for (const [id, record] of [...this.rendered]) {
      const entry = this.docks.find((d) => d.id === id);
      if (!entry || entry.enabled === false) {
        record.dock.el.remove();
        this.rendered.delete(id);
      }
    }

    for (const entry of enabled) {
      let record = this.rendered.get(entry.id);
      if (!record) {
        const iframe = h('iframe.obs-custom-dock-frame', {
          src: entry.url,
          title: entry.name || entry.url,
          // No sandbox attribute: OBS browser docks are unrestricted, and
          // same-origin access is needed by many dashboards.
          loading: 'lazy',
          allow: 'clipboard-write; fullscreen',
        });
        iframe.addEventListener('error', () => this.#reportLoadError(entry));
        const content = h('div.obs-panel.obs-custom-dock', {}, [iframe]);
        const dock = new Dock({
          id: `custom:${entry.id}`,
          title: entry.name || entry.url,
          content,
          onClose: () => this.setEnabled(entry.id, false),
        });
        this.column.appendChild(dock.el);
        record = { dock, iframe, entry };
        this.rendered.set(entry.id, record);
      } else {
        record.entry = entry;
        record.dock.setTitle(entry.name || entry.url);
        if (record.iframe.getAttribute('src') !== entry.url) record.iframe.setAttribute('src', entry.url);
      }
    }

    this.column.hidden = this.rendered.size === 0;
  }

  #reportLoadError(entry) {
    this.onLoadError?.(entry);
    this.onStatus?.(
      `"${entry.name || entry.url}" refused to load in a frame (X-Frame-Options/CSP). ` +
        'Many sites can only be docked inside OBS itself.',
      'warning'
    );
  }

  /** Docks > Custom Browser Docks... */
  openManager() {
    let draft = this.docks.map((d) => ({ ...d }));
    const list = h('div.obs-custom-dock-rows');

    const renderRows = () => {
      clear(list);
      if (!draft.length) {
        list.appendChild(h('div.obs-empty', { text: 'No custom docks yet' }));
      }
      draft.forEach((entry, index) => {
        const name = h('input.obs-input', {
          type: 'text',
          value: entry.name ?? '',
          placeholder: 'Dock name',
        });
        const url = h('input.obs-input', {
          type: 'text',
          value: entry.url ?? '',
          placeholder: 'https://example.com/chat',
        });
        name.addEventListener('input', () => (draft[index].name = name.value));
        url.addEventListener('input', () => (draft[index].url = url.value));

        const remove = h('button.obs-btn.danger', {
          type: 'button',
          text: 'Remove',
          on: {
            click: () => {
              draft.splice(index, 1);
              renderRows();
            },
          },
        });

        list.appendChild(
          h('div.obs-custom-dock-row', {}, [
            h('div.obs-custom-dock-fields', {}, [
              h('label.obs-label', { text: 'Dock name' }),
              name,
              h('label.obs-label', { text: 'URL' }),
              url,
            ]),
            remove,
          ])
        );
      });
    };

    renderRows();

    const dialog = openDialog({
      title: 'Custom Browser Docks',
      width: 720,
      height: 480,
      body: [
        h('div.obs-hint.obs-muted', {
          text:
            'Docks are shown in the right-hand column. Sites that send X-Frame-Options or a restrictive ' +
            'Content-Security-Policy cannot be framed by a browser.',
        }),
        list,
      ],
      footer: dialogButtons([
        {
          label: 'Add',
          action: () => {
            draft.push({ id: makeId(), name: '', url: '', enabled: true });
            renderRows();
          },
        },
        { label: 'Cancel', action: () => dialog.close() },
        {
          label: 'OK',
          primary: true,
          action: () => {
            const cleaned = draft
              .map((entry) => ({
                id: entry.id ?? makeId(),
                name: (entry.name ?? '').trim(),
                url: normalizeUrl(entry.url),
                enabled: entry.enabled !== false,
              }))
              .filter((entry) => entry.url);
            const dropped = draft.length - cleaned.length;
            this.docks = cleaned;
            this.#persist();
            this.render();
            if (dropped > 0) this.onStatus?.(`${dropped} dock(s) skipped: URL is required`, 'warning');
            dialog.close();
          },
        },
      ]),
    });
    return dialog;
  }

  /** Human-readable size, used by tests. */
  get count() {
    return this.rendered.size;
  }
}
