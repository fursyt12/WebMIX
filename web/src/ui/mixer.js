/*
 * WebMIX - Audio Mixer dock.
 *
 * The desktop mixer (frontend/widgets/AudioMixer.cpp + VolumeControl): one
 * strip per audio source with a category header, the name and its menu, the
 * dB readout, a fader beside a per-channel meter with its scale, and the mute
 * and monitoring buttons underneath.
 *
 * Which sources get a strip, in what order and under which category is decided
 * exactly as the desktop does it - global audio devices first, then pinned,
 * then what is audible; hidden and inactive ones only on request - from state
 * OBS keeps (`GetMixerState`), so a source hidden or pinned here is hidden or
 * pinned in the desktop window too.
 *
 * Metering uses the high-volume InputVolumeMeters event, so the meters are
 * painted on a canvas and the strips are never re-rendered for a level change.
 */
import { h, reconcile, setText, setClass } from '../dom.js';
import { icon, iconButton } from './icons.js';
import { showContextMenu, prompt } from './dialog.js';
import { Topic } from '../store.js';
import { t } from '../i18n.js';
import {
  FADER_PRECISION,
  MIN_METER_DB,
  METER_WARNING_DB,
  METER_ERROR_DB,
  mulToSlider,
  sliderToMul,
  mulToLabel,
  mulToDb,
} from '../fader.js';

/* Source output flags, from libobs' obs-source.h. `inputKindCaps` is the
 * bitmask obs-websocket and the native service both report for an input. */
const OBS_SOURCE_AUDIO = 1 << 1;

const NON_AUDIO_KINDS = [/^image_source/, /^color_source/, /^text_/, /^slideshow/];

/* The meter's colours (Yami: the dim zone behind, the bright level in front). */
const METER = {
  nominal: ['#17641E', '#37D247'],
  warning: ['#6E520D', '#E5AF24'],
  error: ['#7D1224', '#E33B57'],
  inactive: ['#646464', '#D2D2D2'],
  magnitude: '#000000',
};

const SCALE_STEPS = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54, -60];

/* How long a channel's peak stays marked before it falls back. */
const PEAK_HOLD_MS = 1000;

const dbFraction = (db) => Math.min(1, Math.max(0, (db - MIN_METER_DB) / (0 - MIN_METER_DB)));

export class MixerPanel {
  constructor({ store, api, onStatus, onSelectSource, onAdvancedAudio }) {
    this.store = store;
    this.api = api;
    this.onStatus = onStatus;
    this.onSelectSource = onSelectSource;
    this.onAdvancedAudio = onAdvancedAudio;

    /* Until OBS answers, the desktop defaults. */
    this.options = { vertical: true, showInactive: false, keepInactiveLast: false, showHidden: false, keepHiddenLast: false };
    this.status = new Map(); // inputName -> { global, pinned, hidden, active, ... }
    this.statusKnown = false;
    this.strips = new Map(); // inputName -> strip record
    this.pendingVolume = new Map();

    this.list = h('div.obs-mixer-list.obs-scroll', { role: 'group', 'aria-label': 'Audio Mixer' });

    this.hiddenButton = h('button.obs-btn.flat.obs-mixer-hidden-count', {
      type: 'button',
      on: { click: () => this.#setOption('showHidden', !this.options.showHidden) },
    });
    this.layoutButton = iconButton('layoutH', {
      title: 'Horizontal Layout',
      onClick: () => this.#setOption('vertical', !this.options.vertical),
    });
    this.optionsButton = h('button.obs-btn.flat.obs-mixer-options', {
      type: 'button',
      on: { click: (event) => this.openOptionsMenu(event) },
    });
    this.optionsButton.append(h('span', { text: t('Basic.AudioMixer.Options') }), h('span.obs-mixer-options-arrow'));

    this.toolbar = h('div.obs-mixer-toolbar', { role: 'toolbar' }, [
      this.hiddenButton,
      h('div.obs-toolbar-sep'),
      h('div.obs-toolbar-spacer'),
      h('div.obs-toolbar-sep'),
      this.layoutButton,
      h('div.obs-toolbar-sep'),
      iconButton('cogs', { title: 'Advanced Audio Properties', onClick: () => this.onAdvancedAudio?.() }),
      h('div.obs-toolbar-sep'),
      this.optionsButton,
    ]);

    this.el = h('div.obs-panel.obs-mixer-panel', {}, [this.list, this.toolbar]);
    this.#applyOptions();

    /* A short dock has no room for the whole scale. */
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => setClass(this.list, 'is-compact', this.list.clientHeight < 200)).observe(this.list);
    }

