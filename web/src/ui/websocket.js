/*
 * WebMIX - Tools > WebSocket Server Settings, and its Connect Info window.
 *
 * obs-websocket's own dialogs, drawn in the page with the plugin's own strings.
 * The server does not reimplement them: it drives the plugin's real (hidden)
 * dialog, so the checks, the saving and the server restart are the plugin's -
 * see frontend/webmix/WebMixWebSocket.hpp. What the plugin would ask in a
 * message box (a short password, a password of your own, connect info while
 * live) is asked here, in the same words, before anything is sent.
 */
import { h, clear } from '../dom.js';
import { t } from '../i18n.js';
import { openDialog, dialogButtons, alert, confirm } from './dialog.js';
import { fetchWebSocketSettings, applyWebSocketSettings, kickWebSocketSession } from '../bridge.js';

const PASSWORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A password the way obs-websocket generates one: random letters and digits. */
export function generatePassword(length = 16, random = (n) => crypto.getRandomValues(new Uint32Array(n))) {
  /* Reject the top of the range so every character is equally likely. */
  const limit = Math.floor(0x100000000 / PASSWORD_CHARS.length) * PASSWORD_CHARS.length;
  let out = '';
  while (out.length < length) {
    for (const value of random(length - out.length)) {
      if (value < limit) out += PASSWORD_CHARS[value % PASSWORD_CHARS.length];
    }
  }
  return out;
}

/** Copy a field's text; plain-HTTP pages (another computer) have no clipboard API. */
async function copyField(input) {
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    document.execCommand?.('copy');
  }
}

const checkbox = (label, title = null) => {
  const input = h('input.obs-checkbox', { type: 'checkbox' });
  return { input, row: h('label.obs-checkbox', { title, raw: true }, [input, h('span', { text: label, raw: true })]) };
};

const field = (label, control) =>
  h('div.obs-property-row', {}, [h('label.obs-label.obs-property-label', { text: label, raw: true }), control]);

