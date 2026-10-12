/*
 * Tests for the preview stream's client side - the parts that decide whether a
 * pane recovers by itself - and for a few markup/CSS regressions that are only
 * visible in a browser and were each a broken piece of the interface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { MultipartJpegParser, openMjpegStream } from '../src/webgpu-preview.js';

const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const encode = (text) => new TextEncoder().encode(text);
const jpeg = (marker) => new Uint8Array([0xff, 0xd8, ...encode(marker), 0xff, 0xd9]);
const asStrings = (frames) => frames.map((frame) => new TextDecoder().decode(frame.slice(2, -2)));

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** One part the way the host writes it: headers, body, then the boundary that
 *  closes it - so a browser can paint the frame without waiting for the next. */
const part = (frame, stamp = 1700000000000) =>
  concat(
    encode(`Content-Type: image/jpeg\r\nX-Timestamp: ${stamp}\r\nContent-Length: ${frame.length}\r\n\r\n`),
    frame,
    encode('\r\n--webmixframe\r\n')
  );

const FIRST_BOUNDARY = encode('--webmixframe\r\n');

/** A fetch() that answers with the given chunks and then ends (or hangs). */
function stubFetch({ status = 200, chunks = [], hang = false }) {
  return async (_url, { signal } = {}) => {
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (!hang) controller.close();
        signal?.addEventListener('abort', () => {
          try {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          } catch {
            /* already closed */
          }
        });
      },
    });
    return new Response(status === 200 ? body : null, { status });
  };
}

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/* ------------------------------------------------------------- the parser */

test('a frame is complete as soon as its closing boundary has arrived', () => {
  const parser = new MultipartJpegParser();
  assert.equal(parser.push(FIRST_BOUNDARY).length, 0);
  // The whole part is here, and nothing of the next one: it must come out now.
  assert.deepEqual(asStrings(parser.push(part(jpeg('still')))), ['still']);
  assert.deepEqual(asStrings(parser.push(part(jpeg('next')))), ['next']);
  assert.equal(parser.frames, 2);
});

test('extra part headers do not confuse the parser', () => {
  const parser = new MultipartJpegParser();
  const frames = parser.push(concat(FIRST_BOUNDARY, part(jpeg('a'), 1), part(jpeg('b'), 2)));
  assert.deepEqual(asStrings(frames), ['a', 'b']);
});

test('trailing-boundary parts survive being split at every offset', () => {
  const body = concat(FIRST_BOUNDARY, part(jpeg('alpha')), part(jpeg('beta')), part(jpeg('gamma')));
  for (const step of [1, 3, 7, 16, 61]) {
    const parser = new MultipartJpegParser();
    const collected = [];
    for (let offset = 0; offset < body.length; offset += step) {
      collected.push(...parser.push(body.subarray(offset, offset + step)));
    }
    assert.deepEqual(asStrings(collected), ['alpha', 'beta', 'gamma'], `chunks of ${step}`);
  }
});

/* ---------------------------------------------------- the stream's ending */

test('a stream the host closes reports its end, so the pane can reopen it', async () => {
  const events = [];
  await withFetch(stubFetch({ chunks: [FIRST_BOUNDARY, part(jpeg('one'))] }), () =>
    openMjpegStream('api/preview.mjpg', {
      onFrame: (frame) => events.push(`frame:${asStrings([frame])[0]}`),
      onEnd: () => events.push('end'),
      onError: (err) => events.push(`error:${err.message}`),
    })
  );
  assert.deepEqual(events, ['frame:one', 'end']);
});

test('a refused stream is an error, not a silent blank pane', async () => {
  const events = [];
  await withFetch(stubFetch({ status: 503 }), () =>
    openMjpegStream('api/preview.mjpg', {
      onEnd: () => events.push('end'),
      onError: (err) => events.push(`error:${err.message}`),
    })
  );
  assert.equal(events.length, 1);
  assert.match(events[0], /^error:.*503/);
});

test('an aborted stream is silent: nobody asked for it to come back', async () => {
  const events = [];
  const abort = new AbortController();
  const done = withFetch(stubFetch({ chunks: [FIRST_BOUNDARY], hang: true }), () =>
    openMjpegStream('api/preview.mjpg', {
      signal: abort.signal,
      onEnd: () => events.push('end'),
      onError: () => events.push('error'),
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  abort.abort();
  await done;
  assert.deepEqual(events, []);
});

/* ------------------------------------------------ the panel's own logic */

test('the preview panel does not reopen its streams on every store update', async () => {
  const source = await read('../src/ui/preview.js');
  const render = source.slice(source.indexOf('  render() {'), source.indexOf('  start() {'));
  assert.ok(render.includes('this.wasConnected === false'), 'streams restart on the change to connected only');
  assert.ok(!/everConnected/.test(source), 'the per-render restart is gone');
});

test('a failing stream cannot re-render the panel that reopens it', async () => {
  const source = await read('../src/ui/preview.js');
  const start = source.slice(source.indexOf('  #startStream(surface) {'), source.indexOf('  async #drainFrames'));
  assert.ok(!start.includes('#report('), 'stream errors stay inside the pane (retry with backoff)');
  assert.ok(start.includes('onEnd'), 'a closed stream is retried too');
});

test('the preview panes read their scene through the selectors', async () => {
  const source = await read('../src/ui/preview.js');
  // Studio Mode switched on from elsewhere has no preview scene yet; the raw
  // field left the Preview pane empty.
  assert.ok(source.includes('selectors.previewPaneScene(state)'));
});

/* ------------------------------------------------ markup and stylesheet */

test('every inline SVG image declares its namespace', async () => {
  const css = await read('../assets/obs.css');
  const urls = css.match(/url\("data:image\/svg\+xml,[^"]+"\)/g) ?? [];
  assert.ok(urls.length >= 6, 'the checkbox artwork is inlined');
  for (const url of urls) {
    // Without xmlns a browser parses the image as plain XML and draws nothing,
    // which made every checkbox in the interface invisible.
    assert.ok(url.includes("xmlns='http://www.w3.org/2000/svg'"), url.slice(0, 80));
  }
});

test('a dialog footer exists even when the dialog opens without buttons', async () => {
  const source = await read('../src/ui/dialog.js');
  assert.ok(source.includes('dialog.append(titleBar, bodyEl, footerEl)'));
  const css = await read('../assets/layout.css');
  assert.match(css, /\.obs-dialog-footer:empty\s*\{\s*display:\s*none/);
});

test('section headings are only positioned inside a group box', async () => {
  const css = await read('../assets/obs.css');
  assert.ok(!/^\.obs-group-title\s*\{[^}]*position:\s*absolute/m.test(css));
  assert.match(css, /\.obs-group > \.obs-group-title\s*\{[^}]*position:\s*absolute/);
});
