/*
 * Integration tests for the obs-websocket v5 client against the mock OBS
 * server: handshake, authentication, request/response, error mapping,
 * batches, event dispatch, timeouts and automatic reconnection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startMockObs } from './helpers/mock-obs.mjs';
import { startWsServer } from './helpers/ws-server.mjs';
import { ObsClient, ObsRequestError, ObsConnectionError } from '../src/obs-client.js';
import { REQUESTS, REQUEST_TYPES, EVENTS, EventSubscription } from '../src/protocol.js';

const connectClient = async (mock, options = {}) => {
  const client = new ObsClient({ url: mock.url, autoReconnect: false, ...options });
  await client.connect();
  return client;
};

const waitFor = (emitter, event, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeout);
    emitter.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

test('connects without authentication and completes the handshake', async (t) => {
  const mock = await startMockObs();
  t.after(() => mock.close());
  const client = await connectClient(mock);
  t.after(() => client.disconnect());

  assert.equal(client.connected, true);
  assert.equal(client.obsWebSocketVersion, '5.7.4');
  assert.equal(client.negotiatedRpcVersion, 1);
  assert.equal(client.status, 'connected');
});

test('authenticates with the correct password', async (t) => {
  const mock = await startMockObs({ password: 's3cret' });
  t.after(() => mock.close());
  const client = await connectClient(mock, { password: 's3cret' });
  t.after(() => client.disconnect());

  assert.equal(client.connected, true);
  const version = await client.getVersion();
  assert.equal(version.obsVersion, '33.0.0');
});

test('rejects a wrong password with close code 4009', async (t) => {
  const mock = await startMockObs({ password: 's3cret' });
  t.after(() => mock.close());
  const client = new ObsClient({ url: mock.url, password: 'wrong', autoReconnect: true });

  await assert.rejects(
    () => client.connect(),
    (err) => {
      assert.ok(err instanceof ObsConnectionError);
      assert.equal(err.code, 4009);
      assert.match(err.message, /Authentication failed/);
      return true;
    }
  );
  assert.equal(client.connected, false);
});

test('requires a password when the server asks for one', async (t) => {
  const mock = await startMockObs({ password: 's3cret' });
  t.after(() => mock.close());
  const client = new ObsClient({ url: mock.url, autoReconnect: false });

  await assert.rejects(
    () => client.connect(),
    (err) => err instanceof ObsConnectionError && err.code === 4009
  );
});

test('request/response round-trip returns responseData', async (t) => {
  const mock = await startMockObs();
  t.after(() => mock.close());
  const client = await connectClient(mock);
  t.after(() => client.disconnect());

  const data = await client.request('GetSceneList');
  assert.equal(data.currentProgramSceneName, 'Scene');
  assert.equal(data.scenes.length, 2);
  assert.equal(data.scenes[0].sceneName, 'Scene 2'); // reversed order, like OBS

  await client.request('SetCurrentProgramScene', { sceneName: 'Scene 2' });
  assert.equal(mock.state.programScene, 'Scene 2');
});

test('OBS request errors surface as ObsRequestError with code and comment', async (t) => {
  const mock = await startMockObs();
  t.after(() => mock.close());
  const client = await connectClient(mock);
  t.after(() => client.disconnect());

  await assert.rejects(
    () => client.request('GetSceneItemId', { sceneName: 'Scene', sourceName: 'nope' }),
    (err) => {
      assert.ok(err instanceof ObsRequestError);
      assert.equal(err.requestType, 'GetSceneItemId');
      assert.equal(err.code, 600);
      assert.match(err.comment, /No source was found/);
      return true;
    }
  );

  // Unknown request types are reported by OBS itself (code 204).
  await assert.rejects(
    () => client.request('NotARealRequest'),
    (err) => err instanceof ObsRequestError && err.code === 204
  );
});

test('requests fail fast when the client is not connected', async () => {
  const client = new ObsClient({ url: 'ws://127.0.0.1:1', autoReconnect: false });
  await assert.rejects(() => client.request('GetVersion'), (err) => err instanceof ObsConnectionError);
});

test('batched requests resolve with per-request results', async (t) => {
  const mock = await startMockObs();
  t.after(() => mock.close());
  const client = await connectClient(mock);
  t.after(() => client.disconnect());

  const results = await client.requestBatch([
    { requestType: 'GetVersion' },
    { requestType: 'GetSceneList' },
    { requestType: 'GetSceneItemId', requestData: { sceneName: 'Scene', sourceName: 'nope' } },
  ]);

  assert.equal(results.length, 3);
  assert.equal(results[0].requestStatus.result, true);
  assert.equal(results[1].responseData.currentProgramSceneName, 'Scene');
  assert.equal(results[2].requestStatus.result, false);
  assert.equal(results[2].requestStatus.code, 600);
});

test('forwards OBS events and tracks their payload', async (t) => {
  const mock = await startMockObs();
  t.after(() => mock.close());
  const client = await connectClient(mock);
  t.after(() => client.disconnect());

  const seen = [];
  client.on('CurrentProgramSceneChanged', (data) => seen.push(data.sceneName));
  const wildcard = [];
  client.on('event', (evt) => wildcard.push(evt.eventType));

  mock.emit('CurrentProgramSceneChanged', { sceneName: 'Scene 2' });
  mock.emit('StudioModeStateChanged', { studioModeEnabled: true });
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(seen, ['Scene 2']);
  assert.deepEqual(wildcard, ['CurrentProgramSceneChanged', 'StudioModeStateChanged']);
});

test('volume meter events can be subscribed to', async (t) => {
  const mock = await startMockObs();
  t.after(() => mock.close());
  const client = await connectClient(mock, {
    eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters,
  });
  t.after(() => client.disconnect());

  const meters = waitFor(client, 'InputVolumeMeters');
  mock.emit('InputVolumeMeters', { inputs: [{ inputName: 'Display Capture', inputLevelsMul: [[0.5, 0.5]] }] });
  const data = await meters;
  assert.equal(data.inputs[0].inputName, 'Display Capture');
});

test('requests time out instead of hanging forever', async (t) => {
  const server = await startWsServer((conn) => {
    conn.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.7.4', rpcVersion: 1 } }));
    conn.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.op === 1) conn.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      // Deliberately never answer op 6.
    });
  });
  t.after(() => server.close());

  const client = new ObsClient({ url: server.url, autoReconnect: false, requestTimeout: 150 });
  await client.connect();
  t.after(() => client.disconnect());

  await assert.rejects(
    () => client.request('GetVersion'),
    (err) => err instanceof ObsConnectionError && /timed out/.test(err.message)
  );
});

test('reconnects automatically after the server drops the connection', async (t) => {
  const mock = await startMockObs();
  t.after(() => mock.close());

  const client = new ObsClient({
    url: mock.url,
    autoReconnect: true,
    reconnectBaseDelay: 40,
    reconnectMaxDelay: 80,
  });
  await client.connect();
  t.after(() => client.disconnect());

  const reconnected = waitFor(client, 'connected', 4000);
  mock.dropConnection();
  const info = await reconnected;

  assert.equal(client.connected, true);
  assert.equal(info.obsWebSocketVersion, '5.7.4');
  // The client is usable again after reconnecting.
  const data = await client.request('GetSceneList');
  assert.equal(data.currentProgramSceneName, 'Scene');
});

test('disconnect() does not trigger reconnection', async (t) => {
  const mock = await startMockObs();
  t.after(() => mock.close());
  const client = await connectClient(mock);

  let reconnected = false;
  client.on('connected', () => (reconnected = true));
  client.disconnect();
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(client.connected, false);
  assert.equal(reconnected, false);
  assert.equal(client.status, 'disconnected');
});

test('request validation catches typos before they reach OBS', () => {
  assert.deepEqual(ObsClient.validate('GetSceneList', {}, REQUESTS), { ok: true });
  assert.deepEqual(ObsClient.validate('SetCurrentProgramScene', { sceneName: 'Scene' }, REQUESTS), { ok: true });
  assert.deepEqual(ObsClient.validate('SetCurrentSceneCollection', { sceneCollectionName: 'X' }, REQUESTS), { ok: true });

  // Every request must supply its non-optional fields.
  const missing = ObsClient.validate('SetCurrentSceneCollection', {}, REQUESTS);
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /missing required field "sceneCollectionName"/);

  const missingHotkey = ObsClient.validate('TriggerHotkeyByName', {}, REQUESTS);
  assert.equal(missingHotkey.ok, false);
  assert.match(missingHotkey.errors[0], /missing required field "hotkeyName"/);

  // Misspelled fields are rejected instead of being silently ignored by OBS.
  const unknown = ObsClient.validate('GetSceneList', { sceneNmae: 'x' }, REQUESTS);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors[0], /unknown field "sceneNmae"/);

  // OBS marks either/or pairs (sceneName vs sceneUuid) as optional, so they
  // must not be reported as missing.
  assert.deepEqual(ObsClient.validate('SetCurrentProgramScene', { sceneUuid: 'abc' }, REQUESTS), { ok: true });

  const unknownRequest = ObsClient.validate('Nope', {}, REQUESTS);
  assert.equal(unknownRequest.ok, false);
  assert.match(unknownRequest.errors[0], /Unknown request type/);
});

test('protocol metadata is complete and consistent', () => {
  assert.equal(REQUEST_TYPES.length, 147);
  for (const type of REQUEST_TYPES) {
    assert.ok(Array.isArray(REQUESTS[type].fields), `${type} has fields`);
    assert.equal(typeof REQUESTS[type].category, 'string', `${type} has category`);
  }
  for (const type of Object.keys(EVENTS)) {
    assert.ok(Array.isArray(EVENTS[type].fields), `${type} has eventFields`);
  }
  assert.equal(EventSubscription.All, 4095);
  assert.ok(REQUEST_TYPES.includes('GetSourceScreenshot'));
  assert.ok(REQUEST_TYPES.includes('TriggerStudioModeTransition'));
  assert.ok(REQUEST_TYPES.includes('SetInputVolume'));
});
