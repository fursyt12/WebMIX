/*
 * Tests for the interface language: OBS's own locale strings, looked up by
 * key (`t`) or by their English text (`tr`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { plain, setLocale, t, tr, hasKey, currentLocale } from '../src/i18n.js';

const RUSSIAN = {
  locale: 'ru-RU',
  english: {
    'Basic.MainMenu.File': '&File',
    'Basic.Main.StartStreaming': 'Start Streaming',
    'StudioMode.PreviewSceneName': 'Preview: %1',
    'Basic.MainMenu.Edit.Scale.Canvas': 'Canvas (%1x%2)',
    None: 'None',
    'Basic.Other.None': 'None',
    OnlyEnglish: 'Only English',
  },
  strings: {
    'Basic.MainMenu.File': 'Файл (&F)',
    'Basic.Main.StartStreaming': 'Начать трансляцию',
    'StudioMode.PreviewSceneName': 'Предпросмотр: %1',
    'Basic.MainMenu.Edit.Scale.Canvas': 'Холст (%1x%2)',
    None: 'Нет',
    'Basic.Other.None': 'Отсутствует',
    OnlyEnglish: 'Only English',
  },
};

test('keyboard accelerators are not part of a label', () => {
  assert.equal(plain('&File'), 'File');
  assert.equal(plain('Файл (&F)'), 'Файл');
  assert.equal(plain('Show &Recordings'), 'Show Recordings');
  assert.equal(plain('Lock && Load'), 'Lock & Load');
});

test('without a locale every text passes through', () => {
  setLocale(null);
  assert.equal(tr('Start Streaming'), 'Start Streaming');
  assert.equal(t('Basic.Main.StartStreaming', { fallback: 'Start Streaming' }), 'Start Streaming');
  assert.equal(t('No.Such.Key'), 'No.Such.Key');
  assert.equal(currentLocale(), 'en-US');
});

test('a string is found by its key, with its arguments filled in', () => {
  setLocale(RUSSIAN);
  assert.equal(currentLocale(), 'ru-RU');
  assert.equal(t('Basic.Main.StartStreaming'), 'Начать трансляцию');
  assert.equal(t('Basic.MainMenu.File'), 'Файл');
  assert.equal(t('StudioMode.PreviewSceneName', 'Game'), 'Предпросмотр: Game');
  assert.equal(t('Basic.MainMenu.Edit.Scale.Canvas', 1920, 1080), 'Холст (1920x1080)');
  assert.ok(hasKey('None'));
  assert.ok(!hasKey('Nope'));
});

test('a string is found by its English text', () => {
  setLocale(RUSSIAN);
  assert.equal(tr('Start Streaming'), 'Начать трансляцию');
  assert.equal(tr('File'), 'Файл');
  // The first key with that English text is the general one.
  assert.equal(tr('None'), 'Нет');
});

test('text that is not an OBS string is left alone', () => {
  setLocale(RUSSIAN);
  assert.equal(tr('My Webcam Scene'), 'My Webcam Scene');
  assert.equal(tr('Only English'), 'Only English');
  assert.equal(tr(42), 42);
  setLocale(null);
});
