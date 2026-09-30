/*
 * WebMIX - source toolbar (the context bar below the menubar).
 *
 * Shows the selected source's name plus its actions.  OBS builds a per-kind
 * toolbar here (browser / media / color / device-select variants); the web
 * version reproduces the parts that obs-websocket can drive:
 *
 *  - Properties / Filters / Interact for every source
 *  - media transport via TriggerMediaInputAction
 *  - browser "Refresh cache" via PressInputPropertiesButton
 */
import { h, clear, setText } from '../dom.js';
import { icon, iconButton } from './icons.js';
import { Topic } from '../store.js';

const MEDIA_ACTIONS = [
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART', icon: 'refresh', title: 'Restart' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS', icon: 'up', title: 'Previous' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY', icon: 'play', title: 'Play' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE', icon: 'pause', title: 'Pause' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP', icon: 'stop', title: 'Stop' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT', icon: 'down', title: 'Next' },
];

export class SourceToolbar {
  constructor({ store, api, root, onStatus }) {
    this.store = store;
    this.api = api;
    this.root = root;
    this.onStatus = onStatus;
    this.selected = null;
    this.openFilters = null;
    this.openProperties = null;
    this.#renderEmpty();
  }

  setSelection(name) {
    if (this.selected === name) return;
    this.selected = name;
    this.store.notify(Topic.SceneItems);
  }

  #renderEmpty() {
    clear(this.root);
    this.root.appendChild(h('span.obs-toolbar-context.obs-muted', { text: 'No source selected' }));
  }

  update(state) {
    const name = this.selected;
    if (!name || !state.inputs[name]) {
      this.#renderEmpty();
      this.root.classList.add('is-empty');
      return;
    }
    this.root.classList.remove('is-empty');

    const input = state.inputs[name];
    const kind = input.inputKind ?? '';
    const isMedia = /ffmpeg_source|vlc_source|media_source/.test(kind);
    const isBrowser = /browser_source/.test(kind);

    clear(this.root);
    this.root.append(
      h('span.obs-toolbar-context', {}, [
        h('span.obs-source-icon', {}, [icon('folder', 16)]),
        h('span.obs-toolbar-context-label', { text: name }),
      ]),
      h('div.obs-toolbar-sep')
    );

    const propsBtn = h('button.obs-btn.flat', {
      type: 'button',
      on: { click: () => this.openProperties?.(name) },
    });
    propsBtn.append(icon('properties', 14), ' Properties');
    const filtersBtn = h('button.obs-btn.flat', {
      type: 'button',
      on: { click: () => this.openFilters?.(name) },
    });
    filtersBtn.append(icon('filter', 14), ' Filters');
    const interactBtn = h('button.obs-btn.flat', {
      type: 'button',
      on: { click: () => this.#interact(name) },
    });
    interactBtn.append(icon('interact', 14), ' Interact');

    this.root.append(propsBtn, filtersBtn, interactBtn);

    if (isBrowser) {
      this.root.append(
        h('div.obs-toolbar-sep'),
        h('button.obs-btn.flat', {
          type: 'button',
          text: 'Refresh cache',
          on: { click: () => this.#pressButton(name, 'refreshnocache', 'Cache refreshed') },
        }),
        h('button.obs-btn.flat', {
          type: 'button',
          text: 'Open URL',
          on: { click: () => this.#openUrl(name) },
        })
      );
    }

    if (isMedia) {
      this.root.append(h('div.obs-toolbar-sep'));
      for (const entry of MEDIA_ACTIONS) {
        this.root.appendChild(
          iconButton(entry.icon, {
            title: entry.title,
            onClick: () => this.#mediaAction(name, entry.action, entry.title),
          })
        );
      }
    }
  }

  async #pressButton(name, propertyName, message) {
    try {
      await this.api.pressInputPropertiesButton(name, propertyName);
      this.onStatus?.(message, 'info');
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  async #mediaAction(name, action, title) {
    try {
      await this.api.request('TriggerMediaInputAction', { inputName: name, mediaAction: action });
      this.onStatus?.(`${title}: ${name}`, 'info');
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  async #openUrl(name) {
    try {
      const { inputSettings } = await this.api.getInputSettings(name);
      if (inputSettings?.url) window.open(inputSettings.url, '_blank', 'noopener');
      else this.onStatus?.('This source has no URL', 'warning');
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }

  async #interact(name) {
    try {
      const { inputSettings } = await this.api.getInputSettings(name);
      if (inputSettings?.url) {
        window.open(inputSettings.url, '_blank', 'noopener');
        return;
      }
      await this.api.openInputInteractDialog(name);
      this.onStatus?.('Interact window opened on the OBS host', 'info');
    } catch (err) {
      this.onStatus?.(err.message, 'error');
    }
  }
}
