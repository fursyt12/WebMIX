/*
 * WebMIX - inline SVG icon set.
 *
 * The Qt UI loads icons from frontend/data/themes/Dark/*.svg.  Rather than
 * shipping 58 files (and a lookup that depends on the theme), the handful of
 * glyphs the web UI needs are inlined here as 16x16 monochrome paths that
 * follow the same visual language (1.5px strokes, currentColor fill).
 *
 * Swap in the original assets by replacing the `paths` entry with an <img>.
 */
const paths = {
  plus: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  minus: '<path d="M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  up: '<path d="M8 13V4M4.5 7.5 8 4l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  down: '<path d="M8 3v9M4.5 8.5 8 12l3.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  filter: '<path d="M2.5 3.5h11L9.5 8.5v4l-3 1.5v-5.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  gear: '<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  dots: '<circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/>',
  dotsV: '<circle cx="8" cy="3.5" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="12.5" r="1.2" fill="currentColor"/>',
  trash: '<path d="M3.5 5h9M6 5V3.5h4V5M5 5l.6 8.5h4.8L11 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  eye: '<path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.7" fill="currentColor"/>',
  eyeOff: '<path d="M2 8s2.2-3.6 6-3.6c1.2 0 2.2.3 3 .8M14 8s-2.2 3.6-6 3.6c-1.2 0-2.2-.3-3-.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 13 13 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  lock: '<rect x="3.6" y="7" width="8.8" height="6" rx="1" fill="currentColor"/><path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  unlock: '<rect x="3.6" y="7" width="8.8" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  pause: '<rect x="4.5" y="3.5" width="2.4" height="9" fill="currentColor"/><rect x="9.1" y="3.5" width="2.4" height="9" fill="currentColor"/>',
  play: '<path d="M5 3.5v9l8-4.5z" fill="currentColor"/>',
  stop: '<rect x="4" y="4" width="8" height="8" fill="currentColor"/>',
  save: '<path d="M3.5 3.5h7L13 6v6.5H3.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 3.5v4h4" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  camera: '<path d="M2.5 5.5h3l1-1.5h3l1 1.5h3v7h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="8" cy="9" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.2 2.6v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  layoutV: '<rect x="2.5" y="3" width="11" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 3v10" stroke="currentColor" stroke-width="1.4"/>',
  layoutH: '<rect x="2.5" y="3" width="11" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 8h11" stroke="currentColor" stroke-width="1.4"/>',
  grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2.5" width="4.5" height="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="9" width="4.5" height="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="4.5" height="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  list: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  mic: '<rect x="6" y="2.5" width="4" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 8a4 4 0 0 0 8 0M8 12v1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  headphones: '<path d="M3.5 9V8a4.5 4.5 0 0 1 9 0v1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="9" width="3" height="4" rx="1" fill="currentColor"/><rect x="10.5" y="9" width="3" height="4" rx="1" fill="currentColor"/>',
  interact: '<path d="M4 2.5v8l2.2-2 1.6 3.4 1.6-.8-1.6-3.3H11z" fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round"/>',
  stream: '<circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M4.5 4.5a5 5 0 0 0 0 7M11.5 4.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  record: '<circle cx="8" cy="8" r="4.2" fill="currentColor"/>',
  studio: '<rect x="2" y="4" width="5.2" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="8.8" y="4" width="5.2" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  check: '<path d="M3 8.5 6.2 12 13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  info: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7v4M8 5.2v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  warning: '<path d="M8 2.5 14.5 13.5h-13z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.4v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  folder: '<path d="M2.5 4.5h4l1.2 1.6h5.8v6.4h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  properties: '<rect x="2.5" y="3" width="11" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 6h6M5 8.5h6M5 11h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
};

/** Return an <svg> element for `name`, sized `size` px (default 16). */
export function icon(name, size = 16) {
  const body = paths[name] ?? paths.info;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('obs-icon');
  svg.innerHTML = body;
  return svg;
}

/** Convenience: an icon-only button with a tooltip and accessible name. */
export function iconButton(name, { title, onClick, className = '', disabled = false, size = 16 } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `obs-icon-btn ${className}`.trim();
  button.title = title ?? '';
  button.setAttribute('aria-label', title ?? name);
  button.disabled = disabled;
  button.appendChild(icon(name, size));
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

export const ICON_NAMES = Object.keys(paths);
