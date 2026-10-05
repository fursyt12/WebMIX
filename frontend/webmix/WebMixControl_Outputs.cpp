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

/* WebMIX: the scene transition and the output (stream/record/replay/virtual
 * cam) requests.  Everything here goes straight through the frontend API, so
 * the behaviour - including "already running" refusals - matches what the
 * desktop UI does for the same button press. */

#include "WebMixControlInternal.hpp"

#include <obs-frontend-api.h>

#include <util/platform.h>
#include <util/util.hpp>
#include <util/util_uint64.h>

#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>

#include <cmath>

namespace WebMixControl {

namespace {

/*! The desk clock the UI shows for an output, derived from the frames the
 *  output has processed.  obs-websocket reports the same shape, and the
 *  frontend parses it back into milliseconds. */
QString DurationToTimecode(uint64_t durationMs)
{
	const uint64_t totalSeconds = durationMs / 1000ULL;
	const uint64_t hoursPart = totalSeconds / 3600ULL;
	const uint64_t minutesPart = (totalSeconds / 60ULL) % 60ULL;
	const uint64_t secondsPart = totalSeconds % 60ULL;
	const uint64_t millisPart = durationMs % 1000ULL;

	return QString::asprintf("%02llu:%02llu:%02llu.%03llu", (unsigned long long)hoursPart,
				 (unsigned long long)minutesPart, (unsigned long long)secondsPart,
				 (unsigned long long)millisPart);
}

/*! How long an output has effectively been running, in milliseconds.  An
 *  inactive output reports 0 so the UI never shows a stale timer. */
uint64_t OutputDuration(obs_output_t *output)
{
	if (!output || !obs_output_active(output)) {
		return 0;
	}
	video_t *video = obs_output_video(output);
	if (!video) {
		return 0;
	}
	return util_mul_div64(static_cast<uint64_t>(obs_output_get_total_frames(output)),
			      video_output_get_frame_time(video), 1000000ULL);
}

/*! The file a finished recording was written to.  The encoder stores it as
 *  `url` (FFmpeg outputs) or `path` (the plain file output). */
QString LastRecordFileName()
{
	OBSOutputAutoRelease output = obs_frontend_get_recording_output();
	if (!output) {
		return QString();
	}

	OBSDataAutoRelease settings = obs_output_get_settings(output);
	if (!settings) {
		return QString();
	}

	obs_data_item_t *item = obs_data_item_byname(settings, "url");
	if (!item) {
		item = obs_data_item_byname(settings, "path");
	}
	if (!item) {
		return QString();
	}

	const char *value = obs_data_item_get_string(item);
	const QString path = value ? QString::fromUtf8(value) : QString();
	obs_data_item_release(&item);
	return path;
}

/*! The current transition as the scene-transition list spells it, with the
 *  name/uuid/kind set to null when OBS has no transition at all. */
QJsonObject TransitionListJson()
{
	QJsonArray transitions;

	obs_frontend_source_list sources = {};
	obs_frontend_get_transitions(&sources);
	for (size_t i = 0; i < sources.sources.num; i++) {
		obs_source_t *transition = sources.sources.array[i];
		if (!transition) {
			continue;
		}

		QJsonObject entry;
		entry["transitionName"] = QString::fromUtf8(obs_source_get_name(transition));
		entry["transitionUuid"] = QString::fromUtf8(obs_source_get_uuid(transition));
		entry["transitionKind"] = QString::fromUtf8(obs_source_get_id(transition));
		entry["transitionFixed"] = obs_transition_fixed(transition);
		entry["transitionConfigurable"] = obs_source_configurable(transition);
		transitions.append(entry);
	}
	obs_frontend_source_list_free(&sources);

	QJsonObject json;
	json["transitions"] = transitions;

	OBSSourceAutoRelease current = obs_frontend_get_current_transition();
	if (current) {
		json["currentSceneTransitionName"] = QString::fromUtf8(obs_source_get_name(current));
		json["currentSceneTransitionUuid"] = QString::fromUtf8(obs_source_get_uuid(current));
		json["currentSceneTransitionKind"] = QString::fromUtf8(obs_source_get_id(current));
	} else {
		json["currentSceneTransitionName"] = QJsonValue::Null;
		json["currentSceneTransitionUuid"] = QJsonValue::Null;
		json["currentSceneTransitionKind"] = QJsonValue::Null;
	}

	return json;
}

} // namespace

/* ---------------------------------------------------------- transitions -- */

void RegisterTransitionHandlers()
{
	AddHandler("GetTransitionKindList", [](const QJsonObject &, Response &response) {
		QJsonArray kinds;
		size_t index = 0;
		const char *kind = nullptr;
		while (obs_enum_transition_types(index++, &kind)) {
			if (kind) {
				kinds.append(QString::fromUtf8(kind));
			}
		}
		response.data["transitionKinds"] = kinds;
	});

	AddHandler("GetSceneTransitionList",
		   [](const QJsonObject &, Response &response) { response.data = TransitionListJson(); });

	AddHandler("GetCurrentSceneTransition", [](const QJsonObject &, Response &response) {
		OBSSourceAutoRelease transition = obs_frontend_get_current_transition();
		if (!transition) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("OBS does not currently have a scene transition set."));
			return;
		}

		response.data["transitionName"] = QString::fromUtf8(obs_source_get_name(transition));
		response.data["transitionUuid"] = QString::fromUtf8(obs_source_get_uuid(transition));
		response.data["transitionKind"] = QString::fromUtf8(obs_source_get_id(transition));

		if (obs_transition_fixed(transition)) {
			/* A fixed transition owns its timing, so the UI hides the
			 * duration control entirely. */
			response.data["transitionFixed"] = true;
			response.data["transitionDuration"] = QJsonValue::Null;
		} else {
			response.data["transitionFixed"] = false;
			response.data["transitionDuration"] = obs_frontend_get_transition_duration();
		}

		if (obs_source_configurable(transition)) {
			response.data["transitionConfigurable"] = true;
			OBSDataAutoRelease settings = obs_source_get_settings(transition);
			response.data["transitionSettings"] = ObsDataToJson(settings);
		} else {
			response.data["transitionConfigurable"] = false;
			response.data["transitionSettings"] = QJsonValue::Null;
		}
	});

	AddHandler("SetCurrentSceneTransition", [](const QJsonObject &requestData, Response &response) {
		const QString name = StringField(requestData, "transitionName");
		if (name.isEmpty()) {
			Fail(response, Status::MissingRequestField, QStringLiteral("A transition name is required."));
			return;
		}

		OBSSource transition = FindTransition(name);
		if (!transition) {
			Fail(response, Status::ResourceNotFound,
			     QStringLiteral("No scene transition was found by that name."));
			return;
		}

		obs_frontend_set_current_transition(transition);
	});

	AddHandler("SetCurrentSceneTransitionDuration", [](const QJsonObject &requestData, Response &response) {
		/* The frontend's spin box uses the same bounds, so an out-of-range
		 * value here is a caller bug rather than something to clamp. */
		const int duration = IntField(requestData, "transitionDuration", -1);
		if (duration < 50 || duration > 20000) {
			Fail(response, Status::RequestFieldOutOfRange,
			     QStringLiteral("transitionDuration must be between 50 and 20000 milliseconds."));
			return;
		}

		obs_frontend_set_transition_duration(duration);
	});

	AddHandler("SetCurrentSceneTransitionSettings", [](const QJsonObject &requestData, Response &response) {
		if (!requestData.value(QStringLiteral("transitionSettings")).isObject()) {
			Fail(response, Status::MissingRequestField,
			     QStringLiteral("transitionSettings must be an object."));
			return;
		}

		OBSSourceAutoRelease transition = obs_frontend_get_current_transition();
		if (!transition) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("OBS does not currently have a scene transition set."));
			return;
		}
		if (!obs_source_configurable(transition)) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The current transition does not support custom settings."));
			return;
		}

		/* `overlay` is the default obs-websocket behaviour: merge into the
		 * existing settings instead of replacing them. */
		bool overlay = true;
		if (requestData.contains(QStringLiteral("overlay"))) {
			overlay = BoolField(requestData, "overlay", true);
		}

		OBSData settings = ObsDataFromJson(requestData.value(QStringLiteral("transitionSettings")).toObject());
		if (!settings) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The transition settings could not be converted."));
			return;
		}

		if (overlay) {
			obs_source_update(transition, settings);
		} else {
			obs_source_reset_settings(transition, settings);
		}
		obs_source_update_properties(transition);
	});

	AddHandler("SetTBarPosition", [](const QJsonObject &requestData, Response &response) {
		if (!obs_frontend_preview_program_mode_active()) {
			Fail(response, Status::StudioModeNotActive, QStringLiteral("Studio mode is not active."));
			return;
		}

		const double position = DoubleField(requestData, "position", -1.0);
		if (position < 0.0 || position > 1.0) {
			Fail(response, Status::RequestFieldOutOfRange,
			     QStringLiteral("position must be between 0.0 and 1.0."));
			return;
		}

		/* Only a caller that plans another update in the same drag keeps the
		 * TBar held, so releasing is the default. */
		bool release = true;
		if (requestData.contains(QStringLiteral("release"))) {
			release = BoolField(requestData, "release", true);
		}

		OBSSourceAutoRelease transition = obs_frontend_get_current_transition();
		if (!transition) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("OBS does not currently have a scene transition set."));
			return;
		}

		/* The TBar works in 1024 steps, like the frontend's own slider. */
		obs_frontend_set_tbar_position(static_cast<int>(std::round(position * 1024.0)));
		if (release) {
			obs_frontend_release_tbar();
		}
	});
}

