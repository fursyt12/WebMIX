/*
 * WebMIX - source toolbar (the context bar between the preview and the docks).
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
import { icon, iconButton, sourceIcon } from './icons.js';
import { Topic, selectors } from '../store.js';

const MEDIA_ACTIONS = [
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART', icon: 'mediaRestart', title: 'Restart' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS', icon: 'mediaPrevious', title: 'Previous' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY', icon: 'mediaPlay', title: 'Play' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE', icon: 'mediaPause', title: 'Pause' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP', icon: 'mediaStop', title: 'Stop' },
  { action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT', icon: 'mediaNext', title: 'Next' },
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

  /*! A button of the context bar: the desktop's are ordinary push buttons
   *  with the icon in front of the text. */
  #button(iconName, label, onClick, disabled = false) {
    const button = h('button.obs-btn.obs-context-btn', { type: 'button', disabled, on: { click: onClick } });
    if (iconName) button.appendChild(icon(iconName, 16));
    button.appendChild(h('span', { text: label }));
    return button;
  }

  /*! Nothing selected: the bar keeps its two buttons, disabled, like OBS. */
  #renderEmpty() {
    clear(this.root);
    this.root.append(
      h('span.obs-context-source', {}, [h('span.obs-context-name', { text: 'No source selected' })]),
      this.#button('gear', 'Properties', null, true),
      this.#button('filter', 'Filters', null, true)
    );
  }

  update(state) {
    const name = this.selected;
    const item = name
      ? selectors.sceneItems(state, selectors.previewPaneScene(state)).find((i) => i.sourceName === name)
      : null;
    if (!name || (!state.inputs[name] && !item)) {
      this.#renderEmpty();
      this.root.classList.add('is-empty');
      return;
    }
    this.root.classList.remove('is-empty');

    const input = state.inputs[name] ?? {};
    const kind = input.inputKind ?? item?.inputKind ?? '';
    const isMedia = /ffmpeg_source|vlc_source|media_source/.test(kind);
    const isBrowser = /browser_source/.test(kind);
    /* OBS_SOURCE_INTERACTION: only sources that take input get the button. */
    const interactive = isBrowser || ((input.inputKindCaps ?? 0) & (1 << 5)) !== 0;

    clear(this.root);
    this.root.append(
      h('span.obs-context-source', {}, [
        sourceIcon(item?.sourceIcon ?? 'default', 16),
        h('span.obs-context-name', { text: name, raw: true, title: name }),
      ]),
      this.#button('gear', 'Properties', () => this.openProperties?.(name)),
      this.#button('filter', 'Filters', () => this.openFilters?.(name))
    );
    if (interactive) {
      this.root.append(this.#button('interact', 'Interact', () => this.#interact(name)));
    }

    if (isBrowser) {
      this.root.append(
        h('span.obs-context-gap'),
        this.#button('refresh', 'Refresh', () => this.#pressButton(name, 'refreshnocache', 'Cache refreshed'))
      );
    }

    if (isMedia) {
      this.root.append(h('span.obs-context-gap'));
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
