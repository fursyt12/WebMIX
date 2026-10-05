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

/* WebMIX: the event side of the native control service.
 *
 * Where obs-websocket has an EventHandler tree that translates libobs signals
 * into protocol events, this file connects the same signals in-process and
 * hands the results straight to the subscribed transports (currently the SSE
 * endpoint).  The payload shapes match obs-websocket's, because the web
 * frontend's store reducers are written against them.
 *
 * Two deliberate improvements over the obs-websocket originals:
 *
 *  - Scene signals carry no calldata for the scene in some libobs versions
 *    (`reorder` and `item_transform` emit only the item, or nothing at all), so
 *    the scene is taken from the signal's own context first and from the
 *    calldata only as a fallback.  Without this, SceneItemListReindexed and
 *    SceneItemTransformChanged never fire.
 *  - Volume meters are accumulated here and published on a timer instead of
 *    being tied to the protocol's per-client subscription bookkeeping.
 *
 * Threading: the signal handlers run on the main thread except for the audio
 * capture callback, which runs on an audio thread and therefore only touches
 * its own meter under a mutex. */

#include "WebMixControlInternal.hpp"

#include <obs-frontend-api.h>

#include <media-io/audio-io.h>
#include <obs-audio-controls.h>

#include <util/platform.h>

#include <QCoreApplication>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QMutex>
#include <QMutexLocker>
#include <QString>
#include <QTimer>

#include <algorithm>
#include <atomic>
#include <cmath>

namespace WebMixControl {

namespace {

/* ---------------------------------------------------------------- helpers -- */

template<typename T> T *CalldataPointer(calldata_t *data, const char *name)
{
	void *value = nullptr;
	if (!data || !calldata_get_ptr(data, name, &value)) {
		return nullptr;
	}
	return static_cast<T *>(value);
}

QString NameOf(obs_source_t *source)
{
	return source ? QString::fromUtf8(obs_source_get_name(source)) : QString();
}

QString UuidOf(obs_source_t *source)
{
	return source ? QString::fromUtf8(obs_source_get_uuid(source)) : QString();
}

bool IsInput(obs_source_t *source)
{
	return source && obs_source_get_type(source) == OBS_SOURCE_TYPE_INPUT;
}

bool IsScene(obs_source_t *source)
{
	return source && obs_source_get_type(source) == OBS_SOURCE_TYPE_SCENE;
}

bool IsTransition(obs_source_t *source)
{
	return source && obs_source_get_type(source) == OBS_SOURCE_TYPE_TRANSITION;
}

/*! The input's audio track bitmask as obs-websocket spells it: an object whose
 *  keys are the track numbers 1..6 and whose values are booleans. */
QJsonObject AudioTracksJson(uint32_t mixers)
{
	QJsonObject tracks;
	for (int track = 1; track <= 6; track++) {
		tracks[QString::number(track)] = (mixers & (1u << (track - 1))) != 0;
	}
	return tracks;
}

QString MonitoringTypeName(enum obs_monitoring_type type)
{
	switch (type) {
	case OBS_MONITORING_TYPE_MONITOR_ONLY:
		return QStringLiteral("OBS_MONITORING_TYPE_MONITOR_ONLY");
	case OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT:
		return QStringLiteral("OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT");
	case OBS_MONITORING_TYPE_NONE:
	default:
		return QStringLiteral("OBS_MONITORING_TYPE_NONE");
	}
}

/* --------------------------------------------------------------- metering -- */

/*! One input's accumulated levels.  `magnitude`/`peak` are written by the audio
 *  thread and read by the publishing timer, hence the mutex. */
struct Meter {
	QMutex mutex;
	float magnitude[MAX_AUDIO_CHANNELS] = {};
	float peak[MAX_AUDIO_CHANNELS] = {};
	int channels = 0;
	uint64_t lastUpdate = 0;
	bool muted = false;
	float volume = 1.0f;
};

QHash<obs_source_t *, Meter *> &Meters()
{
	static QHash<obs_source_t *, Meter *> meters;
	return meters;
}

void ResetMeterLocked(Meter *meter)
{
	std::fill(std::begin(meter->magnitude), std::end(meter->magnitude), 0.0f);
	std::fill(std::begin(meter->peak), std::end(meter->peak), 0.0f);
	meter->lastUpdate = 0;
}

/*! Publish every metered input's levels.  Runs on the main thread. */
void EmitInputVolumeMeters()
{
	if (Meters().isEmpty()) {
		return;
	}

	const uint64_t now = os_gettime_ns();
	QJsonArray inputs;
	for (auto it = Meters().cbegin(); it != Meters().cend(); ++it) {
		obs_source_t *source = it.key();
		Meter *meter = it.value();

		QMutexLocker locker(&meter->mutex);
		if (meter->lastUpdate != 0 && now - meter->lastUpdate > 300000000ULL) {
			/* Nothing arrived for 300 ms: the source went quiet. */
			ResetMeterLocked(meter);
		}

		const float volume = meter->muted ? 0.0f : meter->volume;
		QJsonArray levels;
		for (int channel = 0; channel < meter->channels; channel++) {
			QJsonArray level;
			level.append(meter->magnitude[channel] * volume);
			level.append(meter->peak[channel] * volume);
			level.append(meter->peak[channel]);
			levels.append(level);
		}

		QJsonObject entry;
		entry["inputName"] = NameOf(source);
		entry["inputUuid"] = UuidOf(source);
		entry["inputLevelsMul"] = levels;
		inputs.append(entry);
	}

	QJsonObject eventData;
	eventData["inputs"] = inputs;
	Emit(QStringLiteral("InputVolumeMeters"), eventData, Intent::InputVolumeMeters);
}

QTimer *MeterTimer()
{
	static QTimer *timer = nullptr;
	if (!timer) {
		timer = new QTimer(QCoreApplication::instance());
		timer->setInterval(16);
		QObject::connect(timer, &QTimer::timeout, timer, [] { EmitInputVolumeMeters(); });
	}
	return timer;
}

void AudioCapture(void *param, obs_source_t *, const struct audio_data *data, bool muted)
{
	auto *meter = static_cast<Meter *>(param);
	if (!meter || !data) {
		return;
	}

	QMutexLocker locker(&meter->mutex);

	int channels = 0;
	for (int plane = 0; plane < MAX_AV_PLANES; plane++) {
		if (data->data[plane]) {
			channels++;
		}
	}
	channels = std::clamp(channels, 0, static_cast<int>(MAX_AUDIO_CHANNELS));
	if (channels != meter->channels) {
		meter->channels = channels;
		ResetMeterLocked(meter);
	}

	meter->muted = muted;

	int channel = 0;
	for (int plane = 0; channel < meter->channels; plane++) {
		const float *samples = reinterpret_cast<const float *>(data->data[plane]);
		if (!samples) {
			continue;
		}

		float peak = 0.0f;
		double sum = 0.0;
		for (size_t i = 0; i < data->frames; i++) {
			const float sample = samples[i];
			const float magnitude = std::fabs(sample);
			if (magnitude > peak) {
				peak = magnitude;
			}
			sum += static_cast<double>(sample) * sample;
		}

		meter->peak[channel] = peak;
		meter->magnitude[channel] =
			data->frames ? static_cast<float>(std::sqrt(sum / static_cast<double>(data->frames))) : 0.0f;
		channel++;
	}
	for (; channel < MAX_AUDIO_CHANNELS; channel++) {
		meter->peak[channel] = 0.0f;
		meter->magnitude[channel] = 0.0f;
	}

	meter->lastUpdate = os_gettime_ns();
}

void AttachMeter(obs_source_t *source)
{
	if (!source || Meters().contains(source)) {
		return;
	}
	/* Only sources that actually carry audio are worth metering. */
	if ((obs_source_get_output_flags(source) & OBS_SOURCE_AUDIO) == 0) {
		return;
	}

	auto *meter = new Meter();
	meter->volume = obs_source_get_volume(source);
	Meters().insert(source, meter);
	obs_source_add_audio_capture_callback(source, AudioCapture, meter);
	MeterTimer()->start();
}

void DetachMeter(obs_source_t *source)
{
	Meter *meter = Meters().take(source);
	if (!meter) {
		return;
	}
	obs_source_remove_audio_capture_callback(source, AudioCapture, meter);
	delete meter;
	if (Meters().isEmpty()) {
		MeterTimer()->stop();
	}
}

/* --------------------------------------------------------- source events -- */

/* Every signal callback has the same shape.  Several handlers use only one of
 * the two arguments (or neither) and the frontend builds with
 * -Werror=unused-parameter, hence the attribute rather than a cast. */
#define HANDLE(name)                                                                                        \
	void name([[maybe_unused]] void *param, [[maybe_unused]] calldata_t *data)

HANDLE(OnInputActive)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	eventData["videoActive"] = obs_source_active(source);
	Emit(QStringLiteral("InputActiveStateChanged"), eventData, Intent::InputActiveStateChanged);
}

HANDLE(OnInputShow)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	eventData["videoShowing"] = obs_source_showing(source);
	Emit(QStringLiteral("InputShowStateChanged"), eventData, Intent::InputShowStateChanged);
}

