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

/* WebMIX: operations obs-websocket has no request for at all.
 *
 *  - reordering scenes
 *  - creating / renaming / removing transitions
 *  - reading and rebinding hotkeys
 *
 * The scene and transition work is delegated to OBSBasic's narrow WebMIX seam
 * (frontend/webmix/OBSBasic_WebMix.cpp) so the logic stays in one place; the
 * hotkey work uses the libobs hotkey API and persists exactly like the desktop
 * hotkey page does. */

#include "WebMixBridge.hpp"

#include <widgets/OBSBasic.hpp>

#include <obs-frontend-api.h>
#include <obs-interaction.h>
#include <obs.hpp>

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonObject>
#include <QString>
#include <QVector>

#include <util/platform.h>

#include <cstring>
#include <tuple>
#include <utility>

namespace {

struct HotkeyEntry {
	obs_hotkey_id id = OBS_INVALID_HOTKEY_ID;
	QString name;
	QString description;
	QJsonArray bindings;
};

/*! Find a hotkey id by the name the settings UI and obs-websocket use. */
obs_hotkey_id HotkeyIdByName(const QString &name)
{
	obs_hotkey_id found = OBS_INVALID_HOTKEY_ID;
	auto search = std::make_pair(&name, &found);
	obs_enum_hotkeys(
		[](void *data, obs_hotkey_id id, obs_hotkey_t *key) {
			auto *pair = static_cast<std::pair<const QString *, obs_hotkey_id *> *>(data);
			const char *keyName = obs_hotkey_get_name(key);
			if (keyName && *pair->first == QString::fromUtf8(keyName)) {
				*pair->second = id;
				return false;
			}
			return true;
		},
		&search);
	return found;
}

uint32_t ModifiersFromString(const QString &modifiers)
{
	uint32_t flags = 0;
	for (const QString &part : modifiers.split(',', Qt::SkipEmptyParts)) {
		const QString token = part.trimmed().toLower();
		if (token == "control" || token == "ctrl") {
			flags |= INTERACT_CONTROL_KEY;
		} else if (token == "alt") {
			flags |= INTERACT_ALT_KEY;
		} else if (token == "shift") {
			flags |= INTERACT_SHIFT_KEY;
		} else if (token == "command" || token == "meta") {
			flags |= INTERACT_COMMAND_KEY;
		}
	}
	return flags;
}

/*! Persist a hotkey the way OBSBasicSettings::SaveHotkeySettings() does. */
void SaveHotkeyToConfig(obs_hotkey_id id, const QString &name)
{
	OBSDataArrayAutoRelease array = obs_hotkey_save(id);
	OBSDataAutoRelease data = obs_data_create();
	obs_data_set_array(data, "bindings", array);

	config_t *config = OBSBasic::Get() ? OBSBasic::Get()->Config() : nullptr;
	if (!config) {
		return;
	}
	config_set_string(config, "Hotkeys", name.toUtf8().constData(), obs_data_get_json(data));
	config_save_safe(config, "tmp", nullptr);
	blog(LOG_INFO, "[WebMIX] Hotkey '%s' saved to the active profile", qUtf8Printable(name));
}

} // namespace

