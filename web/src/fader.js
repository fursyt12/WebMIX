/*
 * WebMIX - volume fader and meter math.
 *
 * Ported from libobs so the mixer behaves exactly like the desktop UI:
 *
 *  - The volume slider uses the OBS `OBS_FADER_LOG` curve
 *    (libobs/obs-audio-controls.c: log_def_to_db / log_db_to_def) and a
 *    0..FADER_PRECISION range, matching frontend/components/VolumeControl.cpp.
 *  - The level meter is drawn in dB from -60 (bottom) to 0 (top) with
 *    warning at -20 dB and error at -9 dB
 *    (frontend/components/VolumeMeter.cpp).
 */

/** VolumeControl.cpp / VolumeMeter.hpp: slider resolution. */
export const FADER_PRECISION = 4096;

const LOG_OFFSET_DB = 6;
const LOG_RANGE_DB = 96;
const LOG_OFFSET_VAL = -Math.log10(LOG_OFFSET_DB); // -0.7781512503836436
// The C comment claims -log10(-LOG_RANGE_DB + LOG_OFFSET_DB); the value
// -2.00860017176191756 corresponds to -(LOG_RANGE_DB + LOG_OFFSET_DB).
const LOG_RANGE_VAL = -Math.log10(LOG_RANGE_DB + LOG_OFFSET_DB); // -2.0086001717619175

export const MIN_METER_DB = -60;
export const METER_WARNING_DB = -20;
export const METER_ERROR_DB = -9;
export const METER_CLIP_DB = 0;

/** Fader deflection (0..1) -> decibels. */
export function defToDb(def) {
  if (def >= 1) return 0;
  if (def <= 0) return -Infinity;
  return (
    -(LOG_RANGE_DB + LOG_OFFSET_DB) *
      Math.pow((LOG_RANGE_DB + LOG_OFFSET_DB) / LOG_OFFSET_DB, -def) +
    LOG_OFFSET_DB
  );
}

/** Decibels -> fader deflection (0..1). */
export function dbToDef(db) {
  if (db >= 0) return 1;
  if (db <= -96) return 0;
  return (
    (-Math.log10(-db + LOG_OFFSET_DB) - LOG_RANGE_VAL) / (LOG_OFFSET_VAL - LOG_RANGE_VAL)
  );
}

/** Linear volume multiplier -> decibels. */
export function mulToDb(mul) {
  return mul <= 0 ? -Infinity : 20 * Math.log10(mul);
}

/** Decibels -> linear volume multiplier. */
export function dbToMul(db) {
  if (db === -Infinity) return 0;
  return 10 ** (db / 20);
}

/** Slider value (0..FADER_PRECISION) -> volume multiplier. */
export function sliderToMul(value) {
  const def = value / FADER_PRECISION;
  return dbToMul(defToDb(def));
}

/** Volume multiplier -> slider value (0..FADER_PRECISION). */
export function mulToSlider(mul) {
  return Math.round(dbToDef(mulToDb(mul)) * FADER_PRECISION);
}

/** Format a dB value the way OBS labels it. */
export function dbToLabel(db) {
  if (db === -Infinity || db <= -100) return '-inf dB';
  return `${db.toFixed(1)} dB`;
}

/** Format a slider-value label (OBS shows the dB value under the slider). */
export function mulToLabel(mul) {
  return dbToLabel(mulToDb(mul));
}

/** Meter fill percentage (0..100) for a linear level multiplier. */
export function levelToPercent(mul) {
  const db = mulToDb(mul);
  if (db <= MIN_METER_DB) return 0;
  if (db >= METER_CLIP_DB) return 100;
  return ((db - MIN_METER_DB) / (METER_CLIP_DB - MIN_METER_DB)) * 100;
}

/** Meter state class for a level: nominal | warning | error. */
export function levelState(mul) {
  const db = mulToDb(mul);
  if (db >= METER_ERROR_DB) return 'error';
  if (db >= METER_WARNING_DB) return 'warning';
  return 'nominal';
}
