/*
 * Tests for the browser-side hotkey bindings (obs-websocket can trigger
 * hotkeys but cannot rebind them, so WebMIX captures the combinations itself).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  comboFromEvent,
  normalizeCombo,
  matchBinding,
  isTypingTarget,
  obsKeyFromEvent,
  obsModifiersFromEvent,
  describeCombo,
  captureObsKey,
} from '../src/hotkeys.js';

const evt = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('comboFromEvent normalises keys and modifiers', () => {
  assert.equal(comboFromEvent(evt('r', { ctrlKey: true })), 'Ctrl+R');
  assert.equal(comboFromEvent(evt('R', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+R');
  assert.equal(comboFromEvent(evt('F5')), 'F5');
  assert.equal(comboFromEvent(evt(' ')), 'Space');
  assert.equal(comboFromEvent(evt('Escape')), 'Escape');
  assert.equal(comboFromEvent(evt('ArrowUp', { altKey: true })), 'Alt+ArrowUp');
});

test('a bare modifier is not a usable binding', () => {
  for (const key of ['Control', 'Alt', 'Shift', 'Meta']) {
    assert.equal(comboFromEvent(evt(key, { ctrlKey: true })), null, key);
  }
});

test('normalizeCombo canonicalises modifier order', () => {
  assert.equal(normalizeCombo('Shift+Ctrl+R'), 'Ctrl+Shift+R');
  assert.equal(normalizeCombo(' Alt + Ctrl + R '), 'Ctrl+Alt+R');
  assert.equal(normalizeCombo('Ctrl+R'), 'Ctrl+R');
  assert.equal(normalizeCombo(''), '');
  assert.equal(normalizeCombo(null), '');
});

test('matchBinding finds the hotkey for an event regardless of modifier order', () => {
  const bindings = {
    'OBSBasic.StartRecording': 'Ctrl+Shift+R',
    'OBSBasic.StopStreaming': 'Ctrl+Alt+S',
    'OBSBasic.MuteMic': 'F9',
  };
  assert.equal(matchBinding(bindings, evt('r', { ctrlKey: true, shiftKey: true })), 'OBSBasic.StartRecording');
  assert.equal(matchBinding(bindings, evt('R', { shiftKey: true, ctrlKey: true })), 'OBSBasic.StartRecording');
  assert.equal(matchBinding(bindings, evt('s', { ctrlKey: true, altKey: true })), 'OBSBasic.StopStreaming');
  assert.equal(matchBinding(bindings, evt('F9')), 'OBSBasic.MuteMic');
  assert.equal(matchBinding(bindings, evt('r', { ctrlKey: true })), null);
  assert.equal(matchBinding(bindings, evt('x')), null);
  assert.equal(matchBinding({}, evt('F9')), null);
});

test('isTypingTarget protects form fields from hotkey capture', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget(null), false);
});

test('browser keys map to the OBS key names obs_key_from_name expects', () => {
  assert.equal(obsKeyFromEvent({ code: 'KeyR' }), 'OBS_KEY_R');
  assert.equal(obsKeyFromEvent({ code: 'Digit7' }), 'OBS_KEY_7');
  assert.equal(obsKeyFromEvent({ code: 'F9' }), 'OBS_KEY_F9');
  assert.equal(obsKeyFromEvent({ code: 'Numpad4' }), 'OBS_KEY_NUM4');
  assert.equal(obsKeyFromEvent({ code: 'Space' }), 'OBS_KEY_SPACE');
  assert.equal(obsKeyFromEvent({ code: 'Escape' }), 'OBS_KEY_ESCAPE');
  assert.equal(obsKeyFromEvent({ code: 'ArrowUp' }), 'OBS_KEY_UP');
  assert.equal(obsKeyFromEvent({ code: 'PageDown' }), 'OBS_KEY_PAGEDOWN');
  // Unmapped keys must not silently bind something else.
  assert.equal(obsKeyFromEvent({ code: 'LaunchMail' }), null);
  assert.equal(obsKeyFromEvent({}), null);
  assert.equal(obsKeyFromEvent(undefined), null);
});

test('modifiers map to the OBS interaction flags', () => {
  assert.deepEqual(obsModifiersFromEvent({}), []);
  assert.deepEqual(obsModifiersFromEvent({ ctrlKey: true }), ['control']);
  assert.deepEqual(obsModifiersFromEvent({ ctrlKey: true, shiftKey: true }), ['control', 'shift']);
  assert.deepEqual(obsModifiersFromEvent({ altKey: true, metaKey: true }), ['alt', 'command']);
});

test('describeCombo renders a readable combination', () => {
  assert.equal(describeCombo({ keyName: 'OBS_KEY_F9', modifiers: ['control'] }), 'Ctrl+F9');
  assert.equal(describeCombo({ keyName: 'OBS_KEY_R', modifiers: ['control', 'shift'] }), 'Ctrl+Shift+R');
  assert.equal(describeCombo({ keyName: 'OBS_KEY_SPACE', modifiers: [] }), 'SPACE');
});

test('captureObsKey resolves a binding and cancels on Escape', async () => {
  const dispatch = (event) => window.dispatchEvent(Object.assign(new Event('keydown'), event));
  const listeners = new Set();
  globalThis.window = {
    addEventListener: (type, fn) => listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    dispatchEvent: (event) => {
      for (const fn of [...listeners]) fn(event);
      return true;
    },
  };
  // A modifier-only press must not complete the capture.
  let resolved = 'pending';
  captureObsKey((binding) => (resolved = binding));
  dispatch({ key: 'Control', code: 'ControlLeft', ctrlKey: true });
  assert.equal(resolved, 'pending');

  dispatch({ key: 'F9', code: 'F9', ctrlKey: true });
  assert.deepEqual(resolved, { keyName: 'OBS_KEY_F9', modifiers: ['control'] });

  // Escape cancels.
  resolved = 'pending';
  captureObsKey((binding) => (resolved = binding));
  dispatch({ key: 'Escape', code: 'Escape' });
  assert.equal(resolved, null);
});
