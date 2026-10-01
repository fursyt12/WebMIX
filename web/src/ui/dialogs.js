/*
 * WebMIX - OBS dialogs rebuilt for the web.
 *
 * Fully faithful (all data comes from obs-websocket):
 *   - Scene Item Transform  (Get/SetSceneItemTransform)
 *   - Stats                 (GetStats + GetVideoSettings)
 *   - Advanced Audio        (per-input volume/mute/monitor/tracks/sync/balance)
 *   - Stream / Video / Audio / Output settings (video settings, stream service
 *     settings, record directory and profile parameters)
 *
 * Best effort (obs-websocket does not expose the property *schema*):
 *   - Properties and Filter settings are rendered from the default-settings
 *     key/value map, so labels, ranges, groups, visibility conditions and
 *     list-property choices are not available.  See web/README.md.
 */
import { h, clear, setText, setClass, qs, debounce } from '../dom.js';
import { openDialog, dialogButtons, showContextMenu, prompt, confirm, alert } from './dialog.js';
import { icon, iconButton } from './icons.js';
import { Topic, selectors } from '../store.js';
import { mulToLabel, dbToMul, mulToDb } from '../fader.js';
import { statsRows } from './stats.js';
import {
  fetchSourceProperties,
  fetchFilterProperties,
  renderPropertyForm,
  pressPropertyButton,
} from '../properties.js';
import {
  loadBindings,
  saveBindings,
  captureCombo,
  captureObsKey,
  normalizeCombo,
  describeCombo,
} from '../hotkeys.js';
import { fetchHotkeys, bindHotkey, clearHotkey, fetchEncoderOptions } from '../bridge.js';

/* ------------------------------------------------------- generic properties */

const valueKind = (value) => {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value) || (value && typeof value === 'object')) return 'json';
  return 'string';
};

/**
 * Build a form for an OBS settings map.
 *
 * @param {object} options
 * @param {Record<string, any>} options.current  current settings
 * @param {Record<string, any>} options.defaults default settings (key schema)
 * @param {(name: string) => Promise<Array<{name: string, value: any}>>} [options.listItems]
 * @returns {{el: HTMLElement, getSettings: () => object, reset: () => void}}
 */
export function buildPropertyForm({ current = {}, defaults = {}, listItems = null }) {
  const keys = [...new Set([...Object.keys(defaults), ...Object.keys(current)])].sort();
  const rows = h('div.obs-property-form');
  const editors = new Map();

  for (const key of keys) {
    const value = key in current ? current[key] : defaults[key];
    const kind = valueKind(value);
    const label = h('label.obs-label.obs-property-label', { text: key });
    let control;

    if (kind === 'boolean') {
      control = h('input.obs-checkbox', { type: 'checkbox', checked: !!value });
      editors.set(key, () => control.checked);
    } else if (kind === 'integer' || kind === 'number') {
      control = h('input.obs-input.obs-property-number', {
        type: 'number',
        value: String(value),
        step: kind === 'integer' ? '1' : '0.01',
      });
      editors.set(key, () => {
        const num = Number(control.value);
        return Number.isFinite(num) ? num : value;
      });
    } else if (kind === 'json') {
      control = h('textarea.obs-input.obs-property-json.obs-scroll', {
        rows: '3',
        text: JSON.stringify(value, null, 2),
      });
      editors.set(key, () => {
        try {
          return JSON.parse(control.value);
        } catch {
          return value;
        }
      });
    } else {
      control = h('input.obs-input.obs-property-text', { type: 'text', value: String(value ?? '') });
      editors.set(key, () => control.value);
      if (listItems) {
        // Replace with a <select> when OBS reports a list property.
        listItems(key)
          .then((items) => {
            if (!items?.length) return;
            const select = h(
              'select.obs-select.obs-property-select',
              {},
              items.map((item) =>
                h('option', { value: String(item.value ?? item.name), text: item.name ?? String(item.value) })
              )
            );
            select.value = String(value ?? '');
            control.replaceWith(select);
            editors.set(key, () => select.value);
          })
          .catch(() => {});
      }
    }

    rows.appendChild(h('div.obs-property-row', {}, [label, control]));
  }

  if (!keys.length) {
    rows.appendChild(h('div.obs-empty', { text: 'This source has no configurable settings' }));
  }

  return {
    el: rows,
    getSettings() {
      const out = {};
      for (const [key, read] of editors) out[key] = read();
      return out;
    },
    reset() {
      for (const [key, read] of editors) void read;
      for (const key of keys) {
        const value = defaults[key];
        const node = rows.querySelector(`.obs-property-row:nth-child(${keys.indexOf(key) + 1}) input, .obs-property-row:nth-child(${keys.indexOf(key) + 1}) textarea, .obs-property-row:nth-child(${keys.indexOf(key) + 1}) select`);
        if (!node) continue;
        if (node.type === 'checkbox') node.checked = !!value;
        else if (node.tagName === 'TEXTAREA') node.value = JSON.stringify(value, null, 2);
        else node.value = String(value ?? '');
      }
    },
  };
}

/* ---------------------------------------------------------------- properties */

