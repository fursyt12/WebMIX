/*
 * WebMIX - Controls dock.
 *
 * Start/Stop Streaming, Start/Pause Recording, Replay Buffer + Save,
 * Virtual Camera + config, Studio Mode and Settings - with OBS's runtime
 * button labels ("Preparing...", "Stopping Stream...", "Pause Recording" ...).
 */
import { h, setText, setClass, clear } from '../dom.js';
import { icon } from './icons.js';
import { Topic } from '../store.js';

export class ControlsPanel {
  constructor({ store, api, onStatus, onSettings, onVirtualCamConfig }) {
    this.store = store;
    this.api = api;
    this.onStatus = onStatus;
    this.onSettings = onSettings;
    this.onVirtualCamConfig = onVirtualCamConfig;

    this.streamButton = h('button.obs-btn.obs-control-btn.obs-stream-btn', {
      type: 'button',
      text: 'Start Streaming',
      on: { click: () => this.#guard(() => this.api.toggleStream()) },
    });

    this.recordButton = h('button.obs-btn.obs-control-btn.obs-record-btn', {
      type: 'button',
      text: 'Start Recording',
      on: { click: () => this.#guard(() => this.api.toggleRecord()) },
    });
    this.pauseRecordButton = h('button.obs-btn.obs-control-icon-btn', {
      type: 'button',
      title: 'Pause Recording',
      on: { click: () => this.#guard(() => this.api.toggleRecordPause()) },
    });
    this.pauseRecordButton.appendChild(icon('pause', 14));

    this.replayButton = h('button.obs-btn.obs-control-btn.obs-replay-btn', {
      type: 'button',
      text: 'Start Replay Buffer',
      on: { click: () => this.#guard(() => this.api.toggleReplayBuffer()) },
    });
    this.saveReplayButton = h('button.obs-btn.obs-control-icon-btn', {
      type: 'button',
      title: 'Save Replay',
      on: { click: () => this.#guard(() => this.api.saveReplayBuffer()) },
    });
    this.saveReplayButton.appendChild(icon('save', 14));

    this.vcamButton = h('button.obs-btn.obs-control-btn.obs-vcam-btn', {
      type: 'button',
      text: 'Start Virtual Camera',
      on: { click: () => this.#guard(() => this.api.toggleVirtualCam()) },
    });
    this.vcamConfigButton = h('button.obs-btn.obs-control-icon-btn', {
      type: 'button',
      title: 'Virtual Camera Config',
      on: { click: () => this.onVirtualCamConfig?.() },
    });
    this.vcamConfigButton.appendChild(icon('gear', 14));

    this.modeSwitch = h('button.obs-btn.obs-control-btn.obs-studio-btn', {
      type: 'button',
      text: 'Studio Mode',
      on: { click: () => this.#guard(() => this.api.setStudioMode(!this.store.state.studioMode)) },
    });

    this.settingsButton = h('button.obs-btn.obs-control-btn.obs-settings-btn', {
      type: 'button',
      text: 'Settings',
      on: { click: () => this.onSettings?.() },
    });

    this.el = h('div.obs-panel.obs-controls-panel', {}, [
      this.streamButton,
      h('div.obs-control-row', {}, [this.recordButton, this.pauseRecordButton]),
      h('div.obs-control-row', {}, [this.replayButton, this.saveReplayButton]),
      h('div.obs-control-row', {}, [this.vcamButton, this.vcamConfigButton]),
      this.modeSwitch,
      this.settingsButton,
    ]);
  }

  async #guard(fn) {
    try {
      await fn();
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  update(state) {
    const { streaming, recording, replayBuffer, virtualCam } = state.outputs;

    setText(this.streamButton, streaming.active ? 'Stop Streaming' : 'Start Streaming');
    setClass(this.streamButton, 'is-active', streaming.active);
    setClass(this.streamButton, 'is-busy', isPending(streaming.state));

    setText(this.recordButton, recording.active ? (recording.paused ? 'Stop Recording' : 'Stop Recording') : 'Start Recording');
    setClass(this.recordButton, 'is-active', recording.active);
    setClass(this.recordButton, 'is-paused', recording.paused);
    this.pauseRecordButton.hidden = !recording.active;
    this.pauseRecordButton.title = recording.paused ? 'Unpause Recording' : 'Pause Recording';
    clear(this.pauseRecordButton);
    this.pauseRecordButton.appendChild(icon(recording.paused ? 'play' : 'pause', 14));
    setClass(this.pauseRecordButton, 'is-active', recording.paused);

    setText(this.replayButton, replayBuffer.active ? 'Stop Replay Buffer' : 'Start Replay Buffer');
    setClass(this.replayButton, 'is-active', replayBuffer.active);
    this.saveReplayButton.hidden = !replayBuffer.active;

    setText(this.vcamButton, virtualCam.active ? 'Stop Virtual Camera' : 'Start Virtual Camera');
    setClass(this.vcamButton, 'is-active', virtualCam.active);

    setClass(this.modeSwitch, 'is-active', state.studioMode);
    setText(this.modeSwitch, 'Studio Mode');
  }
}

const isPending = (outputState) =>
  outputState === 'OBS_WEBSOCKET_OUTPUT_STARTING' ||
  outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPING' ||
  outputState === 'OBS_WEBSOCKET_OUTPUT_RECONNECTING';
