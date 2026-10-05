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

/* WebMIX: the input, source and filter requests.
 *
 * These are what the source list, the mixer and the filters dialog drive.  The
 * request and response fields follow obs-websocket's handlers exactly - the
 * browser's reducers are keyed on them - but the implementation goes straight
 * to libobs, with the live-preview module reused for screenshots.
 *
 * A few obs-websocket status codes have no equivalent in the vocabulary
 * WebMixControl.hpp exposes (unknown kind, wrong resource type, failed
 * creation or render).  Those use the nearest local code and put the detail in
 * the comment, so the UI still shows the same message it would over the
 * socket. */

#include "WebMixControlInternal.hpp"

#include "WebMixPreview.hpp"

#include <obs-frontend-api.h>

#include <media-io/audio-io.h>

#include <QBuffer>
#include <QDir>
#include <QFileInfo>
#include <QImage>
#include <QImageWriter>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QSaveFile>
#include <QString>

#include <cmath>
#include <limits>

namespace WebMixControl {

namespace {

/* ---- request fields ----------------------------------------------------- */

/* obs-websocket treats an absent field and an explicit null the same way, and
 * validates the type of an optional field just as strictly as a required one;
 * these helpers keep that contract (and its wording). */

bool Present(const QJsonObject &data, const char *name)
{
	const QString key = QString::fromLatin1(name);
	return data.contains(key) && !data.value(key).isNull();
}

bool OptionalString(const QJsonObject &data, const char *name, QString &value, Response &response)
{
	const QString key = QString::fromLatin1(name);
	const QJsonValue field = data.value(key);
	if (!field.isString()) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("The field value of `%1` must be a string.").arg(key));
		return false;
	}
	value = field.toString();
	if (value.isEmpty()) {
		Fail(response, Status::RequestFieldEmpty,
		     QStringLiteral("The field value of `%1` must not be empty.").arg(key));
		return false;
	}
	return true;
}

bool RequireString(const QJsonObject &data, const char *name, QString &value, Response &response)
{
	if (!Present(data, name)) {
		Fail(response, Status::MissingRequestField,
		     QStringLiteral("Your request is missing the `%1` field.").arg(QString::fromLatin1(name)));
		return false;
	}
	return OptionalString(data, name, value, response);
}

bool OptionalBool(const QJsonObject &data, const char *name, bool &value, Response &response)
{
	const QString key = QString::fromLatin1(name);
	const QJsonValue field = data.value(key);
	if (!field.isBool()) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("The field value of `%1` must be boolean.").arg(key));
		return false;
	}
	value = field.toBool();
	return true;
}

bool RequireBool(const QJsonObject &data, const char *name, bool &value, Response &response)
{
	if (!Present(data, name)) {
		Fail(response, Status::MissingRequestField,
		     QStringLiteral("Your request is missing the `%1` field.").arg(QString::fromLatin1(name)));
		return false;
	}
	return OptionalBool(data, name, value, response);
}

bool OptionalNumber(const QJsonObject &data, const char *name, double &value, Response &response,
		    double minimum = -std::numeric_limits<double>::max(),
		    double maximum = std::numeric_limits<double>::max())
{
	const QString key = QString::fromLatin1(name);
	const QJsonValue field = data.value(key);
	if (!field.isDouble()) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("The field value of `%1` must be a number.").arg(key));
		return false;
	}
	const double number = field.toDouble();
	if (number < minimum) {
		Fail(response, Status::RequestFieldOutOfRange,
		     QStringLiteral("The field value of `%1` is below the minimum of `%2`.").arg(key).arg(minimum));
		return false;
	}
	if (number > maximum) {
		Fail(response, Status::RequestFieldOutOfRange,
		     QStringLiteral("The field value of `%1` is above the maximum of `%2`.").arg(key).arg(maximum));
		return false;
	}
	value = number;
	return true;
}

bool RequireNumber(const QJsonObject &data, const char *name, double &value, Response &response,
		   double minimum = -std::numeric_limits<double>::max(),
		   double maximum = std::numeric_limits<double>::max())
{
	if (!Present(data, name)) {
		Fail(response, Status::MissingRequestField,
		     QStringLiteral("Your request is missing the `%1` field.").arg(QString::fromLatin1(name)));
		return false;
	}
	return OptionalNumber(data, name, value, response, minimum, maximum);
}

bool OptionalObject(const QJsonObject &data, const char *name, QJsonObject &value, Response &response)
{
	const QString key = QString::fromLatin1(name);
	const QJsonValue field = data.value(key);
	if (!field.isObject()) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("The field value of `%1` must be an object.").arg(key));
		return false;
	}
	value = field.toObject();
	return true;
}

bool RequireObject(const QJsonObject &data, const char *name, QJsonObject &value, Response &response)
{
	if (!Present(data, name)) {
		Fail(response, Status::MissingRequestField,
		     QStringLiteral("Your request is missing the `%1` field.").arg(QString::fromLatin1(name)));
		return false;
	}
	return OptionalObject(data, name, value, response);
}

/* ---- lookups ------------------------------------------------------------ */

/*! The failure obs-websocket returns when no naming field is set.  WebMIX has
 *  a single canvas, so `canvasUuid` is neither required nor consulted. */
