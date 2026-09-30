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

#include "WebMixBridge.hpp"

#include <obs-frontend-api.h>
#include <obs-module.h>
#include <obs.hpp>

#include <QJsonArray>
#include <QJsonValue>
#include <QStringList>

namespace {

using namespace WebMixBridge;

const char *NumberTypeName(enum obs_number_type type)
{
	return type == OBS_NUMBER_SLIDER ? "slider" : "scroller";
}

const char *TextTypeName(enum obs_text_type type)
{
	switch (type) {
	case OBS_TEXT_PASSWORD:
		return "password";
	case OBS_TEXT_MULTILINE:
		return "multiline";
	case OBS_TEXT_INFO:
		return "info";
	default:
		return "text";
	}
}

const char *PathTypeName(enum obs_path_type type)
{
	switch (type) {
	case OBS_PATH_FILE_SAVE:
		return "save";
	case OBS_PATH_DIRECTORY:
		return "directory";
	default:
		return "file";
	}
}

const char *ListTypeName(enum obs_combo_type type)
{
	switch (type) {
	case OBS_COMBO_TYPE_EDITABLE:
		return "editable";
	case OBS_COMBO_TYPE_RADIO:
		return "radio";
	default:
		return "list";
	}
}

const char *ListFormatName(enum obs_combo_format format)
{
	switch (format) {
	case OBS_COMBO_FORMAT_INT:
		return "int";
	case OBS_COMBO_FORMAT_FLOAT:
		return "float";
	case OBS_COMBO_FORMAT_BOOL:
		return "bool";
	default:
		return "string";
	}
}

/*! Read the current value of a property out of its settings object. */
QJsonValue ReadValue(obs_property_t *property, obs_data_t *settings)
{
	const char *name = obs_property_name(property);
	if (!name || !settings) {
		return QJsonValue();
	}

	switch (obs_property_get_type(property)) {
	case OBS_PROPERTY_BOOL:
		return obs_data_get_bool(settings, name);
	case OBS_PROPERTY_INT:
	case OBS_PROPERTY_COLOR:
	case OBS_PROPERTY_COLOR_ALPHA:
		return static_cast<double>(obs_data_get_int(settings, name));
	case OBS_PROPERTY_FLOAT:
		return obs_data_get_double(settings, name);
	case OBS_PROPERTY_LIST:
		switch (obs_property_list_format(property)) {
		case OBS_COMBO_FORMAT_INT:
			return static_cast<double>(obs_data_get_int(settings, name));
		case OBS_COMBO_FORMAT_FLOAT:
			return obs_data_get_double(settings, name);
		case OBS_COMBO_FORMAT_BOOL:
			return obs_data_get_bool(settings, name);
		default:
			return QString::fromUtf8(obs_data_get_string(settings, name));
		}
	default:
		return QString::fromUtf8(obs_data_get_string(settings, name));
	}
}

QJsonArray SerializeListItems(obs_property_t *property)
{
	const size_t count = obs_property_list_item_count(property);
	const enum obs_combo_format format = obs_property_list_format(property);
	QJsonArray items;

	for (size_t i = 0; i < count; i++) {
		QJsonObject item;
		item["name"] = QString::fromUtf8(obs_property_list_item_name(property, i) ?: "");
		item["disabled"] = obs_property_list_item_disabled(property, i);

		switch (format) {
		case OBS_COMBO_FORMAT_INT:
			item["value"] = static_cast<double>(obs_property_list_item_int(property, i));
			break;
		case OBS_COMBO_FORMAT_FLOAT:
			item["value"] = obs_property_list_item_float(property, i);
			break;
		case OBS_COMBO_FORMAT_BOOL:
			item["value"] = obs_property_list_item_bool(property, i);
			break;
		default:
			item["value"] = QString::fromUtf8(obs_property_list_item_string(property, i) ?: "");
			break;
		}
		items.append(item);
	}
	return items;
}

QJsonArray SerializeFrameRate(obs_property_t *property)
{
	QJsonArray options;
	const size_t optionCount = obs_property_frame_rate_options_count(property);
	for (size_t i = 0; i < optionCount; i++) {
		QJsonObject option;
		option["name"] = QString::fromUtf8(obs_property_frame_rate_option_name(property, i) ?: "");
		option["description"] =
			QString::fromUtf8(obs_property_frame_rate_option_description(property, i) ?: "");
		options.append(option);
	}
	return options;
}

QJsonArray SerializeFontFlags()
{
	QJsonArray flags;
	flags.append(QJsonObject{{"value", OBS_FONT_BOLD}, {"name", "Bold"}});
	flags.append(QJsonObject{{"value", OBS_FONT_ITALIC}, {"name", "Italic"}});
	flags.append(QJsonObject{{"value", OBS_FONT_UNDERLINE}, {"name", "Underline"}});
	flags.append(QJsonObject{{"value", OBS_FONT_STRIKEOUT}, {"name", "Strikeout"}});
	return flags;
}

QJsonObject SerializeProperty(obs_property_t *property, obs_data_t *settings);

QJsonArray SerializePropertyList(obs_properties_t *properties, obs_data_t *settings)
{
	QJsonArray result;
	if (!properties) {
		return result;
	}

	obs_property_t *property = obs_properties_first(properties);
	while (property) {
		result.append(SerializeProperty(property, settings));
		if (!obs_property_next(&property)) {
			break;
		}
	}
	return result;
}

QJsonObject SerializeProperty(obs_property_t *property, obs_data_t *settings)
{
	const char *name = obs_property_name(property);
	const enum obs_property_type type = obs_property_get_type(property);

	QJsonObject out;
	out["name"] = QString::fromUtf8(name ?: "");
	out["label"] = QString::fromUtf8(obs_property_description(property) ?: (name ?: ""));
	out["visible"] = obs_property_visible(property);
	out["enabled"] = obs_property_enabled(property);

	const char *longDescription = obs_property_long_description(property);
	if (longDescription && *longDescription) {
		out["description"] = QString::fromUtf8(longDescription);
	}

	switch (type) {
	case OBS_PROPERTY_BOOL:
		out["type"] = "bool";
		break;
	case OBS_PROPERTY_INT:
		out["type"] = "int";
		out["min"] = obs_property_int_min(property);
		out["max"] = obs_property_int_max(property);
		out["step"] = obs_property_int_step(property);
		out["numberType"] = NumberTypeName(obs_property_int_type(property));
		if (const char *suffix = obs_property_int_suffix(property); suffix && *suffix) {
			out["suffix"] = QString::fromUtf8(suffix);
		}
		break;
	case OBS_PROPERTY_FLOAT:
		out["type"] = "float";
		out["min"] = obs_property_float_min(property);
		out["max"] = obs_property_float_max(property);
		out["step"] = obs_property_float_step(property);
		out["numberType"] = NumberTypeName(obs_property_float_type(property));
		if (const char *suffix = obs_property_float_suffix(property); suffix && *suffix) {
			out["suffix"] = QString::fromUtf8(suffix);
		}
		break;
	case OBS_PROPERTY_TEXT:
		out["type"] = "text";
		out["textType"] = TextTypeName(obs_property_text_type(property));
		out["monospace"] = obs_property_text_monospace(property);
		if (obs_property_text_type(property) == OBS_TEXT_INFO) {
			switch (obs_property_text_info_type(property)) {
			case OBS_TEXT_INFO_WARNING:
				out["infoType"] = "warning";
				break;
			case OBS_TEXT_INFO_ERROR:
				out["infoType"] = "error";
				break;
			default:
				out["infoType"] = "normal";
				break;
			}
		}
		break;
	case OBS_PROPERTY_PATH:
		out["type"] = "path";
		out["pathType"] = PathTypeName(obs_property_path_type(property));
		out["filter"] = QString::fromUtf8(obs_property_path_filter(property) ?: "");
		out["defaultPath"] = QString::fromUtf8(obs_property_path_default_path(property) ?: "");
		break;
	case OBS_PROPERTY_LIST:
		out["type"] = "list";
		out["listType"] = ListTypeName(obs_property_list_type(property));
		out["format"] = ListFormatName(obs_property_list_format(property));
		out["items"] = SerializeListItems(property);
		break;
	case OBS_PROPERTY_COLOR:
		out["type"] = "color";
		out["alpha"] = false;
		break;
	case OBS_PROPERTY_COLOR_ALPHA:
		out["type"] = "color";
		out["alpha"] = true;
		break;
	case OBS_PROPERTY_BUTTON:
		out["type"] = "button";
		out["buttonType"] = obs_property_button_type(property) == OBS_BUTTON_URL ? "url" : "default";
		if (const char *url = obs_property_button_url(property); url && *url) {
			out["url"] = QString::fromUtf8(url);
		}
		break;
	case OBS_PROPERTY_FONT: {
		out["type"] = "font";
		out["flags"] = SerializeFontFlags();
		/* OBS stores a font property as three keys: the face name, plus
		 * "<name>.size" and "<name>.flags". */
		if (name && settings) {
			const QString sizeKey = QStringLiteral("%1.size").arg(QString::fromUtf8(name));
			const QString flagsKey = QStringLiteral("%1.flags").arg(QString::fromUtf8(name));
			out["size"] = static_cast<double>(obs_data_get_int(settings, sizeKey.toUtf8().constData()));
			out["flagValue"] =
				static_cast<double>(obs_data_get_int(settings, flagsKey.toUtf8().constData()));
		}
		break;
	}
	case OBS_PROPERTY_EDITABLE_LIST:
		out["type"] = "editableList";
		out["listType"] =
			obs_property_editable_list_type(property) == OBS_EDITABLE_LIST_TYPE_STRINGS ? "strings"
			: obs_property_editable_list_type(property) == OBS_EDITABLE_LIST_TYPE_FILES ? "files"
												    : "filesAndUrls";
		out["filter"] = QString::fromUtf8(obs_property_editable_list_filter(property) ?: "");
		out["defaultPath"] = QString::fromUtf8(obs_property_editable_list_default_path(property) ?: "");
		break;
	case OBS_PROPERTY_FRAME_RATE:
		out["type"] = "frameRate";
		out["options"] = SerializeFrameRate(property);
		break;
	case OBS_PROPERTY_GROUP:
		out["type"] = "group";
		out["groupType"] = obs_property_group_type(property) == OBS_GROUP_CHECKABLE ? "checkable" : "normal";
		out["children"] = SerializePropertyList(obs_property_group_content(property), settings);
		break;
	default:
		out["type"] = "unknown";
		break;
	}

	if (type != OBS_PROPERTY_BUTTON && type != OBS_PROPERTY_GROUP) {
		out["value"] = ReadValue(property, settings);
	}

	return out;
}

/*! Build the common {kind, settings, properties} payload. */
QJsonObject BuildPayload(obs_source_t *source, const QString &sourceName, const char *extraNameKey,
			 const QString &extraName)
{
	QJsonObject result;
	result["sourceName"] = sourceName;
	if (!extraName.isEmpty()) {
		result[QString::fromUtf8(extraNameKey)] = extraName;
	}

	if (!source) {
		result["error"] = "source not found";
		return result;
	}

	obs_properties_t *properties = obs_source_properties(source);
	obs_data_t *settings = obs_source_get_settings(source);

	if (properties && settings) {
		obs_properties_apply_settings(properties, settings);
	}

	result["kind"] = QString::fromUtf8(obs_source_get_id(source) ?: "");
	result["properties"] = SerializePropertyList(properties, settings);

	/* Current values, so the dialog can show what is actually set. */
	QJsonObject values;
	if (settings) {
		obs_data_item_t *item = nullptr;
		for (item = obs_data_first(settings); item; obs_data_item_next(&item)) {
			const char *name = obs_data_item_get_name(item);
			if (!name) {
				continue;
			}
			switch (obs_data_item_gettype(item)) {
			case OBS_DATA_BOOLEAN:
				values[QString::fromUtf8(name)] = obs_data_item_get_bool(item);
				break;
			case OBS_DATA_NUMBER: {
				if (obs_data_item_numtype(item) == OBS_DATA_NUM_INT) {
					values[QString::fromUtf8(name)] =
						static_cast<double>(obs_data_item_get_int(item));
				} else {
					values[QString::fromUtf8(name)] = obs_data_item_get_double(item);
				}
				break;
			}
			default:
				values[QString::fromUtf8(name)] =
					QString::fromUtf8(obs_data_item_get_string(item) ?: "");
				break;
			}
		}
	}
	result["values"] = values;

	if (properties) {
		obs_properties_destroy(properties);
	}

	return result;
}

} // namespace

