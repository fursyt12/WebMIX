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

/* WebMIX: the scene and scene-item request handlers.
 *
 * The request fields, response fields and status codes are the ones
 * obs-websocket documents for the same request types, because the web client's
 * reducers and dialogs were written against them; only the transport differs.
 * Everything here is a direct call into libobs or the frontend API, so the
 * handlers stay on the main thread and never block. */

#include "WebMixControlInternal.hpp"

#include <obs-frontend-api.h>

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>

#include <cstdint>
#include <limits>

namespace WebMixControl {

namespace {

/* --------------------------------------------------------------- fields -- */

/*! True when a field is present and not JSON null.  obs-websocket treats an
 *  explicit null the same as an absent optional field. */
bool FieldPresent(const QJsonObject &data, const char *name)
{
	const QJsonValue value = data.value(QString::fromLatin1(name));
	return !value.isUndefined() && !value.isNull();
}

bool RequiredString(const QJsonObject &data, const char *name, QString &out, Response &response)
{
	const QString field = QString::fromLatin1(name);
	if (!FieldPresent(data, name)) {
		Fail(response, Status::MissingRequestField,
		     QStringLiteral("Your request is missing the `%1` field.").arg(field));
		return false;
	}

	const QJsonValue value = data.value(field);
	if (!value.isString()) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("The field value of `%1` must be a string.").arg(field));
		return false;
	}

	out = value.toString();
	if (out.isEmpty()) {
		Fail(response, Status::RequestFieldEmpty,
		     QStringLiteral("The field value of `%1` must not be empty.").arg(field));
		return false;
	}
	return true;
}

bool RequiredBool(const QJsonObject &data, const char *name, bool &out, Response &response)
{
	const QString field = QString::fromLatin1(name);
	if (!FieldPresent(data, name)) {
		Fail(response, Status::MissingRequestField,
		     QStringLiteral("Your request is missing the `%1` field.").arg(field));
		return false;
	}

	const QJsonValue value = data.value(field);
	if (!value.isBool()) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("The field value of `%1` must be boolean.").arg(field));
		return false;
	}

	out = value.toBool();
	return true;
}

/*! Read an optional number; the caller has already checked that it is present.
 *  A malformed or out-of-range value fails the response. */
bool OptionalNumber(const QJsonObject &data, const char *name, double minimum, double maximum, double &out,
		    Response &response)
{
	const QString field = QString::fromLatin1(name);
	const QJsonValue value = data.value(field);
	if (!value.isDouble()) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("The field value of `%1` must be a number.").arg(field));
		return false;
	}

	const double number = value.toDouble();
	if (number < minimum || number > maximum) {
		Fail(response, Status::RequestFieldOutOfRange,
		     QStringLiteral("The field value of `%1` is out of range.").arg(field));
		return false;
	}

	out = number;
	return true;
}

/*! Read an optional boolean; the caller has already checked that it is
 *  present. */
bool OptionalBool(const QJsonObject &data, const char *name, bool &out, Response &response)
{
	const QString field = QString::fromLatin1(name);
	const QJsonValue value = data.value(field);
	if (!value.isBool()) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("The field value of `%1` must be boolean.").arg(field));
		return false;
	}

	out = value.toBool();
	return true;
}

/* ------------------------------------------------------------ enum maps -- */

const char *BoundsTypeName(enum obs_bounds_type type)
{
	switch (type) {
	case OBS_BOUNDS_NONE:
		return "OBS_BOUNDS_NONE";
	case OBS_BOUNDS_STRETCH:
		return "OBS_BOUNDS_STRETCH";
	case OBS_BOUNDS_SCALE_INNER:
		return "OBS_BOUNDS_SCALE_INNER";
	case OBS_BOUNDS_SCALE_OUTER:
		return "OBS_BOUNDS_SCALE_OUTER";
	case OBS_BOUNDS_SCALE_TO_WIDTH:
		return "OBS_BOUNDS_SCALE_TO_WIDTH";
	case OBS_BOUNDS_SCALE_TO_HEIGHT:
		return "OBS_BOUNDS_SCALE_TO_HEIGHT";
	case OBS_BOUNDS_MAX_ONLY:
		return "OBS_BOUNDS_MAX_ONLY";
	}
	return "OBS_BOUNDS_NONE";
}

/*! The string spelling of a bounds type, accepting either the obs-websocket
 *  name or the numeric enum a caller may have round-tripped back to us. */