HANDLE(OnInputMute)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	eventData["inputMuted"] = obs_source_muted(source);
	Emit(QStringLiteral("InputMuteStateChanged"), eventData, Intent::Inputs);
}

HANDLE(OnInputVolume)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}

	const float volume = obs_source_get_volume(source);
	if (Meter *meter = Meters().value(source)) {
		QMutexLocker locker(&meter->mutex);
		meter->volume = volume;
	}

	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	eventData["inputVolumeMul"] = volume;
	eventData["inputVolumeDb"] = obs_mul_to_db(volume);
	Emit(QStringLiteral("InputVolumeChanged"), eventData, Intent::Inputs);
}

HANDLE(OnInputAudioBalance)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	eventData["inputAudioBalance"] = obs_source_get_balance_value(source);
	Emit(QStringLiteral("InputAudioBalanceChanged"), eventData, Intent::Inputs);
}

HANDLE(OnInputAudioSync)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	/* libobs reports nanoseconds; the protocol reports milliseconds. */
	eventData["inputAudioSyncOffset"] = obs_source_get_sync_offset(source) / 1000000.0;
	Emit(QStringLiteral("InputAudioSyncOffsetChanged"), eventData, Intent::Inputs);
}

HANDLE(OnInputAudioTracks)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	eventData["inputAudioTracks"] = AudioTracksJson(obs_source_get_audio_mixers(source));
	Emit(QStringLiteral("InputAudioTracksChanged"), eventData, Intent::Inputs);
}

HANDLE(OnInputAudioMonitorType)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	eventData["monitorType"] = MonitoringTypeName(MonitoringTypeOf(source));
	Emit(QStringLiteral("InputAudioMonitorTypeChanged"), eventData, Intent::Inputs);
}

void EmitMediaAction(obs_source_t *source, const char *action)
{
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	eventData["mediaAction"] = QString::fromLatin1(action);
	Emit(QStringLiteral("MediaInputActionTriggered"), eventData, Intent::MediaInputs);
}

HANDLE(OnMediaStarted)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	Emit(QStringLiteral("MediaInputPlaybackStarted"), eventData, Intent::MediaInputs);
}

