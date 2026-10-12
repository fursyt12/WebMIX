/*
 * WebMIX - dockable panel chrome.
 *
 * Reproduces QDockWidget: a 4px-radius title bar with the dock title (8pt
 * bold), an optional button strip and a content area.  Docks are hidden and
 * re-shown from the Docks menu. The title-bar button floats a dock, as on the
 * desktop: it becomes a window over the page that can be dragged by its title
 * and resized, and the same button (or closing it) puts it back.
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
    this.buttonStrip.appendChild(
      iconButton('popout', {
        title: 'Float',
        className: 'obs-dock-float',
        size: 10,
        onClick: () => this.setFloating(!this.floating),
      })
    );
    if (closable) {
      /* Only a floating dock has a close button; a docked one is closed
       * from the Docks menu, like the desktop's. */
      this.buttonStrip.appendChild(
        iconButton('close', {
          title: 'Close',
          className: 'obs-dock-close',
          size: 10,
          onClick: () => {
            this.setFloating(false);
            onClose?.(id);
          },
        })
      );
    }

    this.header = h('header.obs-dock-title', {}, [this.titleText, this.buttonStrip]);
    this.el = h(`section.obs-dock`, { dataset: { dockId: id } }, [
      this.header,
      h('div.obs-dock-content.obs-scroll', {}, [content]),
    ]);
    this.floating = false;
    this.#wireDrag();
  }

  /*! Float the dock over the page, or put it back in its slot. */
  setFloating(floating) {
    if (floating === this.floating) return;
    const slot = this.el.parentElement;
    if (floating) {
      const rect = this.el.getBoundingClientRect();
      Object.assign(this.el.style, {
        left: `${Math.round(rect.left + 24)}px`,
        top: `${Math.round(Math.max(8, rect.top - 24))}px`,
        width: `${Math.round(Math.max(220, rect.width))}px`,
        height: `${Math.round(Math.max(140, rect.height))}px`,
      });
    } else {
      Object.assign(this.el.style, { left: '', top: '', width: '', height: '' });
    }
    this.floating = floating;
    this.el.classList.toggle('is-floating', floating);
    /* The slot it left must not keep its room in the layout. */
    slot?.classList.toggle('is-vacated', floating);
  }

  #wireDrag() {
    this.header.addEventListener('pointerdown', (event) => {
      if (!this.floating || event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      const startX = event.clientX - this.el.offsetLeft;
      const startY = event.clientY - this.el.offsetTop;
      const move = (moveEvent) => {
        const left = Math.min(window.innerWidth - 60, Math.max(-this.el.offsetWidth + 60, moveEvent.clientX - startX));
        const top = Math.min(window.innerHeight - 24, Math.max(0, moveEvent.clientY - startY));
        this.el.style.left = `${left}px`;
        this.el.style.top = `${top}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  setTitle(title) {
    setText(this.titleText, title);
  }

  setVisible(visible) {
    if (!visible) this.setFloating(false);
    this.el.hidden = !visible;
    // Hidden docks inside a splitter must not reserve space.
    this.el.style.display = visible ? '' : 'none';
  }

  get visible() {
    return !this.el.hidden && this.el.style.display !== 'none';
  }
}