QString BoundsTypeString(const QJsonValue &value)
{
	if (value.isString()) {
		const QString name = value.toString();
		for (int i = OBS_BOUNDS_NONE; i <= OBS_BOUNDS_MAX_ONLY; i++) {
			if (name == QLatin1String(BoundsTypeName(static_cast<enum obs_bounds_type>(i)))) {
				return name;
			}
		}
	} else if (value.isDouble()) {
		const int number = value.toInt(-1);
		if (number >= OBS_BOUNDS_NONE && number <= OBS_BOUNDS_MAX_ONLY) {
			return QString::fromLatin1(BoundsTypeName(static_cast<enum obs_bounds_type>(number)));
		}
	}
	return QString::fromLatin1(BoundsTypeName(OBS_BOUNDS_NONE));
}

bool BoundsTypeFromJson(const QJsonValue &value, enum obs_bounds_type &out)
{
	if (value.isString()) {
		const QString name = value.toString();
		for (int i = OBS_BOUNDS_NONE; i <= OBS_BOUNDS_MAX_ONLY; i++) {
			if (name == QLatin1String(BoundsTypeName(static_cast<enum obs_bounds_type>(i)))) {
				out = static_cast<enum obs_bounds_type>(i);
				return true;
			}
		}
		return false;
	}
	if (value.isDouble()) {
		const int number = value.toInt(-1);
		if (number >= OBS_BOUNDS_NONE && number <= OBS_BOUNDS_MAX_ONLY) {
			out = static_cast<enum obs_bounds_type>(number);
			return true;
		}
	}
	return false;
}

const char *BlendModeName(enum obs_blending_type type)
{
	switch (type) {
	case OBS_BLEND_NORMAL:
		return "OBS_BLEND_NORMAL";
	case OBS_BLEND_ADDITIVE:
		return "OBS_BLEND_ADDITIVE";
	case OBS_BLEND_SUBTRACT:
		return "OBS_BLEND_SUBTRACT";
	case OBS_BLEND_SCREEN:
		return "OBS_BLEND_SCREEN";
	case OBS_BLEND_MULTIPLY:
		return "OBS_BLEND_MULTIPLY";
	case OBS_BLEND_LIGHTEN:
		return "OBS_BLEND_LIGHTEN";
	case OBS_BLEND_DARKEN:
		return "OBS_BLEND_DARKEN";
	}
	return "OBS_BLEND_NORMAL";
}

bool BlendModeFromJson(const QJsonValue &value, enum obs_blending_type &out)
{
	if (value.isString()) {
		const QString name = value.toString();
		for (int i = OBS_BLEND_NORMAL; i <= OBS_BLEND_DARKEN; i++) {
			if (name == QLatin1String(BlendModeName(static_cast<enum obs_blending_type>(i)))) {
				out = static_cast<enum obs_blending_type>(i);
				return true;
			}
		}
		return false;
	}
	if (value.isDouble()) {
		const int number = value.toInt(-1);
		if (number >= OBS_BLEND_NORMAL && number <= OBS_BLEND_DARKEN) {
			out = static_cast<enum obs_blending_type>(number);
			return true;
		}
	}
	return false;
}

/* -------------------------------------------------------------- sources -- */

QString SourceName(obs_source_t *source)
{
	const char *name = source ? obs_source_get_name(source) : nullptr;
	return name ? QString::fromUtf8(name) : QString();
}

QString SourceUuid(obs_source_t *source)
{
	const char *uuid = source ? obs_source_get_uuid(source) : nullptr;
	return uuid ? QString::fromUtf8(uuid) : QString();
}

/*! Resolve the scene (or group) a request names, or fail the response. */
OBSSource ResolveSceneNamed(const QJsonObject &data, const char *nameField, const char *uuidField, bool allowGroup,
			    Response &response)
{
	const QString key = NameOrUuid(data, nameField, uuidField);
	if (key.isEmpty()) {
		Fail(response, Status::MissingRequestField,
		     QStringLiteral("Your request must contain at least one of the following fields: `%1` or `%2`.")
			     .arg(QString::fromLatin1(nameField), QString::fromLatin1(uuidField)));
		return OBSSource();
	}

	OBSSource source = FindScene(key);
	if (!source) {
		/* FindScene() is also empty for a source that exists but is not a
		 * scene; keep that distinct from "not found", as obs-websocket does. */
		if (FindSource(key)) {
			Fail(response, Status::InvalidResourceState, "The specified source is not a scene.");
		} else {
			Fail(response, Status::ResourceNotFound,
			     QStringLiteral("No source was found by the name or UUID `%1`.").arg(key));
		}
		return OBSSource();
	}
	if (!allowGroup && obs_source_is_group(source)) {
		Fail(response, Status::InvalidResourceState, "The specified source is not a scene. (Is group)");
		return OBSSource();
	}
	return source;
}