HANDLE(OnMediaEnded)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!IsInput(source)) {
		return;
	}
	QJsonObject eventData;
	eventData["inputName"] = NameOf(source);
	eventData["inputUuid"] = UuidOf(source);
	Emit(QStringLiteral("MediaInputPlaybackEnded"), eventData, Intent::MediaInputs);
}

#define MEDIA_ACTION_HANDLER(name, action)                                                                  \
	HANDLE(name)                                                                                        \
	{                                                                                                   \
		EmitMediaAction(static_cast<obs_source_t *>(param), action);                                \
	}

MEDIA_ACTION_HANDLER(OnMediaPause, "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE")
MEDIA_ACTION_HANDLER(OnMediaPlay, "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY")
MEDIA_ACTION_HANDLER(OnMediaRestart, "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART")
MEDIA_ACTION_HANDLER(OnMediaStopped, "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP")
MEDIA_ACTION_HANDLER(OnMediaNext, "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT")
MEDIA_ACTION_HANDLER(OnMediaPrevious, "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS")

/* ---- scenes ------------------------------------------------------------ */

/*! The scene a scene signal belongs to: the signal's own context first (some
 *  libobs signals carry no calldata at all), the calldata as a fallback. */
obs_scene_t *SceneForSignal(void *param, calldata_t *data)
{
	if (obs_scene_t *scene = CalldataPointer<obs_scene_t>(data, "scene")) {
		return scene;
	}
	return obs_scene_from_source(static_cast<obs_source_t *>(param));
}

void EmitSceneItemEvent(const char *eventType, obs_scene_t *scene, obs_sceneitem_t *item, int intent)
{
	if (!scene || !item) {
		return;
	}
	obs_source_t *sceneSource = obs_scene_get_source(scene);
	obs_source_t *itemSource = obs_sceneitem_get_source(item);

	QJsonObject eventData;
	eventData["sceneName"] = NameOf(sceneSource);
	eventData["sceneUuid"] = UuidOf(sceneSource);
	eventData["sourceName"] = NameOf(itemSource);
	eventData["sourceUuid"] = UuidOf(itemSource);
	eventData["sceneItemId"] = static_cast<double>(obs_sceneitem_get_id(item));
	Emit(QString::fromLatin1(eventType), eventData, intent);
}

HANDLE(OnSceneItemCreated)
{
	obs_scene_t *scene = SceneForSignal(param, data);
	obs_sceneitem_t *item = CalldataPointer<obs_sceneitem_t>(data, "item");
	if (!scene || !item) {
		return;
	}
	EmitSceneItemEvent("SceneItemCreated", scene, item, Intent::SceneItems);
}

HANDLE(OnSceneItemRemoved)
{
	obs_scene_t *scene = SceneForSignal(param, data);
	obs_sceneitem_t *item = CalldataPointer<obs_sceneitem_t>(data, "item");
	if (!scene || !item) {
		return;
	}
	EmitSceneItemEvent("SceneItemRemoved", scene, item, Intent::SceneItems);
}

HANDLE(OnSceneItemVisible)
{
	obs_scene_t *scene = SceneForSignal(param, data);
	obs_sceneitem_t *item = CalldataPointer<obs_sceneitem_t>(data, "item");
	if (!scene || !item) {
		return;
	}
	obs_source_t *sceneSource = obs_scene_get_source(scene);
	QJsonObject eventData;
	eventData["sceneName"] = NameOf(sceneSource);
	eventData["sceneUuid"] = UuidOf(sceneSource);
	eventData["sceneItemId"] = static_cast<double>(obs_sceneitem_get_id(item));
	eventData["sceneItemEnabled"] = obs_sceneitem_visible(item);
	Emit(QStringLiteral("SceneItemEnableStateChanged"), eventData, Intent::SceneItems);
}

HANDLE(OnSceneItemLocked)
{
	obs_scene_t *scene = SceneForSignal(param, data);
	obs_sceneitem_t *item = CalldataPointer<obs_sceneitem_t>(data, "item");
	if (!scene || !item) {
		return;
	}
	obs_source_t *sceneSource = obs_scene_get_source(scene);
	QJsonObject eventData;
	eventData["sceneName"] = NameOf(sceneSource);
	eventData["sceneUuid"] = UuidOf(sceneSource);
	eventData["sceneItemId"] = static_cast<double>(obs_sceneitem_get_id(item));
	eventData["sceneItemLocked"] = obs_sceneitem_locked(item);
	Emit(QStringLiteral("SceneItemLockStateChanged"), eventData, Intent::SceneItems);
}

HANDLE(OnSceneItemTransform)
{
	obs_sceneitem_t *item = CalldataPointer<obs_sceneitem_t>(data, "item");
	if (!item) {
		return;
	}
	obs_scene_t *scene = obs_sceneitem_get_scene(item);
	if (!scene) {
		scene = SceneForSignal(param, data);
	}
	if (!scene) {
		return;
	}
	obs_source_t *sceneSource = obs_scene_get_source(scene);

	QJsonObject eventData;
	eventData["sceneName"] = NameOf(sceneSource);
	eventData["sceneUuid"] = UuidOf(sceneSource);
	eventData["sceneItemId"] = static_cast<double>(obs_sceneitem_get_id(item));
	eventData["sceneItemTransform"] = SceneItemTransformJson(item);
	Emit(QStringLiteral("SceneItemTransformChanged"), eventData, Intent::SceneItemTransformChanged);
}

