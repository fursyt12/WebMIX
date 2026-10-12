/*
 * WebMIX - small widgets the desktop UI has and HTML does not.
 */
import { h } from '../dom.js';

/**
 * QSpinBox: a number field that shows its unit inside the field ("300 ms")
 * and has its two step buttons stacked at the right edge.
 *
 * @param {object} options
 * @param {number} [options.value]
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @param {number} [options.step]
 * @param {string} [options.suffix]   shown after the number, e.g. ' ms'
 * @param {number} [options.decimals]
 * @param {string} [options.label]    accessible name
 * @param {(value: number) => void} [options.onChange]
 * @returns {{el: HTMLElement, input: HTMLInputElement, value: number, focused: boolean}}
 */
export function spinBox({ value = 0, min = -Infinity, max = Infinity, step = 1, suffix = '', decimals = 0, label = '', onChange } = {}) {
  let current = Number(value) || 0;

  const format = (number) => `${number.toFixed(decimals)}${suffix}`;
  const clamp = (number) => Math.min(max, Math.max(min, number));
  const input = h('input', { type: 'text', inputmode: 'decimal', value: format(current), 'aria-label': label, raw: true });

  const commit = (next, notify = true) => {
    const parsed = clamp(Number.isFinite(next) ? next : current);
    const changed = parsed !== current;
    current = parsed;
    input.value = format(current);
    if (changed && notify) onChange?.(current);
  };

  input.addEventListener('change', () => commit(parseFloat(input.value.replace(',', '.'))));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      commit(current + (event.key === 'ArrowUp' ? step : -step));
    } else if (event.key === 'Enter') {
      input.blur();
    }
  });
  input.addEventListener('wheel', (event) => {
    if (document.activeElement !== input) return;
    event.preventDefault();
    commit(current + (event.deltaY < 0 ? step : -step));
  });

  const up = h('button', { type: 'button', tabindex: '-1', 'aria-label': 'Increase', on: { click: () => commit(current + step) } });
  const down = h('button', { type: 'button', tabindex: '-1', 'aria-label': 'Decrease', on: { click: () => commit(current - step) } });
  const el = h('div.obs-spin', {}, [input, up, down]);

  return {
    el,
    input,
    get value() {
      return current;
    },
    /** Set from outside (an OBS event); does not call onChange. */
    set value(next) {
      commit(Number(next), false);
    },
    get focused() {
      return document.activeElement === input;
    },
  };
}