OBSSource ResolveScene(const QJsonObject &data, bool allowGroup, Response &response)
{
	return ResolveSceneNamed(data, "sceneName", "sceneUuid", allowGroup, response);
}

/*! Resolve `sceneItemId` against a scene the caller keeps alive. */
obs_sceneitem_t *ResolveSceneItem(obs_scene_t *scene, const QJsonObject &data, Response &response)
{
	if (!scene) {
		Fail(response, Status::InvalidResourceState, "The specified source is not a scene.");
		return nullptr;
	}
	if (!FieldPresent(data, "sceneItemId")) {
		Fail(response, Status::MissingRequestField, "Your request is missing the `sceneItemId` field.");
		return nullptr;
	}

	obs_sceneitem_t *item = FindSceneItem(scene, data);
	if (!item) {
		Fail(response, Status::ResourceNotFound,
		     QStringLiteral("No scene item was found in `%1` with the given id.")
			     .arg(SourceName(obs_scene_get_source(scene))));
		return nullptr;
	}
	return item;
}

/*! The first (or, with offset -1, the last) item whose source matches a name or
 *  uuid, mirroring obs-websocket's searchOffset semantics. */
obs_sceneitem_t *FindSceneItemBySource(obs_scene_t *scene, const QString &key, bool byUuid, int offset)
{
	if (!scene || key.isEmpty()) {
		return nullptr;
	}

	struct Context {
		const QString *key;
		bool byUuid;
		int offset;
		obs_sceneitem_t *found;
	};
	Context context{&key, byUuid, offset, nullptr};

	auto callback = [](obs_scene_t *, obs_sceneitem_t *item, void *param) {
		auto *state = static_cast<Context *>(param);
		obs_source_t *source = obs_sceneitem_get_source(item);
		const char *value = nullptr;
		if (source) {
			value = state->byUuid ? obs_source_get_uuid(source) : obs_source_get_name(source);
		}
		if (!value || *state->key != QString::fromUtf8(value)) {
			return true;
		}

		if (state->offset > 0) {
			state->offset--;
			return true;
		}

		state->found = item;
		/* offset == -1 asks for the last match, so keep enumerating. */
		return state->offset == -1;
	};
	obs_scene_enum_items(scene, callback, &context);

	return context.found;
}

/*! Add a source to a scene, optionally applying a transform and crop, then set
 *  its visibility.  obs_scene_add() hands back the scene's own reference, so
 *  the caller must not release the result. */
obs_sceneitem_t *AddSceneItem(obs_scene_t *scene, obs_source_t *source, bool visible,
			      const obs_transform_info *transform, const obs_sceneitem_crop *crop)
{
	if (!scene || !source) {
		return nullptr;
	}

	obs_sceneitem_t *item = obs_scene_add(scene, source);
	if (!item) {
		return nullptr;
	}
	if (transform) {
		obs_sceneitem_set_info2(item, transform);
	}
	if (crop) {
		obs_sceneitem_set_crop(item, crop);
	}
	obs_sceneitem_set_visible(item, visible);
	return item;
}

/* --------------------------------------------------------------- scenes -- */

void HandleGetSceneList(const QJsonObject &, Response &response)
{
	/* The frontend getters hand over a reference, so take it with the
	 * auto-release wrapper rather than the safe-ref one. */
	OBSSourceAutoRelease program = obs_frontend_get_current_scene();
	if (program) {
		response.data["currentProgramSceneName"] = SourceName(program);
		response.data["currentProgramSceneUuid"] = SourceUuid(program);
	} else {
		response.data["currentProgramSceneName"] = QJsonValue::Null;
		response.data["currentProgramSceneUuid"] = QJsonValue::Null;
	}

	OBSSourceAutoRelease preview = obs_frontend_get_current_preview_scene();
	if (preview) {
		response.data["currentPreviewSceneName"] = SourceName(preview);
		response.data["currentPreviewSceneUuid"] = SourceUuid(preview);
	} else {
		response.data["currentPreviewSceneName"] = QJsonValue::Null;
		response.data["currentPreviewSceneUuid"] = QJsonValue::Null;
	}

	response.data["scenes"] = SceneArray();
}

