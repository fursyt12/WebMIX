/*
 * WebMIX - OBS property renderer.
 *
 * obs-websocket exposes settings *values* but not the property *schema*, so a
 * web UI cannot know labels, ranges, list items or groups.  The WebMIX bridge
 * (frontend/webmix/WebMixBridge.cpp, served by OBS in --web mode) provides
 * exactly that, and this module turns it into the same controls the Qt
 * Properties/Filters dialogs show.
 *
 * When the bridge is unavailable (UI served externally by a plain static
 * server) the fetch helpers return null and callers fall back to a key-based
 * form.
 */
import { h, clear, setClass } from './dom.js';

const BRIDGE = 'api/properties';

/* ------------------------------------------------------------ value helpers */

/*
 * OBS stores colours as 0xAABBGGRR - red in the *low* byte (see
 * vec4_from_rgba() in libobs/graphics/vec4.h, which memcpy's the integer into
 * an R,G,B,A byte array). Getting this order wrong swaps red and blue in every
 * colour picker, so it is spelled out here and covered by tests.
 */
export function colorIntToHex(value, withAlpha = false) {
  const int = Number(value) >>> 0;
  const r = int & 0xff;
  const g = (int >>> 8) & 0xff;
  const b = (int >>> 16) & 0xff;
  const hex = (r << 16) | (g << 8) | b;
  const rgb = hex.toString(16).padStart(6, '0');
  if (!withAlpha) return `#${rgb}`;
  const alpha = ((int >>> 24) & 0xff).toString(16).padStart(2, '0');
  return `#${rgb}${alpha}`;
}

export function hexToColorInt(hex, withAlpha = false) {
  const clean = String(hex ?? '').replace('#', '');
  const rgb = parseInt(clean.slice(0, 6), 16) || 0;
  const r = (rgb >>> 16) & 0xff;
  const g = (rgb >>> 8) & 0xff;
  const b = rgb & 0xff;
  const alpha = withAlpha && clean.length === 8 ? parseInt(clean.slice(6, 8), 16) || 0 : 0xff;
  const packed = r | (g << 8) | (b << 16) | (alpha << 24);
  // Without alpha OBS still keeps the top byte opaque.
  return withAlpha ? packed >>> 0 : (packed & 0x00ffffff) >>> 0;
}

/** Stable string form used to compare schema item values with current values. */
export function valueKey(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value ?? '');
}

/** Number of decimals implied by a step, for display. */
export function decimalsForStep(step) {
  const text = String(step ?? 1);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(4, text.length - dot - 1);
}

/* ------------------------------------------------------------- bridge calls */

async function fetchJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.error) return null;
    return data;
  } catch {
    return null;
  }
}

/** Property schema for an input/scene source, or null when unavailable. */
export function fetchSourceProperties(name) {
  return fetchJson(`${BRIDGE}/source?name=${encodeURIComponent(name)}`);
}

/** Property schema for a filter, or null when unavailable. */
export function fetchFilterProperties(sourceName, filterName) {
  return fetchJson(
    `${BRIDGE}/filter?source=${encodeURIComponent(sourceName)}&filter=${encodeURIComponent(filterName)}`
  );
}

/** Property schema for a transition, or null when unavailable. */
export function fetchTransitionProperties(name) {
  return fetchJson(`${BRIDGE}/transition?name=${encodeURIComponent(name)}`);
}

