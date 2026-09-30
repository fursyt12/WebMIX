/*
 * WebMIX - high level OBS API facade.
 *
 * Wraps the obs-websocket v5 requests into named operations the UI can call,
 * and keeps the state store in sync where a request has no matching event
 * (initial loads, settings dialogs, list refreshes).
 */
import { Topic, toDisplayOrder } from './store.js';

export class ObsApi {
  /**
   * @param {import('./obs-client.js').ObsClient} client
   * @param {import('./store.js').Store} store
   */
  constructor(client, store) {
    this.client = client;
    this.store = store;
  }

  get connected() {
    return this.client.connected;
  }

  request(type, data, options) {
    return this.client.request(type, data, options);
  }

  batch(requests) {
    return this.client.requestBatch(requests);
  }

  /* --------------------------------------------------- initial full load */

  /**
   * Load everything the UI needs. Uses a request batch so the round-trips do
   * not add up, then folds the results into the store.
   */
  async refreshAll() {
    const state = this.store.state;
    const version = await this.client.getVersion({ force: true });
    state.version = version;

    const base = await this.batch([
      { requestType: 'GetSceneList' },
      { requestType: 'GetInputList' },
      { requestType: 'GetSceneTransitionList' },
      { requestType: 'GetCurrentSceneTransition' },
      { requestType: 'GetStudioModeEnabled' },
      { requestType: 'GetStreamStatus' },
      { requestType: 'GetRecordStatus' },
      { requestType: 'GetReplayBufferStatus' },
      { requestType: 'GetVirtualCamStatus' },
      { requestType: 'GetSceneCollectionList' },
      { requestType: 'GetProfileList' },
      { requestType: 'GetVideoSettings' },
      { requestType: 'GetHotkeyList' },
    ]);

    const [
      sceneList,
      inputList,
      transitionList,
      currentTransition,
      studioMode,
      streamStatus,
      recordStatus,
      replayStatus,
      vcamStatus,
      sceneCollections,
      profiles,
      video,
      hotkeys,
    ] = base.map((entry) => (entry.requestStatus?.result ? entry.responseData : {}));

    this.store.batch(() => {
      state.scenes = toDisplayOrder(sceneList.scenes);
      state.currentProgramScene = sceneList.currentProgramSceneName ?? null;
      state.currentPreviewScene = sceneList.currentPreviewSceneName ?? null;
      state.studioMode = !!studioMode.studioModeEnabled;

      state.inputs = {};
      state.audio = {};
      for (const input of inputList.inputs ?? []) {
        state.inputs[input.inputName] = {
          inputName: input.inputName,
          inputUuid: input.inputUuid,
          inputKind: input.inputKind,
          unversionedInputKind: input.unversionedInputKind,
        };
        state.audio[input.inputName] = {
          volumeMul: 1,
          volumeDb: 0,
          muted: false,
          tracks: {},
          monitorType: 'OBS_MONITORING_TYPE_NONE',
          syncOffset: 0,
          balance: 0.5,
          levels: [],
          active: false,
          showing: false,
        };
      }

      state.transitions = transitionList.transitions ?? [];
      state.currentTransition = {
        transitionName: currentTransition.transitionName ?? transitionList.currentSceneTransitionName ?? null,
        transitionKind: currentTransition.transitionKind ?? transitionList.currentSceneTransitionKind ?? null,
        transitionDuration: currentTransition.transitionDuration ?? 300,
        transitionSettings: currentTransition.transitionSettings ?? {},
        transitionFixed: currentTransition.transitionFixed ?? false,
        transitionConfigurable: currentTransition.transitionConfigurable ?? false,
      };

      state.outputs.streaming.active = !!streamStatus.outputActive;
      state.outputs.streaming.timecode = streamStatus.outputTimecode ?? '00:00:00.000';
      state.outputs.streaming.bytes = streamStatus.outputBytes ?? 0;
      state.outputs.streaming.skippedFrames = streamStatus.outputSkippedFrames ?? 0;
      state.outputs.streaming.totalFrames = streamStatus.outputTotalFrames ?? 0;
      state.outputs.streaming.congestion = streamStatus.outputCongestion ?? 0;
      state.outputs.streaming.reconnecting = !!streamStatus.outputReconnecting;

      state.outputs.recording.active = !!recordStatus.outputActive;
      state.outputs.recording.paused = !!recordStatus.outputPaused;
      state.outputs.recording.timecode = recordStatus.outputTimecode ?? '00:00:00.000';
      state.outputs.recording.bytes = recordStatus.outputBytes ?? 0;

      state.outputs.replayBuffer.active = !!replayStatus.outputActive;
      state.outputs.virtualCam.active = !!vcamStatus.outputActive;

      state.sceneCollections = {
        current: sceneCollections.currentSceneCollectionName ?? null,
        list: sceneCollections.sceneCollections ?? [],
      };
      state.profiles = { current: profiles.currentProfileName ?? null, list: profiles.profiles ?? [] };
      state.video = video;
      // GetHotkeyList only returns frontend hotkeys; plugin hotkeys need the
      // extra flag, which the UI does not need for the hotkey list dialog.
      state.hotkeys = hotkeys.hotkeys ?? [];
    });

    // Per-input audio details (volume, mute, tracks, monitoring, sync, balance).
    await this.refreshAudio();
    await this.refreshSceneItems(state.currentProgramScene);
    if (state.studioMode && state.currentPreviewScene) {
      await this.refreshSceneItems(state.currentPreviewScene);
    }
    await this.refreshStats();

    this.store.notifyAll();
    return state;
  }

