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

#include <QJsonArray>
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

/*! Encoder choices for the Simple output mode, as the desktop settings offer them. */
QJsonObject EncoderOptions();

/*! Every hotkey with its current bindings, formatted by OBS itself. */
QJsonArray Hotkeys();

/*! Replace the bindings of one hotkey. `keyName` is an OBS key name such as
 *  "OBS_KEY_R"; `modifiers` is a comma separated list of control/alt/shift/command. */
bool SetHotkeyBinding(const QString &hotkeyName, const QString &keyName, const QString &modifiers, QString &error);

/*! Remove every binding from one hotkey. */
bool ClearHotkeyBinding(const QString &hotkeyName, QString &error);

/* ---- operations obs-websocket has no request for ---------------------- */

bool MoveScene(int fromIndex, int toIndex, QString &error);
bool AddTransition(const QString &id, const QString &name, QString &error);
bool RenameTransition(const QString &name, const QString &newName, QString &error);
bool RemoveTransition(const QString &name, QString &error);

/*! List a known directory (recordings, logs, crashes, config); `relative`
 *  selects a subdirectory and must stay inside it. */
QJsonObject ListDirectory(const QString &kind, const QString &relative);

/*! Resolve a download target inside a known directory; returns false with a reason. */
bool ResolveFileForDownload(const QString &kind, const QString &relative, QString &path, QString &error);

/*! Read the tail of a text file (used for the log viewer). */
bool ReadTextTail(const QString &kind, const QString &relative, int maxBytes, QString &text, QString &error);

/*! A C string that may be null, as a QString.  OBS returns null for optional
 *  strings, and the GNU `x ?: ""` shorthand used for it is a syntax error on
 *  MSVC, so this evaluates the expression exactly once. */
inline QString Utf8OrEmpty(const char *text)
{
	return text ? QString::fromUtf8(text) : QString();
}

/*! Serialize an obs_properties_t tree; exposed for reuse and testing. */
QJsonObject SerializeProperties(void *properties, void *settings);

} // namespace WebMixBridge