namespace WebMixBridge {

bool PressButton(const QString &scope, const QString &sourceName, const QString &filterName,
		 const QString &propertyName, QString &error)
{
	OBSSourceAutoRelease source = obs_get_source_by_name(sourceName.toUtf8().constData());
	if (!source) {
		error = "source not found";
		return false;
	}

	obs_source_t *target = source;
	OBSSourceAutoRelease filter;
	if (scope == "filter") {
		filter = obs_source_get_filter_by_name(source, filterName.toUtf8().constData());
		if (!filter) {
			error = "filter not found";
			return false;
		}
		target = filter;
	} else if (scope != "source") {
		error = "invalid scope";
		return false;
	}

	OBSProperties properties = obs_source_properties(target);
	obs_property_t *property = obs_properties_get(properties, propertyName.toUtf8().constData());
	if (!property) {
		error = "property not found";
		return false;
	}
	if (obs_property_get_type(property) != OBS_PROPERTY_BUTTON) {
		error = "property is not a button";
		return false;
	}
	if (!obs_property_enabled(property)) {
		error = "button is disabled";
		return false;
	}

	obs_property_button_clicked(property, target);
	return true;
}

QJsonObject SerializeProperties(void *properties, void *settings)
{
	QJsonObject wrapper;
	wrapper["properties"] =
		SerializePropertyList(static_cast<obs_properties_t *>(properties), static_cast<obs_data_t *>(settings));
	return wrapper;
}

QJsonObject SourceProperties(const QString &sourceName)
{
	OBSSourceAutoRelease source = obs_get_source_by_name(sourceName.toUtf8().constData());
	return BuildPayload(source, sourceName, "sourceName", QString());
}

QJsonObject FilterProperties(const QString &sourceName, const QString &filterName)
{
	OBSSourceAutoRelease source = obs_get_source_by_name(sourceName.toUtf8().constData());
	if (!source) {
		QJsonObject error;
		error["error"] = "source not found";
		return error;
	}

	OBSSourceAutoRelease filter = obs_source_get_filter_by_name(source, filterName.toUtf8().constData());
	return BuildPayload(filter, sourceName, "filterName", filterName);
}

QJsonObject TransitionProperties(const QString &transitionName)
{
	obs_frontend_source_list transitions = {};
	obs_frontend_get_transitions(&transitions);

	obs_source_t *found = nullptr;
	for (size_t i = 0; i < transitions.sources.num; i++) {
		obs_source_t *candidate = transitions.sources.array[i];
		const char *name = obs_source_get_name(candidate);
		if (name && transitionName == QString::fromUtf8(name)) {
			found = candidate;
			break;
		}
	}

	QJsonObject result;
	if (!found) {
		obs_frontend_source_list_free(&transitions);
		result["error"] = "transition not found";
		return result;
	}

	obs_source_t *transition = obs_source_get_ref(found);
	result = BuildPayload(transition, transitionName, "transitionName", QString());
	obs_source_release(transition);
	obs_frontend_source_list_free(&transitions);
	return result;
}

} // namespace WebMixBridge
