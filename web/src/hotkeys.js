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
 * Capture the next key as an OBS key name plus modifier tokens, for rebinding
 * inside OBS. Resolves null on Escape; unsupported keys keep waiting.
 * @param {(binding: {keyName: string, modifiers: string[]}|null) => void} resolve
 */
export function captureObsKey(resolve) {
  const onKey = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      cleanup();
      resolve(null);
      return;
    }
    const keyName = obsKeyFromEvent(event);
    if (!keyName) return; // modifier-only or unmapped key: keep waiting
    const modifiers = obsModifiersFromEvent(event);
    cleanup();
    resolve({ keyName, modifiers });
  };
  const cleanup = () => window.removeEventListener('keydown', onKey, true);
  window.addEventListener('keydown', onKey, true);
  return cleanup;
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

/* ------------------------------------------------- OBS key names (for OBS) */

/**
 * Map a browser `event.code` to the OBS key name used by `obs_key_from_name`.
 *
 * OBS identifies keys by name (OBS_KEY_A ... OBS_KEY_F24), which is portable -
 * unlike the platform virtual key codes the Qt UI uses. Returns null for keys
 * this table does not cover.
 */
const OBS_KEY_BY_CODE = (() => {
  const map = {};
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    map[`Key${letter}`] = `OBS_KEY_${letter}`;
  }
  for (let i = 0; i <= 9; i++) map[`Digit${i}`] = `OBS_KEY_${i}`;
  for (let i = 1; i <= 24; i++) map[`F${i}`] = `OBS_KEY_F${i}`;
  for (let i = 0; i <= 9; i++) map[`Numpad${i}`] = `OBS_KEY_NUM${i}`;
  Object.assign(map, {
    Space: 'OBS_KEY_SPACE',
    Escape: 'OBS_KEY_ESCAPE',
    Enter: 'OBS_KEY_RETURN',
    NumpadEnter: 'OBS_KEY_RETURN',
    Tab: 'OBS_KEY_TAB',
    Backspace: 'OBS_KEY_BACKSPACE',
    Delete: 'OBS_KEY_DELETE',
    Insert: 'OBS_KEY_INSERT',
    Home: 'OBS_KEY_HOME',
    End: 'OBS_KEY_END',
    PageUp: 'OBS_KEY_PAGEUP',
    PageDown: 'OBS_KEY_PAGEDOWN',
    ArrowUp: 'OBS_KEY_UP',
    ArrowDown: 'OBS_KEY_DOWN',
    ArrowLeft: 'OBS_KEY_LEFT',
    ArrowRight: 'OBS_KEY_RIGHT',
    Minus: 'OBS_KEY_MINUS',
    Equal: 'OBS_KEY_EQUAL',
    BracketLeft: 'OBS_KEY_BRACKETLEFT',
    BracketRight: 'OBS_KEY_BRACKETRIGHT',
    Backslash: 'OBS_KEY_BACKSLASH',
    Semicolon: 'OBS_KEY_SEMICOLON',
    Quote: 'OBS_KEY_QUOTE',
    Backquote: 'OBS_KEY_QUOTELEFT',
    Comma: 'OBS_KEY_COMMA',
    Period: 'OBS_KEY_PERIOD',
    Slash: 'OBS_KEY_SLASH',
    NumpadAdd: 'OBS_KEY_NUMPLUS',
    NumpadSubtract: 'OBS_KEY_NUMMINUS',
    NumpadMultiply: 'OBS_KEY_NUMMULTIPLY',
    NumpadDivide: 'OBS_KEY_NUMSLASH',
    NumpadDecimal: 'OBS_KEY_NUMPERIOD',
    CapsLock: 'OBS_KEY_CAPSLOCK',
  });
  return map;
})();

/** The OBS key name for a keyboard event, or null when unsupported. */
export function obsKeyFromEvent(event) {
  return OBS_KEY_BY_CODE[event?.code] ?? null;
}

/** OBS modifier tokens for a keyboard event. */
export function obsModifiersFromEvent(event) {
  const modifiers = [];
  if (event?.ctrlKey) modifiers.push('control');
  if (event?.altKey) modifiers.push('alt');
  if (event?.shiftKey) modifiers.push('shift');
  if (event?.metaKey) modifiers.push('command');
  return modifiers;
}

/** Human-readable form of a captured combination, e.g. "Ctrl+Shift+R". */
export function describeCombo({ keyName, modifiers }) {
  const labels = modifiers.map((m) =>
    m === 'control' ? 'Ctrl' : m === 'alt' ? 'Alt' : m === 'shift' ? 'Shift' : 'Cmd'
  );
  const key = String(keyName ?? '').replace(/^OBS_KEY_/, '');
  return [...labels, key].filter(Boolean).join('+');
}
