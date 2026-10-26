/*
 * WebMIX - Tools > Web Interface Access.
 *
 * WebMIX's own dialog (the desktop window has nothing like it): the one login
 * that browsers on other computers sign in with. Browsers on the computer
 * running OBS never need it. See src/access.js and
 * frontend/webmix/WebMixAuth.hpp.
 */
import { h, clear } from '../dom.js';
import { t } from '../i18n.js';
import { openDialog, dialogButtons, confirm } from './dialog.js';
import { fetchAccess, saveAccess, removeAccess, signOut } from '../access.js';

export async function openAccessDialog({ onStatus } = {}) {
  const dialog = openDialog({
    title: t('WebMix.Access.Title'),
    width: 540,
    body: h('div.obs-empty', { text: 'Loading...' }),
  });

  const user = h('input.obs-input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
  const password = h('input.obs-input', { type: 'password', autocomplete: 'new-password' });
  const repeat = h('input.obs-input', { type: 'password', autocomplete: 'new-password' });
  const message = h('div.obs-hint', { role: 'alert', hidden: true });
  for (const input of [user, password, repeat]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save();
      }
    });
  }

  let state = await fetchAccess();

  function say(text, kind = 'error') {
    message.textContent = text ?? '';
    message.hidden = !text;
    message.classList.toggle('obs-error', kind === 'error');
  }

  const field = (label, control) =>
    h('div.obs-property-row', {}, [h('label.obs-label.obs-property-label', { text: label, raw: true }), control]);

  function render() {
    clear(dialog.body);
    clear(dialog.footer);
    if (state.configured === undefined) {
      dialog.body.append(h('div.obs-error', { text: state.error ?? 'The web interface server is not available', raw: true }));
      dialog.footer.append(dialogButtons([{ label: 'Close', primary: true, action: () => dialog.close() }]));
      return;
    }

    user.value = state.username ?? '';
    password.value = '';
    repeat.value = '';

    const lines = [
      t('WebMix.Access.Intro'),
      state.network ? t('WebMix.Access.Network', state.port) : t('WebMix.Access.LocalOnly'),
      state.configured ? t('WebMix.Access.Configured', state.username) : t('WebMix.Access.NotConfigured'),
    ];
    if (state.configured) lines.push(t('WebMix.Access.Sessions', state.sessions ?? 0));
    if (!state.local && state.user) lines.push(t('WebMix.Access.SignedInAs', state.user));

    dialog.body.append(
      ...lines.map((text) => h('div.obs-message-text', { text, raw: true })),
      state.network ? h('div.obs-hint', { text: t('WebMix.Access.Unencrypted'), raw: true }) : null,
      h('div.obs-settings-group', {}, [
        field(t('WebMix.Access.Username'), user),
        field(t('WebMix.Access.Password'), password),
        field(t('WebMix.Access.ConfirmPassword'), repeat),
      ]),
      message
    );

    const buttons = [];
    if (state.configured) {
      buttons.push({ label: t('WebMix.Access.Remove'), danger: true, action: remove });
    }
    if (!state.local && state.user) {
      buttons.push({ label: t('WebMix.Access.SignOut'), action: () => signOut() });
    }
    buttons.push(
      { label: 'Close', action: () => dialog.close() },
      { label: t('WebMix.Access.Save'), primary: true, action: save }
    );
    dialog.footer.append(dialogButtons(buttons));
  }

  async function save() {
    const name = user.value.trim();
    const minimum = state.minPasswordLength ?? 8;
    if (!name) {
      say(t('WebMix.Access.UsernameEmpty'));
      user.focus();
      return;
    }
    if (password.value.length < minimum) {
      say(t('WebMix.Access.PasswordTooShort', minimum));
      password.focus();
      return;
    }
    if (password.value !== repeat.value) {
      say(t('WebMix.Access.PasswordMismatch'));
      repeat.focus();
      return;
    }
    const result = await saveAccess(name, password.value);
    if (!result.ok) {
      say(result.error);
      return;
    }
    state = result;
    render();
    say(t('WebMix.Access.Saved'), 'info');
    onStatus?.(t('WebMix.Access.Saved'), 'info');
  }

  async function remove() {
    if (!state.local) {
      say(t('WebMix.Access.RemoteRemove'));
      return;
    }
    const sure = await confirm({
      title: t('WebMix.Access.Remove'),
      text: t('WebMix.Access.RemoveConfirm'),
      okLabel: t('WebMix.Access.Remove'),
      danger: true,
    });
    if (!sure) return;
    const result = await removeAccess();
    if (!result.ok) {
      say(result.error === 'remote-remove' ? t('WebMix.Access.RemoteRemove') : result.error);
      return;
    }
    state = result;
    render();
    say(t('WebMix.Access.Removed'), 'info');
    onStatus?.(t('WebMix.Access.Removed'), 'info');
  }

  render();
  (state.configured ? password : user).focus();
}