/* -------------------------------------------------------------- outputs -- */

void RegisterOutputHandlers()
{
	AddHandler("GetStreamStatus", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_streaming_output();
		const uint64_t duration = OutputDuration(output);

		float congestion = output ? obs_output_get_congestion(output) : 0.0f;
		if (std::isnan(congestion)) {
			/* JSON has no NaN, and libobs can report one before the first
			 * packet has been measured. */
			congestion = 0.0f;
		}

		response.data["outputActive"] = output ? obs_output_active(output) : false;
		response.data["outputReconnecting"] = output ? obs_output_reconnecting(output) : false;
		response.data["outputTimecode"] = DurationToTimecode(duration);
		response.data["outputDuration"] = static_cast<double>(duration);
		response.data["outputCongestion"] = static_cast<double>(congestion);
		response.data["outputBytes"] = static_cast<double>(output ? obs_output_get_total_bytes(output) : 0);
		response.data["outputSkippedFrames"] = output ? obs_output_get_frames_dropped(output) : 0;
		response.data["outputTotalFrames"] = output ? obs_output_get_total_frames(output) : 0;
	});

	AddHandler("StartStream", [](const QJsonObject &, Response &response) {
		if (obs_frontend_streaming_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The stream output is already running."));
			return;
		}

		obs_frontend_streaming_start();
	});

	AddHandler("StopStream", [](const QJsonObject &, Response &response) {
		if (!obs_frontend_streaming_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The stream output is not running."));
			return;
		}

		obs_frontend_streaming_stop();
	});

	AddHandler("ToggleStream", [](const QJsonObject &, Response &response) {
		/* The toggle reports the state it just switched to, since the UI
		 * updates its button from the response. */
		if (obs_frontend_streaming_active()) {
			obs_frontend_streaming_stop();
			response.data["outputActive"] = false;
		} else {
			obs_frontend_streaming_start();
			response.data["outputActive"] = true;
		}
	});

	AddHandler("SendStreamCaption", [](const QJsonObject &requestData, Response &response) {
		const QJsonValue caption = requestData.value(QStringLiteral("captionText"));
		if (!caption.isString()) {
			Fail(response, Status::MissingRequestField, QStringLiteral("A caption text is required."));
			return;
		}

		if (!obs_frontend_streaming_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The stream output is not running."));
			return;
		}

		OBSOutputAutoRelease output = obs_frontend_get_streaming_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The stream output is not available."));
			return;
		}

		/* 0.0 means the next caption may follow immediately. */
		obs_output_output_caption_text2(output, caption.toString().toUtf8().constData(), 0.0);
	});

	AddHandler("GetRecordStatus", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_recording_output();
		const uint64_t duration = OutputDuration(output);

		response.data["outputActive"] = output ? obs_output_active(output) : false;
		response.data["outputPaused"] = output ? obs_output_paused(output) : false;
		response.data["outputTimecode"] = DurationToTimecode(duration);
		response.data["outputDuration"] = static_cast<double>(duration);
		response.data["outputBytes"] = static_cast<double>(output ? obs_output_get_total_bytes(output) : 0);
	});

	AddHandler("StartRecord", [](const QJsonObject &, Response &response) {
		if (obs_frontend_recording_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The record output is already running."));
			return;
		}

		obs_frontend_recording_start();
	});

	AddHandler("StopRecord", [](const QJsonObject &, Response &response) {
		if (!obs_frontend_recording_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The record output is not running."));
			return;
		}

		obs_frontend_recording_stop();

		/* The frontend toasts the file it just wrote, so read it back after
		 * the stop has been requested. */
		response.data["outputPath"] = LastRecordFileName();
	});

	AddHandler("ToggleRecord", [](const QJsonObject &, Response &response) {
		if (obs_frontend_recording_active()) {
			obs_frontend_recording_stop();
			response.data["outputActive"] = false;
		} else {
			obs_frontend_recording_start();
			response.data["outputActive"] = true;
		}
	});

	AddHandler("ToggleRecordPause", [](const QJsonObject &, Response &response) {
		if (obs_frontend_recording_paused()) {
			obs_frontend_recording_pause(false);
			response.data["outputPaused"] = false;
		} else {
			obs_frontend_recording_pause(true);
			response.data["outputPaused"] = true;
		}
	});

	AddHandler("SplitRecordFile", [](const QJsonObject &, Response &response) {
		if (!obs_frontend_recording_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The record output is not running."));
			return;
		}

		if (!obs_frontend_recording_split_file()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("Verify that file splitting is enabled in the output settings."));
		}
	});

	AddHandler("CreateRecordChapter", [](const QJsonObject &requestData, Response &response) {
		if (!obs_frontend_recording_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The record output is not running."));
			return;
		}

		/* The name is optional; with no name the muxer picks one. */
		const QString name = StringField(requestData, "chapterName");
		const QByteArray encoded = name.toUtf8();
		if (!obs_frontend_recording_add_chapter(name.isEmpty() ? nullptr : encoded.constData())) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("Verify that the output being used supports chapter markers."));
		}
	});

	AddHandler("GetReplayBufferStatus", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_replay_buffer_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("Replay buffer is not available."));
			return;
		}

		response.data["outputActive"] = obs_frontend_replay_buffer_active();
	});

	AddHandler("StartReplayBuffer", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_replay_buffer_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("Replay buffer is not available."));
			return;
		}
		if (obs_frontend_replay_buffer_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The replay buffer output is already running."));
			return;
		}

		obs_frontend_replay_buffer_start();
	});

	AddHandler("StopReplayBuffer", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_replay_buffer_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("Replay buffer is not available."));
			return;
		}
		if (!obs_frontend_replay_buffer_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The replay buffer output is not running."));
			return;
		}

		obs_frontend_replay_buffer_stop();
	});

	AddHandler("ToggleReplayBuffer", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_replay_buffer_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("Replay buffer is not available."));
			return;
		}

		if (obs_frontend_replay_buffer_active()) {
			obs_frontend_replay_buffer_stop();
			response.data["outputActive"] = false;
		} else {
			obs_frontend_replay_buffer_start();
			response.data["outputActive"] = true;
		}
	});

	AddHandler("SaveReplayBuffer", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_replay_buffer_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("Replay buffer is not available."));
			return;
		}
		if (!obs_frontend_replay_buffer_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The replay buffer output is not running."));
			return;
		}

		obs_frontend_replay_buffer_save();
	});

	AddHandler("GetLastReplayBufferReplay", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_replay_buffer_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("Replay buffer is not available."));
			return;
		}
		if (!obs_frontend_replay_buffer_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The replay buffer output is not running."));
			return;
		}

		BPtr<char> path = obs_frontend_get_last_replay();
		response.data["savedReplayPath"] = path ? QString::fromUtf8(path.Get()) : QString();
	});

	AddHandler("GetVirtualCamStatus", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_virtualcam_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("VirtualCam is not available."));
			return;
		}

		response.data["outputActive"] = obs_frontend_virtualcam_active();
	});

	AddHandler("StartVirtualCam", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_virtualcam_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("VirtualCam is not available."));
			return;
		}
		if (obs_frontend_virtualcam_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The virtual camera output is already running."));
			return;
		}

		obs_frontend_start_virtualcam();
	});

	AddHandler("StopVirtualCam", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_virtualcam_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("VirtualCam is not available."));
			return;
		}
		if (!obs_frontend_virtualcam_active()) {
			Fail(response, Status::InvalidResourceState,
			     QStringLiteral("The virtual camera output is not running."));
			return;
		}

		obs_frontend_stop_virtualcam();
	});

	AddHandler("ToggleVirtualCam", [](const QJsonObject &, Response &response) {
		OBSOutputAutoRelease output = obs_frontend_get_virtualcam_output();
		if (!output) {
			Fail(response, Status::InvalidResourceState, QStringLiteral("VirtualCam is not available."));
			return;
		}

		if (obs_frontend_virtualcam_active()) {
			obs_frontend_stop_virtualcam();
			response.data["outputActive"] = false;
		} else {
			obs_frontend_start_virtualcam();
			response.data["outputActive"] = true;
		}
	});
}

} // namespace WebMixControl