HANDLE(OnSceneReorder)
{
	obs_scene_t *scene = SceneForSignal(param, data);
	if (!scene) {
		return;
	}
	obs_source_t *sceneSource = obs_scene_get_source(scene);

	QJsonObject eventData;
	eventData["sceneName"] = NameOf(sceneSource);
	eventData["sceneUuid"] = UuidOf(sceneSource);
	eventData["sceneItems"] = SceneItemArray(scene, true);
	Emit(QStringLiteral("SceneItemListReindexed"), eventData, Intent::SceneItems);
}

/* ---- filters ----------------------------------------------------------- */

HANDLE(OnFilterAdded)
{
	auto *source = static_cast<obs_source_t *>(param);
	auto *filter = CalldataPointer<obs_source_t>(data, "filter");
	if (!source || !filter) {
		return;
	}

	OBSDataAutoRelease settings = obs_source_get_settings(filter);

	QJsonObject eventData;
	eventData["sourceName"] = NameOf(source);
	eventData["filterName"] = NameOf(filter);
	eventData["filterKind"] = QString::fromUtf8(obs_source_get_id(filter));
	eventData["filterIndex"] = static_cast<int>(FilterArray(source).size());
	eventData["filterSettings"] = ObsDataToJson(settings);
	Emit(QStringLiteral("SourceFilterCreated"), eventData, Intent::Filters);
}

HANDLE(OnFilterRemoved)
{
	auto *source = static_cast<obs_source_t *>(param);
	auto *filter = CalldataPointer<obs_source_t>(data, "filter");
	if (!source || !filter) {
		return;
	}
	QJsonObject eventData;
	eventData["sourceName"] = NameOf(source);
	eventData["filterName"] = NameOf(filter);
	Emit(QStringLiteral("SourceFilterRemoved"), eventData, Intent::Filters);
}

HANDLE(OnFiltersReordered)
{
	auto *source = static_cast<obs_source_t *>(param);
	if (!source) {
		return;
	}
	QJsonObject eventData;
	eventData["sourceName"] = NameOf(source);
	eventData["filters"] = FilterArray(source);
	Emit(QStringLiteral("SourceFilterListReindexed"), eventData, Intent::Filters);
}

HANDLE(OnFilterEnabled)
{
	auto *filter = static_cast<obs_source_t *>(param);
	obs_source_t *parent = filter ? obs_filter_get_parent(filter) : nullptr;
	if (!filter || !parent) {
		return;
	}
	QJsonObject eventData;
	eventData["sourceName"] = NameOf(parent);
	eventData["filterName"] = NameOf(filter);
	eventData["filterEnabled"] = obs_source_enabled(filter);
	Emit(QStringLiteral("SourceFilterEnableStateChanged"), eventData, Intent::Filters);
}

HANDLE(OnFilterRenamed)
{
	auto *filter = static_cast<obs_source_t *>(param);
	obs_source_t *parent = filter ? obs_filter_get_parent(filter) : nullptr;
	if (!filter || !parent) {
		return;
	}
	QJsonObject eventData;
	eventData["sourceName"] = NameOf(parent);
	eventData["oldFilterName"] = QString::fromUtf8(calldata_string(data, "prev_name"));
	eventData["filterName"] = NameOf(filter);
	Emit(QStringLiteral("SourceFilterNameChanged"), eventData, Intent::Filters);
}

HANDLE(OnFilterUpdated)
{
	auto *filter = static_cast<obs_source_t *>(param);
	obs_source_t *parent = filter ? obs_filter_get_parent(filter) : nullptr;
	if (!filter || !parent) {
		return;
	}
	OBSDataAutoRelease settings = obs_source_get_settings(filter);
	QJsonObject eventData;
	eventData["sourceName"] = NameOf(parent);
	eventData["filterName"] = NameOf(filter);
	eventData["filterSettings"] = ObsDataToJson(settings);
	Emit(QStringLiteral("SourceFilterSettingsChanged"), eventData, Intent::Filters);
}

/* ---- transitions ------------------------------------------------------- */

HANDLE(OnTransitionStarted)
{
	auto *transition = static_cast<obs_source_t *>(param);
	if (!IsTransition(transition)) {
		return;
	}
	QJsonObject eventData;
	eventData["transitionName"] = NameOf(transition);
	eventData["transitionUuid"] = UuidOf(transition);
	Emit(QStringLiteral("SceneTransitionStarted"), eventData, Intent::Transitions);
}

HANDLE(OnTransitionEnded)
{
	auto *transition = static_cast<obs_source_t *>(param);
	if (!IsTransition(transition)) {
		return;
	}
	QJsonObject eventData;
	eventData["transitionName"] = NameOf(transition);
	eventData["transitionUuid"] = UuidOf(transition);
	Emit(QStringLiteral("SceneTransitionEnded"), eventData, Intent::Transitions);
}

HANDLE(OnTransitionVideoEnded)
{
	auto *transition = static_cast<obs_source_t *>(param);
	if (!IsTransition(transition)) {
		return;
	}
	QJsonObject eventData;
	eventData["transitionName"] = NameOf(transition);
	eventData["transitionUuid"] = UuidOf(transition);
	Emit(QStringLiteral("SceneTransitionVideoEnded"), eventData, Intent::Transitions);
}

/* ---- core signals ------------------------------------------------------ */

HANDLE(OnSourceCreated)
{
	auto *source = CalldataPointer<obs_source_t>(data, "source");
	if (!source) {
		return;
	}

	if (IsInput(source)) {
		OBSDataAutoRelease settings = obs_source_get_settings(source);
		QJsonObject eventData;
		eventData["inputName"] = NameOf(source);
		eventData["inputUuid"] = UuidOf(source);
		eventData["inputKind"] = QString::fromUtf8(obs_source_get_id(source));
		eventData["unversionedInputKind"] = QString::fromUtf8(obs_source_get_unversioned_id(source));
		eventData["inputKindCaps"] = static_cast<int>(obs_source_get_output_flags(source));
		eventData["inputSettings"] = ObsDataToJson(settings);
		Emit(QStringLiteral("InputCreated"), eventData, Intent::Inputs);
	} else if (IsScene(source)) {
		QJsonObject eventData;
		eventData["sceneName"] = NameOf(source);
		eventData["sceneUuid"] = UuidOf(source);
		eventData["isGroup"] = obs_source_is_group(source);
		Emit(QStringLiteral("SceneCreated"), eventData, Intent::Scenes);
	}

	ConnectSourceEvents(source);
}