    /* Audible/inactive changes arrive without an event of their own. */
    this.refreshTimer = setInterval(() => this.refreshStatus(), 2000);
    this.refreshStatus();
  }

  /* ------------------------------------------------------ OBS's mixer state */

  /*! Ask OBS what the mixer should show; redraw when the answer changed. */
  async refreshStatus() {
    if (!this.api.connected || this.refreshing) return;
    this.refreshing = true;
    try {
      const data = await this.api.request('GetMixerState');
      const signature = JSON.stringify(data);
      if (signature !== this.statusSignature) {
        this.statusSignature = signature;
        this.statusKnown = true;
        this.options = {
          vertical: !!data.vertical,
          showInactive: !!data.showInactive,
          keepInactiveLast: !!data.keepInactiveLast,
          showHidden: !!data.showHidden,
          keepHiddenLast: !!data.keepHiddenLast,
        };
        this.status = new Map((data.inputs ?? []).map((entry) => [entry.inputName, entry]));
        this.#applyOptions();
        this.update(this.store.state, new Set([Topic.Inputs, Topic.Audio]));
      }
    } catch {
      /* A host without the request (obs-websocket): every audio input is
       * shown as active, which is the most that protocol can say. */
      this.statusKnown = false;
    } finally {
      this.refreshing = false;
    }
  }

  async #setOption(optionName, optionEnabled) {
    this.options[optionName] = optionEnabled;
    this.#applyOptions();
    this.update(this.store.state, new Set([Topic.Inputs, Topic.Audio]));
    try {
      await this.api.request('SetMixerOption', { optionName, optionEnabled });
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
    this.statusSignature = null;
    this.refreshStatus();
  }

  async #setInputState(name, patch) {
    try {
      await this.api.request('SetInputMixerState', { inputName: name, ...patch });
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
    this.statusSignature = null;
    this.refreshStatus();
  }

  async unhideAll() {
    try {
      await this.api.request('UnhideAllInputs');
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
    this.statusSignature = null;
    this.refreshStatus();
  }

  #applyOptions() {
    setClass(this.list, 'is-horizontal', !this.options.vertical);
    /* The button offers the other layout, like the desktop's. */
    this.layoutButton.replaceChildren(icon(this.options.vertical ? 'layoutH' : 'layoutV', 16));
    this.layoutButton.title = t(
      this.options.vertical ? 'Basic.AudioMixer.Layout.Horizontal' : 'Basic.AudioMixer.Layout.Vertical'
    );
    setClass(this.hiddenButton, 'is-active', this.options.showHidden);
  }

  openOptionsMenu(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const vertical = this.options.vertical;
    showContextMenu({ x: rect.left, y: rect.top - 4 }, [
      { label: t('UnhideAll'), action: () => this.unhideAll() },
      { separator: true },
      {
        label: t('Basic.AudioMixer.ShowHidden'),
        checked: this.options.showHidden,
        action: () => this.#setOption('showHidden', !this.options.showHidden),
      },
      {
        label: t('Basic.AudioMixer.ShowInactive'),
        checked: this.options.showInactive,
        action: () => this.#setOption('showInactive', !this.options.showInactive),
      },
      {
        label: t(vertical ? 'Basic.AudioMixer.KeepHiddenRight' : 'Basic.AudioMixer.KeepHiddenBottom'),
        checked: this.options.keepHiddenLast,
        action: () => this.#setOption('keepHiddenLast', !this.options.keepHiddenLast),
      },
      {
        label: t(vertical ? 'Basic.AudioMixer.KeepInactiveRight' : 'Basic.AudioMixer.KeepInactiveBottom'),
        checked: this.options.keepInactiveLast,
        action: () => this.#setOption('keepInactiveLast', !this.options.keepInactiveLast),
      },
      { separator: true },
      {
        label: t(vertical ? 'Basic.AudioMixer.Layout.Horizontal' : 'Basic.AudioMixer.Layout.Vertical'),
        action: () => this.#setOption('vertical', !vertical),
      },
      { separator: true },
      { label: t('Basic.AdvAudio'), action: () => this.onAdvancedAudio?.() },
    ]);
  }

  /* ------------------------------------------------------------ which strips */

  #statusOf(name) {
    return (
      this.status.get(name) ?? {
        global: false,
        pinned: false,
        hidden: false,
        locked: false,
        active: true,
        previewed: false,
        unassigned: false,
      }
    );
  }

  /*! AudioMixer::getMixerVisibilityForControl. */
  #isVisible(status) {
    if (status.pinned) return true;
    if (status.hidden && this.options.showHidden) return true;
    if (!status.active && this.options.showInactive) return !status.hidden;
    if (status.active) return !status.hidden;
    if (status.previewed) return !status.hidden;
    return false;
  }

  /*! The strips to show, in the desktop's order: global devices, pinned
   *  sources, the rest - with hidden and inactive ones last when asked. */
  #orderedInputs(state) {
    const names = Object.keys(state.inputs).filter((name) => {
      const input = state.inputs[name];
      if (this.statusKnown) return this.status.has(name);
      const caps = input?.inputKindCaps;
      if (typeof caps === 'number') return (caps & OBS_SOURCE_AUDIO) !== 0;
      return !NON_AUDIO_KINDS.some((re) => re.test(input?.inputKind ?? ''));
    });

    const rank = (name) => {
      const status = this.#statusOf(name);
      if (status.hidden && this.options.keepHiddenLast) return 4;
      if (!status.active && this.options.keepInactiveLast) return 3;
      if (status.global) return 0;
      if (status.pinned) return 1;
      return 2;
    };

    return names
      .filter((name) => this.#isVisible(this.#statusOf(name)))
      .map((name, index) => ({ name, index, rank: rank(name) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.name);
  }

  /*! VolumeControl::updateCategoryLabel. */
  #category(status) {
    if (status.unassigned) return 'Basic.AudioMixer.Category.Unassigned';
    if (status.global) return 'Basic.AudioMixer.Category.Global';
    if (status.pinned) return 'Basic.AudioMixer.Category.Pinned';
    if (status.hidden) return 'Basic.AudioMixer.Category.Hidden';
    if (!status.active) return status.previewed ? 'Basic.AudioMixer.Category.Preview' : 'Basic.AudioMixer.Category.Inactive';
    return 'Basic.AudioMixer.Category.Active';
  }

  update(state, topics) {
    /* Levels only: paint the meters and leave the DOM alone. */
    if (topics && topics.size === 1 && topics.has(Topic.Audio) && this.strips.size) {
      for (const [name, strip] of this.strips) {
        this.#syncAudio(name, strip, state);
        this.#paintMeter(strip, state.audio[name]);
      }
      return;
    }

    const visible = this.#orderedInputs(state);
    for (const name of [...this.strips.keys()]) {
      if (!visible.includes(name)) this.strips.delete(name);
    }

    reconcile(
      this.list,
      visible,
      (name) => name,
      (name) => this.#createStrip(name),
      (node, name) => this.#updateStrip(node, name, state)
    );

    const hidden = [...this.status.values()].filter((status) => status.hidden).length;
    setText(this.hiddenButton, t('Basic.AudioMixer.HiddenTotal', hidden), true);
    this.hiddenButton.title = t(this.options.showHidden ? 'Basic.AudioMixer.HideHidden' : 'Basic.AudioMixer.ShowHidden');

    /* Something else changed (a scene, a source): the mixer's own state may
     * have changed with it. */
    if (topics && !topics.has(Topic.Audio)) this.refreshStatus();
  }

  /* -------------------------------------------------------------- one strip */

  #createStrip(name) {
    const category = h('div.obs-vol-category');
    const nameHead = h('span.obs-vol-name-head');
    const nameTail = h('span.obs-vol-name-tail');
    const nameButton = h('button.obs-vol-name', { type: 'button' }, [
      h('span.obs-vol-name-text', {}, [nameHead, nameTail]),
      h('span.obs-vol-name-arrow'),
    ]);
    const volumeLabel = h('div.obs-vol-db', { text: '0.0 dB', raw: true });
    const slider = h('input.obs-vol-slider', {
      type: 'range',
      min: '0',
      max: String(FADER_PRECISION),
      step: '1',
      value: String(FADER_PRECISION),
    });
    const meter = h('canvas.obs-vol-meter');
    const scale = h(
      'div.obs-vol-scale',
      {},
      SCALE_STEPS.map((db) => {
        const mark = h('span', { text: String(db), raw: true });
        mark.style.setProperty('--at', String(1 - dbFraction(db)));
        return mark;
      })
    );
    const muteButton = h('button.obs-vol-btn.obs-vol-mute', { type: 'button' });
    const monitorButton = h('button.obs-vol-btn.obs-vol-monitor', { type: 'button' });

    const strip = h('div.obs-vol', { dataset: { inputName: name } }, [
      category,
      nameButton,
      volumeLabel,
      h('div.obs-vol-body', {}, [h('div.obs-vol-fader', {}, [slider]), meter, scale]),
      h('div.obs-vol-buttons', {}, [muteButton, monitorButton]),
    ]);

    nameButton.addEventListener('click', (event) => {
      this.onSelectSource?.(name);
      this.openStripMenu(event, name, nameButton.getBoundingClientRect());
    });
    muteButton.addEventListener('click', () => {
      this.api.toggleInputMute(name).catch((err) => this.onStatus?.(err.message, 'error'));
    });
    monitorButton.addEventListener('click', () => this.toggleMonitor(name));

    const commit = (final) => {
      const mul = sliderToMul(Number(slider.value));
      setText(volumeLabel, mulToLabel(mul), true);
      this.#fillSlider(slider);
      this.#setVolume(name, mul, final);
    };
    slider.addEventListener('pointerup', () => commit(true));
    slider.addEventListener('input', () => commit(false));
    slider.addEventListener('change', () => commit(true));
    slider.addEventListener('dblclick', () => {
      slider.value = String(FADER_PRECISION);
      commit(true);
    });

    strip.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openStripMenu(event, name);
    });

    this.strips.set(name, {
      el: strip,
      category,
      nameButton,
      nameHead,
      nameTail,
      volumeLabel,
      slider,
      meter,
      muteButton,
      monitorButton,
      peaks: [],
    });
    return strip;
  }

  /*! The fader's blue fill, from its rest up to the handle. */
  #fillSlider(slider) {
    slider.style.setProperty('--fill', `${((Number(slider.value) / FADER_PRECISION) * 100).toFixed(2)}%`);
  }

  #setButtonIcon(button, name) {
    if (button.dataset.icon === name) return;
    button.dataset.icon = name;
    button.replaceChildren(icon(name, 16));
  }

  #updateStrip(stripEl, name, state) {
    const strip = this.strips.get(name);
    if (!strip) return;
    const status = this.#statusOf(name);

    setText(strip.category, t(this.#category(status)), true);
    setClass(stripEl, 'is-pinned', status.global || status.pinned);
    setClass(stripEl, 'is-inactive', !status.active);
    setClass(stripEl, 'is-preview', !status.active && status.previewed);
    setClass(stripEl, 'is-hidden', status.hidden && !(status.global || status.pinned));
    setClass(stripEl, 'is-unassigned', status.unassigned);

    /* A long name is elided in the middle, keeping its ending readable
     * ("Desktop Au...dio 2"), as VolumeName does. */
    const tail = name.length > 9 ? name.slice(-5) : '';
    setText(strip.nameHead, tail ? name.slice(0, -5) : name, true);
    setText(strip.nameTail, tail, true);
    strip.nameButton.title = name;

    strip.slider.disabled = !!status.locked;
    strip.slider.setAttribute('aria-label', t('VolControl.SliderUnmuted', name));

    this.#syncAudio(name, strip, state);
    this.#paintMeter(strip, state.audio[name]);
  }

  /*! Volume, mute and monitoring - what the audio events change. */
  #syncAudio(name, strip, state) {
    const audio = state.audio[name] ?? {};
    const status = this.#statusOf(name);

    // Do not fight the user while they drag the fader or hold a pending write.
    if (!this.pendingVolume.has(name) && document.activeElement !== strip.slider) {
      const sliderValue = mulToSlider(audio.volumeMul ?? 1);
      if (Number(strip.slider.value) !== sliderValue) strip.slider.value = String(sliderValue);
      setText(strip.volumeLabel, mulToLabel(audio.volumeMul ?? 1), true);
      this.#fillSlider(strip.slider);
    }

    const muted = !!audio.muted;
    setClass(strip.el, 'is-muted', muted);
    this.#setButtonIcon(strip.muteButton, status.unassigned ? 'unassigned' : muted ? 'mute' : 'speaker');
    setClass(strip.muteButton, 'is-active', muted);
    strip.muteButton.title = t(muted ? 'Unmute' : 'Mute');

    const monitoring = (audio.monitorType ?? 'OBS_MONITORING_TYPE_NONE') !== 'OBS_MONITORING_TYPE_NONE';
    this.#setButtonIcon(strip.monitorButton, monitoring ? 'headphones' : 'headphonesOff');
    setClass(strip.monitorButton, 'is-active', monitoring);
    strip.monitorButton.title = t(monitoring ? 'Basic.AudioMixer.Monitoring.Disable' : 'Basic.AudioMixer.Monitoring.Enable');
  }

  /*! One bar per channel: the three dim zones, the level over them in the
   *  bright colours, the magnitude as a dark line, the held peak as a bright
   *  one, and the input indicator at the foot of the bar. */
  #paintMeter(strip, audio) {
    const canvas = strip.meter;
    const vertical = this.options.vertical;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }

    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const levels = Array.isArray(audio?.levels) && audio.levels.length ? audio.levels : [[0, 0, 0], [0, 0, 0]];
    const channels = Math.max(1, levels.length);
    const inactive = strip.el.classList.contains('is-inactive') || strip.el.classList.contains('is-muted');

    /* Along the bar: `length` is the metered part, with the small input
     * indicator after a gap at the low end. */
    const indicator = 3;
    const gap = 2;
    const along = vertical ? height : width;
    const across = vertical ? width : height;
    const length = along - indicator - gap;
    const thickness = Math.max(2, Math.floor((across - (channels - 1)) / channels));
    const now = performance.now();

    const zones = [
      [MIN_METER_DB, METER_WARNING_DB, 'nominal'],
      [METER_WARNING_DB, METER_ERROR_DB, 'warning'],
      [METER_ERROR_DB, 0, 'error'],
    ];

    /* A span of the bar, between two fractions of its length (0 = quiet). */
    const span = (channel, from, to, colour) => {
      if (to <= from) return;
      const offset = channel * (thickness + 1);
      context.fillStyle = colour;
      if (vertical) context.fillRect(offset, length * (1 - to), thickness, length * (to - from));
      else context.fillRect(indicator + gap + length * from, offset, length * (to - from), thickness);
    };

    levels.forEach((level, channel) => {
      const magnitude = dbFraction(mulToDb(Number(level?.[0] ?? 0)));
      const peak = dbFraction(mulToDb(Number(level?.[1] ?? 0)));
      const inputPeak = mulToDb(Number(level?.[2] ?? 0));

      for (const [low, high, zone] of zones) {
        const from = dbFraction(low);
        const to = dbFraction(high);
        span(channel, from, to, METER[zone][0]);
        span(channel, from, Math.min(to, peak), inactive ? METER.inactive[1] : METER[zone][1]);
      }

      if (magnitude > 0.005) span(channel, magnitude - 2 / length, magnitude, METER.magnitude);

      /* Peak hold. */
      const held = strip.peaks[channel];
      if (!held || peak >= held.value || now - held.at > PEAK_HOLD_MS) strip.peaks[channel] = { value: peak, at: now };
      const hold = strip.peaks[channel].value;
      if (hold > 0.01) {
        const zone = hold >= dbFraction(METER_ERROR_DB) ? 'error' : hold >= dbFraction(METER_WARNING_DB) ? 'warning' : 'nominal';
        span(channel, hold - 1.5 / length, hold, inactive ? METER.inactive[1] : METER[zone][1]);
      }

      /* Input indicator: what reaches OBS before the fader - silent, present,
       * or clipping. */
      const offset = channel * (thickness + 1);
      context.fillStyle =
        inputPeak >= -0.5 ? METER.error[1] : inputPeak > MIN_METER_DB ? METER.nominal[1] : METER.nominal[0];
      if (vertical) context.fillRect(offset, height - indicator, thickness, indicator);
      else context.fillRect(0, offset, indicator, thickness);
    });
  }

  #setVolume(name, mul, final) {
    if (final) this.pendingVolume.delete(name);
    else this.pendingVolume.set(name, mul);
    this.api.setInputVolume(name, mul).catch((err) => {
      this.pendingVolume.delete(name);
      this.onStatus?.(err.message, 'error');
    });
  }

  /*! The headphones button: monitoring off, or on alongside the output. */
  async toggleMonitor(name) {
    const audio = this.store.state.audio[name] ?? {};
    const on = (audio.monitorType ?? 'OBS_MONITORING_TYPE_NONE') !== 'OBS_MONITORING_TYPE_NONE';
    try {
      await this.api.setInputAudioMonitorType(
        name,
        on ? 'OBS_MONITORING_TYPE_NONE' : 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'
      );
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  async renameInput(name) {
    const value = await prompt({
      title: t('Basic.Main.MixerRename.Title'),
      label: t('Basic.Main.MixerRename.Text'),
      value: name,
    });
    if (!value || value === name) return;
    try {
      await this.api.renameInput(name, value);
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  /*! The strip's menu (the arrow beside its name, or a right click). */
  openStripMenu(event, name, anchor = null) {
    const status = this.#statusOf(name);
    const open = (type) => () =>
      this.el.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: { sourceName: name } }));
    showContextMenu(anchor ? { x: anchor.left, y: anchor.bottom } : { x: event.clientX, y: event.clientY }, [
      { label: t('UnhideAll'), action: () => this.unhideAll() },
      { separator: true },
      {
        label: t(status.pinned ? 'Basic.AudioMixer.Unpin' : 'Basic.AudioMixer.Pin'),
        action: () => this.#setInputState(name, { pinned: !status.pinned }),
      },
      {
        label: t(status.hidden ? 'Basic.AudioMixer.Unhide' : 'Basic.AudioMixer.Hide'),
        action: () => this.#setInputState(name, { hidden: !status.hidden }),
      },
      {
        label: t('LockVolume'),
        checked: !!status.locked,
        action: () => this.#setInputState(name, { locked: !status.locked }),
      },
      { separator: true },
      { label: t('Rename'), action: () => this.renameInput(name) },
      { separator: true },
      { label: t('Filters'), action: open('webmix:open-filters') },
      { label: t('Properties'), action: open('webmix:open-properties') },
    ]);
  }
}
