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

/* WebMIX: the remux queue behind /api/remux.
 *
 * `media_remux_job_process` blocks until the whole file is written, so the
 * queue is drained by a single worker thread; the HTTP endpoints only touch the
 * queue's bookkeeping, which is guarded by one mutex.  The worker never keeps a
 * pointer into the queue across the lock - it remembers the entry's id and
 * looks it up again, so clearing the list while a remux runs is harmless. */

#include "WebMixRemux.hpp"

#include "WebMixBridge.hpp"

#include <media-io/media-remux.h>
#include <obs.hpp>

#include <QFileInfo>
#include <QJsonArray>
#include <QMutex>
#include <QMutexLocker>
#include <QStringList>
#include <QUuid>
#include <QVector>

#include <util/platform.h>

#include <atomic>
#include <thread>

namespace {

/*! RemuxEntryState of RemuxQueueModel, as the web UI names it. */
const char *kStateReady = "ready";
const char *kStatePending = "pending";
const char *kStateInProgress = "in_progress";
const char *kStateComplete = "complete";
const char *kStateInvalidPath = "invalid_path";
const char *kStateError = "error";

struct Entry {
	QString id;
	QString source;
	QString target;
	QString format;
	QString state = kStateReady;
	QString error;
};

QMutex queueMutex;
QVector<Entry> queue;
bool processing = false;
std::thread worker;
std::atomic<bool> cancelRequested{false};
std::atomic<float> progress{0.f};

/*! Call sites hold queueMutex. */
Entry *FindLocked(const QString &id)
{
	for (Entry &entry : queue) {
		if (entry.id == id) {
			return &entry;
		}
	}
	return nullptr;
}

/*!
 * Join a worker that has finished.  Only ever called with `processing == false`,
 * which the worker sets as the very last thing it does under the mutex, so it
 * cannot be waiting for the lock we hold here.
 */
void ReapLocked()
{
	if (!processing && worker.joinable()) {
		worker.join();
	}
}

bool ProgressCallback(void *data, float percent)
{
	UNUSED_PARAMETER(data);
	progress.store(percent);
	return !cancelRequested.load();
}

void Run()
{
	for (;;) {
		QString id;
		QString source;
		QString target;

		{
			QMutexLocker locker(&queueMutex);
			int row = -1;
			for (int index = 0; index < queue.size(); index++) {
				if (queue[index].state == QLatin1String(kStatePending)) {
					row = index;
					break;
				}
			}
			if (row < 0) {
				break;
			}
			queue[row].state = kStateInProgress;
			id = queue[row].id;
			source = queue[row].source;
			target = queue[row].target;
			progress.store(0.f);
		}

		media_remux_job_t job = nullptr;
		const bool created = media_remux_job_create(&job, qUtf8Printable(source), qUtf8Printable(target));
		bool success = false;
		if (created) {
			success = media_remux_job_process(job, ProgressCallback, nullptr);
			media_remux_job_destroy(job);
		}

		const bool cancelled = cancelRequested.load();

		{
			QMutexLocker locker(&queueMutex);
			Entry *entry = FindLocked(id);
			if (entry) {
				if (success) {
					entry->state = kStateComplete;
					entry->error.clear();
				} else {
					/* A cancelled remux leaves a partial file behind,
					 * which is what the desktop reports as an error too. */
					entry->state = kStateError;
					entry->error = cancelled ? QStringLiteral("stopped")
						       : created ? QStringLiteral("the recording could not be remuxed")
								 : QStringLiteral("the recording could not be opened");
				}
			}
			if (cancelled) {
				/* RemuxQueueModel::endProcessing(): untouched entries go back to ready. */
				for (Entry &pending : queue) {
					if (pending.state == QLatin1String(kStatePending)) {
						pending.state = kStateReady;
					}
				}
			}
		}

		if (!success) {
			blog(LOG_WARNING, "[WebMIX] Remux of '%s' failed (%s)", qUtf8Printable(source),
			     cancelled ? "stopped" : "muxer error");
		}

		if (cancelled) {
			break;
		}
	}

	QMutexLocker locker(&queueMutex);
	for (Entry &entry : queue) {
		if (entry.state == QLatin1String(kStatePending)) {
			entry.state = kStateReady;
		}
	}
	processing = false;
	progress.store(0.f);
}

int ActiveCountLocked()
{
	int count = 0;
	for (const Entry &entry : queue) {
		if (entry.state == QLatin1String(kStatePending) || entry.state == QLatin1String(kStateInProgress)) {
			count++;
		}
	}
	return count;
}

/*! Map the requested container onto a target file name, as RemuxQueueModel does. */
QString TargetNameFor(const QFileInfo &source, const QString &format)
{
	const QString suffix = source.suffix();
	if (format == QLatin1String("mp4") &&
	    (suffix.contains("mov", Qt::CaseInsensitive) || suffix.contains("mp4", Qt::CaseInsensitive))) {
		return source.completeBaseName() + ".remuxed." + suffix;
	}
	return source.completeBaseName() + "." + format;
}

} // namespace

