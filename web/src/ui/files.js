/*
 * WebMIX - file browser dialogs.
 *
 * The desktop UI's "Show Recordings", "Show Log Files", "Show Settings Folder"
 * and "Show Profile Folder" items open a file manager on the OBS machine. On a
 * headless instance there is no file manager and the machine may be elsewhere
 * entirely, so these dialogs list the same directories and let the browser
 * download the files instead.
 *
 * Only the directories OBS itself uses are reachable; the server validates every
 * path (no "..", no absolute paths, canonical result must stay inside the root).
 */
import { h, clear, setText } from '../dom.js';
import { openDialog, dialogButtons, showContextMenu } from './dialog.js';

const KIND_LABELS = {
  recordings: 'Recordings',
  logs: 'Log Files',
  crashes: 'Crash Reports',
  config: 'Settings Folder',
  profile: 'Profile Folder',
};

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso) {
  if (!iso) return '-';
  return String(iso).replace('T', ' ').slice(0, 16);
}

/** URL for a listing/download/text request. */
export function filesUrl(kind, relativePath = '', extra = {}) {
  const params = new URLSearchParams({ kind });
  if (relativePath) params.set('path', relativePath);
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return `api/files/${extra.endpoint ?? 'list'}?${params.toString()}`;
}

/** Fetch a directory listing; null when the bridge is unavailable. */
export async function fetchListing(kind, relativePath = '') {
  try {
    const response = await fetch(`api/files/list?kind=${encodeURIComponent(kind)}&path=${encodeURIComponent(relativePath)}`, {
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { error: data?.error ?? `request failed (${response.status})` };
    return data;
  } catch {
    return null;
  }
}

/**
 * Open a file browser for one of the known directories.
 *
 * @param {object} options
 * @param {string} options.kind        recordings | logs | crashes | config | profile
 * @param {string} [options.title]
 * @param {boolean} [options.canPreview]  offer an inline viewer for text files
 * @param {boolean} [options.openNewest]  preview the newest file immediately
 * @param {(text: string, kind?: string) => void} [options.onStatus]
 */
export async function openFilesDialog({ kind, title, canPreview = false, openNewest = false, onStatus }) {
  let current = '';
  const pathLabel = h('div.obs-files-path.obs-muted');
  const table = h('table.obs-table.obs-files-table');
  const body = h('div.obs-files-body.obs-scroll', {}, [table]);

  const dialog = openDialog({
    title: title ?? KIND_LABELS[kind] ?? kind,
    width: 760,
    height: 520,
    body: [h('div.obs-files-bar', {}, [pathLabel]), body],
    closable: true,
    footer: null,
  });

  async function load(relative) {
    const listing = await fetchListing(kind, relative);
    if (!listing) {
      clear(body);
      body.appendChild(
        h('div.obs-hint.obs-muted', {
          text: 'File access needs OBS to serve this page (--web); the bridge is not available.',
        })
      );
      setText(pathLabel, '');
      return;
    }
    if (listing.error) {
      onStatus?.(`${KIND_LABELS[kind] ?? kind}: ${listing.error}`, 'warning');
      return;
    }

    current = listing.relative ?? '';
    setText(pathLabel, listing.path ?? '');
    clear(table);

    const entries = listing.entries ?? [];
    if (!entries.length) {
      table.appendChild(h('tbody', {}, [h('tr', {}, [h('td.obs-muted', { text: 'This folder is empty' })])]));
    }

    const rows = h('tbody');
    if (current) {
      const up = h('button.obs-btn.flat', { type: 'button', text: '\u2191 Up' });
      up.addEventListener('click', () => load(listing.parent ?? ''));
      rows.appendChild(h('tr', {}, [h('td', {}, [up]), h('td', {}), h('td', {}), h('td', {})]));
    }

    for (const entry of entries) {
      const relative = current ? `${current}/${entry.name}` : entry.name;
      const nameCell = h('td.obs-files-name');
      if (entry.isDirectory) {
        const open = h('button.obs-btn.flat.obs-files-dir', { type: 'button', text: `\u{1F4C1} ${entry.name}` });
        open.addEventListener('click', () => load(relative));
        nameCell.appendChild(open);
      } else {
        nameCell.textContent = entry.name;
      }

      const actions = h('td.obs-files-actions');
      if (!entry.isDirectory) {
        const download = h('button.obs-btn.flat', { type: 'button', text: 'Download' });
        download.addEventListener('click', () => {
          // One-shot navigation with the attachment header set by the server.
          window.location.href = `api/files/download?kind=${encodeURIComponent(kind)}&path=${encodeURIComponent(relative)}`;
          onStatus?.(`Downloading ${entry.name}`, 'info');
        });
        actions.appendChild(download);

        if (canPreview && /\.(txt|log|json|ini|md)$/i.test(entry.name)) {
          const view = h('button.obs-btn.flat', { type: 'button', text: 'View' });
          view.addEventListener('click', () => showText(kind, relative, entry.name));
          actions.appendChild(view);
        }
      }

      rows.appendChild(
        h('tr', {}, [
          nameCell,
          h('td.obs-files-size', { text: entry.isDirectory ? '' : formatSize(entry.size) }),
          h('td.obs-files-date', { text: formatDate(entry.modified) }),
          actions,
        ])
      );
    }
    table.appendChild(rows);

    if (openNewest && entries.length) {
      const newest = entries.find((entry) => !entry.isDirectory);
      if (newest) {
        showText(kind, current ? `${current}/${newest.name}` : newest.name, newest.name);
      }
    }
  }

  /** Inline text viewer (OBS's "View Current Log"). */
  async function showText(textKind, relative, name) {
    const viewer = openDialog({
      title: name,
      width: 900,
      height: 600,
      body: h('div.obs-empty', { text: 'Loading...' }),
      footer: dialogButtons([
        {
          label: 'Download',
          action: () => {
            window.location.href = `api/files/download?kind=${encodeURIComponent(textKind)}&path=${encodeURIComponent(relative)}`;
          },
        },
        { label: 'Close', primary: true, action: () => viewer.close() },
      ]),
    });

    try {
      const response = await fetch(
        `api/files/text?kind=${encodeURIComponent(textKind)}&path=${encodeURIComponent(relative)}&limit=262144`,
        { cache: 'no-store' }
      );
      const text = await response.text();
      clear(viewer.body);
      viewer.body.appendChild(h('pre.obs-file-viewer.obs-scroll', { text }));
    } catch (err) {
      clear(viewer.body);
      viewer.body.appendChild(h('div.obs-error', { text: String(err?.message ?? err) }));
    }
  }

  dialog.footer.append(
    dialogButtons([
      {
        label: 'Refresh',
        action: () => load(current),
      },
      {
        label: 'Open Folder',
        action: () => onStatus?.('The folder lives on the OBS machine; use Download to fetch a file', 'info'),
      },
      { label: 'Close', primary: true, action: () => dialog.close() },
    ])
  );

  await load('');
  return dialog;
}
