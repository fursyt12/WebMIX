/*
 * Tests for the WebGPU preview pipeline's pure parts: the MJPEG multipart
 * parser (fed real byte streams, including split boundaries) and the colour
 * conversions shared with the property renderer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MultipartJpegParser } from '../src/webgpu-preview.js';
import { colorIntToHex, hexToColorInt, valueKey, decimalsForStep } from '../src/properties.js';

const jpeg = (marker) =>
  new Uint8Array([0xff, 0xd8, ...new TextEncoder().encode(marker), 0xff, 0xd9]);

/** Build a correct multipart/x-mixed-replace body for the given frames. */
function multipart(frames, boundary = 'webmixframe') {
  const parts = [];
  for (const frame of frames) {
    parts.push(
      new TextEncoder().encode(
        `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
      ),
      frame,
      new TextEncoder().encode('\r\n')
    );
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const asStrings = (frames) => frames.map((frame) => new TextDecoder().decode(frame.slice(2, -2)));

test('parses several frames delivered in one chunk', () => {
  const parser = new MultipartJpegParser();
  const frames = parser.push(multipart([jpeg('one'), jpeg('two'), jpeg('three')]));
  assert.equal(frames.length, 3);
  assert.deepEqual(asStrings(frames), ['one', 'two', 'three']);
  assert.equal(parser.frames, 3);
});

test('parses frames split across arbitrary chunk boundaries', () => {
  const body = multipart([jpeg('alpha'), jpeg('beta')]);
  const parser = new MultipartJpegParser();
  const collected = [];
  // One byte at a time is the worst case for a streaming parser.
  for (const byte of body) {
    for (const frame of parser.push(new Uint8Array([byte]))) collected.push(frame);
  }
  assert.equal(collected.length, 2);
  assert.deepEqual(asStrings(collected), ['alpha', 'beta']);
});

test('parses frames split at awkward offsets (headers and lengths)', () => {
  const body = multipart([jpeg('first-frame-payload'), jpeg('second')]);
  const parser = new MultipartJpegParser();
  const collected = [];
  for (let offset = 0; offset < body.length; offset += 7) {
    for (const frame of parser.push(body.subarray(offset, offset + 7))) collected.push(frame);
  }
  assert.equal(collected.length, 2);
  assert.deepEqual(asStrings(collected), ['first-frame-payload', 'second']);
});

test('ignores preamble noise and keeps the last partial part buffered', () => {
  const parser = new MultipartJpegParser();
  const noise = new TextEncoder().encode('HTTP garbage that is not a part\r\n');
  assert.equal(parser.push(noise).length, 0);

  const first = multipart([jpeg('complete')]);
  const second = multipart([jpeg('incomplete')]);
  // Split the second part inside its body.
  const cut = second.length - 6;
  const head = new Uint8Array([...first, ...second.subarray(0, cut)]);

  const frames = parser.push(head);
  assert.equal(frames.length, 1, 'only the complete part is emitted');
  assert.deepEqual(asStrings(frames), ['complete']);

  // The remaining bytes complete the second frame.
  const more = parser.push(second.subarray(cut));
  assert.equal(more.length, 1);
  assert.deepEqual(asStrings(more), ['incomplete']);
});

test('colour values round-trip between OBS ints and CSS hex', () => {
  assert.equal(colorIntToHex(0xffffff), '#ffffff');
  assert.equal(colorIntToHex(0x000000), '#000000');
  assert.equal(colorIntToHex(0xff0000), '#ff0000');

  assert.equal(hexToColorInt('#ff0000'), 0xff0000);
  assert.equal(hexToColorInt('00ff00'), 0x00ff00);

  // With alpha the top byte carries the alpha channel.
  const withAlpha = hexToColorInt('#11223344', true);
  assert.equal((withAlpha >>> 24) & 0xff, 0x44);
  assert.equal(withAlpha & 0xffffff, 0x112233);
  assert.equal(colorIntToHex(withAlpha, true), '#11223344');
});

test('list values compare consistently regardless of type', () => {
  assert.equal(valueKey(0), '0');
  assert.equal(valueKey('0'), '0');
  assert.equal(valueKey(true), 'true');
  assert.equal(valueKey(false), 'false');
  assert.equal(valueKey('Автоматически'), 'Автоматически');
  assert.equal(valueKey(null), '');
});

test('step precision drives the displayed decimals', () => {
  assert.equal(decimalsForStep(1), 0);
  assert.equal(decimalsForStep(0.1), 1);
  assert.equal(decimalsForStep(0.01), 2);
  assert.equal(decimalsForStep(0.001), 3);
});
