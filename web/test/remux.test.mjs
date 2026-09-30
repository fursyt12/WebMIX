/*
 * Tests for the remux bridge client: the queue is driven entirely through
 * /api/remux, so the request shapes (and the 409 conflict the dialog turns into
 * a "replace?" question) are what the UI depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchRemuxState,
  addRemux,
  startRemux,
  stopRemux,
  clearFinishedRemux,
  clearAllRemux,
} from '../src/bridge.js';

/** Stub global fetch with a route table; returns the recorded requests. */
function stubFetch(routes) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push(`${method} ${url}`);
    const handler = routes[`${method} ${url.split('?')[0]}`] ?? routes[url.split('?')[0]];
    if (!handler) throw new Error(`no route for ${method} ${url}`);
    const { status = 200, body = {} } = handler(url) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

const STATE = {
  jobs: [{ id: 'job-1', source: '/rec/a.mkv', target: '/rec/a.mp4', format: 'mp4', state: 'ready' }],
  processing: false,
  progress: 0,
  canClearFinished: false,
  activeCount: 0,
};

test('fetchRemuxState returns the queue when the bridge answers', async () => {
  const stub = stubFetch({ 'GET api/remux': () => ({ body: STATE }) });
  try {
    assert.deepEqual(await fetchRemuxState(), STATE);
  } finally {
    stub.restore();
  }
});

test('fetchRemuxState ignores a payload that is not a queue', async () => {
  const stub = stubFetch({ 'GET api/remux': () => ({ body: { error: 'not available' } }) });
  try {
    assert.equal(await fetchRemuxState(), null);
  } finally {
    stub.restore();
  }
});

test('fetchRemuxState fails soft without a bridge', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    assert.equal(await fetchRemuxState(), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('addRemux encodes the path and passes the format and overwrite flag', async () => {
  const stub = stubFetch({
    'POST api/remux/add': (url) => ({
      body: { ok: true, id: 'job-2', source: url.includes('sub%2Fb.mkv') ? '/rec/sub/b.mkv' : '', target: '/rec/sub/b.mp4' },
    }),
  });
  try {
    const result = await addRemux('sub/b.mkv', 'mp4', true);
    assert.equal(result.ok, true);
    assert.equal(
      stub.requests[0],
      'POST api/remux/add?path=sub%2Fb.mkv&format=mp4&overwrite=1'
    );
  } finally {
    stub.restore();
  }
});

test('addRemux reports an existing target as a conflict', async () => {
  const stub = stubFetch({
    'POST api/remux/add': () => ({
      status: 409,
      body: { ok: false, conflict: true, target: '/rec/a.mp4', error: 'the target file already exists' },
    }),
  });
  try {
    const result = await addRemux('a.mkv', 'mp4', false);
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.equal(result.target, '/rec/a.mp4');
  } finally {
    stub.restore();
  }
});

test('the queue controls call their own endpoints', async () => {
  const stub = stubFetch({
    'POST api/remux/start': () => ({ body: { ok: true, ...STATE } }),
    'POST api/remux/stop': () => ({ body: { ok: true, ...STATE } }),
    'POST api/remux/clear': () => ({ body: { ok: true, jobs: [] } }),
    'POST api/remux/clearall': () => ({ body: { ok: true, jobs: [] } }),
  });
  try {
    assert.equal((await startRemux()).ok, true);
    assert.equal((await stopRemux()).ok, true);
    assert.equal((await clearFinishedRemux()).ok, true);
    assert.equal((await clearAllRemux()).ok, true);
    assert.deepEqual(stub.requests, [
      'POST api/remux/start',
      'POST api/remux/stop',
      'POST api/remux/clear',
      'POST api/remux/clearall',
    ]);
  } finally {
    stub.restore();
  }
});

test('startRemux surfaces a refused start', async () => {
  const stub = stubFetch({
    'POST api/remux/start': () => ({ status: 400, body: { ok: false, error: 'there is nothing to remux' } }),
  });
  try {
    const result = await startRemux();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'there is nothing to remux');
  } finally {
    stub.restore();
  }
});
