/*
 * Tests for the native control transport.
 *
 * The point of the native client is that the page reaches OBS without a
 * websocket, so these tests deliberately never construct one: they drive
 * ObsDirectClient against the mock control service and assert the same
 * behaviour the UI relies on from ObsClient (state, requests, batches, events,
 * error shapes and reconnection).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ObsDirectClient } from '../src/obs-direct.js';
import { ObsConnectionError, ObsRequestError } from '../src/obs-client.js';
import { startNativeObs } from './helpers/native-obs.mjs';

/** Wait until `predicate` holds, or fail after `timeout` ms. */
async function until(predicate, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('condition was never met');
}

test('connect() opens the native channel and reports it as connected', async (t) => {
  const obs = await startNativeObs();
  t.after(() => obs.close());

  const client = new ObsDirectClient({ base: obs.base });
  const events = [];
  client.on('connected', (info) => events.push(info));

  const info = await client.connect();
  assert.equal(info.native, true);
  assert.equal(client.connected, true);
  assert.equal(client.status, 'connected');
  // The probe reports how much of the vocabulary the host implements.
  assert.ok(info.requestTypes >= 3);
  assert.equal(events.length, 1);

  client.disconnect();
  assert.equal(client.connected, false);
});

test('connect() refuses a host that only serves static files', async (t) => {
  const obs = await startNativeObs({ serveEvents: false });
  t.after(() => obs.close());

  // The event endpoint is absent, so the page must not pretend to be connected
  // to an OBS that is not running the control service.
  const client = new ObsDirectClient({ base: obs.base, autoReconnect: false });
  await assert.rejects(() => client.connect(), ObsConnectionError);
  assert.equal(client.connected, false);
});

test('connect() fails cleanly when nothing is listening', async () => {
  const client = new ObsDirectClient({ base: 'http://127.0.0.1:1/', autoReconnect: false });
  await assert.rejects(() => client.connect(), ObsConnectionError);
  assert.equal(client.connected, false);
});

test('request() returns responseData and forwards the request verbatim', async (t) => {
  const obs = await startNativeObs();
  t.after(() => obs.close());

  const client = new ObsDirectClient({ base: obs.base });
  await client.connect();
  t.after(() => client.disconnect());

  const data = await client.request('GetSceneList');
  assert.equal(data.currentProgramSceneName, 'Scene');
  assert.equal(data.scenes.length, 1);

  await client.request('SetCurrentProgramScene', { sceneName: 'Scene' });
  assert.deepEqual(obs.calls.at(-1), {
    requestType: 'SetCurrentProgramScene',
    requestData: { sceneName: 'Scene' },
  });
});

test('request() surfaces a refused request as ObsRequestError', async (t) => {
  const obs = await startNativeObs({
    handlers: {
      SetSceneName: () => ({ error: { code: 600, comment: 'No scene named that' } }),
    },
  });
  t.after(() => obs.close());

  const client = new ObsDirectClient({ base: obs.base });
  await client.connect();
  t.after(() => client.disconnect());

  const error = await client.request('SetSceneName', { sceneName: 'nope' }).then(
    () => null,
    (err) => err
  );
  assert.ok(error instanceof ObsRequestError);
  assert.equal(error.code, 600);
  assert.equal(error.comment, 'No scene named that');
  assert.equal(error.name, 'ObsRequestError');
});

test('requestBatch() runs every request in one round trip', async (t) => {
  const obs = await startNativeObs({
    handlers: {
      GetInputVolume: () => ({ inputVolumeMul: 0.5, inputVolumeDb: -6 }),
      // One failure in the batch must not reject the whole call: the caller
      // inspects each entry, exactly as refreshAudio() does.
      GetInputMute: () => ({ error: { code: 600, comment: 'gone' } }),
    },
  });
  t.after(() => obs.close());

  const client = new ObsDirectClient({ base: obs.base });
  await client.connect();
  t.after(() => client.disconnect());

  const results = await client.requestBatch([
    { requestType: 'GetInputVolume', requestData: { inputName: 'Mic' } },
    { requestType: 'GetInputMute', requestData: { inputName: 'Mic' } },
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].requestStatus.result, true);
  assert.equal(results[0].responseData.inputVolumeMul, 0.5);
  assert.equal(results[1].requestStatus.result, false);
  assert.equal(obs.calls.filter((call) => call.batch).length, 2);
});