void HandleGetCurrentProgramScene(const QJsonObject &, Response &response)
{
	OBSSourceAutoRelease program = obs_frontend_get_current_scene();
	if (!program) {
		Fail(response, Status::InvalidResourceState, "OBS does not have a current program scene.");
		return;
	}

	const QString name = SourceName(program);
	const QString uuid = SourceUuid(program);
	response.data["sceneName"] = name;
	response.data["sceneUuid"] = uuid;
	response.data["currentProgramSceneName"] = name;
	response.data["currentProgramSceneUuid"] = uuid;
}

void HandleSetCurrentProgramScene(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, false, response);
	if (!scene) {
		return;
	}
	obs_frontend_set_current_scene(scene);
}

void HandleGetCurrentPreviewScene(const QJsonObject &, Response &response)
{
	if (!obs_frontend_preview_program_mode_active()) {
		Fail(response, Status::StudioModeNotActive, "Studio mode is not active.");
		return;
	}

	OBSSourceAutoRelease preview = obs_frontend_get_current_preview_scene();
	if (!preview) {
		Fail(response, Status::InvalidResourceState, "OBS does not have a current preview scene.");
		return;
	}

	const QString name = SourceName(preview);
	const QString uuid = SourceUuid(preview);
	response.data["sceneName"] = name;
	response.data["sceneUuid"] = uuid;
	response.data["currentPreviewSceneName"] = name;
	response.data["currentPreviewSceneUuid"] = uuid;
	/* The web client reads these shorter aliases when it re-reads the preview
	 * scene after enabling studio mode; obs-websocket clients ignore them. */
	response.data["currentSceneName"] = name;
	response.data["currentSceneUuid"] = uuid;
}

void HandleSetCurrentPreviewScene(const QJsonObject &data, Response &response)
{
	if (!obs_frontend_preview_program_mode_active()) {
		Fail(response, Status::StudioModeNotActive, "Studio mode is not active.");
		return;
	}

	OBSSource scene = ResolveScene(data, false, response);
	if (!scene) {
		return;
	}
	obs_frontend_set_current_preview_scene(scene);
}

void HandleCreateScene(const QJsonObject &data, Response &response)
{
	QString sceneName;
	if (!RequiredString(data, "sceneName", sceneName, response)) {
		return;
	}
	if (FindSource(sceneName)) {
		Fail(response, Status::ResourceAlreadyExists, "A source already exists by that scene name.");
		return;
	}

	obs_canvas_t *canvas = obs_get_main_canvas();
	if (!canvas) {
		Fail(response, Status::InvalidResourceState, "OBS does not have a main canvas.");
		return;
	}

	const QByteArray name = sceneName.toUtf8();
	OBSSceneAutoRelease scene = obs_canvas_scene_create(canvas, name.constData());
	if (!scene) {
		Fail(response, Status::InvalidResourceState, "Failed to create the scene.");
		return;
	}

	response.data["sceneUuid"] = SourceUuid(obs_scene_get_source(scene));
}

void HandleRemoveScene(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, false, response);
	if (!scene) {
		return;
	}

	/* The last scene cannot be removed: the frontend always needs a program
	 * scene to fall back to. */
	obs_frontend_source_list scenes = {};
	obs_frontend_get_scenes(&scenes);
	const size_t count = scenes.sources.num;
	obs_frontend_source_list_free(&scenes);
	if (count < 2) {
		Fail(response, Status::InvalidResourceState, "You cannot remove the last scene in the collection.");
		return;
	}

	obs_source_remove(scene);
}

void HandleSetSceneName(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, false, response);
	if (!scene) {
		return;
	}

	QString newSceneName;
	if (!RequiredString(data, "newSceneName", newSceneName, response)) {
		return;
	}
	if (newSceneName == SourceName(scene)) {
		return;
	}

	OBSSource existing = FindSource(newSceneName);
	if (existing && static_cast<obs_source_t *>(existing) != static_cast<obs_source_t *>(scene)) {
		Fail(response, Status::ResourceAlreadyExists, "A source already exists by that new scene name.");
		return;
	}

	const QByteArray name = newSceneName.toUtf8();
	obs_source_set_name(scene, name.constData());
}

