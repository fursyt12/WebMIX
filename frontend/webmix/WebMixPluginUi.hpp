/******************************************************************************
    Copyright (C) 2025 WebMIX contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
******************************************************************************/

#pragma once

#include <QJsonObject>
#include <QString>

#include <functional>

/* WebMIX: the windows plugins add, in the browser.
 *
 * Plugins put their settings behind Tools menu entries that open Qt windows
 * (DistroAV's NDI output settings, the Output Timer, the Scripts window...).
 * In web mode the Qt window is never shown, so the page triggers those entries
 * itself and mirrors what they open. The window is really shown - the plugin
 * fills it, checks it and applies it exactly as on the desktop - but it is
 * never put on screen and can never be activated, so it cannot take the
 * keyboard from whatever the person is using; its widgets are described to
 * the page, which draws the same form and hands every edit and click back to
 * the widget it came from. Message boxes, file dialogs and further windows a
 * mirrored window opens are mirrored the same way.
 *
 * Only what a page asked for is captured: triggering a Tools entry, or doing
 * something to a mirrored window, arms the capture for a moment, and anything
 * else a plugin shows behaves as it always did.
 *
 * A window belongs to the page (`session`) that opened it, so it opens there
 * and not in every browser that is connected. Changes reach that page as the
 * `WebMixPluginWindowsChanged` event: `{session, open: [ids], windows:
 * [window]}`, `windows` being the ones that changed. */
namespace WebMixPluginUi {

using Reply = std::function<void(const QJsonObject &result)>;

/*! The Tools menu entries plugins added, in menu order, and OBS's own Plugin
 *  Manager: `{items: [{id, text, enabled, checkable, checked, replacement?,
 *  items?}], pluginManager: id|null}`. `replacement` names a dialog the page
 *  has its own version of ("webSocketSettings"); `items` is a submenu. */
QJsonObject Tools();

/*! The mirrored windows `session` has open: `{ok, session, open: [ids],
 *  windows: [{id, title, modal, width, height, body}], everyone}`, `everyone`
 *  being the same for the windows every page shows, plus their `notices`.
 *  `body` is the window's widgets as a tree of `{t, id?, ...}` nodes (see
 *  the .cpp). Trigger() and Act() reply with this too. */
QJsonObject Windows(const QString &session);

/*! Trigger Tools entry `id` for `session`. `reply` gets Windows() once the
 *  window it opened is shown, with `opened: false` when nothing was. */
void Trigger(int id, const QString &session, Reply reply);

/*! Do to a mirrored window what a person would: `{window, widget, action,
 *  value}`, action being set, click, trigger, select, activate, check, tab,
 *  link or close. `reply` gets Windows() a moment later. */
void Act(const QJsonObject &request, const QString &session, Reply reply);

/*! Web mode, called before the main window exists: from now on every window
 *  OBS or a plugin shows is kept off screen and goes to the pages (session
 *  "*", every page) unless a page asked for it, and no window OBS keeps
 *  hidden can take the keyboard. Until Serve() there is no page: a modal
 *  window, which would hold OBS's start-up, is answered no and becomes a
 *  notice. A window that has to be on screen anyway sets the
 *  `webmixOnScreen` property before it is shown (the address chooser). */
void StartWebMode();

/*! The web interface is reachable: windows wait for the pages from now on,
 *  and what plugins open with QDesktopServices (links, folders) goes to the
 *  pages as the `WebMixOpenUrl` event (`{session, url}` or `{session, path}`)
 *  instead of opening on this computer. */
void Serve();

/*! Something every page is told until one of them dismisses it:
 *  `{kind, title, text}` (kind "startup": a window answered at start-up). */
void Notice(const QJsonObject &notice);

/*! Stop capturing and give every mirrored window back to Qt as it was. */
void Stop();

} // namespace WebMixPluginUi
