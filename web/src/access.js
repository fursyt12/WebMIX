/*
 * WebMIX - sign-in, from inside the interface.
 *
 * Browsers on the computer running OBS are trusted; any other browser signs in
 * on login.html with the one login set in Tools > Web Interface Access. This
 * module is the interface's half of that: the dialog's requests, and the
 * guard that sends the page back to the sign-in form when the server stops
 * accepting its session (OBS restarted, the login changed, or it expired).
 *
 *   GET  api/auth/config   {configured, username, sessions, minPasswordLength,
 *                           local, user, network, port}
 *   POST api/auth/config   {username, password} | {remove: true}
 *                          -> the same, plus {ok, error}
 *   POST api/auth/logout
 */

/** The sign-in form, told to come back to this page (relative to the root). */
export function signInUrl(loc = globalThis.location) {
  return `login.html?next=${encodeURIComponent(`./${loc.search}${loc.hash}`)}`;
}

function isOwnUrl(input, loc) {
  try {
    const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)), loc.href);
    return url.origin === loc.origin;
  } catch {
    return false;
  }
}

/**
 * Leave for the sign-in form the first time one of this page's own requests
 * is answered 401. Every request the interface makes - the control channel,
 * the event stream, the bridge, the preview - goes through fetch(), so this is
 * the one place that has to know.
 */
export function installSignInGuard(win = globalThis) {
  if (typeof win.fetch !== 'function' || win.fetch.webmixSignInGuard) return;
  const original = win.fetch.bind(win);
  let leaving = false;
  const guarded = async (input, init) => {
    const response = await original(input, init);
    if (response.status === 401 && !leaving && isOwnUrl(input, win.location)) {
      leaving = true;
      win.location.replace(signInUrl(win.location));
    }
    return response;
  };
  guarded.webmixSignInGuard = true;
  win.fetch = guarded;
}

async function request(path, body) {
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { ...(data ?? {}), ok: false, error: data?.error ?? `request failed (${response.status})` };
    return { ok: true, ...(data ?? {}) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** Who may get in, and who this browser is; `ok: false` without the server. */
export function fetchAccess() {
  return request('api/auth/config');
}

/** Set (or replace) the login. Every other signed-in browser is signed out. */
export function saveAccess(username, password) {
  return request('api/auth/config', { username, password });
}

/** Remove the login (only from the computer running OBS). */
export function removeAccess() {
  return request('api/auth/config', { remove: true });
}

/** End this browser's session and go back to the sign-in form. */
export async function signOut(loc = globalThis.location) {
  await request('api/auth/logout', {});
  loc.replace('login.html');
}
