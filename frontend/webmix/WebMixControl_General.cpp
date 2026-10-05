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

/* WebMIX: the general requests (version, statistics, hotkeys and the input
 * dialogs) and the configuration requests (scene collections, profiles, video,
 * stream service and the record directory).
 *
 * These read and write OBS itself rather than one of its objects, so they go
 * through libobs and the frontend API directly.  The response fields and the
 * "already running" refusals mirror obs-websocket's handlers of the same name,
 * because the web frontend parses those exact field names.
 *
 * WebMixControl.hpp names the subset of obs-websocket status codes this
 * service uses.  A few handlers need one it does not name (OutputRunning,
 * ResourceCreationFailed, NotEnoughResources, CannotAct); those report the
 * closest named code instead.  The frontend shows the code next to the comment
 * but never branches on it. */

#include "WebMixControlInternal.hpp"

#include "WebMixBridge.hpp"

#include <obs-frontend-api.h>
#include <obs-interaction.h>
#include <obs.hpp>

#include <util/config-file.h>
#include <util/platform.h>
#include <util/util.hpp>

#include <QByteArray>
#include <QImageWriter>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QStringList>
#include <QSysInfo>

namespace WebMixControl {

namespace {

/* ------------------------------------------------------------ utilities -- */

/*! The frontend returns its string lists as one bmalloc'd block, so BPtr is
 *  enough - the individual strings live inside it and must not be freed. */
QStringList FrontendStringList(char **values)
{
	QStringList names;
	if (!values) {
		return names;
	}
	for (size_t index = 0; values[index]; index++) {
		names.append(QString::fromUtf8(values[index]));
	}
	return names;
}

QStringList SceneCollectionNames()
{
	BPtr<char *> names = obs_frontend_get_scene_collections();
	return FrontendStringList(names.Get());
}

QStringList ProfileNames()
{
	BPtr<char *> names = obs_frontend_get_profiles();
	return FrontendStringList(names.Get());
}

QString CurrentSceneCollection()
{
	BPtr<char> name = obs_frontend_get_current_scene_collection();
	return WebMixBridge::Utf8OrEmpty(name.Get());
}

QString CurrentProfile()
{
	BPtr<char> name = obs_frontend_get_current_profile();
	return WebMixBridge::Utf8OrEmpty(name.Get());
}

QString CurrentRecordDirectory()
{
	BPtr<char> path = obs_frontend_get_current_record_output_path();
	return WebMixBridge::Utf8OrEmpty(path.Get());
}

/*! A config value as JSON, with null for the C API's "not set". */
QJsonValue ConfigString(const char *value)
{
	return value ? QJsonValue(QString::fromUtf8(value)) : QJsonValue(QJsonValue::Null);
}

/*! obs_data as JSON including its registered defaults.  The shared serializer
 *  omits them, but obs-websocket asks for them when it reports the stream
 *  service: a fresh rtmp_common service keeps its server and service name as
 *  defaults, and the stream dialog shows those instead of empty boxes. */
QJsonObject ObsDataToJsonWithDefaults(obs_data_t *data)
{
	if (!data) {
		return QJsonObject();
	}
	const char *text = obs_data_get_json_with_defaults(data);
	if (!text) {
		return QJsonObject();
	}
	const QJsonDocument document = QJsonDocument::fromJson(QByteArray(text));
	return document.isObject() ? document.object() : QJsonObject();
}

/*! The profile both the profile parameters and the Video section live in.  OBS
 *  always has one once the frontend is up, but a null here must not crash. */
config_t *ActiveProfileConfig(Response &response)
{
	config_t *config = obs_frontend_get_profile_config();
	if (!config) {
		Fail(response, Status::InvalidResourceState, QStringLiteral("OBS has no active profile."));
	}
	return config;
}

/*! Read an optional integer field with obs-websocket's bounds.  A `maximum` of
 *  0 means "no upper bound"; an absent field leaves `value` alone.  Fails the
 *  response and returns false when the field is present but unusable. */
bool OptionalIntField(const QJsonObject &data, const char *name, int minimum, int maximum, int &value,
		      Response &response)
{
	const QString key = QString::fromLatin1(name);
	if (!data.contains(key)) {
		return true;
	}

	const QJsonValue field = data.value(key);
	if (!field.isDouble()) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("The field `%1` must be a number.").arg(key));
		return false;
	}

