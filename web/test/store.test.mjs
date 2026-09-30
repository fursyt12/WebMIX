/*
 * Unit tests for the store: OBS event reducers, topic mapping and batching.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Store, createState, reduceEvent, topicsForEvent, Topic, selectors } from '../src/store.js';

test('createState starts disconnected and empty', () => {
  const state = createState();
  assert.equal(state.connection.status, 'disconnected');
  assert.deepEqual(state.scenes, []);
  assert.equal(state.studioMode, false);
  assert.equal(state.outputs.streaming.active, false);
});

test('scene lifecycle events keep the scene list in sync', () => {
  const state = createState();

  reduceEvent(state, 'SceneCreated', { sceneName: 'Intro', isGroup: false });
  reduceEvent(state, 'SceneCreated', { sceneName: 'Game', isGroup: false });
  assert.deepEqual(state.scenes.map((s) => s.sceneName), ['Game', 'Intro']);
  assert.ok(state.sceneItems.Intro);

  reduceEvent(state, 'SceneNameChanged', { oldSceneName: 'Intro', sceneName: 'Outro' });
  assert.ok(state.scenes.some((s) => s.sceneName === 'Outro'));
  assert.ok(!state.scenes.some((s) => s.sceneName === 'Intro'));

  reduceEvent(state, 'SceneRemoved', { sceneName: 'Outro', isGroup: false });
  assert.deepEqual(state.scenes.map((s) => s.sceneName), ['Game']);
  assert.equal(state.sceneItems.Outro, undefined);
});

test('SceneListChanged replaces the whole list (authoritative refresh)', () => {
  const state = createState();
  reduceEvent(state, 'SceneListChanged', {
    scenes: [
      { sceneName: 'Top', sceneIndex: 1 },
      { sceneName: 'Bottom', sceneIndex: 0 },
    ],
  });
  assert.deepEqual(state.scenes.map((s) => s.sceneName), ['Top', 'Bottom']);
});

test('program/preview scene changes and studio mode', () => {
  const state = createState();
  reduceEvent(state, 'CurrentProgramSceneChanged', { sceneName: 'Game' });
  assert.equal(state.currentProgramScene, 'Game');

  reduceEvent(state, 'StudioModeStateChanged', { studioModeEnabled: true });
  assert.equal(state.studioMode, true);

  reduceEvent(state, 'CurrentPreviewSceneChanged', { sceneName: 'Intro' });
  assert.equal(selectors.previewPaneScene(state), 'Intro');
  assert.equal(selectors.programPaneScene(state), 'Game');

  // Before OBS reports a preview scene, Studio Mode previews the program scene.
  const fresh = createState();
  reduceEvent(fresh, 'CurrentProgramSceneChanged', { sceneName: 'Game' });
  reduceEvent(fresh, 'StudioModeStateChanged', { studioModeEnabled: true });
  assert.equal(fresh.currentPreviewScene, null);
  assert.equal(selectors.previewPaneScene(fresh), 'Game');

  // Leaving studio mode clears the preview scene, like OBS does.
  reduceEvent(state, 'StudioModeStateChanged', { studioModeEnabled: false });
  assert.equal(state.currentPreviewScene, null);
  assert.equal(selectors.previewPaneScene(state), 'Game');
});

test('scene item events are applied and kept sorted by index', () => {
  const state = createState();
  reduceEvent(state, 'SceneCreated', { sceneName: 'Scene' });
  reduceEvent(state, 'SceneItemCreated', { sceneName: 'Scene', sceneItemId: 5, sourceName: 'A', sceneItemIndex: 2 });
  reduceEvent(state, 'SceneItemCreated', { sceneName: 'Scene', sceneItemId: 6, sourceName: 'B', sceneItemIndex: 0 });
  assert.deepEqual(state.sceneItems.Scene.map((i) => i.sceneItemId), [6, 5]);

  reduceEvent(state, 'SceneItemEnableStateChanged', { sceneName: 'Scene', sceneItemId: 5, sceneItemEnabled: false });
  assert.equal(state.sceneItems.Scene.find((i) => i.sceneItemId === 5).sceneItemEnabled, false);

  reduceEvent(state, 'SceneItemLockStateChanged', { sceneName: 'Scene', sceneItemId: 6, sceneItemLocked: true });
  assert.equal(state.sceneItems.Scene.find((i) => i.sceneItemId === 6).sceneItemLocked, true);

  reduceEvent(state, 'SceneItemListReindexed', {
    sceneName: 'Scene',
    sceneItems: [
      { sceneItemId: 5, sceneItemIndex: 0 },
      { sceneItemId: 6, sceneItemIndex: 1 },
    ],
  });
  assert.deepEqual(state.sceneItems.Scene.map((i) => i.sceneItemId), [5, 6]);

  reduceEvent(state, 'SceneItemRemoved', { sceneName: 'Scene', sceneItemId: 5 });
  assert.deepEqual(state.sceneItems.Scene.map((i) => i.sceneItemId), [6]);
});

test('input and audio events update the mixer state', () => {
  const state = createState();
  reduceEvent(state, 'InputCreated', { inputName: 'Mic', inputKind: 'wasapi_input_capture' });
  assert.equal(state.inputs.Mic.inputKind, 'wasapi_input_capture');

  reduceEvent(state, 'InputVolumeChanged', { inputName: 'Mic', inputVolumeMul: 0.5, inputVolumeDb: -6.02 });
  assert.equal(state.audio.Mic.volumeMul, 0.5);
  assert.equal(state.audio.Mic.volumeDb, -6.02);

  reduceEvent(state, 'InputMuteStateChanged', { inputName: 'Mic', inputMuted: true });
  assert.equal(state.audio.Mic.muted, true);

  reduceEvent(state, 'InputAudioTracksChanged', { inputName: 'Mic', inputAudioTracks: { 1: true, 2: false } });
  assert.deepEqual(state.audio.Mic.tracks, { 1: true, 2: false });

  reduceEvent(state, 'InputAudioMonitorTypeChanged', { inputName: 'Mic', monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' });
  assert.equal(state.audio.Mic.monitorType, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');

  reduceEvent(state, 'InputVolumeMeters', {
    inputs: [{ inputName: 'Mic', inputLevelsMul: [[0.25, 0.3, 0.1, 0.05]] }],
  });
  assert.deepEqual(state.audio.Mic.levels, [[0.25, 0.3, 0.1, 0.05]]);

  // Renaming a source follows through to audio + scene items.
  reduceEvent(state, 'InputNameChanged', { oldInputName: 'Mic', inputName: 'Microphone' });
  assert.equal(state.inputs.Microphone.inputKind, 'wasapi_input_capture');
  assert.equal(state.audio.Microphone.volumeMul, 0.5);
  assert.equal(state.audio.Mic, undefined);
});

test('renaming an input updates scene items that reference it', () => {
  const state = createState();
  reduceEvent(state, 'SceneCreated', { sceneName: 'Scene' });
  reduceEvent(state, 'InputCreated', { inputName: 'Webcam', inputKind: 'v4l2_input' });
  reduceEvent(state, 'SceneItemCreated', { sceneName: 'Scene', sceneItemId: 1, sourceName: 'Webcam', sceneItemIndex: 0 });
  reduceEvent(state, 'InputNameChanged', { oldInputName: 'Webcam', inputName: 'Camera' });
  assert.equal(state.sceneItems.Scene[0].sourceName, 'Camera');
});

test('filter events maintain the per-source filter list', () => {
  const state = createState();
  reduceEvent(state, 'SourceFilterCreated', { sourceName: 'Cam', filterName: 'Color', filterKind: 'color_filter_v2', filterIndex: 1 });
  reduceEvent(state, 'SourceFilterCreated', { sourceName: 'Cam', filterName: 'Sharpen', filterKind: 'sharpness_filter_v2', filterIndex: 0 });
  assert.deepEqual(state.filters.Cam.map((f) => f.filterName), ['Sharpen', 'Color']);

  reduceEvent(state, 'SourceFilterEnableStateChanged', { sourceName: 'Cam', filterName: 'Color', filterEnabled: false });
  assert.equal(state.filters.Cam.find((f) => f.filterName === 'Color').filterEnabled, false);

  reduceEvent(state, 'SourceFilterSettingsChanged', { sourceName: 'Cam', filterName: 'Color', filterSettings: { gamma: 2 } });
  assert.deepEqual(state.filters.Cam.find((f) => f.filterName === 'Color').filterSettings, { gamma: 2 });

  reduceEvent(state, 'SourceFilterNameChanged', { sourceName: 'Cam', oldFilterName: 'Color', filterName: 'Colour' });
  assert.ok(state.filters.Cam.some((f) => f.filterName === 'Colour'));

  reduceEvent(state, 'SourceFilterRemoved', { sourceName: 'Cam', filterName: 'Sharpen' });
  assert.deepEqual(state.filters.Cam.map((f) => f.filterName), ['Colour']);
});

test('output state events are tracked for stream/record/replay/vcam', () => {
  const state = createState();
  reduceEvent(state, 'StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  assert.equal(state.outputs.streaming.active, true);

  reduceEvent(state, 'RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  assert.equal(state.outputs.recording.active, true);
  reduceEvent(state, 'RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_PAUSED' });
  assert.equal(state.outputs.recording.paused, true);
  reduceEvent(state, 'RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: '/tmp/x.mkv' });
  assert.equal(state.outputs.recording.active, false);
  assert.equal(state.outputs.recording.path, '/tmp/x.mkv');

  reduceEvent(state, 'ReplayBufferStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  assert.equal(state.outputs.replayBuffer.active, true);
  reduceEvent(state, 'ReplayBufferSaved', { savedReplayPath: '/tmp/replay.mkv' });
  assert.equal(state.outputs.replayBuffer.lastReplayPath, '/tmp/replay.mkv');

  reduceEvent(state, 'VirtualcamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  assert.equal(state.outputs.virtualCam.active, true);
});

test('transition events update the current transition', () => {
  const state = createState();
  reduceEvent(state, 'CurrentSceneTransitionChanged', { transitionName: 'Fade' });
  assert.equal(state.currentTransition.transitionName, 'Fade');
  reduceEvent(state, 'CurrentSceneTransitionDurationChanged', { transitionDuration: 500 });
  assert.equal(state.currentTransition.transitionDuration, 500);
  reduceEvent(state, 'SceneTransitionStarted', { transitionName: 'Fade' });
  assert.equal(state.transitionActive, true);
  reduceEvent(state, 'SceneTransitionEnded', { transitionName: 'Fade' });
  assert.equal(state.transitionActive, false);
});

test('config events update profile and scene collection lists', () => {
  const state = createState();
  reduceEvent(state, 'ProfileListChanged', { profiles: ['Untitled', 'Streaming'] });
  reduceEvent(state, 'CurrentProfileChanged', { profileName: 'Streaming' });
  assert.deepEqual(state.profiles, { current: 'Streaming', list: ['Untitled', 'Streaming'] });

  reduceEvent(state, 'SceneCollectionListChanged', { sceneCollections: ['Main', 'Podcast'] });
  reduceEvent(state, 'CurrentSceneCollectionChanged', { sceneCollectionName: 'Podcast' });
  assert.deepEqual(state.sceneCollections, { current: 'Podcast', list: ['Main', 'Podcast'] });
});

test('unknown events are ignored without throwing', () => {
  const state = createState();
  assert.equal(reduceEvent(state, 'SomethingBrandNew', { x: 1 }), false);
  assert.equal(reduceEvent(state, 'InputVolumeMeters', {}), true);
});

test('topicsForEvent maps events to the panels that must re-render', () => {
  assert.deepEqual(topicsForEvent('InputVolumeMeters'), [Topic.Audio]);
  assert.ok(topicsForEvent('SceneItemCreated').includes(Topic.SceneItems));
  assert.deepEqual(topicsForEvent('NotAnEvent'), []);
});

test('store notifies subscribers by topic and batches updates', () => {
  const store = new Store();
  const calls = [];
  store.subscribe((state, topics) => calls.push([...topics].sort()));

  store.applyEvent('InputMuteStateChanged', { inputName: 'Mic', inputMuted: true });
  assert.deepEqual(calls.at(-1), [Topic.Audio]);

  calls.length = 0;
  store.batch(() => {
    store.applyEvent('InputMuteStateChanged', { inputName: 'Mic', inputMuted: false });
    store.applyEvent('InputVolumeChanged', { inputName: 'Mic', inputVolumeMul: 1, inputVolumeDb: 0 });
    store.applyEvent('SceneCreated', { sceneName: 'X' });
  });
  assert.equal(calls.length, 1, 'batch collapses notifications into one pass');
  assert.deepEqual(calls[0], [Topic.Audio, Topic.Scenes].sort());

  store.patch({ studioMode: true }, Topic.Ui);
  assert.deepEqual(calls.at(-1), [Topic.Ui]);
});

test('store listener errors do not break other listeners', () => {
  const store = new Store();
  const seen = [];
  store.subscribe(() => {
    throw new Error('boom');
  });
  store.subscribe(() => seen.push('second'));
  store.applyEvent('SceneCreated', { sceneName: 'X' });
  assert.deepEqual(seen, ['second']);
});

test('selectors tolerate missing scenes', () => {
  const state = createState();
  assert.equal(selectors.sceneByName(state, 'nope'), null);
  assert.deepEqual(selectors.sceneItems(state, 'nope'), []);
  assert.equal(selectors.audio(state, 'nope'), null);
  assert.deepEqual(selectors.filters(state, 'nope'), []);
});