void FailMissingName(Response &response, const char *nameField, const char *uuidField)
{
	Fail(response, Status::MissingRequestField,
	     QStringLiteral("Your request must contain at least one of the following fields: `%1` or `%2`.")
		     .arg(QString::fromLatin1(nameField), QString::fromLatin1(uuidField)));
}

void FailNoSource(Response &response, const QString &key, const char *kind)
{
	Fail(response, Status::ResourceNotFound,
	     QStringLiteral("No %1 was found by the name or UUID of `%2`.").arg(QString::fromLatin1(kind), key));
}

/*! The input a request names.  FindInput only accepts OBS_SOURCE_TYPE_INPUT,
 *  so naming a scene here reads as "not found" - which is the closest local
 *  status to obs-websocket's InvalidResourceType. */
OBSSource RequireInput(const QJsonObject &data, Response &response)
{
	const QString key = NameOrUuid(data, "inputName", "inputUuid");
	if (key.isEmpty()) {
		FailMissingName(response, "inputName", "inputUuid");
		return OBSSource();
	}

	OBSSource input = FindInput(key);
	if (!input) {
		FailNoSource(response, key, "input");
	}
	return input;
}

/*! The input a request names, with the audio capability its mixer fields
 *  require. */
OBSSource RequireAudioInput(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireInput(data, response);
	if (input && (obs_source_get_output_flags(input) & OBS_SOURCE_AUDIO) == 0) {
		Fail(response, Status::InvalidResourceState,
		     QStringLiteral("The specified input does not support audio."));
		return OBSSource();
	}
	return input;
}

/*! Any source a request names, by name or uuid; scenes and inputs alike. */
OBSSource RequireSource(const QJsonObject &data, Response &response)
{
	const QString key = NameOrUuid(data, "sourceName", "sourceUuid");
	if (key.isEmpty()) {
		FailMissingName(response, "sourceName", "sourceUuid");
		return OBSSource();
	}

	OBSSource source = FindSource(key);
	if (!source) {
		FailNoSource(response, key, "source");
	}
	return source;
}

OBSSource RequireScene(const QJsonObject &data, Response &response)
{
	const QString key = NameOrUuid(data, "sceneName", "sceneUuid");
	if (key.isEmpty()) {
		FailMissingName(response, "sceneName", "sceneUuid");
		return OBSSource();
	}

	OBSSource scene = FindScene(key);
	if (!scene) {
		FailNoSource(response, key, "scene");
	}
	return scene;
}

/*! Both objects a filter request names.  `source` is set even when the filter
 *  is not, so a caller never dereferences a half-resolved pair. */
struct FilterTarget {
	OBSSource source;
	OBSSource filter;
};

FilterTarget RequireFilter(const QJsonObject &data, Response &response)
{
	FilterTarget target;
	target.source = RequireSource(data, response);
	if (!target.source) {
		return target;
	}

	QString filterName;
	if (!RequireString(data, "filterName", filterName, response)) {
		return target;
	}

	/* Resolve through the source we already have so a request that named the
	 * source by uuid works the same as one that named it. */
	const QString sourceName = QString::fromUtf8(obs_source_get_name(target.source));
	target.filter = FindFilter(sourceName, filterName);
	if (!target.filter) {
		Fail(response, Status::ResourceNotFound,
		     QStringLiteral("No filter was found in the source `%1` with the name `%2`.")
			     .arg(sourceName, filterName));
	}
	return target;
}

/* ---- kinds -------------------------------------------------------------- */

/*! Whether OBS knows this (versioned) input kind.  obs-websocket validates
 *  against the same list before trusting a kind from a client. */
bool IsInputKind(const QString &kind)
{
	size_t index = 0;
	const char *id = nullptr;
	while (obs_enum_input_types2(index++, &id, nullptr)) {
		if (id && kind == QString::fromUtf8(id)) {
			return true;
		}
	}
	return false;
}

bool IsFilterKind(const QString &kind)
{
	size_t index = 0;
	const char *id = nullptr;
	while (obs_enum_filter_types(index++, &id)) {
		if (id && kind == QString::fromUtf8(id)) {
			return true;
		}
	}
	return false;
}

const char *kInputKindUnsupported =
	"Your specified input kind is not supported by OBS. Check that your specified kind is properly "
	"versioned and that any necessary plugins are loaded.";
const char *kFilterKindUnsupported =
	"Your specified filter kind is not supported by OBS. Check that any necessary plugins are loaded.";

/* ---- audio vocabulary --------------------------------------------------- */

/*! Monitoring as the wire spells it.  This libobs keeps only an on/off flag;
 *  `obs_source_set_monitoring_type()` is deprecated (and fails the frontend's
 *  -Werror) and maps MONITOR_ONLY onto "enabled" anyway, so a request for
 *  either monitoring mode is the same boolean and NONE is off. */
QString MonitoringTypeName(bool enabled)
{
	return enabled ? QStringLiteral("OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT")
		       : QStringLiteral("OBS_MONITORING_TYPE_NONE");
}

/*! The `inputAudioTracks` wire format: an object keyed "1".."6". */
QJsonObject AudioTracksJson(uint32_t mixers)
{
	QJsonObject tracks;
	for (uint32_t index = 0; index < MAX_AUDIO_MIXES; index++) {
		tracks[QString::number(index + 1)] = (mixers & (1u << index)) != 0;
	}
	return tracks;
}