test('events arrive from the SSE stream with their payload intact', async (t) => {
  const obs = await startNativeObs();
  t.after(() => obs.close());

  const client = new ObsDirectClient({ base: obs.base });
  const seen = [];
  client.on('event', (event) => seen.push(event));
  const sceneChanges = [];
  client.on('CurrentProgramSceneChanged', (data) => sceneChanges.push(data));

  await client.connect();
  t.after(() => client.disconnect());

  obs.emit('CurrentProgramSceneChanged', { sceneName: 'Intro', sceneUuid: 'uuid-1' }, 4);
  obs.emit('InputVolumeMeters', { inputs: [{ inputName: 'Mic', inputLevelsMul: [[0.5, 0.6, 0.6]] }] }, 1 << 16);

  await until(() => seen.length === 2);
  assert.deepEqual(sceneChanges, [{ sceneName: 'Intro', sceneUuid: 'uuid-1' }]);
  assert.equal(seen[1].eventType, 'InputVolumeMeters');
  assert.equal(seen[1].eventData.inputs[0].inputLevelsMul[0][0], 0.5);
  assert.equal(seen[1].eventIntent, 1 << 16);
});

test('malformed frames are ignored instead of breaking the stream', async (t) => {
  const obs = await startNativeObs();
  t.after(() => obs.close());

  const client = new ObsDirectClient({ base: obs.base });
  const problems = [];
  client.on('protocolError', (message) => problems.push(message));
  const sceneChanges = [];
  client.on('CurrentProgramSceneChanged', (data) => sceneChanges.push(data));

  await client.connect();
  t.after(() => client.disconnect());

  // A keep-alive comment, a truncated JSON frame and a frame with no type must
  // all be tolerated: one bad frame must not kill the stream.
  obs.raw(': ping\n\n');
  obs.raw('data: {"eventType":\n\n');
  obs.raw('data: {"eventData":{"sceneName":"typeless"}}\n\n');
  obs.emit('CurrentProgramSceneChanged', { sceneName: 'A' });
  await until(() => sceneChanges.length === 1);
  assert.equal(sceneChanges[0].sceneName, 'A');
  // Two bad frames, two reports - and the good frame still got through.
  assert.equal(problems.length, 2);
});

test('a dropped stream is reported and reconnected', async (t) => {
  const obs = await startNativeObs();
  t.after(() => obs.close());

  const client = new ObsDirectClient({ base: obs.base, reconnectBaseDelay: 20, reconnectMaxDelay: 50 });
  const reconnects = [];
  client.on('reconnecting', (info) => reconnects.push(info));
  const sceneChanges = [];
  client.on('CurrentProgramSceneChanged', (data) => sceneChanges.push(data));

  await client.connect();
  t.after(() => client.disconnect());

  obs.dropStreams();
  await until(() => reconnects.length >= 1);
  await until(() => client.connected);

  // The new stream is live.
  obs.emit('CurrentProgramSceneChanged', { sceneName: 'AfterRestart' });
  await until(() => sceneChanges.length >= 1);
  assert.equal(sceneChanges.at(-1).sceneName, 'AfterRestart');
});

test('getVersion() caches, and refresh forces a re-read', async (t) => {
  const obs = await startNativeObs();
  t.after(() => obs.close());

  const client = new ObsDirectClient({ base: obs.base });
  await client.connect();
  t.after(() => client.disconnect());

  const first = await client.getVersion();
  await client.getVersion();
  assert.equal(obs.calls.filter((call) => call.requestType === 'GetVersion').length, 1);

  await client.getVersion({ force: true });
  assert.equal(obs.calls.filter((call) => call.requestType === 'GetVersion').length, 2);
  assert.equal(first.obsVersion, '33.0.0');
});

test('a request before connect() is refused without touching the network', async () => {
  const client = new ObsDirectClient({ base: 'http://127.0.0.1:1/' });
  await assert.rejects(() => client.request('GetVersion'), ObsConnectionError);
});
