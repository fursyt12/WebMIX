/*
 * WebMIX - File > Remux Recordings.
 *
 * The desktop dialog (frontend/dialogs/OBSRemux.cpp) queues recordings, runs
 * them through libobs' own remuxer and shows three columns: a state icon, the
 * OBS recording and the target file. This is the same queue, driven through the
 * bridge (`/api/remux`), which owns the worker thread inside OBS.
 *
 * Two things cannot work the same way in a browser: there is no file dialog on
 * the OBS machine, so the empty "OBS Recording" row browses the recordings
 * directory over the bridge instead, and the target name is derived from the
 * chosen container the way RemuxQueueModel derives it (dropping a file into the
 * window still queues the recording of that name on the OBS machine).
 */
import { h, clear } from '../dom.js';
import { icon } from './icons.js';
import { openDialog, dialogButtons, confirm, alert } from './dialog.js';
import { fetchListing } from './files.js';
import {
  fetchRemuxState,
  addRemux,
  startRemux,
  stopRemux,
  clearFinishedRemux,
  clearAllRemux,
} from '../bridge.js';

const FORMATS = [
  { id: 'mp4', label: 'MP4' },
  { id: 'mov', label: 'MOV' },
  { id: 'mkv', label: 'MKV' },
];

/* RemuxEntryPathItemDelegate: (*.mp4 *.flv *.mov *.mkv *.ts *.m3u8) */
const VIDEO_FILE = /\.(mp4|flv|mov|mkv|ts|m3u8)$/i;

const POLL_MS = 500;

/* RemuxQueueModel::getIcon(), minus the Qt style icons. */
const STATE_ICONS = {
  complete: { name: 'check', className: 'is-complete' },
  in_progress: { name: 'play', className: 'is-progress' },
  error: { name: 'close', className: 'is-error' },
  invalid_path: { name: 'warning', className: 'is-warning' },
};

const STATE_LABELS = {
  ready: 'Ready',
  pending: 'Pending',
  in_progress: 'Remuxing',
  complete: 'Remuxed',
  invalid_path: 'The recording no longer exists',
  error: 'Remuxing failed',
};

/**
 * Open the Remux Recordings dialog.
 *
 * @param {object} [options]
 * @param {(text: string, kind?: string) => void} [options.onStatus]  status bar hook
 */
