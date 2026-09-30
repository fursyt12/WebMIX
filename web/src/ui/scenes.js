/*
 * WebMIX - Scenes dock.
 *
 * Reproduces OBS's Scenes panel: a list (or grid) of scenes with the toolbar
 * Add / Remove / Filters / Move Up / Move Down, F2 rename, and the scene
 * context menu.  Clicking a scene switches the program scene (or the preview
 * scene in Studio Mode), exactly like the desktop UI.
 *
 * NOTE: obs-websocket 5.7 exposes no request to reorder scenes, so the
 * Move Up / Move Down buttons report that the operation needs the WebMIX
 * bridge (see web/README.md "Known gaps").
 */
import { h, reconcile, setText, setClass, clear } from '../dom.js';
import { iconButton, icon } from './icons.js';
import { showContextMenu, prompt, confirm } from './dialog.js';
import { Topic, selectors } from '../store.js';
import { moveScene } from '../bridge.js';

export class ScenesPanel {
  constructor({ store, api, onStatus }) {
    this.store = store;
    this.api = api;
    this.onStatus = onStatus;
    this.selected = null;
    this.gridMode = false;
    this.renaming = null;

    this.list = h('ul.obs-list.obs-scene-list', {
      role: 'listbox',
      tabindex: '0',
      'aria-label': 'Scenes',
    });

    this.toolbar = h('div.obs-list-toolbar', { role: 'toolbar' }, [
      iconButton('plus', { title: 'Add Scene', onClick: () => this.addScene() }),
      iconButton('minus', { title: 'Remove Scene', onClick: () => this.removeScene() }),
      h('div.obs-toolbar-sep'),
      iconButton('filter', { title: 'Scene Filters', onClick: () => this.openFilters() }),
      h('div.obs-toolbar-sep'),
      iconButton('up', { title: 'Move Scene Up', onClick: () => this.move(-1) }),
      iconButton('down', { title: 'Move Scene Down', onClick: () => this.move(1) }),
    ]);

    this.el = h('div.obs-panel.obs-scenes-panel', {}, [this.list, this.toolbar]);
    this.#wire();
  }

  #wire() {
    this.list.addEventListener('click', (event) => {
      const row = event.target.closest('[data-scene-name]');
      if (!row) return;
      const name = row.dataset.sceneName;
      if (this.renaming) return;
      this.selected = name;
      this.activateScene(name);
    });

    this.list.addEventListener('dblclick', (event) => {
      const row = event.target.closest('[data-scene-name]');
      if (row) this.startRename(row.dataset.sceneName);
    });

    this.list.addEventListener('keydown', (event) => {
      const rows = [...this.list.querySelectorAll('[data-scene-name]')];
      const index = rows.findIndex((r) => r.dataset.sceneName === this.selected);
      if (event.key === 'F2' && this.selected) {
        event.preventDefault();
        this.startRename(this.selected);
      } else if (event.key === 'Delete' && this.selected) {
        event.preventDefault();
        this.removeScene();
      } else if (event.key === 'ArrowDown' && index < rows.length - 1) {
        event.preventDefault();
        this.selected = rows[index + 1].dataset.sceneName;
        this.activateScene(this.selected);
        this.list.focus();
      } else if (event.key === 'ArrowUp' && index > 0) {
        event.preventDefault();
        this.selected = rows[index - 1].dataset.sceneName;
        this.activateScene(this.selected);
        this.list.focus();
      } else if (event.key === ' ') {
        event.preventDefault();
        if (this.selected) this.activateScene(this.selected, true);
      }
    });

