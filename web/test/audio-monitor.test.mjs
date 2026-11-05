/*
 * Tests for WebMIX browser-only audio monitoring (`AudioPacketDecoder`,
 * `hasMonitoredInputs`, `AudioMonitor`) and startup locale keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AudioPacketDecoder, AudioMonitor, hasMonitoredInputs } from '../src/audio-monitor.js';

function buildWma1Packet({ channels = 2, sampleRate = 48000, samples = [] }) {
  const frames = samples.length / channels;
  const buf = new Uint8Array(12 + samples.length * 2);
  buf[0] = 0x57; // 'W'
  buf[1] = 0x4d; // 'M'
  buf[2] = 0x41; // 'A'
  buf[3] = 0x31; // '1'
  const view = new DataView(buf.buffer);
  view.setUint16(4, channels, true);
  view.setUint16(6, frames, true);
  view.setUint32(8, sampleRate, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(12 + i * 2, samples[i], true);
  }
  return buf;
}

function createMockAudioContext(initialState = 'running') {
  const scheduled = [];
  const ctx = {
    state: initialState,
    currentTime: 1.0,
    destination: { kind: 'destination' },
    resumed: 0,
    closed: 0,
    resume() {
      this.resumed++;
      this.state = 'running';
      return Promise.resolve();
    },
    close() {
      this.closed++;
      this.state = 'closed';
      return Promise.resolve();
    },
    createBuffer(channels, frames, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return {
        numberOfChannels: channels,
        length: frames,
        sampleRate,
        duration: frames / sampleRate,
        getChannelData: (ch) => data[ch],
      };
    },
    createBufferSource() {
      return {
        buffer: null,
        connectedTo: null,
        connect(dest) {
          this.connectedTo = dest;
        },
        start(when) {
          scheduled.push({ when, buffer: this.buffer, connectedTo: this.connectedTo });
        },
      };
    },
  };
  return { ctx, scheduled };
}

test('AudioPacketDecoder decodes stereo s16le packets and 0-frame keepalives', () => {
  const decoder = new AudioPacketDecoder();
  const keepalive = buildWma1Packet({ channels: 2, sampleRate: 48000, samples: [] });
  const audio = buildWma1Packet({
    channels: 2,
    sampleRate: 48000,
    samples: [-32768, 16384, 0, -16384],
  });

  const combined = new Uint8Array(keepalive.length + audio.length);
  combined.set(keepalive, 0);
  combined.set(audio, keepalive.length);

  const packets = decoder.push(combined);
  assert.equal(packets.length, 2);

  assert.equal(packets[0].frames, 0);
  assert.equal(packets[0].sampleRate, 48000);
  assert.deepEqual(packets[0].planes, []);

  assert.equal(packets[1].channels, 2);
  assert.equal(packets[1].frames, 2);
  assert.equal(packets[1].sampleRate, 48000);
  assert.equal(packets[1].planes[0][0], -1.0);
  assert.equal(packets[1].planes[1][0], 0.5);
  assert.equal(packets[1].planes[0][1], 0.0);
  assert.equal(packets[1].planes[1][1], -0.5);
});

test('AudioPacketDecoder preserves channel alignment across 1-byte TCP fragments', () => {
  const decoder = new AudioPacketDecoder();
  const pkt1 = buildWma1Packet({ channels: 2, sampleRate: 44100, samples: [8192, -8192, 16384, -16384] });
  const pkt2 = buildWma1Packet({ channels: 2, sampleRate: 44100, samples: [4096, -4096] });

  const streamBytes = new Uint8Array(pkt1.length + pkt2.length);
  streamBytes.set(pkt1, 0);
  streamBytes.set(pkt2, pkt1.length);

  const decoded = [];
  for (let i = 0; i < streamBytes.length; i++) {
    decoded.push(...decoder.push(streamBytes.subarray(i, i + 1)));
  }

  assert.equal(decoded.length, 2);
  assert.deepEqual([...decoded[0].planes[0]], [0.25, 0.5]);
  assert.deepEqual([...decoded[0].planes[1]], [-0.25, -0.5]);
  assert.deepEqual([...decoded[1].planes[0]], [0.125]);
  assert.deepEqual([...decoded[1].planes[1]], [-0.125]);
});

test('AudioPacketDecoder rejects invalid magic headers', () => {
  const decoder = new AudioPacketDecoder();
  const bad = new Uint8Array(12);
  bad.set([0x4f, 0x47, 0x47, 0x53]); // 'OGGS'
  assert.throws(() => decoder.push(bad), /Invalid WebMIX audio stream header/);
});

test('hasMonitoredInputs reflects server-side OBS monitoring state', () => {
  assert.equal(hasMonitoredInputs({ connection: { status: 'disconnected' }, audio: {} }), false);
  assert.equal(
    hasMonitoredInputs({
      connection: { status: 'connected' },
      audio: { Mic: { monitorType: 'OBS_MONITORING_TYPE_NONE' } },
    }),
    false
  );
  assert.equal(
    hasMonitoredInputs({
      connection: { status: 'connected' },
      audio: {
        Desktop: { monitorType: 'OBS_MONITORING_TYPE_NONE' },
        Mic: { monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' },
      },
    }),
    true
  );
});

test('AudioMonitor streams to all active browser clients and disconnects when monitoring stops', async (t) => {
  const openClients = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/api/audio' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      openClients.add(res);
      req.on('close', () => openClients.delete(res));
      // Handshake keepalive + one 2-frame stereo packet
      res.write(buildWma1Packet({ channels: 2, sampleRate: 48000, samples: [] }));
      res.write(buildWma1Packet({ channels: 2, sampleRate: 48000, samples: [16384, -16384, 8192, -8192] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const res of openClients) res.end();
    await new Promise((resolve) => server.close(resolve));
  });

  const base = `http://127.0.0.1:${server.address().port}/`;
  const host = { embedded: true, audioStream: true };

  // Two independent tabs observing the same OBS monitoring state.
  const tab1Audio = createMockAudioContext('running');
  const tab2Audio = createMockAudioContext('running');
  const tab1 = new AudioMonitor({ base, createAudioContext: () => tab1Audio.ctx });
  const tab2 = new AudioMonitor({ base, createAudioContext: () => tab2Audio.ctx });
  t.after(() => {
    tab1.destroy();
    tab2.destroy();
  });

  const stateOff = {
    connection: { status: 'connected' },
    audio: { Mic: { monitorType: 'OBS_MONITORING_TYPE_NONE' } },
  };
  tab1.sync(stateOff, host);
  tab2.sync(stateOff, host);
  assert.equal(tab1.active, false);
  assert.equal(tab2.active, false);
  assert.equal(openClients.size, 0);

  // Enabling monitoring in OBS causes both tabs to connect and play audio.
  const stateOn = {
    connection: { status: 'connected' },
    audio: { Mic: { monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' } },
  };
  tab1.sync(stateOn, host);
  tab2.sync(stateOn, host);

  const deadline = Date.now() + 2000;
  while ((tab1Audio.scheduled.length < 1 || tab2Audio.scheduled.length < 1) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }

  assert.equal(tab1Audio.scheduled.length, 1);
  assert.equal(tab2Audio.scheduled.length, 1);
  assert.equal(tab1Audio.scheduled[0].buffer.getChannelData(0)[0], 0.5);
  assert.equal(tab2Audio.scheduled[0].buffer.getChannelData(1)[0], -0.5);
  assert.equal(openClients.size, 2);

  // Disabling monitoring closes both HTTP streams immediately.
  tab1.sync(stateOff, host);
  tab2.sync(stateOff, host);
  const closeDeadline = Date.now() + 2000;
  while (openClients.size > 0 && Date.now() < closeDeadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(openClients.size, 0);
});

test('ru-RU and en-US locales define WebMix.Startup.StartStreaming', () => {
  const ruPath = fileURLToPath(new URL('../../frontend/data/locale/ru-RU.ini', import.meta.url));
  const enPath = fileURLToPath(new URL('../../frontend/data/locale/en-US.ini', import.meta.url));
  const ru = readFileSync(ruPath, 'utf8');
  const en = readFileSync(enPath, 'utf8');
  assert.match(ru, /WebMix\.Startup\.StartStreaming="Начинать трансляцию при запуске"/);
  assert.match(en, /WebMix\.Startup\.StartStreaming="Start streaming when OBS starts"/);
});