/* ---- screenshots -------------------------------------------------------- */

/*! obs-websocket accepts any format Qt can write; the browser asks for png or
 *  jpg, and the check keeps everything else honest. */
bool IsImageFormatSupported(const QString &format)
{
	return QImageWriter::supportedImageFormats().contains(format.toLatin1());
}

/*! Encode a frame as the requested format.  JPEG goes through the preview
 *  module's encoder so a screenshot and a live preview frame are produced by
 *  exactly the same path. */
QByteArray EncodeImage(const QImage &image, const QString &format, int quality)
{
	if (format.compare(QLatin1String("jpg"), Qt::CaseInsensitive) == 0 ||
	    format.compare(QLatin1String("jpeg"), Qt::CaseInsensitive) == 0) {
		return WebMixPreview::EncodeJpeg(image, quality);
	}

	QByteArray encoded;
	QBuffer buffer(&encoded);
	buffer.open(QBuffer::WriteOnly);
	if (!image.save(&buffer, format.toLatin1().constData(), quality)) {
		return QByteArray();
	}
	buffer.close();
	return encoded;
}

QString DataUrl(const QByteArray &encoded, const QString &format)
{
	/* Browsers only registered "jpeg", not "jpg"; Qt's format name is the
	 * latter, and obs-websocket passes it straight through, which produces a
	 * data URL that works by sniffing rather than by the spec. */
	QString mime = format.toLower();
	if (mime == QLatin1String("jpg")) {
		mime = QStringLiteral("jpeg");
	}
	return QStringLiteral("data:image/%1;base64,%2").arg(mime, QString::fromLatin1(encoded.toBase64()));
}

/*! The fields both screenshot requests share. */
struct ScreenshotOptions {
	QString sourceName;
	QString format;
	uint32_t width = 0;
	uint32_t height = 0;
	int quality = -1;
};

/*! Parse the common part of Get/SaveSourceScreenshot.  A source is resolved by
 *  name or uuid, but rendering goes by name, so the resolved name is kept. */
bool ReadScreenshotRequest(const QJsonObject &data, Response &response, ScreenshotOptions &options)
{
	OBSSource source = RequireSource(data, response);
	if (!source) {
		return false;
	}

	const enum obs_source_type type = obs_source_get_type(source);
	if (type != OBS_SOURCE_TYPE_INPUT && type != OBS_SOURCE_TYPE_SCENE) {
		Fail(response, Status::NotSupported,
		     QStringLiteral("The specified source is not an input or a scene."));
		return false;
	}

	if (!RequireString(data, "imageFormat", options.format, response)) {
		return false;
	}
	if (!IsImageFormatSupported(options.format)) {
		Fail(response, Status::NotSupported,
		     QStringLiteral("Your specified image format is invalid or not supported by this system."));
		return false;
	}

	double width = 0.0;
	if (Present(data, "imageWidth") && !OptionalNumber(data, "imageWidth", width, response, 8.0, 4096.0)) {
		return false;
	}
	options.width = static_cast<uint32_t>(width);

	double height = 0.0;
	if (Present(data, "imageHeight") && !OptionalNumber(data, "imageHeight", height, response, 8.0, 4096.0)) {
		return false;
	}
	options.height = static_cast<uint32_t>(height);

	double quality = -1.0;
	if (Present(data, "imageCompressionQuality") &&
	    !OptionalNumber(data, "imageCompressionQuality", quality, response, -1.0, 100.0)) {
		return false;
	}
	options.quality = static_cast<int>(quality);

	options.sourceName = QString::fromUtf8(obs_source_get_name(source));
	return true;
}

bool CaptureScreenshot(const ScreenshotOptions &options, Response &response, QImage &image)
{
	bool ok = false;
	image = WebMixPreview::CaptureSource(options.sourceName, options.width, options.height, ok);
	if (!ok || image.isNull()) {
		Fail(response, Status::InvalidResourceState, QStringLiteral("Failed to render screenshot."));
		return false;
	}
	return true;
}

/* ---- inputs ------------------------------------------------------------- */

void GetInputList(const QJsonObject &data, Response &response)
{
	QString kind;
	if (Present(data, "inputKind") && !OptionalString(data, "inputKind", kind, response)) {
		return;
	}

	response.data["inputs"] = InputArray(kind);
}

void GetInputKindList(const QJsonObject &data, Response &response)
{
	bool unversioned = false;
	if (Present(data, "unversioned") && !OptionalBool(data, "unversioned", unversioned, response)) {
		return;
	}

	QJsonArray kinds;
	/* Parallel to inputKinds: what OBS itself calls each kind, for the picker.
	 * The ids are what CreateInput needs, but "monitor_capture" is not a label
	 * to put in front of a user ("Display Capture" is). Extra field, so an
	 * obs-websocket client reading inputKinds is unaffected. */
	QJsonArray names;
	size_t index = 0;
	const char *id = nullptr;
	const char *unversionedId = nullptr;
	while (obs_enum_input_types2(index++, &id, &unversionedId)) {
		/* Disabled kinds cannot be created, and obs-websocket hides them
		 * from the picker for the same reason. */
		if ((obs_get_source_output_flags(id) & OBS_SOURCE_CAP_DISABLED) != 0) {
			continue;
		}
		const char *chosen = unversioned ? unversionedId : id;
		kinds.append(QString::fromUtf8(chosen ? chosen : id));

		const char *displayName = obs_source_get_display_name(id);
		names.append(QString::fromUtf8(displayName && *displayName ? displayName : (chosen ? chosen : id)));
	}
	response.data["inputKinds"] = kinds;
	response.data["inputKindNames"] = names;
}

