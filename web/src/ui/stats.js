/*
 * WebMIX - Stats dock / dialog contents.
 *
 * OBS ships a Stats dock (hidden and floating by default) that shows the same
 * figures as View > Stats.  Both views are rendered from `statsRows()` so they
 * can never drift apart.
 */
import { h, clear } from '../dom.js';

/** Build the label/value rows shown by the Stats dock and dialog. */
export function statsRows(state) {
  const stats = state.stats ?? {};
  const video = state.video ?? {};
  const { streaming, recording } = state.outputs ?? {};
  const targetFps = (video.fpsNumerator ?? 0) / (video.fpsDenominator ?? 1);

  const skipped = streaming?.skippedFrames ?? stats.outputSkippedFrames ?? 0;
  const total = streaming?.totalFrames ?? stats.outputTotalFrames ?? 0;

  return [
    ['CPU Usage', `${Number(stats.cpuUsage ?? 0).toFixed(1)}%`],
    ['Memory Usage', `${Number(stats.memoryUsage ?? 0).toFixed(1)} MB`],
    ['Available Disk Space', `${Number(stats.availableDiskSpace ?? 0).toFixed(1)} MB`],
    ['Active FPS', `${Number(stats.activeFps ?? 0).toFixed(2)}`],
    ['Average Frame Render Time', `${Number(stats.averageFrameRenderTime ?? 0).toFixed(2)} ms`],
    ['Target FPS', Number.isFinite(targetFps) && targetFps > 0 ? targetFps.toFixed(2) : '-'],
    ['Base Resolution', video.baseWidth ? `${video.baseWidth}x${video.baseHeight}` : '-'],
    ['Output Resolution', video.outputWidth ? `${video.outputWidth}x${video.outputHeight}` : '-'],
    ['Render Skipped Frames', `${stats.renderSkippedFrames ?? 0}`],
    ['Render Total Frames', `${stats.renderTotalFrames ?? 0}`],
    ['Output Skipped Frames', `${skipped}`],
    ['Output Total Frames', `${total}`],
    [
      'Skipped Frame Percentage',
      total > 0 ? `${((skipped / total) * 100).toFixed(2)}%` : '0.00%',
    ],
    ['Streaming', streaming?.active ? 'active' : 'inactive'],
    ['Recording', recording?.active ? (recording.paused ? 'paused' : 'active') : 'inactive'],
    ['WebSocket Incoming Messages', `${stats.webSocketSessionIncomingMessages ?? 0}`],
    ['WebSocket Outgoing Messages', `${stats.webSocketSessionOutgoingMessages ?? 0}`],
  ];
}

/** Render the stats table into a container. */
export function renderStatsTable(container, state) {
  clear(container);
  const table = h('table.obs-table.obs-stats-table');
  for (const [label, value] of statsRows(state)) {
    table.appendChild(h('tr', {}, [h('th', { text: label }), h('td', { text: String(value) })]));
  }
  container.appendChild(table);
  return container;
}

export class StatsPanel {
  constructor() {
    this.body = h('div.obs-stats-body');
    this.el = h('div.obs-panel.obs-stats-panel', {}, [this.body]);
  }

  update(state) {
    renderStatsTable(this.body, state);
  }
}