export async function openPropertiesDialog({ api, store, sourceName, onStatus }) {
  if (!sourceName) return;
  const isScene = store.state.scenes.some((s) => s.sceneName === sourceName);
  if (isScene) {
    onStatus?.('Scenes have no properties; open Filters instead', 'warning');
    return;
  }

  const dialog = openDialog({
    title: `Properties for '${sourceName}'`,
    width: 640,
    height: 520,
    body: h('div.obs-empty', { text: 'Loading settings...' }),
    footer: null,
    closable: true,
  });

  /* Preferred path: the WebMIX bridge supplies the real property schema, so we
   * can render the same labelled controls the desktop UI shows. */
  const schema = await fetchSourceProperties(sourceName);
  if (schema) {
    let original = { ...schema.values };
    let form = null;
    const container = h('div.obs-properties-schema');

    const render = (overrides = {}, focusName = null) => {
      form = renderPropertyForm(schema, {
        overrides,
        onChange: (changed) => applyLive(changed),
        onButton: (property) => pressButton(property),
      });
      container.replaceChildren(form.el);
      if (focusName) focusProperty(container, focusName);
    };

    const applyLive = debounce(async (changed) => {
      if (changed.value === undefined) return;
      try {
        await api.setInputSettings(sourceName, { [changed.name]: changed.value }, true);
        const fresh = await fetchSourceProperties(sourceName);
        if (!fresh) return;
        const keep = form ? form.getSettings() : {};
        // Adopt the fresh schema (visibility may have changed) but keep what the
        // user has typed in fields the schema does not own.
        Object.assign(schema, fresh);
        original = { ...fresh.values, ...original, [changed.name]: changed.value };
        render({ ...keep, [changed.name]: changed.value }, changed.name);
      } catch (err) {
        onStatus?.(err.message, 'error');
      }
    }, 260);

    const pressButton = async (property) => {
      try {
        await api.pressInputPropertiesButton(sourceName, property.name);
      } catch (err) {
        onStatus?.(err.message, 'error');
      }
    };

    clear(dialog.body);
    render();
    if (!(schema.properties ?? []).length) {
      container.appendChild(h('div.obs-empty', { text: 'This source has no configurable settings' }));
    }

    dialog.footer.append(
      dialogButtons([
        {
          label: 'Defaults',
          action: async () => {
            try {
              const { defaultInputSettings } = await api.getInputDefaultSettings(schema.kind ?? '');
              await api.setInputSettings(sourceName, defaultInputSettings, true);
              const fresh = await fetchSourceProperties(sourceName);
              if (fresh) {
                Object.assign(schema, fresh);
                render(fresh.values);
              }
            } catch (err) {
              onStatus?.(err.message, 'error');
            }
          },
        },
        {
          label: 'Cancel',
          action: async () => {
            // Changes are applied live, so restore the captured values.
            try {
              await api.setInputSettings(sourceName, original, true);
            } catch {
              /* best effort */
            }
            dialog.close();
          },
        },
        { label: 'OK', primary: true, action: () => dialog.close() },
      ])
    );
    return dialog;
  }

  /* Fallback (bridge unavailable, e.g. UI served by a plain static server):
   * obs-websocket only exposes values, so show them keyed by property name. */
  try {
    const [{ inputSettings, inputKind }, { defaultInputSettings }] = await Promise.all([
      api.getInputSettings(sourceName),
      api.getInputDefaultSettings(store.state.inputs[sourceName]?.inputKind ?? ''),
    ]);

    const form = buildPropertyForm({
      current: inputSettings,
      defaults: defaultInputSettings,
      listItems: (propertyName) => api.getInputPropertiesListPropertyItems(sourceName, propertyName),
    });

    clear(dialog.body);
    dialog.body.append(
      h('div.obs-hint.obs-muted', {
        text: `Property labels and ranges are not exposed by obs-websocket; keys are shown instead (${inputKind}).`,
      }),
      form.el
    );

    dialog.footer.append(
      dialogButtons([
        { label: 'Defaults', action: () => form.reset() },
        {
          label: 'Apply',
          action: async () => {
            try {
              await api.setInputSettings(sourceName, form.getSettings());
              dialog.close();
            } catch (err) {
              onStatus?.(err.message, 'error');
            }
          },
        },
        {
          label: 'OK',
          primary: true,
          action: async () => {
            try {
              await api.setInputSettings(sourceName, form.getSettings());
              dialog.close();
            } catch (err) {
              onStatus?.(err.message, 'error');
            }
          },
        },
        { label: 'Cancel', action: () => dialog.close() },
      ])
    );
  } catch (err) {
    clear(dialog.body);
    dialog.body.appendChild(h('div.obs-error', { text: err.message }));
    onStatus?.(err.message, 'error');
  }
}

/*! Keep the caret in the field the user was editing across a re-render. */
function focusProperty(container, name) {
  const row = container.querySelector(`[data-prop="${CSS.escape(name)}"]`);
  const field = row?.querySelector('input, select, textarea');
  if (!field) return;
  field.focus();
  if (typeof field.setSelectionRange === 'function' && typeof field.value === 'string') {
    const end = field.value.length;
    try {
      field.setSelectionRange(end, end);
    } catch {
      /* not a text field */
    }
  }
}

/* ------------------------------------------------------------------- filters */

