#!/usr/bin/env node
/*
 * WebMIX static server.
 *
 * Serves the web frontend and exposes `/obs-config.json`, which the UI reads
 * to prefill the connection details from OBS's own obs-websocket config.
 *
 * No dependencies - run with:  node server.mjs [--port 8080] [--host 0.0.0.0]
 *
 * The web app talks to OBS directly over WebSocket (default port 4455), so
 * this server is only needed to deliver the files (and for `npm run dev`).
 */
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { obsWebSocketConfigPath, readObsWebSocketConfig } from './tools/obs-paths.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const PORT = Number(getArg('port', process.env.PORT ?? 8080));
const HOST = getArg('host', process.env.HOST ?? '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

async function serveFile(res, filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/obs-config.json') {
    const config = await readObsWebSocketConfig();
    if (!config) {
      sendJson(res, 200, { available: false, reason: 'obs-websocket config not found' });
      return;
    }
    sendJson(res, 200, {
      available: true,
      server_enabled: config.server_enabled !== false,
      server_port: config.server_port ?? 4455,
      server_password: config.server_password ?? '',
      auth_required: config.auth_required !== false,
      configPath: obsWebSocketConfigPath(),
    });
    return;
  }

  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, root: ROOT });
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(join(ROOT, normalized));
  if (!filePath.startsWith(resolve(ROOT) + sep) && filePath !== resolve(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  await serveFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  const config = obsWebSocketConfigPath();
  console.log(`WebMIX web UI:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
  console.log(`OBS websocket config read from: ${config}`);
  console.log('Open the page and connect to OBS (Tools > WebSocket Server Settings).');
});