  async refreshAudio() {
    const names = Object.keys(this.store.state.inputs);
    if (!names.length) return;
    const requests = [];
    for (const inputName of names) {
      requests.push(
        { requestType: 'GetInputVolume', requestData: { inputName } },
        { requestType: 'GetInputMute', requestData: { inputName } },
        { requestType: 'GetInputAudioTracks', requestData: { inputName } },
        { requestType: 'GetInputAudioMonitorType', requestData: { inputName } },
        { requestType: 'GetInputAudioSyncOffset', requestData: { inputName } },
        { requestType: 'GetInputAudioBalance', requestData: { inputName } }
      );
    }
    const results = await this.batch(requests);
    const state = this.store.state;
    state.audio ??= {};
    results.forEach((entry, index) => {
      const inputName = names[Math.floor(index / 6)];
      const audio = (state.audio[inputName] ??= {});
      if (!entry.requestStatus?.result) return;
      switch (index % 6) {
        case 0:
          audio.volumeMul = entry.responseData.inputVolumeMul;
          audio.volumeDb = entry.responseData.inputVolumeDb;
          break;
        case 1:
          audio.muted = entry.responseData.inputMuted;
          break;
        case 2:
          audio.tracks = entry.responseData.inputAudioTracks;
          break;
        case 3:
          audio.monitorType = entry.responseData.monitorType;
          break;
        case 4:
          audio.syncOffset = entry.responseData.inputAudioSyncOffset;
          break;
        case 5:
          audio.balance = entry.responseData.inputAudioBalance;
          break;
      }
    });
    this.store.notify(Topic.Audio);
  }

  async refreshSceneItems(sceneName) {
    if (!sceneName) return [];
    const data = await this.request('GetSceneItemList', { sceneName });
    this.store.batch(() => {
      this.store.state.sceneItems[sceneName] = (data.sceneItems ?? []).map((i) => ({ ...i }));
    });
    this.store.notify(Topic.SceneItems);
    return data.sceneItems ?? [];
  }

  async refreshStats() {
    try {
      const stats = await this.request('GetStats');
      this.store.state.stats = stats;
      this.store.notify(Topic.Stats);
      return stats;
    } catch {
      return null;
    }
  }

  async refreshFilters(sourceName) {
    const data = await this.request('GetSourceFilterList', { sourceName });
    this.store.state.filters[sourceName] = data.filters ?? [];
    this.store.notify(Topic.Filters);
    return data.filters ?? [];
  }

  /* -------------------------------------------------------------- scenes */

  async setProgramScene(sceneName) {
    if (this.store.state.studioMode) {
      await this.request('SetCurrentPreviewScene', { sceneName });
      this.store.state.currentPreviewScene = sceneName;
      this.store.notify(Topic.Scenes);
    } else {
      await this.request('SetCurrentProgramScene', { sceneName });
      this.store.state.currentProgramScene = sceneName;
      this.store.notify(Topic.Scenes);
    }
  }

  async setPreviewScene(sceneName) {
    await this.request('SetCurrentPreviewScene', { sceneName });
    this.store.state.currentPreviewScene = sceneName;
    this.store.notify(Topic.Scenes);
  }

  async createScene(sceneName) {
    await this.request('CreateScene', { sceneName });
    await this.refreshScenes();
  }

  async removeScene(sceneName) {
    await this.request('RemoveScene', { sceneName });
    await this.refreshScenes();
  }

