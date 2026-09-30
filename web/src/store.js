/*
 * WebMIX - application state store.
 *
 * Holds a mirror of the OBS state that the UI renders, keeps it in sync from
 * obs-websocket events, and notifies subscribers by topic so panels only
 * re-render the parts that actually changed.
 *
 * The reducer (`reduceEvent`) is pure with respect to the DOM, so it is
 * unit-tested directly in Node.
 */

/** Topics a panel can subscribe to. */
export const Topic = Object.freeze({
  Connection: 'connection',
  Scenes: 'scenes',
  SceneItems: 'sceneItems',
  Inputs: 'inputs',
  Audio: 'audio',
  Filters: 'filters',
  Transitions: 'transitions',
  Outputs: 'outputs',
  Stats: 'stats',
  Config: 'config',
  Video: 'video',
  Hotkeys: 'hotkeys',
  Ui: 'ui',
});

const ALL_TOPICS = Object.values(Topic);

/** Which topics each OBS event invalidates. */
const EVENT_TOPICS = {
  SceneCreated: [Topic.Scenes],
  SceneRemoved: [Topic.Scenes, Topic.SceneItems],
  SceneNameChanged: [Topic.Scenes, Topic.SceneItems],
  SceneListChanged: [Topic.Scenes],
  CurrentProgramSceneChanged: [Topic.Scenes, Topic.SceneItems, Topic.Outputs],
  CurrentPreviewSceneChanged: [Topic.Scenes, Topic.SceneItems],

  SceneItemCreated: [Topic.SceneItems],
  SceneItemRemoved: [Topic.SceneItems],
  SceneItemListReindexed: [Topic.SceneItems],
  SceneItemEnableStateChanged: [Topic.SceneItems],
  SceneItemLockStateChanged: [Topic.SceneItems],
  SceneItemSelected: [Topic.SceneItems],
  SceneItemTransformChanged: [Topic.SceneItems],

  InputCreated: [Topic.Inputs, Topic.Audio],
  InputRemoved: [Topic.Inputs, Topic.Audio, Topic.Filters],
  InputNameChanged: [Topic.Inputs, Topic.Audio, Topic.Filters],
  InputSettingsChanged: [Topic.Inputs],
  InputActiveStateChanged: [Topic.Inputs],
  InputShowStateChanged: [Topic.Inputs],
  InputMuteStateChanged: [Topic.Audio],
  InputVolumeChanged: [Topic.Audio],
  InputAudioBalanceChanged: [Topic.Audio],
  InputAudioSyncOffsetChanged: [Topic.Audio],
  InputAudioTracksChanged: [Topic.Audio],
  InputAudioMonitorTypeChanged: [Topic.Audio],
  InputVolumeMeters: [Topic.Audio],
  MediaInputPlaybackStarted: [Topic.Inputs],
  MediaInputPlaybackEnded: [Topic.Inputs],
  MediaInputActionTriggered: [Topic.Inputs],

  SourceFilterCreated: [Topic.Filters],
  SourceFilterRemoved: [Topic.Filters],
  SourceFilterNameChanged: [Topic.Filters],
  SourceFilterSettingsChanged: [Topic.Filters],
  SourceFilterEnableStateChanged: [Topic.Filters],
  SourceFilterListReindexed: [Topic.Filters],

  CurrentSceneTransitionChanged: [Topic.Transitions],
  CurrentSceneTransitionDurationChanged: [Topic.Transitions],
  SceneTransitionStarted: [Topic.Transitions],
  SceneTransitionEnded: [Topic.Transitions],
  SceneTransitionVideoEnded: [Topic.Transitions],

  StreamStateChanged: [Topic.Outputs],
  RecordStateChanged: [Topic.Outputs],
  RecordFileChanged: [Topic.Outputs],
  ReplayBufferStateChanged: [Topic.Outputs],
  ReplayBufferSaved: [Topic.Outputs],
  VirtualcamStateChanged: [Topic.Outputs],

  CurrentSceneCollectionChanging: [Topic.Config],
  CurrentSceneCollectionChanged: [Topic.Config],
  SceneCollectionListChanged: [Topic.Config],
  CurrentProfileChanging: [Topic.Config],
  CurrentProfileChanged: [Topic.Config],
  ProfileListChanged: [Topic.Config],

  StudioModeStateChanged: [Topic.Ui, Topic.Scenes, Topic.SceneItems],
  ExitStarted: [Topic.Connection],
  ScreenshotSaved: [Topic.Ui],
  VendorEvent: [],
  CustomEvent: [],
};

