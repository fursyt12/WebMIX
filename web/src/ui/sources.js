/*
 * WebMIX - Sources dock.
 *
 * Reproduces OBS's Sources panel for the active scene: per-item visibility and
 * lock toggles, source icon, name, F2 rename, drag-free reordering through
 * Move Up / Move Down (sceneItemIndex 0 is the TOP of the list, matching
 * obs-websocket), the Add Source dialog and the source context menu.
 */
import { h, reconcile, setText, setClass, clear, qs } from '../dom.js';
import { iconButton, icon } from './icons.js';
import { showContextMenu, prompt, confirm, openDialog, dialogButtons } from './dialog.js';
import { Topic, selectors } from '../store.js';

const SOURCE_ICON_BY_KIND = [
  [/browser/, 'list'],
  [/image|slideshow/, 'camera'],
  [/text|freetype/, 'properties'],
  [/monitor_capture|screen_capture|display_capture|window_capture|game_capture|v4l2|av_capture/, 'camera'],
  [/ffmpeg|media|vlc/, 'play'],
  [/audio|wasapi|pulse|alsa|coreaudio|jack|mic/, 'mic'],
  [/color|colour/, 'grid'],
];

const iconForKind = (kind) => SOURCE_ICON_BY_KIND.find(([re]) => re.test(kind ?? ''))?.[1] ?? 'folder';

export class SourcesPanel {
  constructor({ store, api, onStatus, onSelectSource }) {
    this.store = store;
    this.api = api;
    this.onStatus = onStatus;
    this.onSelectSource = onSelectSource;
    this.selected = null;
    this.renaming = null;

    this.list = h('ul.obs-list.obs-source-list', {
      role: 'listbox',
      tabindex: '0',
      'aria-label': 'Sources',
    });

    this.toolbar = h('div.obs-list-toolbar', { role: 'toolbar' }, [
      iconButton('plus', { title: 'Add Source', onClick: () => this.addSource() }),
      iconButton('minus', { title: 'Remove Source', onClick: () => this.removeSource() }),
      h('div.obs-toolbar-sep'),
      iconButton('properties', { title: 'Source Properties', onClick: () => this.openProperties() }),
      h('div.obs-toolbar-sep'),
      iconButton('up', { title: 'Move Source Up', onClick: () => this.move(-1) }),
      iconButton('down', { title: 'Move Source Down', onClick: () => this.move(1) }),
    ]);

    this.el = h('div.obs-panel.obs-sources-panel', {}, [this.list, this.toolbar]);
    this.#wire();
  }

