#!/usr/bin/env node
/*
 * WebMIX native live check.
 *
 * Exercises the in-process control service on a *running* OBS - no
 * obs-websocket, no mocks - over the same HTTP + SSE channel the browser uses:
 *
 *   1. /api/status advertises the native channel
 *   2. every request type the UI needs is implemented
 *   3. the read requests return the shapes the UI renders
 *   4. writes really change OBS and the matching event arrives on the stream
 *   5. a batch runs in one round trip, failures included
 *   6. volume meters actually reach the browser
 *
 * Usage:
 *   obs --web --web-port 4470 &
 *   node tools/native-live-check.mjs [--base http://127.0.0.1:4470/]
 */
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const BASE = getArg('base', process.env.WEBMIX_BASE ?? 'http://127.0.0.1:4470/');

let passed = 0;
let failed = 0;

function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log(`ok   ${label}`);
  } else {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** POST one request and return the whole response envelope. */
async function request(requestType, requestData = {}) {
  const response = await fetch(new URL('api/obs/request', BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType, requestData }),
  });
  if (!response.ok) throw new Error(`${requestType}: HTTP ${response.status}`);
  return response.json();
}

/** POST a request and return responseData, throwing on a refused request. */
async function call(requestType, requestData = {}) {
  const payload = await request(requestType, requestData);
  if (!payload.requestStatus?.result) {
    throw new Error(`${requestType} refused: ${payload.requestStatus?.comment ?? payload.requestStatus?.code}`);
  }
  return payload.responseData ?? {};
}

/* ------------------------------------------------------------------ stream */

