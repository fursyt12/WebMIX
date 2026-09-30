/*
 * WebMIX - locates OBS's obs-websocket configuration file.
 *
 * Shared by server.mjs (to prefill the connect form) and
 * tools/enable-websocket.mjs (to enable the server).  Kept in its own module so
 * importing it never starts the HTTP server.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/** Platform config directory holding obs-websocket's config.json. */
export function obsWebSocketConfigPath() {
  const os = platform();
  if (os === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
  }
  if (os === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'obs-studio',
      'plugin_config',
      'obs-websocket',
      'config.json'
    );
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
}

/** Read obs-websocket's config, or null when it does not exist yet. */
export async function readObsWebSocketConfig() {
  try {
    return JSON.parse(await readFile(obsWebSocketConfigPath(), 'utf8'));
  } catch {
    return null;
  }
}
