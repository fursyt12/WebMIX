#!/usr/bin/env node
/*
 * Enable OBS's built-in WebSocket server.
 *
 * WebMIX needs obs-websocket to be enabled (it ships with OBS but is off by
 * default).  This helper flips `server_enabled` to true in the existing config
 * so the user does not have to click through Tools > WebSocket Server Settings.
 *
 * OBS must be restarted for the change to take effect.
 *
 * Usage:  node tools/enable-websocket.mjs [--port 4455] [--password <pw>] [--disable]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { obsWebSocketConfigPath } from './obs-paths.mjs';

const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
};

const path = obsWebSocketConfigPath();
const port = Number(getArg('port') ?? 4455);
const password = getArg('password');
const disable = args.includes('--disable');

let config = {};
try {
  config = JSON.parse(await readFile(path, 'utf8'));
  console.log(`Read ${path}`);
} catch {
  console.log(`No existing config at ${path}; creating one.`);
}

config.server_enabled = !disable;
config.server_port = port;
if (password !== null) config.server_password = password;
config.auth_required ??= true;
config.alerts_enabled ??= false;
config.first_load ??= false;

await mkdir(dirname(path), { recursive: true });
await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log(
  disable
    ? 'obs-websocket server disabled.'
    : `obs-websocket server enabled on port ${port} (auth required: ${config.auth_required}).`
);
if (!disable && !config.server_password) {
  console.log('WARNING: no password is set. Set one in OBS > Tools > WebSocket Server Settings.');
}
console.log('Restart OBS for the change to take effect.');
