/*
 * WebMIX - application bootstrap.
 *
 * Connects to OBS over obs-websocket, builds the desktop-equivalent UI and
 * keeps it in sync with OBS events.  See web/docs/ui-spec.md for the layout
 * this reproduces.
 */
import { Store, Topic, selectors } from './store.js';
import { ObsClient } from './obs-client.js';
import { ObsApi } from './api.js';
import { h, qs, clear, setText, setClass } from './dom.js';
import { MenuBar } from './ui/menu.js';
import { Dock } from './ui/dock.js';
import { ScenesPanel } from './ui/scenes.js';
import { SourcesPanel } from './ui/sources.js';
import { MixerPanel } from './ui/mixer.js';
import { TransitionsPanel } from './ui/transitions.js';
import { ControlsPanel } from './ui/controls.js';
import { StatusBar } from './ui/statusbar.js';
import { PreviewPanel } from './ui/preview.js';
import { SourceToolbar } from './ui/source-toolbar.js';
import { StatsPanel } from './ui/stats.js';
import { CustomDocksPanel } from './ui/custom-docks.js';
import { loadBindings, matchBinding, isTypingTarget } from './hotkeys.js';
import { detectHost, requestShutdown } from './host.js';
import { openFilesDialog } from './ui/files.js';
import { WebGpuPreview } from './webgpu-preview.js';
import { openDialog, dialogButtons, alert, confirm, showContextMenu } from './ui/dialog.js';
import {
  openPropertiesDialog,
  openFiltersDialog,
  openTransformDialog,
  openStatsDialog,
  openAdvancedAudioDialog,
  openSettingsDialog,
  openAboutDialog,
} from './ui/dialogs.js';

const STORAGE_KEY = 'webmix.connection';
const LAYOUT_KEY = 'webmix.layout';

const store = new Store();
let client = null;
let api = null;
let ui = null;
/** Whether the page is served by OBS itself (--web) or by an external server. */
let host = { embedded: false, shutdown: false };

/* ------------------------------------------------------------------ connect */

function savedConnection() {
  const params = new URLSearchParams(location.search);
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    saved = {};
  }
  // Explicit query parameters are a deliberate override and must beat both the
  // remembered values and whatever the hosting server reports.
  const fromUrl = params.has('host') || params.has('port');
  const host = params.get('host') ?? saved.host ?? location.hostname ?? '127.0.0.1';
  const port = Number(params.get('port') ?? saved.port ?? 4455);
  const password = params.get('password') ?? saved.password ?? '';
  const autoconnect = params.get('autoconnect') === '1' || saved.autoconnect === true;
  return { host, port, password, autoconnect, fromUrl };
}

function persistConnection(connection) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...connection, password: connection.password ?? '' }));
  } catch {
    /* storage may be unavailable */
  }
}

/** Prefill from the dev server, which can read OBS's own websocket config. */
async function fetchServerConfig() {
  try {
    const response = await fetch('obs-config.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.server_enabled === false) return data ?? null;
    return {
      host: location.hostname || '127.0.0.1',
      port: data.server_port ?? 4455,
      password: data.server_password ?? '',
      serverEnabled: data.server_enabled !== false,
    };
  } catch {
    return null;
  }
}

function renderConnectScreen(connection, { status = '', kind = '' } = {}) {
  const body = qs('#connect-body');
  const footer = qs('#connect-footer');
  clear(body);
  clear(footer);

  const hostInput = h('input.obs-input', { type: 'text', value: connection.host, style: { width: '100%' } });
  const portInput = h('input.obs-input', { type: 'number', value: String(connection.port), style: { width: '100%' } });
  const passwordInput = h('input.obs-input', { type: 'password', value: connection.password ?? '', style: { width: '100%' } });
  const autoconnect = h('input.obs-checkbox', { type: 'checkbox', checked: connection.autoconnect === true });
  const statusEl = h(`div.obs-connect-status${kind ? `.is-${kind}` : ''}`, { text: status });

  body.append(
    h('div.obs-connect-logo', { text: 'WebMIX' }),
    h('div.obs-hint.obs-muted', {
      text: 'Connect to OBS Studio. Enable the WebSocket server in OBS under Tools > WebSocket Server Settings.',
    }),
    h('div.obs-property-row', {}, [h('label.obs-label', { text: 'Host' }), hostInput]),
    h('div.obs-property-row', {}, [h('label.obs-label', { text: 'Port' }), portInput]),
    h('div.obs-property-row', {}, [h('label.obs-label', { text: 'Password' }), passwordInput]),
    h('div.obs-property-row', {}, [
      h('label.obs-label', { text: 'Auto connect' }),
      h('label.obs-radio-label', {}, [autoconnect, 'Reconnect on load']),
    ]),
    statusEl
  );

  const connectButton = h('button.obs-btn.primary', {
    type: 'button',
    text: 'Connect',
    on: {
      click: () => {
        const next = {
          host: hostInput.value.trim() || '127.0.0.1',
          port: Number(portInput.value) || 4455,
          password: passwordInput.value,
          autoconnect: autoconnect.checked,
        };
        persistConnection(next);
        connect(next);
      },
    },
  });
  footer.append(connectButton);

  for (const input of [hostInput, portInput, passwordInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') connectButton.click();
    });
  }
  setTimeout(() => hostInput.focus(), 0);

  return { setStatus: (text, kindName = '') => {
    setText(statusEl, text);
    statusEl.className = `obs-connect-status${kindName ? ` is-${kindName}` : ''}`;
  } };
}

