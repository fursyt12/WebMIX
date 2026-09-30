/*
 * Verifies the dependency-free SHA-256 / base64 implementation against
 * node:crypto, including all SHA-256 padding boundaries and the exact
 * obs-websocket authentication string construction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import {
  sha256,
  sha256Hex,
  sha256Base64,
  bytesToBase64,
  base64ToBytes,
  utf8ToBytes,
  buildAuthString,
} from '../src/hash.js';

const nodeHash = (data) => createHash('sha256').update(data).digest();
const nodeHashB64 = (data) => createHash('sha256').update(data).digest('base64');

test('sha256 matches node:crypto on every padding boundary', () => {
  for (const len of [0, 1, 2, 3, 31, 32, 33, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 1000, 4096]) {
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = (i * 7 + 3) & 0xff;
    const mine = Buffer.from(sha256(new Uint8Array(buf)));
    assert.equal(mine.toString('hex'), nodeHash(buf).toString('hex'), `byte length ${len}`);
  }
});

test('sha256 matches node:crypto for text including multibyte UTF-8', () => {
  for (const s of ['', 'a', 'hello world', 'Привет, мир! 🎬', 'x'.repeat(200)]) {
    assert.equal(sha256Hex(utf8ToBytes(s)), nodeHash(s).toString('hex'), JSON.stringify(s.slice(0, 20)));
  }
});

test('base64 encode/decode round-trips and matches Buffer', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33, 255]) {
    const bytes = randomBytes(len);
    const b64 = bytesToBase64(bytes);
    assert.equal(b64, bytes.toString('base64'), `encode length ${len}`);
    assert.deepEqual(Buffer.from(base64ToBytes(b64)), bytes, `decode length ${len}`);
  }
});

test('buildAuthString matches the reference obs-websocket algorithm', () => {
  const password = 'vAwvBS2FC0HRv8hP';
  const salt = randomBytes(16).toString('base64');
  const challenge = randomBytes(16).toString('base64');

  const secret = nodeHashB64(password + salt);
  const expected = createHash('sha256').update(secret + challenge).digest('base64');

  assert.equal(buildAuthString(password, salt, challenge), expected);
  assert.equal(sha256Base64(password + salt), secret);
});

test('buildAuthString is stable and changes with every input', () => {
  const salt = 'c2FsdA==';
  const challenge = 'Y2hhbGxlbmdl';
  const a = buildAuthString('pw', salt, challenge);
  assert.equal(a, buildAuthString('pw', salt, challenge));
  assert.notEqual(a, buildAuthString('pw2', salt, challenge));
  assert.notEqual(a, buildAuthString('pw', 'b3RoZXI=', challenge));
  assert.notEqual(a, buildAuthString('pw', salt, 'b3RoZXI='));
});