namespace WebMixBridge {

QJsonArray Hotkeys()
{
	QVector<HotkeyEntry> entries;
	QHash<obs_hotkey_id, int> indexById;

	obs_enum_hotkeys(
		[](void *data, obs_hotkey_id id, obs_hotkey_t *key) {
			auto *list = static_cast<QVector<HotkeyEntry> *>(data);
			HotkeyEntry entry;
			entry.id = id;
			entry.name = QString::fromUtf8(obs_hotkey_get_name(key) ?: "");
			entry.description = QString::fromUtf8(obs_hotkey_get_description(key) ?: "");
			list->append(entry);
			return true;
		},
		&entries);

	for (int i = 0; i < entries.size(); i++) {
		indexById.insert(entries[i].id, i);
	}

	auto context = std::make_pair(&entries, &indexById);
	obs_enum_hotkey_bindings(
		[](void *data, size_t, obs_hotkey_binding_t *binding) {
			auto *ctx = static_cast<std::pair<QVector<HotkeyEntry> *, QHash<obs_hotkey_id, int> *> *>(data);
			const int index = ctx->second->value(obs_hotkey_binding_get_hotkey_id(binding), -1);
			if (index < 0) {
				return true;
			}

			/* Let OBS format the combination so the web UI shows exactly
			 * what the desktop hotkey page shows. */
			struct dstr text = {0};
			dstr_init(&text);
			obs_key_combination_to_str(obs_hotkey_binding_get_key_combination(binding), &text);
			(*ctx->first)[index].bindings.append(QString::fromUtf8(text.array ?: ""));
			dstr_free(&text);
			return true;
		},
		&context);

	QJsonArray result;
	for (const HotkeyEntry &entry : entries) {
		QJsonObject object;
		object["name"] = entry.name;
		object["description"] = entry.description;
		object["bindings"] = entry.bindings;
		result.append(object);
	}
	return result;
}

bool SetHotkeyBinding(const QString &hotkeyName, const QString &keyName, const QString &modifiers, QString &error)
{
	const obs_hotkey_id id = HotkeyIdByName(hotkeyName);
	if (id == OBS_INVALID_HOTKEY_ID) {
		error = "hotkey not found";
		return false;
	}

	const obs_key_t key = obs_key_from_name(keyName.toUtf8().constData());
	if (key == OBS_KEY_NONE) {
		error = QStringLiteral("unknown key '%1'").arg(keyName);
		return false;
	}

	obs_key_combination_t combination = {ModifiersFromString(modifiers), key};
	obs_hotkey_load_bindings(id, &combination, 1);
	SaveHotkeyToConfig(id, hotkeyName);

	blog(LOG_INFO, "[WebMIX] Hotkey '%s' bound to %s%s", qUtf8Printable(hotkeyName),
	     modifiers.isEmpty() ? "" : qUtf8Printable(modifiers + "+"), qUtf8Printable(keyName));
	return true;
}

bool ClearHotkeyBinding(const QString &hotkeyName, QString &error)
{
	const obs_hotkey_id id = HotkeyIdByName(hotkeyName);
	if (id == OBS_INVALID_HOTKEY_ID) {
		error = "hotkey not found";
		return false;
	}

	obs_hotkey_load_bindings(id, nullptr, 0);
	SaveHotkeyToConfig(id, hotkeyName);

	blog(LOG_INFO, "[WebMIX] Hotkey '%s' cleared", qUtf8Printable(hotkeyName));
	return true;
}

bool MoveScene(int fromIndex, int toIndex, QString &error)
{
	OBSBasic *main = OBSBasic::Get();
	if (!main) {
		error = "OBS is not ready";
		return false;
	}
	if (!main->WebMixMoveScene(fromIndex, toIndex)) {
		error = "scene index out of range";
		return false;
	}
	return true;
}

bool AddTransition(const QString &id, const QString &name, QString &error)
{
	OBSBasic *main = OBSBasic::Get();
	if (!main) {
		error = "OBS is not ready";
		return false;
	}
	if (name.isEmpty()) {
		error = "a transition name is required";
		return false;
	}
	if (!main->WebMixAddTransition(id, name)) {
		error = QStringLiteral("could not create transition '%1' (name taken or unknown kind)").arg(name);
		return false;
	}
	return true;
}

bool RenameTransition(const QString &name, const QString &newName, QString &error)
{
	OBSBasic *main = OBSBasic::Get();
	if (!main) {
		error = "OBS is not ready";
		return false;
	}
	if (!main->WebMixRenameTransition(name, newName)) {
		error = QStringLiteral("could not rename '%1' to '%2'").arg(name, newName);
		return false;
	}
	return true;
}

bool RemoveTransition(const QString &name, QString &error)
{
	OBSBasic *main = OBSBasic::Get();
	if (!main) {
		error = "OBS is not ready";
		return false;
	}
	if (!main->WebMixRemoveTransition(name)) {
		error = QStringLiteral("could not remove '%1' (built-in transitions cannot be removed)").arg(name);
		return false;
	}
	return true;
}

/* Encoder choices for the Simple output mode, mirroring the option set and the
 * localised labels of the desktop Settings dialog (OBSBasicSettings). The web
 * UI stores the same symbolic values ("x264", "nvenc", ...) in the profile, so
 * the two interfaces stay interchangeable. */
QJsonObject EncoderOptions()
{
	struct Option {
		const char *value;
		const char *labelKey;
		const char *requiredEncoder;
	};

	const Option videoOptions[] = {
		{"x264", "Software", nullptr},
		{"x264_lowcpu", "SoftwareLowCPU", nullptr},
		{"qsv", "Hardware.QSV.H264", "obs_qsv11"},
		{"qsv_av1", "Hardware.QSV.AV1", "obs_qsv11_av1"},
		{"nvenc", "Hardware.NVENC.H264", "ffmpeg_nvenc"},
		{"nvenc_av1", "Hardware.NVENC.AV1", "obs_nvenc_av1_tex"},
		{"nvenc_hevc", "Hardware.NVENC.HEVC", "ffmpeg_hevc_nvenc"},
		{"amd", "Hardware.AMD.H264", "h264_texture_amf"},
		{"amd_hevc", "Hardware.AMD.HEVC", "h265_texture_amf"},
		{"amd_av1", "Hardware.AMD.AV1", "av1_texture_amf"},
		{"apple_h264", "Hardware.Apple.H264", "com.apple.videotoolbox.videoencoder.ave.avc"},
		{"apple_hevc", "Hardware.Apple.HEVC", "com.apple.videotoolbox.videoencoder.ave.hevc"},
	};

	const auto available = [](const char *encoderId) {
		if (!encoderId) {
			return true;
		}
		const char *value = nullptr;
		for (int index = 0; obs_enum_encoder_types(index, &value); index++) {
			if (value && strcmp(value, encoderId) == 0) {
				return true;
			}
		}
		return false;
	};

	const auto buildVideo = [&](bool withLowCpu) {
		QJsonArray list;
		for (const Option &option : videoOptions) {
			if (!withLowCpu && strcmp(option.value, "x264_lowcpu") == 0) {
				continue;
			}
			QJsonObject entry;
			entry["value"] = QString::fromUtf8(option.value);
			entry["label"] = QTStr(QStringLiteral("Basic.Settings.Output.Simple.Encoder.%1")
						       .arg(QString::fromUtf8(option.labelKey))
						       .toUtf8()
						       .constData());
			entry["available"] = available(option.requiredEncoder);
			list.append(entry);
		}
		return list;
	};

	/* OBS stores the audio encoder as "aac"/"opus", while the encoder ids are
	 * "ffmpeg_aac"/"ffmpeg_opus"; the profile keys use the short form. */
	QJsonArray audio;
	for (const auto &[value, labelKey, encoderId] :
	     {std::tuple{"aac", "Basic.Settings.Output.Simple.Codec.AAC.Default", "ffmpeg_aac"},
	      std::tuple{"opus", "Basic.Settings.Output.Simple.Codec.Opus", "ffmpeg_opus"}}) {
		QJsonObject entry;
		entry["value"] = QString::fromUtf8(value);
		entry["label"] = QTStr(labelKey);
		entry["available"] = available(encoderId);
		audio.append(entry);
	}

	QJsonObject result;
	result["videoRecording"] = buildVideo(true);
	result["videoStreaming"] = buildVideo(false);
	result["audio"] = audio;
	/* Same order and values as OBSBasicSettings::FillSimpleRecordingValues. */
	QJsonArray formats;
	for (const auto &[value, labelKey] :
	     {std::pair{"flv", "FLV"}, std::pair{"mkv", "MKV"}, std::pair{"mp4", "MP4"}, std::pair{"mov", "MOV"},
	      std::pair{"hybrid_mp4", "hMP4"}, std::pair{"hybrid_mov", "hMOV"}, std::pair{"fragmented_mp4", "fMP4"},
	      std::pair{"fragmented_mov", "fMOV"}, std::pair{"mpegts", "TS"}}) {
		QJsonObject entry;
		entry["value"] = QString::fromUtf8(value);
		entry["label"] = QTStr(QStringLiteral("Basic.Settings.Output.Format.%1")
					       .arg(QString::fromUtf8(labelKey))
					       .toUtf8()
					       .constData());
		formats.append(entry);
	}
	result["recordingFormats"] = formats;
	result["recordingQualities"] = QJsonArray{
		QJsonObject{{"value", "Stream"},
			    {"label", QTStr("Basic.Settings.Output.Simple.RecordingQuality.Stream")}},
		QJsonObject{{"value", "Small"},
			    {"label", QTStr("Basic.Settings.Output.Simple.RecordingQuality.Small")}},
		QJsonObject{{"value", "HQ"}, {"label", QTStr("Basic.Settings.Output.Simple.RecordingQuality.HQ")}},
		QJsonObject{{"value", "Lossless"},
			    {"label", QTStr("Basic.Settings.Output.Simple.RecordingQuality.Lossless")}},
	};
	return result;
}

} // namespace WebMixBridge