HANDLE(OnSourceDestroyed)
{
	auto *source = CalldataPointer<obs_source_t>(data, "source");
	if (!source) {
		return;
	}

	DisconnectSourceEvents(source);

	if (IsInput(source)) {
		QJsonObject eventData;
		eventData["inputName"] = NameOf(source);
		eventData["inputUuid"] = UuidOf(source);
		Emit(QStringLiteral("InputRemoved"), eventData, Intent::Inputs);
	} else if (IsScene(source)) {
		QJsonObject eventData;
		eventData["sceneName"] = NameOf(source);
		eventData["sceneUuid"] = UuidOf(source);
		eventData["isGroup"] = obs_source_is_group(source);
		Emit(QStringLiteral("SceneRemoved"), eventData, Intent::Scenes);
	}
}

HANDLE(OnSourceRenamed)
{
	auto *source = CalldataPointer<obs_source_t>(data, "source");
	if (!source) {
		return;
	}
	const QString previous = QString::fromUtf8(calldata_string(data, "prev_name"));

	if (IsInput(source)) {
		QJsonObject eventData;
		eventData["inputUuid"] = UuidOf(source);
		eventData["oldInputName"] = previous;
		eventData["inputName"] = NameOf(source);
		Emit(QStringLiteral("InputNameChanged"), eventData, Intent::Inputs);
	} else if (IsScene(source)) {
		QJsonObject eventData;
		eventData["sceneUuid"] = UuidOf(source);
		eventData["oldSceneName"] = previous;
		eventData["sceneName"] = NameOf(source);
		Emit(QStringLiteral("SceneNameChanged"), eventData, Intent::Scenes);
	}
}

/* ---- outputs ----------------------------------------------------------- */

HANDLE(OnRecordFileChanged)
{
	QJsonObject eventData;
	eventData["newOutputPath"] = QString::fromUtf8(calldata_string(data, "next_file"));
	Emit(QStringLiteral("RecordFileChanged"), eventData, Intent::Outputs);
}

/* ---- frontend events --------------------------------------------------- */

void EmitOutputState(const char *eventType, const char *prefix, const char *suffix, bool active,
		     const QJsonObject &extra = QJsonObject())
{
	QJsonObject eventData;
	eventData["outputActive"] = active;
	eventData["outputState"] = OutputStateName(prefix, suffix);
	for (auto it = extra.begin(); it != extra.end(); ++it) {
		eventData[it.key()] = it.value();
	}
	Emit(QString::fromLatin1(eventType), eventData, Intent::Outputs);
}

QString TakeFrontendString(char *value)
{
	if (!value) {
		return QString();
	}
	const QString text = QString::fromUtf8(value);
	bfree(value);
	return text;
}

