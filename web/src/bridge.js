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

export { notAvailable as bridgeUnavailable };
