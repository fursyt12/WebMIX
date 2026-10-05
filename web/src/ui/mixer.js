/*
 * WebMIX - Audio Mixer dock.
 *
 * One channel strip per audio source, matching OBS's AudioMixer:
 * category chip, mute button, monitoring button, volume slider (OBS LOG fader
 * curve), dB readout and a peak/magnitude meter with warning (-20 dB) and
 * error (-9 dB) colouring.
 *
 * Metering uses the high-volume InputVolumeMeters event, so strips are updated
 * imperatively (never re-rendered) to keep slider drags smooth.
 */
import { h, reconcile, setText, setClass, clear } from '../dom.js';
import { icon, iconButton } from './icons.js';
import { showContextMenu, prompt } from './dialog.js';
import { Topic, selectors } from '../store.js';
import {
  FADER_PRECISION,
  mulToSlider,
  sliderToMul,
  mulToLabel,
  levelToPercent,
  levelState,
} from '../fader.js';

/*
 * Sources that produce no audio never appear in OBS's Audio Mixer: the desktop
 * UI only creates a VolumeControl for sources whose output flags include
 * OBS_SOURCE_AUDIO.  Browser and media sources *can* carry audio, so they stay.
 */
/* Source output flags, from libobs' obs-source.h. `inputKindCaps` is the
 * bitmask obs-websocket and the native service both report for an input. */
const OBS_SOURCE_VIDEO = 1 << 0;
const OBS_SOURCE_AUDIO = 1 << 1;

const NON_AUDIO_KINDS = [
  /^image_source/,
  /^color_source/,
  /^text_/,
  /^slideshow/,
];

export class MixerPanel {
  constructor({ store, api, onStatus, onSelectSource, onAdvancedAudio }) {
    this.store = store;
    this.api = api;
    this.onStatus = onStatus;
    this.onSelectSource = onSelectSource;
    this.onAdvancedAudio = onAdvancedAudio;

    this.vertical = true;
    this.showHidden = false;
    this.showInactive = false;
    this.strips = new Map(); // inputName -> { el, slider, fill, peak, label, ... }
    this.pendingVolume = new Map();

    this.list = h('div.obs-mixer-list.obs-scroll', { role: 'group', 'aria-label': 'Audio Mixer' });

    this.toolbar = h('div.obs-mixer-toolbar', { role: 'toolbar' }, [
      h('button.obs-btn.flat.obs-mixer-hidden-count', {
        type: 'button',
        text: '0 hidden',
        title: 'Show hidden sources',
        on: { click: () => this.toggleHidden() },
      }),
      h('div.obs-toolbar-sep'),
      h('div.obs-toolbar-spacer'),
      h('div.obs-toolbar-sep'),
      iconButton('layoutV', { title: 'Vertical Layout', onClick: () => this.toggleLayout() }),
      h('div.obs-toolbar-sep'),
      iconButton('gear', { title: 'Advanced Audio Properties', onClick: () => this.onAdvancedAudio?.() }),
      h('div.obs-toolbar-sep'),
      h('button.obs-btn.flat.obs-bold', {
        type: 'button',
        text: 'Options',
        on: { click: (event) => this.openOptionsMenu(event) },
      }),
    ]);

    this.el = h('div.obs-panel.obs-mixer-panel', {}, [this.list, this.toolbar]);
    this.hiddenCount = this.toolbar.querySelector('.obs-mixer-hidden-count');
    this.#applyLayout();
  }

