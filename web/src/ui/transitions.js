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
import { showContextMenu } from './dialog.js';
import { Topic } from '../store.js';

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

  addTransition() {
    this.onStatus?.(
      'Creating transitions is not exposed by obs-websocket; add it in the OBS desktop UI',
      'warning'
    );
  }

  removeTransition() {
    this.onStatus?.(
      'Removing transitions is not exposed by obs-websocket; manage it in the OBS desktop UI',
      'warning'
    );
  }

  openPropsMenu(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    showContextMenu(
      { x: rect.left, y: rect.top - 4 },
      [
        { label: 'Rename...', action: () => this.onStatus?.('Renaming transitions requires the desktop UI', 'warning') },
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
