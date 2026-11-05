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
#include <QStringList>

/* WebMIX: headless background updater.
 *
 * OBS's desktop updater opens a native window and (on Windows) an interactive
 * installer, neither of which can be answered on a headless studio machine.
 * WebMixUpdater checks GitHub releases for fursyt12/WebMIX in the background,
 * pre-downloads and SHA-256-verifies the matching release asset while OBS is
 * idle, serves the changelog and progress to the browser over /api/update/*
 * (and live WebMixUpdateStateChanged SSE events), installs the update without
 * touching the host desktop, and restarts WebMIX on the same address and port.
 */
namespace WebMixUpdater {

/*! Start background update checks for a running WebMixServer. */
void Start(const QString &listenHost, quint16 listenPort);

/*! Cancel any in-flight transfer and join the worker thread. */
void Shutdown();

/*! Current update state serialized for GET /api/update and SSE events. */
QJsonObject State();

/*! Trigger an asynchronous check against GitHub Releases. */
void Check(bool manual);

/*! Persist or clear `[General] WebSkippedUpdateVersion` in global.ini. */
bool SkipVersion(const QString &version, QString &error);

/*! Update periodic background check scheduling when WebAutoCheckUpdates changes. */
void OnAutoCheckChanged(bool enabled);

/*! Start downloading (if needed), verifying, installing and restarting. */
bool Install(const QString &sudoPassword, QString &error);

/*! Filled when an in-place POSIX update asks main() to exec the new binary. */
bool TakePendingRestart(QString &executable, QStringList &arguments);

} // namespace WebMixUpdater