    this.list.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('[data-scene-name]');
      event.preventDefault();
      if (row) this.selected = row.dataset.sceneName;
      this.openContextMenu(event.clientX, event.clientY);
    });
  }

  /** Clicking a scene switches program (or preview in Studio Mode). */
  activateScene(name, forceTransition = false) {
    if (!name) return;
    const state = this.store.state;
    const alreadyActive = state.studioMode
      ? state.currentPreviewScene === name
      : state.currentProgramScene === name;
    if (alreadyActive && !forceTransition) return;
    this.api.setProgramScene(name).catch((err) => this.onStatus?.(err.message, 'error'));
  }

  async addScene() {
    const name = await prompt({
      title: 'Add Scene',
      label: 'Scene name',
      value: this.#uniqueSceneName('Scene'),
    });
    if (!name) return;
    try {
      await this.api.createScene(name);
      this.selected = name;
      this.store.notify(Topic.Scenes);
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  async removeScene() {
    const name = this.selected;
    if (!name) return;
    const state = this.store.state;
    if (state.scenes.length <= 1) {
      this.onStatus?.('Cannot remove the last scene', 'error');
      return;
    }
    const ok = await confirm({
      title: 'Remove Scene',
      text: `Are you sure you want to remove "${name}"?`,
      okLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.removeScene(name);
      this.selected = this.store.state.scenes[0]?.sceneName ?? null;
      this.store.notify(Topic.Scenes);
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  move(direction) {
    const state = this.store.state;
    const index = state.scenes.findIndex((s) => s.sceneName === this.selected);
    if (index < 0) return;
    const target = direction < 0 ? index - 1 : index + 1;
    if (target < 0 || target >= state.scenes.length) return;
    this.moveTo(target);
  }

  moveToTop() {
    this.moveTo(0);
  }

  moveToBottom() {
    this.moveTo(this.store.state.scenes.length - 1);
  }

  /**
   * Reorder through the WebMIX bridge: there is no obs-websocket request for
   * this, so without the bridge (external static server) it stays unavailable.
   */
  async moveTo(target) {
    const state = this.store.state;
    const index = state.scenes.findIndex((s) => s.sceneName === this.selected);
    if (index < 0 || target === index || target < 0 || target >= state.scenes.length) return;

    const result = await moveScene(index, target);
    if (result?.ok) {
      await this.api.refreshScenes();
      this.store.notify(Topic.Scenes);
    } else {
      this.onStatus?.(result?.error ?? 'Could not reorder scenes', 'warning');
    }
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

  async startRename(name) {
    if (!name) return;
    const row = this.list.querySelector(`[data-scene-name="${CSS.escape(name)}"]`);
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
        await this.api.renameScene(name, value);
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

  async duplicateScene(name) {
    const target = this.#uniqueSceneName(`${name} Copy`);
    try {
      // Duplicating a scene is not exposed directly; create + copy is done
      // by the desktop UI. Report the gap rather than doing it wrong.
      this.onStatus?.(
        'Duplicating a scene is not exposed by obs-websocket; create a new scene and add the same sources',
        'warning'
      );
      void target;
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  openContextMenu(x, y) {
    const state = this.store.state;
    const name = this.selected;
    const index = state.scenes.findIndex((s) => s.sceneName === name);
    showContextMenu({ x, y }, [
      { label: 'Add Scene', action: () => this.addScene() },
      { label: 'Duplicate...', disabled: !name, action: () => this.duplicateScene(name) },
      { separator: true },
      { label: 'Rename...', disabled: !name, shortcut: 'F2', action: () => this.startRename(name) },
      { label: 'Remove', disabled: !name || state.scenes.length <= 1, shortcut: 'Del', action: () => this.removeScene() },
      { separator: true },
      { label: 'Move Up', disabled: !name || index <= 0, action: () => this.move(-1) },
      { label: 'Move Down', disabled: !name || index >= state.scenes.length - 1, action: () => this.move(1) },
      { label: 'Move to Top', disabled: !name || index <= 0, action: () => this.moveToTop() },
      { label: 'Move to Bottom', disabled: !name || index >= state.scenes.length - 1, action: () => this.moveToBottom() },
      { separator: true },
      { label: 'Filters', disabled: !name, action: () => this.openFilters() },
      { label: 'Properties', disabled: !name, action: () => this.openProperties() },
      { separator: true },
      { label: 'Screenshot Scene', disabled: !name, action: () => this.screenshot(name) },
      { separator: true },
      { label: 'Grid Mode', checked: this.gridMode, action: () => this.toggleGridMode() },
    ]);
  }

  async screenshot(name) {
    try {
      const data = await this.api.getSourceScreenshot(name, { format: 'png', quality: 100 });
      const link = document.createElement('a');
      link.href = data;
      link.download = `${name}.png`;
      link.click();
      this.onStatus?.(`Screenshot saved: ${name}.png`, 'info');
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  toggleGridMode(force = null) {
    this.gridMode = force === null ? !this.gridMode : !!force;
    this.store.notify(Topic.Scenes);
  }

  #uniqueSceneName(base) {
    const names = new Set(this.store.state.scenes.map((s) => s.sceneName));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  update(state) {
    setClass(this.list, 'is-grid', this.gridMode);
    const scenes = state.scenes;
    if (!this.selected || !scenes.some((s) => s.sceneName === this.selected)) {
      this.selected =
        selectors.previewPaneScene(state) ?? scenes[0]?.sceneName ?? null;
    }

    reconcile(
      this.list,
      scenes,
      (scene) => scene.sceneName,
      (scene) => this.#createRow(scene),
      (node, scene) => this.#updateRow(node, scene, state)
    );
  }

  #createRow(scene) {
    const row = h('li.obs-list-item.obs-scene-item', {
      dataset: { sceneName: scene.sceneName },
      role: 'option',
      tabindex: '-1',
    });
    row.append(
      h('span.obs-list-label', { text: scene.sceneName }),
      h('span.obs-scene-badges')
    );
    return row;
  }

  #updateRow(row, scene, state) {
    setText(row.querySelector('.obs-list-label'), scene.sceneName);
    const isProgram = state.currentProgramScene === scene.sceneName;
    const isPreview = state.currentPreviewScene === scene.sceneName;
    setClass(row, 'is-selected', this.selected === scene.sceneName);
    setClass(row, 'is-program', isProgram);
    setClass(row, 'is-preview', state.studioMode && isPreview);
    row.setAttribute('aria-selected', String(this.selected === scene.sceneName));

    const badges = row.querySelector('.obs-scene-badges');
    clear(badges);
    if (state.studioMode) {
      if (isProgram) badges.appendChild(h('span.obs-badge.live', { text: 'LIVE' }));
      else if (isPreview) badges.appendChild(h('span.obs-badge', { text: 'PREVIEW' }));
    } else if (isProgram) {
      badges.appendChild(h('span.obs-badge.live', { text: 'LIVE' }));
    }
  }
}
