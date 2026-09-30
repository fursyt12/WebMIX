/*
 * WebMIX - main menu bar.
 *
 * The tree mirrors OBS Studio's menu bar exactly (File, Edit, View, Docks,
 * Profile, Scene Collection, Tools, Help), including submenus, checkable
 * items, shortcuts and separators, as documented in web/docs/ui-spec.md §3.
 *
 * Items carry an `action` id; the app dispatches those through a command
 * registry, so this module stays declarative.
 */
import { h, clear, qs } from '../dom.js';

/** Strip Qt mnemonic markers; callers render `&File` as "File". */
export const plain = (label) => String(label ?? '').replace(/&/g, '');

const sep = () => ({ type: 'separator' });

export const MENU_TREE = [
  {
    id: 'file',
    label: '&File',
    items: [
      { id: 'actionShow_Recordings', label: 'Show &Recordings', action: 'showRecordings' },
      { id: 'actionRemux', label: 'Re&mux Recordings', action: 'remuxRecordings' },
      sep(),
      { id: 'action_Settings', label: '&Settings', action: 'openSettings' },
      { id: 'actionShowSettingsFolder', label: 'Show Settings Folder', action: 'showSettingsFolder' },
      { id: 'actionShowProfileFolder', label: 'Show Profile Folder', action: 'showProfileFolder' },
      sep(),
      { id: 'actionE_xit', label: 'E&xit', shortcut: 'Ctrl+Q', action: 'exit' },
    ],
  },
  {
    id: 'edit',
    label: '&Edit',
    items: [
      { id: 'actionMainUndo', label: 'Undo', shortcut: 'Ctrl+Z', action: 'undo' },
      { id: 'actionMainRedo', label: 'Redo', shortcut: 'Ctrl+Shift+Z', action: 'redo' },
      sep(),
      { id: 'actionCopySource', label: 'Copy', shortcut: 'Ctrl+C', action: 'copySource' },
      { id: 'actionPasteRef', label: 'Paste (Reference)', shortcut: 'Ctrl+V', action: 'pasteRef' },
      { id: 'actionPasteDup', label: 'Paste (Duplicate)', action: 'pasteDup' },
      sep(),
      { id: 'actionCopyFilters', label: 'Copy Filters', action: 'copyFilters' },
      { id: 'actionPasteFilters', label: 'Paste Filters', action: 'pasteFilters' },
      sep(),
      {
        id: 'transformMenu',
        label: '&Transform',
        items: [
          { id: 'actionEditTransform', label: '&Edit Transform', shortcut: 'Ctrl+E', action: 'editTransform' },
          { id: 'actionCopyTransform', label: 'Copy Transform', shortcut: 'Ctrl+Shift+C', action: 'copyTransform' },
          { id: 'actionPasteTransform', label: 'Paste Transform', shortcut: 'Ctrl+Shift+V', action: 'pasteTransform' },
          { id: 'actionResetTransform', label: '&Reset Transform', shortcut: 'Ctrl+R', action: 'resetTransform' },
          sep(),
          { id: 'actionRotate90CW', label: 'Rotate 90 degrees CW', action: 'rotate90cw' },
          { id: 'actionRotate90CCW', label: 'Rotate 90 degrees CCW', action: 'rotate90ccw' },
          { id: 'actionRotate180', label: 'Rotate 180 degrees', action: 'rotate180' },
          sep(),
          { id: 'actionFlipHorizontal', label: 'Flip &Horizontal', action: 'flipHorizontal' },
          { id: 'actionFlipVertical', label: 'Flip &Vertical', action: 'flipVertical' },
          sep(),
          { id: 'actionFitToScreen', label: '&Fit to screen', shortcut: 'Ctrl+F', action: 'fitToScreen' },
          { id: 'actionStretchToScreen', label: '&Stretch to screen', shortcut: 'Ctrl+S', action: 'stretchToScreen' },
          { id: 'actionCenterToScreen', label: '&Center to screen', shortcut: 'Ctrl+D', action: 'centerToScreen' },
          { id: 'actionVerticalCenter', label: 'Center Vertically', action: 'verticalCenter' },
          { id: 'actionHorizontalCenter', label: 'Center Horizontally', action: 'horizontalCenter' },
        ],
      },
      {
        id: 'orderMenu',
        label: '&Order',
        items: [
          { id: 'actionMoveUp', label: 'Move &Up', shortcut: 'Ctrl+Up', action: 'moveUp' },
          { id: 'actionMoveDown', label: 'Move &Down', shortcut: 'Ctrl+Down', action: 'moveDown' },
          sep(),
          { id: 'actionMoveToTop', label: 'Move to &Top', shortcut: 'Ctrl+Home', action: 'moveToTop' },
          { id: 'actionMoveToBottom', label: 'Move to &Bottom', shortcut: 'Ctrl+End', action: 'moveToBottom' },
        ],
      },
      {
        id: 'scalingMenu',
        label: 'Preview &Scaling',
        items: [
          { id: 'actionScaleWindow', label: 'Scale to Window', type: 'check', action: 'scaleWindow' },
          { id: 'actionScaleCanvas', label: 'Canvas', type: 'check', action: 'scaleCanvas' },
          { id: 'actionScaleOutput', label: 'Output', type: 'check', action: 'scaleOutput' },
          sep(),
          { id: 'actionPreviewZoomIn', label: 'Zoom In', action: 'previewZoomIn' },
          { id: 'actionPreviewZoomOut', label: 'Zoom Out', action: 'previewZoomOut' },
          { id: 'actionPreviewResetZoom', label: 'Reset Zoom', action: 'previewResetZoom' },
        ],
      },
      { id: 'actionLockPreview', label: '&Lock Preview', type: 'check', action: 'lockPreview' },
      sep(),
      { id: 'actionAdvAudioProperties', label: '&Advanced Audio Properties', action: 'advancedAudio' },
      sep(),
    ],
  },
  {
    id: 'view',
    label: '&View',
    items: [
      { id: 'resetUI', label: '&Reset UI', action: 'resetUI' },
      { id: 'actionFullscreenInterface', label: 'Fullscreen Interface', shortcut: 'F11', action: 'fullscreen' },
      sep(),
      {
        id: 'sceneListModeMenu',
        label: 'Scene List Mode',
        items: [
          { id: 'actionSceneListMode', label: 'List', type: 'check', action: 'sceneListMode' },
          { id: 'actionSceneGridMode', label: 'Grid', type: 'check', action: 'sceneGridMode' },
        ],
      },
      { id: 'toggleListboxToolbars', label: 'Dock Toolbars', type: 'check', checked: true, action: 'toggleListboxToolbars' },
      { id: 'toggleContextBar', label: 'Source Toolbar', type: 'check', checked: true, action: 'toggleContextBar' },
      { id: 'toggleSourceIcons', label: 'Source &Icons', type: 'check', checked: true, action: 'toggleSourceIcons' },
      { id: 'toggleStatusBar', label: '&Status Bar', type: 'check', checked: true, action: 'toggleStatusBar' },
      sep(),
      { id: 'stats', label: 'Stats', action: 'openStats' },
      sep(),
      { id: 'actionAlwaysOnTop', label: '&Always On Top', type: 'check', action: 'alwaysOnTop' },
    ],
  },
  {
    id: 'docks',
    label: '&Docks',
    dynamic: 'docks',
    items: [
      { id: 'lockDocks', label: '&Lock Docks', type: 'check', checked: true, action: 'lockDocks' },
      { id: 'sideDocks', label: '&Full-Height Docks', type: 'check', checked: true, action: 'sideDocks' },
      { id: 'resetDocks', label: '&Reset Docks', action: 'resetDocks' },
      sep(),
      { id: 'manageExtraBrowserDocks', label: 'Custom Browser Docks...', action: 'manageCustomDocks' },
      sep(),
    ],
  },
  {
    id: 'profile',
    label: '&Profile',
    dynamic: 'profiles',
    items: [
      { id: 'actionNewProfile', label: 'New...', action: 'newProfile' },
      { id: 'actionDupProfile', label: 'Duplicate...', action: 'duplicateProfile' },
      { id: 'actionRenameProfile', label: 'Rename...', action: 'renameProfile' },
      { id: 'actionRemoveProfile', label: 'Remove', action: 'removeProfile' },
      { id: 'actionImportProfile', label: 'Import...', action: 'importProfile' },
      { id: 'actionExportProfile', label: 'Export...', action: 'exportProfile' },
      sep(),
    ],
  },
  {
    id: 'sceneCollection',
    label: '&Scene Collection',
    dynamic: 'sceneCollections',
    items: [
      { id: 'actionNewSceneCollection', label: 'New...', action: 'newSceneCollection' },
      { id: 'actionDupSceneCollection', label: 'Duplicate...', action: 'duplicateSceneCollection' },
      { id: 'actionRenameSceneCollection', label: 'Rename...', action: 'renameSceneCollection' },
      { id: 'actionRemoveSceneCollection', label: 'Remove', action: 'removeSceneCollection' },
      { id: 'actionImportSceneCollection', label: 'Import...', action: 'importSceneCollection' },
      { id: 'actionExportSceneCollection', label: 'Export...', action: 'exportSceneCollection' },
      sep(),
      { id: 'actionShowMissingFiles', label: 'Check for Missing Files', action: 'showMissingFiles' },
      { id: 'actionRemigrateSceneCollection', label: 'Set Base Resolution', disabled: true, action: 'remigrateSceneCollection' },
      sep(),
    ],
  },
  {
    id: 'tools',
    label: '&Tools',
    items: [
      { id: 'autoConfigure', label: 'Auto-Configuration Wizard', action: 'autoConfigure' },
      { id: 'actionOpenPluginManager', label: 'Plugin Manager', action: 'openPluginManager' },
      { id: 'actionScripts', label: 'Scripts', action: 'openScripts' },
      sep(),
    ],
  },
  {
    id: 'help',
    label: '&Help',
    items: [
      { id: 'actionHelpPortal', label: 'Help &Portal', action: 'helpPortal' },
      { id: 'actionWebsite', label: 'Visit &Website', action: 'website' },
      { id: 'actionDiscord', label: 'Join &Discord Server', action: 'discord' },
      sep(),
      {
        id: 'menuLogFiles',
        label: '&Log Files',
        items: [
          { id: 'actionShowLogs', label: '&Show Log Files', action: 'showLogs' },
          { id: 'actionUploadCurrentLog', label: 'Upload &Current Log File', action: 'uploadCurrentLog' },
          { id: 'actionUploadLastLog', label: 'Upload &Previous Log File', action: 'uploadLastLog' },
          { id: 'actionViewCurrentLog', label: '&View Current Log', action: 'viewCurrentLog' },
        ],
      },
      { id: 'actionRestartSafe', label: 'Restart in Safe Mode', action: 'restartSafe' },
      sep(),
      { id: 'actionReleaseNotes', label: 'Release Notes', action: 'releaseNotes' },
      { id: 'actionShowAbout', label: '&About', action: 'about' },
      sep(),
    ],
  },
];