  #wire() {
    this.list.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-toggle]');
      const row = event.target.closest('[data-source-name]');
      if (!row) return;
      const { sourceName: name, sceneItemId } = row.dataset;
      const item = this.#item(name);
      if (!item) return;

      if (toggle?.dataset.toggle === 'visible') {
        event.stopPropagation();
        this.api
          .setSceneItemEnabled(this.#sceneName(), Number(sceneItemId), !item.sceneItemEnabled)
          .catch((err) => this.onStatus?.(err.message, 'error'));
        return;
      }
      if (toggle?.dataset.toggle === 'lock') {
        event.stopPropagation();
        this.api
          .setSceneItemLocked(this.#sceneName(), Number(sceneItemId), !item.sceneItemLocked)
          .catch((err) => this.onStatus?.(err.message, 'error'));
        return;
      }
      this.selected = name;
      this.onSelectSource?.(name, item);
      this.store.notify(Topic.SceneItems);
    });

    this.list.addEventListener('keydown', (event) => {
      if (event.key === 'F2' && this.selected) {
        event.preventDefault();
        this.startRename(this.selected);
      } else if (event.key === 'Delete' && this.selected) {
        event.preventDefault();
        this.removeSource();
      }
    });

    /* Double-clicking a source opens its properties, exactly like the desktop
     * UI's source list - for a capture source that is where the monitor or
     * window is chosen, so it is the shortcut people reach for first. */
    this.list.addEventListener('dblclick', (event) => {
      const row = event.target.closest('[data-source-name]');
      if (!row) return;
      this.selected = row.dataset.sourceName;
      this.onSelectSource?.(this.selected, this.#item(this.selected));
      this.openProperties();
    });

    this.list.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const row = event.target.closest('[data-source-name]');
      if (row) {
        this.selected = row.dataset.sourceName;
        this.onSelectSource?.(this.selected, this.#item(this.selected));
      }
      this.openContextMenu(event.clientX, event.clientY);
    });
  }

  #sceneName() {
    return selectors.previewPaneScene(this.store.state);
  }

  #item(name) {
    return selectors.sceneItems(this.store.state, this.#sceneName()).find((i) => i.sourceName === name) ?? null;
  }

  #selectedItem() {
    return this.selected ? this.#item(this.selected) : null;
  }

  async addSource() {
    const sceneName = this.#sceneName();
    if (!sceneName) {
      this.onStatus?.('Select a scene first', 'warning');
      return;
    }
    try {
      const kinds = await this.api.getInputKindList();
      const existing = selectors.inputs(this.store.state).map((i) => i.inputName);
      const result = await this.#addSourceDialog(kinds, existing, sceneName);
      if (!result) return;
      if (result.mode === 'existing') {
        await this.api.createSceneItem(sceneName, result.inputName);
      } else {
        const defaults = await this.api.getInputDefaultSettings(result.inputKind).catch(() => ({}));
        await this.api.createInput(sceneName, result.inputName, result.inputKind, defaults);
      }
      this.selected = result.inputName;
      this.onSelectSource?.(result.inputName, this.#item(result.inputName));
      this.store.notify(Topic.SceneItems, Topic.Inputs);
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  /** OBS "Add Source" dialog: pick a type (or an existing source) and a name. */
  #addSourceDialog(kinds, existingInputs, sceneName) {
    return new Promise((resolve) => {
      const kindList = h('ul.obs-list.obs-source-kind-list', { role: 'listbox' });
      const existingList = h('ul.obs-list.obs-source-existing-list', { role: 'listbox', hidden: true });
      const nameInput = h('input.obs-input', { type: 'text', style: { width: '100%' } });
      const nameRow = h('div.obs-field-row', {}, [h('label.obs-label', { text: 'Source name' }), nameInput]);
      const createRadio = h('input.obs-radio', { type: 'radio', name: 'add-mode', checked: true });
      const existingRadio = h('input.obs-radio', { type: 'radio', name: 'add-mode' });
      const modeRow = h('div.obs-radio-row', {}, [
        h('label.obs-radio-label', {}, [createRadio, 'Create new']),
        h('label.obs-radio-label', {}, [existingRadio, 'Add Existing']),
      ]);

      let selectedKind = kinds[0]?.kind ?? null;
      let selectedExisting = null;

      /* OBS names a new source after its type ("Display Capture"), and appends
       * a number when that name is taken. */
      const uniqueName = (base) => {
        if (!existingInputs.includes(base)) return base;
        for (let i = 2; ; i++) {
          const candidate = `${base} ${i}`;
          if (!existingInputs.includes(candidate)) return candidate;
        }
      };

      const renderKinds = () => {
        clear(kindList);
        for (const entry of kinds) {
          const row = h(
            'li.obs-list-item',
            { dataset: { kind: entry.kind }, role: 'option', title: entry.kind },
            [icon(iconForKind(entry.kind)), h('span.obs-list-label', { text: entry.name })]
          );
          if (entry.kind === selectedKind) row.classList.add('is-selected');
          row.addEventListener('click', () => {
            selectedKind = entry.kind;
            nameInput.value = uniqueName(entry.name);
            for (const other of kindList.children) other.classList.remove('is-selected');
            row.classList.add('is-selected');
          });
          kindList.appendChild(row);
        }
      };
      renderKinds();
      nameInput.value = kinds.length ? uniqueName(kinds[0].name) : '';

      const renderExisting = () => {
        clear(existingList);
        if (!existingInputs.length) {
          existingList.appendChild(h('li.obs-list-item.obs-muted', { text: 'No existing sources' }));
        }
        for (const name of existingInputs) {
          const row = h('li.obs-list-item', { dataset: { name }, role: 'option' }, [
            h('span.obs-list-label', { text: name }),
          ]);
          if (name === selectedExisting) row.classList.add('is-selected');
          row.addEventListener('click', () => {
            selectedExisting = name;
            for (const other of existingList.children) other.classList.remove('is-selected');
            row.classList.add('is-selected');
          });
          existingList.appendChild(row);
        }
      };

      const syncMode = () => {
        const useExisting = existingRadio.checked;
        kindList.hidden = useExisting;
        existingList.hidden = !useExisting;
        nameRow.hidden = useExisting;
      };
      createRadio.addEventListener('change', syncMode);
      existingRadio.addEventListener('change', syncMode);

      const dialog = openDialog({
        title: 'Add Source',
        width: 560,
        height: 460,
        body: [
          modeRow,
          h('div.obs-source-add-columns', {}, [
            h('div.obs-source-add-left', {}, [kindList, existingList]),
            h('div.obs-source-add-right', {}, [
              nameRow,
              h('div.obs-hint.obs-muted', { text: `Adds the source to "${sceneName}".` }),
            ]),
          ]),
        ],
        footer: dialogButtons([
          { label: 'Cancel', action: () => dialog.close() },
          {
            label: 'Create New',
            primary: true,
            action: () => {
              if (existingRadio.checked) {
                if (!selectedExisting) {
                  this.onStatus?.('Select a source to add', 'warning');
                  return;
                }
                // Resolve first: closing the dialog runs its onClose, which
                // resolves null and would win over this value.
                resolve({ mode: 'existing', inputName: selectedExisting });
                dialog.close();
              } else {
                const name = nameInput.value.trim();
                if (!name || !selectedKind) {
                  this.onStatus?.('Choose a source type and a name', 'warning');
                  return;
                }
                resolve({ mode: 'new', inputName: name, inputKind: selectedKind });
                dialog.close();
              }
            },
          },
        ]),
        onClose: () => resolve(null),
      });
      // Existing-source tab needs the list rendered lazily.
      existingRadio.addEventListener('change', renderExisting, { once: true });
      setTimeout(() => nameInput.focus(), 0);
    });
  }

  async removeSource() {
    const name = this.selected;
    const item = this.#selectedItem();
    if (!name || !item) return;
    const sceneName = this.#sceneName();
    const others = selectors
      .sceneItems(this.store.state, sceneName)
      .filter((i) => i.sourceName !== name);
    const stillUsed = Object.entries(this.store.state.sceneItems).some(([scene, items]) =>
      scene !== sceneName && items.some((i) => i.sourceName === name)
    );

    const choice = await this.#removeDialog(name, stillUsed);
    if (!choice) return;
    try {
      await this.api.removeSceneItem(sceneName, item.sceneItemId);
      if (choice === 'delete') {
        await this.api.removeInput(name);
      }
      this.selected = others[0]?.sourceName ?? null;
      this.store.notify(Topic.SceneItems, Topic.Inputs);
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  #removeDialog(name, stillUsed) {
    return new Promise((resolve) => {
      let result = null;
      const dialog = openDialog({
        title: 'Remove Source',
        width: 460,
        body: h('div.obs-message-text', {
          text: stillUsed
            ? `"${name}" is used by other scenes. Remove it from this scene, or delete it everywhere?`
            : `Remove "${name}" from the scene, or delete the source entirely?`,
        }),
        footer: dialogButtons([
          { label: 'Cancel', action: () => dialog.close() },
          { label: 'Remove from Scene', action: () => { result = 'remove'; dialog.close(); } },
          { label: 'Delete Source', danger: true, action: () => { result = 'delete'; dialog.close(); } },
        ]),
        onClose: () => resolve(result),
      });
    });
  }

  move(direction) {
    const sceneName = this.#sceneName();
    const item = this.#selectedItem();
    if (!sceneName || !item) return;
    const items = selectors.sceneItems(this.store.state, sceneName);
    const index = items.findIndex((i) => i.sceneItemId === item.sceneItemId);
    const next = index + direction;
    if (next < 0 || next >= items.length) return;
    this.api
      .setSceneItemIndex(sceneName, item.sceneItemId, next)
      .catch((err) => this.onStatus?.(err.message, 'error'));
  }

  openFilters() {
    if (!this.selected) return;
    this.el.dispatchEvent(
      new CustomEvent('webmix:open-filters', { bubbles: true, detail: { sourceName: this.selected } })
    );
  }

  openProperties() {
    if (!this.selected) return;
    this.el.dispatchEvent(
      new CustomEvent('webmix:open-properties', { bubbles: true, detail: { sourceName: this.selected } })
    );
  }

  async interact() {
    const name = this.selected;
    if (!name) return;
    try {
      const { inputSettings } = await this.api.getInputSettings(name);
      if (inputSettings?.url) {
        window.open(inputSettings.url, '_blank', 'noopener');
        return;
      }
      if (inputSettings?.local_file) {
        this.onStatus?.(`Interact is only available in the OBS desktop UI for "${name}"`, 'warning');
        return;
      }
      await this.api.openInputInteractDialog(name);
      this.onStatus?.('Interact window opened on the OBS host', 'info');
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  async startRename(name) {
    const row = this.list.querySelector(`[data-source-name="${CSS.escape(name)}"]`);
    const label = row?.querySelector('.obs-list-label');
    if (!label) return;
    this.renaming = name;
    const input = h('input.obs-input.obs-inline-edit', { type: 'text', value: name });
    label.replaceWith(input);
    input.focus();
    input.select();

    const finish = async (commit) => {
      this.renaming = null;
      const value = input.value.trim();
      input.replaceWith(label);
      if (!commit || !value || value === name) return;
      try {
        await this.api.renameInput(name, value);
        if (this.selected === name) this.selected = value;
      } catch (err) {
        this.onStatus?.(err.message, 'error');
      }
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  openContextMenu(x, y) {
    const name = this.selected;
    const item = this.#selectedItem();
    const sceneName = this.#sceneName();
    const items = selectors.sceneItems(this.store.state, sceneName);
    const index = item ? items.findIndex((i) => i.sceneItemId === item.sceneItemId) : -1;
    showContextMenu({ x, y }, [
      { label: 'Add Source', action: () => this.addSource() },
      { label: 'Group Selected Items', disabled: true },
      { label: 'Ungroup', disabled: true },
      { separator: true },
      { label: 'Copy', disabled: !name, action: () => this.copySource(name) },
      { label: 'Paste (Reference)', disabled: true },
      { label: 'Paste (Duplicate)', disabled: true },
      { separator: true },
      { label: 'Hide in Mixer', disabled: !name, action: () => this.hideInMixer(name) },
      { label: 'Rename...', disabled: !name, shortcut: 'F2', action: () => this.startRename(name) },
      { label: 'Remove', disabled: !name, shortcut: 'Del', action: () => this.removeSource() },
      { separator: true },
      { label: 'Move Up', disabled: index <= 0, action: () => this.move(-1) },
      { label: 'Move Down', disabled: index < 0 || index >= items.length - 1, action: () => this.move(1) },
      { separator: true },
      { label: 'Interact', disabled: !name, action: () => this.interact() },
      { label: 'Filters', disabled: !name, action: () => this.openFilters() },
      { label: 'Properties', disabled: !name, action: () => this.openProperties() },
      { separator: true },
      { label: 'Screenshot Source', disabled: !name, action: () => this.screenshot(name) },
      { label: 'Duplicate', disabled: !item, action: () => this.duplicate(item) },
    ]);
  }

  async copySource(name) {
    try {
      const { inputSettings } = await this.api.getInputSettings(name);
      await navigator.clipboard?.writeText(JSON.stringify({ name, settings: inputSettings }));
      this.onStatus?.(`Copied settings of "${name}"`, 'info');
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  async hideInMixer(name) {
    // OBS stores this as a frontend/private setting; obs-websocket cannot set it.
    this.onStatus?.(`Hiding "${name}" in the mixer is not exposed by obs-websocket`, 'warning');
  }

  async duplicate(item) {
    const sceneName = this.#sceneName();
    if (!item) return;
    try {
      await this.api.duplicateSceneItem(sceneName, item.sceneItemId);
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  async screenshot(name) {
    try {
      const data = await this.api.getSourceScreenshot(name, { format: 'png', quality: 100 });
      const link = document.createElement('a');
      link.href = data;
      link.download = `${name}.png`;
      link.click();
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  update(state) {
    const sceneName = selectors.previewPaneScene(state);
    const items = selectors.sceneItems(state, sceneName);
    if (this.selected && !items.some((i) => i.sourceName === this.selected)) this.selected = null;

    reconcile(
      this.list,
      items,
      (item) => String(item.sceneItemId),
      (item) => this.#createRow(item),
      (node, item) => this.#updateRow(node, item, state)
    );

    if (!items.length) {
      clear(this.list);
      this.list.appendChild(
        h('li.obs-empty', { text: sceneName ? 'No sources in this scene' : 'No scene selected' })
      );
    }
  }

  #createRow(item) {
    const row = h('li.obs-list-item.obs-source-item', {
      dataset: { sourceName: item.sourceName, sceneItemId: String(item.sceneItemId) },
      role: 'option',
      tabindex: '-1',
    });
    row.append(
      h('button.obs-icon-btn.obs-source-toggle', {
        type: 'button',
        dataset: { toggle: 'visible' },
        title: 'Toggle visibility',
      }),
      h('button.obs-icon-btn.obs-source-toggle', {
        type: 'button',
        dataset: { toggle: 'lock' },
        title: 'Lock sources',
      }),
      h('span.obs-source-icon'),
      h('span.obs-list-label', { text: item.sourceName })
    );
    return row;
  }

  #updateRow(row, item, state) {
    setText(row.querySelector('.obs-list-label'), item.sourceName);
    row.dataset.sourceName = item.sourceName;
    row.dataset.sceneItemId = String(item.sceneItemId);
    setClass(row, 'is-selected', this.selected === item.sourceName);
    setClass(row, 'is-hidden', !item.sceneItemEnabled);
    setClass(row, 'is-locked', !!item.sceneItemLocked);
    row.setAttribute('aria-selected', String(this.selected === item.sourceName));

    const visibleBtn = row.querySelector('[data-toggle="visible"]');
    clear(visibleBtn);
    visibleBtn.appendChild(icon(item.sceneItemEnabled ? 'eye' : 'eyeOff', 14));
    visibleBtn.title = 'Toggle visibility';

    const lockBtn = row.querySelector('[data-toggle="lock"]');
    clear(lockBtn);
    lockBtn.appendChild(icon(item.sceneItemLocked ? 'lock' : 'unlock', 14));
    lockBtn.title = 'Lock sources';

    const iconEl = row.querySelector('.obs-source-icon');
    const kind = state.inputs[item.sourceName]?.inputKind;
    clear(iconEl);
    iconEl.appendChild(icon(iconForKind(kind), 16));
  }

  /** Select a source by name (used by the source toolbar / mixer). */
  select(name) {
    this.selected = name;
    this.store.notify(Topic.SceneItems);
  }
}