export async function openWebSocketSettingsDialog({ onStatus } = {}) {
  let state = await fetchWebSocketSettings();
  if (!state) {
    onStatus?.('WebSocket Server Settings need the WebMIX server', 'warning');
    return;
  }
  if (!state.available) {
    await alert({ title: t('OBSWebSocket.Settings.DialogTitle'), text: t('WebMix.WebSocket.Unavailable'), icon: 'warning' });
    return;
  }

  const enabled = checkbox(t('OBSWebSocket.Settings.ServerEnable'));
  const alerts = checkbox(t('OBSWebSocket.Settings.AlertsEnable'));
  const debug = checkbox(t('OBSWebSocket.Settings.DebugEnable'), t('OBSWebSocket.Settings.DebugEnableHoverText'));
  const port = h('input.obs-input', { type: 'number', step: '1' });
  const auth = checkbox(t('OBSWebSocket.Settings.AuthRequired'));
  const password = h('input.obs-input', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
  const generate = h('button.obs-btn', {
    type: 'button',
    text: t('OBSWebSocket.Settings.GeneratePassword'),
    raw: true,
    on: {
      click: () => {
        password.value = generatePassword();
        password.select();
        passwordEdited = false;
      },
    },
  });
  const showInfo = h('button.obs-btn', {
    type: 'button',
    text: t('OBSWebSocket.Settings.ShowConnectInfo'),
    raw: true,
    on: { click: () => showConnectInfo() },
  });
  const sessions = h('tbody');

  /* The plugin only questions a password typed by hand, not a generated one. */
  let passwordEdited = false;
  password.addEventListener('input', () => {
    passwordEdited = true;
  });
  auth.input.addEventListener('change', syncAuth);

  function syncAuth() {
    const editable = auth.input.checked && !state.passwordLocked;
    password.disabled = !editable;
    generate.disabled = !editable;
  }

  function load() {
    enabled.input.checked = !!state.enabled;
    alerts.input.checked = !!state.alerts;
    debug.input.checked = !!state.debug;
    port.min = String(state.portMin ?? 1);
    port.max = String(state.portMax ?? 65534);
    port.value = String(state.port ?? 4455);
    port.disabled = !!state.portLocked;
    auth.input.checked = !!state.authRequired;
    auth.input.disabled = !!state.passwordLocked;
    password.value = state.password ?? '';
    passwordEdited = false;
    syncAuth();
    renderSessions(state.sessions);
  }

  function renderSessions(list = []) {
    clear(sessions);
    for (const session of list) {
      sessions.appendChild(
        h('tr', {}, [
          h('td', { text: session.address, raw: true }),
          h('td', { text: session.duration, raw: true }),
          h('td', { text: session.messages, raw: true }),
          h('td', { text: session.identified ? '✓' : '✕', raw: true, style: { textAlign: 'center' } }),
          h('td', { style: { textAlign: 'center' } }, [
            h('button.obs-btn', {
              type: 'button',
              text: t('OBSWebSocket.SessionTable.KickButtonText'),
              raw: true,
              on: {
                click: async () => {
                  const result = await kickWebSocketSession(session.address);
                  if (!result?.ok) onStatus?.(result?.error ?? 'Kick failed', 'error');
                  refreshSessions();
                },
              },
            }),
          ]),
        ])
      );
    }
  }

  async function refreshSessions() {
    const latest = await fetchWebSocketSettings();
    if (latest?.available) renderSessions(latest.sessions);
  }

  async function save() {
    const minimum = state.minPasswordLength ?? 6;
    if (password.value.length < minimum) {
      await alert({
        title: t('OBSWebSocket.Settings.Save.PasswordInvalidErrorTitle'),
        text: t('OBSWebSocket.Settings.Save.PasswordInvalidErrorMessage'),
        icon: 'error',
      });
      return false;
    }
    if (passwordEdited && password.value !== state.password) {
      const sure = await confirm({
        title: t('OBSWebSocket.Settings.Save.UserPasswordWarningTitle'),
        text: `${t('OBSWebSocket.Settings.Save.UserPasswordWarningMessage')}\n\n${t('OBSWebSocket.Settings.Save.UserPasswordWarningInfoText')}`,
        okLabel: t('Yes'),
        cancelLabel: t('No'),
      });
      if (!sure) {
        password.value = state.password ?? '';
        passwordEdited = false;
        return false;
      }
    }

    const min = Number(port.min);
    const max = Number(port.max);
    const result = await applyWebSocketSettings({
      enabled: enabled.input.checked,
      alerts: alerts.input.checked,
      debug: debug.input.checked,
      port: Math.min(max, Math.max(min, Math.round(Number(port.value) || min))),
      authRequired: auth.input.checked,
      password: password.value,
    });
    if (!result?.ok) {
      await alert({
        title: t('OBSWebSocket.Settings.Save.PasswordInvalidErrorTitle'),
        text: result?.error ?? 'The settings could not be applied',
        icon: 'error',
      });
      return false;
    }
    state = result;
    load();
    return true;
  }

  async function showConnectInfo() {
    const latest = await fetchWebSocketSettings({ connectInfo: true });
    if (!latest?.connect) return;
    if (latest.videoActive) {
      const sure = await confirm({
        title: t('OBSWebSocket.Settings.ShowConnectInfoWarningTitle'),
        text: `${t('OBSWebSocket.Settings.ShowConnectInfoWarningMessage')}\n\n${t('OBSWebSocket.Settings.ShowConnectInfoWarningInfoText')}`,
        okLabel: t('Yes'),
        cancelLabel: t('No'),
      });
      if (!sure) return;
    }
    openConnectInfoDialog(latest.connect);
  }

  /* The plugin refreshes its session table every second while it is open. */
  const timer = setInterval(refreshSessions, 1000);

  const dialog = openDialog({
    title: t('OBSWebSocket.Settings.DialogTitle'),
    width: 640,
    className: 'webmix-websocket-dialog',
    body: [
      h('div.obs-group-title', { text: t('OBSWebSocket.Settings.PluginSettingsTitle'), raw: true }),
      h('div.obs-settings-group', {}, [enabled.row, alerts.row, debug.row]),
      h('div.obs-group-title', { text: t('OBSWebSocket.Settings.ServerSettingsTitle'), raw: true }),
      h('div.obs-settings-group', {}, [
        field(t('OBSWebSocket.Settings.ServerPort'), port),
        auth.row,
        field(t('OBSWebSocket.Settings.Password'), h('div.webmix-password-row', {}, [password, generate])),
        h('div', {}, [showInfo]),
      ]),
      h('div.obs-group-title', { text: t('OBSWebSocket.SessionTable.Title'), raw: true }),
      h('table.obs-table.webmix-session-table', {}, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', { text: t('OBSWebSocket.SessionTable.RemoteAddressColumnTitle'), raw: true }),
            h('th', { text: t('OBSWebSocket.SessionTable.SessionDurationColumnTitle'), raw: true }),
            h('th', { text: t('OBSWebSocket.SessionTable.MessagesInOutColumnTitle'), raw: true }),
            h('th', { text: t('OBSWebSocket.SessionTable.IdentifiedTitle'), raw: true }),
            h('th', { text: t('OBSWebSocket.SessionTable.KickButtonColumnTitle'), raw: true }),
          ]),
        ]),
        sessions,
      ]),
    ],
    footer: dialogButtons([
      { label: 'OK', primary: true, action: async () => (await save()) && dialog.close() },
      { label: 'Cancel', action: () => dialog.close() },
      { label: 'Apply', action: () => save() },
    ]),
    onClose: () => clearInterval(timer),
  });

  load();
}

/** The plugin's Connect Info window: address, port, password and the QR code. */
export function openConnectInfoDialog(info) {
  const row = (label, value, copyable = true) => {
    const input = h('input.obs-input', { type: 'text', readonly: true, value: value ?? '' });
    return field(
      label,
      h('div.webmix-password-row', {}, [
        input,
        h('button.obs-btn', {
          type: 'button',
          text: t('OBSWebSocket.ConnectInfo.CopyText'),
          raw: true,
          disabled: !copyable,
          on: { click: () => copyField(input) },
        }),
      ])
    );
  };

  openDialog({
    title: t('OBSWebSocket.ConnectInfo.DialogTitle'),
    width: 460,
    body: [
      h('div.obs-settings-group', {}, [
        row(t('OBSWebSocket.ConnectInfo.ServerIp'), info.address),
        row(t('OBSWebSocket.ConnectInfo.ServerPort'), info.port),
        row(t('OBSWebSocket.ConnectInfo.ServerPassword'), info.password, info.passwordAvailable),
      ]),
      h('div.obs-group-title', { text: t('OBSWebSocket.ConnectInfo.QrTitle'), raw: true }),
      info.qr
        ? h('img.webmix-connect-qr', { src: info.qr, width: '236', height: '236', alt: info.url ?? '' })
        : h('div.obs-hint', { text: info.url ?? '', raw: true }),
    ],
  });
}
