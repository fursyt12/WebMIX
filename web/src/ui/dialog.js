/*
 * WebMIX - modal dialogs, message boxes and context menus.
 *
 * Mirrors the Qt dialogs OBS uses (QDialog + QMessageBox) with the theme's
 * window background, 1px borders and modal backdrop.
 */
import { h, clear, qs, trapFocus, qsa } from '../dom.js';

const modalRoot = () => qs('#modal-root');
const menuRoot = () => qs('#menu-root');

let openDialogs = [];

/**
 * Open a modal dialog.
 * @param {object} options
 * @param {string} options.title
 * @param {Node|Node[]} options.body
 * @param {Node|Node[]} [options.footer]
 * @param {number} [options.width]
 * @param {boolean} [options.closable]
 * @param {(reason: string) => void} [options.onClose]
 * @returns {{el: HTMLElement, close: (reason?: string) => void, body: HTMLElement, footer: HTMLElement}}
 */
export function openDialog({ title, body, footer, width = 520, height = null, closable = true, onClose, className = '' }) {
  const backdrop = h('div.obs-modal-backdrop');
  const dialog = h(`div.obs-dialog${className ? `.${className}` : ''}`, {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': typeof title === 'string' ? title : 'Dialog',
    tabindex: '-1',
  });
  if (width) dialog.style.width = `${width}px`;
  if (height) dialog.style.height = `${height}px`;

  const titleBar = h('div.obs-dialog-title', { text: title });
  const closeBtn = closable
    ? h('button.obs-icon-btn.obs-dialog-close', {
        type: 'button',
        'aria-label': 'Close',
        title: 'Close',
        text: '\u2715',
        on: { click: () => close('close') },
      })
    : null;
  if (closeBtn) titleBar.appendChild(closeBtn);

  const bodyEl = h('div.obs-dialog-body.obs-scroll');
  if (body) bodyEl.append(...(Array.isArray(body) ? body : [body]));

  const footerEl = h('div.obs-dialog-footer');
  if (footer) footerEl.append(...(Array.isArray(footer) ? footer : [footer]));

  dialog.append(titleBar, bodyEl);
  if (footer) dialog.appendChild(footerEl);
  backdrop.appendChild(dialog);
  modalRoot().appendChild(backdrop);

  const releaseFocus = trapFocus(dialog);
  const previousFocus = document.activeElement;

  const onBackdropDown = (event) => {
    if (event.target === backdrop && closable) close('backdrop');
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && closable) {
      event.stopPropagation();
      close('escape');
    }
  };
  backdrop.addEventListener('pointerdown', onBackdropDown);
  dialog.addEventListener('keydown', onKey);

  let closed = false;
  function close(reason = 'close') {
    if (closed) return;
    closed = true;
    releaseFocus();
    backdrop.remove();
    openDialogs = openDialogs.filter((d) => d !== close);
    previousFocus?.focus?.();
    onClose?.(reason);
  }

  openDialogs.push(close);
  const focusTarget = dialog.querySelector('input, select, textarea, button:not(.obs-dialog-close)') ?? dialog;
  setTimeout(() => focusTarget.focus?.(), 0);

  return { el: dialog, body: bodyEl, footer: footerEl, close };
}

/** Close the top-most dialog (used by the Escape handler). */
export function closeTopDialog() {
  openDialogs.at(-1)?.('escape');
}

/** Build a button row for a dialog footer. */
export function dialogButtons(buttons) {
  const row = h('div.obs-dialog-buttons');
  for (const { label, action, primary, danger, autofocus } of buttons) {
    row.appendChild(
      h(`button.obs-btn${primary ? '.primary' : ''}${danger ? '.danger' : ''}`, {
        type: 'button',
        text: label,
        autofocus: autofocus || undefined,
        on: { click: action },
      })
    );
  }
  return row;
}