let connectScreenApi = null;

async function connect(connection) {
  const setStatus = connectScreenApi?.setStatus ?? (() => {});
  setStatus('Connecting...');

  if (client) client.disconnect();

  client = new ObsClient({
    host: connection.host,
    port: connection.port,
    password: connection.password ?? '',
    autoReconnect: true,
    eventSubscriptions: undefined,
  });
  api = new ObsApi(client, store);
  wireClient(connection);

  try {
    await client.connect();
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  }
  setStatus('Connected', 'ok');
}

function wireClient(connection) {
  client.on('status', (status) => {
    store.setConnection({ status });
    if (status === 'reconnecting' || status === 'connecting') {
      ui?.statusbar.showMessage(`Reconnecting to ${connection.host}:${connection.port}...`, 'warning', 0);
    }
  });

  client.on('reconnecting', ({ attempt }) => {
    store.setConnection({ status: 'reconnecting', attempt });
  });

  client.on('connected', async (info) => {
    store.setConnection({
      status: 'connected',
      url: client.url,
      obsWebSocketVersion: info.obsWebSocketVersion,
      rpcVersion: info.negotiatedRpcVersion,
      error: null,
    });
    qs('#connect-screen').hidden = true;
    qs('#app').hidden = false;
    try {
      await api.refreshAll();
    } catch (err) {
      console.warn('[webmix] initial state load failed', err);
    }
    // The UI is created on the first successful connection so the panels bind
    // to a live store.
    if (!ui) ui = buildUi();
    ui.statusbar.showMessage(`Connected to ${client.url}`, 'success', 4000);
    await ui.init();
  });

  client.on('disconnected', ({ code, reason }) => {
    store.setConnection({ status: 'disconnected', error: reason || `code ${code}` });
    ui?.statusbar.showMessage(`Disconnected from OBS (code ${code}). Reconnecting...`, 'error', 0);
  });

  client.on('authfailed', () => {
    qs('#app').hidden = true;
    qs('#connect-screen').hidden = false;
    connectScreenApi?.setStatus('Authentication failed - check the WebSocket password', 'error');
  });

  client.on('event', ({ eventType, eventData }) => {
    store.applyEvent(eventType, eventData);
  });

  client.on('protocolError', (message) => {
    console.warn('[webmix] protocol error:', message);
  });
}

/* ----------------------------------------------------------------------- UI */

