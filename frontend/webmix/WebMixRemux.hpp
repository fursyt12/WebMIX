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

/* WebMIX: "Remux Recordings" without a window.
 *
 * The desktop dialog (frontend/dialogs/OBSRemux.cpp) runs a queue of recordings
 * through libobs' own remuxer on a worker thread. That is exactly what has to
 * happen here as well, but the browser cannot pick arbitrary files on the OBS
 * machine, so entries are addressed relative to the current recordings
 * directory and validated like every other file the web UI touches.
 *
 * The queue, the states and the worker semantics mirror RemuxQueueModel and
 * RemuxWorker: entries are added as `ready`, a start turns them into `pending`,
 * the worker walks them one at a time (`in_progress` -> `complete`/`error`) and
 * a stop returns the untouched entries to `ready`. */
namespace WebMixRemux {

/*! The full queue plus the current progress, as the dialog polls it. */
QJsonObject State();

/*! Queue one recording, addressed relative to the recordings directory.
 *  `format` is one of "mp4", "mov" or "mkv".
 *
 *  Fails when the file is outside the recordings directory or the format is
 *  unknown.  When the derived target already exists and `overwrite` is false
 *  the call fails with `conflict` set, so the UI can ask before replacing. */
bool Add(const QString &relativeSource, const QString &format, bool overwrite, QString &id, QString &source,
	 QString &target, bool &conflict, QString &error);

/*! Start processing the queued entries. */
bool Start(QString &error);

/*! Ask the worker to stop; the entry in progress becomes an error. */
void Stop();

/*! Drop finished entries; returns how many are left. */
int ClearFinished();

/*! Drop the whole queue, like the desktop dialog's "Clear All Items". */
void ClearAll();

/*! How many entries are queued or running (including pending ones). */
int ActiveCount();

/*! Cancel anything running and wait for the worker thread. Called on exit. */
void Shutdown();

} // namespace WebMixRemux
