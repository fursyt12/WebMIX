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

#include "WebMixControl.hpp"

#include <obs.hpp>

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

/* WebMIX: the seam between the control service and the per-area request
 * handlers.  Every handler group lives in its own translation unit and only
 * registers `requestType -> function` pairs; the dispatch and the shared
 * lookups/serializers live in WebMixControl.cpp. */

namespace WebMixControl {

/* ---- registration (called once, from the dispatch table's initializer) ---- */

void AddHandler(const char *requestType, Handler handler);

void RegisterGeneralHandlers();
void RegisterConfigHandlers();
void RegisterSceneHandlers();
void RegisterSceneItemHandlers();
void RegisterInputHandlers();
void RegisterSourceHandlers();
void RegisterFilterHandlers();
void RegisterTransitionHandlers();
void RegisterOutputHandlers();

/* ---- failures ----------------------------------------------------------- */

/*! Mark a response as failed with an obs-websocket status code. */
void Fail(Response &response, int code, const QString &comment = QString());

/* ---- request fields ----------------------------------------------------- */

QString StringField(const QJsonObject &data, const char *name);
int IntField(const QJsonObject &data, const char *name, int fallback = 0);
bool BoolField(const QJsonObject &data, const char *name, bool fallback = false);
double DoubleField(const QJsonObject &data, const char *name, double fallback = 0.0);

/*! The value of a field that may be spelled with a name or a uuid suffix, as
 *  obs-websocket lets clients do.  Returns the first non-empty one. */
QString NameOrUuid(const QJsonObject &data, const char *nameField, const char *uuidField);

/* ---- lookups ------------------------------------------------------------ */
/* All of these return a referenced OBSSource (empty when not found).  Names are
 * tried before uuids, which is the order obs-websocket uses. */

OBSSource FindSource(const QString &nameOrUuid);
OBSSource FindScene(const QString &nameOrUuid);
OBSSource FindInput(const QString &nameOrUuid);
OBSSource FindTransition(const QString &nameOrUuid);
OBSSource FindFilter(const QString &sourceName, const QString &filterNameOrUuid);

/*! The scene behind a source, or nullptr when it is not a scene. */
obs_scene_t *SceneOf(obs_source_t *source);

/*! The scene item a request refers to, found by `sceneItemId`, or nullptr. */
obs_sceneitem_t *FindSceneItem(obs_scene_t *scene, const QJsonObject &data);

/* ---- serialization ------------------------------------------------------ */

QJsonObject SceneItemTransformJson(obs_sceneitem_t *item);
QJsonArray SceneItemArray(obs_scene_t *scene, bool basic = false);
QJsonArray SceneArray();
QJsonArray InputArray(const QString &kind = QString());
QJsonArray FilterArray(obs_source_t *source);
QJsonObject VideoSettingsJson();

/*! obs_data_t <-> JSON, for settings-bearing requests. */
QJsonObject ObsDataToJson(obs_data_t *data);
OBSData ObsDataFromJson(const QJsonObject &object);

/*! `inputKind` for an input, `scene`/`group` handling included. */
QJsonObject SourceSummary(obs_source_t *source);

/*! Audio monitoring type.
 *
 * libobs deprecated the three-state enum in favour of a plain "monitoring
 * enabled" bool and made the old accessors log a warning on every call.  These
 * wrappers keep the historical two-state wire spelling in one place, so the
 * mixer and the fallback transport agree without the deprecated calls. */
enum obs_monitoring_type MonitoringTypeOf(obs_source_t *source);
void SetMonitoringType(obs_source_t *source, enum obs_monitoring_type type);

/*! The obs-websocket spelling of a bounds type, for transform payloads. */
QString BoundsTypeName(obs_bounds_type type);

/*! The inverse, accepting either the name or the numeric value. */
obs_bounds_type BoundsTypeFromJson(const QJsonValue &value, obs_bounds_type fallback = OBS_BOUNDS_NONE);

/* ---- shared vocabulary -------------------------------------------------- */

/*! Output state names, spelled as obs-websocket spells them:
 *  ObsOutputStateName("OBS_WEBSOCKET_OUTPUT", "STARTED") -> "..._STARTED". */
QString OutputStateName(const char *prefix, const char *suffix);

/*! Milliseconds since OBS started, for output event timecodes. */
QString OutputTimecode();

/* ---- event bridge (WebMixControlEvents.cpp) ----------------------------- */

/*! Subscribe to the frontend callbacks and the libobs signals; the inverse. */
void RegisterEventSources();
void UnregisterEventSources();

/*! Connect/disconnect the per-source signals (inputs, scenes, transitions and
 *  their filters) for one source.  Called for every existing source when the
 *  bridge starts and for every source libobs announces afterwards. */
void ConnectSourceEvents(obs_source_t *source);
void DisconnectSourceEvents(obs_source_t *source);

} // namespace WebMixControl
