/*
 * Tests for the file-browser helpers: URL construction (which is what keeps
 * requests inside the allowed directories) and size formatting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { filesUrl, fetchListing } from '../src/ui/files.js';

test('filesUrl encodes kind and path safely', () => {
  assert.equal(filesUrl('logs'), 'api/files/list?kind=logs');
  assert.equal(filesUrl('logs', '2024 01 02.txt'), 'api/files/list?kind=logs&path=2024+01+02.txt');
  // A name with a slash must survive as a single path parameter, not become
  // two path segments.
  const url = filesUrl('recordings', 'sub/dir/file.mkv');
  assert.ok(url.includes('path=sub%2Fdir%2Ffile.mkv'), url);
  // Dangerous characters are encoded rather than passed through.
  assert.ok(filesUrl('logs', '../etc/passwd').includes('path=..%2Fetc%2Fpasswd'));
});

test('filesUrl supports extra parameters', () => {
  const url = filesUrl('logs', 'a.txt', { endpoint: 'text', limit: 2048 });
  assert.ok(url.startsWith('api/files/text?'));
  assert.ok(url.includes('limit=2048'));
});

test('fetchListing reports a missing bridge instead of throwing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    assert.equal(await fetchListing('logs'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchListing surfaces a server-side refusal', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid path' }),
  });
  try {
    const result = await fetchListing('logs', '../..');
    assert.deepEqual(result, { error: 'invalid path' });
  } finally {
    globalThis.fetch = original;
  }
});