void OnFrontendEvent(enum obs_frontend_event event, void *)
{
	switch (event) {
	case OBS_FRONTEND_EVENT_STREAMING_STARTING:
		EmitOutputState("StreamStateChanged", "OBS_WEBSOCKET_OUTPUT", "STARTING", false);
		break;
	case OBS_FRONTEND_EVENT_STREAMING_STARTED:
		EmitOutputState("StreamStateChanged", "OBS_WEBSOCKET_OUTPUT", "STARTED", true);
		break;
	case OBS_FRONTEND_EVENT_STREAMING_STOPPING:
		EmitOutputState("StreamStateChanged", "OBS_WEBSOCKET_OUTPUT", "STOPPING", true);
		break;
	case OBS_FRONTEND_EVENT_STREAMING_STOPPED:
		EmitOutputState("StreamStateChanged", "OBS_WEBSOCKET_OUTPUT", "STOPPED", false);
		break;

	case OBS_FRONTEND_EVENT_RECORDING_STARTING:
		EmitOutputState("RecordStateChanged", "OBS_WEBSOCKET_OUTPUT", "STARTING", false);
		break;
	case OBS_FRONTEND_EVENT_RECORDING_STARTED: {
		if (obs_output_t *output = obs_frontend_get_recording_output()) {
			signal_handler_t *handler = obs_output_get_signal_handler(output);
			signal_handler_connect(handler, "file_changed", OnRecordFileChanged, nullptr);
			obs_output_release(output);
		}
		EmitOutputState("RecordStateChanged", "OBS_WEBSOCKET_OUTPUT", "STARTED", true);
		break;
	}
	case OBS_FRONTEND_EVENT_RECORDING_STOPPING:
		EmitOutputState("RecordStateChanged", "OBS_WEBSOCKET_OUTPUT", "STOPPING", true);
		break;
	case OBS_FRONTEND_EVENT_RECORDING_STOPPED: {
		QJsonObject extra;
		extra["outputPath"] = TakeFrontendString(obs_frontend_get_last_recording());
		EmitOutputState("RecordStateChanged", "OBS_WEBSOCKET_OUTPUT", "STOPPED", false, extra);
		break;
	}
	case OBS_FRONTEND_EVENT_RECORDING_PAUSED:
		EmitOutputState("RecordStateChanged", "OBS_WEBSOCKET_OUTPUT", "PAUSED", true);
		break;
	case OBS_FRONTEND_EVENT_RECORDING_UNPAUSED:
		EmitOutputState("RecordStateChanged", "OBS_WEBSOCKET_OUTPUT", "UNPAUSED", true);
		break;

	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STARTING:
		EmitOutputState("ReplayBufferStateChanged", "OBS_WEBSOCKET_OUTPUT", "STARTING", false);
		break;
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STARTED:
		EmitOutputState("ReplayBufferStateChanged", "OBS_WEBSOCKET_OUTPUT", "STARTED", true);
		break;
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STOPPING:
		EmitOutputState("ReplayBufferStateChanged", "OBS_WEBSOCKET_OUTPUT", "STOPPING", true);
		break;
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STOPPED:
		EmitOutputState("ReplayBufferStateChanged", "OBS_WEBSOCKET_OUTPUT", "STOPPED", false);
		break;
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_SAVED: {
		QJsonObject eventData;
		eventData["savedReplayPath"] = TakeFrontendString(obs_frontend_get_last_replay());
		Emit(QStringLiteral("ReplayBufferSaved"), eventData, Intent::Outputs);
		break;
	}

	case OBS_FRONTEND_EVENT_VIRTUALCAM_STARTED:
		EmitOutputState("VirtualcamStateChanged", "OBS_WEBSOCKET_OUTPUT", "STARTED", true);
		break;
	case OBS_FRONTEND_EVENT_VIRTUALCAM_STOPPED:
		EmitOutputState("VirtualcamStateChanged", "OBS_WEBSOCKET_OUTPUT", "STOPPED", false);
		break;

	case OBS_FRONTEND_EVENT_SCENE_CHANGED: {
		OBSSourceAutoRelease scene = obs_frontend_get_current_scene();
		QJsonObject eventData;
		eventData["sceneName"] = NameOf(scene);
		eventData["sceneUuid"] = UuidOf(scene);
		Emit(QStringLiteral("CurrentProgramSceneChanged"), eventData, Intent::Scenes);
		break;
	}
	case OBS_FRONTEND_EVENT_PREVIEW_SCENE_CHANGED: {
		OBSSourceAutoRelease scene = obs_frontend_get_current_preview_scene();
		QJsonObject eventData;
		eventData["sceneName"] = NameOf(scene);
		eventData["sceneUuid"] = UuidOf(scene);
		Emit(QStringLiteral("CurrentPreviewSceneChanged"), eventData, Intent::Scenes);
		break;
	}
	case OBS_FRONTEND_EVENT_SCENE_LIST_CHANGED: {
		QJsonObject eventData;
		eventData["scenes"] = SceneArray();
		Emit(QStringLiteral("SceneListChanged"), eventData, Intent::Scenes);
		break;
	}

	case OBS_FRONTEND_EVENT_TRANSITION_CHANGED: {
		OBSSourceAutoRelease transition = obs_frontend_get_current_transition();
		QJsonObject eventData;
		eventData["transitionName"] = NameOf(transition);
		eventData["transitionUuid"] = UuidOf(transition);
		Emit(QStringLiteral("CurrentSceneTransitionChanged"), eventData, Intent::Transitions);
		break;
	}
	case OBS_FRONTEND_EVENT_TRANSITION_DURATION_CHANGED: {
		QJsonObject eventData;
		eventData["transitionDuration"] = obs_frontend_get_transition_duration();
		Emit(QStringLiteral("CurrentSceneTransitionDurationChanged"), eventData, Intent::Transitions);
		break;
	}

	case OBS_FRONTEND_EVENT_STUDIO_MODE_ENABLED:
		Emit(QStringLiteral("StudioModeStateChanged"), QJsonObject{{"studioModeEnabled", true}}, Intent::Ui);
		break;
	case OBS_FRONTEND_EVENT_STUDIO_MODE_DISABLED:
		Emit(QStringLiteral("StudioModeStateChanged"), QJsonObject{{"studioModeEnabled", false}}, Intent::Ui);
		break;

	case OBS_FRONTEND_EVENT_SCENE_COLLECTION_CHANGING: {
		QJsonObject eventData;
		eventData["sceneCollectionName"] = TakeFrontendString(obs_frontend_get_current_scene_collection());
		Emit(QStringLiteral("CurrentSceneCollectionChanging"), eventData, Intent::Config);
		break;
	}
	case OBS_FRONTEND_EVENT_SCENE_COLLECTION_CHANGED: {
		QJsonObject eventData;
		eventData["sceneCollectionName"] = TakeFrontendString(obs_frontend_get_current_scene_collection());
		Emit(QStringLiteral("CurrentSceneCollectionChanged"), eventData, Intent::Config);
		break;
	}
	case OBS_FRONTEND_EVENT_SCENE_COLLECTION_LIST_CHANGED: {
		QJsonArray collections;
		char **names = obs_frontend_get_scene_collections();
		for (size_t i = 0; names && names[i]; i++) {
			collections.append(QString::fromUtf8(names[i]));
		}
		bfree(names);
		QJsonObject eventData;
		eventData["sceneCollections"] = collections;
		Emit(QStringLiteral("SceneCollectionListChanged"), eventData, Intent::Config);
		break;
	}

	case OBS_FRONTEND_EVENT_PROFILE_CHANGING: {
		QJsonObject eventData;
		eventData["profileName"] = TakeFrontendString(obs_frontend_get_current_profile());
		Emit(QStringLiteral("CurrentProfileChanging"), eventData, Intent::Config);
		break;
	}
	case OBS_FRONTEND_EVENT_PROFILE_CHANGED: {
		QJsonObject eventData;
		eventData["profileName"] = TakeFrontendString(obs_frontend_get_current_profile());
		Emit(QStringLiteral("CurrentProfileChanged"), eventData, Intent::Config);
		break;
	}
	case OBS_FRONTEND_EVENT_PROFILE_LIST_CHANGED: {
		QJsonArray profiles;
		char **names = obs_frontend_get_profiles();
		for (size_t i = 0; names && names[i]; i++) {
			profiles.append(QString::fromUtf8(names[i]));
		}
		bfree(names);
		QJsonObject eventData;
		eventData["profiles"] = profiles;
		Emit(QStringLiteral("ProfileListChanged"), eventData, Intent::Config);
		break;
	}

	case OBS_FRONTEND_EVENT_SCREENSHOT_TAKEN: {
		QJsonObject eventData;
		eventData["savedScreenshotPath"] = TakeFrontendString(obs_frontend_get_last_screenshot());
		Emit(QStringLiteral("ScreenshotSaved"), eventData, Intent::Ui);
		break;
	}

	case OBS_FRONTEND_EVENT_EXIT:
		Emit(QStringLiteral("ExitStarted"), QJsonObject(), Intent::General);
		break;

	default:
		break;
	}
}

} // namespace

