/*
 * WebMIX - dockable panel chrome.
 *
 * Reproduces QDockWidget: a 4px-radius title bar with the dock title (8pt
 * bold), an optional button strip and a content area.  Docks can be hidden
 * and re-shown from View > Docks, and closed with the title-bar button.
 */
import { h, setText } from '../dom.js';
import { iconButton } from './icons.js';

export class Dock {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {string} options.title
   * @param {HTMLElement} options.content
   * @param {Array<HTMLElement>} [options.buttons]
   * @param {boolean} [options.closable]
   * @param {(id: string) => void} [options.onClose]
   */
  constructor({ id, title, content, buttons = [], closable = true, onClose }) {
    this.id = id;
    this.title = title;
    this.content = content;
    this.titleText = h('span.obs-dock-title-text', { text: title });
    this.buttonStrip = h('div.obs-dock-buttons');
    for (const button of buttons) this.buttonStrip.appendChild(button);
    if (closable) {
      this.buttonStrip.appendChild(
        iconButton('close', {
          title: 'Close',
          className: 'obs-dock-close',
          size: 14,
          onClick: () => onClose?.(id),
        })
      );
    }

    this.el = h(`section.obs-dock`, { dataset: { dockId: id } }, [
      h('header.obs-dock-title', {}, [this.titleText, this.buttonStrip]),
      h('div.obs-dock-content.obs-scroll', {}, [content]),
    ]);
  }

  setTitle(title) {
    setText(this.titleText, title);
  }

  setVisible(visible) {
    this.el.hidden = !visible;
    // Hidden docks inside a splitter must not reserve space.
    this.el.style.display = visible ? '' : 'none';
  }

  get visible() {
    return !this.el.hidden && this.el.style.display !== 'none';
  }
}