/** Build the initial (disconnected) state. */
export function createState() {
  return {
    connection: {
      status: 'disconnected', // disconnected | connecting | reconnecting | connected
      url: '',
      obsWebSocketVersion: null,
      rpcVersion: null,
      obsVersion: null,
      error: null,
      attempt: 0,
    },
    /** Scenes in display order (top of the OBS list first). */
    scenes: [],
    currentProgramScene: null,
    currentPreviewScene: null,
    studioMode: false,
    /** sceneName -> scene items, index 0 = top of the OBS source list. */
    sceneItems: {},
    /** inputName -> { inputKind, unversionedInputKind } */
    inputs: {},
    /** inputName -> audio state */
    audio: {},
    /** inputName -> playback state */
    media: {},
    /** sourceName -> filter list */
    filters: {},
    transitions: [],
    currentTransition: { transitionName: null, transitionDuration: 300, transitionKind: null, transitionSettings: {} },
    transitionActive: false,
    outputs: {
      streaming: { active: false, state: null, timecode: '00:00:00.000', bytes: 0, skippedFrames: 0, totalFrames: 0, congestion: 0, reconnecting: false },
      recording: { active: false, paused: false, state: null, timecode: '00:00:00.000', bytes: 0, path: null },
      replayBuffer: { active: false, state: null, lastReplayPath: null },
      virtualCam: { active: false, state: null },
    },
    stats: null,
    video: null,
    profiles: { current: null, list: [] },
    sceneCollections: { current: null, list: [] },
    hotkeys: [],
    version: null,
    /** Transient UI-only state mirrored here for convenience. */
    ui: {
      programSceneLabel: null,
      lastScreenshotPath: null,
      safeMode: false,
    },
  };
}

const ensureInput = (state, inputName) => {
  if (!inputName) return null;
  state.inputs[inputName] ??= { inputName, inputKind: null, unversionedInputKind: null };
  state.audio[inputName] ??= {
    volumeMul: 1,
    volumeDb: 0,
    muted: false,
    tracks: { 1: true },
    monitorType: 'OBS_MONITORING_TYPE_NONE',
    syncOffset: 0,
    balance: 0.5,
    levels: [],
    active: false,
    showing: false,
  };
  state.audio[inputName].inputName = inputName;
  return state.audio[inputName];
};

const ensureSceneItems = (state, sceneName) => {
  if (!sceneName) return null;
  state.sceneItems[sceneName] ??= [];
  return state.sceneItems[sceneName];
};

const sortByIndex = (list, indexKey) => list.sort((a, b) => (a[indexKey] ?? 0) - (b[indexKey] ?? 0));

/**
 * Apply one obs-websocket event to `state` in place.
 * @returns {boolean} whether anything changed
 */
