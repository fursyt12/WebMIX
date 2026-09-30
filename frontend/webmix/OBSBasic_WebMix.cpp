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

/* WebMIX: operations the browser frontend needs that obs-websocket does not
 * expose at all (there is no reorder-scene or transition create/rename/remove
 * request).  Each one mirrors the equivalent UI action, minus the modal dialogs
 * the desktop UI would show - a headless instance has nobody to answer them.
 *
 * The web UI performs its own confirmation prompts before calling these. */

#include <utility/QuickTransition.hpp>
#include <widgets/OBSBasic.hpp>

#include <QListWidget>
#include <QString>
#include <QStringList>

#include <obs.hpp>

#include <algorithm>
#include <string>
#include <vector>

/* --------------------------------------------------------------- scenes --- */

bool OBSBasic::WebMixMoveScene(int fromIndex, int toIndex)
{
	const int count = ui->scenes->count();
	if (count == 0 || fromIndex < 0 || fromIndex >= count || toIndex < 0 || toIndex >= count ||
	    fromIndex == toIndex) {
		return false;
	}

	/* ChangeSceneIndex() reorders the *selected* row, so select first and let
	 * OBS do the work (it also refreshes the multiview projectors). */
	const int previousRow = ui->scenes->currentRow();
	ui->scenes->setCurrentRow(fromIndex);
	ChangeSceneIndex(false, toIndex, -1);
	if (previousRow >= 0 && previousRow != fromIndex) {
		ui->scenes->setCurrentRow(std::clamp(toIndex, 0, count - 1));
	}

	blog(LOG_INFO, "[WebMIX] Scene moved from index %d to %d", fromIndex, toIndex);
	return true;
}

/* ---------------------------------------------------------- transitions --- */

bool OBSBasic::WebMixAddTransition(const QString &id, const QString &name)
{
	if (id.isEmpty() || name.isEmpty()) {
		return false;
	}
	if (FindTransition(name.toUtf8().constData())) {
		return false; /* the name is taken */
	}

	obs_source_t *source = obs_source_create_private(id.toUtf8().constData(), name.toUtf8().constData(), nullptr);
	if (!source) {
		return false;
	}

	InitTransition(source);

	const std::string uuid = obs_source_get_uuid(source);
	/* The map holds its own reference (OBSSource is ref-counted), so the
	 * creation reference is released below, exactly like the UI does. */
	transitions.insert({uuid, source});
	transitionNameToUuids.insert({name.toStdString(), uuid});
	transitionUuids.push_back(uuid);

	emit TransitionAdded(name, QString::fromStdString(uuid));
	UpdateCurrentTransition(uuid, true);
	obs_source_release(source);

	OnEvent(OBS_FRONTEND_EVENT_TRANSITION_LIST_CHANGED);
	ClearQuickTransitionWidgets();
	RefreshQuickTransitions();

	blog(LOG_INFO, "[WebMIX] Transition '%s' created (%s)", qUtf8Printable(name), qUtf8Printable(id));
	return true;
}

bool OBSBasic::WebMixRenameTransition(const QString &name, const QString &newName)
{
	if (name.isEmpty() || newName.isEmpty() || name == newName) {
		return false;
	}

	OBSSource transition = FindTransition(name.toUtf8().constData());
	if (!transition || FindTransition(newName.toUtf8().constData())) {
		return false;
	}

	obs_source_set_name(transition, newName.toUtf8().constData());

	const std::string oldName = name.toStdString();
	const std::string uuid = obs_source_get_uuid(transition);
	auto it = transitionNameToUuids.find(oldName);
	if (it != transitionNameToUuids.end()) {
		transitionNameToUuids.erase(it);
		transitionNameToUuids.insert({newName.toStdString(), uuid});
	}

	emit TransitionRenamed(QString::fromStdString(uuid), newName);

	OnEvent(OBS_FRONTEND_EVENT_TRANSITION_LIST_CHANGED);
	ClearQuickTransitionWidgets();
	RefreshQuickTransitions();

	blog(LOG_INFO, "[WebMIX] Transition '%s' renamed to '%s'", qUtf8Printable(name), qUtf8Printable(newName));
	return true;
}

bool OBSBasic::WebMixRemoveTransition(const QString &name)
{
	OBSSource transition = FindTransition(name.toUtf8().constData());
	if (!transition || !obs_source_configurable(transition)) {
		return false;
	}

	/* Only configurable transitions can be removed; Cut and Fade are built in
	 * and always present, exactly as in the desktop UI. */
	const std::string uuid = obs_source_get_uuid(transition);
	auto iterator = transitions.find(uuid);
	if (iterator == transitions.end()) {
		return false;
	}

	for (size_t i = quickTransitions.size(); i > 0; i--) {
		QuickTransition &qt = quickTransitions[i - 1];
		if (qt.source == transition) {
			if (qt.button) {
				qt.button->deleteLater();
			}
			RemoveQuickTransitionHotkey(&qt);
			quickTransitions.erase(quickTransitions.begin() + i - 1);
		}
	}

	transitionNameToUuids.erase(name.toStdString());
	transitionUuids.erase(std::remove(transitionUuids.begin(), transitionUuids.end(), uuid), transitionUuids.end());
	transitions.erase(iterator);
	emit TransitionRemoved(QString::fromStdString(uuid));

	if (!transitionUuids.empty()) {
		UpdateCurrentTransition(transitionUuids.back(), true);
	}

	OnEvent(OBS_FRONTEND_EVENT_TRANSITION_LIST_CHANGED);
	ClearQuickTransitionWidgets();
	RefreshQuickTransitions();

	blog(LOG_INFO, "[WebMIX] Transition '%s' removed", qUtf8Printable(name));
	return true;
}

QStringList OBSBasic::WebMixTransitionNames() const
{
	QStringList names;
	for (const auto &[uuid, transition] : transitions) {
		if (transition) {
			names.append(QString::fromUtf8(obs_source_get_name(transition)));
		}
	}
	return names;
}
