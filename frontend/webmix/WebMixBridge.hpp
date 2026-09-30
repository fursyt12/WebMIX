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

/* WebMIX: exposes OBS state that obs-websocket does not cover.
 *
 * obs-websocket can read and write *values* (`GetInputSettings`), but not the
 * property *schema*, so a web UI can only show raw keys.  The functions here
 * serialize the real `obs_properties_t` tree (labels, types, ranges, list
 * items, groups and per-setting visibility) so the browser can render the same
 * Properties/Filters dialogs as the desktop UI.
 *
 * They run inside the OBS process, so they use libobs and the frontend API
 * directly rather than the websocket protocol. */
namespace WebMixBridge {

/*! Property schema plus current values for an input or scene source. */
QJsonObject SourceProperties(const QString &sourceName);

/*! Property schema plus current values for a filter on a source. */
QJsonObject FilterProperties(const QString &sourceName, const QString &filterName);

/*! Property schema for a scene transition instance. */
QJsonObject TransitionProperties(const QString &transitionName);

/*! Invoke a button property. `scope` is "source" or "filter". */
bool PressButton(const QString &scope, const QString &sourceName, const QString &filterName,
		 const QString &propertyName, QString &error);

/*! Serialize an obs_properties_t tree; exposed for reuse and testing. */
QJsonObject SerializeProperties(void *properties, void *settings);

} // namespace WebMixBridge