export function reduceEvent(state, eventType, data = {}) {
  switch (eventType) {
    /* ------------------------------------------------------------- scenes */
    case 'SceneCreated': {
      if (!data.sceneName) break;
      if (!state.scenes.some((s) => s.sceneName === data.sceneName)) {
        state.scenes.unshift({ sceneName: data.sceneName, sceneIndex: state.scenes.length });
      }
      ensureSceneItems(state, data.sceneName);
      break;
    }
    case 'SceneRemoved': {
      state.scenes = state.scenes.filter((s) => s.sceneName !== data.sceneName);
      delete state.sceneItems[data.sceneName];
      if (state.currentProgramScene === data.sceneName) state.currentProgramScene = null;
      if (state.currentPreviewScene === data.sceneName) state.currentPreviewScene = null;
      break;
    }
    case 'SceneNameChanged': {
      const scene = state.scenes.find((s) => s.sceneName === data.oldSceneName);
      if (scene) scene.sceneName = data.sceneName;
      if (state.sceneItems[data.oldSceneName]) {
        state.sceneItems[data.sceneName] = state.sceneItems[data.oldSceneName];
        delete state.sceneItems[data.oldSceneName];
      }
      if (state.currentProgramScene === data.oldSceneName) state.currentProgramScene = data.sceneName;
      if (state.currentPreviewScene === data.oldSceneName) state.currentPreviewScene = data.sceneName;
      break;
    }
    case 'SceneListChanged': {
      if (Array.isArray(data.scenes)) {
        state.scenes = data.scenes.map((s) => ({ ...s }));
      }
      break;
    }
    case 'CurrentProgramSceneChanged': {
      state.currentProgramScene = data.sceneName ?? null;
      break;
    }
    case 'CurrentPreviewSceneChanged': {
      state.currentPreviewScene = data.sceneName ?? null;
      break;
    }

    /* -------------------------------------------------------- scene items */
    case 'SceneItemCreated': {
      const list = ensureSceneItems(state, data.sceneName);
      if (!list) break;
      if (list.some((i) => i.sceneItemId === data.sceneItemId)) break;
      list.push({
        sceneItemId: data.sceneItemId,
        sourceName: data.sourceName,
        sceneItemEnabled: true,
        sceneItemLocked: false,
        sceneItemIndex: data.sceneItemIndex ?? list.length,
        sceneItemTransform: null,
      });
      sortByIndex(list, 'sceneItemIndex');
      break;
    }
    case 'SceneItemRemoved': {
      const list = state.sceneItems[data.sceneName];
      if (!list) break;
      state.sceneItems[data.sceneName] = list.filter((i) => i.sceneItemId !== data.sceneItemId);
      break;
    }
    case 'SceneItemListReindexed': {
      const list = ensureSceneItems(state, data.sceneName);
      if (!list || !Array.isArray(data.sceneItems)) break;
      for (const entry of data.sceneItems) {
        const item = list.find((i) => i.sceneItemId === entry.sceneItemId);
        if (item) item.sceneItemIndex = entry.sceneItemIndex;
      }
      sortByIndex(list, 'sceneItemIndex');
      break;
    }
    case 'SceneItemEnableStateChanged': {
      const item = findSceneItem(state, data.sceneName, data.sceneItemId);
      if (item) item.sceneItemEnabled = data.sceneItemEnabled;
      break;
    }
    case 'SceneItemLockStateChanged': {
      const item = findSceneItem(state, data.sceneName, data.sceneItemId);
      if (item) item.sceneItemLocked = data.sceneItemLocked;
      break;
    }
    case 'SceneItemTransformChanged': {
      const item = findSceneItem(state, data.sceneName, data.sceneItemId);
      if (item) item.sceneItemTransform = data.sceneItemTransform;
      break;
    }

    /* -------------------------------------------------------------- inputs */
    case 'InputCreated': {
      state.inputs[data.inputName] = {
        inputName: data.inputName,
        inputUuid: data.inputUuid,
        inputKind: data.inputKind,
        unversionedInputKind: data.unversionedInputKind,
      };
      ensureInput(state, data.inputName);
      break;
    }
    case 'InputRemoved': {
      delete state.inputs[data.inputName];
      delete state.audio[data.inputName];
      delete state.filters[data.inputName];
      break;
    }
    case 'InputNameChanged': {
      const entry = state.inputs[data.oldInputName];
      if (entry) {
        delete state.inputs[data.oldInputName];
        entry.inputName = data.inputName;
        state.inputs[data.inputName] = entry;
      }
      if (state.audio[data.oldInputName]) {
        state.audio[data.inputName] = state.audio[data.oldInputName];
        delete state.audio[data.oldInputName];
      }
      if (state.filters[data.oldInputName]) {
        state.filters[data.inputName] = state.filters[data.oldInputName];
        delete state.filters[data.oldInputName];
      }
      for (const list of Object.values(state.sceneItems)) {
        for (const item of list) if (item.sourceName === data.oldInputName) item.sourceName = data.inputName;
      }
      break;
    }
    case 'InputMuteStateChanged': {
      const audio = ensureInput(state, data.inputName);
      if (audio) audio.muted = data.inputMuted;
      break;
    }
    case 'InputVolumeChanged': {
      const audio = ensureInput(state, data.inputName);
      if (audio) {
        audio.volumeMul = data.inputVolumeMul;
        audio.volumeDb = data.inputVolumeDb;
      }
      break;
    }
    case 'InputAudioBalanceChanged': {
      const audio = ensureInput(state, data.inputName);
      if (audio) audio.balance = data.inputAudioBalance;
      break;
    }
    case 'InputAudioSyncOffsetChanged': {
      const audio = ensureInput(state, data.inputName);
      if (audio) audio.syncOffset = data.inputAudioSyncOffset;
      break;
    }
    case 'InputAudioTracksChanged': {
      const audio = ensureInput(state, data.inputName);
      if (audio) audio.tracks = data.inputAudioTracks;
      break;
    }
    case 'InputAudioMonitorTypeChanged': {
      const audio = ensureInput(state, data.inputName);
      if (audio) audio.monitorType = data.monitorType;
      break;
    }
    case 'InputActiveStateChanged': {
      const audio = ensureInput(state, data.inputName);
      if (audio) audio.active = data.videoActive;
      break;
    }
    case 'InputShowStateChanged': {
      const audio = ensureInput(state, data.inputName);
      if (audio) audio.showing = data.videoShowing;
      break;
    }
    case 'InputVolumeMeters': {
      for (const entry of data.inputs ?? []) {
        const audio = ensureInput(state, entry.inputName);
        if (audio) audio.levels = entry.inputLevelsMul ?? [];
      }
      break;
    }
    case 'MediaInputPlaybackStarted': {
      state.media[data.inputName] = { ...(state.media[data.inputName] ?? {}), state: 'playing' };
      break;
    }
    case 'MediaInputPlaybackEnded': {
      state.media[data.inputName] = { ...(state.media[data.inputName] ?? {}), state: 'ended' };
      break;
    }

    /* ------------------------------------------------------------- filters */
    case 'SourceFilterCreated': {
      const list = (state.filters[data.sourceName] ??= []);
      if (!list.some((f) => f.filterName === data.filterName)) {
        list.push({
          filterName: data.filterName,
          filterKind: data.filterKind,
          filterEnabled: true,
          filterIndex: data.filterIndex ?? list.length,
          filterSettings: data.filterSettings ?? {},
        });
        sortByIndex(list, 'filterIndex');
      }
      break;
    }
    case 'SourceFilterRemoved': {
      const list = state.filters[data.sourceName];
      if (list) state.filters[data.sourceName] = list.filter((f) => f.filterName !== data.filterName);
      break;
    }
    case 'SourceFilterNameChanged': {
      const filter = (state.filters[data.sourceName] ?? []).find((f) => f.filterName === data.oldFilterName);
      if (filter) filter.filterName = data.filterName;
      break;
    }
    case 'SourceFilterSettingsChanged': {
      const filter = (state.filters[data.sourceName] ?? []).find((f) => f.filterName === data.filterName);
      if (filter) filter.filterSettings = data.filterSettings;
      break;
    }
    case 'SourceFilterEnableStateChanged': {
      const filter = (state.filters[data.sourceName] ?? []).find((f) => f.filterName === data.filterName);
      if (filter) filter.filterEnabled = data.filterEnabled;
      break;
    }
    case 'SourceFilterListReindexed': {
      state.filters[data.sourceName] = (data.filters ?? []).map((f) => ({
        filterName: f.filterName,
        filterKind: f.filterKind,
        filterEnabled: f.filterEnabled,
        filterIndex: f.filterIndex,
        filterSettings: f.filterSettings ?? {},
      }));
      break;
    }

    /* --------------------------------------------------------- transitions */
    case 'CurrentSceneTransitionChanged': {
      state.currentTransition.transitionName = data.transitionName;
      break;
    }
    case 'CurrentSceneTransitionDurationChanged': {
      state.currentTransition.transitionDuration = data.transitionDuration;
      break;
    }
    case 'SceneTransitionStarted': {
      state.transitionActive = true;
      break;
    }
    case 'SceneTransitionEnded':
    case 'SceneTransitionVideoEnded': {
      state.transitionActive = false;
      break;
    }

    /* ------------------------------------------------------------- outputs */
    case 'StreamStateChanged': {
      state.outputs.streaming.active = data.outputActive;
      state.outputs.streaming.state = data.outputState;
      break;
    }
    case 'RecordStateChanged': {
      state.outputs.recording.active = data.outputActive;
      state.outputs.recording.state = data.outputState;
      state.outputs.recording.paused = data.outputState === 'OBS_WEBSOCKET_OUTPUT_PAUSED';
      if (data.outputPath) state.outputs.recording.path = data.outputPath;
      break;
    }
    case 'RecordFileChanged': {
      state.outputs.recording.path = data.newOutputPath;
      break;
    }
    case 'ReplayBufferStateChanged': {
      state.outputs.replayBuffer.active = data.outputActive;
      state.outputs.replayBuffer.state = data.outputState;
      break;
    }
    case 'ReplayBufferSaved': {
      state.outputs.replayBuffer.lastReplayPath = data.savedReplayPath;
      break;
    }
    case 'VirtualcamStateChanged': {
      state.outputs.virtualCam.active = data.outputActive;
      state.outputs.virtualCam.state = data.outputState;
      break;
    }

    /* -------------------------------------------------------------- config */
    case 'CurrentSceneCollectionChanged':
    case 'CurrentSceneCollectionChanging': {
      state.sceneCollections.current = data.sceneCollectionName;
      break;
    }
    case 'SceneCollectionListChanged': {
      state.sceneCollections.list = data.sceneCollections ?? [];
      break;
    }
    case 'CurrentProfileChanged':
    case 'CurrentProfileChanging': {
      state.profiles.current = data.profileName;
      break;
    }
    case 'ProfileListChanged': {
      state.profiles.list = data.profiles ?? [];
      break;
    }

    /* ------------------------------------------------------------------ ui */
    case 'StudioModeStateChanged': {
      state.studioMode = data.studioModeEnabled;
      if (!data.studioModeEnabled) state.currentPreviewScene = null;
      break;
    }
    case 'ScreenshotSaved': {
      state.ui.lastScreenshotPath = data.savedScreenshotPath;
      break;
    }
    case 'ExitStarted': {
      state.connection.status = 'disconnected';
      state.connection.error = 'OBS is shutting down';
      break;
    }

    default:
      return false;
  }
  return true;
}

