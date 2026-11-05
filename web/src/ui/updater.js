/*
 * WebMIX - browser-only OBS-style self-updater.
 *
 * Mirrors OBS Studio's update window (`OBSUpdate.ui` + `AutoUpdateThread`),
 * except everything happens inside the browser:
 *
 *   - Background check on startup (configurable in Settings > General) and
 *     explicit check from Help > Check For Updates.
 *   - Formatted release changelog (`## What is new`) with Update Now,
 *     Remind me Later, and Skip Version.
 *   - Live download, verification, package installation, and automatic
 *     restart progress over SSE (`WebMixUpdateStateChanged`), followed by
 *     polling `/api/status` for the new `bootId` and reloading the page so
 *     updated web assets take effect immediately.
 */
import { h, clear, setText } from '../dom.js';
import { t } from '../i18n.js';
import { detectHost } from '../host.js';
import { fetchUpdateState, checkForUpdates, skipUpdateVersion, installUpdate } from '../bridge.js';
import { openDialog, alert, confirm } from './dialog.js';

export const UPDATE_STATE_EVENT = 'WebMixUpdateStateChanged';
const UPDATED_TOAST_KEY = 'webmix.justUpdatedTo';

/* ----------------------------------------------------- pure formatting API */

/** Human-readable byte size (`12.4 MB`). */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let scaled = value;
  while (scaled >= 1024 && idx < units.length - 1) {
    scaled /= 1024;
    idx++;
  }
  return `${idx === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[idx]}`;
}

/** Whether an update state is actively downloading, installing, or restarting. */
export function isUpdateBusy(stateName) {
  return stateName === 'downloading' || stateName === 'installing' || stateName === 'restarting';
}

/**
 * Decide whether an incoming update state should automatically pop up the
 * changelog modal in this browser session.
 */
export function shouldAutoOpenUpdateDialog(state, { remindedVersions = new Set() } = {}) {
  if (!state || typeof state !== 'object') return false;
  if (isUpdateBusy(state.state)) return true;
  if (!state.updateAvailable || !state.latestVersion) return false;
  if (state.state !== 'available' && state.state !== 'ready') return false;
  if (remindedVersions.has(state.latestVersion)) return false;
  if (!state.manualCheck && state.skippedVersion && state.latestVersion === state.skippedVersion) {
    return false;
  }
  return true;
}

/**
 * Tokenize inline Markdown (`**bold**`, `` `code` ``, `[label](https://...)`)
 * without ever touching innerHTML.
 */
export function parseInlineTokens(text) {
  const input = String(text ?? '');
  const tokens = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let cursor = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index > cursor) {
      tokens.push({ type: 'text', text: input.slice(cursor, match.index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ type: 'bold', text: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ type: 'code', text: match[2] });
    } else if (match[3] !== undefined && match[4] !== undefined) {
      tokens.push({ type: 'link', text: match[3], href: match[4] });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < input.length) {
    tokens.push({ type: 'text', text: input.slice(cursor) });
  }
  return tokens;
}

/**
 * Parse release notes Markdown into block descriptors (`heading`, `hr`,
 * `list`, `codeblock`, `paragraph`) for safe DOM rendering and unit tests.
 */
export function parseChangelogBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let listItems = null;
  let paragraphLines = [];
  let inFence = false;
  let fenceLines = [];

  const flushParagraph = () => {
    if (paragraphLines.length) {
      blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
      paragraphLines = [];
    }
  };
  const flushList = () => {
    if (listItems && listItems.length) {
      blocks.push({ type: 'list', items: listItems });
      listItems = null;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      flushParagraph();
      flushList();
      if (inFence) {
        blocks.push({ type: 'codeblock', text: fenceLines.join('\n') });
        fenceLines = [];
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(rawLine);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'hr' });
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      continue;
    }

    const bulletMatch = /^[-*+]\s+(.+)$/.exec(trimmed);
    if (bulletMatch) {
      flushParagraph();
      if (!listItems) listItems = [];
      listItems.push(bulletMatch[1].trim());
      continue;
    }

    if (listItems && listItems.length && /^\s{2,}\S/.test(rawLine)) {
      listItems[listItems.length - 1] += ` ${trimmed}`;
      continue;
    }

    flushList();
    paragraphLines.push(trimmed);
  }

  if (inFence && fenceLines.length) {
    blocks.push({ type: 'codeblock', text: fenceLines.join('\n') });
  }
  flushParagraph();
  flushList();
  return blocks;
}

