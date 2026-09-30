/*
 * WebMIX - host detection.
 *
 * The frontend can be served either by an external static server
 * (`node server.mjs`) or by OBS itself in `--web` mode.  The embedded server
 * exposes /api/status and /api/shutdown, which lets the UI offer something the
 * desktop build cannot do over obs-websocket alone: shutting OBS down.
 */

const STATUS_PATH = 'api/status';
const SHUTDOWN_PATH = 'api/shutdown';

/**
 * Probe the host.
 * @param {string} [base] absolute base URL, e.g. 'http://127.0.0.1:4456/';
 *                        defaults to the page origin (relative fetch)
 * @returns {Promise<{embedded: boolean, shutdown: boolean, previewStream: boolean,
 *                    propertySchema: boolean, remux: boolean, version?: string, webRoot?: string}>}
 */
export async function detectHost(base = '') {
  try {
    const response = await fetch(base + STATUS_PATH, { cache: 'no-store' });
    if (!response.ok) return { embedded: false, shutdown: false, previewStream: false, propertySchema: false, remux: false };
    const data = await response.json();
    if (!data || data.webmix !== true) {
      return { embedded: false, shutdown: false, previewStream: false, propertySchema: false, remux: false };
    }
    return {
      embedded: true,
      shutdown: data.shutdownEndpoint === true,
      // The embedded server can stream preview frames (WebGPU path), expose
      // the property schema and remux recordings; without these flags the UI
      // stays on the obs-websocket-only code paths.
      previewStream: data.previewStream === true,
      propertySchema: data.propertySchema === true,
      remux: data.remux === true,
      version: data.version,
      webRoot: data.webRoot,
    };
  } catch {
    // Not served by OBS, or the request failed: the plain static server does
    // not implement these endpoints.
    return { embedded: false, shutdown: false, previewStream: false, propertySchema: false, remux: false };
  }
}

/**
 * Ask OBS to shut down. Only works when served by OBS itself.
 * @param {string} [base]
 * @param {boolean} [force] shut down even while a remux is running
 * @returns {Promise<boolean>} whether the request was accepted
 */
export async function requestShutdown(base = '', force = false) {
  try {
    const response = await fetch(base + SHUTDOWN_PATH + (force ? '?force=1' : ''), {
      method: 'POST',
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}
