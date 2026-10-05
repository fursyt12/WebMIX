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

/* WebMIX: dispatch, shared lookups and the serializers the request handlers
 * build on.  Nothing here touches a socket - see WebMixServer.cpp for the two
 * transports (HTTP request/response and Server-Sent Events). */

#include "WebMixControlInternal.hpp"

#include <obs-frontend-api.h>

#include <util/platform.h>

#include <QCoreApplication>
#include <QDateTime>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QMetaObject>
#include <QString>
#include <QThread>

#include <algorithm>

namespace WebMixControl {

namespace {

/* ------------------------------------------------------------- registry -- */

/*! Where AddHandler() writes while the table is being built.  The group
 *  registrars run from the lambda below, so this is only ever non-null during
 *  that one call - which keeps the groups from depending on the table's
 *  initialisation order. */
QHash<QString, Handler> *CurrentTable = nullptr;

QHash<QString, Handler> &Handlers()
{
	/* Built once, on first use, on the main thread. */
	static QHash<QString, Handler> handlers = [] {
		QHash<QString, Handler> table;
		CurrentTable = &table;
		RegisterGeneralHandlers();
		RegisterConfigHandlers();
		RegisterSceneHandlers();
		RegisterSceneItemHandlers();
		RegisterInputHandlers();
		RegisterSourceHandlers();
		RegisterFilterHandlers();
		RegisterTransitionHandlers();
		RegisterOutputHandlers();
		CurrentTable = nullptr;
		return table;
	}();
	return handlers;
}

/* ---------------------------------------------------------------- events -- */

struct Sink {
	EventSink callback;
	int intents;
};

QHash<quint64, Sink> &Sinks()
{
	static QHash<quint64, Sink> sinks;
	return sinks;
}

quint64 &NextToken()
{
	static quint64 token = 1;
	return token;
}

bool &Started()
{
	static bool started = false;
	return started;
}

} // namespace

void AddHandler(const char *requestType, Handler handler)
{
	if (!requestType || !handler) {
		return;
	}
	if (!CurrentTable) {
		/* Registration only happens while the table is built; anything else
		 * is a programming error and must not recurse into Handlers(). */
		blog(LOG_WARNING, "[WebMIX] Handler '%s' registered outside the table build", requestType);
		return;
	}
	CurrentTable->insert(QString::fromLatin1(requestType), handler);
}

Response Request(const QString &requestType, const QJsonObject &requestData)
{
	Response response;
	const auto handler = Handlers().constFind(requestType);
	if (handler == Handlers().constEnd()) {
		Fail(response, Status::NotSupported,
		     QStringLiteral("WebMIX does not implement the request \"%1\"").arg(requestType));
		return response;
	}
	handler.value()(requestData, response);
	return response;
}

QStringList RequestTypes()
{
	QStringList types = Handlers().keys();
	std::sort(types.begin(), types.end());
	return types;
}

bool HasRequest(const QString &requestType)
{
	return Handlers().contains(requestType);
}

quint64 Subscribe(EventSink sink, int intents)
{
	const quint64 token = NextToken()++;
	Sinks().insert(token, Sink{std::move(sink), intents});
	return token;
}

void Unsubscribe(quint64 token)
{
	Sinks().remove(token);
}

void Emit(const QString &eventType, const QJsonObject &eventData, int intent)
{
	/* Not every libobs signal arrives on the main thread: transition_start and
	 * transition_stop are emitted from the render thread, and show/hide can
	 * come from the graphics thread.  The subscribers are QTcpSockets, which
	 * may only be touched from the thread that owns them - writing from
	 * anywhere else corrupts the socket's notifier and it silently stops
	 * delivering, which is exactly what happened before this hop existed.
	 *
	 * The payload is copied by value, so the queued call is safe even if the
	 * emitter is already gone by the time it runs. */
	QCoreApplication *app = QCoreApplication::instance();
	if (app && QThread::currentThread() != app->thread()) {
		QMetaObject::invokeMethod(
			app, [eventType, eventData, intent]() { Emit(eventType, eventData, intent); },
			Qt::QueuedConnection);
		return;
	}

	if (Sinks().isEmpty()) {
		return;
	}
	/* Copy the list first: a sink that throws or unsubscribes must not
	 * invalidate the iteration. */
	const QList<quint64> tokens = Sinks().keys();
	for (const quint64 token : tokens) {
		const auto sink = Sinks().constFind(token);
		if (sink == Sinks().constEnd()) {
			continue;
		}
		if ((sink->intents & intent) == 0) {
			continue;
		}
		sink->callback(eventType, eventData, intent);
	}
}

void Start()
{
	if (Started()) {
		return;
	}
	Started() = true;
	RegisterEventSources();
}

void Stop()
{
	if (!Started()) {
		return;
	}
	Started() = false;
	UnregisterEventSources();
	Sinks().clear();
}

bool IsStarted()
{
	return Started();
}

/* ------------------------------------------------------------ failures --- */

void Fail(Response &response, int code, const QString &comment)
{
	response.ok = false;
	response.code = code;
	response.comment = comment;
}

/* -------------------------------------------------------------- fields --- */

QString StringField(const QJsonObject &data, const char *name)
{
	const QJsonValue value = data.value(QString::fromLatin1(name));
	if (value.isString()) {
		return value.toString();
	}
	if (value.isDouble()) {
		/* Scene item ids and similar arrive as numbers; accept them so a
		 * caller that forgot to stringify still works. */
		return QString::number(value.toDouble(), 'g', 15);
	}
	return QString();
}

int IntField(const QJsonObject &data, const char *name, int fallback)
{
	const QJsonValue value = data.value(QString::fromLatin1(name));
	if (value.isDouble()) {
		return value.toInt(fallback);
	}
	if (value.isString()) {
		bool ok = false;
		const int parsed = value.toString().toInt(&ok);
		return ok ? parsed : fallback;
	}
	return fallback;
}

bool BoolField(const QJsonObject &data, const char *name, bool fallback)
{
	const QJsonValue value = data.value(QString::fromLatin1(name));
	return value.isBool() ? value.toBool() : fallback;
}

double DoubleField(const QJsonObject &data, const char *name, double fallback)
{
	const QJsonValue value = data.value(QString::fromLatin1(name));
	if (value.isDouble()) {
		return value.toDouble();
	}
	if (value.isString()) {
		bool ok = false;
		const double parsed = value.toString().toDouble(&ok);
		return ok ? parsed : fallback;
	}
	return fallback;
}

QString NameOrUuid(const QJsonObject &data, const char *nameField, const char *uuidField)
{
	const QString name = StringField(data, nameField);
	if (!name.isEmpty()) {
		return name;
	}
	return StringField(data, uuidField);
}

/* ------------------------------------------------------------- lookups --- */

namespace {

struct Search {
	const QString *key;
	bool matchUuid;
	obs_source_t *found;
};

bool Matches(obs_source_t *source, const QString &key, bool byUuid)
{
	if (!source) {
		return false;
	}
	const char *value = byUuid ? obs_source_get_uuid(source) : obs_source_get_name(source);
	return value && key == QString::fromUtf8(value);
}

bool SearchCallback(void *param, obs_source_t *source)
{
	auto *search = static_cast<Search *>(param);
	/* A removed source lives on until the last reference goes (the desktop
	 * undo stack holds one), but it is gone as far as the application is
	 * concerned: it must not be found, or a delete would appear to do
	 * nothing. */
	if (obs_source_removed(source)) {
		return true;
	}
	if (Matches(source, *search->key, search->matchUuid)) {
		/* Keep a reference for the caller. */
		search->found = obs_source_get_ref(source);
		return false;
	}
	return true;
}

/*! Name first, then uuid, across inputs, scenes and transition instances -
 *  which is exactly the set a request can name. */
OBSSource FindAny(const QString &nameOrUuid, bool *isScene = nullptr)
{
	if (nameOrUuid.isEmpty()) {
		return OBSSource();
	}

	for (const bool byUuid : {false, true}) {
		Search search{&nameOrUuid, byUuid, nullptr};

		obs_enum_sources(SearchCallback, &search);
		if (search.found) {
			if (isScene) {
				*isScene = false;
			}
			return OBSSource(search.found);
		}

		obs_enum_scenes(SearchCallback, &search);
		if (search.found) {
			if (isScene) {
				*isScene = true;
			}
			return OBSSource(search.found);
		}

		/* Transitions are private sources and are only visible through the
		 * frontend's own list. */
		obs_frontend_source_list transitions = {};
		obs_frontend_get_transitions(&transitions);
		for (size_t i = 0; i < transitions.sources.num; i++) {
			obs_source_t *transition = transitions.sources.array[i];
			if (!obs_source_removed(transition) && Matches(transition, nameOrUuid, byUuid)) {
				search.found = obs_source_get_ref(transition);
				break;
			}
		}
		obs_frontend_source_list_free(&transitions);
		if (search.found) {
			if (isScene) {
				*isScene = false;
			}
			return OBSSource(search.found);
		}
	}

	return OBSSource();
}

} // namespace

OBSSource FindSource(const QString &nameOrUuid)
{
	return FindAny(nameOrUuid);
}

OBSSource FindScene(const QString &nameOrUuid)
{
	OBSSource source = FindAny(nameOrUuid);
	if (source && obs_source_get_type(source) == OBS_SOURCE_TYPE_SCENE) {
		return source;
	}
	return OBSSource();
}

OBSSource FindInput(const QString &nameOrUuid)
{
	OBSSource source = FindAny(nameOrUuid);
	if (source && obs_source_get_type(source) == OBS_SOURCE_TYPE_INPUT) {
		return source;
	}
	return OBSSource();
}

OBSSource FindTransition(const QString &nameOrUuid)
{
	OBSSource source = FindAny(nameOrUuid);
	if (source && obs_source_get_type(source) == OBS_SOURCE_TYPE_TRANSITION) {
		return source;
	}
	return OBSSource();
}

OBSSource FindFilter(const QString &sourceName, const QString &filterNameOrUuid)
{
	OBSSource source = FindAny(sourceName);
	if (!source || filterNameOrUuid.isEmpty()) {
		return OBSSource();
	}

	struct FilterSearch {
		const QString *key;
		bool byUuid;
		obs_source_t *found;
	};
	FilterSearch search{&filterNameOrUuid, false, nullptr};

	/* nfilters' enumeration callback returns void: it cannot stop early, so
	 * the first match wins and later ones are ignored. */
	auto callback = [](obs_source_t *, obs_source_t *filter, void *param) {
		auto *state = static_cast<FilterSearch *>(param);
		if (!state->found && Matches(filter, *state->key, state->byUuid)) {
			state->found = obs_source_get_ref(filter);
		}
	};
	obs_source_enum_filters(source, callback, &search);
	if (!search.found) {
		search.byUuid = true;
		obs_source_enum_filters(source, callback, &search);
	}
	return OBSSource(search.found);
}

obs_scene_t *SceneOf(obs_source_t *source)
{
	if (!source) {
		return nullptr;
	}
	return obs_scene_from_source(source);
}

obs_sceneitem_t *FindSceneItem(obs_scene_t *scene, const QJsonObject &data)
{
	if (!scene) {
		return nullptr;
	}
	/* `sceneItemId` is a number in obs-websocket; accept a string too. */
	const QJsonValue value = data.value(QStringLiteral("sceneItemId"));
	int64_t id = 0;
	if (value.isDouble()) {
		id = static_cast<int64_t>(value.toDouble());
	} else if (value.isString()) {
		bool ok = false;
		id = value.toString().toLongLong(&ok);
		if (!ok) {
			return nullptr;
		}
	} else {
		return nullptr;
	}
	return obs_scene_find_sceneitem_by_id(scene, id);
}

/* -------------------------------------------------------- serialization --- */

QJsonObject ObsDataToJson(obs_data_t *data)
{
	if (!data) {
		return QJsonObject();
	}
	/* obs_data owns the canonical JSON view of itself, including nested
	 * objects and arrays, so reuse it instead of walking the tree. */
	const char *text = obs_data_get_json(data);
	if (!text) {
		return QJsonObject();
	}
	const QJsonDocument document = QJsonDocument::fromJson(QByteArray(text));
	return document.isObject() ? document.object() : QJsonObject();
}

OBSData ObsDataFromJson(const QJsonObject &object)
{
	OBSData data = obs_data_create();
	if (object.isEmpty()) {
		return data;
	}
	const QByteArray text = QJsonDocument(object).toJson(QJsonDocument::Compact);
	obs_data_t *parsed = obs_data_create_from_json(text.constData());
	if (parsed) {
		obs_data_release(data);
		return OBSData(parsed);
	}
	return data;
}

QJsonObject SceneItemTransformJson(obs_sceneitem_t *item)
{
	QJsonObject json;
	if (!item) {
		return json;
	}

	obs_transform_info info;
	obs_sceneitem_crop crop;
	obs_sceneitem_get_info2(item, &info);
	obs_sceneitem_get_crop(item, &crop);

	obs_source_t *source = obs_sceneitem_get_source(item);
	const double sourceWidth = source ? obs_source_get_width(source) : 0.0;
	const double sourceHeight = source ? obs_source_get_height(source) : 0.0;

	json["sourceWidth"] = sourceWidth;
	json["sourceHeight"] = sourceHeight;
	json["positionX"] = info.pos.x;
	json["positionY"] = info.pos.y;
	json["rotation"] = info.rot;
	json["scaleX"] = info.scale.x;
	json["scaleY"] = info.scale.y;
	json["width"] = info.scale.x * sourceWidth;
	json["height"] = info.scale.y * sourceHeight;
	json["alignment"] = static_cast<int>(info.alignment);
	/* The wire format spells the enum; `web/src/ui/dialogs.js` selects on
	 * these names, so a bare number would leave the bounding-box dropdown
	 * showing the wrong entry. */
	json["boundsType"] = BoundsTypeName(info.bounds_type);
	json["boundsAlignment"] = static_cast<int>(info.bounds_alignment);
	json["boundsWidth"] = info.bounds.x;
	json["boundsHeight"] = info.bounds.y;
	json["cropLeft"] = static_cast<int>(crop.left);
	json["cropRight"] = static_cast<int>(crop.right);
	json["cropTop"] = static_cast<int>(crop.top);
	json["cropBottom"] = static_cast<int>(crop.bottom);
	json["cropToBounds"] = info.crop_to_bounds;

	return json;
}

QJsonArray SceneItemArray(obs_scene_t *scene, bool basic)
{
	QJsonArray items;
	if (!scene) {
		return items;
	}

	struct Context {
		QJsonArray *items;
		bool basic;
	};
	Context context{&items, basic};

	auto callback = [](obs_scene_t *, obs_sceneitem_t *item, void *param) {
		auto *state = static_cast<Context *>(param);

		QJsonObject entry;
		entry["sceneItemId"] = static_cast<double>(obs_sceneitem_get_id(item));
		entry["sceneItemIndex"] = static_cast<int>(state->items->size());

		if (!state->basic) {
			obs_source_t *source = obs_sceneitem_get_source(item);
			entry["sceneItemEnabled"] = obs_sceneitem_visible(item);
			entry["sceneItemLocked"] = obs_sceneitem_locked(item);
			entry["sceneItemTransform"] = SceneItemTransformJson(item);
			entry["sceneItemBlendMode"] = static_cast<int>(obs_sceneitem_get_blending_mode(item));
			entry["sourceName"] = source ? QString::fromUtf8(obs_source_get_name(source)) : QString();
			entry["sourceUuid"] = source ? QString::fromUtf8(obs_source_get_uuid(source)) : QString();
			entry["sourceType"] = source ? static_cast<int>(obs_source_get_type(source)) : 0;
			if (source && obs_source_get_type(source) == OBS_SOURCE_TYPE_INPUT) {
				entry["inputKind"] = QString::fromUtf8(obs_source_get_id(source));
			} else {
				entry["inputKind"] = QJsonValue::Null;
			}
			if (source && obs_source_get_type(source) == OBS_SOURCE_TYPE_SCENE) {
				entry["isGroup"] = obs_source_is_group(source);
			} else {
				entry["isGroup"] = QJsonValue::Null;
			}
		}

		state->items->append(entry);
		return true;
	};
	obs_scene_enum_items(scene, callback, &context);

	return items;
}

QJsonArray SceneArray()
{
	/* obs-websocket returns the frontend's list reversed, and the store
	 * reverses it again to get the display order; keep the wire format. */
	obs_frontend_source_list scenes = {};
	obs_frontend_get_scenes(&scenes);

	QJsonArray array;
	for (size_t i = 0; i < scenes.sources.num; i++) {
		obs_source_t *scene = scenes.sources.array[i];
		QJsonObject entry;
		entry["sceneName"] = QString::fromUtf8(obs_source_get_name(scene));
		entry["sceneUuid"] = QString::fromUtf8(obs_source_get_uuid(scene));
		entry["sceneIndex"] = static_cast<int>(scenes.sources.num - i - 1);
		array.append(entry);
	}
	obs_frontend_source_list_free(&scenes);

	/* Reverse in place, matching ArrayHelper::GetSceneList(). */
	QJsonArray reversed;
	for (int i = array.size() - 1; i >= 0; i--) {
		reversed.append(array.at(i));
	}
	return reversed;
}

QJsonArray InputArray(const QString &kind)
{
	QJsonArray inputs;

	struct Context {
		QJsonArray *inputs;
		const QString *kind;
	};
	Context context{&inputs, &kind};

	auto callback = [](void *param, obs_source_t *source) {
		auto *state = static_cast<Context *>(param);
		if (obs_source_get_type(source) != OBS_SOURCE_TYPE_INPUT || obs_source_removed(source)) {
			return true;
		}
		const QString sourceKind = QString::fromUtf8(obs_source_get_id(source));
		if (!state->kind->isEmpty() && *state->kind != sourceKind) {
			return true;
		}

		QJsonObject entry;
		entry["inputName"] = QString::fromUtf8(obs_source_get_name(source));
		entry["inputUuid"] = QString::fromUtf8(obs_source_get_uuid(source));
		entry["inputKind"] = sourceKind;
		entry["unversionedInputKind"] = QString::fromUtf8(obs_source_get_unversioned_id(source));
		/* The mixer needs this to tell an audio-only device from a video
		 * source; obs-websocket reports the same field. */
		entry["inputKindCaps"] = static_cast<int>(obs_source_get_output_flags(source));
		state->inputs->append(entry);
		return true;
	};
	obs_enum_sources(callback, &context);

	return inputs;
}

QJsonArray FilterArray(obs_source_t *source)
{
	QJsonArray filters;
	if (!source) {
		return filters;
	}

	struct Context {
		QJsonArray *filters;
	};
	Context context{&filters};

	auto callback = [](obs_source_t *, obs_source_t *filter, void *param) {
		auto *state = static_cast<Context *>(param);

		QJsonObject entry;
		entry["filterEnabled"] = obs_source_enabled(filter);
		entry["filterIndex"] = static_cast<int>(state->filters->size());
		entry["filterKind"] = QString::fromUtf8(obs_source_get_id(filter));
		entry["filterName"] = QString::fromUtf8(obs_source_get_name(filter));
		OBSDataAutoRelease settings = obs_source_get_settings(filter);
		entry["filterSettings"] = ObsDataToJson(settings);
		state->filters->append(entry);
	};
	obs_source_enum_filters(source, callback, &context);

	return filters;
}

QJsonObject VideoSettingsJson()
{
	QJsonObject json;
	obs_video_info ovi = {};
	if (obs_get_video_info(&ovi)) {
		json["fpsNumerator"] = static_cast<int>(ovi.fps_num);
		json["fpsDenominator"] = static_cast<int>(ovi.fps_den);
		json["baseWidth"] = static_cast<int>(ovi.base_width);
		json["baseHeight"] = static_cast<int>(ovi.base_height);
		json["outputWidth"] = static_cast<int>(ovi.output_width);
		json["outputHeight"] = static_cast<int>(ovi.output_height);
	} else {
		json["fpsNumerator"] = QJsonValue::Null;
		json["fpsDenominator"] = QJsonValue::Null;
		json["baseWidth"] = QJsonValue::Null;
		json["baseHeight"] = QJsonValue::Null;
		json["outputWidth"] = QJsonValue::Null;
		json["outputHeight"] = QJsonValue::Null;
	}
	return json;
}

QJsonObject SourceSummary(obs_source_t *source)
{
	QJsonObject json;
	if (!source) {
		return json;
	}
	json["inputName"] = QString::fromUtf8(obs_source_get_name(source));
	json["inputUuid"] = QString::fromUtf8(obs_source_get_uuid(source));
	json["inputKind"] = QString::fromUtf8(obs_source_get_id(source));
	json["unversionedInputKind"] = QString::fromUtf8(obs_source_get_unversioned_id(source));
	return json;
}

QString OutputStateName(const char *prefix, const char *suffix)
{
	return QStringLiteral("%1_%2").arg(QString::fromLatin1(prefix), QString::fromLatin1(suffix));
}

QString BoundsTypeName(obs_bounds_type type)
{
	switch (type) {
	case OBS_BOUNDS_STRETCH:
		return QStringLiteral("OBS_BOUNDS_STRETCH");
	case OBS_BOUNDS_SCALE_INNER:
		return QStringLiteral("OBS_BOUNDS_SCALE_INNER");
	case OBS_BOUNDS_SCALE_OUTER:
		return QStringLiteral("OBS_BOUNDS_SCALE_OUTER");
	case OBS_BOUNDS_SCALE_TO_WIDTH:
		return QStringLiteral("OBS_BOUNDS_SCALE_TO_WIDTH");
	case OBS_BOUNDS_SCALE_TO_HEIGHT:
		return QStringLiteral("OBS_BOUNDS_SCALE_TO_HEIGHT");
	case OBS_BOUNDS_MAX_ONLY:
		return QStringLiteral("OBS_BOUNDS_MAX_ONLY");
	case OBS_BOUNDS_NONE:
	default:
		return QStringLiteral("OBS_BOUNDS_NONE");
	}
}

obs_bounds_type BoundsTypeFromJson(const QJsonValue &value, obs_bounds_type fallback)
{
	if (value.isDouble()) {
		const int numeric = value.toInt();
		if (numeric >= OBS_BOUNDS_NONE && numeric <= OBS_BOUNDS_MAX_ONLY) {
			return static_cast<obs_bounds_type>(numeric);
		}
		return fallback;
	}
	const QString name = value.toString();
	if (name == QLatin1String("OBS_BOUNDS_STRETCH")) {
		return OBS_BOUNDS_STRETCH;
	}
	if (name == QLatin1String("OBS_BOUNDS_SCALE_INNER")) {
		return OBS_BOUNDS_SCALE_INNER;
	}
	if (name == QLatin1String("OBS_BOUNDS_SCALE_OUTER")) {
		return OBS_BOUNDS_SCALE_OUTER;
	}
	if (name == QLatin1String("OBS_BOUNDS_SCALE_TO_WIDTH")) {
		return OBS_BOUNDS_SCALE_TO_WIDTH;
	}
	if (name == QLatin1String("OBS_BOUNDS_SCALE_TO_HEIGHT")) {
		return OBS_BOUNDS_SCALE_TO_HEIGHT;
	}
	if (name == QLatin1String("OBS_BOUNDS_MAX_ONLY")) {
		return OBS_BOUNDS_MAX_ONLY;
	}
	return fallback;
}

/* libobs deprecated the three-state monitoring enum: the accessors now log a
 * warning on every call and the setter collapses MONITOR_ONLY and
 * MONITOR_AND_OUTPUT into "enabled", so only two of the three states can
 * actually be stored.  Going through the bool avoids both the warning spam and
 * the misleading third state; the wire strings keep their historical spelling
 * so the mixer's cycle and the fallback transport agree. */
enum obs_monitoring_type MonitoringTypeOf(obs_source_t *source)
{
	return obs_source_get_monitoring_enabled(source) ? OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT
							 : OBS_MONITORING_TYPE_NONE;
}

void SetMonitoringType(obs_source_t *source, enum obs_monitoring_type type)
{
	obs_source_set_monitoring_enabled(source, type != OBS_MONITORING_TYPE_NONE);
}

QString OutputTimecode()
{
	const qint64 elapsed = QDateTime::currentMSecsSinceEpoch();
	/* obs-websocket reports a wall-clock timecode; the UI only ever shows it,
	 * so a monotonic millisecond stamp in the same format is enough. */
	const qint64 totalSeconds = elapsed / 1000;
	const qint64 hours = (totalSeconds / 3600) % 100;
	const qint64 minutes = (totalSeconds / 60) % 60;
	const qint64 seconds = totalSeconds % 60;
	const qint64 millis = elapsed % 1000;
	return QStringLiteral("%1:%2:%3.%4")
		.arg(hours, 2, 10, QLatin1Char('0'))
		.arg(minutes, 2, 10, QLatin1Char('0'))
		.arg(seconds, 2, 10, QLatin1Char('0'))
		.arg(millis, 3, 10, QLatin1Char('0'));
}

} // namespace WebMixControl