/** Subscribe to the event stream; returns a collector plus a stop function. */
async function openEvents() {
  const controller = new AbortController();
  const response = await fetch(new URL('api/obs/events', BASE), {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`event stream refused (HTTP ${response.status})`);

  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // A server that closes the stream is as fatal as one that errors:
          // every later event check would silently become a false negative.
          if (!controller.signal.aborted) console.log('     (event stream closed by the server)');
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              events.push(JSON.parse(line.slice(5).trim()));
            } catch {
              /* ignore malformed frames, like the client does */
            }
          }
        }
      }
    } catch (error) {
      // A stream that ends early would silently turn every later event check
      // into a false negative, so say so.
      if (!controller.signal.aborted) {
        console.log(`     (event stream ended: ${error.message})`);
      }
    }
  })();

  return {
    events,
    /** The current stream position, so a later wait only sees new events. */
    mark: () => events.length,
    /**
     * Wait for one event type to show up after `from`.
     *
     * The stream is live and OBS emits the same event types at startup (a
     * program scene change, a scene removal), so searching the whole backlog
     * would happily return a stale event and hide a real regression.
     */
    async waitFor(eventType, { from = 0, timeout = 4000 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = events.slice(from).find((event) => event.eventType === eventType);
        if (found) return found;
        await delay(25);
      }
      const after = events.slice(from).map((event) => event.eventType);
      const unique = [...new Set(after)];
      console.log(
        `     (waited ${timeout}ms for ${eventType}; ${after.length} frames arrived meanwhile: ${
          unique.slice(0, 6).join(', ') || 'none'
        })`
      );
      return null;
    },
    stop: () => controller.abort(),
  };
}

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(`WebMIX native live check against ${BASE}\n`);

  const status = await (await fetch(new URL('api/status', BASE))).json();
  check(status.webmix === true, 'the host identifies itself as WebMIX');
  check(status.obsControl === true, 'the host offers the native control channel', status);
  check(typeof status.obsRequestTypes === 'number' && status.obsRequestTypes > 0, 'it reports a request vocabulary', status.obsRequestTypes);

  const listed = await (await fetch(new URL('api/obs/requests', BASE))).json();
  const implemented = new Set(listed.requests ?? []);
  check(implemented.size > 0, `the request list is populated (${implemented.size} types)`);

  /* What the web frontend actually calls (see web/src/api.js). Missing any of
   * these means a dock would break, so they are asserted by name. */
  const required = [
    'GetVersion', 'GetStats', 'GetSceneList', 'GetInputList', 'GetSceneItemList',
    'GetSceneTransitionList', 'GetCurrentSceneTransition', 'GetStudioModeEnabled',
    'GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus', 'GetVirtualCamStatus',
    'GetSceneCollectionList', 'GetProfileList', 'GetVideoSettings', 'GetHotkeyList',
    'GetInputVolume', 'GetInputMute', 'GetInputAudioTracks', 'GetInputAudioMonitorType',
    'GetInputAudioSyncOffset', 'GetInputAudioBalance', 'GetSourceFilterList',
    'GetInputSettings', 'GetInputKindList', 'GetInputDefaultSettings',
    'SetCurrentProgramScene', 'CreateScene', 'RemoveScene', 'SetSceneName',
    'CreateInput', 'RemoveInput', 'SetInputName', 'SetInputMute', 'SetInputVolume',
    'CreateSceneItem', 'RemoveSceneItem', 'DuplicateSceneItem', 'SetSceneItemTransform',
    'CreateSourceFilter', 'RemoveSourceFilter', 'SetSourceFilterEnabled',
    'SetCurrentSceneTransition', 'SetCurrentSceneTransitionDuration',
    'SetStudioModeEnabled', 'TriggerStudioModeTransition',
    'StartStream', 'StopStream', 'StartRecord', 'StartReplayBuffer', 'StartVirtualCam',
    'GetSourceScreenshot', 'TriggerHotkeyByName', 'OpenInputPropertiesDialog',
  ];
  const missing = required.filter((type) => !implemented.has(type));
  check(missing.length === 0, `every request the UI calls is implemented (${required.length} checked)`, missing);

  /* ---- reads ------------------------------------------------------------ */

  const version = await call('GetVersion');
  check(typeof version.obsVersion === 'string' && version.obsVersion.length > 0, 'GetVersion reports the OBS version', version.obsVersion);

  const sceneList = await call('GetSceneList');
  /* Everything below is a write; remember where the program was so the run
   * leaves the instance exactly as it found it. */
  const programBefore = sceneList.currentProgramSceneName;
  /* Studio mode changes what a program-scene switch means, so a run that dies
   * half way through would leave the instance in a state that makes every
   * later check behave oddly. Capture it and restore at the end. */
  const studioBefore = (await call('GetStudioModeEnabled')).studioModeEnabled === true;
  check(Array.isArray(sceneList.scenes), 'GetSceneList returns a scenes array');
  check(typeof sceneList.currentProgramSceneName === 'string', 'GetSceneList reports the program scene', sceneList.currentProgramSceneName);
  check(
    (sceneList.scenes ?? []).every((scene) => typeof scene.sceneName === 'string' && typeof scene.sceneIndex === 'number'),
    'each scene carries a name and a display index'
  );

  const inputs = await call('GetInputList');
  check(Array.isArray(inputs.inputs), 'GetInputList returns an inputs array');

  const video = await call('GetVideoSettings');
  check(video.baseWidth > 0 && video.baseHeight > 0, 'GetVideoSettings reports the canvas size', `${video.baseWidth}x${video.baseHeight}`);
  check(video.fpsNumerator > 0 && video.fpsDenominator > 0, 'GetVideoSettings reports the frame rate', `${video.fpsNumerator}/${video.fpsDenominator}`);

  const stats = await call('GetStats');
  check(typeof stats.activeFps === 'number', 'GetStats reports the active FPS', stats.activeFps);

  const transitions = await call('GetSceneTransitionList');
  check(Array.isArray(transitions.transitions) && transitions.transitions.length > 0, 'GetSceneTransitionList lists the built-in transitions');
  check(transitions.currentSceneTransitionName !== undefined, 'the current transition is reported');

  const sceneName = sceneList.currentProgramSceneName;
  const items = await call('GetSceneItemList', { sceneName });
  check(Array.isArray(items.sceneItems), 'GetSceneItemList returns the items of the program scene');
  const transformed = (items.sceneItems ?? []).filter((item) => item.sceneItemTransform);
  check(
    transformed.every((item) => typeof item.sceneItemTransform.boundsType === 'string'),
    'scene item transforms spell boundsType as a name (dialogs.js selects on it)',
    transformed[0]?.sceneItemTransform?.boundsType
  );

  const profiles = await call('GetProfileList');
  check(Array.isArray(profiles.profiles) && typeof profiles.currentProfileName === 'string', 'GetProfileList reports the active profile');
  const collections = await call('GetSceneCollectionList');
  check(Array.isArray(collections.sceneCollections), 'GetSceneCollectionList lists the collections');
  const hotkeys = await call('GetHotkeyList');
  check(Array.isArray(hotkeys.hotkeys) && hotkeys.hotkeys.every((name) => typeof name === 'string'), 'GetHotkeyList returns names, like the fallback transport');

  /* ---- events + writes --------------------------------------------------- */

  const stream = await openEvents();
  try {
    check(true, 'the SSE event stream opens');

    // A scene created from the API must appear both as an event and in the list.
    let mark = stream.mark();
    const created = await call('CreateScene', { sceneName: 'WebMIX live check' });
    check(created !== undefined, 'CreateScene succeeds');

    const createdEvent = await stream.waitFor('SceneCreated', { from: mark });
    check(!!createdEvent, 'SceneCreated arrives on the event stream');
    check(createdEvent?.eventData?.sceneName === 'WebMIX live check', 'the SceneCreated payload names the scene', createdEvent?.eventData);

    const listChanged = await stream.waitFor('SceneListChanged', { from: mark });
    check(!!listChanged, 'SceneListChanged follows it');
    check(
      (listChanged?.eventData?.scenes ?? []).some((scene) => scene.sceneName === 'WebMIX live check'),
      'the SceneListChanged payload contains the new scene'
    );

    mark = stream.mark();
    const renamed = await call('SetSceneName', { sceneName: 'WebMIX live check', newSceneName: 'WebMIX live check 2' });
    check(renamed !== undefined, 'SetSceneName succeeds');
    const renamedEvent = await stream.waitFor('SceneNameChanged', { from: mark });
    check(renamedEvent?.eventData?.oldSceneName === 'WebMIX live check', 'SceneNameChanged carries the old name', renamedEvent?.eventData);
    check(renamedEvent?.eventData?.sceneName === 'WebMIX live check 2', 'SceneNameChanged carries the new name');

    // Switching programs must be visible, and it is what the preview pane keys on.
    mark = stream.mark();
    const switched = await call('SetCurrentProgramScene', { sceneName: 'WebMIX live check 2' });
    check(switched !== undefined, 'SetCurrentProgramScene succeeds');
    const programEvent = await stream.waitFor('CurrentProgramSceneChanged', { from: mark });
    check(programEvent?.eventData?.sceneName === 'WebMIX live check 2', 'CurrentProgramSceneChanged reports the new program scene', programEvent?.eventData);

    // Studio mode is the one piece of UI state OBS owns directly.
    mark = stream.mark();
    await call('SetStudioModeEnabled', { studioModeEnabled: true });
    const studioEvent = await stream.waitFor('StudioModeStateChanged', { from: mark });
    check(studioEvent?.eventData?.studioModeEnabled === true, 'StudioModeStateChanged reports studio mode on');
    await call('SetStudioModeEnabled', { studioModeEnabled: false });

    // Refusals must be reported, not thrown away.
    const duplicate = await request('CreateScene', { sceneName: 'WebMIX live check 2' });
    check(duplicate.requestStatus.result === false, 'creating a duplicate scene is refused');
    check(typeof duplicate.requestStatus.comment === 'string' && duplicate.requestStatus.comment.length > 0, 'the refusal carries a comment', duplicate.requestStatus.comment);

    const unknown = await request('NoSuchRequest', {});
    check(unknown.requestStatus.result === false, 'an unknown request type is refused cleanly', unknown.requestStatus);

    // Restore the scene collection.
    mark = stream.mark();
    await call('RemoveScene', { sceneName: 'WebMIX live check 2' });
    const removedEvent = await stream.waitFor('SceneRemoved', { from: mark });
    check(removedEvent?.eventData?.sceneName === 'WebMIX live check 2', 'SceneRemoved arrives after the scene is gone');

    /* ---- audio ---------------------------------------------------------- */

    const audioInput = (inputs.inputs ?? [])[0];
    if (audioInput) {
      const volume = await call('GetInputVolume', { inputName: audioInput.inputName });
      check(typeof volume.inputVolumeMul === 'number', 'GetInputVolume reports a multiplier', volume);

      const before = await call('GetInputMute', { inputName: audioInput.inputName });
      mark = stream.mark();
      await call('SetInputMute', { inputName: audioInput.inputName, inputMuted: !before.inputMuted });
      const muteEvent = await stream.waitFor('InputMuteStateChanged', { from: mark });
      check(!!muteEvent, 'InputMuteStateChanged arrives after SetInputMute');
      await call('SetInputMute', { inputName: audioInput.inputName, inputMuted: before.inputMuted });

      const tracks = await call('GetInputAudioTracks', { inputName: audioInput.inputName });
      check(tracks.inputAudioTracks && typeof tracks.inputAudioTracks === 'object', 'GetInputAudioTracks returns the track map', tracks.inputAudioTracks);

      // Meters are the highest-volume event; they must actually flow.
      mark = stream.mark();
      await delay(400);
      const meters = await stream.waitFor('InputVolumeMeters', { from: mark, timeout: 3000 });
      check(!!meters, 'InputVolumeMeters reaches the browser');
      check(Array.isArray(meters?.eventData?.inputs), 'the meter payload is an array of inputs');
    } else {
      console.log('skip audio checks (OBS has no inputs)');
    }

    /* ---- inputs and scene items: the write paths the UI drives ---------- */

    const firstInput = (inputs.inputs ?? [])[0];
    if (firstInput) {
      const settings = await call('GetInputSettings', { inputName: firstInput.inputName });
      check(
        settings.inputSettings && typeof settings.inputSettings === 'object',
        'GetInputSettings returns a settings object'
      );
      // Round-trip: whatever OBS reported must be accepted back unchanged.
      await call('SetInputSettings', {
        inputName: firstInput.inputName,
        inputSettings: settings.inputSettings,
        overlay: true,
      });
      check(true, 'SetInputSettings accepts the settings it just returned');
    }

    const shot = await call('GetSourceScreenshot', {
      sourceName: sceneName,
      imageFormat: 'jpg',
      imageWidth: 160,
      imageHeight: 90,
    });
    check(
      typeof shot.imageData === 'string' && shot.imageData.startsWith('data:image/jpeg;base64,'),
      'GetSourceScreenshot returns a JPEG data URL'
    );

    /* Unique names: a run that dies before its cleanup would otherwise wedge
     * every later run with "a source already exists by that input name" - and
     * that is exactly the state a broken RemoveInput leaves behind. */
    const suffix = Date.now().toString(36);
    const itemScene = `WebMIX item check ${suffix}`;
    const itemSource = `WebMIX colour ${suffix}`;
    await call('CreateScene', { sceneName: itemScene });
    try {
      await call('CreateInput', {
        sceneName: itemScene,
        inputName: itemSource,
        inputKind: 'color_source_v3',
        inputSettings: {},
      });
      const created = await call('GetSceneItemList', { sceneName: itemScene });
      check(created.sceneItems?.length === 1, 'CreateInput adds the source to the scene', created.sceneItems?.length);

      const itemId = created.sceneItems[0].sceneItemId;
      await call('SetSceneItemTransform', {
        sceneName: itemScene,
        sceneItemId: itemId,
        sceneItemTransform: { positionX: 42, positionY: 24, scaleX: 1.5, scaleY: 1.5 },
      });
      const transform = await call('GetSceneItemTransform', { sceneName: itemScene, sceneItemId: itemId });
      check(
        transform.sceneItemTransform?.positionX === 42 && transform.sceneItemTransform?.scaleX === 1.5,
        'SetSceneItemTransform round-trips through GetSceneItemTransform',
        transform.sceneItemTransform
      );

      mark = stream.mark();
      await call('SetSceneItemEnabled', { sceneName: itemScene, sceneItemId: itemId, sceneItemEnabled: false });
      const itemEvent = await stream.waitFor('SceneItemEnableStateChanged', { from: mark });
      check(
        itemEvent?.eventData?.sceneItemId === itemId && itemEvent?.eventData?.sceneItemEnabled === false,
        'SceneItemEnableStateChanged reports the change',
        itemEvent?.eventData
      );

      const filters = await call('GetSourceFilterList', { sourceName: itemSource });
      check(Array.isArray(filters.filters), 'GetSourceFilterList works on a scene item source');

      /* Deleting a source is a delete, not a flag: the desktop UI prunes the
       * scene items that hold it, and without that the source survives forever
       * and keeps showing up in every list. */
      const removedOk = await call('RemoveInput', { inputName: itemSource });
      check(removedOk !== undefined, 'RemoveInput is accepted');
      const inputsAfter = await call('GetInputList');
      check(
        !(inputsAfter.inputs ?? []).some((i) => i.inputName === itemSource),
        'RemoveInput takes the source out of the input list',
        (inputsAfter.inputs ?? []).map((i) => i.inputName)
      );
      /* libobs keeps a removed source alive while the desktop undo stack holds
       * a reference, so "gone from the list" is not enough on its own: it must
       * also stop being addressable, or a delete would look like it worked and
       * then a reload would bring the source back. */
      const gone = await request('GetInputVolume', { inputName: itemSource });
      check(gone.requestStatus.result === false, 'and it stops being addressable', gone.requestStatus);
      const itemsAfter = await call('GetSceneItemList', { sceneName: itemScene });
      check(
        !(itemsAfter.sceneItems ?? []).some((i) => i.sourceName === itemSource),
        'RemoveInput also drops the scene items that referenced it',
        itemsAfter.sceneItems
      );
    } finally {
      await call('RemoveScene', { sceneName: itemScene }).catch(() => {});
      // The source outlives the scene, so delete it explicitly - the check must
      // leave the instance exactly as it found it.
      await call('RemoveInput', { inputName: itemSource }).catch(() => {});
    }

    /* ---- batch ---------------------------------------------------------- */

    const batchResponse = await fetch(new URL('api/obs/batch', BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          { requestType: 'GetVersion' },
          { requestType: 'GetVideoSettings' },
          { requestType: 'NoSuchRequest' },
        ],
      }),
    });
    const batch = await batchResponse.json();
    check(batch.results?.length === 3, 'a batch returns one result per request');
    check(batch.results[0].requestStatus.result === true && typeof batch.results[0].responseData.obsVersion === 'string', 'batch entry 1 succeeded');
    check(batch.results[1].responseData.baseWidth > 0, 'batch entry 2 carries its own data');
    check(batch.results[2].requestStatus.result === false, 'a failing batch entry does not fail the batch');
  } finally {
    stream.stop();
  }

  await call('SetStudioModeEnabled', { studioModeEnabled: studioBefore }).catch(() => {});
  if (programBefore) {
    await call('SetCurrentProgramScene', { sceneName: programBefore }).catch(() => {});
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n${error.stack ?? error}`);
  console.error(`\nIs OBS running with --web on ${BASE}?`);
  process.exit(2);
});