void GetInputDefaultSettings(const QJsonObject &data, Response &response)
{
	QString kind;
	if (!RequireString(data, "inputKind", kind, response)) {
		return;
	}
	if (!IsInputKind(kind)) {
		Fail(response, Status::NotSupported, QString::fromUtf8(kInputKindUnsupported));
		return;
	}

	OBSDataAutoRelease defaults = obs_get_source_defaults(kind.toUtf8().constData());
	if (!defaults) {
		Fail(response, Status::NotSupported,
		     QStringLiteral("Failed to get the default settings of that input kind."));
		return;
	}

	response.data["defaultInputSettings"] = ObsDataToJson(defaults);
}

void GetInputSettings(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireInput(data, response);
	if (!input) {
		return;
	}

	OBSDataAutoRelease settings = obs_source_get_settings(input);
	response.data["inputSettings"] = ObsDataToJson(settings);
	response.data["inputKind"] = QString::fromUtf8(obs_source_get_id(input));
}

void SetInputSettings(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireInput(data, response);
	if (!input) {
		return;
	}

	QJsonObject settings;
	if (!RequireObject(data, "inputSettings", settings, response)) {
		return;
	}

	bool overlay = true;
	if (Present(data, "overlay") && !OptionalBool(data, "overlay", overlay, response)) {
		return;
	}

	/* obs_source_update merges the keys that are present and leaves the rest,
	 * which is exactly the overlay obs-websocket promises. */
	OBSData newSettings = ObsDataFromJson(settings);
	if (overlay) {
		obs_source_update(input, newSettings);
	} else {
		obs_source_reset_settings(input, newSettings);
	}
	obs_source_update_properties(input);
}

void CreateInput(const QJsonObject &data, Response &response)
{
	OBSSource sceneSource = RequireScene(data, response);
	if (!sceneSource) {
		return;
	}

	QString inputName;
	if (!RequireString(data, "inputName", inputName, response)) {
		return;
	}

	QString inputKind;
	if (!RequireString(data, "inputKind", inputKind, response)) {
		return;
	}

	OBSSourceAutoRelease existing = obs_get_source_by_name(inputName.toUtf8().constData());
	if (existing) {
		Fail(response, Status::ResourceAlreadyExists,
		     QStringLiteral("A source already exists by that input name."));
		return;
	}

	if (!IsInputKind(inputKind)) {
		Fail(response, Status::NotSupported, QString::fromUtf8(kInputKindUnsupported));
		return;
	}

	OBSData inputSettings;
	if (Present(data, "inputSettings")) {
		QJsonObject settings;
		if (!OptionalObject(data, "inputSettings", settings, response)) {
			return;
		}
		inputSettings = ObsDataFromJson(settings);
	}

	bool sceneItemEnabled = true;
	if (Present(data, "sceneItemEnabled") && !OptionalBool(data, "sceneItemEnabled", sceneItemEnabled, response)) {
		return;
	}

	OBSSourceAutoRelease input = obs_source_create(inputKind.toUtf8().constData(), inputName.toUtf8().constData(),
						       inputSettings, nullptr);
	if (!input) {
		Fail(response, Status::InvalidResourceState, QStringLiteral("Creation of the input failed."));
		return;
	}

	/* Some kinds advertise monitoring in their defaults, but creating the
	 * source does not apply it; OBS's own creation helper sets it explicitly. */
	if ((obs_source_get_output_flags(input) & OBS_SOURCE_MONITOR_BY_DEFAULT) != 0) {
		obs_source_set_monitoring_enabled(input, true);
	}

	obs_scene_t *scene = obs_scene_from_source(sceneSource);
	obs_sceneitem_t *item = scene ? obs_scene_add(scene, input) : nullptr;
	if (!item) {
		/* Removing the source undoes the half-finished creation. */
		obs_source_remove(input);
		Fail(response, Status::InvalidResourceState, QStringLiteral("Creation of the scene item failed."));
		return;
	}
	obs_sceneitem_set_visible(item, sceneItemEnabled);

	response.data["inputUuid"] = QString::fromUtf8(obs_source_get_uuid(input));
	response.data["sceneItemId"] = static_cast<double>(obs_sceneitem_get_id(item));
}

void RemoveInput(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireInput(data, response);
	if (!input) {
		return;
	}

	/* Removing a source only marks it and emits a signal; every scene item
	 * still holds a reference, so on its own the source would survive forever -
	 * still listed by GetInputList and still drawn in every scene that used it.
	 * The desktop UI prunes the items after deleting a source, and that half
	 * was missing here.
	 *
	 * Pruning goes through obs_sceneitem_remove_internal(), so each dropped
	 * item emits the usual signal and clients update from the event stream
	 * rather than from a refresh. */
	obs_source_remove(input);

	auto prune = [](void *, obs_source_t *scene) {
		if (obs_scene_t *sceneData = obs_scene_from_source(scene)) {
			obs_scene_prune_sources(sceneData);
		}
		return true;
	};
	obs_enum_scenes(prune, nullptr);

	/* The reference this handler holds is released at the end of the scope,
	 * which is what finally destroys the source once its items are gone. */
}

