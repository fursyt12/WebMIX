/*
 * WebMIX - Scene Transitions dock.
 *
 * Combo box of transitions, duration spin box (hidden for fixed transitions),
 * Add / Remove / Properties buttons, and - in Studio Mode - the studio
 * transition button and T-bar.
 *
 * obs-websocket 5.7 can switch, configure and trigger transitions but cannot
 * create, rename or remove transition instances, so those buttons report the
 * gap instead of silently doing nothing.
 */
import { h, reconcile, setText, setClass } from '../dom.js';
import { iconButton } from './icons.js';
import { showContextMenu, prompt, confirm, openDialog, dialogButtons } from './dialog.js';
import { Topic } from '../store.js';
import { addTransition, renameTransition, removeTransition } from '../bridge.js';

export class TransitionsPanel {
  constructor({ store, api, onStatus }) {
    this.store = store;
    this.api = api;
    this.onStatus = onStatus;

    this.combo = h('select.obs-select.obs-transition-combo', {
      'aria-label': 'Transition',
      on: {
        change: () => {
          this.api
            .setCurrentTransition(this.combo.value)
            .catch((err) => this.onStatus?.(err.message, 'error'));
        },
      },
    });

    this.durationLabel = h('label.obs-label', { text: 'Duration' });
    this.duration = h('input.obs-spin', {
      type: 'number',
      min: '50',
      max: '20000',
      step: '50',
      value: '300',
      'aria-label': 'Duration',
      on: {
        change: () => {
          const value = Number(this.duration.value);
          if (Number.isFinite(value)) {
            this.api.setTransitionDuration(value).catch((err) => this.onStatus?.(err.message, 'error'));
          }
        },
      },
    });
    this.durationRow = h('div.obs-field-row.obs-transition-duration', {}, [
      this.durationLabel,
      this.duration,
      h('span.obs-muted', { text: 'ms' }),
    ]);

    this.buttons = h('div.obs-transition-buttons', {}, [
      h('div.obs-toolbar-spacer'),
      iconButton('plus', { title: 'Add Configurable Transition', onClick: () => this.addTransition() }),
      iconButton('minus', { title: 'Remove Transition', onClick: () => this.removeTransition() }),
      iconButton('gear', { title: 'Transition Properties', onClick: (event) => this.openPropsMenu(event) }),
    ]);

    // Studio Mode extras.
    this.tbar = h('input.obs-range.obs-tbar', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.001',
      value: '0',
      'aria-label': 'T-Bar',
      on: {
        input: () => this.api.setTBarPosition(Number(this.tbar.value), false).catch(() => {}),
        change: () => this.api.setTBarPosition(Number(this.tbar.value), true).catch((err) => this.onStatus?.(err.message, 'error')),
      },
    });
    this.transitionButton = h('button.obs-btn.primary.obs-studio-transition', {
      type: 'button',
      text: 'Transition',
      on: {
        click: () => this.api.triggerStudioTransition().catch((err) => this.onStatus?.(err.message, 'error')),
      },
    });
    this.studioBox = h('div.obs-transition-studio', { hidden: true }, [this.tbar, this.transitionButton]);