export async function openFiltersDialog({ api, store, sourceName, onStatus }) {
  if (!sourceName) return;

  const dialog = openDialog({
    title: `Filters for '${sourceName}'`,
    width: 700,
    height: 520,
    closable: true,
  });

  const list = h('ul.obs-list.obs-filter-list', { role: 'listbox' });
  const formArea = h('div.obs-filter-settings.obs-scroll');
  let selectedFilter = null;
  let form = null;

  const layout = h('div.obs-filters-layout', {}, [
    h('div.obs-filters-left', {}, [
      list,
      h('div.obs-list-toolbar', {}, [
        iconButton('plus', { title: 'Add Filter', onClick: () => addFilter() }),
        iconButton('minus', {
          title: 'Remove Filter',
          onClick: () => removeFilter(),
        }),
        h('div.obs-toolbar-sep'),
        iconButton('up', { title: 'Move Filter Up', onClick: () => moveFilter(-1) }),
        iconButton('down', { title: 'Move Filter Down', onClick: () => moveFilter(1) }),
      ]),
    ]),
    h('div.obs-filters-right', {}, [h('div.obs-group-title', { text: 'Filter Settings' }), formArea]),
  ]);
  dialog.body.appendChild(layout);

  async function refresh() {
    const filters = await api.refreshFilters(sourceName);
    clear(list);
    for (const filter of filters) {
      const row = h('li.obs-list-item.obs-filter-item', {
        dataset: { filterName: filter.filterName },
        role: 'option',
      }, [
        h('input.obs-checkbox', {
          type: 'checkbox',
          checked: filter.filterEnabled,
          title: 'Toggle filter',
          on: {
            change: (event) => {
              event.stopPropagation();
              api
                .setSourceFilterEnabled(sourceName, filter.filterName, event.target.checked)
                .catch((err) => onStatus?.(err.message, 'error'));
            },
          },
        }),
        h('span.obs-list-label', { text: filter.filterName }),
      ]);
      row.addEventListener('click', (event) => {
        if (event.target.type === 'checkbox') return;
        selectFilter(filter.filterName);
      });
      if (filter.filterName === selectedFilter) row.classList.add('is-selected');
      list.appendChild(row);
    }
    if (!filters.length) list.appendChild(h('li.obs-empty', { text: 'No filters' }));
    if (selectedFilter && !filters.some((f) => f.filterName === selectedFilter)) selectedFilter = null;
    if (!selectedFilter && filters.length) selectedFilter = filters[0].filterName;
    if (selectedFilter) selectFilter(selectedFilter);
    else clear(formArea);
  }

  async function selectFilter(filterName) {
    selectedFilter = filterName;
    for (const row of list.children) {
      row.classList.toggle('is-selected', row.dataset.filterName === filterName);
    }
    const filters = selectors.filters(store.state, sourceName);
    const filter = filters.find((f) => f.filterName === filterName);
    if (!filter) return;

    clear(formArea);
    formArea.appendChild(h('div.obs-empty', { text: 'Loading...' }));

    /* Preferred: the WebMIX bridge gives us the real property schema. */
    const schema = await fetchFilterProperties(sourceName, filterName);
    if (schema) {
      let original = { ...schema.values };
      const container = h('div.obs-properties-schema');

      const applyLive = debounce(async (changed) => {
        if (changed.value === undefined) return;
        try {
          await api.setSourceFilterSettings(sourceName, filterName, { [changed.name]: changed.value }, true);
          const fresh = await fetchFilterProperties(sourceName, filterName);
          if (!fresh) return;
          const keep = form ? form.getSettings() : {};
          Object.assign(schema, fresh);
          original = { ...fresh.values, ...original, [changed.name]: changed.value };
          render({ ...keep, [changed.name]: changed.value }, changed.name);
        } catch (err) {
          onStatus?.(err.message, 'error');
        }
      }, 260);

      const render = (overrides = {}, focusName = null) => {
        form = renderPropertyForm(schema, {
          overrides,
          onChange: (changed) => applyLive(changed),
          onButton: async (property) => {
            const ok = await pressPropertyButton({
              scope: 'filter',
              name: sourceName,
              filter: filterName,
              property: property.name,
            });
            if (!ok) onStatus?.('The filter button could not be pressed', 'warning');
          },
        });
        container.replaceChildren(form.el);
        if (focusName) focusProperty(container, focusName);
      };

      clear(formArea);
      formArea.append(
        h('div.obs-hint.obs-muted', { text: `Filter kind: ${filter.filterKind}` }),
        container
      );
      render();
      return;
    }

    /* Fallback: values only (no labels/ranges), keyed by property name. */
    try {
      const defaults = await api.getSourceFilterDefaultSettings(filter.filterKind);
      form = buildPropertyForm({ current: filter.filterSettings ?? {}, defaults });
      clear(formArea);
      formArea.append(
        h('div.obs-hint.obs-muted', { text: `Filter kind: ${filter.filterKind}` }),
        form.el
      );
    } catch (err) {
      clear(formArea);
      formArea.appendChild(h('div.obs-error', { text: err.message }));
    }
  }

  async function addFilter() {
    try {
      const kinds = await api.getSourceFilterKindList();
      const kind = await pickFromList('Add Filter', 'Filter type', kinds);
      if (!kind) return;
      const name = await prompt({
        title: 'Add Filter',
        label: 'Filter name',
        value: kind,
        validate: (v) => (v ? null : 'A name is required.'),
      });
      if (!name) return;
      const defaults = await api.getSourceFilterDefaultSettings(kind).catch(() => ({}));
      await api.createSourceFilter(sourceName, name, kind, defaults);
      selectedFilter = name;
      await refresh();
    } catch (err) {
      onStatus?.(err.message, 'error');
    }
  }

  async function removeFilter() {
    if (!selectedFilter) return;
    const ok = await confirm({
      title: 'Remove Filter',
      text: `Remove filter "${selectedFilter}"?`,
      okLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeSourceFilter(sourceName, selectedFilter);
      selectedFilter = null;
      await refresh();
    } catch (err) {
      onStatus?.(err.message, 'error');
    }
  }

  function moveFilter(direction) {
    const filters = selectors.filters(store.state, sourceName);
    const index = filters.findIndex((f) => f.filterName === selectedFilter);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= filters.length) return;
    api
      .setSourceFilterIndex(sourceName, selectedFilter, next)
      .then(refresh)
      .catch((err) => onStatus?.(err.message, 'error'));
  }

  dialog.footer.append(
    dialogButtons([
      {
        label: 'Apply',
        action: async () => {
          if (!form || !selectedFilter) return;
          try {
            await api.setSourceFilterSettings(sourceName, selectedFilter, form.getSettings());
          } catch (err) {
            onStatus?.(err.message, 'error');
          }
        },
      },
      {
        label: 'Close',
        primary: true,
        action: async () => {
          if (form && selectedFilter) {
            try {
              await api.setSourceFilterSettings(sourceName, selectedFilter, form.getSettings());
            } catch { /* reported below */ }
          }
          dialog.close();
        },
      },
    ])
  );

  await refresh();
  return dialog;
}

/** Simple list picker used by "Add Filter" / "Add Transition". */
function pickFromList(title, label, values) {
  return new Promise((resolve) => {
    const list = h('ul.obs-list.obs-scroll', { style: { maxHeight: '260px' } });
    let selected = values[0] ?? null;
    for (const value of values) {
      const row = h('li.obs-list-item', { dataset: { value }, role: 'option' }, [
        h('span.obs-list-label', { text: value }),
      ]);
      if (value === selected) row.classList.add('is-selected');
      row.addEventListener('click', () => {
        selected = value;
        for (const other of list.children) other.classList.remove('is-selected');
        row.classList.add('is-selected');
      });
      list.appendChild(row);
    }
    const dialog = openDialog({
      title,
      width: 420,
      body: [h('label.obs-label', { text: label }), list],
      footer: dialogButtons([
        { label: 'Cancel', action: () => dialog.close() },
        { label: 'OK', primary: true, action: () => { resolve(selected); dialog.close(); } },
      ]),
      onClose: () => resolve(null),
    });
  });
}

/* ----------------------------------------------------------------- transform */

const ALIGNMENTS = [
  ['top-left', 0], ['top-center', 1], ['top-right', 2],
  ['center-left', 3], ['center', 4], ['center-right', 5],
  ['bottom-left', 6], ['bottom-center', 7], ['bottom-right', 8],
];

