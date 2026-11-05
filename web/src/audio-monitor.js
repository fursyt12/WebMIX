/*
 * WebMIX - browser-side audio monitoring client.
 *
 * Plays OBS's monitored audio (`GET /api/audio`) through Web Audio.  In `--web`
 * mode OBS suppresses its host OS monitoring backend, so monitored sources are
 * heard exclusively in open WebMIX browser tabs.
 *
 * Plain `AudioContext` + `AudioBufferSourceNode` scheduling is used instead of
 * `AudioWorklet` because WebMIX is commonly served over plain HTTP on a LAN,
 * where `window.isSecureContext` is false and `audioWorklet` is unavailable.
 */
import { t } from './i18n.js';

const MAGIC_0 = 0x57; // 'W'
const MAGIC_1 = 0x4d; // 'M'
const MAGIC_2 = 0x41; // 'A'
const MAGIC_3 = 0x31; // '1'
const HEADER_BYTES = 12;

const TARGET_LEAD_SEC = 0.035;
const MAX_LEAD_SEC = 0.14;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 2000;

/**
 * Whether any input in the store currently has audio monitoring enabled while
 * connected to OBS.
 */
export function hasMonitoredInputs(state) {
  if (state?.connection?.status !== 'connected') return false;
  for (const entry of Object.values(state?.audio ?? {})) {
    const type = entry?.monitorType ?? 'OBS_MONITORING_TYPE_NONE';
    if (type !== 'OBS_MONITORING_TYPE_NONE') return true;
  }
  return false;
}

/**
 * Streaming parser for `"WMA1"` framed s16le PCM packets.
 */
export class AudioPacketDecoder {
  #buffer = new Uint8Array(0);
  #length = 0;

  reset() {
    this.#length = 0;
  }

  /**
   * Append a chunk from a fetch reader and return all complete packets decoded
   * so far.
   * @param {Uint8Array} chunk
   * @returns {Array<{channels: number, frames: number, sampleRate: number, planes: Float32Array[]}>}
   */
  push(chunk) {
    if (!chunk || chunk.byteLength === 0) return [];

    if (this.#length + chunk.byteLength > this.#buffer.byteLength) {
      const nextSize = Math.max(4096, (this.#length + chunk.byteLength) * 2);
      const grown = new Uint8Array(nextSize);
      if (this.#length > 0) {
        grown.set(this.#buffer.subarray(0, this.#length), 0);
      }
      this.#buffer = grown;
    }
    this.#buffer.set(chunk, this.#length);
    this.#length += chunk.byteLength;

    const packets = [];
    let offset = 0;

    while (this.#length - offset >= HEADER_BYTES) {
      if (
        this.#buffer[offset] !== MAGIC_0 ||
        this.#buffer[offset + 1] !== MAGIC_1 ||
        this.#buffer[offset + 2] !== MAGIC_2 ||
        this.#buffer[offset + 3] !== MAGIC_3
      ) {
        throw new Error('Invalid WebMIX audio stream header');
      }

      const headerView = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + offset, HEADER_BYTES);
      const channels = headerView.getUint16(4, true);
      const frames = headerView.getUint16(6, true);
      const sampleRate = headerView.getUint32(8, true);

      if (channels === 0 || channels > 8 || sampleRate === 0) {
        throw new Error('Invalid WebMIX audio packet parameters');
      }

      const payloadBytes = frames * channels * 2;
      const totalBytes = HEADER_BYTES + payloadBytes;
      if (this.#length - offset < totalBytes) {
        break;
      }

      const planes = [];
      if (frames > 0) {
        for (let ch = 0; ch < channels; ch++) {
          planes.push(new Float32Array(frames));
        }
        const pcmView = new DataView(
          this.#buffer.buffer,
          this.#buffer.byteOffset + offset + HEADER_BYTES,
          payloadBytes
        );
        let byteOffset = 0;
        for (let i = 0; i < frames; i++) {
          for (let ch = 0; ch < channels; ch++) {
            planes[ch][i] = pcmView.getInt16(byteOffset, true) / 32768;
            byteOffset += 2;
          }
        }
      }

      packets.push({ channels, frames, sampleRate, planes });
      offset += totalBytes;
    }

    if (offset > 0) {
      const remaining = this.#length - offset;
      if (remaining > 0) {
        this.#buffer.copyWithin(0, offset, this.#length);
      }
      this.#length = remaining;
    }

    return packets;
  }
}

function defaultCreateAudioContext() {
  if (typeof globalThis === 'undefined') return null;
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    return new Ctor({ latencyHint: 'interactive' });
  } catch {
    return new Ctor();
  }
}

export class AudioMonitor {
  #base;
  #onStatus;
  #fetch;
  #createAudioContext;
  #ctx = null;
  #wantActive = false;
  #abortController = null;
  #loopPromise = null;
  #nextPlayTime = 0;
  #warnedSuspended = false;
  #gestureInstalled = false;
  #onUserGesture;

