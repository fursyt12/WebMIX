/*
 * Mock obs-websocket v5 server used by the WebMIX test-suite.
 *
 * Speaks enough of the real protocol to exercise the browser client and the
 * UI state layer without a running OBS instance: handshake + optional
 * authentication, request/response, batches, events, and an in-memory model
 * of scenes, sources, audio, filters, transitions and outputs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { startWsServer } from './ws-server.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest();
const b64 = (v) => Buffer.from(v).toString('base64');

/** Reference implementation of the obs-websocket auth string. */
export function expectedAuthString(password, salt, challenge) {
  const secret = b64(sha256(password + salt));
  return b64(sha256(secret + challenge));
}

// 1x1 transparent PNG
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const OK = { result: true, code: 100 };

function ok(responseData = {}) {
  return { requestStatus: OK, responseData };
}

function err(code, comment, responseData = {}) {
  return { requestStatus: { result: false, code, comment }, responseData };
}

export async function startMockObs(options = {}) {
  const {
    password = null,
    obsWebSocketVersion = '5.7.4',
    rpcVersion = 1,
    platform = 'linux',
  } = options;

  /* ------------------------------------------------------------ state */

  const state = {
    scenes: ['Scene', 'Scene 2'],
    programScene: 'Scene',
    previewScene: 'Scene 2',
    studioMode: false,
    transition: { name: 'Fade', duration: 300, kind: 'fade_transition' },
    sceneItems: {
      Scene: [
        { sceneItemId: 1, sourceName: 'Display Capture', sceneItemEnabled: true, sceneItemLocked: false, sceneItemIndex: 0, sceneItemTransform: defaultTransform() },
        { sceneItemId: 2, sourceName: 'Text (GDI+)', sceneItemEnabled: false, sceneItemLocked: false, sceneItemIndex: 1, sceneItemTransform: defaultTransform() },
      ],
      'Scene 2': [],
    },
    inputs: {
      'Display Capture': { inputKind: 'screen_capture', volume: 1, muted: false, tracks: { '1': true, '2': true, '3': false, '4': false, '5': false, '6': false }, monitorType: 'OBS_MONITORING_TYPE_NONE', syncOffset: 0, balance: 0.5, settings: {} },
      'Text (GDI+)': { inputKind: 'text_gdiplus', volume: 0.5, muted: true, tracks: { '1': true, '2': false, '3': false, '4': false, '5': false, '6': false }, monitorType: 'OBS_MONITORING_TYPE_NONE', syncOffset: 0, balance: 0.5, settings: { text: 'Hello WebMIX' } },
    },
    filters: {
      'Display Capture': [{ filterName: 'Color Correction', filterKind: 'color_filter_v2', filterEnabled: true, filterIndex: 0, filterSettings: {} }],
    },
    output: {
      streaming: false,
      recording: false,
      recordingPaused: false,
      replayBuffer: false,
      virtualCam: false,
      recordTimecode: '00:00:00.000',
    },
    eventIntents: new Set(),
    requests: [], // log for assertions
  };

  const handlers = {
    GetVersion: () => ok({
      obsWebSocketVersion,
      rpcVersion,
      availableRequests: [],
      supportedImageFormats: ['png', 'jpg', 'jpeg', 'bmp', 'webp'],
      platform,
      obsVersion: '33.0.0',
    }),

    GetStats: () => ok({
      activeFps: 60.0, averageFrameRenderTime: 0.4, cpuUsage: 3.1, memoryUsage: 512.0,
      availableDiskSpace: 10240.0, outputSkippedFrames: 0, outputTotalFrames: 1234,
      renderSkippedFrames: 0, renderTotalFrames: 1234, webSocketSessionIncomingMessages: 1,
      webSocketSessionOutgoingMessages: 1,
    }),

    /* scenes */
    GetSceneList: () => ok({
      currentProgramSceneName: state.programScene,
      currentPreviewSceneName: state.studioMode ? state.previewScene : null,
      scenes: [...state.scenes].reverse().map((s, i) => ({ sceneName: s, sceneIndex: i })),
    }),
    SetCurrentProgramScene: ({ sceneName }) => {
      state.programScene = sceneName;
      emit('CurrentProgramSceneChanged', { sceneName });
      return ok();
    },
    SetCurrentPreviewScene: ({ sceneName }) => {
      state.previewScene = sceneName;
      emit('CurrentPreviewSceneChanged', { sceneName });
      return ok();
    },
    CreateScene: ({ sceneName }) => {
      state.scenes.push(sceneName);
      state.sceneItems[sceneName] = [];
      emit('SceneCreated', { sceneName, isGroup: false });
      emit('SceneListChanged', { scenes: state.scenes.map((sceneName, sceneIndex) => ({ sceneName, sceneIndex })) });
      return ok();
    },
    RemoveScene: ({ sceneName }) => {
      state.scenes = state.scenes.filter((s) => s !== sceneName);
      delete state.sceneItems[sceneName];
      emit('SceneRemoved', { sceneName, isGroup: false });
      return ok();
    },
    SetSceneName: ({ sceneName, newSceneName }) => {
      state.scenes = state.scenes.map((s) => (s === sceneName ? newSceneName : s));
      state.sceneItems[newSceneName] = state.sceneItems[sceneName] ?? [];
      delete state.sceneItems[sceneName];
      emit('SceneNameChanged', { oldSceneName: sceneName, sceneName: newSceneName });
      return ok();
    },
    GetGroupList: () => ok({ groups: [] }),

    /* scene items */
    GetSceneItemList: ({ sceneName }) => ok({
      sceneItems: (state.sceneItems[sceneName] ?? []).map((i) => ({ ...i })),
    }),
    GetGroupSceneItemList: () => ok({ sceneItems: [] }),
    GetSceneItemId: ({ sceneName, sourceName }) => {
      const item = (state.sceneItems[sceneName] ?? []).find((i) => i.sourceName === sourceName);
      if (!item) return err(600, 'No source was found in the scene');
      return ok({ sceneItemId: item.sceneItemId });
    },
    GetSceneItemEnabled: ({ sceneName, sceneItemId }) => {
      const item = findItem(sceneName, sceneItemId);
      if (!item) return err(600, 'Item not found');
      return ok({ sceneItemEnabled: item.sceneItemEnabled });
    },
    SetSceneItemEnabled: ({ sceneName, sceneItemId, sceneItemEnabled }) => {
      const item = findItem(sceneName, sceneItemId);
      if (!item) return err(600, 'Item not found');
      item.sceneItemEnabled = sceneItemEnabled;
      emit('SceneItemEnableStateChanged', { sceneName, sceneItemId, sceneItemEnabled });
      return ok();
    },
    GetSceneItemLocked: ({ sceneName, sceneItemId }) => {
      const item = findItem(sceneName, sceneItemId);
      if (!item) return err(600, 'Item not found');
      return ok({ sceneItemLocked: item.sceneItemLocked });
    },
    SetSceneItemLocked: ({ sceneName, sceneItemId, sceneItemLocked }) => {
      const item = findItem(sceneName, sceneItemId);
      if (!item) return err(600, 'Item not found');
      item.sceneItemLocked = sceneItemLocked;
      emit('SceneItemLockStateChanged', { sceneName, sceneItemId, sceneItemLocked });
      return ok();
    },
    GetSceneItemTransform: ({ sceneName, sceneItemId }) => {
      const item = findItem(sceneName, sceneItemId);
      if (!item) return err(600, 'Item not found');
      return ok({ sceneItemTransform: item.sceneItemTransform });
    },
    SetSceneItemTransform: ({ sceneName, sceneItemId, sceneItemTransform }) => {
      const item = findItem(sceneName, sceneItemId);
      if (!item) return err(600, 'Item not found');
      item.sceneItemTransform = { ...item.sceneItemTransform, ...sceneItemTransform };
      emit('SceneItemTransformChanged', { sceneName, sceneItemId, sceneItemTransform: item.sceneItemTransform });
      return ok();
    },
    SetSceneItemIndex: ({ sceneName, sceneItemId, sceneItemIndex }) => {
      const list = state.sceneItems[sceneName] ?? [];
      const item = list.find((i) => i.sceneItemId === sceneItemId);
      if (!item) return err(600, 'Item not found');
      list.splice(list.indexOf(item), 1);
      list.splice(sceneItemIndex, 0, item);
      list.forEach((i, idx) => (i.sceneItemIndex = idx));
      emit('SceneItemListReindexed', { sceneName, sceneItems: list.map((i) => ({ sceneItemId: i.sceneItemId, sceneItemIndex: i.sceneItemIndex })) });
      return ok();
    },
    CreateSceneItem: ({ sceneName, sourceName, sceneItemEnabled = true }) => {
      const list = state.sceneItems[sceneName] ?? (state.sceneItems[sceneName] = []);
      const sceneItemId = list.length + 100;
      list.push({ sceneItemId, sourceName, sceneItemEnabled, sceneItemLocked: false, sceneItemIndex: list.length, sceneItemTransform: defaultTransform() });
      emit('SceneItemCreated', { sceneName, sourceName, sceneItemId, sceneItemIndex: list.length - 1 });
      return ok({ sceneItemId });
    },
    RemoveSceneItem: ({ sceneName, sceneItemId }) => {
      const list = state.sceneItems[sceneName] ?? [];
      state.sceneItems[sceneName] = list.filter((i) => i.sceneItemId !== sceneItemId);
      emit('SceneItemRemoved', { sceneName, sceneItemId });
      return ok();
    },
    DuplicateSceneItem: ({ sceneName, sceneItemId }) => {
      const list = state.sceneItems[sceneName] ?? [];
      const item = list.find((i) => i.sceneItemId === sceneItemId);
      if (!item) return err(600, 'Item not found');
      const copy = { ...item, sceneItemId: list.length + 100, sceneItemIndex: list.length };
      list.push(copy);
      emit('SceneItemCreated', { sceneName, sourceName: copy.sourceName, sceneItemId: copy.sceneItemId, sceneItemIndex: copy.sceneItemIndex });
      return ok({ sceneItemId: copy.sceneItemId });
    },
    GetSceneItemBlendMode: () => ok({ sceneItemBlendMode: 'OBS_BLEND_NORMAL' }),
    SetSceneItemBlendMode: () => ok(),

    /* inputs + audio */
    GetInputList: () => ok({
      inputs: Object.entries(state.inputs).map(([inputName, v]) => ({ inputName, inputKind: v.inputKind, unversionedInputKind: v.inputKind })),
    }),
    GetInputKindList: () => ok({ inputKinds: ['screen_capture', 'text_gdiplus', 'browser_source', 'image_source'] }),
    GetSpecialInputs: () => ok({ desktop1: null, desktop2: null, mic1: null, mic2: null, mic3: null, mic4: null }),
    GetInputSettings: ({ inputName }) => ok({ inputSettings: state.inputs[inputName]?.settings ?? {}, inputKind: state.inputs[inputName]?.inputKind }),
    SetInputSettings: ({ inputName, inputSettings }) => {
      Object.assign(state.inputs[inputName].settings, inputSettings);
      emit('InputSettingsChanged', { inputName, inputSettings: state.inputs[inputName].settings });
      return ok();
    },
    GetInputDefaultSettings: ({ inputKind }) => ok({ defaultInputSettings: { kind: inputKind } }),
    GetInputPropertiesListPropertyItems: () => ok({ propertyItems: [] }),
    PressInputPropertiesButton: () => ok(),
    CreateInput: ({ sceneName, inputName, inputKind, inputSettings = {} }) => {
      state.inputs[inputName] = { inputKind, volume: 1, muted: false, tracks: { '1': true }, monitorType: 'OBS_MONITORING_TYPE_NONE', syncOffset: 0, balance: 0.5, settings: inputSettings };
      state.sceneItems[sceneName] ??= [];
      state.sceneItems[sceneName].push({ sceneItemId: state.sceneItems[sceneName].length + 100, sourceName: inputName, sceneItemEnabled: true, sceneItemLocked: false, sceneItemIndex: state.sceneItems[sceneName].length, sceneItemTransform: defaultTransform() });
      emit('InputCreated', { inputName, inputKind });
      return ok({ sceneItemId: state.sceneItems[sceneName].at(-1).sceneItemId });
    },
    RemoveInput: ({ inputName }) => {
      delete state.inputs[inputName];
      emit('InputRemoved', { inputName });
      return ok();
    },
    SetInputName: ({ inputName, newInputName }) => {
      state.inputs[newInputName] = state.inputs[inputName];
      delete state.inputs[inputName];
      emit('InputNameChanged', { oldInputName: inputName, inputName: newInputName });
      return ok();
    },
    GetInputVolume: ({ inputName }) => ok({ inputVolumeMul: state.inputs[inputName].volume, inputVolumeDb: mulToDb(state.inputs[inputName].volume) }),
    SetInputVolume: ({ inputName, inputVolumeMul }) => {
      state.inputs[inputName].volume = inputVolumeMul;
      emit('InputVolumeChanged', { inputName, inputVolumeMul, inputVolumeDb: mulToDb(inputVolumeMul) });
      return ok();
    },
    GetInputMute: ({ inputName }) => ok({ inputMuted: state.inputs[inputName].muted }),
    SetInputMute: ({ inputName, inputMuted }) => {
      state.inputs[inputName].muted = inputMuted;
      emit('InputMuteStateChanged', { inputName, inputMuted });
      return ok();
    },
    ToggleInputMute: ({ inputName }) => {
      const inputMuted = !state.inputs[inputName].muted;
      state.inputs[inputName].muted = inputMuted;
      emit('InputMuteStateChanged', { inputName, inputMuted });
      return ok({ inputMuted });
    },
    GetInputAudioTracks: ({ inputName }) => ok({ inputAudioTracks: state.inputs[inputName].tracks }),
    SetInputAudioTracks: ({ inputName, inputAudioTracks }) => {
      state.inputs[inputName].tracks = inputAudioTracks;
      emit('InputAudioTracksChanged', { inputName, inputAudioTracks });
      return ok();
    },
    GetInputAudioMonitorType: ({ inputName }) => ok({ monitorType: state.inputs[inputName].monitorType }),
    SetInputAudioMonitorType: ({ inputName, monitorType }) => {
      state.inputs[inputName].monitorType = monitorType;
      emit('InputAudioMonitorTypeChanged', { inputName, monitorType });
      return ok();
    },
    GetInputAudioSyncOffset: ({ inputName }) => ok({ inputAudioSyncOffset: state.inputs[inputName].syncOffset }),
    SetInputAudioSyncOffset: ({ inputName, inputAudioSyncOffset }) => {
      state.inputs[inputName].syncOffset = inputAudioSyncOffset;
      emit('InputAudioSyncOffsetChanged', { inputName, inputAudioSyncOffset });
      return ok();
    },
    GetInputAudioBalance: ({ inputName }) => ok({ inputAudioBalance: state.inputs[inputName].balance }),
    SetInputAudioBalance: ({ inputName, inputAudioBalance }) => {
      state.inputs[inputName].balance = inputAudioBalance;
      emit('InputAudioBalanceChanged', { inputName, inputAudioBalance });
      return ok();
    },
    GetInputDeinterlaceMode: () => ok({ deinterlaceMode: 'OBS_DEINTERLACE_MODE_DISABLE' }),
    SetInputDeinterlaceMode: () => ok(),
    GetInputDeinterlaceFieldOrder: () => ok({ deinterlaceFieldOrder: 'OBS_DEINTERLACE_FIELD_ORDER_TOP' }),
    SetInputDeinterlaceFieldOrder: () => ok(),
    TriggerInputMediaAction: () => ok(),
    GetMediaInputStatus: () => ok({ mediaState: 'OBS_MEDIA_STATE_NONE' }),

    /* filters */
    GetSourceFilterList: ({ sourceName }) => ok({ filters: (state.filters[sourceName] ?? []).map((f) => ({ ...f })) }),
    GetSourceFilterKindList: () => ok({ sourceFilterKinds: ['color_filter_v2', 'noise_suppress_filter_v2', 'gain_filter'] }),
    GetSourceFilterDefaultSettings: ({ filterKind }) => ok({ defaultFilterSettings: { kind: filterKind } }),
    CreateSourceFilter: ({ sourceName, filterName, filterKind, filterSettings = {} }) => {
      const list = state.filters[sourceName] ?? (state.filters[sourceName] = []);
      list.push({ filterName, filterKind, filterEnabled: true, filterIndex: list.length, filterSettings });
      emit('SourceFilterCreated', { sourceName, filterName, filterKind, filterIndex: list.length - 1 });
      return ok();
    },
    RemoveSourceFilter: ({ sourceName, filterName }) => {
      state.filters[sourceName] = (state.filters[sourceName] ?? []).filter((f) => f.filterName !== filterName);
      emit('SourceFilterRemoved', { sourceName, filterName });
      return ok();
    },
    SetSourceFilterEnabled: ({ sourceName, filterName, filterEnabled }) => {
      const f = (state.filters[sourceName] ?? []).find((x) => x.filterName === filterName);
      if (!f) return err(600, 'Filter not found');
      f.filterEnabled = filterEnabled;
      emit('SourceFilterEnableStateChanged', { sourceName, filterName, filterEnabled });
      return ok();
    },
    SetSourceFilterSettings: ({ sourceName, filterName, filterSettings }) => {
      const f = (state.filters[sourceName] ?? []).find((x) => x.filterName === filterName);
      if (!f) return err(600, 'Filter not found');
      Object.assign(f.filterSettings, filterSettings);
      emit('SourceFilterSettingsChanged', { sourceName, filterName, filterSettings: f.filterSettings });
      return ok();
    },
    SetSourceFilterName: ({ sourceName, filterName, newFilterName }) => {
      const f = (state.filters[sourceName] ?? []).find((x) => x.filterName === filterName);
      if (!f) return err(600, 'Filter not found');
      f.filterName = newFilterName;
      emit('SourceFilterNameChanged', { sourceName, oldFilterName: filterName, filterName: newFilterName });
      return ok();
    },
    SetSourceFilterIndex: () => ok(),
    GetSourceFilter: ({ sourceName, filterName }) => {
      const f = (state.filters[sourceName] ?? []).find((x) => x.filterName === filterName);
      if (!f) return err(600, 'Filter not found');
      return ok({ filterEnabled: f.filterEnabled, filterIndex: f.filterIndex, filterKind: f.filterKind, filterSettings: f.filterSettings });
    },

    /* transitions + studio mode */
    GetSceneTransitionList: () => ok({
      currentSceneTransitionName: state.transition.name,
      currentSceneTransitionKind: state.transition.kind,
      transitions: [
        { transitionName: 'Cut', transitionKind: 'cut_transition', transitionFixed: true, transitionConfigurable: false },
        { transitionName: 'Fade', transitionKind: 'fade_transition', transitionFixed: false, transitionConfigurable: true },
      ],
    }),
    GetTransitionKindList: () => ok({ transitionKinds: ['cut_transition', 'fade_transition', 'fade_to_color_transition'] }),
    GetCurrentSceneTransition: () => ok({ transitionName: state.transition.name, transitionKind: state.transition.kind, transitionFixed: false, transitionDuration: state.transition.duration, transitionConfigurable: true, transitionSettings: {} }),
    SetCurrentSceneTransition: ({ transitionName }) => {
      state.transition.name = transitionName;
      emit('CurrentSceneTransitionChanged', { transitionName });
      return ok();
    },
    SetCurrentSceneTransitionDuration: ({ transitionDuration }) => {
      state.transition.duration = transitionDuration;
      emit('CurrentSceneTransitionDurationChanged', { transitionDuration });
      return ok();
    },
    SetCurrentSceneTransitionSettings: () => ok(),
    SetTBarPosition: () => ok(),
    TriggerStudioModeTransition: () => {
      const from = state.programScene;
      state.programScene = state.previewScene;
      emit('SceneTransitionStarted', { transitionName: state.transition.name });
      emit('CurrentProgramSceneChanged', { sceneName: state.programScene });
      emit('SceneTransitionEnded', { transitionName: state.transition.name });
      return ok();
    },
    GetStudioModeEnabled: () => ok({ studioModeEnabled: state.studioMode }),
    SetStudioModeEnabled: ({ studioModeEnabled }) => {
      state.studioMode = studioModeEnabled;
      emit('StudioModeStateChanged', { studioModeEnabled });
      return ok();
    },

    /* outputs */
    GetStreamStatus: () => ok({ outputActive: state.output.streaming, outputReconnecting: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputCongestion: 0, outputBytes: 0, outputSkippedFrames: 0, outputTotalFrames: 0 }),
    StartStream: () => setOutput('streaming', true, 'StreamStateChanged', 'OBS_WEBSOCKET_OUTPUT_STARTED'),
    StopStream: () => setOutput('streaming', false, 'StreamStateChanged', 'OBS_WEBSOCKET_OUTPUT_STOPPED'),
    ToggleStream: () => setOutput('streaming', !state.output.streaming, 'StreamStateChanged', state.output.streaming ? 'OBS_WEBSOCKET_OUTPUT_STOPPED' : 'OBS_WEBSOCKET_OUTPUT_STARTED', true),
    GetRecordStatus: () => ok({ outputActive: state.output.recording, outputPaused: state.output.recordingPaused, outputTimecode: state.output.recordTimecode, outputDuration: 0, outputBytes: 0 }),
    StartRecord: () => setOutput('recording', true, 'RecordStateChanged', 'OBS_WEBSOCKET_OUTPUT_STARTED'),
    StopRecord: () => setOutput('recording', false, 'RecordStateChanged', 'OBS_WEBSOCKET_OUTPUT_STOPPED'),
    ToggleRecord: () => setOutput('recording', !state.output.recording, 'RecordStateChanged', state.output.recording ? 'OBS_WEBSOCKET_OUTPUT_STOPPED' : 'OBS_WEBSOCKET_OUTPUT_STARTED'),
    PauseRecord: () => setOutput('recordingPaused', true, 'RecordStateChanged', 'OBS_WEBSOCKET_OUTPUT_PAUSED'),
    ResumeRecord: () => setOutput('recordingPaused', false, 'RecordStateChanged', 'OBS_WEBSOCKET_OUTPUT_RESUMED'),
    SplitRecordFile: () => ok(),
    CreateRecordChapter: () => ok(),
    GetReplayBufferStatus: () => ok({ outputActive: state.output.replayBuffer }),
    StartReplayBuffer: () => setOutput('replayBuffer', true, 'ReplayBufferStateChanged', 'OBS_WEBSOCKET_OUTPUT_STARTED'),
    StopReplayBuffer: () => setOutput('replayBuffer', false, 'ReplayBufferStateChanged', 'OBS_WEBSOCKET_OUTPUT_STOPPED'),
    ToggleReplayBuffer: () => setOutput('replayBuffer', !state.output.replayBuffer, 'ReplayBufferStateChanged', state.output.replayBuffer ? 'OBS_WEBSOCKET_OUTPUT_STOPPED' : 'OBS_WEBSOCKET_OUTPUT_STARTED'),
    SaveReplayBuffer: () => {
      emit('ReplayBufferSaved', { savedReplayPath: '/tmp/replay.mkv' });
      return ok();
    },
    GetLastReplayBufferReplay: () => ok({ savedReplayPath: '/tmp/replay.mkv' }),
    GetVirtualCamStatus: () => ok({ outputActive: state.output.virtualCam }),
    StartVirtualCam: () => setOutput('virtualCam', true, 'VirtualcamStateChanged', 'OBS_WEBSOCKET_OUTPUT_STARTED'),
    StopVirtualCam: () => setOutput('virtualCam', false, 'VirtualcamStateChanged', 'OBS_WEBSOCKET_OUTPUT_STOPPED'),
    ToggleVirtualCam: () => setOutput('virtualCam', !state.output.virtualCam, 'VirtualcamStateChanged', state.output.virtualCam ? 'OBS_WEBSOCKET_OUTPUT_STOPPED' : 'OBS_WEBSOCKET_OUTPUT_STARTED'),
    GetOutputList: () => ok({ outputs: [] }),
    GetOutputStatus: () => ok({ outputActive: true, outputReconnecting: false, outputTimecode: '00:00:00.000', outputDuration: 0 }),
    GetOutputSettings: () => ok({ outputSettings: {} }),
    SetOutputSettings: () => ok(),
    StartOutput: () => ok(),
    StopOutput: () => ok(),
    ToggleOutput: () => ok(),

    /* config */
    GetSceneCollectionList: () => ok({ currentSceneCollectionName: 'Untitled', sceneCollections: ['Untitled'] }),
    SetCurrentSceneCollection: () => ok(),
    CreateSceneCollection: () => ok(),
    GetProfileList: () => ok({ currentProfileName: 'Untitled', profiles: ['Untitled'] }),
    SetCurrentProfile: () => ok(),
    CreateProfile: () => ok(),
    RemoveProfile: () => ok(),
    GetProfileParameter: () => ok({ parameterValue: '' }),
    SetProfileParameter: () => ok(),
    GetVideoSettings: () => ok({ fpsNumerator: 60, fpsDenominator: 1, baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 }),
    SetVideoSettings: () => ok(),
    GetStreamServiceSettings: () => ok({ streamServiceType: 'rtmp_common', streamServiceSettings: {} }),
    SetStreamServiceSettings: () => ok(),
    GetRecordDirectory: () => ok({ recordDirectory: '/home/user/Videos' }),
    SetRecordDirectory: () => ok(),
    GetPersistentData: () => ok({ slotValue: null }),
    SetPersistentData: () => ok(),

    /* general + ui */
    GetHotkeyList: () => ok({ hotkeys: ['OBSBasic.StartRecording', 'OBSBasic.StopRecording'] }),
    TriggerHotkeyByName: () => ok(),
    TriggerHotkeyByKeySequence: () => ok(),
    GetSourceActive: () => ok({ sourceActive: true, videoActive: true, videoShowing: true }),
    GetSourceScreenshot: () => ok({ imageData: `data:image/png;base64,${TINY_PNG_BASE64}` }),
    SaveSourceScreenshot: () => ok(),
    GetMonitorList: () => ok({ monitors: [{ monitorName: 'Monitor 1', monitorIndex: 0, monitorWidth: 1920, monitorHeight: 1080 }] }),
    OpenInputFiltersDialog: () => ok(),
    OpenInputPropertiesDialog: () => ok(),
    OpenInputInteractDialog: () => ok(),
    OpenSourceProjector: () => ok(),
    OpenVideoMixProjector: () => ok(),
    BroadcastCustomEvent: () => ok(),
    CallVendorRequest: () => ok({ vendorName: '', requestType: '', responseData: {} }),
    Sleep: () => ok(),
  };

  function defaultTransform() {
    return {
      positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1,
      alignment: 5, boundsType: 'OBS_BOUNDS_NONE', boundsAlignment: 0,
      boundsWidth: 1920, boundsHeight: 1080, cropLeft: 0, cropTop: 0,
      cropRight: 0, cropBottom: 0, sourceWidth: 1920, sourceHeight: 1080,
      width: 1920, height: 1080,
    };
  }

  function findItem(sceneName, sceneItemId) {
    return (state.sceneItems[sceneName] ?? []).find((i) => i.sceneItemId === sceneItemId);
  }

  function mulToDb(mul) {
    return mul <= 0 ? -100 : 20 * Math.log10(mul);
  }

  function setOutput(key, active, event, outputState, toggleResponse = false) {
    state.output[key] = active;
    const data = { outputActive: active, outputState };
    emit(event, data);
    return toggleResponse ? ok({ outputActive: active }) : ok();
  }

  /* --------------------------------------------------------- connection */

  let activeConn = null;
  const server = await startWsServer((conn) => {
    activeConn = conn;
    const salt = password ? randomBytes(16).toString('base64') : null;
    const challenge = password ? randomBytes(16).toString('base64') : null;

    conn.send(JSON.stringify({
      op: 0,
      d: {
        obsWebSocketVersion,
        rpcVersion,
        ...(password ? { authentication: { challenge, salt } } : {}),
      },
    }));

    let identified = false;

    conn.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        conn.close(4002, 'Message decode error');
        return;
      }

      if (msg.op === 1) {
        if (identified) return conn.close(4008, 'Already identified');
        const d = msg.d ?? {};
        if (password) {
          const expected = expectedAuthString(password, salt, challenge);
          if (d.authentication !== expected) {
            conn.close(4009, 'Authentication failed');
            return;
          }
        }
        identified = true;
        conn.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: rpcVersion } }));
        return;
      }

      if (!identified) return conn.close(4007, 'Not identified');

      if (msg.op === 3) {
        // Reidentify - just accept.
        return;
      }

      if (msg.op === 6) {
        const { requestType, requestId, requestData = {} } = msg.d ?? {};
        state.requests.push({ requestType, requestData });
        const handler = handlers[requestType];
        const result = handler
          ? handler(requestData)
          : err(204, `Unknown request type: ${requestType}`);
        conn.send(JSON.stringify({
          op: 7,
          d: { requestType, requestId, ...result },
        }));
        return;
      }

      if (msg.op === 8) {
        const { requestId, requests = [] } = msg.d ?? {};
        const results = requests.map((r) => {
          const handler = handlers[r.requestType];
          return {
            requestType: r.requestType,
            ...(handler ? handler(r.requestData ?? {}) : err(204, 'Unknown request type')),
          };
        });
        conn.send(JSON.stringify({ op: 9, d: { requestId, results } }));
      }
    });
  });

  function emit(eventType, eventData) {
    if (!activeConn || activeConn.closed) return;
    activeConn.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 1, eventData } }));
  }

  return {
    url: server.url,
    port: server.port,
    state,
    emit,
    handlers,
    /** Force-close the current client socket (simulates an OBS restart). */
    dropConnection: () => activeConn?.destroy(),
    close: () => server.close(),  };
}

export { err as mockError, ok as mockOk };