export async function openTransformDialog({ api, store, sceneName, sceneItemId, onStatus, onChanged }) {
  const scene = sceneName ?? selectors.previewPaneScene(store.state);
  if (!scene || !sceneItemId) {
    onStatus?.('Select a source first', 'warning');
    return;
  }

  let transform;
  try {
    transform = await api.getSceneItemTransform(scene, sceneItemId);
  } catch (err) {
    onStatus?.(err.message, 'error');
    return;
  }

  const num = (key, step = 1) =>
    h('input.obs-input.obs-property-number', {
      type: 'number',
      step: String(step),
      value: String(round(transform[key] ?? 0)),
      dataset: { field: key },
    });

  const fields = {
    positionX: num('positionX'),
    positionY: num('positionY'),
    rotation: num('rotation', 0.1),
    scaleX: h('input.obs-input.obs-property-number', {
      type: 'number',
      step: '0.1',
      value: String(round((transform.scaleX ?? 1) * 100, 2)),
      dataset: { field: 'scaleXPercent' },
    }),
    scaleY: h('input.obs-input.obs-property-number', {
      type: 'number',
      step: '0.1',
      value: String(round((transform.scaleY ?? 1) * 100, 2)),
      dataset: { field: 'scaleYPercent' },
    }),
    boundsWidth: num('boundsWidth'),
    boundsHeight: num('boundsHeight'),
    cropLeft: num('cropLeft'),
    cropTop: num('cropTop'),
    cropRight: num('cropRight'),
    cropBottom: num('cropBottom'),
  };

  const boundsType = h(
    'select.obs-select',
    {},
    [
      ['OBS_BOUNDS_NONE', 'No bounds'],
      ['OBS_BOUNDS_STRETCH', 'Stretch to bounds'],
      ['OBS_BOUNDS_SCALE_INNER', 'Scale to inner bounds'],
      ['OBS_BOUNDS_SCALE_OUTER', 'Scale to outer bounds'],
      ['OBS_BOUNDS_SCALE_TO_WIDTH', 'Scale to width of bounds'],
      ['OBS_BOUNDS_SCALE_TO_HEIGHT', 'Scale to height of bounds'],
      ['OBS_BOUNDS_MAX_ONLY', 'Maximum size only'],
    ].map(([value, text]) => h('option', { value, text }))
  );
  boundsType.value = transform.boundsType ?? 'OBS_BOUNDS_NONE';

  const alignmentGrid = h('div.obs-align-grid');
  let alignment = transform.alignment ?? 5;
  for (const [name, value] of ALIGNMENTS) {
    const button = h('button.obs-align-cell', {
      type: 'button',
      title: name,
      dataset: { alignment: String(value) },
      on: {
        click: () => {
          alignment = value;
          for (const cell of alignmentGrid.children) {
            cell.classList.toggle('is-selected', Number(cell.dataset.alignment) === value);
          }
        },
      },
    });
    if (value === alignment) button.classList.add('is-selected');
    alignmentGrid.appendChild(button);
  }

  const row = (label, ...controls) =>
    h('div.obs-property-row', {}, [h('label.obs-label.obs-property-label', { text: label }), ...controls]);

  const dialog = openDialog({
    title: 'Transform',
    width: 520,
    closable: true,
    body: [
      h('div.obs-transform-columns', {}, [
        h('div.obs-transform-col', {}, [
          h('div.obs-group-title', { text: 'Positional Alignment' }),
          alignmentGrid,
          row('Position X', fields.positionX),
          row('Position Y', fields.positionY),
          row('Rotation', fields.rotation),
        ]),
        h('div.obs-transform-col', {}, [
          h('div.obs-group-title', { text: 'Scale' }),
          row('Scale X (%)', fields.scaleX),
          row('Scale Y (%)', fields.scaleY),
          row('Bounding Box', boundsType),
          row('Width', fields.boundsWidth),
          row('Height', fields.boundsHeight),
        ]),
      ]),
      h('div.obs-group-title', { text: 'Crop' }),
      h('div.obs-transform-columns', {}, [
        h('div.obs-transform-col', {}, [row('Left', fields.cropLeft), row('Top', fields.cropTop)]),
        h('div.obs-transform-col', {}, [row('Right', fields.cropRight), row('Bottom', fields.cropBottom)]),
      ]),
    ],
  });

  const readValues = (overrides = {}) => {
    const value = (key, fallback) => {
      const input = Object.values(fields).find((f) => f.dataset.field === key);
      const numValue = input ? Number(input.value) : fallback;
      return Number.isFinite(numValue) ? numValue : fallback;
    };
    return {
      positionX: value('positionX', transform.positionX),
      positionY: value('positionY', transform.positionY),
      rotation: value('rotation', transform.rotation),
      scaleX: value('scaleXPercent', (transform.scaleX ?? 1) * 100) / 100,
      scaleY: value('scaleYPercent', (transform.scaleY ?? 1) * 100) / 100,
      boundsType: boundsType.value,
      boundsAlignment: alignment,
      boundsWidth: value('boundsWidth', transform.boundsWidth),
      boundsHeight: value('boundsHeight', transform.boundsHeight),
      cropLeft: value('cropLeft', transform.cropLeft),
      cropTop: value('cropTop', transform.cropTop),
      cropRight: value('cropRight', transform.cropRight),
      cropBottom: value('cropBottom', transform.cropBottom),
      ...overrides,
    };
  };

  const apply = async (overrides = {}) => {
    try {
      await api.setSceneItemTransform(scene, sceneItemId, readValues(overrides));
      transform = { ...transform, ...readValues(overrides) };
      onChanged?.();
    } catch (err) {
      onStatus?.(err.message, 'error');
    }
  };

  dialog.footer.append(
    dialogButtons([
      { label: 'Reset Transform', action: () => apply({ positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 }) },
      { label: 'Fit to Screen', action: () => apply({ boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: store.state.video?.baseWidth ?? 1920, boundsHeight: store.state.video?.baseHeight ?? 1080 }) },
      { label: 'Center', action: () => apply({ alignment: 0, positionX: (store.state.video?.baseWidth ?? 1920) / 2, positionY: (store.state.video?.baseHeight ?? 1080) / 2 }) },
      { label: 'Apply', action: () => apply() },
      { label: 'Close', primary: true, action: () => dialog.close() },
    ])
  );
}

const round = (value, digits = 3) => Number(Number(value).toFixed(digits));

/* --------------------------------------------------------------------- stats */

export async function openStatsDialog({ api, store }) {
  const dialog = openDialog({ title: 'Stats', width: 560, closable: true });

  const render = () => {
    // Shared with the Stats dock so both always show the same figures.
    const table = h('table.obs-table.obs-stats-table');
    for (const [label, value] of statsRows(store.state)) {
      table.appendChild(
        h('tr', {}, [h('th', { text: label }), h('td', { text: String(value) })])
      );
    }
    clear(dialog.body);
    dialog.body.appendChild(table);
  };

  render();
  dialog.footer.append(
    dialogButtons([
      { label: 'Refresh', action: async () => { await api.refreshStats(); render(); } },
      { label: 'Close', primary: true, action: () => dialog.close() },
    ])
  );

  const timer = setInterval(async () => {
    await api.refreshStats().catch(() => {});
    render();
  }, 2000);
  dialog.el.addEventListener('webmix:closed', () => clearInterval(timer));
  return dialog;
}

/* ---------------------------------------------------- advanced audio (table) */

