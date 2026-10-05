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

#include <functional>

/* WebMIX: the native control service.
 *
 * This is the piece that makes WebMIX a frontend *of OBS* rather than a client
 * of a plugin: it talks to libobs and to the frontend API in-process, with no
 * socket, no protocol server and no obs-websocket in the path.
 *
 * It deliberately speaks the same vocabulary the web frontend already uses -
 * `requestType` / `responseData` for calls, `eventType` / `eventData` for
 * notifications - so the UI's state reducers and high level API stay exactly as
 * they are and only the transport changes.  obs-websocket remains a supported
 * *alternative* transport (see web/src/obs-client.js) for pages served from
 * somewhere else; it is never required by this one.
 *
 * Threading: every entry point must be called from the Qt main thread.  The
 * embedded HTTP server lives there, and so do the libobs signals that feed the
 * event side, so no locking is needed - and none of the request handlers may
 * block. */

namespace WebMixControl {

/*! obs-websocket's request status codes.  The frontend surfaces them next to
 *  the error comment, so the numbers and meanings are kept identical. */
namespace Status {
constexpr int Success = 100;
constexpr int MissingRequestField = 300;
constexpr int MissingRequestData = 301;
constexpr int InvalidRequestFieldType = 302;
constexpr int RequestFieldOutOfRange = 400;
constexpr int RequestFieldEmpty = 401;
constexpr int ResourceNotFound = 600;
constexpr int ResourceAlreadyExists = 601;
constexpr int InvalidResourceState = 603;
constexpr int StudioModeNotActive = 604;
constexpr int NotSupported = 605;
} // namespace Status

/*! The outcome of one request. */
struct Response {
	bool ok = true;
	int code = Status::Success;
	QString comment;
	QJsonObject data;
};

/*! One entry of the control vocabulary. */
using Handler = void (*)(const QJsonObject &requestData, Response &response);

/*! Run one request.  An unknown request type is a failure, not a crash. */
Response Request(const QString &requestType, const QJsonObject &requestData);

/*! Every request type this build implements, sorted. */
QStringList RequestTypes();

/*! Whether a request type is implemented (used by the server and the tests). */
bool HasRequest(const QString &requestType);

/* ---- events ------------------------------------------------------------ */

/*! Event subscription bits, matching obs-websocket's so a client can ask for
 *  exactly what it needs (volume meters are the expensive one). */
namespace Intent {
constexpr int None = 0;
constexpr int General = 1 << 0;
constexpr int Config = 1 << 1;
constexpr int Scenes = 1 << 2;
constexpr int Inputs = 1 << 3;
constexpr int Transitions = 1 << 4;
constexpr int Filters = 1 << 5;
constexpr int Outputs = 1 << 6;
constexpr int SceneItems = 1 << 7;
constexpr int MediaInputs = 1 << 8;
constexpr int Vendors = 1 << 9;
constexpr int Ui = 1 << 10;
constexpr int All = (1 << 11) - 1;
constexpr int InputVolumeMeters = 1 << 16;
constexpr int InputActiveStateChanged = 1 << 17;
constexpr int InputShowStateChanged = 1 << 18;
constexpr int SceneItemTransformChanged = 1 << 19;
} // namespace Intent

/*! Receives every event whose intent the subscriber asked for. */
using EventSink = std::function<void(const QString &eventType, const QJsonObject &eventData, int intent)>;

/*! Register a sink; returns a token for Unsubscribe().  `intents` defaults to
 *  everything, including the high-volume meter and per-frame events. */
quint64 Subscribe(EventSink sink, int intents = Intent::All | Intent::InputVolumeMeters |
						Intent::InputActiveStateChanged | Intent::InputShowStateChanged |
						Intent::SceneItemTransformChanged);
void Unsubscribe(quint64 token);

/*! Send one event to every interested sink.  Also the seam the signal handlers
 *  in WebMixControlEvents.cpp use, and what the tests drive directly. */
void Emit(const QString &eventType, const QJsonObject &eventData, int intent);

/*! Connect the frontend callbacks and libobs signals.  Idempotent. */
void Start();

/*! Disconnect everything again and drop the sinks. */
void Stop();

bool IsStarted();

} // namespace WebMixControl
