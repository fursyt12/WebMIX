/*
 * A stand-in for OBS's native control service.
 *
 * It implements the same four endpoints the embedded server exposes
 * (`/api/obs/requests`, `/api/obs/request`, `/api/obs/batch`, `/api/obs/events`),
 * so the client is exercised against a faithful peer instead of stubs - the
 * same idea as `mock-obs.mjs` for the websocket transport.
 */
import { createServer } from 'node:http';

/** Request types the mock implements unless a test overrides them. */
const DEFAULT_HANDLERS = {
  GetVersion: () => ({
    obsVersion: '33.0.0',
    obsWebSocketVersion: null,
    rpcVersion: 1,
    platform: 'linux',
    platformDescription: 'Linux',
  }),
  GetSceneList: () => ({
    currentProgramSceneName: 'Scene',
    currentPreviewSceneName: null,
    scenes: [{ sceneName: 'Scene', sceneUuid: 'uuid-scene', sceneIndex: 0 }],
  }),
  SetCurrentProgramScene: () => ({}),
};

/**
 * @param {object} [options]
 * @param {Record<string, (data: object) => object>} [options.handlers]
 *        extra/overriding handlers; return `{error: {code, comment}}` to fail
 * @param {boolean} [options.serveEvents] whether to expose the SSE endpoint
 * @returns {Promise<object>} the mock server handle
 */
export async function startNativeObs({ handlers = {}, serveEvents = true } = {}) {
  const table = { ...DEFAULT_HANDLERS, ...handlers };
  const calls = [];
  const streams = new Set();

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/api/obs/requests' && req.method === 'GET') {
      sendJson(res, 200, { requests: Object.keys(table) });
      return;
    }

    if (path === '/api/obs/events' && req.method === 'GET') {
      if (!serveEvents) {
        sendJson(res, 404, { error: 'no event stream here' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': ready\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    if (path === '/api/obs/request' && req.method === 'POST') {
      readJson(req, (body) => {
        calls.push({ requestType: body.requestType, requestData: body.requestData ?? {} });
        sendJson(res, 200, runOne(body.requestType, body.requestData ?? {}, table));
      });
      return;
    }

    if (path === '/api/obs/batch' && req.method === 'POST') {
      readJson(req, (body) => {
        const results = (body.requests ?? []).map((entry) => {
          calls.push({ requestType: entry.requestType, requestData: entry.requestData ?? {}, batch: true });
          const payload = runOne(entry.requestType, entry.requestData ?? {}, table);
          return {
            requestType: entry.requestType,
            requestStatus: payload.requestStatus,
            responseData: payload.responseData,
          };
        });
        sendJson(res, 200, { results });
      });
      return;
    }

    // Anything else looks like the static host: it answers with the SPA shell,
    // which is exactly what a native client must refuse to mistake for a peer.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>WebMIX</title>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    base: `http://127.0.0.1:${port}/`,
    calls,
    /** Push one event to every open stream. */
    emit(eventType, eventData = {}, eventIntent = 1) {
      const frame = `data: ${JSON.stringify({ eventType, eventIntent, eventData })}\n\n`;
      for (const stream of streams) stream.write(frame);
    },
    /** Write an arbitrary SSE frame, for the malformed-input tests. */
    raw(frame) {
      for (const stream of streams) stream.write(frame);
    },
    /** Close every open stream, as a restart of OBS would. */
    dropStreams() {
      for (const stream of streams) stream.end();
      streams.clear();
    },
    async close() {
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function runOne(requestType, requestData, table) {
  const handler = table[requestType];
  if (!handler) {
    return {
      requestType,
      requestStatus: { result: false, code: 605, comment: `unknown request ${requestType}` },
      responseData: {},
    };
  }
  const result = handler(requestData) ?? {};
  if (result.error) {
    return {
      requestType,
      requestStatus: { result: false, code: result.error.code ?? 600, comment: result.error.comment ?? '' },
      responseData: result.responseData ?? {},
    };
  }
  return { requestType, requestStatus: { result: true, code: 100 }, responseData: result };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJson(req, callback) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    try {
      callback(JSON.parse(raw || '{}'));
    } catch {
      callback({});
    }
  });
}