void HandleGetGroupList(const QJsonObject &, Response &response)
{
	obs_canvas_t *canvas = obs_get_main_canvas();
	if (!canvas) {
		Fail(response, Status::InvalidResourceState, "OBS does not have a main canvas.");
		return;
	}

	/* Groups are scenes that a scene owns; the canvas holds all of them, so
	 * this is obs-websocket's GetCanvasGroupList for the main canvas. */
	QJsonArray groups;
	auto callback = [](void *param, obs_source_t *source) {
		auto *array = static_cast<QJsonArray *>(param);
		if (obs_source_is_group(source)) {
			array->append(SourceName(source));
		}
		return true;
	};
	obs_canvas_enum_scenes(canvas, callback, &groups);

	response.data["groups"] = groups;
}

void HandleGetStudioModeEnabled(const QJsonObject &, Response &response)
{
	response.data["studioModeEnabled"] = obs_frontend_preview_program_mode_active();
}

void HandleSetStudioModeEnabled(const QJsonObject &data, Response &response)
{
	bool enabled = false;
	if (!RequiredBool(data, "studioModeEnabled", enabled, response)) {
		return;
	}

	/* Only touch the frontend when the state actually changes. */
	if (obs_frontend_preview_program_mode_active() != enabled) {
		obs_frontend_set_preview_program_mode(enabled);
	}
}

void HandleTriggerStudioModeTransition(const QJsonObject &, Response &response)
{
	if (!obs_frontend_preview_program_mode_active()) {
		Fail(response, Status::StudioModeNotActive, "Studio mode is not active.");
		return;
	}

	/* Same as the Transition button: queues the work on the UI thread. */
	obs_frontend_preview_program_trigger_transition();
}

/* ----------------------------------------------------------- scene items -- */

void HandleGetSceneItemList(const QJsonObject &data, Response &response)
{
	/* Groups and nested scenes are scenes too; SceneItemArray() walks any of
	 * them, so a group's own items stay reachable. */
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}

	response.data["sceneItems"] = SceneItemArray(SceneOf(scene));
}

void HandleGetSceneItemId(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}

	QString key;
	bool byUuid = false;
	if (!StringField(data, "sourceName").isEmpty()) {
		key = StringField(data, "sourceName");
	} else if (!StringField(data, "sourceUuid").isEmpty()) {
		key = StringField(data, "sourceUuid");
		byUuid = true;
	} else {
		Fail(response, Status::MissingRequestField,
		     "Your request must contain at least one of the following fields: `sourceName` or `sourceUuid`.");
		return;
	}

	int offset = 0;
	if (FieldPresent(data, "searchOffset")) {
		double number = 0;
		if (!OptionalNumber(data, "searchOffset", -1.0, std::numeric_limits<int>::max(), number, response)) {
			return;
		}
		offset = static_cast<int>(number);
	}

	obs_sceneitem_t *item = FindSceneItemBySource(SceneOf(scene), key, byUuid, offset);
	if (!item) {
		Fail(response, Status::ResourceNotFound,
		     "No scene items were found in the specified scene by that name or offset.");
		return;
	}

	response.data["sceneItemId"] = static_cast<double>(obs_sceneitem_get_id(item));
}

void HandleGetSceneItemEnabled(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	response.data["sceneItemEnabled"] = obs_sceneitem_visible(item);
}

void HandleSetSceneItemEnabled(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	bool enabled = false;
	if (!RequiredBool(data, "sceneItemEnabled", enabled, response)) {
		return;
	}
	obs_sceneitem_set_visible(item, enabled);
}

void HandleGetSceneItemLocked(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	response.data["sceneItemLocked"] = obs_sceneitem_locked(item);
}

void HandleSetSceneItemLocked(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	bool locked = false;
	if (!RequiredBool(data, "sceneItemLocked", locked, response)) {
		return;
	}
	obs_sceneitem_set_locked(item, locked);
}

void HandleGetSceneItemIndex(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	response.data["sceneItemIndex"] = obs_sceneitem_get_order_position(item);
}

void HandleSetSceneItemIndex(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	if (!FieldPresent(data, "sceneItemIndex")) {
		Fail(response, Status::MissingRequestField, "Your request is missing the `sceneItemIndex` field.");
		return;
	}
	double number = 0;
	if (!OptionalNumber(data, "sceneItemIndex", 0.0, 8192.0, number, response)) {
		return;
	}
	obs_sceneitem_set_order_position(item, static_cast<int>(number));
}

void HandleGetSceneItemTransform(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	QJsonObject transform = SceneItemTransformJson(item);
	/* The shared serializer reports the raw enum; obs-websocket and the web
	 * transform dialog both use the string spelling, so normalize it. */
	transform["boundsType"] = BoundsTypeString(transform.value(QStringLiteral("boundsType")));
	response.data["sceneItemTransform"] = transform;
}

