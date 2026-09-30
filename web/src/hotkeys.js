/*
 * WebMIX - browser-side hotkey bindings.
 *
 * obs-websocket can list hotkeys and *trigger* them by name, but cannot change
 * OBS's own bindings.  WebMIX therefore lets the user bind keys in the browser:
 * the combination is captured, stored locally and, when pressed, sent to OBS as
 * `TriggerHotkeyByName`.  This makes hotkeys usable from the web UI even though
 * OBS itself still owns the real bindings.
 */

const STORAGE_KEY = 'webmix.hotkeys';

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

/** Normalise a KeyboardEvent into a stable combo string, e.g. "Ctrl+Shift+R". */
export function comboFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');

  const key = normalizeKey(event.key);
  if (!key) return null;
  // A modifier on its own is not a usable binding.
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null;
  parts.push(key);
  return parts.join('+');
}

function normalizeKey(key) {
  if (!key) return null;
  if (key === ' ') return 'Space';
  if (key === 'Escape') return 'Escape';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** True when the event should be ignored because the user is typing. */
export function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/** Sort modifiers into a canonical order for display and comparison. */
export function normalizeCombo(combo) {
  if (!combo) return '';
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  const modifiers = MODIFIER_ORDER.filter((m) => parts.includes(m));
  const keys = parts.filter((p) => !MODIFIER_ORDER.includes(p));
  return [...modifiers, ...keys].join('+');
}

/** Find the hotkey name bound to a keyboard event, if any. */
export function matchBinding(bindings, event) {
  const combo = normalizeCombo(comboFromEvent(event));
  if (!combo) return null;
  for (const [hotkeyName, bound] of Object.entries(bindings)) {
    if (normalizeCombo(bound) === combo) return hotkeyName;
  }
  return null;
}

export function loadBindings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveBindings(bindings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the next key combination the user presses.
 * @param {(combo: string|null) => void} resolve  null when cancelled (Escape)
 */
export function captureCombo(resolve) {
  const onKey = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      cleanup();
      resolve(null);
      return;
    }
    const combo = comboFromEvent(event);
    if (!combo) return; // modifier only: keep waiting
    cleanup();
    resolve(normalizeCombo(combo));
  };
  const cleanup = () => {
    window.removeEventListener('keydown', onKey, true);
  };
  window.addEventListener('keydown', onKey, true);
  return cleanup;
}