  #applyLayout() {
    setClass(this.list, 'is-horizontal', !this.vertical);
  }

  toggleLayout() {
    this.vertical = !this.vertical;
    this.#applyLayout();
    this.toolbar.querySelector('.obs-icon-btn')?.setAttribute(
      'title',
      this.vertical ? 'Vertical Layout' : 'Horizontal Layout'
    );
  }

  toggleHidden() {
    this.showHidden = !this.showHidden;
    this.store.notify(Topic.Audio);
  }

  openOptionsMenu(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    showContextMenu(
      { x: rect.left, y: rect.top - 4 },
      [
        { label: 'Unhide All', action: () => this.unhideAll() },
        { separator: true },
        { label: 'Show hidden sources', checked: this.showHidden, action: () => this.toggleHidden() },
        { label: 'Show inactive sources', checked: this.showInactive, action: () => { this.showInactive = !this.showInactive; this.store.notify(Topic.Audio); } },
        { separator: true },
        { label: 'Vertical Layout', checked: this.vertical, action: () => this.setLayout(true) },
        { label: 'Horizontal Layout', checked: !this.vertical, action: () => this.setLayout(false) },
        { separator: true },
        { label: 'Advanced Audio Properties', action: () => this.onAdvancedAudio?.() },
      ]
    );
  }

  setLayout(vertical) {
    this.vertical = vertical;
    this.#applyLayout();
    this.store.notify(Topic.Audio);
  }

  unhideAll() {
    this.showHidden = true;
    this.store.notify(Topic.Audio);
  }

  /** Ordered list of inputs to show, mirroring OBS's mixer order. */
  #orderedInputs(state) {
    const sceneName = selectors.previewPaneScene(state);
    const seen = new Set();
    const names = [];

    for (const item of selectors.sceneItems(state, sceneName)) {
      if (!seen.has(item.sourceName)) {
        seen.add(item.sourceName);
        names.push(item.sourceName);
      }
    }
    for (const name of Object.keys(state.inputs)) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }

    return names.filter((name) => {
      const input = state.inputs[name];
      const kind = input?.inputKind ?? '';
      if (NON_AUDIO_KINDS.some((re) => re.test(kind))) return false;

      // `active`/`showing` describe a source's *video* state. A global audio
      // device (desktop audio, a microphone) never produces video, so both are
      // permanently false for it and the rule below would hide it from the
      // mixer forever. Only apply the rule when the source can be on screen.
      const caps = input?.inputKindCaps;
      const hasVideo = typeof caps === 'number' ? (caps & OBS_SOURCE_VIDEO) !== 0 : true;

      const audio = state.audio[name];
      if (!this.showInactive && hasVideo && audio && audio.active === false && audio.showing === false) {
        // OBS hides sources that are not active anywhere; keep them unless we
        // know they are inactive in the current scene AND not showing.
        const inScene = selectors
          .sceneItems(state, sceneName)
          .some((i) => i.sourceName === name);
        if (!inScene) return false;
      }
      return true;
    });
  }

  update(state, topics) {
    const names = this.#orderedInputs(state);
    const visible = names;

    reconcile(
      this.list,
      visible,
      (name) => name,
      (name) => this.#createStrip(name),
      (node, name) => this.#updateStrip(node, name, state)
    );

    if (!visible.length) {
      clear(this.list);
      this.list.appendChild(h('div.obs-empty', { text: 'No audio sources in this scene' }));
      this.strips.clear();
    }

    // Meter-only fast path: update in place without touching the DOM tree.
    if (topics?.has(Topic.Audio)) {
      for (const [name, strip] of this.strips) this.#updateMeters(name, strip, state);
    }

    setText(this.hiddenCount, '0 hidden');
  }

  #createStrip(name) {
    const slider = h('input.obs-range.obs-volume-slider', {
      type: 'range',
      min: '0',
      max: String(FADER_PRECISION),
      step: '1',
      value: String(FADER_PRECISION),
      'aria-label': `Volume for ${name}`,
    });
    const volumeLabel = h('span.obs-mixer-label.obs-volume-label', { text: '0.0 dB' });
    const muteButton = h('button.obs-btn.obs-mixer-btn.obs-mute-btn', { type: 'button', title: 'Mute' });
    const monitorButton = h('button.obs-btn.obs-mixer-btn.obs-monitor-btn', {
      type: 'button',
      title: 'Enable monitoring',
    });
    const nameButton = h('button.obs-mixer-name', { type: 'button', text: name, title: name });

    const meterFill = h('div.obs-meter-fill');
    const meterBar = h('div.obs-meter-bar', {}, [meterFill]);
    const meter = h('div.obs-meter', {}, [meterBar]);
    const peakLine = h('div.obs-meter-peak');

    const strip = h('div.obs-mixer-strip', { dataset: { inputName: name } }, [
      h('div.obs-mixer-strip-top', {}, [nameButton]),
      h('div.obs-mixer-strip-main', {}, [
        h('div.obs-mixer-buttons', {}, [muteButton, monitorButton]),
        h('div.obs-mixer-fader', {}, [slider, volumeLabel]),
        h('div.obs-mixer-meter', {}, [meter, peakLine]),
      ]),
    ]);

    nameButton.addEventListener('click', () => {
      this.onSelectSource?.(name);
    });
    nameButton.addEventListener('dblclick', () => this.renameInput(name));

    muteButton.addEventListener('click', () => {
      this.api.toggleInputMute(name).catch((err) => this.onStatus?.(err.message, 'error'));
    });

    monitorButton.addEventListener('click', () => this.cycleMonitor(name));

    let dragging = false;
    const commit = (final) => {
      const mul = sliderToMul(Number(slider.value));
      setText(volumeLabel, mulToLabel(mul));
      this.#setVolume(name, mul, final);
    };
    slider.addEventListener('pointerdown', () => (dragging = true));
    slider.addEventListener('pointerup', () => {
      dragging = false;
      commit(true);
    });
    slider.addEventListener('input', () => commit(false));
    slider.addEventListener('change', () => commit(true));
    slider.addEventListener('dblclick', () => {
      slider.value = String(FADER_PRECISION);
      commit(true);
    });

    const openMenu = (event) => {
      event.preventDefault();
      this.openStripMenu(event, name);
    };
    strip.addEventListener('contextmenu', openMenu);
    nameButton.addEventListener('contextmenu', openMenu);

    const record = { el: strip, slider, volumeLabel, muteButton, monitorButton, nameButton, meter, meterBar, meterFill, peakLine };
    this.strips.set(name, record);
    return strip;
  }

  #updateStrip(stripEl, name, state) {
    const strip = this.strips.get(name);
    if (!strip) return;
    const audio = state.audio[name] ?? { volumeMul: 1, muted: false, monitorType: 'OBS_MONITORING_TYPE_NONE', levels: [] };

    // Do not fight the user while they drag the fader or hold a pending write.
    const pending = this.pendingVolume.get(name);
    if (!pending && document.activeElement !== strip.slider) {
      const sliderValue = mulToSlider(audio.volumeMul ?? 1);
      if (Number(strip.slider.value) !== sliderValue) strip.slider.value = String(sliderValue);
      setText(strip.volumeLabel, mulToLabel(audio.volumeMul ?? 1));
    }

    setText(strip.nameButton, name);
    strip.nameButton.title = name;

    setClass(strip.muteButton, 'is-active', !!audio.muted);
    strip.muteButton.title = audio.muted ? 'Unmute' : 'Mute';
    clear(strip.muteButton);
    strip.muteButton.appendChild(icon(audio.muted ? 'eyeOff' : 'mic', 14));

    const monitoring = audio.monitorType === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'
      ? 'both'
      : audio.monitorType === 'OBS_MONITORING_TYPE_MONITOR_ONLY'
        ? 'only'
        : 'off';
    setClass(strip.monitorButton, 'is-active', monitoring !== 'off');
    strip.monitorButton.title =
      monitoring === 'off' ? 'Enable monitoring' : monitoring === 'only' ? 'Monitoring only' : 'Monitor and Output';
    clear(strip.monitorButton);
    strip.monitorButton.appendChild(icon('headphones', 14));

    setClass(stripEl, 'is-muted', !!audio.muted);
    this.#updateMeters(name, strip, state);
  }

  #updateMeters(name, strip, state) {
    const audio = state.audio[name];
    if (!audio) return;
    const levels = Array.isArray(audio.levels) ? audio.levels : [];
    // levels[channel] = [magnitudeMul, peakMul, inputPeakMul]
    const magnitude = Math.max(0, ...levels.map((l) => Number(l?.[0] ?? 0)));
    const peak = Math.max(0, ...levels.map((l) => Number(l?.[1] ?? 0)));

    const percent = levelToPercent(magnitude);
    strip.meterFill.style.setProperty('--obs-meter-level', `${percent.toFixed(1)}%`);
    strip.meterFill.style.height = `${percent.toFixed(1)}%`;

    const state_ = levelState(magnitude);
    setClass(strip.meterBar, 'is-warning', state_ === 'warning');
    setClass(strip.meterBar, 'is-error', state_ === 'error');

    const peakPercent = levelToPercent(peak);
    strip.peakLine.style.bottom = `${peakPercent.toFixed(1)}%`;
    strip.peakLine.hidden = peakPercent <= 0;
  }

  #setVolume(name, mul, final) {
    if (final) this.pendingVolume.delete(name);
    else this.pendingVolume.set(name, mul);
    this.api.setInputVolume(name, mul).catch((err) => {
      this.pendingVolume.delete(name);
      this.onStatus?.(err.message, 'error');
    });
  }

  async cycleMonitor(name) {
    const audio = this.store.state.audio[name] ?? {};
    const order = [
      'OBS_MONITORING_TYPE_NONE',
      'OBS_MONITORING_TYPE_MONITOR_ONLY',
      'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
    ];
    const next = order[(order.indexOf(audio.monitorType ?? order[0]) + 1) % order.length];
    try {
      await this.api.setInputAudioMonitorType(name, next);
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  async renameInput(name) {
    const value = await prompt({ title: 'Rename Source', label: 'Source name', value: name });
    if (!value || value === name) return;
    try {
      await this.api.renameInput(name, value);
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  openStripMenu(event, name) {
    const audio = this.store.state.audio[name] ?? {};
    showContextMenu(
      { x: event.clientX, y: event.clientY },
      [
        { label: 'Lock Volume', checked: false, disabled: true },
        { label: 'Pin', checked: false, disabled: true },
        { label: 'Hide', disabled: true },
        { label: 'Unhide All', action: () => this.unhideAll() },
        { separator: true },
        { label: 'Rename...', action: () => this.renameInput(name) },
        { separator: true },
        { label: 'Copy Filters', action: () => this.onStatus?.('Copy Filters requires the desktop UI', 'warning') },
        { label: 'Paste Filters', action: () => this.onStatus?.('Paste Filters requires the desktop UI', 'warning') },
        { label: 'Filters', action: () => this.el.dispatchEvent(new CustomEvent('webmix:open-filters', { bubbles: true, detail: { sourceName: name } })) },
        { label: 'Properties', action: () => this.el.dispatchEvent(new CustomEvent('webmix:open-properties', { bubbles: true, detail: { sourceName: name } })) },
        { separator: true },
        { label: audio.muted ? 'Unmute' : 'Mute', action: () => this.api.toggleInputMute(name).catch((err) => this.onStatus?.(err.message, 'error')) },
      ]
    );
  }
}