    this.el = h('div.obs-panel.obs-transitions-panel', {}, [
      this.combo,
      this.durationRow,
      this.buttons,
      this.studioBox,
    ]);
  }

  /** OBS instantiate-a-transition dialog: pick a kind, then a name. */
  async addTransition() {
    let kinds;
    try {
      kinds = (await this.api.request('GetTransitionKindList')).transitionKinds ?? [];
    } catch (err) {
      this.onStatus?.(err.message, 'error');
      return;
    }
    if (!kinds.length) {
      this.onStatus?.('OBS reported no transition kinds', 'warning');
      return;
    }

    const chosen = await this.#pickKind(kinds);
    if (!chosen) return;

    const name = await prompt({
      title: 'Add Transition',
      label: 'Transition name',
      value: chosen.display,
    });
    if (!name) return;

    const result = await addTransition(chosen.id, name);
    if (result?.ok) {
      await this.refresh();
      this.onStatus?.(`Transition "${name}" created`, 'success');
    } else {
      this.onStatus?.(result?.error ?? 'Could not create the transition', 'warning');
    }
  }

  async removeTransition() {
    const name = this.store.state.currentTransition.transitionName;
    if (!name) return;
    const ok = await confirm({
      title: 'Remove Transition',
      text: `Remove transition "${name}"?`,
      okLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;

    const result = await removeTransition(name);
    if (result?.ok) {
      await this.refresh();
      this.onStatus?.(`Transition "${name}" removed`, 'success');
    } else {
      this.onStatus?.(result?.error ?? 'Could not remove the transition', 'warning');
    }
  }

  async renameCurrentTransition() {
    const name = this.store.state.currentTransition.transitionName;
    if (!name) return;
    const newName = await prompt({
      title: 'Rename Transition',
      label: 'Transition name',
      value: name,
    });
    if (!newName || newName === name) return;

    const result = await renameTransition(name, newName);
    if (result?.ok) {
      await this.refresh();
      this.onStatus?.(`Renamed to "${newName}"`, 'success');
    } else {
      this.onStatus?.(result?.error ?? 'Could not rename the transition', 'warning');
    }
  }

  /** Re-read the transition list from OBS (and the current selection). */
  async refresh() {
    try {
      const [list, current] = await Promise.all([
        this.api.request('GetSceneTransitionList'),
        this.api.request('GetCurrentSceneTransition'),
      ]);
      this.store.batch(() => {
        this.store.state.transitions = list.transitions ?? [];
        this.store.state.currentTransition = {
          ...this.store.state.currentTransition,
          transitionName: current.transitionName ?? list.currentSceneTransitionName ?? null,
          transitionKind: current.transitionKind ?? list.currentSceneTransitionKind ?? null,
          transitionDuration: current.transitionDuration ?? 300,
          transitionFixed: current.transitionFixed ?? false,
          transitionConfigurable: current.transitionConfigurable ?? false,
        };
      });
      this.store.notify(Topic.Transitions);
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  /** Small dialog listing the transition kinds OBS offers. */
  #pickKind(kinds) {
    return new Promise((resolve) => {
      const list = h('ul.obs-list.obs-scroll', { style: { maxHeight: '260px' } });
      let selected = kinds[0];
      for (const id of kinds) {
        const display = id
          .replace(/_transition$/, '')
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
        const row = h('li.obs-list-item', { dataset: { kind: id }, role: 'option' }, [
          h('span.obs-list-label', { text: display }),
        ]);
        if (id === selected) row.classList.add('is-selected');
        row.addEventListener('click', () => {
          selected = id;
          for (const other of list.children) other.classList.remove('is-selected');
          row.classList.add('is-selected');
        });
        list.appendChild(row);
      }

      const dialog = openDialog({
        title: 'Transition Type',
        width: 380,
        body: [h('label.obs-label', { text: 'Transition' }), list],
        footer: dialogButtons([
          { label: 'Cancel', action: () => dialog.close() },
          {
            label: 'OK',
            primary: true,
            action: () => {
              // Resolve before closing: the dialog's onClose resolves null.
              resolve({ id: selected, display: selected.replace(/_transition$/, '').replace(/_/g, ' ') });
              dialog.close();
            },
          },
        ]),
        onClose: () => resolve(null),
      });
    });
  }

  openPropsMenu(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    showContextMenu(
      { x: rect.left, y: rect.top - 4 },
      [
        { label: 'Rename...', action: () => this.renameCurrentTransition() },
        { label: 'Properties', action: () => this.openProperties() },
      ]
    );
  }

  async openProperties() {
    const name = this.store.state.currentTransition.transitionName;
    if (!name) return;
    this.el.dispatchEvent(
      new CustomEvent('webmix:open-transition-properties', { bubbles: true, detail: { transitionName: name } })
    );
  }

  update(state) {
    const current = state.currentTransition.transitionName;
    reconcile(
      this.combo,
      state.transitions,
      (t) => t.transitionName,
      (t) => h('option', { value: t.transitionName, text: t.transitionName }),
      (node, t) => {
        setText(node, t.transitionName);
        node.value = t.transitionName;
      }
    );
    if (current && this.combo.value !== current) this.combo.value = current;

    const fixed = state.currentTransition.transitionFixed === true;
    this.durationRow.hidden = fixed;
    if (!fixed && document.activeElement !== this.duration) {
      this.duration.value = String(state.currentTransition.transitionDuration ?? 300);
    }

    setClass(this.el, 'is-studio', state.studioMode);
    this.studioBox.hidden = !state.studioMode;
    setClass(this.transitionButton, 'is-busy', state.transitionActive);
  }
}