void SetInputName(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireInput(data, response);
	if (!input) {
		return;
	}

	QString newName;
	if (!RequireString(data, "newInputName", newName, response)) {
		return;
	}

	OBSSourceAutoRelease existing = obs_get_source_by_name(newName.toUtf8().constData());
	if (existing) {
		Fail(response, Status::ResourceAlreadyExists,
		     QStringLiteral("A source already exists by that new input name."));
		return;
	}

	obs_source_set_name(input, newName.toUtf8().constData());
}

void GetInputVolume(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	const float mul = obs_source_get_volume(input);
	float db = obs_mul_to_db(mul);
	if (std::isinf(db) && db < 0.0f) {
		/* Silence is -infinity dB on the wire as -100, which the UI's fader
		 * can actually render. */
		db = -100.0f;
	}

	response.data["inputVolumeMul"] = static_cast<double>(mul);
	response.data["inputVolumeDb"] = static_cast<double>(db);
}

void SetInputVolume(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	const bool hasMul = Present(data, "inputVolumeMul");
	const bool hasDb = Present(data, "inputVolumeDb");

	double mul = 0.0;
	double db = 0.0;
	if (hasMul && !OptionalNumber(data, "inputVolumeMul", mul, response, 0.0, 20.0)) {
		return;
	}
	if (hasDb && !OptionalNumber(data, "inputVolumeDb", db, response, -100.0, 26.0)) {
		return;
	}

	if (hasMul && hasDb) {
		Fail(response, Status::InvalidRequestFieldType,
		     QStringLiteral("You may only specify one volume field."));
		return;
	}
	if (!hasMul && !hasDb) {
		Fail(response, Status::MissingRequestField, QStringLiteral("You must specify one volume field."));
		return;
	}

	const float volume = hasMul ? static_cast<float>(mul) : obs_db_to_mul(static_cast<float>(db));
	obs_source_set_volume(input, volume);
}

void GetInputMute(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	response.data["inputMuted"] = obs_source_muted(input);
}

void SetInputMute(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	bool muted = false;
	if (!RequireBool(data, "inputMuted", muted, response)) {
		return;
	}

	obs_source_set_muted(input, muted);
}

void ToggleInputMute(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	const bool muted = !obs_source_muted(input);
	obs_source_set_muted(input, muted);
	response.data["inputMuted"] = muted;
}

void GetInputAudioTracks(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	response.data["inputAudioTracks"] = AudioTracksJson(obs_source_get_audio_mixers(input));
}

void SetInputAudioTracks(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	QJsonObject tracks;
	if (!RequireObject(data, "inputAudioTracks", tracks, response)) {
		return;
	}

	/* Only the tracks the caller mentions change; the rest keep their state,
	 * matching obs-websocket. */
	uint32_t mixers = obs_source_get_audio_mixers(input);
	for (uint32_t index = 0; index < MAX_AUDIO_MIXES; index++) {
		const QString track = QString::number(index + 1);
		if (!tracks.contains(track) || tracks.value(track).isNull()) {
			continue;
		}

		const QJsonValue value = tracks.value(track);
		if (!value.isBool()) {
			Fail(response, Status::InvalidRequestFieldType,
			     QStringLiteral("The value of one of your tracks is not a boolean."));
			return;
		}

		if (value.toBool()) {
			mixers |= (1u << index);
		} else {
			mixers &= ~(1u << index);
		}
	}

	obs_source_set_audio_mixers(input, mixers);
}

void GetInputAudioMonitorType(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	response.data["monitorType"] = MonitoringTypeName(obs_source_get_monitoring_enabled(input));
}

void SetInputAudioMonitorType(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	QString name;
	if (!RequireString(data, "monitorType", name, response)) {
		return;
	}

	bool enabled = false;
	if (name == QLatin1String("OBS_MONITORING_TYPE_NONE")) {
		enabled = false;
	} else if (name == QLatin1String("OBS_MONITORING_TYPE_MONITOR_ONLY")) {
		/* Still accepted: the desktop UI has dropped the distinction, and the
		 * deprecated libobs setter treated it as plain "enabled" too. */
		enabled = true;
	} else if (name == QLatin1String("OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT")) {
		enabled = true;
	} else {
		Fail(response, Status::InvalidRequestFieldType, QStringLiteral("Unknown monitor type: %1").arg(name));
		return;
	}

	if (!obs_audio_monitoring_available()) {
		Fail(response, Status::InvalidResourceState,
		     QStringLiteral("Audio monitoring is not available on this platform."));
		return;
	}

	obs_source_set_monitoring_enabled(input, enabled);
}

void GetInputAudioSyncOffset(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	/* libobs stores nanoseconds; the wire format is milliseconds. */
	response.data["inputAudioSyncOffset"] = static_cast<double>(obs_source_get_sync_offset(input) / 1000000);
}

void SetInputAudioSyncOffset(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	double offset = 0.0;
	if (!RequireNumber(data, "inputAudioSyncOffset", offset, response, -950.0, 20000.0)) {
		return;
	}

	const int64_t offsetMs = static_cast<int64_t>(offset);
	obs_source_set_sync_offset(input, offsetMs * 1000000);
}

