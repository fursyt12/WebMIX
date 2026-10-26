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

/* WebMIX: Tools > WebSocket Server Settings, for the browser.
 *
 * obs-websocket keeps its settings inside the plugin, and the only way it
 * offers to change them while OBS runs is its own dialog: that applies them,
 * saves config.json and restarts the server. The plugin builds the dialog (and
 * its Connect Info window) when it loads and keeps it hidden until the Tools
 * menu item is used, which in web mode never happens - so the web interface
 * drives that dialog instead of reimplementing it. Its widgets are filled the
 * way the plugin fills them when the dialog opens, read or set, and Apply is
 * pressed: every check the plugin makes, and every side effect, stays the
 * plugin's own.
 *
 * Nothing here is shown on screen. */
namespace WebMixWebSocket {

/*! The settings as the dialog shows them, and the connected sessions:
 *  `{available, enabled, alerts, debug, port, portMin, portMax, portLocked,
 *  authRequired, password, passwordLocked, videoActive, sessions: [{address,
 *  duration, messages, identified}]}`. With `connectInfo`, also `connect:
 *  {address, port, password, passwordAvailable, url, qr}` from the Connect Info
 *  window (`qr` is a PNG data URL). `available` is false when obs-websocket is
 *  not loaded (safe mode, or a build without it). */
QJsonObject State(bool connectInfo);

/*! Apply any of `enabled`, `alerts`, `debug`, `port`, `authRequired` and
 *  `password`, exactly as the dialog's Apply button does. */
bool Apply(const QJsonObject &settings, QString &error);

/*! Disconnect the session connected from `address` (the dialog's Kick). */
bool Kick(const QString &address, QString &error);

} // namespace WebMixWebSocket
