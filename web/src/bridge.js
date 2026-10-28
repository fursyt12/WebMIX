/*
 * WebMIX - client for bridge operations.
 *
 * These are the handful of things obs-websocket has no request for at all:
 * reordering scenes, managing transition instances and rebinding hotkeys. The
 * embedded server (only present when OBS serves the UI) exposes them; callers
 * get `null`/`false` when the bridge is unavailable so they can fall back to
 * explaining the limitation instead of failing.
 */

async function get(path) {
  try {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function post(path) {
  try {
    const response = await fetch(path, { method: 'POST' });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      // Keep whatever else the endpoint reported (a remux conflict carries the
      // target path, a refused start carries the queue state).
      return { ...(data ?? {}), ok: false, error: data?.error ?? `request failed (${response.status})` };
    }
    return data ?? { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

async function postJson(path, body) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ...(data ?? {}), ok: false, error: data?.error ?? `request failed (${response.status})` };
    }
    return data ?? { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

const notAvailable = { ok: false, error: 'the WebMIX bridge is not available (OBS is not serving this page)' };

/* ------------------------------------------------------------------ scenes */

/** Move a scene; indices are display order (0 = top), like the desktop list. */
export async function moveScene(fromIndex, toIndex) {
  return post(`api/scenes/move?from=${fromIndex}&to=${toIndex}`);
}

/* ------------------------------------------------------------- transitions */

export async function addTransition(kind, name) {
  return post(`api/transitions/add?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`);
}

export async function renameTransition(name, newName) {
  return post(`api/transitions/rename?name=${encodeURIComponent(name)}&newName=${encodeURIComponent(newName)}`);
}

export async function removeTransition(name) {
  return post(`api/transitions/remove?name=${encodeURIComponent(name)}`);
}

/* ----------------------------------------------------------------- outputs */

/** Encoder choices OBS offers, with localised names; null without the bridge. */
export async function fetchEncoderOptions() {
  const data = await get('api/encoders');
  return data && Array.isArray(data.videoStreaming) ? data : null;
}

/* ----------------------------------------------------------------- hotkeys */

/** Every hotkey with the bindings OBS itself reports, or null without the bridge. */
export async function fetchHotkeys() {
  const data = await get('api/hotkeys');
  return Array.isArray(data?.hotkeys) ? data.hotkeys : null;
}

/** Bind one key combination in OBS (ob-websocket cannot do this). */
export async function bindHotkey(name, keyName, modifiers = []) {
  if (!keyName) return notAvailable;
  const query = `name=${encodeURIComponent(name)}&key=${encodeURIComponent(keyName)}&modifiers=${encodeURIComponent(modifiers.join(','))}`;
  return post(`api/hotkeys/bind?${query}`);
}

export async function clearHotkey(name) {
  return post(`api/hotkeys/clear?name=${encodeURIComponent(name)}`);
}

/* ------------------------------------------------------------------- remux */

/**
 * The remux queue as OBS sees it:
 * `{ jobs: [{id, source, target, format, state, error}], processing, progress,
 *    canClearFinished, activeCount }`, or null without the bridge.
 */
export async function fetchRemuxState() {
  const data = await get('api/remux');
  return data && Array.isArray(data.jobs) ? data : null;
}

/**
 * Queue one recording. `relativePath` is relative to the recordings directory.
 * Resolves `{ok: false, conflict: true, target}` when the target exists and
 * `overwrite` is false, so the caller can ask before replacing the file.
 */
export async function addRemux(relativePath, format = 'mp4', overwrite = false) {
  const query = `path=${encodeURIComponent(relativePath)}&format=${encodeURIComponent(format)}&overwrite=${overwrite ? 1 : 0}`;
  return post(`api/remux/add?${query}`);
}

export async function startRemux() {
  return post('api/remux/start');
}

export async function stopRemux() {
  return post('api/remux/stop');
}

export async function clearFinishedRemux() {
  return post('api/remux/clear');
}

export async function clearAllRemux() {
  return post('api/remux/clearall');
}

/* ----------------------------------------------------------------- startup */

/**
 * Settings > General, how OBS starts: `{autostart, autostartSupported,
 * openBrowser, address}` (address is where a sign-in start will serve), or
 * null without the bridge.
 */
export async function fetchStartupSettings() {
  return get('api/startup');
}

/** Change any of `autostart` and `openBrowser`; resolves the new state. */
export async function saveStartupSettings(settings) {
  return postJson('api/startup', settings);
}

/* ----------------------------------------------------------- obs-websocket */

/**
 * Tools > WebSocket Server Settings, as obs-websocket's own dialog would show
 * them: `{available, enabled, alerts, debug, port, portMin, portMax,
 * portLocked, authRequired, password, passwordLocked, minPasswordLength,
 * videoActive, sessions: [{address, duration, messages, identified}]}`, plus
 * `connect: {address, port, password, passwordAvailable, url, qr}` when asked
 * for the Connect Info. Null without the bridge.
 */
export async function fetchWebSocketSettings({ connectInfo = false } = {}) {
  return get(`api/websocket${connectInfo ? '?connect=1' : ''}`);
}

/** Apply settings through the plugin's own Apply; resolves the new state. */
export async function applyWebSocketSettings(settings) {
  return postJson('api/websocket', settings);
}

/** Disconnect one session, by its remote address. */
export async function kickWebSocketSession(address) {
  return postJson('api/websocket/kick', { address });
}

/* ---------------------------------------------------------- plugin windows */

/**
 * The Tools menu entries plugins added, in menu order: `{items: [{id, text,
 * enabled, checkable, checked, replacement?, items?}], pluginManager}`, or null
 * without the bridge.
 */
export async function fetchPluginTools() {
  return get('api/plugins/tools');
}

/** The mirrored windows a page has open: `{ok, session, open, windows}`. */
export async function fetchPluginWindows(session) {
  return get(`api/plugins/windows?session=${encodeURIComponent(session)}`);
}

/** Trigger a Tools entry; resolves once its window is shown (`opened: false` if none was). */
export async function triggerPluginTool(id, session) {
  return postJson('api/plugins/trigger', { id, session });
}

/** Do to a mirrored window's widget what a person would: `{session, window, widget, action, value}`. */
export async function actOnPluginWindow(request) {
  return postJson('api/plugins/act', request);
}

export { notAvailable as bridgeUnavailable };