function buildUi() {
  const store2 = store;

  const statusbar = new StatusBar({ store: store2, root: qs('#statusbar') });
  const preview = new PreviewPanel({
    store: store2,
    api,
    canvas: qs('#preview-canvas'),
    labels: qs('#preview-labels'),
    placeholder: qs('#preview-placeholder'),
    host,
    onContextAction: (action, payload) => handlePreviewAction(action, payload),
  });

  const sourceToolbar = new SourceToolbar({
    store: store2,
    api,
    root: qs('#source-toolbar'),
    onStatus: (text, kind) => statusbar.showMessage(text, kind),
  });

  const scenes = new ScenesPanel({
    store: store2,
    api,
    onStatus: (text, kind) => statusbar.showMessage(text, kind),
  });

  const sources = new SourcesPanel({
    store: store2,
    api,
    onStatus: (text, kind) => statusbar.showMessage(text, kind),
    onSelectSource: (name) => sourceToolbar.setSelection(name),
  });

  const mixer = new MixerPanel({
    store: store2,
    api,
    onStatus: (text, kind) => statusbar.showMessage(text, kind),
    onSelectSource: (name) => {
      sources.select(name);
      sourceToolbar.setSelection(name);
    },
    onAdvancedAudio: () =>
      openAdvancedAudioDialog({ api, store: store2, onStatus: (t, k) => statusbar.showMessage(t, k) }),
  });

  const transitions = new TransitionsPanel({
    store: store2,
    api,
    onStatus: (text, kind) => statusbar.showMessage(text, kind),
  });

  const controls = new ControlsPanel({
    store: store2,
    api,
    onStatus: (text, kind) => statusbar.showMessage(text, kind),
    onSettings: () => openSettings(),
    onVirtualCamConfig: () => openVirtualCamConfig(),
  });

  // Docks -------------------------------------------------------------------
  const statsPanel = new StatsPanel();
  const docks = {
    scenes: new Dock({ id: 'scenes', title: 'Scenes', content: scenes.el }),
    sources: new Dock({ id: 'sources', title: 'Sources', content: sources.el }),
    transitions: new Dock({ id: 'transitions', title: 'Scene Transitions', content: transitions.el }),
    controls: new Dock({ id: 'controls', title: 'Controls', content: controls.el }),
    mixer: new Dock({ id: 'mixer', title: 'Audio Mixer', content: mixer.el }),
    // OBS ships the Stats dock hidden and floating by default.
    stats: new Dock({ id: 'stats', title: 'Stats', content: statsPanel.el }),
  };

  for (const [id, dock] of Object.entries(docks)) {
    const slot = qs(`.obs-dock-slot[data-dock="${id}"]`);
    dock.onClose = () => setDockVisible(id, false);
    slot.appendChild(dock.el);
  }

  // Custom Browser Docks (Docks > Custom Browser Docks...) -------------------
  const customDocks = new CustomDocksPanel({
    column: qs('#dock-right'),
    onStatus: (text, kind) => statusbar.showMessage(text, kind),
  });

  function syncCustomDocks() {
    customDocks.render();
    const column = qs('#dock-right');
    qs('#splitter-right').hidden = column.hidden;
  }

  const dockVisibility = restoreLayout().docks ?? {
    scenes: true,
    sources: true,
    transitions: true,
    controls: true,
    mixer: true,
    stats: false,
  };
  if (dockVisibility.stats === undefined) dockVisibility.stats = false;

  function setDockVisible(id, visible) {
    dockVisibility[id] = visible;
    const dock = docks[id];
    const slot = qs(`.obs-dock-slot[data-dock="${id}"]`);
    dock.setVisible(visible);
    slot.hidden = !visible;
    // Hide the splitter that belongs to a hidden dock.
    const splitter = slot.previousElementSibling;
    if (splitter?.classList.contains('obs-splitter')) splitter.hidden = !visible;
    menuBar.syncChecks?.();
    saveLayout({ docks: dockVisibility });
  }

  // Source selection events from panels.
  document.addEventListener('webmix:open-filters', (event) =>
    openFilters(event.detail.sourceName)
  );
  document.addEventListener('webmix:open-properties', (event) =>
    openProperties(event.detail.sourceName)
  );

  const statusMessage = (text, kind = 'info') => statusbar.showMessage(text, kind);

  async function openProperties(sourceName) {
    await openPropertiesDialog({ api, store: store2, sourceName, onStatus: statusMessage });
  }
  async function openFilters(sourceName) {
    await openFiltersDialog({ api, store: store2, sourceName, onStatus: statusMessage });
  }
  async function openSettings() {
    await openSettingsDialog({ api, store: store2, onStatus: statusMessage });
  }
  async function openVirtualCamConfig() {
    const dialog = openDialog({
      title: 'Virtual Camera Config',
      width: 460,
      body: [
        h('div.obs-hint.obs-muted', {
          text: 'Virtual camera output resolution and type are configured in the OBS desktop UI (Settings > Output > Virtual Camera).',
        }),
      ],
      footer: dialogButtons([
        {
          label: 'Stop Virtual Camera',
          danger: true,
          action: async () => {
            await api.stopVirtualCam().catch((err) => statusMessage(err.message, 'error'));
          },
        },
        { label: 'Close', primary: true, action: () => dialog.close() },
      ]),
    });
  }

  // Menu --------------------------------------------------------------------
  const menuBar = new MenuBar(qs('#menubar'), {
    onAction: (action) => handleAction(action),
    isChecked: (id) => {
      switch (id) {
        case 'lockDocks':
          return layoutState.locked !== false;
        case 'sideDocks':
          return layoutState.side !== false;
        case 'toggleListboxToolbars':
          return layoutState.dockToolbars !== false;
        case 'toggleContextBar':
          return layoutState.sourceToolbar !== false;
        case 'toggleSourceIcons':
          return layoutState.sourceIcons !== false;
        case 'toggleStatusBar':
          return layoutState.statusBar !== false;
        case 'actionAlwaysOnTop':
          return Boolean(document.fullscreenElement);
        case 'actionLockPreview':
          return preview.locked;
        case 'actionSceneListMode':
          return !scenes.gridMode;
        case 'actionSceneGridMode':
          return scenes.gridMode;
        case 'actionScaleWindow':
          return preview.scaling === 'window';
        case 'actionScaleCanvas':
          return preview.scaling === 'canvas';
        case 'actionScaleOutput':
          return preview.scaling === 'output';
        default:
          if (id.startsWith('dock:')) return dockVisibility[id.slice(5)] !== false;
          if (id.startsWith('custom:')) return customDocks.isEnabled(id.slice(7));
          return false;
      }
    },
    isDisabled: (id) => {
      if (id === 'actionRemoveProfile') return (store2.state.profiles.list ?? []).length <= 1;
      if (id === 'actionRemoveSceneCollection') return (store2.state.sceneCollections.list ?? []).length <= 1;
      return false;
    },
    buildDynamic: (menuId) => {
      if (menuId === 'docks') {
        const items = Object.keys(docks).map((id) => ({
          id: `dock:${id}`,
          label: docks[id].title,
          type: 'check',
          checked: dockVisibility[id] !== false,
          action: `dock:${id}`,
        }));
        // One toggle per custom browser dock, like OBS appends after its docks.
        for (const dock of customDocks.entries) {
          items.push({
            id: `custom:${dock.id}`,
            label: dock.name || dock.url,
            type: 'check',
            checked: customDocks.isEnabled(dock.id),
            action: `custom:${dock.id}`,
          });
        }
        return items;
      }
      if (menuId === 'profile') {
        return [
          { separator: true },
          ...(store2.state.profiles.list ?? []).map((name) => ({
            id: `profile:${name}`,
            label: name,
            type: 'check',
            checked: store2.state.profiles.current === name,
            action: `profile:${name}`,
          })),
        ];
      }
      if (menuId === 'sceneCollection') {
        return [
          { separator: true },
          ...(store2.state.sceneCollections.list ?? []).map((name) => ({
            id: `collection:${name}`,
            label: name,
            type: 'check',
            checked: store2.state.sceneCollections.current === name,
            action: `collection:${name}`,
          })),
        ];
      }
      return [];
    },
  });

  /* --------------------------------------------------------- action handler */

  async function handleAction(action) {
    if (action.startsWith('dock:')) {
      const id = action.slice(5);
      setDockVisible(id, dockVisibility[id] === false);
      return;
    }
    if (action.startsWith('custom:')) {
      const id = action.slice(7);
      customDocks.setEnabled(id, !customDocks.isEnabled(id));
      syncCustomDocks();
      menuBar.syncChecks?.();
      return;
    }
    if (action === 'manageCustomDocks') {
      customDocks.openManager();
      return;
    }
    if (action.startsWith('profile:')) {
      await api.setCurrentProfile(action.slice(8)).catch((err) => statusMessage(err.message, 'error'));
      return;
    }
    if (action.startsWith('collection:')) {
      await api.setCurrentSceneCollection(action.slice(11)).catch((err) => statusMessage(err.message, 'error'));
      return;
    }

    const selected = sources.selected;
    const sceneName = selectors.previewPaneScene(store2.state);
    const sceneItem = selected
      ? selectors.sceneItems(store2.state, sceneName).find((i) => i.sourceName === selected)
      : null;

    switch (action) {
      case 'exit':
        if (await confirm({ title: 'Exit OBS', text: 'Shut down OBS Studio?', okLabel: 'Exit', danger: true })) {
          // Served by OBS itself: the embedded server exposes a shutdown
          // endpoint, so Exit really works (obs-websocket has no such request).
          if (host.shutdown && (await requestShutdown())) {
            statusMessage('OBS is shutting down', 'success');
            break;
          }
          statusMessage(
            host.embedded
              ? 'OBS refused the shutdown request; close it from its own window or tray'
              : 'OBS must be closed from its own window or the tray icon when the UI is served externally',
            'warning',
            8000
          );
        }
        break;

      case 'openSettings':
        await openSettings();
        break;

      case 'openStats':
        await openStatsDialog({ api, store: store2 });
        break;

      case 'advancedAudio':
        await openAdvancedAudioDialog({ api, store: store2, onStatus: statusMessage });
        break;

      case 'editTransform':
        if (!sceneItem) return statusMessage('Select a source first', 'warning');
        await openTransformDialog({
          api,
          store: store2,
          sceneName,
          sceneItemId: sceneItem.sceneItemId,
          onStatus: statusMessage,
        });
        break;

      case 'resetTransform':
        if (!sceneItem) return statusMessage('Select a source first', 'warning');
        await api
          .setSceneItemTransform(sceneName, sceneItem.sceneItemId, {
            positionX: 0,
            positionY: 0,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            cropLeft: 0,
            cropTop: 0,
            cropRight: 0,
            cropBottom: 0,
          })
          .catch((err) => statusMessage(err.message, 'error'));
        break;

      case 'fitToScreen':
      case 'stretchToScreen':
      case 'centerToScreen': {
        if (!sceneItem) return statusMessage('Select a source first', 'warning');
        const video = store2.state.video ?? {};
        const w = video.baseWidth ?? 1920;
        const h2 = video.baseHeight ?? 1080;
        const patch =
          action === 'fitToScreen'
            ? { boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: w, boundsHeight: h2 }
            : action === 'stretchToScreen'
              ? { boundsType: 'OBS_BOUNDS_STRETCH', boundsAlignment: 0, boundsWidth: w, boundsHeight: h2 }
              : { alignment: 0, positionX: w / 2, positionY: h2 / 2 };
        await api
          .setSceneItemTransform(sceneName, sceneItem.sceneItemId, patch)
          .catch((err) => statusMessage(err.message, 'error'));
        break;
      }

      case 'copyTransform':
        if (!sceneItem) return statusMessage('Select a source first', 'warning');
        try {
          const transform = await api.getSceneItemTransform(sceneName, sceneItem.sceneItemId);
          await navigator.clipboard?.writeText(JSON.stringify(transform));
          statusMessage('Transform copied', 'info');
        } catch (err) {
          statusMessage(err.message, 'error');
        }
        break;

      case 'pasteTransform':
        if (!sceneItem) return statusMessage('Select a source first', 'warning');
        try {
          const transform = JSON.parse(await navigator.clipboard.readText());
          await api.setSceneItemTransform(sceneName, sceneItem.sceneItemId, transform);
          statusMessage('Transform pasted', 'info');
        } catch (err) {
          statusMessage(`Could not paste transform: ${err.message}`, 'error');
        }
        break;

      case 'copyFilters':
        if (!selected) return statusMessage('Select a source first', 'warning');
        try {
          const filters = await api.refreshFilters(selected);
          await navigator.clipboard?.writeText(JSON.stringify(filters));
          statusMessage('Filters copied', 'info');
        } catch (err) {
          statusMessage(err.message, 'error');
        }
        break;

      case 'pasteFilters': {
        if (!selected) return statusMessage('Select a source first', 'warning');
        try {
          const filters = JSON.parse(await navigator.clipboard.readText());
          for (const filter of filters) {
            await api.createSourceFilter(selected, filter.filterName, filter.filterKind, filter.filterSettings ?? {});
          }
          statusMessage('Filters pasted', 'info');
        } catch (err) {
          statusMessage(`Could not paste filters: ${err.message}`, 'error');
        }
        break;
      }

      case 'copySource':
        if (!selected) return statusMessage('Select a source first', 'warning');
        try {
          const { inputSettings, inputKind } = await api.getInputSettings(selected);
          await navigator.clipboard?.writeText(JSON.stringify({ inputKind, inputSettings }));
          statusMessage('Source settings copied', 'info');
        } catch (err) {
          statusMessage(err.message, 'error');
        }
        break;

      case 'pasteRef':
      case 'pasteDup': {
        try {
          const payload = JSON.parse(await navigator.clipboard.readText());
          if (!payload?.inputKind) throw new Error('Clipboard does not contain a WebMIX source');
          const baseName = payload.inputName ?? payload.inputKind;
          const name = `${baseName} Copy`;
          await api.createInput(sceneName, name, payload.inputKind, payload.inputSettings ?? {});
          statusMessage(`Source pasted as "${name}"`, 'success');
        } catch (err) {
          statusMessage(`Could not paste source: ${err.message}`, 'error');
        }
        break;
      }

      case 'undo':
      case 'redo':
        statusMessage('Undo/Redo is not exposed by obs-websocket', 'warning');
        break;

      case 'moveUp':
      case 'moveDown':
      case 'moveToTop':
      case 'moveToBottom': {
        if (!selected || !sceneItem) return statusMessage('Select a source first', 'warning');
        const items = selectors.sceneItems(store2.state, sceneName);
        const index = items.findIndex((i) => i.sceneItemId === sceneItem.sceneItemId);
        const target =
          action === 'moveUp'
            ? index - 1
            : action === 'moveDown'
              ? index + 1
              : action === 'moveToTop'
                ? 0
                : items.length - 1;
        await api
          .setSceneItemIndex(sceneName, sceneItem.sceneItemId, Math.max(0, Math.min(items.length - 1, target)))
          .catch((err) => statusMessage(err.message, 'error'));
        break;
      }

      case 'showRecordings':
        await openFilesDialog({ kind: 'recordings', onStatus: statusMessage });
        break;
      case 'showSettingsFolder':
        await openFilesDialog({ kind: 'config', onStatus: statusMessage });
        break;
      case 'showProfileFolder':
        await openFilesDialog({ kind: 'profile', onStatus: statusMessage });
        break;
      case 'showLogs':
        await openFilesDialog({ kind: 'logs', canPreview: true, onStatus: statusMessage });
        break;
      case 'viewCurrentLog':
        await openFilesDialog({
          kind: 'logs',
          canPreview: true,
          openNewest: true,
          title: 'Current Log',
          onStatus: statusMessage,
        });
        break;
      case 'remuxRecordings':
        statusMessage('The Remux Recordings dialog is not available in the web UI yet', 'warning');
        break;
      case 'openPluginManager':
      case 'openScripts':
      case 'autoConfigure':
      case 'helpPortal':
      case 'website':
      case 'discord':
      case 'uploadCurrentLog':
      case 'uploadLastLog':
      case 'releaseNotes':
      case 'restartSafe':
      case 'showMissingFiles':
      case 'remigrateSceneCollection':
      case 'importProfile':
      case 'exportProfile':
      case 'importSceneCollection':
      case 'exportSceneCollection':
        statusMessage(`"${action}" is only available in the OBS desktop UI`, 'warning');
        break;

      case 'newProfile':
        await createNamed('New Profile', 'Profile name', (name) => api.createProfile(name));
        break;
      case 'duplicateProfile':
        statusMessage('Duplicating profiles is not exposed by obs-websocket', 'warning');
        break;
      case 'renameProfile':
        statusMessage('Renaming profiles is not exposed by obs-websocket', 'warning');
        break;
      case 'removeProfile':
        if (await confirm({ title: 'Remove Profile', text: `Remove profile "${store2.state.profiles.current}"?`, okLabel: 'Remove', danger: true })) {
          await api.removeProfile(store2.state.profiles.current).catch((err) => statusMessage(err.message, 'error'));
        }
        break;
      case 'newSceneCollection':
        await createNamed('New Scene Collection', 'Scene collection name', (name) => api.createSceneCollection(name));
        break;
      case 'duplicateSceneCollection':
        statusMessage('Duplicating scene collections is not exposed by obs-websocket', 'warning');
        break;
      case 'renameSceneCollection':
        statusMessage('Renaming scene collections is not exposed by obs-websocket', 'warning');
        break;
      case 'removeSceneCollection':
        statusMessage('Removing scene collections is not exposed by obs-websocket', 'warning');
        break;

      case 'resetUI':
        await resetLayout();
        break;
      case 'fullscreen':
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen().catch(() => {});
        break;
      case 'alwaysOnTop':
        statusMessage('Always On Top applies to the OBS desktop window', 'warning');
        break;
      case 'lockDocks':
        layoutState.locked = !(layoutState.locked !== false);
        statusMessage(layoutState.locked ? 'Docks locked' : 'Docks unlocked', 'info');
        saveLayout(layoutState);
        break;
      case 'sideDocks':
        layoutState.side = !(layoutState.side !== false);
        applySideDocks();
        saveLayout(layoutState);
        break;
      case 'resetDocks':
        await resetLayout();
        break;
      case 'toggleListboxToolbars':
        layoutState.dockToolbars = !(layoutState.dockToolbars !== false);
        applyLayoutFlags();
        saveLayout(layoutState);
        break;
      case 'toggleContextBar':
        layoutState.sourceToolbar = !(layoutState.sourceToolbar !== false);
        applyLayoutFlags();
        saveLayout(layoutState);
        break;
      case 'toggleSourceIcons':
        layoutState.sourceIcons = !(layoutState.sourceIcons !== false);
        applyLayoutFlags();
        saveLayout(layoutState);
        break;
      case 'toggleStatusBar':
        layoutState.statusBar = !(layoutState.statusBar !== false);
        applyLayoutFlags();
        saveLayout(layoutState);
        break;

      case 'sceneListMode':
        scenes.toggleGridMode(false);
        break;
      case 'sceneGridMode':
        scenes.toggleGridMode(true);
        break;
      case 'lockPreview':
        preview.setLocked(!preview.locked);
        menuBar.syncChecks?.();
        break;
      case 'scaleWindow':
        preview.setScaling('window');
        menuBar.syncChecks?.();
        break;
      case 'scaleCanvas':
        preview.setScaling('canvas');
        menuBar.syncChecks?.();
        break;
      case 'scaleOutput':
        preview.setScaling('output');
        menuBar.syncChecks?.();
        break;
      case 'previewZoomIn':
        preview.zoomIn();
        break;
      case 'previewZoomOut':
        preview.zoomOut();
        break;
      case 'previewResetZoom':
        preview.resetZoom();
        break;

      case 'screenshotPreview':
      case 'screenshotSource':
      case 'screenshotScene':
        await saveScreenshot(
          action === 'screenshotPreview' ? sceneName : selected ?? sceneName,
          statusMessage
        );
        break;

      case 'about':
        openAboutDialog({ store: store2, onStatus: statusMessage });
        break;

      default:
        statusMessage(`"${action}" is not implemented in the web UI yet`, 'warning');
    }
  }

  async function createNamed(title, label, fn) {
    const name = await promptName(title, label);
    if (!name) return;
    await fn(name).catch((err) => statusMessage(err.message, 'error'));
  }

  function promptName(title, label) {
    return new Promise((resolve) => {
      const input = h('input.obs-input', { type: 'text', style: { width: '100%' } });
      const dialog = openDialog({
        title,
        width: 420,
        body: [h('label.obs-label', { text: label }), input],
        footer: dialogButtons([
          { label: 'Cancel', action: () => dialog.close() },
          { label: 'OK', primary: true, action: () => { dialog.close(); resolve(input.value.trim()); } },
        ]),
        onClose: () => resolve(null),
      });
      setTimeout(() => input.focus(), 0);
    });
  }

  function handlePreviewAction(action, payload) {
    switch (action) {
      case 'lockPreview':
        preview.setLocked(!preview.locked);
        menuBar.syncChecks?.();
        break;
      case 'scaleWindow':
      case 'scaleCanvas':
      case 'scaleOutput':
        preview.setScaling(action === 'scaleWindow' ? 'window' : action === 'scaleCanvas' ? 'canvas' : 'output');
        menuBar.syncChecks?.();
        break;
      case 'previewZoomIn':
        preview.zoomIn();
        break;
      case 'previewZoomOut':
        preview.zoomOut();
        break;
      case 'previewResetZoom':
        preview.resetZoom();
        break;
      case 'screenshotPreview':
      case 'screenshotSource':
      case 'screenshotScene':
        saveScreenshot(selectors.previewPaneScene(store2.state), statusMessage);
        break;
      case 'previewError':
        if (payload) statusMessage(`Preview: ${payload}`, 'warning');
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------------- layout */

  const layoutState = { ...restoreLayout() };

  /**
   * Full-Height Docks (OBS "Side Docks").
   *
   * ON  (default): the bottom dock row lives inside the main area, so the
   *                Scenes/Sources column runs the full window height.
   * OFF:           the bottom dock row spans the whole window width.
   * Implemented by re-parenting the splitter + bottom row, which is exactly
   * what the arrangement change means.
   */
  function applySideDocks() {
    const side = layoutState.side !== false;
    const mainArea = qs('#main-area');
    const bottom = qs('#dock-bottom');
    const splitter = qs('#splitter-main-h');
    if (side) {
      if (bottom.parentElement !== mainArea) mainArea.append(splitter, bottom);
    } else if (bottom.parentElement !== qs('#workspace')) {
      qs('#workspace').append(splitter, bottom);
    }
  }

  function applyLayoutFlags() {
    qs('#source-toolbar').hidden = layoutState.sourceToolbar === false;
    qs('#statusbar').hidden = layoutState.statusBar === false;
    for (const toolbar of document.querySelectorAll('.obs-list-toolbar')) {
      toolbar.hidden = layoutState.dockToolbars === false;
    }
    for (const iconEl of document.querySelectorAll('.obs-source-icon')) {
      iconEl.hidden = layoutState.sourceIcons === false;
    }
  }

  async function resetLayout() {
    layoutState.docks = { scenes: true, sources: true, transitions: true, controls: true, mixer: true, stats: false };
    layoutState.locked = true;
    layoutState.side = true;
    layoutState.dockToolbars = true;
    layoutState.sourceToolbar = true;
    layoutState.sourceIcons = true;
    layoutState.statusBar = true;
    for (const id of Object.keys(docks)) setDockVisible(id, layoutState.docks[id] !== false);
    qs('#dock-left').style.width = '';
    qs('#dock-bottom').style.height = '';
    applyLayoutFlags();
    saveLayout(layoutState);
    statusMessage('Docks reset', 'info');
  }

  // Splitters ---------------------------------------------------------------
  wireSplitter(qs('#splitter-vertical'), 'x', (delta) => {
    const column = qs('#dock-left');
    const width = Math.max(150, Math.min(window.innerWidth * 0.6, column.getBoundingClientRect().width + delta));
    column.style.width = `${width}px`;
    saveLayout({ leftWidth: width });
  });

  wireSplitter(qs('#splitter-right'), 'x', (delta) => {
    const column = qs('#dock-right');
    const width = Math.max(160, Math.min(window.innerWidth * 0.6, column.getBoundingClientRect().width - delta));
    column.style.width = `${width}px`;
    saveLayout({ rightWidth: width });
  });

  wireSplitter(qs('#splitter-left-h'), 'y', (delta) => {
    const slot = qs('.obs-dock-slot[data-dock="scenes"]');
    const height = Math.max(60, slot.getBoundingClientRect().height + delta);
    slot.style.flex = `0 0 ${height}px`;
    qs('.obs-dock-slot[data-dock="sources"]').style.flex = '1 1 auto';
  });

  wireSplitter(qs('#splitter-main-h'), 'y', (delta) => {
    const row = qs('#dock-bottom');
    const height = Math.max(90, Math.min(window.innerHeight * 0.7, row.getBoundingClientRect().height - delta));
    row.style.height = `${height}px`;
    saveLayout({ bottomHeight: height });
  });

  for (const splitter of document.querySelectorAll('#dock-bottom > .obs-splitter')) {
    wireSplitter(splitter, 'x', (delta) => {
      const slot = splitter.previousElementSibling;
      const width = Math.max(80, slot.getBoundingClientRect().width + delta);
      slot.style.flex = `0 0 ${width}px`;
    });
  }

  // Keyboard shortcuts ------------------------------------------------------
  // Browser-side hotkey bindings: OBS cannot be rebound over the protocol, so
  // WebMIX captures combinations locally and forwards them as hotkey triggers.
  let hotkeyBindings = loadBindings();
  window.addEventListener('webmix:hotkeys-changed', () => {
    hotkeyBindings = loadBindings();
  });

  document.addEventListener('keydown', (event) => {
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName);
    if (event.key === 'F11') {
      event.preventDefault();
      handleAction('fullscreen');
      return;
    }
    if (inField) return;
    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      handleAction('editTransform');
    } else if (event.ctrlKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      handleAction('resetTransform');
    }
  });

  // Hotkey bindings fire even while an input is focused only if the user is not
  // typing - handled here rather than in the shortcut block above so the
  // bindings never shadow the built-in shortcuts.
  document.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (isTypingTarget(event.target)) return;
    if (!api.connected) return;
    const hotkeyName = matchBinding(hotkeyBindings, event);
    if (!hotkeyName) return;
    event.preventDefault();
    api
      .triggerHotkeyByName(hotkeyName)
      .catch((err) => statusbar.showMessage(err.message, 'error'));
  });

  // Status polling ----------------------------------------------------------
  const pollStatus = async () => {
    if (!api.connected) return;
    try {
      const results = await api.batch([
        { requestType: 'GetStreamStatus' },
        { requestType: 'GetRecordStatus' },
        { requestType: 'GetReplayBufferStatus' },
        { requestType: 'GetVirtualCamStatus' },
      ]);
      const [stream, record, replay, vcam] = results.map((r) => (r.requestStatus?.result ? r.responseData : {}));
      store.batch(() => {
        const outputs = store.state.outputs;
        outputs.streaming.active = !!stream.outputActive;
        outputs.streaming.timecode = stream.outputTimecode ?? '00:00:00.000';
        outputs.streaming.bytes = stream.outputBytes ?? 0;
        outputs.streaming.skippedFrames = stream.outputSkippedFrames ?? 0;
        outputs.streaming.totalFrames = stream.outputTotalFrames ?? 0;
        outputs.streaming.congestion = stream.outputCongestion ?? 0;
        outputs.streaming.reconnecting = !!stream.outputReconnecting;
        outputs.recording.active = !!record.outputActive;
        outputs.recording.paused = !!record.outputPaused;
        outputs.recording.timecode = record.outputTimecode ?? '00:00:00.000';
        outputs.recording.bytes = record.outputBytes ?? 0;
        outputs.replayBuffer.active = !!replay.outputActive;
        outputs.virtualCam.active = !!vcam.outputActive;
      });
      store.notify(Topic.Outputs);
    } catch {
      /* transient - the reconnect logic reports the real problem */
    }
  };

  const pollStats = async () => {
    if (!api.connected) return;
    await api.refreshStats().catch(() => {});
  };

  const statusTimer = setInterval(pollStatus, 2000);
  const statsTimer = setInterval(pollStats, 3000);

  /* --------------------------------------------------------------- updates */

  function refreshAll() {
    menuBar.render();
    scenes.update(store.state);
    sources.update(store.state);
    mixer.update(store.state, new Set([Topic.Audio, Topic.Inputs]));
    transitions.update(store.state);
    controls.update(store.state);
    statusbar.update(store.state);
    sourceToolbar.update(store.state);
    statsPanel.update(store.state);
    preview.render();
    syncCustomDocks();
    applyLayoutFlags();
  }

  const onStoreUpdate = (state, topics) => {
    if (topics.has(Topic.Scenes) || topics.has(Topic.Ui)) scenes.update(state);
    if (topics.has(Topic.SceneItems) || topics.has(Topic.Scenes)) {
      sources.update(state);
      sourceToolbar.update(state);
    }
    if (topics.has(Topic.Audio) || topics.has(Topic.Inputs)) mixer.update(state, topics);
    if (topics.has(Topic.Transitions) || topics.has(Topic.Ui)) transitions.update(state);
    if (topics.has(Topic.Outputs)) controls.update(state);
    if (topics.has(Topic.Stats) || topics.has(Topic.Outputs) || topics.has(Topic.Video)) {
      statusbar.update(state);
    }
    if (topics.has(Topic.Stats) || topics.has(Topic.Outputs) || topics.has(Topic.Video)) {
      statsPanel.update(state);
    }
    if (topics.has(Topic.Scenes) || topics.has(Topic.Ui) || topics.has(Topic.Video)) preview.render();
    if (topics.has(Topic.Config)) menuBar.syncChecks?.();
  };
  store.subscribe(onStoreUpdate);

  applySideDocks();
  if (layoutState.leftWidth) qs('#dock-left').style.width = `${layoutState.leftWidth}px`;
  if (layoutState.rightWidth) qs('#dock-right').style.width = `${layoutState.rightWidth}px`;
  if (layoutState.bottomHeight) qs('#dock-bottom').style.height = `${layoutState.bottomHeight}px`;
  for (const id of Object.keys(docks)) {
    if (dockVisibility[id] === false) setDockVisible(id, false);
  }
  syncCustomDocks();
  applyLayoutFlags();

  return {
    statusbar,
    preview,
    scenes,
    sources,
    mixer,
    transitions,
    controls,
    stats: statsPanel,
    customDocks,
    menuBar,
    /** Run a menu action by id (used by the browser smoke test and bookmarks). */
    dispatch: (action) => handleAction(action),
    /** Pick the preview backend (WebGPU when OBS streams frames) and repaint. */
    init: async () => {
      await preview.init();
      preview.start();
      refreshAll();
    },
    refreshAll,
    dispose() {
      clearInterval(statusTimer);
      clearInterval(statsTimer);
      preview.destroy();
      menuBar.destroy();
    },
  };
}