function renderInlineNodes(text) {
  return parseInlineTokens(text).map((token) => {
    if (token.type === 'bold') return h('strong', { text: token.text, raw: true });
    if (token.type === 'code') return h('code.obs-update-code', { text: token.text, raw: true });
    if (token.type === 'link') {
      return h('a.obs-update-link', {
        href: token.href,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: token.text,
        raw: true,
      });
    }
    return document.createTextNode(token.text);
  });
}

function renderChangelogDom(container, markdown) {
  clear(container);
  const blocks = parseChangelogBlocks(markdown);
  if (!blocks.length) {
    container.appendChild(h('div.obs-muted', { text: '—', raw: true }));
    return;
  }
  for (const block of blocks) {
    if (block.type === 'hr') {
      container.appendChild(h('hr.obs-update-hr'));
    } else if (block.type === 'heading') {
      const tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5';
      container.appendChild(h(`${tag}.obs-update-heading`, { raw: true }, renderInlineNodes(block.text)));
    } else if (block.type === 'list') {
      container.appendChild(
        h(
          'ul.obs-update-list',
          { raw: true },
          block.items.map((item) => h('li', { raw: true }, renderInlineNodes(item)))
        )
      );
    } else if (block.type === 'codeblock') {
      container.appendChild(h('pre.obs-update-pre', { text: block.text, raw: true }));
    } else {
      container.appendChild(h('p.obs-update-p', { raw: true }, renderInlineNodes(block.text)));
    }
  }
}

/* ------------------------------------------------------- UI controller --- */

export class UpdaterController {
  /**
   * @param {object} options
   * @param {object} options.store
   * @param {HTMLElement|null} [options.badgeSlot]
   * @param {(text: string, kind?: string, ms?: number) => void} [options.onStatus]
   * @param {() => void} [options.reload]
   */
  constructor({ store, badgeSlot = null, onStatus = null, reload = null }) {
    this.store = store;
    this.badgeSlot = badgeSlot;
    this.onStatus = onStatus;
    this.reload = reload ?? (() => location.reload());

    this.enabled = false;
    this.initialBootId = null;
    this.state = null;
    this.remindedVersions = new Set();
    this.pendingManualCheck = false;
    this.waitingForRestart = false;
    this.restartPollTimer = null;
    this.dialogView = null;
    this.badgeButton = null;
  }

  /** Attach to the running WebMIX host and check post-update reload state. */
  async start(host) {
    let showedUpdatedMessage = false;
    try {
      const updatedVer = sessionStorage.getItem(UPDATED_TOAST_KEY);
      if (updatedVer) {
        sessionStorage.removeItem(UPDATED_TOAST_KEY);
        showedUpdatedMessage = true;
        this.onStatus?.(
          t('WebMix.Updater.Updated', updatedVer, { fallback: `Updated to WebMIX ${updatedVer}` }),
          'success',
          8000
        );
      }
    } catch {
      /* sessionStorage may be disabled in privacy modes */
    }

    this.enabled = host?.updater === true;
    this.initialBootId = host?.bootId ?? null;
    this.#renderBadge();
    if (!this.enabled) return showedUpdatedMessage;

    const current = await fetchUpdateState();
    if (current) this.handleState(current);
    return showedUpdatedMessage;
  }

