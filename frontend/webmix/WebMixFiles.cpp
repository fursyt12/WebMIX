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

/* WebMIX: file access for a headless instance.
 *
 * The desktop UI's "Show Recordings", "Show Log Files" and "Show Settings
 * Folder" items open a file manager on the OBS machine, which is useless when
 * OBS runs without a window and is not even reachable from a browser.  These
 * helpers list and stream those directories instead, so recordings can actually
 * be retrieved from a headless box.
 *
 * Only the directories OBS itself uses are reachable, and a requested name must
 * resolve to a regular file directly inside one of them - no traversal, no
 * symlink escapes. */

#include "WebMixBridge.hpp"

#include "OBSApp.hpp"

#include <obs-frontend-api.h>
#include <obs.hpp>

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <util/platform.h>

namespace {

/*! Directories the web UI is allowed to read. */
struct KnownDirectory {
	const char *kind;
	QString path;
	QString title;
	bool listing;
};

QString ConfigSubdirectory(const char *name)
{
	char path[512];
	if (GetAppConfigPath(path, sizeof(path), name) <= 0) {
		return QString();
	}
	return QString::fromUtf8(path);
}

QVector<KnownDirectory> KnownDirectories()
{
	QVector<KnownDirectory> directories;

	/* Recordings: whatever the current profile is configured to use. The API
	 * hands out a copy that the caller owns, so it has to be freed here. */
	BPtr<char> recordPath = obs_frontend_get_current_record_output_path();
	directories.append({"recordings", recordPath ? QString::fromUtf8(recordPath.Get()) : QString(),
			    QStringLiteral("Recordings"), true});

	directories.append({"logs", ConfigSubdirectory("obs-studio/logs"), QStringLiteral("Log Files"), true});
	directories.append(
		{"crashes", ConfigSubdirectory("obs-studio/crashes"), QStringLiteral("Crash Reports"), true});
	directories.append({"config", ConfigSubdirectory("obs-studio"), QStringLiteral("Settings Folder"), true});

	/* The active profile directory, like File > Show Profile Folder. */
	QString profileDir;
	if (char *profile = obs_frontend_get_current_profile()) {
		profileDir = ConfigSubdirectory(QStringLiteral("obs-studio/basic/profiles/%1")
							.arg(QString::fromUtf8(profile))
							.toUtf8()
							.constData());
		bfree(profile);
	}
	directories.append({"profile", profileDir, QStringLiteral("Profile Folder"), true});

	return directories;
}

/*!
 * Resolve a path *inside* one of the allowed directories.
 *
 * `relative` must be empty or a forward-slash separated chain of plain names;
 * "..", absolute paths and backslashes are rejected, and the canonical result
 * must stay under the root so a symlink cannot escape either.
 */
bool ResolveInside(const QString &root, const QString &relative, QString &path, QString &error)
{
	if (relative.contains(QLatin1String("..")) || relative.startsWith('/') || relative.contains('\\')) {
		error = "invalid path";
		return false;
	}

	const QDir base(root);
	const QString candidate = relative.isEmpty() ? base.absolutePath() : base.absoluteFilePath(relative);
	const QFileInfo info(candidate);
	if (!info.exists()) {
		error = "not found";
		return false;
	}

	const QString canonicalBase = QFileInfo(base.absolutePath()).canonicalFilePath();
	const QString canonical = info.canonicalFilePath();
	if (canonicalBase.isEmpty() ||
	    (canonical != canonicalBase && !canonical.startsWith(canonicalBase + QLatin1Char('/')))) {
		error = "path is outside the allowed directory";
		return false;
	}

	path = canonical;
	return true;
}

/*! Resolve `kind` to a directory, or an empty string when it is not usable. */
QString DirectoryForKind(const QString &kind)
{
	for (const KnownDirectory &entry : KnownDirectories()) {
		if (kind == QLatin1String(entry.kind)) {
			return entry.path;
		}
	}
	return QString();
}

} // namespace

namespace WebMixBridge {

QJsonObject ListDirectory(const QString &kind, const QString &relative)
{
	QJsonObject result;

	QString path;
	bool allowListing = false;
	for (const KnownDirectory &entry : KnownDirectories()) {
		if (kind == QLatin1String(entry.kind)) {
			path = entry.path;
			allowListing = entry.listing;
			result["title"] = entry.title;
			break;
		}
	}

	result["kind"] = kind;
	if (path.isEmpty()) {
		result["error"] = "that location is not configured";
		return result;
	}
	if (!allowListing) {
		result["error"] = "listing is not allowed for this location";
		return result;
	}

	QString resolved;
	QString error;
	if (!ResolveInside(path, relative, resolved, error)) {
		result["error"] = error;
		return result;
	}

	QDir directory(resolved);
	if (!directory.exists()) {
		result["error"] = "not a directory";
		return result;
	}

	result["path"] = directory.absolutePath();
	result["root"] = QDir(path).absolutePath();
	result["relative"] = relative;
	result["parent"] = relative.contains('/') ? relative.section('/', 0, -2) : QString();
	result["exists"] = true;

	QJsonArray entries;
	const QFileInfoList files =
		directory.entryInfoList(QDir::Files | QDir::Dirs | QDir::NoDotAndDotDot, QDir::Time);
	for (const QFileInfo &info : files) {
		QJsonObject entry;
		entry["name"] = info.fileName();
		entry["isDirectory"] = info.isDir();
		entry["size"] = static_cast<double>(info.size());
		entry["modified"] = info.lastModified().toString(Qt::ISODate);
		entries.append(entry);
	}
	result["entries"] = entries;
	return result;
}

bool ResolveFileForDownload(const QString &kind, const QString &relative, QString &path, QString &error)
{
	path.clear();

	const QString directory = DirectoryForKind(kind);
	if (directory.isEmpty()) {
		error = "that location is not configured";
		return false;
	}

	if (!ResolveInside(directory, relative, path, error)) {
		return false;
	}
	if (!QFileInfo(path).isFile()) {
		error = "not a file";
		return false;
	}
	return true;
}

bool ReadTextTail(const QString &kind, const QString &relative, int maxBytes, QString &text, QString &error)
{
	QString path;
	if (!ResolveFileForDownload(kind, relative, path, error)) {
		return false;
	}

	QFile file(path);
	if (!file.open(QIODevice::ReadOnly)) {
		error = "could not open the file";
		return false;
	}

	const qint64 size = file.size();
	const qint64 limit = qBound(1024, maxBytes, 1024 * 1024);
	if (size > limit) {
		file.seek(size - limit);
	}
	text = QString::fromUtf8(file.readAll());
	if (size > limit) {
		text.prepend(
			QStringLiteral("... (showing the last %1 KB of %2 KB)\n\n").arg(limit / 1024).arg(size / 1024));
	}
	return true;
}

} // namespace WebMixBridge
