/*
 * WebMIX - the sign-in page.
 *
 * Browsers on the computer running OBS never see this. Every other browser is
 * sent here by the server until it signs in with the login set in Tools > Web
 * Interface Access, and comes back to where it was going (`?next=`, relative
 * to the interface's root) once it has.
 *
 * Until it has signed in, the server gives such a browser nothing but this
 * page, i18n.js, the theme and OBS's strings - so this module imports nothing
 * else.
 */
import { currentLocale, loadLocale, t } from './i18n.js';

/**
 * The address to return to: `next` resolved against the page, and only ever
 * one on this same origin (anything else - another host, a protocol-relative
 * `//evil`, a `javascript:` URL - falls back to the interface itself).
 */
export function resolveNext(next, href) {
  const home = new URL('./', href);
  if (!next) return home.href;
  try {
    const target = new URL(next, home);
    return target.origin === home.origin && (target.protocol === 'http:' || target.protocol === 'https:')
      ? target.href
      : home.href;
  } catch {
    return home.href;
  }
}

/** The message for a refused sign-in, from the server's answer. */
export function loginError(result, status) {
  if (result?.error === 'throttled') return t('WebMix.Login.Throttled', result.retryAfter ?? 30);
  if (result?.error === 'not-configured') return t('WebMix.Login.NotConfigured');
  if (result?.error === 'invalid') {
    /* The attempt that triggered a lockout says so straight away. */
    return result.retryAfter ? t('WebMix.Login.Throttled', result.retryAfter) : t('WebMix.Login.Invalid');
  }
  return status ? `${t('WebMix.Login.Failed')} (${status})` : t('WebMix.Login.Failed');
}

async function fetchStatus() {
  const response = await fetch('api/auth/status', { cache: 'no-store' });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

/** Wire up login.html. */
export async function mountLogin(doc = document) {
  const form = doc.querySelector('#login-form');
  const user = doc.querySelector('#login-user');
  const password = doc.querySelector('#login-password');
  const submit = doc.querySelector('#login-submit');
  const message = doc.querySelector('#login-message');
  const next = resolveNext(new URLSearchParams(location.search).get('next'), location.href);

  const say = (text, kind = 'error') => {
    message.textContent = text;
    message.hidden = !text;
    message.classList.toggle('is-error', kind === 'error');
  };

  if (await loadLocale()) {
    doc.documentElement.lang = currentLocale().split('-')[0];
  }
  doc.title = `${t('WebMix.Login.Title')} - WebMIX`;
  for (const node of doc.querySelectorAll('[data-key]')) node.textContent = t(node.dataset.key);

  let status = null;
  try {
    status = await fetchStatus();
  } catch {
    say(t('WebMix.Login.Failed'));
  }
  if (status?.authorized) {
    location.replace(next);
    return;
  }
  if (status && !status.configured) {
    say(t('WebMix.Login.NotConfigured'), 'info');
    for (const input of [user, password, submit]) input.disabled = true;
  }
  form.hidden = false;
  (status?.configured ? user : submit).focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!user.value || !password.value) return;
    submit.disabled = true;
    say('');
    try {
      const response = await fetch('api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.value, password: password.value }),
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.ok) {
        location.replace(next);
        return;
      }
      say(loginError(result, response.status));
      password.value = '';
      password.focus();
    } catch {
      say(t('WebMix.Login.Failed'));
    } finally {
      submit.disabled = false;
    }
  });
}