void ConnectSourceEvents(obs_source_t *source)
{
	if (!source || obs_source_removed(source)) {
		return;
	}
	DisconnectSourceEvents(source);

	signal_handler_t *handler = obs_source_get_signal_handler(source);
	if (!handler) {
		return;
	}

	if (IsInput(source)) {
		signal_handler_connect(handler, "activate", OnInputActive, source);
		signal_handler_connect(handler, "deactivate", OnInputActive, source);
		signal_handler_connect(handler, "show", OnInputShow, source);
		signal_handler_connect(handler, "hide", OnInputShow, source);
		signal_handler_connect(handler, "mute", OnInputMute, source);
		signal_handler_connect(handler, "volume", OnInputVolume, source);
		signal_handler_connect(handler, "audio_balance", OnInputAudioBalance, source);
		signal_handler_connect(handler, "audio_sync", OnInputAudioSync, source);
		signal_handler_connect(handler, "audio_mixers", OnInputAudioTracks, source);
		signal_handler_connect(handler, "audio_monitoring", OnInputAudioMonitorType, source);
		signal_handler_connect(handler, "media_started", OnMediaStarted, source);
		signal_handler_connect(handler, "media_ended", OnMediaEnded, source);
		signal_handler_connect(handler, "media_pause", OnMediaPause, source);
		signal_handler_connect(handler, "media_play", OnMediaPlay, source);
		signal_handler_connect(handler, "media_restart", OnMediaRestart, source);
		signal_handler_connect(handler, "media_stopped", OnMediaStopped, source);
		signal_handler_connect(handler, "media_next", OnMediaNext, source);
		signal_handler_connect(handler, "media_previous", OnMediaPrevious, source);
		AttachMeter(source);
	}

	if (IsScene(source)) {
		signal_handler_connect(handler, "item_add", OnSceneItemCreated, source);
		signal_handler_connect(handler, "item_remove", OnSceneItemRemoved, source);
		signal_handler_connect(handler, "reorder", OnSceneReorder, source);
		signal_handler_connect(handler, "item_visible", OnSceneItemVisible, source);
		signal_handler_connect(handler, "item_locked", OnSceneItemLocked, source);
		signal_handler_connect(handler, "item_transform", OnSceneItemTransform, source);
	}

	if (IsInput(source) || IsScene(source)) {
		signal_handler_connect(handler, "filter_add", OnFilterAdded, source);
		signal_handler_connect(handler, "filter_remove", OnFilterRemoved, source);
		signal_handler_connect(handler, "reorder_filters", OnFiltersReordered, source);

		/* Filters are sources of their own and are also connected, exactly
		 * like the desktop UI expects: the parent's signals never mention
		 * a filter's own enable/rename changes. */
		auto enumerate = [](obs_source_t *, obs_source_t *filter, void *) {
			ConnectSourceEvents(filter);
		};
		obs_source_enum_filters(source, enumerate, nullptr);
	}

	if (obs_source_get_type(source) == OBS_SOURCE_TYPE_FILTER) {
		signal_handler_connect(handler, "enable", OnFilterEnabled, source);
		signal_handler_connect(handler, "rename", OnFilterRenamed, source);
		signal_handler_connect(handler, "update_properties", OnFilterUpdated, source);
	}

	if (IsTransition(source)) {
		signal_handler_connect(handler, "transition_start", OnTransitionStarted, source);
		signal_handler_connect(handler, "transition_stop", OnTransitionEnded, source);
		signal_handler_connect(handler, "transition_video_stop", OnTransitionVideoEnded, source);
	}
}