/* ---------------------------------------------------------------- helpers */

function wireSplitter(el, axis, onDelta) {
  if (!el) return;
  el.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    el.classList.add('is-dragging');
    el.setPointerCapture?.(event.pointerId);
    let last = axis === 'x' ? event.clientX : event.clientY;

    const move = (moveEvent) => {
      const current = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
      const delta = current - last;
      last = current;
      if (delta) onDelta(delta);
    };
    const up = () => {
      el.classList.remove('is-dragging');
      el.releasePointerCapture?.(event.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

async function saveScreenshot(sourceName, statusMessage) {
  if (!sourceName) {
    statusMessage('Nothing to capture', 'warning');
    return;
  }
  try {
    const data = await api.getSourceScreenshot(sourceName, { format: 'png', quality: 100 });
    const link = document.createElement('a');
    link.href = data;
    link.download = `${sourceName}.png`;
    link.click();
    statusMessage(`Screenshot saved: ${sourceName}.png`, 'success');
  } catch (err) {
    statusMessage(err.message, 'error');
  }
}

function restoreLayout() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveLayout(patch) {
  const next = { ...restoreLayout(), ...patch };
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  const connection = savedConnection();
  connectScreenApi = renderConnectScreen(connection);

  // Probe the host first: when OBS serves the UI itself, the obs-websocket
  // connection details come from its own config and we can connect without
  // asking the user anything.
  host = await detectHost();

  const serverConfig = await fetchServerConfig();
  if (serverConfig && serverConfig.port) {
    connectScreenApi = renderConnectScreen(
      {
        host: host.embedded ? location.hostname || '127.0.0.1' : connection.host,
        port: serverConfig.port,
        password: serverConfig.password || connection.password || '',
        autoconnect: connection.autoconnect || host.embedded,
      },
      serverConfig.serverEnabled === false
        ? {
            status:
              'The obs-websocket server is disabled; enable it in Tools > WebSocket Server Settings',
            kind: 'error',
          }
        : host.embedded
          ? { status: 'Served by OBS — connecting automatically', kind: 'ok' }
          : {}
    );
  }

  // The hosting server's own config is authoritative - except when the URL
  // explicitly overrides host/port (used by tests and by remote connections).
  const target = {
    host: connection.fromUrl ? connection.host : serverConfig?.host ?? connection.host,
    port: connection.fromUrl ? connection.port : serverConfig?.port ?? connection.port,
    password: connection.password || serverConfig?.password || '',
    autoconnect: connection.autoconnect || host.embedded,
  };
  persistConnection(target);

  if (target.autoconnect) {
    await connect(target);
  }
}

boot();

window.webmix = {
  /** GPU renderer, exposed for diagnostics and automated checks. */
  WebGpuPreview,
  get store() {
    return store;
  },
  get client() {
    return client;
  },
  get api() {
    return api;
  },
  get ui() {
    return ui;
  },
};