  /** Invoked when the user clicks `Help > Check For Updates`. */
  async triggerManualCheck() {
    if (!this.enabled) {
      window.open('https://github.com/fursyt12/WebMIX/releases', '_blank', 'noopener');
      return;
    }
    if (this.waitingForRestart || isUpdateBusy(this.state?.state)) {
      this.openUpdateDialog({ manual: true });
      return;
    }

    this.pendingManualCheck = true;
    this.onStatus?.(t('WebMix.Updater.Checking', { fallback: 'Checking for updates...' }), 'info', 4000);
    const response = await checkForUpdates();
    if (!response?.ok && response?.error) {
      this.pendingManualCheck = false;
      await alert({
        title: t('Updater.Title', { fallback: 'New update available' }),
        text: t('WebMix.Updater.CheckFailed', response.error, {
          fallback: `Could not check for updates: ${response.error}`,
        }),
        icon: 'error',
        okLabel: t('OK', { fallback: 'OK' }),
      });
      return;
    }
    if (response && response.state && response.state !== 'checking') {
      this.handleState(response);
    }
  }

  /** Handle either an initial `/api/update` snapshot or a live SSE event. */
  handleState(next) {
    if (!next || typeof next !== 'object') return;
    this.state = next;
    this.#renderBadge();

    if (next.state === 'restarting') {
      if (!this.dialogView) this.openUpdateDialog({ manual: true });
      else this.dialogView.update(next);
      this.#beginRestartWatch(next.latestVersion);
      return;
    }

    if (this.pendingManualCheck) {
      if (next.state === 'checking') return;
      this.pendingManualCheck = false;

      if (next.state === 'up-to-date' || (!next.updateAvailable && next.state !== 'error')) {
        alert({
          title: t('Updater.NoUpdatesAvailable.Title', { fallback: 'No updates available' }),
          text: t('Updater.NoUpdatesAvailable.Text', { fallback: 'No updates are currently available' }),
          okLabel: t('OK', { fallback: 'OK' }),
        });
        return;
      }
      if (next.state === 'error') {
        alert({
          title: t('Updater.Title', { fallback: 'New update available' }),
          text: t('WebMix.Updater.CheckFailed', next.error || 'Unknown error', {
            fallback: `Could not check for updates: ${next.error || 'Unknown error'}`,
          }),
          icon: 'error',
          okLabel: t('OK', { fallback: 'OK' }),
        });
        return;
      }
      if (next.updateAvailable) {
        this.remindedVersions.delete(next.latestVersion);
        this.openUpdateDialog({ manual: true });
        return;
      }
    }

    if (this.dialogView) {
      this.dialogView.update(next);
      return;
    }

    if (shouldAutoOpenUpdateDialog(next, { remindedVersions: this.remindedVersions })) {
      /* Record immediately so duplicate SSE ticks do not open a second dialog,
       * and so closing via Escape/X acts as "Remind me Later" for this session. */
      if (next.latestVersion) this.remindedVersions.add(next.latestVersion);
      this.openUpdateDialog({ manual: Boolean(next.manualCheck) });
    }
  }

  /** Called when the SSE connection drops; if an install was finalizing, watch for restart. */
  onDisconnected() {
    if (this.state?.state === 'installing' || this.state?.state === 'restarting') {
      this.#beginRestartWatch(this.state?.latestVersion);
    }
  }