/** QMessageBox-style confirmation. Resolves true/false. */
export function confirm({ title = 'Confirm', text = '', okLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const dialog = openDialog({
      title,
      width: 420,
      body: h('div.obs-message-text', { text }),
      footer: dialogButtons([
        { label: cancelLabel, action: () => dialog.close(), autofocus: true },
        { label: okLabel, primary: !danger, danger, action: () => { result = true; dialog.close(); } },
      ]),
      onClose: () => resolve(result),
    });
  });
}

/** QMessageBox-style information/error box. */
export function alert({ title = 'WebMIX', text = '', icon = 'info', okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const dialog = openDialog({
      title,
      width: 440,
      body: h('div.obs-message-row', {}, [
        h(`span.obs-message-icon.is-${icon}`, { text: icon === 'error' ? '\u26a0' : icon === 'warning' ? '\u26a0' : '\u2139' }),
        h('div.obs-message-text', { text }),
      ]),
      footer: dialogButtons([{ label: okLabel, primary: true, action: () => dialog.close(), autofocus: true }]),
      onClose: () => resolve(),
    });
  });
}

/** Single-line text prompt. Resolves the string or null when cancelled. */
export function prompt({
  title = 'WebMIX',
  label = '',
  value = '',
  okLabel = 'OK',
  cancelLabel = 'Cancel',
  placeholder = '',
  validate = null,
} = {}) {
  return new Promise((resolve) => {
    const input = h('input.obs-input', { type: 'text', value, placeholder, style: { width: '100%' } });
    const error = h('div.obs-error.obs-hint', { hidden: true });
    const ok = h('button.obs-btn.primary', {
      type: 'button',
      text: okLabel,
      on: { click: submit },
    });

    function submit() {
      const current = input.value.trim();
      const problem = validate ? validate(current) : current ? null : 'A value is required.';
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        input.focus();
        return;
      }
      // Resolve before closing: openDialog()'s onClose resolves null, and a
      // settled promise ignores the later value, so closing first would make
      // every prompt() return null.
      resolve(current);
      dialog.close('ok');
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    const dialog = openDialog({
      title,
      width: 420,
      body: [label ? h('label.obs-label', { text: label }) : null, input, error],
      footer: dialogButtons([
        { label: cancelLabel, action: () => dialog.close() },
        { label: okLabel, primary: true, action: () => submit() },
      ]),
      onClose: () => resolve(null),
    });
    setTimeout(() => input.focus(), 0);
  });
}

/**
 * Show a context menu at viewport coordinates.
 * @param {{x: number, y: number}} position
 * @param {Array<object>} items  { label, action, checked, disabled } or { separator: true }
 * @returns {() => void} close function
 */
export function showContextMenu(position, items) {
  closeContextMenu();
  const menu = h('div.obs-menu.obs-context-menu', { role: 'menu' });
  for (const item of items) {
    if (!item || item.separator || item.type === 'separator') {
      menu.appendChild(h('div.obs-menu-sep', { role: 'separator' }));
      continue;
    }
    if (item.hidden) continue;
    const checkable = item.checked !== undefined || item.type === 'check';
    const row = h('button.obs-menu-item', {
      type: 'button',
      role: checkable ? 'menuitemcheckbox' : 'menuitem',
      'aria-checked': checkable ? String(!!item.checked) : null,
      disabled: !!item.disabled,
      on: {
        click: () => {
          closeContextMenu();
          item.action?.();
        },
      },
    });
    if (checkable) row.appendChild(h('span.obs-menu-check', { text: item.checked ? '\u2713' : '' }));
    row.appendChild(h('span.obs-menu-label', { text: item.label }));
    if (item.shortcut) row.appendChild(h('span.obs-menu-shortcut', { text: item.shortcut }));
    menu.appendChild(row);
  }

  menuRoot().appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const x = Math.min(position.x, window.innerWidth - rect.width - 4);
  const y = Math.min(position.y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;

  const onDown = (event) => {
    if (!menu.contains(event.target)) closeContextMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') closeContextMenu();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
  }, 0);

  activeContextMenu = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    menu.remove();
    activeContextMenu = null;
  };
  return activeContextMenu;
}

let activeContextMenu = null;

export function closeContextMenu() {
  activeContextMenu?.();
}