	const int parsed = field.toInt();
	if (parsed < minimum || (maximum > 0 && parsed > maximum)) {
		Fail(response, Status::RequestFieldOutOfRange,
		     QStringLiteral("The field `%1` is out of range.").arg(key));
		return false;
	}

	value = parsed;
	return true;
}

/*! CPU usage is a delta between two samples, so the sample object has to
 *  outlive a request; one per process is what OBS itself keeps. */
struct CpuUsageSample {
	os_cpu_usage_info_t *info = os_cpu_usage_info_start();

	~CpuUsageSample() { os_cpu_usage_info_destroy(info); }
};

double CpuUsage()
{
	static CpuUsageSample sample;
	return os_cpu_usage_info_query(sample.info);
}

/* ---------------------------------------------------------------- hotkeys -- */

struct HotkeySearch {
	const QString *name;
	const QString *context;
	obs_hotkey_id *found;
};

/*! Whether a hotkey belongs to `context`.  Mirrors obs-websocket: only the
 *  source/output/encoder/service registerers carry a name, and a hotkey the
 *  frontend registered ignores the context entirely. */
bool HotkeyMatchesContext(obs_hotkey_t *hotkey, const QString &context)
{
	if (context.isEmpty()) {
		return true;
	}

	switch (obs_hotkey_get_registerer_type(hotkey)) {
	case OBS_HOTKEY_REGISTERER_SOURCE: {
		OBSSourceAutoRelease source =
			obs_weak_source_get_source(static_cast<obs_weak_source_t *>(obs_hotkey_get_registerer(hotkey)));
		return source && context == WebMixBridge::Utf8OrEmpty(obs_source_get_name(source));
	}
	case OBS_HOTKEY_REGISTERER_OUTPUT: {
		OBSOutputAutoRelease output =
			obs_weak_output_get_output(static_cast<obs_weak_output_t *>(obs_hotkey_get_registerer(hotkey)));
		return output && context == WebMixBridge::Utf8OrEmpty(obs_output_get_name(output));
	}
	case OBS_HOTKEY_REGISTERER_ENCODER: {
		OBSEncoderAutoRelease encoder = obs_weak_encoder_get_encoder(
			static_cast<obs_weak_encoder_t *>(obs_hotkey_get_registerer(hotkey)));
		return encoder && context == WebMixBridge::Utf8OrEmpty(obs_encoder_get_name(encoder));
	}
	case OBS_HOTKEY_REGISTERER_SERVICE: {
		OBSServiceAutoRelease service = obs_weak_service_get_service(
			static_cast<obs_weak_service_t *>(obs_hotkey_get_registerer(hotkey)));
		return service && context == WebMixBridge::Utf8OrEmpty(obs_service_get_name(service));
	}
	default:
		return true;
	}
}

obs_hotkey_id HotkeyIdByName(const QString &name, const QString &context)
{
	obs_hotkey_id found = OBS_INVALID_HOTKEY_ID;
	HotkeySearch search{&name, &context, &found};

	obs_enum_hotkeys(
		[](void *data, obs_hotkey_id id, obs_hotkey_t *hotkey) {
			auto *state = static_cast<HotkeySearch *>(data);
			if (*state->name != WebMixBridge::Utf8OrEmpty(obs_hotkey_get_name(hotkey))) {
				return true;
			}
			if (!HotkeyMatchesContext(hotkey, *state->context)) {
				return true;
			}
			*state->found = id;
			return false;
		},
		&search);

	return found;
}

/* ---------------------------------------------------------------- dialogs -- */

/*! The input an `Open...Dialog` request names.  Fails the response and returns
 *  an empty source when the request names nothing that exists. */
