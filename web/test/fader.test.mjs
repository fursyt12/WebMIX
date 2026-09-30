/*
 * Tests for the OBS fader/meter math ported from libobs and
 * frontend/components/VolumeControl.cpp (OBS_FADER_LOG).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FADER_PRECISION,
  defToDb,
  dbToDef,
  mulToDb,
  dbToMul,
  sliderToMul,
  mulToSlider,
  dbToLabel,
  levelToPercent,
  levelState,
} from '../src/fader.js';

const close = (a, b, epsilon = 1e-6) => Math.abs(a - b) < epsilon;

test('fader precision matches the OBS volume slider resolution', () => {
  assert.equal(FADER_PRECISION, 4096);
});

test('log fader curve endpoints match OBS', () => {
  assert.equal(defToDb(1), 0);
  assert.equal(defToDb(0), -Infinity);
  assert.equal(dbToDef(0), 1);
  assert.equal(dbToDef(-96), 0);
  // The curve is anchored at -96 dB with a +6 dB offset.
  assert.ok(close(defToDb(0.0001), -95.99, 0.05));
});

test('log fader curve round-trips', () => {
  for (const def of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
    const db = defToDb(def);
    assert.ok(close(dbToDef(db), def, 1e-9), `def ${def} -> db ${db} -> def`);
  }
  for (const db of [-90, -60, -40, -20, -12, -6, -3, -1, -0.5]) {
    assert.ok(close(defToDb(dbToDef(db)), db, 1e-9), `db ${db}`);
  }
});

test('multiplier/dB conversions follow the OBS convention', () => {
  assert.equal(mulToDb(1), 0);
  assert.equal(mulToDb(0), -Infinity);
  assert.ok(close(mulToDb(0.5), -6.020599913279624, 1e-9));
  assert.equal(dbToMul(0), 1);
  assert.equal(dbToMul(-Infinity), 0);
  assert.ok(close(dbToMul(-6.020599913279624), 0.5, 1e-9));
});

test('slider value <-> multiplier round-trips through the fader curve', () => {
  // The OBS slider tops out at unity gain (0 dB), so anything at or above
  // 1.0 maps to the top of the fader.
  for (const mul of [0, 0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 1]) {
    const slider = mulToSlider(mul);
    assert.ok(slider >= 0 && slider <= FADER_PRECISION, `slider in range for ${mul}`);
    const back = sliderToMul(slider);
    assert.ok(close(back, mul, 0.005), `mul ${mul} -> slider ${slider} -> ${back}`);
  }
  assert.equal(mulToSlider(1.5), FADER_PRECISION, 'gain above unity clamps to the top');
  assert.equal(mulToSlider(2), FADER_PRECISION);
  // Unity gain is the top of the slider.
  assert.equal(mulToSlider(1), FADER_PRECISION);
  assert.equal(sliderToMul(FADER_PRECISION), 1);
  // Silence is the bottom.
  assert.equal(sliderToMul(0), 0);
});

test('dB labels match OBS formatting', () => {
  assert.equal(dbToLabel(0), '0.0 dB');
  assert.equal(dbToLabel(-6.020599913279624), '-6.0 dB');
  assert.equal(dbToLabel(-Infinity), '-inf dB');
  assert.equal(dbToLabel(-101), '-inf dB');
});

test('meter scale is -60 dB .. 0 dB with OBS warning/error thresholds', () => {
  assert.equal(levelToPercent(0), 0);
  assert.equal(levelToPercent(dbToMul(-60)), 0);
  assert.equal(levelToPercent(dbToMul(-30)), 50);
  assert.equal(levelToPercent(dbToMul(0)), 100);
  assert.equal(levelToPercent(dbToMul(6)), 100, 'levels above 0 dB clip the meter');

  assert.equal(levelState(dbToMul(-40)), 'nominal');
  assert.equal(levelState(dbToMul(-20)), 'warning');
  assert.equal(levelState(dbToMul(-9)), 'error');
  assert.equal(levelState(dbToMul(-5)), 'error');
});

test('meter percent is monotonic in level', () => {
  let previous = -1;
  for (const db of [-60, -50, -40, -30, -20, -10, -5, 0]) {
    const percent = levelToPercent(dbToMul(db));
    assert.ok(percent >= previous, `monotonic at ${db} dB`);
    previous = percent;
  }
});