function findSceneItem(state, sceneName, sceneItemId) {
  return (state.sceneItems[sceneName] ?? []).find((i) => i.sceneItemId === sceneItemId);
}

/** Topics invalidated by an event (empty array => nothing to re-render). */
export function topicsForEvent(eventType) {
  return EVENT_TOPICS[eventType] ?? [];
}

/* ------------------------------------------------------------------- store */

export class Store {
  constructor(state = createState()) {
    this.state = state;
    this.listeners = new Set();
    this.batchDepth = 0;
    this.pendingTopics = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Notify listeners about one or more topics. */
  notify(...topics) {
    for (const topic of topics) this.pendingTopics.add(topic);
    if (this.batchDepth > 0) return;
    this.#flush();
  }

  notifyAll() {
    this.notify(...ALL_TOPICS);
  }

  #flush() {
    if (!this.pendingTopics.size) return;
    const topics = this.pendingTopics;
    this.pendingTopics = new Set();
    for (const fn of [...this.listeners]) {
      try {
        fn(this.state, topics);
      } catch (err) {
        console.error('[store] listener failed', err);
      }
    }
  }

  /** Group several mutations into a single notification pass. */
  batch(fn) {
    this.batchDepth++;
    try {
      fn(this);
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) this.#flush();
    }
  }

  /** Shallow-merge a patch into a top-level slice and notify its topic. */
  patch(partial, ...topics) {
    Object.assign(this.state, partial);
    this.notify(...(topics.length ? topics : ALL_TOPICS));
  }

  applyEvent(eventType, data) {
    if (reduceEvent(this.state, eventType, data)) {
      this.notify(...topicsForEvent(eventType));
    }
  }

  setConnection(patch) {
    Object.assign(this.state.connection, patch);
    this.notify(Topic.Connection);
  }
}

/* -------------------------------------------------------------- selectors */

export const selectors = {
  scenes: (state) => state.scenes,
  sceneByName: (state, name) => state.scenes.find((s) => s.sceneName === name) ?? null,
  currentProgramScene: (state) => state.currentProgramScene,
  currentPreviewScene: (state) => state.currentPreviewScene,
  sceneItems: (state, sceneName) => state.sceneItems[sceneName] ?? [],
  inputs: (state) => Object.values(state.inputs),
  audio: (state, inputName) => state.audio[inputName] ?? null,
  filters: (state, sourceName) => state.filters[sourceName] ?? [],
  /**
   * The scene rendered in the sources panel / preview pane, honouring studio
   * mode.  When Studio Mode is enabled OBS starts the preview on the current
   * program scene, so fall back to it if OBS has not reported a preview scene.
   */
  previewPaneScene: (state) =>
    state.studioMode
      ? state.currentPreviewScene ?? state.currentProgramScene
      : state.currentProgramScene,
  programPaneScene: (state) => state.currentProgramScene,
};