OBSSource DialogInput(const QJsonObject &requestData, Response &response)
{
	const QString nameOrUuid = NameOrUuid(requestData, "inputName", "inputUuid");
	if (nameOrUuid.isEmpty()) {
		Fail(response, Status::MissingRequestField,
		     QStringLiteral("The request needs an `inputName` or an `inputUuid`."));
		return OBSSource();
	}

	OBSSource input = FindInput(nameOrUuid);
	if (!input) {
		Fail(response, Status::ResourceNotFound, QStringLiteral("No input was found by that name or UUID."));
	}
	return input;
}

} // namespace

/* ---------------------------------------------------------------- general -- */

void RegisterGeneralHandlers()
{
	AddHandler("GetVersion", [](const QJsonObject &, Response &response) {
		response.data["obsVersion"] = QString::fromUtf8(obs_get_version_string());
		/* There is no obs-websocket in this build, but the UI still shows
		 * the field, so it is kept and labelled with the service that
		 * answers it. */
		response.data["obsWebSocketVersion"] = QStringLiteral("WebMIX");
		response.data["rpcVersion"] = 1;
		response.data["availableRequests"] = QJsonArray::fromStringList(RequestTypes());

		QJsonArray formats;
		for (const QByteArray &format : QImageWriter::supportedImageFormats()) {
			formats.append(QString::fromLatin1(format));
		}
		response.data["supportedImageFormats"] = formats;

		response.data["platform"] = QSysInfo::productType();
		response.data["platformDescription"] = QSysInfo::prettyProductName();
	});

	AddHandler("GetStats", [](const QJsonObject &, Response &response) {
		video_t *video = obs_get_video();
		const QString recordDirectory = CurrentRecordDirectory();

		response.data["cpuUsage"] = CpuUsage();
		response.data["memoryUsage"] = static_cast<double>(os_get_proc_resident_size()) / (1024.0 * 1024.0);
		response.data["availableDiskSpace"] =
			static_cast<double>(os_get_free_disk_space(recordDirectory.toUtf8().constData())) /
			(1024.0 * 1024.0);
		response.data["activeFps"] = obs_get_active_fps();
		response.data["averageFrameRenderTime"] =
			static_cast<double>(obs_get_average_frame_time_ns()) / 1000000.0;
		response.data["renderSkippedFrames"] = static_cast<int>(obs_get_lagged_frames());
		response.data["renderTotalFrames"] = static_cast<int>(obs_get_total_frames());
		response.data["outputSkippedFrames"] = video ? static_cast<int>(video_output_get_skipped_frames(video))
							     : 0;
		response.data["outputTotalFrames"] = video ? static_cast<int>(video_output_get_total_frames(video)) : 0;

		/* There is no socket in this transport, so the per-session counters
		 * obs-websocket reports have no meaning; null is its "no session". */
		response.data["webSocketSessionIncomingMessages"] = QJsonValue::Null;
		response.data["webSocketSessionOutgoingMessages"] = QJsonValue::Null;
	});

	AddHandler("GetHotkeyList", [](const QJsonObject &, Response &response) {
		/* Names only, matching the transport this is a fallback for:
		 * `renderHotkeys()` in web/src/ui/dialogs.js maps the array as strings,
		 * and gets the rich per-hotkey bindings from /api/hotkeys anyway. */
		QJsonArray names;
		const QJsonArray detailed = WebMixBridge::Hotkeys();
		for (const QJsonValue &entry : detailed) {
			names.append(entry.toObject().value(QStringLiteral("name")));
		}
		response.data["hotkeys"] = names;
	});

	AddHandler("TriggerHotkeyByName", [](const QJsonObject &requestData, Response &response) {
		const QString name = StringField(requestData, "hotkeyName");
		if (name.isEmpty()) {
			Fail(response, Status::MissingRequestField, QStringLiteral("A hotkey name is required."));
			return;
		}

		const obs_hotkey_id id = HotkeyIdByName(name, StringField(requestData, "contextName"));
		if (id == OBS_INVALID_HOTKEY_ID) {
			Fail(response, Status::ResourceNotFound, QStringLiteral("No hotkeys were found by that name."));
			return;
		}

		obs_hotkey_trigger_routed_callback(id, true);
		obs_hotkey_trigger_routed_callback(id, false);
	});

	AddHandler("TriggerHotkeyByKeySequence", [](const QJsonObject &requestData, Response &response) {
		obs_key_combination_t combination = {0};

		if (requestData.contains(QStringLiteral("keyId"))) {
			const QJsonValue keyId = requestData.value(QStringLiteral("keyId"));
			if (!keyId.isString()) {
				Fail(response, Status::InvalidRequestFieldType,
				     QStringLiteral("The field `keyId` must be a string."));
				return;
			}
			combination.key = obs_key_from_name(keyId.toString().toUtf8().constData());
		}

		if (requestData.contains(QStringLiteral("keyModifiers"))) {
			const QJsonValue modifiersValue = requestData.value(QStringLiteral("keyModifiers"));
			if (!modifiersValue.isObject()) {
				Fail(response, Status::InvalidRequestFieldType,
				     QStringLiteral("The field `keyModifiers` must be an object."));
				return;
			}

			const QJsonObject modifiers = modifiersValue.toObject();
			uint32_t flags = 0;
			if (BoolField(modifiers, "shift", false)) {
				flags |= INTERACT_SHIFT_KEY;
			}
			if (BoolField(modifiers, "control", false)) {
				flags |= INTERACT_CONTROL_KEY;
			}
			if (BoolField(modifiers, "alt", false)) {
				flags |= INTERACT_ALT_KEY;
			}
			if (BoolField(modifiers, "command", false)) {
				flags |= INTERACT_COMMAND_KEY;
			}
			combination.modifiers = flags;
		}

		if (!combination.modifiers &&
		    (combination.key == OBS_KEY_NONE || combination.key >= OBS_KEY_LAST_VALUE)) {
			Fail(response, Status::RequestFieldEmpty,
			     QStringLiteral("Your provided request fields cannot be used to trigger a hotkey."));
			return;
		}

		/* Things break unless the combination is released before it is
		 * pressed; this is the order obs-websocket injects it in. */
		obs_hotkey_inject_event(combination, false);
		obs_hotkey_inject_event(combination, true);
		obs_hotkey_inject_event(combination, false);
	});

	AddHandler("OpenInputPropertiesDialog", [](const QJsonObject &requestData, Response &response) {
		OBSSource input = DialogInput(requestData, response);
		if (!input) {
			return;
		}
		obs_frontend_open_source_properties(input);
	});

	AddHandler("OpenInputFiltersDialog", [](const QJsonObject &requestData, Response &response) {
		OBSSource input = DialogInput(requestData, response);
		if (!input) {
			return;
		}
		obs_frontend_open_source_filters(input);
	});

	AddHandler("OpenInputInteractDialog", [](const QJsonObject &requestData, Response &response) {
		OBSSource input = DialogInput(requestData, response);
		if (!input) {
			return;
		}
		if (!(obs_source_get_output_flags(input) & OBS_SOURCE_INTERACTION)) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The specified input does not support interaction."));
			return;
		}
		obs_frontend_open_source_interaction(input);
	});
}