/** Invoke a button property through the bridge. */
export async function pressPropertyButton({ scope, name, filter = '', property }) {
  const url =
    `${BRIDGE}/press?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}` +
    `&filter=${encodeURIComponent(filter)}&property=${encodeURIComponent(property)}`;
  try {
    const response = await fetch(url, { method: 'POST' });
    return response.ok;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- renderer */

/**
 * Render a property form.
 *
 * @param {object} schema  payload from the bridge ({properties, values, kind})
 * @param {object} [options]
 * @param {Record<string, any>} [options.overrides] values to prefer over the schema
 * @param {(changed: {name: string, value: any}) => void} [options.onChange]
 * @param {(property: object) => void} [options.onButton]
 * @returns {{el: HTMLElement, getSettings: () => object, readonly: boolean}}
 */
export function renderPropertyForm(schema, { overrides = {}, onChange, onButton } = {}) {
  const properties = schema?.properties ?? [];
  const baseValues = { ...(schema?.values ?? {}), ...overrides };
  const editor = { values: { ...baseValues }, setters: new Map() };
  const root = h('div.obs-property-form.obs-property-form-schema');

  const record = (name, read, extraKeys = []) => {
    editor.setters.set(name, { read, extraKeys });
  };

  const field = (property, control, extra = null) => {
    const row = h('div.obs-property-row', { dataset: { prop: property.name } }, [
      h('label.obs-property-label', { text: property.label || property.name }),
      control,
    ]);
    if (property.description) row.appendChild(h('div.obs-hint.obs-muted', { text: property.description }));
    if (extra) row.appendChild(extra);
    if (property.enabled === false) setClass(row, 'is-disabled', true);
    return row;
  };

  const buildControl = (property) => {
    const value = baseValues[property.name];
    const notify = () => onChange?.({ name: property.name, value: editor.values[property.name] });

    switch (property.type) {
      case 'bool': {
        const input = h('input.obs-checkbox', { type: 'checkbox', checked: !!value });
        input.addEventListener('change', () => {
          editor.values[property.name] = input.checked;
          notify();
        });
        record(property.name, () => input.checked);
        return input;
      }

      case 'int':
      case 'float': {
        const isFloat = property.type === 'float';
        const step = Number(property.step) || (isFloat ? 0.01 : 1);
        const min = property.min ?? (isFloat ? -1e9 : -2147483648);
        const max = property.max ?? (isFloat ? 1e9 : 2147483647);
        const dec = decimalsForStep(step);
        let input;
        if (property.numberType === 'slider') {
          input = h('input.obs-range', {
            type: 'range',
            min: String(min),
            max: String(max),
            step: String(step),
            value: String(value ?? min),
          });
          const readout = h('span.obs-property-readout', {
            text: `${Number(value ?? min).toFixed(dec)}${property.suffix ? ` ${property.suffix}` : ''}`,
          });
          input.addEventListener('input', () => {
            editor.values[property.name] = isFloat ? Number(input.value) : Math.round(Number(input.value));
            readout.textContent = `${Number(input.value).toFixed(dec)}${
              property.suffix ? ` ${property.suffix}` : ''
            }`;
            notify();
          });
          record(property.name, () =>
            isFloat ? Number(input.value) : Math.round(Number(input.value))
          );
          return h('div.obs-property-slider', {}, [input, readout]);
        }
        input = h('input.obs-input.obs-property-number', {
          type: 'number',
          min: String(min),
          max: String(max),
          step: String(step),
          value: String(value ?? 0),
        });
        input.addEventListener('change', () => {
          const num = Number(input.value);
          editor.values[property.name] = Number.isFinite(num) ? num : 0;
          notify();
        });
        record(property.name, () => {
          const num = Number(input.value);
          return Number.isFinite(num) ? num : 0;
        });
        return property.suffix
          ? h('div.obs-property-with-suffix', {}, [input, h('span.obs-muted', { text: property.suffix })])
          : input;
      }

      case 'text': {
        if (property.textType === 'info') {
          record(property.name, () => value ?? '');
          const info = h(`div.obs-property-info.is-${property.infoType ?? 'normal'}`, {
            text: property.label || '',
          });
          // Info properties are labels, not editable rows; render them wide.
          info.dataset.prop = property.name;
          return null;
        }
        const isMultiline = property.textType === 'multiline';
        const input = isMultiline
          ? h('textarea.obs-input.obs-property-json.obs-scroll', {
              rows: '3',
              text: String(value ?? ''),
            })
          : h('input.obs-input', {
              type: property.textType === 'password' ? 'password' : 'text',
              value: String(value ?? ''),
            });
        if (property.monospace) input.classList.add('obs-monospace');
        input.addEventListener('input', () => {
          editor.values[property.name] = input.value;
          notify();
        });
        record(property.name, () => input.value);
        return input;
      }

      case 'path': {
        const input = h('input.obs-input', { type: 'text', value: String(value ?? '') });
        input.addEventListener('input', () => {
          editor.values[property.name] = input.value;
          notify();
        });
        record(property.name, () => input.value);
        return h('div.obs-property-path', {}, [
          input,
          h('div.obs-hint.obs-muted', {
            text:
              property.pathType === 'directory'
                ? 'Directory path (browsers cannot open a native folder picker)'
                : property.pathType === 'save'
                  ? 'Output file path'
                  : 'File path (browsers cannot open a native file picker)',
          }),
        ]);
      }

      case 'list': {
        const items = property.items ?? [];
        const current = valueKey(value);
        if (property.listType === 'radio') {
          const group = h('div.obs-property-radio');
          let selected = current;
          for (const item of items) {
            const key = valueKey(item.value);
            const radio = h('input.obs-radio', {
              type: 'radio',
              name: `prop-${property.name}`,
              checked: key === current,
              disabled: !!item.disabled,
            });
            radio.addEventListener('change', () => {
              if (!radio.checked) return;
              selected = key;
              editor.values[property.name] = item.value;
              notify();
            });
            group.appendChild(h('label.obs-radio-label', {}, [radio, item.name]));
          }
          record(property.name, () => {
            const found = items.find((item) => valueKey(item.value) === selected);
            return found ? found.value : value;
          });
          return group;
        }

        const select = h('select.obs-select');
        for (const item of items) {
          const option = h('option', { value: valueKey(item.value), text: item.name });
          if (item.disabled) option.disabled = true;
          select.appendChild(option);
        }
        if (property.listType === 'editable') {
          // Editable combos allow values outside the list; fall back to an input
          // when the current value is not one of the items.
          const known = items.some((item) => valueKey(item.value) === current);
          if (!known) select.appendChild(h('option', { value: current, text: current }));
        }
        select.value = current;
        select.addEventListener('change', () => {
          const found = items.find((item) => valueKey(item.value) === select.value);
          editor.values[property.name] = found ? found.value : select.value;
          notify();
        });
        record(property.name, () => {
          const found = items.find((item) => valueKey(item.value) === select.value);
          return found ? found.value : select.value;
        });
        return select;
      }

      case 'color': {
        const withAlpha = property.alpha === true;
        const color = h('input.obs-color', {
          type: 'color',
          value: colorIntToHex(value, false),
        });
        let alphaInput = null;
        const update = () => {
          const alpha = alphaInput ? Number(alphaInput.value) : (Number(value) >>> 24) & 0xff;
          editor.values[property.name] = hexToColorInt(color.value, withAlpha) | (withAlpha ? alpha << 24 : 0);
          notify();
        };
        color.addEventListener('input', update);
        const row = [color];
        if (withAlpha) {
          alphaInput = h('input.obs-range', {
            type: 'range',
            min: '0',
            max: '255',
            step: '1',
            value: String((Number(value) >>> 24) & 0xff),
            title: 'Alpha',
          });
          alphaInput.addEventListener('input', update);
          row.push(alphaInput);
        }
        record(property.name, () => {
          const alpha = alphaInput ? Number(alphaInput.value) : (Number(value) >>> 24) & 0xff;
          return (hexToColorInt(color.value, false) | (withAlpha ? alpha << 24 : 0)) >>> 0;
        });
        return h('div.obs-property-color', {}, row);
      }

      case 'button': {
        const button = h('button.obs-btn', { type: 'button', text: property.label || property.name });
        button.addEventListener('click', () => onButton?.(property));
        record(property.name, () => undefined);
        return button;
      }

      case 'font': {
        const face = h('input.obs-input', { type: 'text', value: String(value ?? '') });
        face.addEventListener('input', () => {
          editor.values[property.name] = face.value;
          notify();
        });
        const size = h('input.obs-input.obs-property-number', {
          type: 'number',
          min: '1',
          step: '1',
          value: String(property.size ?? 36),
          title: 'Size',
        });
        const flags = (property.flags ?? []).map((flag) => {
          const box = h('input.obs-checkbox', {
            type: 'checkbox',
            checked: (Number(property.flagValue ?? 0) & flag.value) !== 0,
          });
          box.dataset.flag = String(flag.value);
          return h('label.obs-checkbox-label', {}, [box, flag.name]);
        });
        const sizeKey = `${property.name}.size`;
        const flagsKey = `${property.name}.flags`;
        editor.values[sizeKey] = property.size ?? 36;
        editor.values[flagsKey] = property.flagValue ?? 0;
        record(property.name, () => face.value, [sizeKey, flagsKey]);
        editor.setters.set(`${property.name}#extras`, {
          read: () => ({
            [sizeKey]: Number(size.value) || 0,
            [flagsKey]: flags.reduce(
              (acc, label) => acc | (label.querySelector('input').checked ? Number(label.querySelector('input').dataset.flag) : 0),
              0
            ),
          }),
        });
        return h('div.obs-property-font', {}, [face, h('div.obs-property-font-meta', {}, [size, ...flags])]);
      }

      case 'editableList': {
        const input = h('textarea.obs-input.obs-property-json.obs-scroll', {
          rows: '3',
          text: JSON.stringify(Array.isArray(value) ? value : [], null, 0),
        });
        input.addEventListener('change', () => {
          try {
            editor.values[property.name] = JSON.parse(input.value);
          } catch {
            /* keep the last valid value */
          }
          notify();
        });
        record(property.name, () => {
          try {
            return JSON.parse(input.value);
          } catch {
            return value ?? [];
          }
        });
        return input;
      }

      case 'frameRate':
        // Rarely used by the UI; expose the option list when present.
        if (property.options?.length) {
          const select = h(
            'select.obs-select',
            {},
            property.options.map((option) => h('option', { value: option.name, text: option.description || option.name }))
          );
          select.value = String(value ?? '');
          select.addEventListener('change', () => {
            editor.values[property.name] = select.value;
            notify();
          });
          record(property.name, () => select.value);
          return select;
        }
        record(property.name, () => value);
        return h('div.obs-property-info', { text: 'Frame rate is configured via the canvas settings' });

      default: {
        record(property.name, () => value);
        return h('div.obs-muted', { text: `${property.type}: ${JSON.stringify(value)}` });
      }
    }
  };

  const buildProperties = (list, container) => {
    for (const property of list) {
      if (property.visible === false) continue;

      if (property.type === 'group') {
        const body = h('div.obs-property-group-body');
        buildProperties(property.children ?? [], body);
        if (property.groupType === 'checkable') {
          const enable = h('input.obs-checkbox', { type: 'checkbox', checked: valueKey(baseValues[property.name]) === 'true' });
          enable.addEventListener('change', () => {
            editor.values[property.name] = enable.checked;
            setClass(fieldset, 'is-collapsed', !enable.checked);
            onChange?.({ name: property.name, value: enable.checked });
          });
          record(property.name, () => enable.checked);
          const fieldset = h('fieldset.obs-property-group', {}, [
            h('legend', {}, [h('label.obs-checkbox-label', {}, [enable, property.label || property.name])]),
            body,
          ]);
          if (!enable.checked) fieldset.classList.add('is-collapsed');
          container.appendChild(fieldset);
          continue;
        }
        container.appendChild(
          h('fieldset.obs-property-group', {}, [h('legend', { text: property.label || property.name }), body])
        );
        continue;
      }

      const control = buildControl(property);
      if (control === null) {
        // Info property: a full-width note, not a label/control pair.
        if (property.type === 'text' && property.textType === 'info') {
          container.appendChild(
            h(`div.obs-property-info.is-${property.infoType ?? 'normal'}`, { text: property.label })
          );
        }
        continue;
      }
      container.appendChild(field(property, control));
    }
  };

  buildProperties(properties, root);

  return {
    el: root,
    /** Every known value, including untouched ones, ready for SetInputSettings. */
    getSettings() {
      const out = { ...baseValues };
      for (const [name, setter] of editor.setters) {
        if (name.endsWith('#extras')) {
          Object.assign(out, setter.read());
          continue;
        }
        const value = setter.read();
        if (value !== undefined) out[name] = value;
      }
      return out;
    },
  };
}