void GetInputAudioBalance(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	response.data["inputAudioBalance"] = static_cast<double>(obs_source_get_balance_value(input));
}

void SetInputAudioBalance(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireAudioInput(data, response);
	if (!input) {
		return;
	}

	double balance = 0.0;
	if (!RequireNumber(data, "inputAudioBalance", balance, response, 0.0, 1.0)) {
		return;
	}

	obs_source_set_balance_value(input, static_cast<float>(balance));
}

void GetInputPropertiesListPropertyItems(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireInput(data, response);
	if (!input) {
		return;
	}

	QString propertyName;
	if (!RequireString(data, "propertyName", propertyName, response)) {
		return;
	}

	OBSProperties properties = obs_source_properties(input);
	obs_property_t *property = obs_properties_get(properties, propertyName.toUtf8().constData());
	if (!property) {
		Fail(response, Status::ResourceNotFound, QStringLiteral("Unable to find a property by that name."));
		return;
	}
	if (obs_property_get_type(property) != OBS_PROPERTY_LIST) {
		Fail(response, Status::NotSupported, QStringLiteral("The property found is not a list."));
		return;
	}

	const enum obs_combo_format format = obs_property_list_format(property);
	const size_t count = obs_property_list_item_count(property);

	QJsonArray items;
	for (size_t index = 0; index < count; index++) {
		QJsonObject item;
		const char *itemName = obs_property_list_item_name(property, index);
		item["itemName"] = itemName ? QString::fromUtf8(itemName) : QString();
		item["itemEnabled"] = !obs_property_list_item_disabled(property, index);

		switch (format) {
		case OBS_COMBO_FORMAT_INT:
			item["itemValue"] = static_cast<qint64>(obs_property_list_item_int(property, index));
			break;
		case OBS_COMBO_FORMAT_FLOAT:
			item["itemValue"] = obs_property_list_item_float(property, index);
			break;
		case OBS_COMBO_FORMAT_STRING: {
			const char *value = obs_property_list_item_string(property, index);
			item["itemValue"] = value ? QString::fromUtf8(value) : QString();
			break;
		}
		default:
			item["itemValue"] = QJsonValue::Null;
			break;
		}

		items.append(item);
	}

	response.data["propertyItems"] = items;
}

void PressInputPropertiesButton(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireInput(data, response);
	if (!input) {
		return;
	}

	QString propertyName;
	if (!RequireString(data, "propertyName", propertyName, response)) {
		return;
	}

	OBSProperties properties = obs_source_properties(input);
	obs_property_t *property = obs_properties_get(properties, propertyName.toUtf8().constData());
	if (!property) {
		Fail(response, Status::ResourceNotFound, QStringLiteral("Unable to find a property by that name."));
		return;
	}
	if (obs_property_get_type(property) != OBS_PROPERTY_BUTTON) {
		Fail(response, Status::NotSupported, QStringLiteral("The property found is not a button."));
		return;
	}
	if (!obs_property_enabled(property)) {
		Fail(response, Status::InvalidResourceState, QStringLiteral("The property item found is not enabled."));
		return;
	}

	/* The clicked callback is what the desktop properties view calls, so a
	 * button such as the browser source's reload behaves identically. */
	obs_property_button_clicked(property, input);
}

void TriggerMediaInputAction(const QJsonObject &data, Response &response)
{
	OBSSource input = RequireInput(data, response);
	if (!input) {
		return;
	}

	QString action;
	if (!RequireString(data, "mediaAction", action, response)) {
		return;
	}

	if (action == QLatin1String("OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY")) {
		/* libobs spells play as "resume", hence the flag. */
		obs_source_media_play_pause(input, false);
	} else if (action == QLatin1String("OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE")) {
		obs_source_media_play_pause(input, true);
	} else if (action == QLatin1String("OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP")) {
		obs_source_media_stop(input);
	} else if (action == QLatin1String("OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART")) {
		obs_source_media_restart(input);
	} else if (action == QLatin1String("OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT")) {
		obs_source_media_next(input);
	} else if (action == QLatin1String("OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS")) {
		obs_source_media_previous(input);
	} else {
		Fail(response, Status::NotSupported,
		     QStringLiteral("You have specified an invalid media input action."));
	}
}

/* ---- sources ------------------------------------------------------------ */

void GetSourceActive(const QJsonObject &data, Response &response)
{
	OBSSource source = RequireSource(data, response);
	if (!source) {
		return;
	}

	const enum obs_source_type type = obs_source_get_type(source);
	if (type != OBS_SOURCE_TYPE_INPUT && type != OBS_SOURCE_TYPE_SCENE) {
		Fail(response, Status::NotSupported,
		     QStringLiteral("The specified source is not an input or a scene."));
		return;
	}

	response.data["videoActive"] = obs_source_active(source);
	response.data["videoShowing"] = obs_source_showing(source);
}

