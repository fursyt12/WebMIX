/*
 * Tests for host detection: the UI behaves differently when OBS serves it
 * itself (--web) than when it is served by an external static server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { detectHost, requestShutdown } from '../src/host.js';

/** Start a fake host; `handler` receives (req, res) and may return true when handled. */
async function startHost(handler) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!handler(req, res)) {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('detectHost recognises the embedded OBS server', async (t) => {
  let shutdownCalls = 0;
  const host = await startHost((req, res) => {
    if (req.url === '/api/status') {
      res.end(
        JSON.stringify({
          webmix: true,
          shutdownEndpoint: true,
          previewStream: true,
          propertySchema: true,
          version: '33.0.0',
          webRoot: '/opt/obs/web',
        })
      );
      return true;
    }
    if (req.url === '/api/shutdown' && req.method === 'POST') {
      shutdownCalls++;
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    return false;
  });
  t.after(() => host.close());

  const info = await detectHost(host.base);
  assert.equal(info.embedded, true);
  assert.equal(info.shutdown, true);
  assert.equal(info.version, '33.0.0');
  assert.equal(info.webRoot, '/opt/obs/web');
  assert.equal(info.previewStream, true);
  assert.equal(info.propertySchema, true);

  assert.equal(await requestShutdown(host.base), true);
  assert.equal(shutdownCalls, 1);
});

test('detectHost treats a plain static server as external', async (t) => {
  const host = await startHost((req, res) => {
    if (req.url === '/api/status') {
      res.statusCode = 404;
      res.end('Not found');
      return true;
    }
    return false;
  });
  t.after(() => host.close());

  const info = await detectHost(host.base);
  assert.equal(info.embedded, false);
  assert.equal(info.shutdown, false);
  assert.equal(await requestShutdown(host.base), false);
});

test('detectHost ignores a non-WebMIX status payload', async (t) => {
  const host = await startHost((req, res) => {
    if (req.url === '/api/status') {
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    return false;
  });
  t.after(() => host.close());

  const info = await detectHost(host.base);
  assert.equal(info.embedded, false);
});

test('detectHost and requestShutdown fail safe when nothing is listening', async () => {
  // Port 1 is not served by anything.
  const base = 'http://127.0.0.1:1/';
  assert.deepEqual(await detectHost(base), {
    embedded: false,
    shutdown: false,
    previewStream: false,
    propertySchema: false,
  });
  assert.equal(await requestShutdown(base), false);
});

test('requestShutdown reports failure when the host rejects it', async (t) => {
  const host = await startHost((req, res) => {
    if (req.url === '/api/shutdown') {
      res.statusCode = 500;
      res.end('{}');
      return true;
    }
    return false;
  });
  t.after(() => host.close());
  assert.equal(await requestShutdown(host.base), false);
});