/**
 * MenuBar renders the top-level menus and their popups.
 *
 * Usage:
 *   const bar = new MenuBar(rootEl, { onAction(id), isChecked(id), isDisabled(id),
 *                                     buildDynamic(menuId) -> items[] });
 *   bar.render();
 */
export class MenuBar {
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    this.openMenuId = null;
    this.popup = null;
    this.activeSubmenu = null;
    this.#bindGlobal();
  }

  #bindGlobal() {
    this.onDocPointerDown = (event) => {
      if (!this.openMenuId) return;
      if (this.root.contains(event.target) || this.popup?.contains(event.target)) return;
      this.close();
    };
    this.onKeyDown = (event) => {
      if (event.key === 'Escape' && this.openMenuId) {
        this.close();
        event.stopPropagation();
      }
    };
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    document.addEventListener('keydown', this.onKeyDown);
  }

  render() {
    clear(this.root);
    for (const menu of MENU_TREE) {
      const button = h('button.obs-menubar-item', {
        type: 'button',
        role: 'menuitem',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
        text: plain(menu.label),
        dataset: { menuId: menu.id },
        on: {
          click: (event) => {
            event.stopPropagation();
            if (this.openMenuId === menu.id) this.close();
            else this.open(menu.id, button);
          },
          pointerenter: () => {
            // Once a menu is open, hovering the bar switches menus (Qt behaviour).
            if (this.openMenuId && this.openMenuId !== menu.id) this.open(menu.id, button);
          },
        },
      });
      this.root.appendChild(button);
    }
    if (this.handlers.isChecked) this.syncChecks();
  }

  open(menuId, anchor) {
    const menu = MENU_TREE.find((m) => m.id === menuId);
    if (!menu) return;
    this.close();
    this.openMenuId = menuId;
    anchor?.setAttribute('aria-expanded', 'true');

    const items = this.#resolveItems(menu);
    const popup = h('div.obs-menu', { role: 'menu' });
    this.#renderItems(popup, items, 0);
    qs('#menu-root').appendChild(popup);

    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${Math.round(rect.left)}px`;
    popup.style.top = `${Math.round(rect.bottom)}px`;
    // Keep the popup inside the viewport.
    const popupRect = popup.getBoundingClientRect();
    if (popupRect.right > window.innerWidth - 4) {
      popup.style.left = `${Math.max(4, window.innerWidth - popupRect.width - 4)}px`;
    }
    if (popupRect.bottom > window.innerHeight - 4) {
      popup.style.maxHeight = `${window.innerHeight - rect.bottom - 8}px`;
      popup.style.overflowY = 'auto';
    }
    this.popup = popup;
  }

  #resolveItems(menu) {
    let items = menu.items;
    if (menu.dynamic && this.handlers.buildDynamic) {
      const dynamic = this.handlers.buildDynamic(menu.id) ?? [];
      if (dynamic.length) items = [...items, ...dynamic];
    }
    return items;
  }

  #renderItems(container, items, depth) {
    for (const item of items) {
      if (item.type === 'separator') {
        container.appendChild(h('div.obs-menu-sep', { role: 'separator' }));
        continue;
      }
      if (item.hidden) continue;

      const checkable = item.type === 'check' || item.checked !== undefined;
      const checked = this.handlers.isChecked ? this.handlers.isChecked(item.id, item) : !!item.checked;
      const disabled = this.handlers.isDisabled ? this.handlers.isDisabled(item.id, item) : !!item.disabled;
      const hasSubmenu = Array.isArray(item.items) && item.items.length > 0;

      const row = h('button.obs-menu-item', {
        type: 'button',
        role: checkable ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': checkable ? String(checked) : null,
        'aria-disabled': disabled ? 'true' : null,
        disabled,
        dataset: { actionId: item.id, depth: String(depth) },
        on: {
          click: (event) => {
            event.stopPropagation();
            if (hasSubmenu) return;
            this.close();
            this.handlers.onAction?.(item.action ?? item.id, item);
          },
          pointerenter: (event) => this.#handleHover(event.currentTarget, item, depth),
        },
      });

      if (checkable) {
        row.appendChild(h('span.obs-menu-check', { text: checked ? '\u2713' : '' }));
      }
      row.appendChild(h('span.obs-menu-label', { text: plain(item.label) }));
      if (item.shortcut) row.appendChild(h('span.obs-menu-shortcut', { text: item.shortcut }));
      if (hasSubmenu) row.appendChild(h('span.obs-menu-arrow', { text: '\u25b8' }));
      container.appendChild(row);

      if (hasSubmenu) {
        const submenu = h('div.obs-menu.obs-submenu', { role: 'menu', hidden: true });
        this.#renderItems(submenu, item.items, depth + 1);
        row.appendChild(submenu);
      }
    }
  }

  #handleHover(row, item, depth) {
    // Close any deeper submenu that is no longer on the hover path.
    let node = row.parentElement;
    while (node && node !== this.popup) {
      if (node.classList?.contains('obs-submenu')) node.hidden = true;
      node = node.parentElement;
    }
    const submenu = row.querySelector(':scope > .obs-submenu');
    if (submenu) {
      submenu.hidden = false;
      const rect = row.getBoundingClientRect();
      if (rect.right + 180 > window.innerWidth) {
        submenu.style.left = 'auto';
        submenu.style.right = '100%';
      }
    }
  }

  /** Refresh check marks after external state changes. */
  syncChecks() {
    if (!this.popup) return;
    for (const row of this.popup.querySelectorAll('[data-action-id]')) {
      const id = row.dataset.actionId;
      if (row.getAttribute('aria-checked') === null) continue;
      const checked = !!this.handlers.isChecked?.(id);
      row.setAttribute('aria-checked', String(checked));
      const mark = row.querySelector('.obs-menu-check');
      if (mark) mark.textContent = checked ? '\u2713' : '';
    }
  }

  close() {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
    if (this.openMenuId) {
      this.root.querySelector(`[data-menu-id="${this.openMenuId}"]`)?.setAttribute('aria-expanded', 'false');
    }
    this.openMenuId = null;
  }

  /** Close the menu bar (used by app teardown). */
  destroy() {
    this.close();
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown);
  }
}