  constructor({
    base = '',
    onStatus = null,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    createAudioContext = defaultCreateAudioContext,
  } = {}) {
    this.#base = base;
    this.#onStatus = onStatus;
    this.#fetch = fetchImpl;
    this.#createAudioContext = createAudioContext;
    this.#onUserGesture = () => {
      if (this.#ctx && this.#ctx.state === 'suspended') {
        this.#ctx.resume().catch(() => {});
      }
    };
  }

  get active() {
    return this.#wantActive;
  }

  /**
   * Call inside a click/change gesture when enabling monitoring so the browser
   * unlocks Web Audio playback immediately.
   */
  unlock() {
    const ctx = this.#ensureContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  /**
   * Synchronise stream state with the store and host capabilities.
   */
  sync(state, host) {
    const shouldRun = Boolean(host?.audioStream) && hasMonitoredInputs(state);
    if (shouldRun) this.start();
    else this.stop();
  }

  start() {
    if (this.#wantActive) return;
    this.#wantActive = true;
    this.#nextPlayTime = 0;
    this.#installGestureListeners();
    if (!this.#loopPromise) {
      this.#loopPromise = this.#runLoop().finally(() => {
        this.#loopPromise = null;
      });
    }
  }

  stop() {
    this.#wantActive = false;
    this.#nextPlayTime = 0;
    this.#warnedSuspended = false;
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
  }

  destroy() {
    this.stop();
    this.#removeGestureListeners();
    if (this.#ctx) {
      const ctx = this.#ctx;
      this.#ctx = null;
      ctx.close?.().catch?.(() => {});
    }
  }

  #ensureContext() {
    if (!this.#ctx && typeof this.#createAudioContext === 'function') {
      try {
        this.#ctx = this.#createAudioContext();
      } catch {
        this.#ctx = null;
      }
    }
    return this.#ctx;
  }

  #installGestureListeners() {
    if (this.#gestureInstalled || typeof window === 'undefined' || !window.addEventListener) return;
    this.#gestureInstalled = true;
    window.addEventListener('pointerdown', this.#onUserGesture, { passive: true });
    window.addEventListener('keydown', this.#onUserGesture, { passive: true });
  }

  #removeGestureListeners() {
    if (!this.#gestureInstalled || typeof window === 'undefined' || !window.removeEventListener) return;
    this.#gestureInstalled = false;
    window.removeEventListener('pointerdown', this.#onUserGesture);
    window.removeEventListener('keydown', this.#onUserGesture);
  }

  async #runLoop() {
    let retryMs = RETRY_BASE_MS;

    while (this.#wantActive) {
      if (typeof this.#fetch !== 'function') return;

      const controller = new AbortController();
      this.#abortController = controller;
      const decoder = new AudioPacketDecoder();
      this.#nextPlayTime = 0;

      try {
        const response = await this.#fetch(`${this.#base}api/audio`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        retryMs = RETRY_BASE_MS;
        const reader = response.body.getReader();
        try {
          while (this.#wantActive) {
            const { value, done } = await reader.read();
            if (done) break;
            const packets = decoder.push(value);
            for (const packet of packets) {
              this.#schedulePacket(packet);
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      } catch (err) {
        if (!this.#wantActive || controller.signal.aborted || err?.name === 'AbortError') {
          break;
        }
      } finally {
        if (this.#abortController === controller) {
          this.#abortController = null;
        }
      }

      if (!this.#wantActive) break;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
    }
  }

  #schedulePacket(packet) {
    if (!packet || packet.frames === 0) return;

    const ctx = this.#ensureContext();
    if (!ctx) return;

    if (ctx.state === 'suspended') {
      ctx.resume?.().catch?.(() => {});
      if (ctx.state === 'suspended') {
        if (!this.#warnedSuspended) {
          this.#warnedSuspended = true;
          this.#onStatus?.(
            t('WebMix.Audio.ClickToUnmute', {
              fallback: 'Browser suspended audio playback — click anywhere on the page to hear monitoring.',
            }),
            'warning',
            8000
          );
        }
        return;
      }
    }
    this.#warnedSuspended = false;

    const buffer = ctx.createBuffer(packet.channels, packet.frames, packet.sampleRate);
    for (let ch = 0; ch < packet.channels; ch++) {
      buffer.getChannelData(ch).set(packet.planes[ch]);
    }

    const now = ctx.currentTime;
    if (this.#nextPlayTime < now + 0.005 || this.#nextPlayTime - now > MAX_LEAD_SEC) {
      this.#nextPlayTime = now + TARGET_LEAD_SEC;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(this.#nextPlayTime);
    this.#nextPlayTime += buffer.duration;
  }
}