void GetSourceScreenshot(const QJsonObject &data, Response &response)
{
	ScreenshotOptions options;
	if (!ReadScreenshotRequest(data, response, options)) {
		return;
	}

	QImage image;
	if (!CaptureScreenshot(options, response, image)) {
		return;
	}

	const QByteArray encoded = EncodeImage(image, options.format, options.quality);
	if (encoded.isEmpty()) {
		Fail(response, Status::InvalidResourceState, QStringLiteral("Failed to encode screenshot."));
		return;
	}

	response.data["imageData"] = DataUrl(encoded, options.format);
}

void SaveSourceScreenshot(const QJsonObject &data, Response &response)
{
	ScreenshotOptions options;
	if (!ReadScreenshotRequest(data, response, options)) {
		return;
	}

	QString filePath;
	if (!RequireString(data, "imageFilePath", filePath, response)) {
		return;
	}

	const QFileInfo info(filePath);
	if (!info.absoluteDir().exists()) {
		Fail(response, Status::ResourceNotFound,
		     QStringLiteral("The directory for your file path does not exist."));
		return;
	}

	QImage image;
	if (!CaptureScreenshot(options, response, image)) {
		return;
	}

	const QByteArray encoded = EncodeImage(image, options.format, options.quality);
	if (encoded.isEmpty()) {
		Fail(response, Status::InvalidResourceState, QStringLiteral("Failed to encode screenshot."));
		return;
	}

	/* QSaveFile never leaves a half-written image where a good one used to
	 * be, which matters for the hotkey-driven screenshot output. */
	QSaveFile file(info.absoluteFilePath());
	if (!file.open(QIODevice::WriteOnly)) {
		Fail(response, Status::InvalidResourceState, QStringLiteral("Failed to save screenshot."));
		return;
	}
	if (file.write(encoded) != encoded.size() || !file.commit()) {
		Fail(response, Status::InvalidResourceState, QStringLiteral("Failed to save screenshot."));
		return;
	}

	/* obs-websocket returns nothing here, but the bytes are already in hand
	 * and the browser can show the shot without a second round trip. */
	response.data["imageData"] = DataUrl(encoded, options.format);
}

/* ---- filters ------------------------------------------------------------ */

void GetSourceFilterKindList(const QJsonObject &, Response &response)
{
	QJsonArray kinds;
	size_t index = 0;
	const char *id = nullptr;
	while (obs_enum_filter_types(index++, &id)) {
		if (id) {
			kinds.append(QString::fromUtf8(id));
		}
	}
	response.data["sourceFilterKinds"] = kinds;
}

void GetSourceFilterList(const QJsonObject &data, Response &response)
{
	OBSSource source = RequireSource(data, response);
	if (!source) {
		return;
	}

	response.data["filters"] = FilterArray(source);
}

void GetSourceFilterDefaultSettings(const QJsonObject &data, Response &response)
{
	QString kind;
	if (!RequireString(data, "filterKind", kind, response)) {
		return;
	}
	if (!IsFilterKind(kind)) {
		Fail(response, Status::NotSupported, QString::fromUtf8(kFilterKindUnsupported));
		return;
	}

	OBSDataAutoRelease defaults = obs_get_source_defaults(kind.toUtf8().constData());
	if (!defaults) {
		Fail(response, Status::NotSupported,
		     QStringLiteral("Failed to get the default settings of that filter kind."));
		return;
	}

	response.data["defaultFilterSettings"] = ObsDataToJson(defaults);
}

void CreateSourceFilter(const QJsonObject &data, Response &response)
{
	OBSSource source = RequireSource(data, response);
	if (!source) {
		return;
	}

	QString filterName;
	if (!RequireString(data, "filterName", filterName, response)) {
		return;
	}

	QString filterKind;
	if (!RequireString(data, "filterKind", filterKind, response)) {
		return;
	}

	OBSSourceAutoRelease existing = obs_source_get_filter_by_name(source, filterName.toUtf8().constData());
	if (existing) {
		Fail(response, Status::ResourceAlreadyExists, QStringLiteral("A filter already exists by that name."));
		return;
	}

	if (!IsFilterKind(filterKind)) {
		Fail(response, Status::NotSupported, QString::fromUtf8(kFilterKindUnsupported));
		return;
	}

	OBSData filterSettings;
	if (Present(data, "filterSettings")) {
		QJsonObject settings;
		if (!OptionalObject(data, "filterSettings", settings, response)) {
			return;
		}
		filterSettings = ObsDataFromJson(settings);
	}

	/* A filter is a private source: the source takes its own reference when it
	 * is added below, and ours is released when this scope ends. */
	OBSSourceAutoRelease filter = obs_source_create_private(filterKind.toUtf8().constData(),
								filterName.toUtf8().constData(), filterSettings);
	if (!filter) {
		Fail(response, Status::InvalidResourceState, QStringLiteral("Creation of the filter failed."));
		return;
	}

	obs_source_filter_add(source, filter);
}

void RemoveSourceFilter(const QJsonObject &data, Response &response)
{
	FilterTarget target = RequireFilter(data, response);
	if (!target.source || !target.filter) {
		return;
	}

	obs_source_filter_remove(target.source, target.filter);
}

void SetSourceFilterName(const QJsonObject &data, Response &response)
{
	FilterTarget target = RequireFilter(data, response);
	if (!target.source || !target.filter) {
		return;
	}

	QString newName;
	if (!RequireString(data, "newFilterName", newName, response)) {
		return;
	}

	OBSSourceAutoRelease existing = obs_source_get_filter_by_name(target.source, newName.toUtf8().constData());
	if (existing) {
		Fail(response, Status::ResourceAlreadyExists,
		     QStringLiteral("A filter already exists by that new name."));
		return;
	}

	obs_source_set_name(target.filter, newName.toUtf8().constData());
}