void HandleSetSceneItemTransform(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	if (!FieldPresent(data, "sceneItemTransform")) {
		Fail(response, Status::MissingRequestField, "Your request is missing the `sceneItemTransform` field.");
		return;
	}
	const QJsonValue transformValue = data.value(QStringLiteral("sceneItemTransform"));
	if (!transformValue.isObject()) {
		Fail(response, Status::InvalidRequestFieldType,
		     "The field value of `sceneItemTransform` must be an object.");
		return;
	}
	const QJsonObject transform = transformValue.toObject();
	if (transform.isEmpty()) {
		Fail(response, Status::RequestFieldEmpty, "The field value of `sceneItemTransform` must not be empty.");
		return;
	}

	/* Apply the fields the caller sent on top of the item's current values, so
	 * a partial transform object means a partial update. */
	obs_transform_info info;
	obs_sceneitem_get_info2(item, &info);
	obs_sceneitem_crop crop;
	obs_sceneitem_get_crop(item, &crop);

	obs_source_t *source = obs_sceneitem_get_source(item);
	const double sourceWidth = source ? obs_source_get_width(source) : 0.0;
	const double sourceHeight = source ? obs_source_get_height(source) : 0.0;

	bool transformChanged = false;
	bool cropChanged = false;

	if (FieldPresent(transform, "positionX")) {
		double number = 0;
		if (!OptionalNumber(transform, "positionX", -90001.0, 90001.0, number, response)) {
			return;
		}
		info.pos.x = static_cast<float>(number);
		transformChanged = true;
	}
	if (FieldPresent(transform, "positionY")) {
		double number = 0;
		if (!OptionalNumber(transform, "positionY", -90001.0, 90001.0, number, response)) {
			return;
		}
		info.pos.y = static_cast<float>(number);
		transformChanged = true;
	}
	if (FieldPresent(transform, "rotation")) {
		double number = 0;
		if (!OptionalNumber(transform, "rotation", -360.0, 360.0, number, response)) {
			return;
		}
		info.rot = static_cast<float>(number);
		transformChanged = true;
	}
	if (FieldPresent(transform, "scaleX")) {
		double number = 0;
		if (!OptionalNumber(transform, "scaleX", -std::numeric_limits<double>::max(),
				    std::numeric_limits<double>::max(), number, response)) {
			return;
		}
		const double finalWidth = number * sourceWidth;
		if (!(finalWidth > -90001.0 && finalWidth < 90001.0)) {
			Fail(response, Status::RequestFieldOutOfRange,
			     "The field `scaleX` is too small or large for the current source resolution.");
			return;
		}
		info.scale.x = static_cast<float>(number);
		transformChanged = true;
	}
	if (FieldPresent(transform, "scaleY")) {
		double number = 0;
		if (!OptionalNumber(transform, "scaleY", -std::numeric_limits<double>::max(),
				    std::numeric_limits<double>::max(), number, response)) {
			return;
		}
		const double finalHeight = number * sourceHeight;
		if (!(finalHeight > -90001.0 && finalHeight < 90001.0)) {
			Fail(response, Status::RequestFieldOutOfRange,
			     "The field `scaleY` is too small or large for the current source resolution.");
			return;
		}
		info.scale.y = static_cast<float>(number);
		transformChanged = true;
	}
	if (FieldPresent(transform, "alignment")) {
		double number = 0;
		if (!OptionalNumber(transform, "alignment", 0.0, std::numeric_limits<uint32_t>::max(), number,
				    response)) {
			return;
		}
		info.alignment = static_cast<uint32_t>(number);
		transformChanged = true;
	}
	if (FieldPresent(transform, "boundsType")) {
		enum obs_bounds_type boundsType;
		if (!BoundsTypeFromJson(transform.value(QStringLiteral("boundsType")), boundsType)) {
			Fail(response, Status::InvalidRequestFieldType, "The field `boundsType` has an invalid value.");
			return;
		}
		info.bounds_type = boundsType;
		transformChanged = true;
	}
	if (FieldPresent(transform, "boundsAlignment")) {
		double number = 0;
		if (!OptionalNumber(transform, "boundsAlignment", 0.0, std::numeric_limits<uint32_t>::max(), number,
				    response)) {
			return;
		}
		info.bounds_alignment = static_cast<uint32_t>(number);
		transformChanged = true;
	}
	/* Zero is a legitimate "no bounds" value that GetSceneItemTransform()
	 * reports and the web transform dialog sends straight back, so the bounds
	 * size is allowed to be zero even though obs-websocket clamps it to one. */
	if (FieldPresent(transform, "boundsWidth")) {
		double number = 0;
		if (!OptionalNumber(transform, "boundsWidth", 0.0, 90001.0, number, response)) {
			return;
		}
		info.bounds.x = static_cast<float>(number);
		transformChanged = true;
	}
	if (FieldPresent(transform, "boundsHeight")) {
		double number = 0;
		if (!OptionalNumber(transform, "boundsHeight", 0.0, 90001.0, number, response)) {
			return;
		}
		info.bounds.y = static_cast<float>(number);
		transformChanged = true;
	}
	if (FieldPresent(transform, "cropLeft")) {
		double number = 0;
		if (!OptionalNumber(transform, "cropLeft", 0.0, 100000.0, number, response)) {
			return;
		}
		crop.left = static_cast<int>(number);
		cropChanged = true;
	}
	if (FieldPresent(transform, "cropRight")) {
		double number = 0;
		if (!OptionalNumber(transform, "cropRight", 0.0, 100000.0, number, response)) {
			return;
		}
		crop.right = static_cast<int>(number);
		cropChanged = true;
	}
	if (FieldPresent(transform, "cropTop")) {
		double number = 0;
		if (!OptionalNumber(transform, "cropTop", 0.0, 100000.0, number, response)) {
			return;
		}
		crop.top = static_cast<int>(number);
		cropChanged = true;
	}
	if (FieldPresent(transform, "cropBottom")) {
		double number = 0;
		if (!OptionalNumber(transform, "cropBottom", 0.0, 100000.0, number, response)) {
			return;
		}
		crop.bottom = static_cast<int>(number);
		cropChanged = true;
	}
	if (FieldPresent(transform, "cropToBounds")) {
		bool cropToBounds = false;
		if (!OptionalBool(transform, "cropToBounds", cropToBounds, response)) {
			return;
		}
		info.crop_to_bounds = cropToBounds;
		transformChanged = true;
	}

	if (!transformChanged && !cropChanged) {
		Fail(response, Status::MissingRequestField, "You have not provided any valid transform changes.");
		return;
	}

	if (transformChanged) {
		obs_sceneitem_set_info2(item, &info);
	}
	if (cropChanged) {
		obs_sceneitem_set_crop(item, &crop);
	}
}

