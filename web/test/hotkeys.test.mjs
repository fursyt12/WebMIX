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