/*! How many filters a source has.  Needed because
 *  obs_source_filter_set_index() trusts its index and would write past the
 *  filter array for a request that names one beyond the list; obs-websocket's
 *  own reorder loop effectively lands on the last filter in that case. */
size_t FilterCount(obs_source_t *source)
{
	size_t count = 0;
	obs_source_enum_filters(
		source, [](obs_source_t *, obs_source_t *, void *param) { ++*static_cast<size_t *>(param); }, &count);
	return count;
}

void SetSourceFilterIndex(const QJsonObject &data, Response &response)
{
	FilterTarget target = RequireFilter(data, response);
	if (!target.source || !target.filter) {
		return;
	}

	double index = 0.0;
	if (!RequireNumber(data, "filterIndex", index, response, 0.0, 8192.0)) {
		return;
	}

	size_t destination = static_cast<size_t>(index);
	const size_t count = FilterCount(target.source);
	if (count > 0 && destination >= count) {
		destination = count - 1;
	}

	obs_source_filter_set_index(target.source, target.filter, destination);
}

void SetSourceFilterEnabled(const QJsonObject &data, Response &response)
{
	FilterTarget target = RequireFilter(data, response);
	if (!target.source || !target.filter) {
		return;
	}

	bool enabled = false;
	if (!RequireBool(data, "filterEnabled", enabled, response)) {
		return;
	}

	obs_source_set_enabled(target.filter, enabled);
}

void SetSourceFilterSettings(const QJsonObject &data, Response &response)
{
	FilterTarget target = RequireFilter(data, response);
	if (!target.source || !target.filter) {
		return;
	}

	QJsonObject settings;
	if (!RequireObject(data, "filterSettings", settings, response)) {
		return;
	}

	bool overlay = true;
	if (Present(data, "overlay") && !OptionalBool(data, "overlay", overlay, response)) {
		return;
	}

	OBSData newSettings = ObsDataFromJson(settings);
	if (overlay) {
		obs_source_update(target.filter, newSettings);
	} else {
		obs_source_reset_settings(target.filter, newSettings);
	}
	obs_source_update_properties(target.filter);
}

} // namespace

void RegisterInputHandlers()
{
	AddHandler("GetInputList", &GetInputList);
	AddHandler("GetInputKindList", &GetInputKindList);
	AddHandler("GetInputDefaultSettings", &GetInputDefaultSettings);
	AddHandler("GetInputSettings", &GetInputSettings);
	AddHandler("SetInputSettings", &SetInputSettings);
	AddHandler("CreateInput", &CreateInput);
	AddHandler("RemoveInput", &RemoveInput);
	AddHandler("SetInputName", &SetInputName);
	AddHandler("GetInputVolume", &GetInputVolume);
	AddHandler("SetInputVolume", &SetInputVolume);
	AddHandler("GetInputMute", &GetInputMute);
	AddHandler("SetInputMute", &SetInputMute);
	AddHandler("ToggleInputMute", &ToggleInputMute);
	AddHandler("GetInputAudioTracks", &GetInputAudioTracks);
	AddHandler("SetInputAudioTracks", &SetInputAudioTracks);
	AddHandler("GetInputAudioMonitorType", &GetInputAudioMonitorType);
	AddHandler("SetInputAudioMonitorType", &SetInputAudioMonitorType);
	AddHandler("GetInputAudioSyncOffset", &GetInputAudioSyncOffset);
	AddHandler("SetInputAudioSyncOffset", &SetInputAudioSyncOffset);
	AddHandler("GetInputAudioBalance", &GetInputAudioBalance);
	AddHandler("SetInputAudioBalance", &SetInputAudioBalance);
	AddHandler("GetInputPropertiesListPropertyItems", &GetInputPropertiesListPropertyItems);
	AddHandler("PressInputPropertiesButton", &PressInputPropertiesButton);
	AddHandler("TriggerMediaInputAction", &TriggerMediaInputAction);
}

void RegisterSourceHandlers()
{
	AddHandler("GetSourceActive", &GetSourceActive);
	AddHandler("GetSourceScreenshot", &GetSourceScreenshot);
	AddHandler("SaveSourceScreenshot", &SaveSourceScreenshot);
}

void RegisterFilterHandlers()
{
	AddHandler("GetSourceFilterList", &GetSourceFilterList);
	AddHandler("GetSourceFilterKindList", &GetSourceFilterKindList);
	AddHandler("GetSourceFilterDefaultSettings", &GetSourceFilterDefaultSettings);
	AddHandler("CreateSourceFilter", &CreateSourceFilter);
	AddHandler("RemoveSourceFilter", &RemoveSourceFilter);
	AddHandler("SetSourceFilterName", &SetSourceFilterName);
	AddHandler("SetSourceFilterIndex", &SetSourceFilterIndex);
	AddHandler("SetSourceFilterEnabled", &SetSourceFilterEnabled);
	AddHandler("SetSourceFilterSettings", &SetSourceFilterSettings);
}

} // namespace WebMixControl