  async renameScene(sceneName, newSceneName) {
    await this.request('SetSceneName', { sceneName, newSceneName });
    await this.refreshScenes();
  }

  async refreshScenes() {
    const data = await this.request('GetSceneList');
    this.store.batch(() => {
      this.store.state.scenes = toDisplayOrder(data.scenes);
      this.store.state.currentProgramScene = data.currentProgramSceneName ?? null;
      this.store.state.currentPreviewScene = data.currentPreviewSceneName ?? null;
    });
    this.store.notify(Topic.Scenes);
    return data;
  }

  async triggerStudioTransition() {
    await this.request('TriggerStudioModeTransition');
    await this.refreshScenes();
  }

  async setStudioMode(enabled) {
    await this.request('SetStudioModeEnabled', { studioModeEnabled: enabled });
    this.store.state.studioMode = enabled;
    if (enabled) {
      try {
        const data = await this.request('GetCurrentPreviewScene');
        this.store.state.currentPreviewScene = data.currentSceneName ?? null;
      } catch {
        /* not fatal */
      }
    }
    this.store.notify(Topic.Ui, Topic.Scenes);
  }

  /* --------------------------------------------------------- scene items */

  async setSceneItemEnabled(sceneName, sceneItemId, sceneItemEnabled) {
    await this.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled });
    const item = (this.store.state.sceneItems[sceneName] ?? []).find((i) => i.sceneItemId === sceneItemId);
    if (item) item.sceneItemEnabled = sceneItemEnabled;
    this.store.notify(Topic.SceneItems);
  }

  async setSceneItemLocked(sceneName, sceneItemId, sceneItemLocked) {
    await this.request('SetSceneItemLocked', { sceneName, sceneItemId, sceneItemLocked });
    const item = (this.store.state.sceneItems[sceneName] ?? []).find((i) => i.sceneItemId === sceneItemId);
    if (item) item.sceneItemLocked = sceneItemLocked;
    this.store.notify(Topic.SceneItems);
  }

  async setSceneItemIndex(sceneName, sceneItemId, sceneItemIndex) {
    await this.request('SetSceneItemIndex', { sceneName, sceneItemId, sceneItemIndex });
    await this.refreshSceneItems(sceneName);
  }

  async removeSceneItem(sceneName, sceneItemId) {
    await this.request('RemoveSceneItem', { sceneName, sceneItemId });
    await this.refreshSceneItems(sceneName);
  }

  async createSceneItem(sceneName, sourceName, sceneItemEnabled = true) {
    const data = await this.request('CreateSceneItem', { sceneName, sourceName, sceneItemEnabled });
    await this.refreshSceneItems(sceneName);
    return data.sceneItemId;
  }

  async duplicateSceneItem(sceneName, sceneItemId) {
    await this.request('DuplicateSceneItem', { sceneName, sceneItemId });
    await this.refreshSceneItems(sceneName);
  }

  async getSceneItemTransform(sceneName, sceneItemId) {
    const data = await this.request('GetSceneItemTransform', { sceneName, sceneItemId });
    return data.sceneItemTransform;
  }

  async setSceneItemTransform(sceneName, sceneItemId, sceneItemTransform) {
    await this.request('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform });
  }

  /* -------------------------------------------------------------- inputs */

  async getInputKindList() {
    const data = await this.request('GetInputKindList');
    return data.inputKinds ?? [];
  }

  async getInputDefaultSettings(inputKind) {
    const data = await this.request('GetInputDefaultSettings', { inputKind });
    return data.defaultInputSettings ?? {};
  }

  async getInputSettings(inputName) {
    const data = await this.request('GetInputSettings', { inputName });
    return data;
  }

  async setInputSettings(inputName, inputSettings, overlay = true) {
    await this.request('SetInputSettings', { inputName, inputSettings, overlay });
  }

  async getInputPropertiesListPropertyItems(inputName, propertyName) {
    const data = await this.request('GetInputPropertiesListPropertyItems', { inputName, propertyName });
    return data.propertyItems ?? [];
  }

  async pressInputPropertiesButton(inputName, propertyName) {
    await this.request('PressInputPropertiesButton', { inputName, propertyName });
  }

  async createInput(sceneName, inputName, inputKind, inputSettings = {}) {
    const data = await this.request('CreateInput', { sceneName, inputName, inputKind, inputSettings });
    await this.store.batch(async () => {
      // The store updates itself from events; refresh lists to be safe.
    });
    await this.refreshInputs();
    if (sceneName) await this.refreshSceneItems(sceneName);
    return data.sceneItemId;
  }

  async removeInput(inputName) {
    await this.request('RemoveInput', { inputName });
    await this.refreshInputs();
  }

  async renameInput(inputName, newInputName) {
    await this.request('SetInputName', { inputName, newInputName });
    await this.refreshInputs();
  }

  async refreshInputs() {
    const data = await this.request('GetInputList');
    this.store.batch(() => {
      const seen = new Set();
      for (const input of data.inputs ?? []) {
        seen.add(input.inputName);
        this.store.state.inputs[input.inputName] = {
          ...(this.store.state.inputs[input.inputName] ?? {}),
          inputName: input.inputName,
          inputUuid: input.inputUuid,
          inputKind: input.inputKind,
          unversionedInputKind: input.unversionedInputKind,
        };
      }
      for (const name of Object.keys(this.store.state.inputs)) {
        if (!seen.has(name)) {
          delete this.store.state.inputs[name];
          delete this.store.state.audio[name];
        }
      }
    });
    this.store.notify(Topic.Inputs, Topic.Audio);
    await this.refreshAudio();
  }

  /* --------------------------------------------------------------- audio */

  async setInputVolume(inputName, inputVolumeMul) {
    await this.request('SetInputVolume', { inputName, inputVolumeMul });
  }

  async setInputVolumeDb(inputName, inputVolumeDb) {
    await this.request('SetInputVolume', { inputName, inputVolumeDb });
  }

  async setInputMute(inputName, inputMuted) {
    await this.request('SetInputMute', { inputName, inputMuted });
  }

  async toggleInputMute(inputName) {
    const data = await this.request('ToggleInputMute', { inputName });
    return data.inputMuted;
  }

  async setInputAudioTracks(inputName, inputAudioTracks) {
    await this.request('SetInputAudioTracks', { inputName, inputAudioTracks });
  }

  async setInputAudioMonitorType(inputName, monitorType) {
    await this.request('SetInputAudioMonitorType', { inputName, monitorType });
  }

  async setInputAudioSyncOffset(inputName, inputAudioSyncOffset) {
    await this.request('SetInputAudioSyncOffset', { inputName, inputAudioSyncOffset });
  }

  async setInputAudioBalance(inputName, inputAudioBalance) {
    await this.request('SetInputAudioBalance', { inputName, inputAudioBalance });
  }

  /* ------------------------------------------------------------- filters */

  async getSourceFilterKindList() {
    const data = await this.request('GetSourceFilterKindList');
    return data.sourceFilterKinds ?? [];
  }

  async getSourceFilterDefaultSettings(filterKind) {
    const data = await this.request('GetSourceFilterDefaultSettings', { filterKind });
    return data.defaultFilterSettings ?? {};
  }

  async createSourceFilter(sourceName, filterName, filterKind, filterSettings = {}) {
    await this.request('CreateSourceFilter', { sourceName, filterName, filterKind, filterSettings });
    await this.refreshFilters(sourceName);
  }

  async removeSourceFilter(sourceName, filterName) {
    await this.request('RemoveSourceFilter', { sourceName, filterName });
    await this.refreshFilters(sourceName);
  }

  async setSourceFilterEnabled(sourceName, filterName, filterEnabled) {
    await this.request('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled });
  }

  async setSourceFilterSettings(sourceName, filterName, filterSettings, overlay = true) {
    await this.request('SetSourceFilterSettings', { sourceName, filterName, filterSettings, overlay });
  }

  async renameSourceFilter(sourceName, filterName, newFilterName) {
    await this.request('SetSourceFilterName', { sourceName, filterName, newFilterName });
    await this.refreshFilters(sourceName);
  }

  async setSourceFilterIndex(sourceName, filterName, filterIndex) {
    await this.request('SetSourceFilterIndex', { sourceName, filterName, filterIndex });
    await this.refreshFilters(sourceName);
  }

  /* --------------------------------------------------------- transitions */

  async setCurrentTransition(transitionName) {
    await this.request('SetCurrentSceneTransition', { transitionName });
    this.store.state.currentTransition.transitionName = transitionName;
    this.store.notify(Topic.Transitions);
  }

  async setTransitionDuration(transitionDuration) {
    await this.request('SetCurrentSceneTransitionDuration', { transitionDuration });
    this.store.state.currentTransition.transitionDuration = transitionDuration;
    this.store.notify(Topic.Transitions);
  }

  async setTransitionSettings(transitionSettings, overlay = true) {
    await this.request('SetCurrentSceneTransitionSettings', { transitionSettings, overlay });
  }

  async setTBarPosition(position, release = false) {
    await this.request('SetTBarPosition', { position, release });
  }

  /* ------------------------------------------------------------- outputs */

  async startStream() { await this.request('StartStream'); }
  async stopStream() { await this.request('StopStream'); }
  async toggleStream() { await this.request('ToggleStream'); }
  async startRecord() { await this.request('StartRecord'); }
  async stopRecord() { const d = await this.request('StopRecord'); return d.outputPath; }
  async toggleRecord() { await this.request('ToggleRecord'); }
  async toggleRecordPause() { await this.request('ToggleRecordPause'); }
  async startReplayBuffer() { await this.request('StartReplayBuffer'); }
  async stopReplayBuffer() { await this.request('StopReplayBuffer'); }
  async toggleReplayBuffer() { await this.request('ToggleReplayBuffer'); }
  async saveReplayBuffer() { await this.request('SaveReplayBuffer'); }
  async startVirtualCam() { await this.request('StartVirtualCam'); }
  async stopVirtualCam() { await this.request('StopVirtualCam'); }
  async toggleVirtualCam() { await this.request('ToggleVirtualCam'); }

  /* --------------------------------------------------------------- dialogs */

  async openInputFiltersDialog(inputName) { await this.request('OpenInputFiltersDialog', { inputName }); }
  async openInputPropertiesDialog(inputName) { await this.request('OpenInputPropertiesDialog', { inputName }); }
  async openInputInteractDialog(inputName) { await this.request('OpenInputInteractDialog', { inputName }); }

  async getSourceScreenshot(sourceName, { format = 'jpg', width = 640, height = 360, quality = 70 } = {}) {
    const data = await this.request(
      'GetSourceScreenshot',
      { sourceName, imageFormat: format, imageWidth: width, imageHeight: height, imageCompressionQuality: quality },
      { timeout: 15000 }
    );
    return data.imageData;
  }

  /* ---------------------------------------------------------------- config */

  async getProfileList() {
    const data = await this.request('GetProfileList');
    this.store.state.profiles = { current: data.currentProfileName, list: data.profiles ?? [] };
    this.store.notify(Topic.Config);
    return data;
  }

  async setCurrentProfile(profileName) {
    await this.request('SetCurrentProfile', { profileName });
    await this.getProfileList();
  }

  async createProfile(profileName) {
    await this.request('CreateProfile', { profileName });
    await this.getProfileList();
  }

  async removeProfile(profileName) {
    await this.request('RemoveProfile', { profileName });
    await this.getProfileList();
  }

  async getSceneCollectionList() {
    const data = await this.request('GetSceneCollectionList');
    this.store.state.sceneCollections = {
      current: data.currentSceneCollectionName,
      list: data.sceneCollections ?? [],
    };
    this.store.notify(Topic.Config);
    return data;
  }

  async setCurrentSceneCollection(sceneCollectionName) {
    await this.request('SetCurrentSceneCollection', { sceneCollectionName });
    await this.getSceneCollectionList();
  }

  async createSceneCollection(sceneCollectionName) {
    await this.request('CreateSceneCollection', { sceneCollectionName });
    await this.getSceneCollectionList();
  }

  async getVideoSettings() {
    const data = await this.request('GetVideoSettings');
    this.store.state.video = data;
    this.store.notify(Topic.Video);
    return data;
  }

  async setVideoSettings(settings) {
    await this.request('SetVideoSettings', settings);
    await this.getVideoSettings();
  }

  async getStreamServiceSettings() {
    return this.request('GetStreamServiceSettings');
  }

  async setStreamServiceSettings(streamServiceType, streamServiceSettings) {
    await this.request('SetStreamServiceSettings', { streamServiceType, streamServiceSettings });
  }

  async getProfileParameter(parameterCategory, parameterName) {
    const data = await this.request('GetProfileParameter', { parameterCategory, parameterName });
    return data.parameterValue;
  }

  async setProfileParameter(parameterCategory, parameterName, parameterValue) {
    await this.request('SetProfileParameter', { parameterCategory, parameterName, parameterValue });
  }

  async getRecordDirectory() {
    const data = await this.request('GetRecordDirectory');
    return data.recordDirectory;
  }

  /* ---------------------------------------------------------------- hotkeys */

  async triggerHotkeyByName(hotkeyName) {
    await this.request('TriggerHotkeyByName', { hotkeyName });
  }

  async triggerHotkeyByKeySequence(keyId, keyModifiers = {}) {
    await this.request('TriggerHotkeyByKeySequence', { keyId, keyModifiers });
  }
}