export async function openAdvancedAudioDialog({ api, store, onStatus, onChanged }) {
  const dialog = openDialog({ title: 'Advanced Audio Properties', width: 900, height: 560, closable: true });
  const container = h('div.obs-adv-audio.obs-scroll');
  dialog.body.appendChild(container);

  const render = () => {
    clear(container);
    const table = h('table.obs-table.obs-adv-audio-table');
    table.appendChild(
      h('thead', {}, [
        h('tr', {}, [
          h('th', { text: 'Sources' }),
          h('th', { text: 'Volume (dB)' }),
          h('th', { text: 'Mute' }),
          h('th', { text: 'Monitor' }),
          h('th', { text: 'Balance' }),
          h('th', { text: 'Sync Offset (ms)' }),
          h('th', { text: 'Tracks' }),
        ]),
      ])
    );
    const tbody = h('tbody');
    const inputs = Object.values(store.state.inputs);
    for (const input of inputs) {
      const audio = store.state.audio[input.inputName] ?? {};
      const row = h('tr', { dataset: { inputName: input.inputName } });

      row.appendChild(h('td.obs-adv-name', { text: input.inputName }));

      const volume = h('input.obs-input.obs-adv-number', {
        type: 'number',
        step: '0.1',
        value: String(round(mulToDb(audio.volumeMul ?? 1), 1)),
      });
      volume.addEventListener('change', () => {
        const db = Number(volume.value);
        if (Number.isFinite(db)) {
          api.setInputVolume(input.inputName, dbToMul(db)).then(onChanged).catch((err) => onStatus?.(err.message, 'error'));
        }
      });
      row.appendChild(h('td', {}, [volume]));

      const mute = h('input.obs-checkbox', { type: 'checkbox', checked: !!audio.muted });
      mute.addEventListener('change', () => {
        api.setInputMute(input.inputName, mute.checked).then(onChanged).catch((err) => onStatus?.(err.message, 'error'));
      });
      row.appendChild(h('td', {}, [mute]));

      const monitor = h(
        'select.obs-select.obs-adv-monitor',
        {},
        [
          ['OBS_MONITORING_TYPE_NONE', 'Monitor Off'],
          ['OBS_MONITORING_TYPE_MONITOR_ONLY', 'Monitor Only'],
          ['OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT', 'Monitor and Output'],
        ].map(([value, text]) => h('option', { value, text }))
      );
      monitor.value = audio.monitorType ?? 'OBS_MONITORING_TYPE_NONE';
      monitor.addEventListener('change', () => {
        api.setInputAudioMonitorType(input.inputName, monitor.value).then(onChanged).catch((err) => onStatus?.(err.message, 'error'));
      });
      row.appendChild(h('td', {}, [monitor]));

      const balance = h('input.obs-range.obs-adv-balance', {
        type: 'range',
        min: '0',
        max: '1',
        step: '0.01',
        value: String(audio.balance ?? 0.5),
      });
      balance.addEventListener('change', () => {
        api.setInputAudioBalance(input.inputName, Number(balance.value)).then(onChanged).catch((err) => onStatus?.(err.message, 'error'));
      });
      row.appendChild(h('td', {}, [balance]));

      const sync = h('input.obs-input.obs-adv-number', {
        type: 'number',
        step: '1',
        value: String(Math.round(audio.syncOffset ?? 0)),
      });
      sync.addEventListener('change', () => {
        api.setInputAudioSyncOffset(input.inputName, Number(sync.value)).then(onChanged).catch((err) => onStatus?.(err.message, 'error'));
      });
      row.appendChild(h('td', {}, [sync]));

      const tracksCell = h('td.obs-adv-tracks');
      const tracks = audio.tracks ?? {};
      for (let i = 1; i <= 6; i++) {
        const box = h('input.obs-checkbox', { type: 'checkbox', checked: !!tracks[i], title: `Track ${i}` });
        box.addEventListener('change', () => {
          const next = { ...(store.state.audio[input.inputName]?.tracks ?? {}) };
          next[i] = box.checked;
          api.setInputAudioTracks(input.inputName, next).then(onChanged).catch((err) => onStatus?.(err.message, 'error'));
        });
        tracksCell.appendChild(box);
      }
      row.appendChild(tracksCell);

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    container.appendChild(table);
  };

  render();
  dialog.footer.append(dialogButtons([{ label: 'Close', primary: true, action: () => dialog.close() }]));
  return dialog;
}

/* ------------------------------------------------------------------ settings */

export async function openSettingsDialog({ api, store, onStatus, onSaved }) {
  const tabs = ['Stream', 'Output', 'Video', 'Audio', 'Advanced', 'Hotkeys'];
  let active = 'Stream';
  const body = h('div.obs-settings-body.obs-scroll');
  const tabStrip = h('div.obs-tabs');
  const dialog = openDialog({ title: 'Settings', width: 820, height: 620, closable: true });

  const renderTabs = () => {
    clear(tabStrip);
    for (const tab of tabs) {
      const button = h('button.obs-tab', {
        type: 'button',
        text: tab,
        on: { click: () => { active = tab; render(); } },
      });
      if (tab === active) button.classList.add('is-active');
      tabStrip.appendChild(button);
    }
  };

  async function render() {
    renderTabs();
    clear(body);
    body.appendChild(h('div.obs-empty', { text: 'Loading...' }));
    try {
      if (active === 'Video') await renderVideo();
      else if (active === 'Stream') await renderStream();
      else if (active === 'Output') await renderOutput();
      else if (active === 'Audio') await renderAudio();
      else if (active === 'Advanced') await renderAdvanced();
      else await renderHotkeys();
    } catch (err) {
      clear(body);
      body.appendChild(h('div.obs-error', { text: err.message }));
    }
  }

  const field = (label, control, hint = null) =>
    h('div.obs-property-row', {}, [
      h('label.obs-label.obs-property-label', { text: label }),
      control,
      hint ? h('div.obs-hint.obs-muted', { text: hint }) : null,
    ]);

  async function renderVideo() {
    const video = await api.getVideoSettings();
    const baseW = h('input.obs-input', { type: 'number', value: String(video.baseWidth), min: '1' });
    const baseH = h('input.obs-input', { type: 'number', value: String(video.baseHeight), min: '1' });
    const outW = h('input.obs-input', { type: 'number', value: String(video.outputWidth), min: '1' });
    const outH = h('input.obs-input', { type: 'number', value: String(video.outputHeight), min: '1' });
    const fpsNum = h('input.obs-input', { type: 'number', value: String(video.fpsNumerator), min: '1' });
    const fpsDen = h('input.obs-input', { type: 'number', value: String(video.fpsDenominator), min: '1' });

    clear(body);
    body.append(
      h('div.obs-group-title', { text: 'General' }),
      field('Base (Canvas) Resolution', h('div.obs-inline', {}, [baseW, 'x', baseH])),
      field('Output (Scaled) Resolution', h('div.obs-inline', {}, [outW, 'x', outH])),
      field('FPS Numerator', fpsNum),
      field('FPS Denominator', fpsDen, 'Common: 60/1, 30/1, 60000/1001'),
      h('div.obs-dialog-actions', {}, [
        h('button.obs-btn.primary', {
          type: 'button',
          text: 'Apply',
          on: {
            click: async () => {
              try {
                await api.setVideoSettings({
                  baseWidth: Number(baseW.value),
                  baseHeight: Number(baseH.value),
                  outputWidth: Number(outW.value),
                  outputHeight: Number(outH.value),
                  fpsNumerator: Number(fpsNum.value),
                  fpsDenominator: Number(fpsDen.value),
                });
                onStatus?.('Video settings saved', 'info');
                onSaved?.();
              } catch (err) {
                onStatus?.(err.message, 'error');
              }
            },
          },
        }),
      ])
    );
  }

  async function renderStream() {
    const data = await api.getStreamServiceSettings();
    const type = h(
      'select.obs-select',
      {},
      ['rtmp_common', 'rtmp_custom', 'whip_custom', 'srt_custom'].map((value) =>
        h('option', { value, text: value })
      )
    );
    type.value = data.streamServiceType ?? 'rtmp_common';
    const settings = { ...(data.streamServiceSettings ?? {}) };
    const server = h('input.obs-input', { type: 'text', value: settings.server ?? '' });
    const key = h('input.obs-input', { type: 'password', value: settings.key ?? '' });
    const service = h('input.obs-input', { type: 'text', value: settings.service ?? '' });

    clear(body);
    body.append(
      h('div.obs-group-title', { text: 'Service' }),
      field('Service Type', type),
      field('Service', service, 'For rtmp_common: e.g. Twitch, YouTube - RTMPS'),
      field('Server', server),
      field('Stream Key', key),
      h('div.obs-dialog-actions', {}, [
        h('button.obs-btn.primary', {
          type: 'button',
          text: 'Apply',
          on: {
            click: async () => {
              try {
                const next = { ...settings };
                if (service.value) next.service = service.value;
                else delete next.service;
                next.server = server.value;
                next.key = key.value;
                await api.setStreamServiceSettings(type.value, next);
                onStatus?.('Stream settings saved', 'info');
                onSaved?.();
              } catch (err) {
                onStatus?.(err.message, 'error');
              }
            },
          },
        }),
      ])
    );
  }

  async function renderOutput() {
    /* OBS's Simple output mode is stored in the active profile, so it can be
     * read and written over obs-websocket; the encoder choices come from the
     * bridge (localised names plus which ones this machine supports). */
    const encoderOptions = await fetchEncoderOptions();
    const param = async (category, name, fallback = '') => {
      try {
        const value = await api.getProfileParameter(category, name);
        return value === null || value === undefined || value === '' ? fallback : value;
      } catch {
        return fallback;
      }
    };

    const [
      mode,
      vbitrate,
      abitrate,
      streamEncoder,
      streamAudioEncoder,
      recEncoder,
      recAudioEncoder,
      recFormat,
      recQuality,
      recordDir,
      replayEnabled,
      replayTime,
      replaySize,
    ] = await Promise.all([
      param('Output', 'Mode', 'Simple'),
      param('SimpleOutput', 'VBitrate', '2500'),
      param('SimpleOutput', 'ABitrate', '160'),
      param('SimpleOutput', 'StreamEncoder', 'x264'),
      param('SimpleOutput', 'StreamAudioEncoder', 'ffmpeg_aac'),
      param('SimpleOutput', 'RecEncoder', 'x264'),
      param('SimpleOutput', 'RecAudioEncoder', 'ffmpeg_aac'),
      param('SimpleOutput', 'RecFormat2', 'mkv'),
      param('SimpleOutput', 'RecQuality', 'Stream'),
      api.getRecordDirectory().catch(() => ''),
      param('SimpleOutput', 'RecRB', 'false'),
      param('SimpleOutput', 'RecRBTime', '20'),
      param('SimpleOutput', 'RecRBSize', '512'),
    ]);

    const modeSelect = h(
      'select.obs-select',
      {},
      ['Simple', 'Advanced'].map((value) => h('option', { value, text: value }))
    );
    modeSelect.value = mode;

    const numberInput = (value, { min = '0', max = '1000000', step = '1' } = {}) =>
      h('input.obs-input.obs-property-number', { type: 'number', value: String(value), min, max, step });

    const vbitrateInput = numberInput(vbitrate, { min: '1', max: '100000' });
    const abitrateInput = numberInput(abitrate, { min: '1', max: '1024' });
    /* Two separate inputs: the same node cannot live in both groups (appending
     * it to the second would move it out of the first). */
    const dirInput = h('input.obs-input', { type: 'text', value: recordDir });
    const dirInputAdvanced = h('input.obs-input', { type: 'text', value: recordDir });

    const encoderSelect = (options, current, { allowUnavailable = false } = {}) => {
      const select = h('select.obs-select');
      const list = options ?? [];
      let found = false;
      for (const option of list) {
        if (!allowUnavailable && option.available === false) continue;
        const entry = h('option', { value: option.value, text: option.label });
        if (option.value === current) {
          entry.selected = true;
          found = true;
        }
        select.appendChild(entry);
      }
      // Keep the configured value visible even when unsupported on this machine.
      if (!found && current) select.appendChild(h('option', { value: current, text: `${current} (current)` }));
      return select;
    };

    const streamEncoderSelect = encoderOptions
      ? encoderSelect(encoderOptions.videoStreaming, streamEncoder)
      : h('input.obs-input', { type: 'text', value: streamEncoder });
    const recEncoderSelect = encoderOptions
      ? encoderSelect(encoderOptions.videoRecording, recEncoder)
      : h('input.obs-input', { type: 'text', value: recEncoder });
    const streamAudioSelect = encoderOptions
      ? encoderSelect(encoderOptions.audio, streamAudioEncoder)
      : h('input.obs-input', { type: 'text', value: streamAudioEncoder });
    const recAudioSelect = encoderOptions
      ? encoderSelect(encoderOptions.audio, recAudioEncoder)
      : h('input.obs-input', { type: 'text', value: recAudioEncoder });

    const formatSelect = h(
      'select.obs-select',
      {},
      (encoderOptions?.recordingFormats ?? [{ value: recFormat, label: recFormat }]).map((format) =>
        h('option', { value: format.value, text: format.label })
      )
    );
    formatSelect.value = recFormat;

    const qualitySelect = h(
      'select.obs-select',
      {},
      (encoderOptions?.recordingQualities ?? [{ value: recQuality, label: recQuality }]).map((quality) =>
        h('option', { value: quality.value, text: quality.label })
      )
    );
    qualitySelect.value = recQuality;

    const replayBox = h('input.obs-checkbox', { type: 'checkbox', checked: String(replayEnabled) === 'true' });
    const replayTimeInput = numberInput(replayTime, { min: '1', max: '3600' });
    const replaySizeInput = numberInput(replaySize, { min: '1', max: '1048576' });

    const simpleGroup = h('div.obs-settings-group', {}, [
      h('div.obs-group-title', { text: 'Streaming' }),
      field('Video Encoder', streamEncoderSelect),
      field('Video Bitrate (Kbps)', vbitrateInput),
      field('Audio Encoder', streamAudioSelect),
      field('Audio Bitrate (Kbps)', abitrateInput),
      h('div.obs-group-title', { text: 'Recording' }),
      field('Recording Path', dirInput),
      field('Recording Format', formatSelect, 'MKV is the safest container: a crash cannot corrupt it.'),
      field('Recording Quality', qualitySelect),
      field('Video Encoder', recEncoderSelect),
      field('Audio Encoder', recAudioSelect),
      h('div.obs-group-title', { text: 'Replay Buffer' }),
      field('Enable Replay Buffer', replayBox),
      field('Maximum Replay Time (s)', replayTimeInput),
      field('Maximum Replay Memory (MB)', replaySizeInput),
    ]);
    simpleGroup.hidden = modeSelect.value !== 'Simple';

    const advancedGroup = h('div.obs-settings-group', {}, [
      h('div.obs-hint.obs-muted', {
        text:
          'In Advanced mode each output and its encoder have their own settings, stored per-encoder in the ' +
          'profile. The active profile can be edited here with Get/SetProfileParameter, but the per-encoder ' +
          'pages are not exposed by obs-websocket yet.',
      }),
      field('Recording Path', dirInputAdvanced),
    ]);
    advancedGroup.hidden = modeSelect.value !== 'Advanced';

    modeSelect.addEventListener('change', () => {
      simpleGroup.hidden = modeSelect.value !== 'Simple';
      advancedGroup.hidden = modeSelect.value !== 'Advanced';
    });

    clear(body);
    body.append(
      h('div.obs-group-title', { text: 'Output' }),
      field('Output Mode', modeSelect),
      simpleGroup,
      advancedGroup,
      h('div.obs-dialog-actions', {}, [
        h('button.obs-btn.primary', {
          type: 'button',
          text: 'Apply',
          on: {
            click: async () => {
              const numeric = (el, fallback) => {
                const value = Number(el.value);
                return Number.isFinite(value) ? String(Math.round(value)) : fallback;
              };
              try {
                await api.setProfileParameter('Output', 'Mode', modeSelect.value);
                await api.setProfileParameter('SimpleOutput', 'VBitrate', numeric(vbitrateInput, '2500'));
                await api.setProfileParameter('SimpleOutput', 'ABitrate', numeric(abitrateInput, '160'));
                await api.setProfileParameter('SimpleOutput', 'StreamEncoder', streamEncoderSelect.value);
                await api.setProfileParameter('SimpleOutput', 'StreamAudioEncoder', streamAudioSelect.value);
                await api.setProfileParameter('SimpleOutput', 'RecEncoder', recEncoderSelect.value);
                await api.setProfileParameter('SimpleOutput', 'RecAudioEncoder', recAudioSelect.value);
                await api.setProfileParameter('SimpleOutput', 'RecFormat2', formatSelect.value);
                await api.setProfileParameter('SimpleOutput', 'RecQuality', qualitySelect.value);
                await api.setProfileParameter('SimpleOutput', 'RecRB', replayBox.checked ? 'true' : 'false');
                await api.setProfileParameter('SimpleOutput', 'RecRBTime', numeric(replayTimeInput, '20'));
                await api.setProfileParameter('SimpleOutput', 'RecRBSize', numeric(replaySizeInput, '512'));
                await api.setRecordDirectory(dirInput.value);
                onStatus?.('Output settings saved', 'info');
                onSaved?.();
              } catch (err) {
                onStatus?.(err.message, 'error');
              }
            },
          },
        }),
      ])
    );
  }

  async function renderAudio() {
    const sampleRate = (await api.getProfileParameter('Audio', 'SampleRate').catch(() => null)) ?? '48000';
    const channelSetup = (await api.getProfileParameter('Audio', 'ChannelSetup').catch(() => null)) ?? 'Stereo';
    const rate = h(
      'select.obs-select',
      {},
      ['44100', '48000'].map((value) => h('option', { value, text: value }))
    );
    rate.value = sampleRate;
    const channels = h(
      'select.obs-select',
      {},
      ['Mono', 'Stereo', '2.1', '4.0', '4.1', '5.1', '7.1'].map((value) =>
        h('option', { value, text: value })
      )
    );
    channels.value = channelSetup;

    clear(body);
    body.append(
      h('div.obs-group-title', { text: 'Audio' }),
      field('Sample Rate', rate),
      field('Channels', channels),
      h('div.obs-hint.obs-muted', {
        text: 'Global audio devices are stored per scene collection and are not exposed by obs-websocket.',
      }),
      h('div.obs-dialog-actions', {}, [
        h('button.obs-btn.primary', {
          type: 'button',
          text: 'Apply',
          on: {
            click: async () => {
              try {
                await api.setProfileParameter('Audio', 'SampleRate', rate.value);
                await api.setProfileParameter('Audio', 'ChannelSetup', channels.value);
                onStatus?.('Audio settings saved (restart OBS to apply)', 'info');
                onSaved?.();
              } catch (err) {
                onStatus?.(err.message, 'error');
              }
            },
          },
        }),
      ])
    );
  }

  async function renderAdvanced() {
    const priority = (await api.getProfileParameter('General', 'ProcessPriority').catch(() => null)) ?? 'Normal';
    const dir = await api.getRecordDirectory().catch(() => '');
    const select = h(
      'select.obs-select',
      {},
      ['High', 'Above Normal', 'Normal', 'Below Normal', 'Idle'].map((value) =>
        h('option', { value, text: value })
      )
    );
    select.value = priority;

    clear(body);
    body.append(
      h('div.obs-group-title', { text: 'Advanced' }),
      field('Process Priority', select),
      field('Recording Path', h('div.obs-inline', {}, [h('span.obs-muted', { text: dir })])),
      h('div.obs-hint.obs-muted', {
        text: 'Many advanced options live in global.ini and are not exposed by obs-websocket.',
      }),
      h('div.obs-dialog-actions', {}, [
        h('button.obs-btn.primary', {
          type: 'button',
          text: 'Apply',
          on: {
            click: async () => {
              try {
                await api.setProfileParameter('General', 'ProcessPriority', select.value);
                onStatus?.('Advanced settings saved', 'info');
                onSaved?.();
              } catch (err) {
                onStatus?.(err.message, 'error');
              }
            },
          },
        }),
      ])
    );
  }

  async function renderHotkeys() {
    // Prefer the bridge: it reports the bindings OBS itself has, which
    // obs-websocket cannot. Without it, fall back to names only.
    const obsHotkeys = await fetchHotkeys();
    let entries = obsHotkeys;
    if (!entries) {
      let names = store.state.hotkeys;
      if (!names?.length) {
        const data = await api.request('GetHotkeyList');
        names = data.hotkeys ?? [];
        store.state.hotkeys = names;
      }
      entries = names.map((name) => ({ name, description: '', bindings: null }));
    }

    let browserBindings = loadBindings();

    const persistBrowser = () => {
      saveBindings(browserBindings);
      window.dispatchEvent(new CustomEvent('webmix:hotkeys-changed'));
    };

    clear(body);
    body.append(
      h('div.obs-hint.obs-muted', {
        text: obsHotkeys
          ? 'Bindings can be changed in OBS itself through the WebMIX bridge. Browser shortcuts are captured by ' +
            'this page and sent as hotkey triggers, which is what works while OBS runs headless - with no window ' +
            'of its own it never receives key presses.'
          : 'obs-websocket cannot rebind hotkeys. The browser shortcuts below are captured by this page and sent ' +
            'to OBS as TriggerHotkeyByName.',
      })
    );

    const table = h('table.obs-table.obs-hotkey-table');
    table.appendChild(
      h('thead', {}, [
        h('tr', {}, [
          h('th', { text: 'Hotkey' }),
          h('th', { text: 'In OBS' }),
          h('th', { text: 'Browser' }),
          h('th', { text: '' }),
        ]),
      ])
    );
    const tbody = h('tbody');

    for (const entry of entries) {
      const nameCell = h('th.obs-hotkey-name', {}, [
        h('div', { text: entry.name }),
        entry.description ? h('div.obs-muted.obs-hotkey-description', { text: entry.description }) : null,
      ]);

      const obsCell = h('td.obs-hotkey-combo', {
        text: entry.bindings ? entry.bindings.join(', ') || '\u2014' : 'n/a',
      });
      if (entry.bindings) {
        const bindButton = h('button.obs-btn.flat', {
          type: 'button',
          text: 'Bind',
          title: 'Press a key combination to bind it in OBS',
          on: {
            click: () => {
              bindButton.textContent = 'Press a key...';
              bindButton.classList.add('is-active');
              captureObsKey(async (binding) => {
                bindButton.textContent = 'Bind';
                bindButton.classList.remove('is-active');
                if (!binding) return;
                const result = await bindHotkey(entry.name, binding.keyName, binding.modifiers);
                if (result?.ok) {
                  onStatus?.(`${entry.name} bound to ${describeCombo(binding)}`, 'success');
                  renderHotkeys();
                } else {
                  onStatus?.(result?.error ?? 'Could not bind the hotkey', 'warning');
                }
              });
            },
          },
        });
        const unbind = h('button.obs-btn.flat', {
          type: 'button',
          text: 'Clear',
          disabled: !(entry.bindings ?? []).length,
          on: {
            click: async () => {
              const result = await clearHotkey(entry.name);
              if (result?.ok) renderHotkeys();
              else onStatus?.(result?.error ?? 'Could not clear the hotkey', 'warning');
            },
          },
        });
        obsCell.append(h('div.obs-hotkey-actions', {}, [bindButton, unbind]));
      }

      const browserCell = h('td.obs-hotkey-combo', {
        text: browserBindings[entry.name] ? normalizeCombo(browserBindings[entry.name]) : '\u2014',
      });
      const browserBind = h('button.obs-btn.flat', {
        type: 'button',
        text: 'Bind',
        on: {
          click: () => {
            browserBind.textContent = 'Press a key...';
            browserBind.classList.add('is-active');
            captureCombo((combo) => {
              browserBind.textContent = 'Bind';
              browserBind.classList.remove('is-active');
              if (!combo) return;
              for (const [other, bound] of Object.entries(browserBindings)) {
                if (normalizeCombo(bound) === combo) delete browserBindings[other];
              }
              browserBindings[entry.name] = combo;
              persistBrowser();
              renderHotkeys();
            });
          },
        },
      });
      const browserClear = h('button.obs-btn.flat', {
        type: 'button',
        text: 'Clear',
        disabled: !browserBindings[entry.name],
        on: {
          click: () => {
            delete browserBindings[entry.name];
            persistBrowser();
            renderHotkeys();
          },
        },
      });
      browserCell.append(h('div.obs-hotkey-actions', {}, [browserBind, browserClear]));

      const triggerCell = h('td', {}, [
        h('button.obs-btn.flat', {
          type: 'button',
          text: 'Trigger',
          on: {
            click: async () => {
              try {
                await api.triggerHotkeyByName(entry.name);
              } catch (err) {
                onStatus?.(err.message, 'error');
              }
            },
          },
        }),
      ]);

      tbody.appendChild(h('tr', {}, [nameCell, obsCell, browserCell, triggerCell]));
    }
    table.appendChild(tbody);
    body.appendChild(table);
    return table;
  }

  dialog.body.append(tabStrip, body);
  await render();
  dialog.footer.append(dialogButtons([{ label: 'Close', primary: true, action: () => dialog.close() }]));
  return dialog;
}

/* --------------------------------------------------------------------- about */

/* obs-websocket reports the OBS version as `obsVersion`; older/other builds
 * may use `obsStudioVersion`. Accept either so the About dialog never lies. */
const obsVersion = (version) => version?.obsVersion ?? version?.obsStudioVersion ?? '-';

export function openAboutDialog({ store, onStatus }) {
  const state = store.state;
  const version = state.version ?? {};
  const dialog = openDialog({
    title: 'About WebMIX',
    width: 520,
    closable: true,
    body: [
      h('div.obs-about-title', { text: 'WebMIX' }),
      h('div.obs-about-subtitle', { text: 'A web frontend for OBS Studio' }),
      h('table.obs-table', {}, [
        h('tr', {}, [h('th', { text: 'OBS Studio' }), h('td', { text: obsVersion(version) })]),
        h('tr', {}, [h('th', { text: 'obs-websocket' }), h('td', { text: version.obsWebSocketVersion ?? state.connection.obsWebSocketVersion ?? '-' })]),
        h('tr', {}, [h('th', { text: 'RPC Version' }), h('td', { text: String(version.rpcVersion ?? state.connection.rpcVersion ?? '-') })]),
        h('tr', {}, [h('th', { text: 'Platform' }), h('td', { text: version.platformDescription ?? version.platform ?? '-' })]),
        h('tr', {}, [h('th', { text: 'Connected to' }), h('td', { text: state.connection.url || '-' })]),
      ]),
    ],
    footer: dialogButtons([{ label: 'Close', primary: true, action: () => dialog.close() }]),
  });
  return dialog;
}