namespace WebMixRemux {

QJsonObject State()
{
	QMutexLocker locker(&queueMutex);
	ReapLocked();

	QJsonArray jobs;
	bool canClearFinished = false;
	for (const Entry &entry : queue) {
		QJsonObject job;
		job["id"] = entry.id;
		job["source"] = entry.source;
		job["target"] = entry.target;
		job["format"] = entry.format;
		job["state"] = entry.state;
		if (!entry.error.isEmpty()) {
			job["error"] = entry.error;
		}
		if (entry.state == QLatin1String(kStateComplete)) {
			canClearFinished = true;
		}
		jobs.append(job);
	}

	QJsonObject result;
	result["jobs"] = jobs;
	result["processing"] = processing;
	result["progress"] = static_cast<double>(progress.load());
	result["canClearFinished"] = canClearFinished;
	result["activeCount"] = ActiveCountLocked();
	return result;
}

bool Add(const QString &relativeSource, const QString &format, bool overwrite, QString &id, QString &source,
	 QString &target, bool &conflict, QString &error)
{
	conflict = false;
	id.clear();
	source.clear();
	target.clear();

	if (format != QLatin1String("mp4") && format != QLatin1String("mov") && format != QLatin1String("mkv")) {
		error = "unsupported target format";
		return false;
	}

	if (!WebMixBridge::ResolveFileForDownload("recordings", relativeSource, source, error)) {
		return false;
	}

	const QFileInfo info(source);
	target = info.absolutePath() + QLatin1Char('/') + TargetNameFor(info, format);
	if (!overwrite && QFileInfo::exists(target)) {
		conflict = true;
		error = "the target file already exists";
		return false;
	}

	Entry entry;
	entry.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
	entry.source = source;
	entry.target = target;
	entry.format = format;

	QMutexLocker locker(&queueMutex);
	ReapLocked();
	queue.append(entry);
	id = entry.id;
	return true;
}

bool Start(QString &error)
{
	QMutexLocker locker(&queueMutex);
	ReapLocked();

	if (processing) {
		error = "a remux is already running";
		return false;
	}

	bool any = false;
	for (Entry &entry : queue) {
		if (entry.state != QLatin1String(kStateReady)) {
			continue;
		}
		/* RemuxQueueModel::checkInputPath(): a file that vanished is invalid. */
		if (!QFileInfo::exists(entry.source)) {
			entry.state = kStateInvalidPath;
			entry.error = "the recording no longer exists";
			continue;
		}
		entry.state = kStatePending;
		entry.error.clear();
		any = true;
	}

	if (!any) {
		error = "there is nothing to remux";
		return false;
	}

	progress.store(0.f);
	cancelRequested.store(false);
	processing = true;
	worker = std::thread(Run);
	blog(LOG_INFO, "[WebMIX] Remuxing %d queued recording(s)", ActiveCountLocked());
	return true;
}

void Stop()
{
	QMutexLocker locker(&queueMutex);
	if (!processing) {
		return;
	}
	cancelRequested.store(true);
	blog(LOG_INFO, "[WebMIX] Remux stopped from the web interface");
}

int ClearFinished()
{
	QMutexLocker locker(&queueMutex);
	ReapLocked();
	for (int index = queue.size() - 1; index >= 0; index--) {
		if (queue[index].state == QLatin1String(kStateComplete)) {
			queue.removeAt(index);
		}
	}
	return queue.size();
}

void ClearAll()
{
	QMutexLocker locker(&queueMutex);
	ReapLocked();
	queue.clear();
}

int ActiveCount()
{
	QMutexLocker locker(&queueMutex);
	return ActiveCountLocked();
}

void Shutdown()
{
	{
		QMutexLocker locker(&queueMutex);
		cancelRequested.store(true);
	}
	if (worker.joinable()) {
		worker.join();
	}
	QMutexLocker locker(&queueMutex);
	processing = false;
	progress.store(0.f);
	/* Drop the queue too: it is process-lifetime state, and entries left behind
	 * show up in OBS's own leak report at exit. */
	queue.clear();
}

} // namespace WebMixRemux