void HandleCreateSceneItem(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}

	const QString key = NameOrUuid(data, "sourceName", "sourceUuid");
	if (key.isEmpty()) {
		Fail(response, Status::MissingRequestField,
		     "Your request must contain at least one of the following fields: `sourceName` or `sourceUuid`.");
		return;
	}

	OBSSource source = FindSource(key);
	if (!source) {
		Fail(response, Status::ResourceNotFound,
		     QStringLiteral("No source was found by the name or UUID `%1`.").arg(key));
		return;
	}
	if (static_cast<obs_source_t *>(source) == static_cast<obs_source_t *>(scene)) {
		Fail(response, Status::InvalidResourceState, "You cannot create scene item of a scene within itself.");
		return;
	}

	bool enabled = true;
	if (FieldPresent(data, "sceneItemEnabled")) {
		if (!OptionalBool(data, "sceneItemEnabled", enabled, response)) {
			return;
		}
	}

	obs_sceneitem_t *item = AddSceneItem(SceneOf(scene), source, enabled, nullptr, nullptr);
	if (!item) {
		Fail(response, Status::InvalidResourceState, "Failed to create the scene item.");
		return;
	}

	response.data["sceneItemId"] = static_cast<double>(obs_sceneitem_get_id(item));
}

void HandleRemoveSceneItem(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	obs_sceneitem_remove(item);
}