void DisconnectSourceEvents(obs_source_t *source)
{
	if (!source) {
		return;
	}

	signal_handler_t *handler = obs_source_get_signal_handler(source);
	if (handler) {
		if (IsInput(source)) {
			signal_handler_disconnect(handler, "activate", OnInputActive, source);
			signal_handler_disconnect(handler, "deactivate", OnInputActive, source);
			signal_handler_disconnect(handler, "show", OnInputShow, source);
			signal_handler_disconnect(handler, "hide", OnInputShow, source);
			signal_handler_disconnect(handler, "mute", OnInputMute, source);
			signal_handler_disconnect(handler, "volume", OnInputVolume, source);
			signal_handler_disconnect(handler, "audio_balance", OnInputAudioBalance, source);
			signal_handler_disconnect(handler, "audio_sync", OnInputAudioSync, source);
			signal_handler_disconnect(handler, "audio_mixers", OnInputAudioTracks, source);
			signal_handler_disconnect(handler, "audio_monitoring", OnInputAudioMonitorType, source);
			signal_handler_disconnect(handler, "media_started", OnMediaStarted, source);
			signal_handler_disconnect(handler, "media_ended", OnMediaEnded, source);
			signal_handler_disconnect(handler, "media_pause", OnMediaPause, source);
			signal_handler_disconnect(handler, "media_play", OnMediaPlay, source);
			signal_handler_disconnect(handler, "media_restart", OnMediaRestart, source);
			signal_handler_disconnect(handler, "media_stopped", OnMediaStopped, source);
			signal_handler_disconnect(handler, "media_next", OnMediaNext, source);
			signal_handler_disconnect(handler, "media_previous", OnMediaPrevious, source);
			DetachMeter(source);
		}

		if (IsScene(source)) {
			signal_handler_disconnect(handler, "item_add", OnSceneItemCreated, source);
			signal_handler_disconnect(handler, "item_remove", OnSceneItemRemoved, source);
			signal_handler_disconnect(handler, "reorder", OnSceneReorder, source);
			signal_handler_disconnect(handler, "item_visible", OnSceneItemVisible, source);
			signal_handler_disconnect(handler, "item_locked", OnSceneItemLocked, source);
			signal_handler_disconnect(handler, "item_transform", OnSceneItemTransform, source);
		}

		if (IsInput(source) || IsScene(source)) {
			signal_handler_disconnect(handler, "filter_add", OnFilterAdded, source);
			signal_handler_disconnect(handler, "filter_remove", OnFilterRemoved, source);
			signal_handler_disconnect(handler, "reorder_filters", OnFiltersReordered, source);
		}

		if (obs_source_get_type(source) == OBS_SOURCE_TYPE_FILTER) {
			signal_handler_disconnect(handler, "enable", OnFilterEnabled, source);
			signal_handler_disconnect(handler, "rename", OnFilterRenamed, source);
			signal_handler_disconnect(handler, "update_properties", OnFilterUpdated, source);
		}

		if (IsTransition(source)) {
			signal_handler_disconnect(handler, "transition_start", OnTransitionStarted, source);
			signal_handler_disconnect(handler, "transition_stop", OnTransitionEnded, source);
			signal_handler_disconnect(handler, "transition_video_stop", OnTransitionVideoEnded, source);
		}
	}

	/* Filters are not enumerated here: libobs destroys them together with
	 * their parent, and each filter got its own disconnect when it was
	 * removed (its own "destroy" is not forwarded to us). */
}

namespace {

void OnCoreSource(void *param, calldata_t *data)
{
	switch (reinterpret_cast<intptr_t>(param)) {
	case 0:
		OnSourceCreated(nullptr, data);
		break;
	case 1:
		OnSourceDestroyed(nullptr, data);
		break;
	case 2:
		OnSourceRenamed(nullptr, data);
		break;
	default:
		break;
	}
}

signal_handler_t *CoreSignals()
{
	return obs_get_signal_handler();
}

} // namespace

void RegisterEventSources()
{
	obs_frontend_add_event_callback(OnFrontendEvent, nullptr);

	if (signal_handler_t *core = CoreSignals()) {
		signal_handler_connect(core, "source_create", OnCoreSource, reinterpret_cast<void *>(0));
		signal_handler_connect(core, "source_create_canvas", OnCoreSource, reinterpret_cast<void *>(0));
		signal_handler_connect(core, "source_destroy", OnCoreSource, reinterpret_cast<void *>(1));
		signal_handler_connect(core, "source_remove", OnCoreSource, reinterpret_cast<void *>(1));
		signal_handler_connect(core, "source_rename", OnCoreSource, reinterpret_cast<void *>(2));
	}

	/* Wire up everything that already exists. */
	auto connectAll = [](void *param, obs_source_t *source) {
		UNUSED_PARAMETER(param);
		ConnectSourceEvents(source);
		return true;
	};
	obs_enum_sources(connectAll, nullptr);
	obs_enum_scenes(connectAll, nullptr);

	obs_frontend_source_list transitions = {};
	obs_frontend_get_transitions(&transitions);
	for (size_t i = 0; i < transitions.sources.num; i++) {
		ConnectSourceEvents(transitions.sources.array[i]);
	}
	obs_frontend_source_list_free(&transitions);

	/* The recording output only exists while recording; a file split can only
	 * happen then, so the signal is connected on start (see OnFrontendEvent). */
}

void UnregisterEventSources()
{
	if (signal_handler_t *core = CoreSignals()) {
		signal_handler_disconnect(core, "source_create", OnCoreSource, reinterpret_cast<void *>(0));
		signal_handler_disconnect(core, "source_create_canvas", OnCoreSource, reinterpret_cast<void *>(0));
		signal_handler_disconnect(core, "source_destroy", OnCoreSource, reinterpret_cast<void *>(1));
		signal_handler_disconnect(core, "source_remove", OnCoreSource, reinterpret_cast<void *>(1));
		signal_handler_disconnect(core, "source_rename", OnCoreSource, reinterpret_cast<void *>(2));
	}

	obs_frontend_remove_event_callback(OnFrontendEvent, nullptr);

	auto disconnectAll = [](void *param, obs_source_t *source) {
		UNUSED_PARAMETER(param);
		DisconnectSourceEvents(source);
		return true;
	};
	obs_enum_sources(disconnectAll, nullptr);
	obs_enum_scenes(disconnectAll, nullptr);

	/* The meters own audio capture callbacks; drop them all. */
	for (auto it = Meters().begin(); it != Meters().end(); ++it) {
		obs_source_remove_audio_capture_callback(it.key(), AudioCapture, it.value());
		delete it.value();
	}
	Meters().clear();
	MeterTimer()->stop();
}

} // namespace WebMixControl