  openUpdateDialog({ manual = false } = {}) {
    if (!this.state) return;
    if (this.dialogView) {
      this.dialogView.setManual(manual);
      this.dialogView.update(this.state);
      return;
    }

    let isManual = manual;
    let renderedChangelog = null;
    let localError = '';

    const summaryEl = h('div.obs-update-summary', { raw: true });
    const changelogEl = h('div.obs-update-changelog.obs-scroll');

    const sudoInput = h('input.obs-input', {
      type: 'password',
      autocomplete: 'current-password',
      placeholder: t('WebMix.Updater.SudoPlaceholder', { fallback: 'sudo password' }),
      raw: true,
    });
    const sudoBox = h('div.obs-update-sudo', { hidden: true }, [
      h('label.obs-label', {
        text: t('WebMix.Updater.SudoPrompt', {
          fallback: 'Administrator password (sudo) is required to install the system package:',
        }),
        raw: true,
      }),
      sudoInput,
    ]);

    const progressFill = h('div.obs-update-progress-fill');
    const progressBar = h('div.obs-update-progress', { hidden: true }, [progressFill]);
    const statusText = h('div.obs-update-status-text.obs-hint', { hidden: true, raw: true });
    const errorBox = h('div.obs-error.obs-update-error', { hidden: true, raw: true });

    const skipBtn = h('button.obs-btn', {
      type: 'button',
      text: t('Updater.Skip', { fallback: 'Skip Version' }),
      raw: true,
      on: {
        click: async () => {
          const version = this.state?.latestVersion;
          if (!version) return;
          skipBtn.disabled = true;
          const res = await skipUpdateVersion(version);
          skipBtn.disabled = false;
          if (res?.ok) {
            dialog.setClosable(true);
            dialog.close('skip');
          } else if (res?.error) {
            localError = res.error;
            updateView(this.state);
          }
        },
      },
    });

    const remindBtn = h('button.obs-btn', {
      type: 'button',
      text: t('Updater.RemindMeLater', { fallback: 'Remind me Later' }),
      raw: true,
      on: {
        click: () => {
          if (this.state?.latestVersion) this.remindedVersions.add(this.state.latestVersion);
          dialog.close('remind');
        },
      },
    });

    const submitInstall = async () => {
      const current = this.state;
      if (!current) return;

      if (!current.canInstall) {
        const targetUrl = current.releaseUrl || 'https://github.com/fursyt12/WebMIX/releases/latest';
        window.open(targetUrl, '_blank', 'noopener');
        return;
      }

      const password = sudoInput.value;
      if (current.needsPassword && !password) {
        localError = 'sudo-password-required';
        updateView(current);
        sudoInput.focus();
        return;
      }

      const outputs = this.store?.state?.outputs;
      if (outputs?.streaming?.active || outputs?.recording?.active) {
        const proceed = await confirm({
          title: t('Updater.Title', { fallback: 'New update available' }),
          text: t('WebMix.Updater.ActiveOutputsConfirm', {
            fallback:
              'Streaming or recording is currently active. Updating will stop all outputs and restart WebMIX. Continue?',
          }),
          okLabel: t('Updater.UpdateNow', { fallback: 'Update Now' }),
          cancelLabel: t('Cancel', { fallback: 'Cancel' }),
          danger: true,
        });
        if (!proceed) return;
      }

      localError = '';
      updateBtn.disabled = true;
      let res = await installUpdate({ password, force: false });

      if (!res?.ok && res?.activeRemux > 0) {
        const proceedRemux = await confirm({
          title: t('Updater.Title', { fallback: 'New update available' }),
          text: t('WebMix.Updater.ActiveRemuxConfirm', {
            fallback:
              'A recording is currently being remuxed. Updating now will interrupt it and restart WebMIX. Continue?',
          }),
          okLabel: t('Updater.UpdateNow', { fallback: 'Update Now' }),
          cancelLabel: t('Cancel', { fallback: 'Cancel' }),
          danger: true,
        });
        if (!proceedRemux) {
          updateBtn.disabled = false;
          return;
        }
        res = await installUpdate({ password, force: true });
      }

      if (!res?.ok) {
        localError = res?.error || 'Update failed';
        updateView(res?.state ? res : this.state);
        if (localError === 'sudo-password-required' || localError === 'invalid-sudo-password') {
          sudoInput.select?.();
          sudoInput.focus();
        }
        return;
      }

      sudoInput.value = '';
      if (res?.state) this.handleState(res);
    };

    sudoInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitInstall();
      }
    });

    const updateBtn = h('button.obs-btn.primary', {
      type: 'button',
      text: t('Updater.UpdateNow', { fallback: 'Update Now' }),
      raw: true,
      on: { click: submitInstall },
    });

    const footerRow = h('div.obs-update-footer', {}, [
      h('div.obs-update-footer-left', {}, [skipBtn]),
      h('div.obs-update-footer-right', {}, [remindBtn, updateBtn]),
    ]);

    const dialog = openDialog({
      title: t('Updater.Title', { fallback: 'New update available' }),
      width: 640,
      closable: true,
      className: 'obs-update-dialog',
      body: [
        h('div.obs-update-intro', {
          text: t('Updater.Text', { fallback: 'There is a new update available:' }),
          raw: true,
        }),
        summaryEl,
        changelogEl,
        sudoBox,
        progressBar,
        statusText,
        errorBox,
      ],
      footer: footerRow,
      onClose: () => {
        if (this.state?.latestVersion) this.remindedVersions.add(this.state.latestVersion);
        this.dialogView = null;
      },
    });

    const updateView = (st) => {
      if (!st) return;
      const busy = this.waitingForRestart || isUpdateBusy(st.state);
      dialog.setClosable(!busy);

      setText(
        summaryEl,
        t('WebMix.Updater.VersionSummary', st.latestVersion || '?', st.currentVersion || '?', {
          fallback: `WebMIX ${st.latestVersion || '?'} is available (installed: ${st.currentVersion || '?'})`,
        })
      );

      if (st.changelog !== renderedChangelog) {
        renderedChangelog = st.changelog;
        renderChangelogDom(changelogEl, st.changelog || '');
      }

      sudoBox.hidden = !(st.canInstall && st.needsPassword) || busy;
      sudoInput.disabled = busy;

      const effectiveError = localError || st.error || '';
      if (effectiveError === 'invalid-sudo-password') {
        setText(errorBox, t('WebMix.Updater.SudoInvalid', { fallback: 'Wrong sudo password. Try again.' }));
        errorBox.hidden = false;
      } else if (effectiveError === 'sudo-password-required') {
        setText(
          errorBox,
          t('WebMix.Updater.SudoRequired', { fallback: 'Enter the sudo password to install the update.' })
        );
        errorBox.hidden = false;
      } else if (effectiveError && (st.state === 'error' || localError)) {
        setText(
          errorBox,
          t('WebMix.Updater.InstallFailed', effectiveError, { fallback: `Update failed: ${effectiveError}` })
        );
        errorBox.hidden = false;
      } else {
        errorBox.hidden = true;
      }

      if (this.waitingForRestart || st.state === 'restarting') {
        progressBar.hidden = false;
        progressBar.classList.add('is-indeterminate');
        progressFill.style.width = '100%';
        setText(
          statusText,
          t('WebMix.Updater.Restarting', { fallback: 'Restarting WebMIX and reconnecting...' })
        );
        statusText.hidden = false;
      } else if (st.state === 'installing') {
        progressBar.hidden = false;
        progressBar.classList.add('is-indeterminate');
        progressFill.style.width = '100%';
        setText(statusText, t('WebMix.Updater.Installing', { fallback: 'Installing update...' }));
        statusText.hidden = false;
      } else if (st.state === 'downloading') {
        const pct = Math.max(0, Math.min(100, Number(st.progress) || 0));
        progressBar.hidden = false;
        progressBar.classList.remove('is-indeterminate');
        progressFill.style.width = `${pct}%`;
        const sizeDetail =
          st.totalBytes > 0 ? ` — ${formatBytes(st.downloadedBytes)} / ${formatBytes(st.totalBytes)}` : '';
        setText(
          statusText,
          t('WebMix.Updater.Downloading', pct, { fallback: `Downloading update (${pct}%)...` }) + sizeDetail
        );
        statusText.hidden = false;
      } else if (st.state === 'available' && st.prefetching) {
        const pct = Math.max(0, Math.min(100, Number(st.progress) || 0));
        progressBar.hidden = false;
        progressBar.classList.remove('is-indeterminate');
        progressFill.style.width = `${pct}%`;
        setText(
          statusText,
          t('WebMix.Updater.Prefetching', pct, {
            fallback: `Pre-downloading update in the background (${pct}%)...`,
          })
        );
        statusText.hidden = false;
      } else if (st.state === 'ready' && st.readyToInstall) {
        progressBar.hidden = true;
        progressBar.classList.remove('is-indeterminate');
        setText(
          statusText,
          t('WebMix.Updater.Ready', {
            fallback: 'Update package downloaded and verified — ready to install.',
          })
        );
        statusText.hidden = false;
      } else if (!st.canInstall) {
        progressBar.hidden = true;
        setText(
          statusText,
          t('WebMix.Updater.ManualDownloadHint', {
            fallback:
              'Automatic installation is not available for this build. Download the new release manually from GitHub.',
          })
        );
        statusText.hidden = false;
      } else {
        progressBar.hidden = true;
        statusText.hidden = true;
      }

      skipBtn.hidden = isManual || !st.latestVersion || st.skippedVersion === st.latestVersion;
      skipBtn.disabled = busy;
      remindBtn.disabled = busy;
      updateBtn.disabled = busy;
      setText(
        updateBtn,
        st.canInstall
          ? t('Updater.UpdateNow', { fallback: 'Update Now' })
          : t('WebMix.Updater.OpenReleasePage', { fallback: 'Open Release Page' })
      );
    };

    this.dialogView = {
      dialog,
      setManual: (flag) => {
        isManual = Boolean(flag);
      },
      update: updateView,
    };
    updateView(this.state);
  }

  #renderBadge() {
    if (!this.badgeSlot) return;
    const st = this.state;
    const show =
      this.enabled &&
      Boolean(st?.updateAvailable && st?.latestVersion) &&
      (isUpdateBusy(st.state) || st.latestVersion !== st.skippedVersion);

    if (!show) {
      if (this.badgeButton) {
        this.badgeButton.remove();
        this.badgeButton = null;
      }
      return;
    }

    if (!this.badgeButton) {
      this.badgeButton = h('button.obs-menubar-update-badge', {
        type: 'button',
        raw: true,
        on: { click: () => this.openUpdateDialog({ manual: true }) },
      });
      this.badgeSlot.appendChild(this.badgeButton);
    }
    setText(
      this.badgeButton,
      t('WebMix.Updater.Badge', st.latestVersion, { fallback: `Update ${st.latestVersion}` })
    );
  }

  #beginRestartWatch(targetVersion) {
    if (this.waitingForRestart) return;
    this.waitingForRestart = true;
    if (this.dialogView && this.state) this.dialogView.update(this.state);

    const startedFromBootId = this.initialBootId;
    let sawServerDown = false;

    const poll = async () => {
      const info = await detectHost();
      if (!info.embedded) {
        sawServerDown = true;
        this.restartPollTimer = setTimeout(poll, 500);
        return;
      }

      const newInstanceUp =
        (startedFromBootId && info.bootId && info.bootId !== startedFromBootId) ||
        (!startedFromBootId && sawServerDown) ||
        (targetVersion && info.version === targetVersion && sawServerDown);

      if (!newInstanceUp) {
        this.restartPollTimer = setTimeout(poll, 500);
        return;
      }

      this.restartPollTimer = null;
      try {
        sessionStorage.setItem(UPDATED_TOAST_KEY, targetVersion || info.version || '');
      } catch {
        /* ignore */
      }
      this.reload();
    };

    this.restartPollTimer = setTimeout(poll, 450);
  }

  destroy() {
    if (this.restartPollTimer) {
      clearTimeout(this.restartPollTimer);
      this.restartPollTimer = null;
    }
    this.badgeButton?.remove();
    this.badgeButton = null;
  }
}