void HandleDuplicateSceneItem(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	/* Without a destination the copy lands in the item's own scene. */
	obs_scene_t *destination = obs_sceneitem_get_scene(item);
	OBSSource destinationScene;
	if (FieldPresent(data, "destinationSceneName") || FieldPresent(data, "destinationSceneUuid")) {
		destinationScene =
			ResolveSceneNamed(data, "destinationSceneName", "destinationSceneUuid", true, response);
		if (!destinationScene) {
			return;
		}
		destination = SceneOf(destinationScene);
	}
	if (!destination) {
		Fail(response, Status::InvalidResourceState, "The destination is not a scene.");
		return;
	}

	/* A scene can only hold one instance of a group. */
	if (obs_sceneitem_is_group(item) && destination == obs_sceneitem_get_scene(item)) {
		Fail(response, Status::InvalidResourceState, "Scenes may only have one instance of a group.");
		return;
	}

	obs_source_t *source = obs_sceneitem_get_source(item);
	const bool visible = obs_sceneitem_visible(item);
	obs_transform_info info;
	obs_sceneitem_crop crop;
	obs_sceneitem_get_info2(item, &info);
	obs_sceneitem_get_crop(item, &crop);

	obs_sceneitem_t *duplicate = AddSceneItem(destination, source, visible, &info, &crop);
	if (!duplicate) {
		Fail(response, Status::InvalidResourceState, "Failed to create the scene item.");
		return;
	}

	response.data["sceneItemId"] = static_cast<double>(obs_sceneitem_get_id(duplicate));
}

void HandleGetSceneItemBlendMode(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	response.data["sceneItemBlendMode"] = QString::fromLatin1(BlendModeName(obs_sceneitem_get_blending_mode(item)));
}

void HandleSetSceneItemBlendMode(const QJsonObject &data, Response &response)
{
	OBSSource scene = ResolveScene(data, true, response);
	if (!scene) {
		return;
	}
	obs_sceneitem_t *item = ResolveSceneItem(SceneOf(scene), data, response);
	if (!item) {
		return;
	}

	if (!FieldPresent(data, "sceneItemBlendMode")) {
		Fail(response, Status::MissingRequestField, "Your request is missing the `sceneItemBlendMode` field.");
		return;
	}

	enum obs_blending_type blendMode;
	if (!BlendModeFromJson(data.value(QStringLiteral("sceneItemBlendMode")), blendMode)) {
		Fail(response, Status::InvalidRequestFieldType, "The field `sceneItemBlendMode` has an invalid value.");
		return;
	}
	obs_sceneitem_set_blending_mode(item, blendMode);
}

} // namespace

void RegisterSceneHandlers()
{
	AddHandler("GetSceneList", &HandleGetSceneList);
	AddHandler("GetCurrentProgramScene", &HandleGetCurrentProgramScene);
	AddHandler("SetCurrentProgramScene", &HandleSetCurrentProgramScene);
	AddHandler("GetCurrentPreviewScene", &HandleGetCurrentPreviewScene);
	AddHandler("SetCurrentPreviewScene", &HandleSetCurrentPreviewScene);
	AddHandler("CreateScene", &HandleCreateScene);
	AddHandler("RemoveScene", &HandleRemoveScene);
	AddHandler("SetSceneName", &HandleSetSceneName);
	AddHandler("GetGroupList", &HandleGetGroupList);
	AddHandler("GetStudioModeEnabled", &HandleGetStudioModeEnabled);
	AddHandler("SetStudioModeEnabled", &HandleSetStudioModeEnabled);
	AddHandler("TriggerStudioModeTransition", &HandleTriggerStudioModeTransition);
}

void RegisterSceneItemHandlers()
{
	AddHandler("GetSceneItemList", &HandleGetSceneItemList);
	AddHandler("GetSceneItemId", &HandleGetSceneItemId);
	AddHandler("GetSceneItemEnabled", &HandleGetSceneItemEnabled);
	AddHandler("SetSceneItemEnabled", &HandleSetSceneItemEnabled);
	AddHandler("GetSceneItemLocked", &HandleGetSceneItemLocked);
	AddHandler("SetSceneItemLocked", &HandleSetSceneItemLocked);
	AddHandler("GetSceneItemIndex", &HandleGetSceneItemIndex);
	AddHandler("SetSceneItemIndex", &HandleSetSceneItemIndex);
	AddHandler("GetSceneItemTransform", &HandleGetSceneItemTransform);
	AddHandler("SetSceneItemTransform", &HandleSetSceneItemTransform);
	AddHandler("CreateSceneItem", &HandleCreateSceneItem);
	AddHandler("RemoveSceneItem", &HandleRemoveSceneItem);
	AddHandler("DuplicateSceneItem", &HandleDuplicateSceneItem);
	AddHandler("GetSceneItemBlendMode", &HandleGetSceneItemBlendMode);
	AddHandler("SetSceneItemBlendMode", &HandleSetSceneItemBlendMode);
}

} // namespace WebMixControl