export async function openRemuxDialog({ onStatus } = {}) {
  let format = 'mp4';
  let state = null;
  let started = false;
  let busy = false;
  let closed = false;

  const helpText = h('div.obs-remux-help', {
    text: 'Drop files in this window to remux, or select an empty "OBS Recording" cell to browse for a file.',
  });

  const formatSelect = h(
    'select.obs-select',
    {
      on: {
        change: () => {
          format = formatSelect.value;
        },
      },
    },
    FORMATS.map((entry) => h('option', { value: entry.id, text: entry.label }))
  );
  formatSelect.value = format;

  const table = h('table.obs-table.obs-remux-table');
  const progressFill = h('div.obs-progress-fill');
  const progressBar = h('div.obs-progress', { hidden: true }, [progressFill]);

  const remuxButton = h('button.obs-btn.primary', { type: 'button', on: { click: onRemux } });
  const clearFinishedButton = h('button.obs-btn', { type: 'button', on: { click: onClearFinished } });
  const clearAllButton = h('button.obs-btn', { type: 'button', on: { click: onClearAll } });
  const closeButton = h('button.obs-btn', { type: 'button', text: 'Close', on: { click: () => dialog.close() } });
  clearFinishedButton.textContent = 'Clear Finished Items';
  clearAllButton.textContent = 'Clear All Items';

  const dialog = openDialog({
    title: 'Remux Recordings',
    width: 850,
    height: 400,
    className: 'obs-remux-dialog',
    body: [
      h('div.obs-remux-help-row', {}, [
        helpText,
        h('label.obs-remux-format', {}, [h('span', { text: 'Target format' }), formatSelect]),
      ]),
      table,
      progressBar,
    ],
    footer: h('div.obs-dialog-buttons', {}, [remuxButton, clearFinishedButton, clearAllButton, closeButton]),
    onClose: () => {
      closed = true;
      clearInterval(timer);
    },
  });

  /* ------------------------------------------------------------------ rows */

  function render(next) {
    state = next;
    const jobs = next?.jobs ?? [];
    const processing = Boolean(next?.processing);

    clear(table);
    table.appendChild(
      h('thead', {}, [
        h('tr', {}, [
          h('th.obs-remux-state'),
          h('th', { text: 'OBS Recording' }),
          h('th', { text: 'Target File' }),
        ]),
      ])
    );

    const tbody = h('tbody');
    for (const job of jobs) {
      const spec = STATE_ICONS[job.state];
      const stateCell = h('td.obs-remux-state', { title: job.error ?? STATE_LABELS[job.state] ?? job.state });
      if (spec) {
        stateCell.classList.add(spec.className);
        stateCell.appendChild(icon(spec.name, 14));
      }
      tbody.appendChild(
        h('tr', { title: job.error ?? '' }, [
          stateCell,
          h('td.obs-remux-path', { text: job.source, title: job.source }),
          h('td.obs-remux-path', { text: job.target, title: job.target }),
        ])
      );
    }

    /* The model's insertion point: an empty row that opens a file browser. */
    if (!processing) {
      const insert = h('tr.obs-remux-insert', { title: 'Select OBS Recording...' }, [
        h('td.obs-remux-state'),
        h('td.obs-remux-path.obs-muted', { text: 'Select OBS Recording...' }),
        h('td.obs-remux-path.obs-muted', { text: 'Select a recording first' }),
      ]);
      insert.addEventListener('click', () => browse(''));
      tbody.appendChild(insert);
    }
    table.appendChild(tbody);

    remuxButton.textContent = processing ? 'Stop Remuxing' : 'Remux';
    remuxButton.disabled = busy || (!processing && jobs.length === 0);
    clearFinishedButton.disabled = busy || !next?.canClearFinished;
    clearAllButton.disabled = busy || jobs.length === 0;

    progressBar.hidden = !processing;
    const percent = Math.round((next?.progress ?? 0) * 100);
    progressFill.style.width = `${percent}%`;

    /* OBSRemux::remuxNextEntry(): report the outcome once the queue drains.
     * A short recording can be remuxed before the start response even arrives,
     * so this checks the queue, not a processing -> idle transition. */
    if (started && !processing) {
      started = false;
      const failed = jobs.some((job) => job.state === 'error' || job.state === 'invalid_path');
      onStatus?.(failed ? 'Remuxing finished with errors' : 'Remuxing finished', failed ? 'warning' : 'info');
      alert({
        title: 'Remuxing finished',
        text: failed ? 'Recording remuxed, but the file may be incomplete' : 'Recording remuxed',
        icon: failed ? 'warning' : 'info',
      });
    }
  }

  async function refresh({ silent = false } = {}) {
    const next = await fetchRemuxState();
    if (!next) {
      if (!silent) {
        clear(table);
        table.appendChild(
          h('tbody', {}, [
            h('tr', {}, [
              h('td.obs-muted', {
                colspan: 3,
                text: 'Remuxing needs OBS to serve this page (--web); the bridge is not available.',
              }),
            ]),
          ])
        );
        remuxButton.disabled = true;
        clearFinishedButton.disabled = true;
        clearAllButton.disabled = true;
      }
      return null;
    }
    render(next);
    return next;
  }

  /* ---------------------------------------------------------------- actions */

  async function queue(relativePath, overwrite = false) {
    busy = true;
    const result = await addRemux(relativePath, format, overwrite);
    busy = false;

    if (!result) {
      onStatus?.('the WebMIX bridge is not available', 'warning');
      return;
    }
    if (result.ok) {
      onStatus?.(`${relativePath} added to the remux list`, 'info');
      await refresh();
      return;
    }
    if (result.conflict) {
      const replace = await confirm({
        title: 'Target files exist',
        text: `The following target files already exist. Do you want to replace them?\n\n${result.target}`,
        okLabel: 'Replace',
        danger: true,
      });
      if (replace) {
        await queue(relativePath, true);
      }
      return;
    }
    if (result.error) {
      onStatus?.(result.error, 'warning');
      await alert({ title: 'Remux Recordings', text: result.error, icon: 'warning' });
    }
  }

  async function onRemux() {
    if (busy) return;

    if (state?.processing) {
      const stop = await confirm({
        title: 'Remuxing in progress',
        text: 'Remuxing is not finished, stopping now may render the target file unusable.\nAre you sure you want to stop remuxing?',
        okLabel: 'Yes',
        cancelLabel: 'No',
        danger: true,
      });
      if (!stop) return;
      busy = true;
      const result = await stopRemux();
      busy = false;
      if (result) render(result);
      return;
    }

    busy = true;
    const result = await startRemux();
    busy = false;
    if (!result) {
      onStatus?.('the WebMIX bridge is not available', 'warning');
      return;
    }
    if (!result.ok) {
      onStatus?.(result.error ?? 'nothing to remux', 'warning');
      render(result);
      return;
    }
    started = true;
    render(result);
  }

  async function onClearFinished() {
    if (busy) return;
    busy = true;
    const result = await clearFinishedRemux();
    busy = false;
    if (result) render(result);
  }

  async function onClearAll() {
    if (busy) return;
    busy = true;
    const result = await clearAllRemux();
    busy = false;
    if (result) render(result);
  }

  /* --------------------------------------------------- recording browser */

  /** Browse the recordings directory (the desktop's "Select OBS Recording..."). */
  function browse(relative) {
    let current = relative;
    const pathLabel = h('div.obs-files-path.obs-muted');
    const list = h('div.obs-remux-picker.obs-scroll');

    const picker = openDialog({
      title: 'Select OBS Recording...',
      width: 640,
      height: 460,
      closable: true,
      body: [pathLabel, list],
      footer: dialogButtons([{ label: 'Cancel', action: () => picker.close() }]),
    });

    async function load(nextRelative) {
      const listing = await fetchListing('recordings', nextRelative);
      clear(list);
      if (!listing) {
        list.appendChild(
          h('div.obs-hint.obs-muted', {
            text: 'File access needs OBS to serve this page (--web); the bridge is not available.',
          })
        );
        return;
      }
      if (listing.error) {
        list.appendChild(h('div.obs-error', { text: listing.error }));
        return;
      }

      current = listing.relative ?? '';
      pathLabel.textContent = listing.path ?? '';

      if (current) {
        const up = h('button.obs-btn.flat', { type: 'button', text: '\u2191 Up' });
        up.addEventListener('click', () => load(listing.parent ?? ''));
        list.appendChild(up);
      }

      const entries = (listing.entries ?? []).filter(
        (entry) => entry.isDirectory || VIDEO_FILE.test(entry.name)
      );
      if (!entries.length) {
        list.appendChild(h('div.obs-hint.obs-muted', { text: 'No recordings in this folder' }));
      }
      for (const entry of entries) {
        const child = current ? `${current}/${entry.name}` : entry.name;
        const button = h('button.obs-btn.flat.obs-files-dir', {
          type: 'button',
          text: entry.isDirectory ? `\u{1F4C1} ${entry.name}` : entry.name,
        });
        button.addEventListener('click', () => {
          if (entry.isDirectory) {
            load(child);
          } else {
            picker.close();
            queue(child);
          }
        });
        list.appendChild(button);
      }
    }

    load(relative);
  }

  /* Dropping a recording queues it by file name on the OBS machine. */
  dialog.el.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!state?.processing) event.dataTransfer.dropEffect = 'copy';
  });
  dialog.el.addEventListener('drop', async (event) => {
    event.preventDefault();
    if (state?.processing || busy) return;
    const names = [...(event.dataTransfer?.files ?? [])].map((file) => file.name).filter(Boolean);
    for (const name of names) {
      await queue(name);
    }
  });

  const timer = setInterval(() => {
    if (!busy && !closed) refresh({ silent: true });
  }, POLL_MS);

  await refresh();
  return dialog;
}