/* ----------------------------------------------------------------- config -- */

void RegisterConfigHandlers()
{
	AddHandler("GetSceneCollectionList", [](const QJsonObject &, Response &response) {
		response.data["currentSceneCollectionName"] = CurrentSceneCollection();
		response.data["sceneCollections"] = QJsonArray::fromStringList(SceneCollectionNames());
	});

	AddHandler("CreateSceneCollection", [](const QJsonObject &requestData, Response &response) {
		const QString name = StringField(requestData, "sceneCollectionName");
		if (name.isEmpty()) {
			Fail(response, Status::MissingRequestField,
			     QStringLiteral("A scene collection name is required."));
			return;
		}
		if (SceneCollectionNames().contains(name)) {
			Fail(response, Status::ResourceAlreadyExists,
			     QStringLiteral("A scene collection with that name already exists."));
			return;
		}
		if (!obs_frontend_add_scene_collection(name.toUtf8().constData())) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("Failed to create the scene collection."));
		}
	});

	AddHandler("SetCurrentSceneCollection", [](const QJsonObject &requestData, Response &response) {
		const QString name = StringField(requestData, "sceneCollectionName");
		if (name.isEmpty()) {
			Fail(response, Status::MissingRequestField,
			     QStringLiteral("A scene collection name is required."));
			return;
		}
		if (!SceneCollectionNames().contains(name)) {
			Fail(response, Status::ResourceNotFound,
			     QStringLiteral("No scene collection was found by that name."));
			return;
		}
		/* Switching is asynchronous and expensive; skip it when nothing
		 * would change, exactly like obs-websocket. */
		if (CurrentSceneCollection() == name) {
			return;
		}

		const QByteArray encoded = name.toUtf8();
		obs_frontend_set_current_scene_collection(encoded.constData());
	});

	AddHandler("GetProfileList", [](const QJsonObject &, Response &response) {
		response.data["currentProfileName"] = CurrentProfile();
		response.data["profiles"] = QJsonArray::fromStringList(ProfileNames());
	});

	AddHandler("CreateProfile", [](const QJsonObject &requestData, Response &response) {
		const QString name = StringField(requestData, "profileName");
		if (name.isEmpty()) {
			Fail(response, Status::MissingRequestField, QStringLiteral("A profile name is required."));
			return;
		}
		if (ProfileNames().contains(name)) {
			Fail(response, Status::ResourceAlreadyExists,
			     QStringLiteral("A profile with that name already exists."));
			return;
		}

		const QByteArray encoded = name.toUtf8();
		obs_frontend_create_profile(encoded.constData());
	});

	AddHandler("RemoveProfile", [](const QJsonObject &requestData, Response &response) {
		const QString name = StringField(requestData, "profileName");
		if (name.isEmpty()) {
			Fail(response, Status::MissingRequestField, QStringLiteral("A profile name is required."));
			return;
		}

		const QStringList profiles = ProfileNames();
		if (!profiles.contains(name)) {
			Fail(response, Status::ResourceNotFound, QStringLiteral("No profile was found by that name."));
			return;
		}
		if (profiles.size() < 2) {
			/* obs-websocket's NotEnoughResources; removing the last
			 * profile would leave OBS with nothing to switch to. */
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The only remaining profile cannot be removed."));
			return;
		}

		const QByteArray encoded = name.toUtf8();
		obs_frontend_delete_profile(encoded.constData());
	});

	AddHandler("SetCurrentProfile", [](const QJsonObject &requestData, Response &response) {
		const QString name = StringField(requestData, "profileName");
		if (name.isEmpty()) {
			Fail(response, Status::MissingRequestField, QStringLiteral("A profile name is required."));
			return;
		}
		if (!ProfileNames().contains(name)) {
			Fail(response, Status::ResourceNotFound, QStringLiteral("No profile was found by that name."));
			return;
		}
		if (CurrentProfile() == name) {
			return;
		}

		const QByteArray encoded = name.toUtf8();
		obs_frontend_set_current_profile(encoded.constData());
	});

	AddHandler("GetProfileParameter", [](const QJsonObject &requestData, Response &response) {
		const QString category = StringField(requestData, "parameterCategory");
		const QString name = StringField(requestData, "parameterName");
		if (category.isEmpty() || name.isEmpty()) {
			Fail(response, Status::MissingRequestField,
			     QStringLiteral("parameterCategory and parameterName are both required."));
			return;
		}

		config_t *profile = ActiveProfileConfig(response);
		if (!profile) {
			return;
		}

		const QByteArray section = category.toUtf8();
		const QByteArray key = name.toUtf8();
		if (config_has_default_value(profile, section.constData(), key.constData())) {
			response.data["parameterValue"] =
				ConfigString(config_get_string(profile, section.constData(), key.constData()));
			response.data["defaultParameterValue"] =
				ConfigString(config_get_default_string(profile, section.constData(), key.constData()));
		} else if (config_has_user_value(profile, section.constData(), key.constData())) {
			response.data["parameterValue"] =
				ConfigString(config_get_string(profile, section.constData(), key.constData()));
			response.data["defaultParameterValue"] = QJsonValue::Null;
		} else {
			response.data["parameterValue"] = QJsonValue::Null;
			response.data["defaultParameterValue"] = QJsonValue::Null;
		}
	});

	AddHandler("SetProfileParameter", [](const QJsonObject &requestData, Response &response) {
		const QString category = StringField(requestData, "parameterCategory");
		const QString name = StringField(requestData, "parameterName");
		if (category.isEmpty() || name.isEmpty()) {
			Fail(response, Status::MissingRequestField,
			     QStringLiteral("parameterCategory and parameterName are both required."));
			return;
		}

		config_t *profile = ActiveProfileConfig(response);
		if (!profile) {
			return;
		}

		const QByteArray section = category.toUtf8();
		const QByteArray key = name.toUtf8();
		const QJsonValue value = requestData.value(QStringLiteral("parameterValue"));
		if (value.isUndefined() || value.isNull()) {
			/* A null value is the documented way to delete the key. */
			if (!config_remove_value(profile, section.constData(), key.constData())) {
				Fail(response, Status::ResourceNotFound,
				     QStringLiteral("There are no existing instances of that profile parameter."));
				return;
			}
		} else if (value.isString()) {
			config_set_string(profile, section.constData(), key.constData(),
					  value.toString().toUtf8().constData());
		} else {
			Fail(response, Status::InvalidRequestFieldType,
			     QStringLiteral("The field `parameterValue` must be a string."));
			return;
		}

		config_save(profile);
	});

	AddHandler("GetVideoSettings", [](const QJsonObject &, Response &response) {
		/* The shared serializer reads the same obs_video_info the main
		 * canvas exposes, and reports nulls when video is not up yet. */
		response.data = VideoSettingsJson();
	});

	AddHandler("SetVideoSettings", [](const QJsonObject &requestData, Response &response) {
		if (obs_video_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("Video settings cannot be changed while an output is active."));
			return;
		}

		config_t *config = ActiveProfileConfig(response);
		if (!config) {
			return;
		}

		/* Each pair has to be complete to be applied, and the running video
		 * pipeline reads the profile's Video section, so that is where the
		 * frontend's own settings page writes too. */
		const bool changeFps = requestData.contains(QStringLiteral("fpsNumerator")) &&
				       requestData.contains(QStringLiteral("fpsDenominator"));
		const bool changeBaseRes = requestData.contains(QStringLiteral("baseWidth")) &&
					   requestData.contains(QStringLiteral("baseHeight"));
		const bool changeOutputRes = requestData.contains(QStringLiteral("outputWidth")) &&
					     requestData.contains(QStringLiteral("outputHeight"));

		int fpsNumerator = 0;
		int fpsDenominator = 0;
		int baseWidth = 0;
		int baseHeight = 0;
		int outputWidth = 0;
		int outputHeight = 0;

		bool valid = true;
		if (changeFps) {
			valid = OptionalIntField(requestData, "fpsNumerator", 1, 0, fpsNumerator, response) &&
				OptionalIntField(requestData, "fpsDenominator", 1, 0, fpsDenominator, response);
		}
		if (valid && changeBaseRes) {
			valid = OptionalIntField(requestData, "baseWidth", 8, 4096, baseWidth, response) &&
				OptionalIntField(requestData, "baseHeight", 8, 4096, baseHeight, response);
		}
		if (valid && changeOutputRes) {
			valid = OptionalIntField(requestData, "outputWidth", 8, 4096, outputWidth, response) &&
				OptionalIntField(requestData, "outputHeight", 8, 4096, outputHeight, response);
		}
		if (!valid) {
			return;
		}

		if (!changeFps && !changeBaseRes && !changeOutputRes) {
			Fail(response, Status::MissingRequestField,
			     QStringLiteral("You must specify at least one video-changing pair."));
			return;
		}

		if (changeFps) {
			config_set_uint(config, "Video", "FPSType", 2);
			config_set_uint(config, "Video", "FPSNum", fpsNumerator);
			config_set_uint(config, "Video", "FPSDen", fpsDenominator);
		}
		if (changeBaseRes) {
			config_set_uint(config, "Video", "BaseCX", baseWidth);
			config_set_uint(config, "Video", "BaseCY", baseHeight);
		}
		if (changeOutputRes) {
			config_set_uint(config, "Video", "OutputCX", outputWidth);
			config_set_uint(config, "Video", "OutputCY", outputHeight);
		}

		config_save_safe(config, "tmp", nullptr);
		obs_frontend_reset_video();
	});

	AddHandler("GetStreamServiceSettings", [](const QJsonObject &, Response &response) {
		OBSService service = obs_frontend_get_streaming_service();
		if (!service) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("OBS does not have a stream service configured."));
			return;
		}

		response.data["streamServiceType"] = WebMixBridge::Utf8OrEmpty(obs_service_get_type(service));
		OBSDataAutoRelease settings = obs_service_get_settings(service);
		response.data["streamServiceSettings"] = ObsDataToJsonWithDefaults(settings);
	});

	AddHandler("SetStreamServiceSettings", [](const QJsonObject &requestData, Response &response) {
		if (obs_frontend_streaming_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("You cannot change stream service settings while streaming."));
			return;
		}

		const QString type = StringField(requestData, "streamServiceType");
		if (type.isEmpty()) {
			Fail(response, Status::MissingRequestField,
			     QStringLiteral("A stream service type is required."));
			return;
		}

		const QJsonValue settingsValue = requestData.value(QStringLiteral("streamServiceSettings"));
		if (!settingsValue.isObject()) {
			Fail(response, Status::MissingRequestField,
			     QStringLiteral("`streamServiceSettings` must be an object."));
			return;
		}

		OBSService current = obs_frontend_get_streaming_service();
		OBSData requested = ObsDataFromJson(settingsValue.toObject());

		if (current && type == WebMixBridge::Utf8OrEmpty(obs_service_get_type(current))) {
			/* Same type: merge into what is already there so keys the
			 * caller did not mention survive. */
			OBSDataAutoRelease currentSettings = obs_service_get_settings(current);
			OBSDataAutoRelease merged = obs_data_create();
			obs_data_apply(merged, currentSettings);
			obs_data_apply(merged, requested);
			obs_service_update(current, merged);
		} else {
			OBSServiceAutoRelease created = obs_service_create(
				type.toUtf8().constData(), "webmix_control_service", requested, nullptr);
			if (!created) {
				Fail(response, Status::ResourceNotFound,
				     QStringLiteral("Failed to create a stream service of that type."));
				return;
			}
			obs_frontend_set_streaming_service(created);
		}

		obs_frontend_save_streaming_service();
	});

	AddHandler("GetRecordDirectory", [](const QJsonObject &, Response &response) {
		response.data["recordDirectory"] = CurrentRecordDirectory();
	});

	AddHandler("SetRecordDirectory", [](const QJsonObject &requestData, Response &response) {
		if (obs_frontend_recording_active()) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("The record output is running."));
			return;
		}

		const QString directory = StringField(requestData, "recordDirectory");
		if (directory.isEmpty()) {
			Fail(response, Status::MissingRequestField, QStringLiteral("A record directory is required."));
			return;
		}

		config_t *config = ActiveProfileConfig(response);
		if (!config) {
			return;
		}

		/* obs-websocket writes both output modes so the directory is
		 * correct whichever one the profile uses. */
		const QByteArray encoded = directory.toUtf8();
		config_set_string(config, "AdvOut", "RecFilePath", encoded.constData());
		config_set_string(config, "SimpleOutput", "FilePath", encoded.constData());
		config_save(config);
	});
}

} // namespace WebMixControl
