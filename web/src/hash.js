/*
 * WebMIX - self-contained SHA-256 + base64 helpers.
 *
 * obs-websocket v5 authentication requires
 *   base64(sha256(base64(sha256(password + salt)) + challenge))
 *
 * `crypto.subtle` is only available in secure contexts (https:// or
 * localhost).  The WebMIX UI is usually served over plain http:// from the
 * OBS machine (possibly to another device on the LAN), so a dependency-free
 * implementation is required here.
 *
 * Verified against node:crypto in web/test/hash.test.mjs.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** UTF-8 encode a JS string into a Uint8Array. */
export function utf8ToBytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  // Minimal fallback (Node always has TextEncoder, so this is only a safety net).
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(++i) & 0x3ff));
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return new Uint8Array(out);
}

/** SHA-256 over a Uint8Array, returning 32 raw bytes. */
export function sha256(msg) {
  const bytes = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
  const len = bytes.length;
  const bitLen = len * 8;
  const withOne = len + 1;
  const rem = withOne % 64;
  const padZeros = rem <= 56 ? 56 - rem : 120 - rem;
  const total = withOne + padZeros + 8;

  const data = new Uint8Array(total);
  data.set(bytes);
  data[len] = 0x80;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // 64-bit big-endian bit length. JS bit ops are 32-bit, so write two halves.
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64-encode raw bytes (works in browsers and Node without Buffer). */
export function bytesToBase64(bytes) {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? B64[b2 & 63] : '=';
  }
  return out;
}

/** Decode base64 (used by tests / screenshot helpers). */
export function base64ToBytes(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, '');
  const len = clean.length;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const n0 = B64.indexOf(clean[i]);
    const n1 = B64.indexOf(clean[i + 1]);
    const n2 = B64.indexOf(clean[i + 2]);
    const n3 = B64.indexOf(clean[i + 3]);
    if (p < out.length) out[p++] = (n0 << 2) | (n1 >> 4);
    if (n2 !== -1 && p < out.length) out[p++] = ((n1 & 15) << 4) | (n2 >> 2);
    if (n3 !== -1 && p < out.length) out[p++] = ((n2 & 3) << 6) | n3;
  }
  return out.subarray(0, p);
}

/** Hex digest, handy for tests and debugging. */
export function sha256Hex(msg) {
  return Array.from(sha256(msg), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Base64 of the SHA-256 of a UTF-8 string. */
export function sha256Base64(str) {
  return bytesToBase64(sha256(utf8ToBytes(str)));
}

/**
 * Build the obs-websocket v5 authentication string.
 * @param {string} password
 * @param {string} salt      base64 salt from the Hello message
 * @param {string} challenge base64 challenge from the Hello message
 */
export function buildAuthString(password, salt, challenge) {
  const secret = sha256Base64(password + salt);
  return bytesToBase64(sha256(utf8ToBytes(secret + challenge)));
}
