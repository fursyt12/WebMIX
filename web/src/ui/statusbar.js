/*
 * WebMIX - status bar.
 *
 * Mirrors StatusBarWidget.ui: transient message, stream delay, dropped
 * frames, network-congestion icon, kbps, stream and record timers, CPU and
 * FPS.  Timers are driven by the periodic GetStreamStatus / GetRecordStatus
 * / GetStats polls that app.js runs, so the bar only formats state.
 */
import { h, setText, setClass } from '../dom.js';
import { parseTimecode } from '../dom.js';
import { Topic } from '../store.js';

const formatClock = (timecode) => {
  const ms = parseTimecode(timecode);
  const total = Math.floor(ms / 1000);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const networkState = (congestion) => {
  if (congestion === undefined || congestion === null) return 'inactive';
  if (congestion < 0.01) return 'excellent';
  if (congestion < 0.05) return 'good';
  if (congestion < 0.15) return 'mediocre';
  return 'bad';
};

export class StatusBar {
  constructor({ store, root }) {
    this.store = store;
    this.root = root;

    this.message = h('span.obs-status-item.obs-status-message');
    this.delay = h('span.obs-status-item.obs-status-delay', { hidden: true });
    this.dropped = h('span.obs-status-item.obs-status-dropped', { hidden: true });
    this.network = h('span.obs-status-item.obs-status-network', { hidden: true });
    this.kbps = h('span.obs-status-item.obs-status-kbps', { text: '0 kbps', hidden: true });
    this.streamIcon = h('span.obs-status-item.obs-status-icon.obs-status-stream');
    this.streamTime = h('span.obs-status-item.obs-status-time', { text: '00:00:00' });
    this.recordIcon = h('span.obs-status-item.obs-status-icon.obs-status-record');
    this.recordTime = h('span.obs-status-item.obs-status-time', { text: '00:00:00' });
    this.cpu = h('span.obs-status-item.obs-status-cpu', { text: 'CPU: 0.0%' });
    this.fps = h('span.obs-status-item.obs-status-fps', { text: '0.00 / 0.00 FPS' });

    this.messageTimer = null;

    this.el = h('div.obs-statusbar-inner', {}, [
      this.message,
      this.delay,
      this.dropped,
      h('span.obs-status-group', {}, [this.network, this.kbps]),
      h('span.obs-status-group', {}, [this.streamIcon, this.streamTime]),
      h('span.obs-status-group', {}, [this.recordIcon, this.recordTime]),
      this.cpu,
      this.fps,
    ]);

    this.root.appendChild(this.el);
    this.root.classList.add('obs-statusbar');
  }

  /** Transient status message (QStatusBar::showMessage). */
  showMessage(text, kind = 'info', timeout = 5000) {
    clearTimeout(this.messageTimer);
    setText(this.message, text ?? '');
    this.root.dataset.messageKind = kind;
    if (timeout > 0) {
      this.messageTimer = setTimeout(() => {
        setText(this.message, '');
        delete this.root.dataset.messageKind;
      }, timeout);
    }
  }

  update(state) {
    const { streaming, recording } = state.outputs;

    this.streamTime.textContent = formatClock(streaming.timecode);
    setClass(this.streamTime, 'is-disabled', !streaming.active);
    setClass(this.streamIcon, 'is-active', streaming.active);
    this.streamIcon.title = streaming.active ? 'Streaming' : 'Not streaming';
    this.streamIcon.textContent = streaming.active ? '\u25cf' : '\u25cb';

    const paused = recording.paused;
    this.recordTime.textContent = `${formatClock(recording.timecode)}${paused ? ' (PAUSED)' : ''}`;
    setClass(this.recordTime, 'is-disabled', !recording.active);
    setClass(this.recordIcon, 'is-active', recording.active);
    setClass(this.recordIcon, 'is-paused', paused);
    this.recordIcon.title = recording.active ? (paused ? 'Recording paused' : 'Recording') : 'Not recording';
    this.recordIcon.textContent = recording.active ? '\u25cf' : '\u25cb';

    // kbps and network only while streaming, like the desktop status bar.
    this.kbps.hidden = !streaming.active;
    this.network.hidden = !streaming.active;
    if (streaming.active) {
      const kbps = state.stats?.outputTotalFrames
        ? Math.round((streaming.bytes * 8) / 1000 / Math.max(1, parseTimecode(streaming.timecode) / 1000))
        : 0;
      const kbpsDisplay = Number.isFinite(kbps) && kbps > 0 ? kbps : 0;
      setText(this.kbps, `${kbpsDisplay} kbps`);
      this.network.dataset.state = networkState(streaming.congestion);
    }

    // Dropped frames while streaming or recording.
    const skipped = streaming.skippedFrames ?? 0;
    const total = streaming.totalFrames ?? 0;
    const showDropped = (streaming.active || recording.active) && skipped > 0;
    this.dropped.hidden = !showDropped;
    if (showDropped) {
      const percent = total > 0 ? ((skipped / total) * 100).toFixed(1) : '0.0';
      setText(this.dropped, `Dropped Frames ${skipped} (${percent}%)`);
    }

    if (state.stats) {
      setText(this.cpu, `CPU: ${Number(state.stats.cpuUsage ?? 0).toFixed(1)}%`);
      const target = state.video
        ? (state.video.fpsNumerator ?? 60) / (state.video.fpsDenominator ?? 1)
        : 0;
      setText(this.fps, `${Number(state.stats.activeFps ?? 0).toFixed(2)} / ${target.toFixed(2)} FPS`);
    }
  }
}
