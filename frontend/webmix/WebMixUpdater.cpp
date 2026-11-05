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

#include "WebMixUpdater.hpp"

#include "WebMixControl.hpp"

#include "OBSApp.hpp"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMetaObject>
#include <QProcess>
#include <QProcessEnvironment>
#include <QRegularExpression>
#include <QTimer>

#include <curl/curl.h>
#include <obs-frontend-api.h>
#include <obs.hpp>
#include <util/curl/curl-helper.h>
#include <util/platform.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <sys/stat.h>
#include <sys/utsname.h>
#include <unistd.h>
#endif

extern bool restart;
extern bool opt_cli_disable_updater;

namespace WebMixUpdater {

namespace {

constexpr int kDefaultInitialCheckDelayMs = 4000;
constexpr int kPeriodicCheckIntervalMs = 6 * 60 * 60 * 1000; /* 6 hours */
constexpr const char *kDefaultReleasesUrl = "https://api.github.com/repos/fursyt12/WebMIX/releases?per_page=15";

int InitialCheckDelayMs()
{
	bool ok = false;
	const int overrideMs = qEnvironmentVariableIntValue("WEBMIX_UPDATE_INITIAL_DELAY_MS", &ok);
	return (ok && overrideMs >= 0) ? overrideMs : kDefaultInitialCheckDelayMs;
}

struct SemVer {
	int major = 0;
	int minor = 0;
	int patch = 0;
	QString prerelease;
	bool valid = false;
};

SemVer ParseVersion(QString raw)
{
	SemVer out;
	raw = raw.trimmed();
	if (raw.startsWith(QLatin1Char('v')) || raw.startsWith(QLatin1Char('V'))) {
		raw.remove(0, 1);
	}

	static const QRegularExpression pattern(QStringLiteral("^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?"));
	const QRegularExpressionMatch match = pattern.match(raw);
	if (!match.hasMatch()) {
		return out;
	}

	out.major = match.captured(1).toInt();
	out.minor = match.captured(2).toInt();
	out.patch = match.captured(3).toInt();
	out.prerelease = match.captured(4);
	out.valid = true;
	return out;
}

/*! Returns <0 if a < b, 0 if a == b, >0 if a > b. */
int CompareVersions(const SemVer &a, const SemVer &b)
{
	if (a.major != b.major) {
		return a.major < b.major ? -1 : 1;
	}
	if (a.minor != b.minor) {
		return a.minor < b.minor ? -1 : 1;
	}
	if (a.patch != b.patch) {
		return a.patch < b.patch ? -1 : 1;
	}
	if (a.prerelease.isEmpty() && b.prerelease.isEmpty()) {
		return 0;
	}
	/* A final release is newer than a prerelease of the same version. */
	if (a.prerelease.isEmpty()) {
		return 1;
	}
	if (b.prerelease.isEmpty()) {
		return -1;
	}
	return QString::compare(a.prerelease, b.prerelease, Qt::CaseInsensitive);
}

QString NormalizeVersionString(const QString &raw)
{
	QString trimmed = raw.trimmed();
	if (trimmed.startsWith(QLatin1Char('v')) || trimmed.startsWith(QLatin1Char('V'))) {
		trimmed.remove(0, 1);
	}
	return trimmed;
}

QString CurrentVersionString()
{
	const QByteArray overrideVer = qgetenv("WEBMIX_UPDATE_CURRENT_VERSION");
	if (!overrideVer.isEmpty()) {
		return NormalizeVersionString(QString::fromUtf8(overrideVer));
	}
	return NormalizeVersionString(QString::fromUtf8(obs_get_version_string()));
}

QString ReleasesApiUrl()
{
	const QByteArray overrideUrl = qgetenv("WEBMIX_UPDATE_RELEASES_URL");
	if (!overrideUrl.isEmpty()) {
		return QString::fromUtf8(overrideUrl);
	}
	return QString::fromLatin1(kDefaultReleasesUrl);
}

/*! Extract the `# WebMIX <ver>` heading and `## What is new` section from a
 *  release body so repeated packaging/CLI instructions do not clutter the
 *  changelog dialog; falls back to the full body when no such section exists. */
QString ExtractReleaseChanges(const QString &version, const QString &body)
{
	const QString normalized = body;
	const QStringList lines = normalized.split(QLatin1Char('\n'));

	int whatIsNewStart = -1;
	int whatIsNewEnd = lines.size();
	for (qsizetype i = 0; i < lines.size(); ++i) {
		const QString trimmed = lines.at(i).trimmed();
		if (whatIsNewStart < 0) {
			if (trimmed.compare(QStringLiteral("## What is new"), Qt::CaseInsensitive) == 0 ||
			    trimmed.compare(QStringLiteral("## What's new"), Qt::CaseInsensitive) == 0 ||
			    trimmed.compare(QStringLiteral("## Changelog"), Qt::CaseInsensitive) == 0 ||
			    trimmed.compare(QStringLiteral("## Что нового"), Qt::CaseInsensitive) == 0) {
				whatIsNewStart = static_cast<int>(i + 1);
			}
		} else if (trimmed.startsWith(QLatin1String("## ")) && !trimmed.startsWith(QLatin1String("### "))) {
			whatIsNewEnd = static_cast<int>(i);
			break;
		}
	}

	QString section;
	if (whatIsNewStart >= 0 && whatIsNewStart < whatIsNewEnd) {
		QStringList slice;
		for (int i = whatIsNewStart; i < whatIsNewEnd; ++i) {
			slice << lines.at(i);
		}
		section = slice.join(QLatin1Char('\n')).trimmed();
	} else {
		section = body.trimmed();
	}

	if (section.isEmpty()) {
		return QStringLiteral("## WebMIX %1").arg(version);
	}
	if (section.startsWith(QLatin1String("# "))) {
		return section;
	}
	return QStringLiteral("## WebMIX %1\n\n%2").arg(version, section);
}

bool IsDirectoryWritable(const QString &dirPath)
{
	if (dirPath.isEmpty()) {
		return false;
	}
	const QString probePath =
		QDir(dirPath).filePath(QStringLiteral(".webmix-write-test-%1").arg(QCoreApplication::applicationPid()));
	QFile probe(probePath);
	if (!probe.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
		return false;
	}
	probe.close();
	QFile::remove(probePath);
	return true;
}

QString CacheRootDirectory()
{
#ifdef _WIN32
	const QString path = QDir(QDir::tempPath()).filePath(QStringLiteral("webmix-update-cache"));
	QDir().mkpath(path);
	return path;
#else
	const QString path =
		QDir(QDir::tempPath())
			.filePath(QStringLiteral("webmix-update-%1").arg(static_cast<qulonglong>(geteuid())));
	QDir().mkpath(path);
	chmod(path.toUtf8().constData(), 0700);
	return path;
#endif
}

void PruneCacheExcept(const QString &keepVersion)
{
	QDir root(CacheRootDirectory());
	if (!root.exists()) {
		return;
	}
	const QFileInfoList entries = root.entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot);
	for (const QFileInfo &entry : entries) {
		if (entry.fileName() != keepVersion) {
			QDir(entry.absoluteFilePath()).removeRecursively();
		}
	}
}

QString ComputeFileSha256(const QString &filePath)
{
	QFile file(filePath);
	if (!file.open(QIODevice::ReadOnly)) {
		return QString();
	}
	QCryptographicHash hash(QCryptographicHash::Sha256);
	if (!hash.addData(&file)) {
		return QString();
	}
	return QString::fromLatin1(hash.result().toHex()).toLower();
}

QString ParseExpectedSha256(const QString &sumsContent, const QString &assetName)
{
	const QStringList lines = sumsContent.split(QLatin1Char('\n'), Qt::SkipEmptyParts);
	for (const QString &rawLine : lines) {
		const QString line = rawLine.trimmed();
		static const QRegularExpression rx(QStringLiteral("^([0-9a-fA-F]{64})\\s+\\*?(.+)$"));
		const QRegularExpressionMatch match = rx.match(line);
		if (!match.hasMatch()) {
			continue;
		}
		QString name = match.captured(2).trimmed();
		if (name.startsWith(QLatin1String("./"))) {
			name.remove(0, 2);
		}
		if (name == assetName || QFileInfo(name).fileName() == assetName) {
			return match.captured(1).toLower();
		}
	}
	return QString();
}

enum class InstallKind {
	Unsupported,
	WindowsZip,
	LinuxDeb,
	LinuxArch,
	TestArchive,
};

const char *InstallKindName(InstallKind kind)
{
	switch (kind) {
	case InstallKind::WindowsZip:
		return "windows-zip";
	case InstallKind::LinuxDeb:
		return "linux-deb";
	case InstallKind::LinuxArch:
		return "linux-arch";
	case InstallKind::TestArchive:
		return "test-archive";
	default:
		return "unsupported";
	}
}

struct InstallTarget {
	InstallKind kind = InstallKind::Unsupported;
	QString arch;
	QString installRoot;
	QString executablePath;
	bool canInstall = false;
	bool needsPassword = false;
};

#ifndef _WIN32
QString RunSimpleQuery(const QString &program, const QStringList &args, int *exitCodeOut = nullptr)
{
	QProcess proc;
	proc.start(program, args, QIODevice::ReadOnly);
	if (!proc.waitForFinished(3000)) {
		proc.kill();
		proc.waitForFinished(500);
		if (exitCodeOut) {
			*exitCodeOut = -1;
		}
		return QString();
	}
	if (exitCodeOut) {
		*exitCodeOut = proc.exitStatus() == QProcess::NormalExit ? proc.exitCode() : -1;
	}
	return QString::fromUtf8(proc.readAllStandardOutput()).trimmed();
}

bool CanRunRootWithoutPassword()
{
	if (geteuid() == 0) {
		return true;
	}
	int code = -1;
	RunSimpleQuery(QStringLiteral("sudo"), {QStringLiteral("-n"), QStringLiteral("true")}, &code);
	return code == 0;
}
#endif

InstallTarget DetectInstallTarget(const QString &startupExePath)
{
	InstallTarget target;
	target.executablePath = startupExePath;

	const QByteArray testDir = qgetenv("WEBMIX_UPDATE_TEST_TARGET_DIR");
	if (!testDir.isEmpty()) {
		target.kind = InstallKind::TestArchive;
		target.installRoot = QString::fromUtf8(testDir);
		QDir().mkpath(target.installRoot);
		target.canInstall = IsDirectoryWritable(target.installRoot);
		target.needsPassword = false;
		return target;
	}

#ifdef _WIN32
	const QString appDir = QFileInfo(startupExePath).absolutePath();
	const QString rootCandidate = QDir(appDir + QStringLiteral("/../..")).canonicalPath();
	if (!rootCandidate.isEmpty() &&
	    QFileInfo::exists(rootCandidate + QStringLiteral("/data/obs-studio/web/index.html"))) {
		target.kind = InstallKind::WindowsZip;
		target.arch = QStringLiteral("x64");
		target.installRoot = rootCandidate;
		target.canInstall = IsDirectoryWritable(rootCandidate) && IsDirectoryWritable(appDir);
		target.needsPassword = false;
	}
#elif defined(__linux__)
#if defined(WEBMIX_PACKAGED_BUILD)
	const bool packagedBuild = true;
#else
	const bool packagedBuild = qEnvironmentVariableIntValue("WEBMIX_UPDATE_FORCE_PACKAGED") == 1;
#endif
	if (packagedBuild && startupExePath.startsWith(QLatin1String("/usr/"))) {
		if (QFileInfo::exists(QStringLiteral("/usr/bin/dpkg-query"))) {
			int code = -1;
			const QString status = RunSimpleQuery(QStringLiteral("/usr/bin/dpkg-query"),
							      {QStringLiteral("-W"), QStringLiteral("-f=${Status}"),
							       QStringLiteral("webmix")},
							      &code);
			if (code == 0 && status.contains(QLatin1String("install ok installed"))) {
				QString arch = RunSimpleQuery(QStringLiteral("/usr/bin/dpkg"),
							      {QStringLiteral("--print-architecture")});
				if (arch.isEmpty()) {
					arch = QStringLiteral("amd64");
				}
				target.kind = InstallKind::LinuxDeb;
				target.arch = arch;
				target.installRoot = QStringLiteral("/usr");
				target.canInstall = true;
				target.needsPassword = !CanRunRootWithoutPassword();
				return target;
			}
		}
		if (QFileInfo::exists(QStringLiteral("/usr/bin/pacman"))) {
			int code = -1;
			RunSimpleQuery(QStringLiteral("/usr/bin/pacman"),
				       {QStringLiteral("-Qi"), QStringLiteral("webmix")}, &code);
			if (code == 0) {
				struct utsname uts{};
				QString arch = QStringLiteral("x86_64");
				if (uname(&uts) == 0 && uts.machine[0] != '\0') {
					arch = QString::fromLatin1(uts.machine);
				}
				target.kind = InstallKind::LinuxArch;
				target.arch = arch;
				target.installRoot = QStringLiteral("/usr");
				target.canInstall = true;
				target.needsPassword = !CanRunRootWithoutPassword();
				return target;
			}
		}
	}
#endif

	return target;
}

struct AssetInfo {
	QString name;
	QString url;
	qint64 size = 0;
};

AssetInfo SelectPlatformAsset(const QJsonArray &assets, const QString &version, const InstallTarget &target,
			      QString &sha256SumsUrl)
{
	sha256SumsUrl.clear();
	AssetInfo chosen;

	for (const QJsonValue &val : assets) {
		const QJsonObject obj = val.toObject();
		const QString name = obj.value(QStringLiteral("name")).toString();
		const QString url = obj.value(QStringLiteral("browser_download_url")).toString();
		if (name == QLatin1String("SHA256SUMS")) {
			sha256SumsUrl = url;
		}
	}

	const auto matches = [&](const QString &name) -> bool {
		switch (target.kind) {
		case InstallKind::WindowsZip:
			return name == QStringLiteral("webmix-%1-windows-%2.zip").arg(version, target.arch) ||
			       (name.startsWith(QLatin1String("webmix-")) &&
				name.endsWith(QStringLiteral("-windows-%1.zip").arg(target.arch)));
		case InstallKind::LinuxDeb:
			return !name.contains(QLatin1String("dbgsym")) &&
			       (name == QStringLiteral("webmix_%1_%2.deb").arg(version, target.arch) ||
				(name.startsWith(QLatin1String("webmix_")) &&
				 name.endsWith(QStringLiteral("_%1.deb").arg(target.arch))));
		case InstallKind::LinuxArch:
			return !name.contains(QLatin1String("-debug-")) &&
			       name.startsWith(QStringLiteral("webmix-%1-").arg(version)) &&
			       name.endsWith(QStringLiteral("-%1.pkg.tar.zst").arg(target.arch));
		case InstallKind::TestArchive:
			return name.startsWith(QLatin1String("webmix-")) &&
			       (name.endsWith(QLatin1String(".tar.gz")) || name.endsWith(QLatin1String(".zip")));
		case InstallKind::Unsupported:
			return false;
		}
		return false;
	};

	for (const QJsonValue &val : assets) {
		const QJsonObject obj = val.toObject();
		const QString name = obj.value(QStringLiteral("name")).toString();
		const QString url = obj.value(QStringLiteral("browser_download_url")).toString();
		if (!name.isEmpty() && !url.isEmpty() && matches(name)) {
			chosen.name = name;
			chosen.url = url;
			chosen.size = static_cast<qint64>(obj.value(QStringLiteral("size")).toDouble(0));
			break;
		}
	}

	return chosen;
}

/* ---- curl helpers ------------------------------------------------------- */

struct CurlDeleter {
	void operator()(CURL *handle) const
	{
		if (handle) {
			curl_easy_cleanup(handle);
		}
	}
};
using ScopedCurl = std::unique_ptr<CURL, CurlDeleter>;

size_t WriteToString(char *ptr, size_t size, size_t nmemb, void *userdata)
{
	const size_t bytes = size * nmemb;
	if (bytes > 0) {
		static_cast<std::string *>(userdata)->append(ptr, bytes);
	}
	return bytes;
}

struct FileWriteContext {
	FILE *fp = nullptr;
	bool writeError = false;
};

size_t WriteToFile(char *ptr, size_t size, size_t nmemb, void *userdata)
{
	const size_t bytes = size * nmemb;
	if (bytes == 0) {
		return 0;
	}
	auto *ctx = static_cast<FileWriteContext *>(userdata);
	const size_t written = std::fwrite(ptr, 1, bytes, ctx->fp);
	if (written != bytes) {
		ctx->writeError = true;
	}
	return written;
}

struct ProgressContext {
	std::atomic<bool> *cancel = nullptr;
	std::function<void(qint64, qint64)> onProgress;
};

int TransferProgressCallback(void *clientp, curl_off_t dltotal, curl_off_t dlnow, curl_off_t, curl_off_t)
{
	auto *ctx = static_cast<ProgressContext *>(clientp);
	if (ctx->cancel && ctx->cancel->load(std::memory_order_relaxed)) {
		return 1; /* abort transfer */
	}
	if (ctx->onProgress) {
		ctx->onProgress(static_cast<qint64>(dlnow), static_cast<qint64>(dltotal));
	}
	return 0;
}

bool HttpGetString(const QString &url, std::atomic<bool> &cancel, bool githubJson, QString &bodyOut, QString &errorOut)
{
	ScopedCurl curl(curl_easy_init());
	if (!curl) {
		errorOut = QStringLiteral("Could not initialize libcurl");
		return false;
	}

	char errBuf[CURL_ERROR_SIZE] = {};
	std::string response;
	ProgressContext progress{&cancel, nullptr};

	struct curl_slist *headers = nullptr;
	const std::string ua = std::string("User-Agent: WebMIX/") + CurrentVersionString().toStdString();
	headers = curl_slist_append(headers, ua.c_str());
	if (githubJson) {
		headers = curl_slist_append(headers, "Accept: application/vnd.github+json");
	}

	const QByteArray urlUtf8 = url.toUtf8();
	curl_easy_setopt(curl.get(), CURLOPT_URL, urlUtf8.constData());
	curl_easy_setopt(curl.get(), CURLOPT_HTTPHEADER, headers);
	curl_easy_setopt(curl.get(), CURLOPT_ACCEPT_ENCODING, "");
	curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 1L);
	curl_easy_setopt(curl.get(), CURLOPT_MAXREDIRS, 10L);
	curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT, 15L);
	curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 45L);
	curl_easy_setopt(curl.get(), CURLOPT_FAILONERROR, 1L);
	curl_easy_setopt(curl.get(), CURLOPT_ERRORBUFFER, errBuf);
	curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, WriteToString);
	curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &response);
	curl_easy_setopt(curl.get(), CURLOPT_NOPROGRESS, 0L);
	curl_easy_setopt(curl.get(), CURLOPT_XFERINFOFUNCTION, TransferProgressCallback);
	curl_easy_setopt(curl.get(), CURLOPT_XFERINFODATA, &progress);
	curl_obs_set_revoke_setting(curl.get());

	const CURLcode code = curl_easy_perform(curl.get());
	curl_slist_free_all(headers);

	if (code != CURLE_OK) {
		errorOut = errBuf[0] ? QString::fromUtf8(errBuf) : QString::fromUtf8(curl_easy_strerror(code));
		return false;
	}

	bodyOut = QString::fromUtf8(response.data(), static_cast<qsizetype>(response.size()));
	return true;
}

bool HttpDownloadFile(const QString &url, const QString &destPath, std::atomic<bool> &cancel,
		      const std::function<void(qint64, qint64)> &onProgress, QString &errorOut)
{
	ScopedCurl curl(curl_easy_init());
	if (!curl) {
		errorOut = QStringLiteral("Could not initialize libcurl");
		return false;
	}

	const QString partPath = destPath + QStringLiteral(".part");
	QFile::remove(partPath);

#ifdef _WIN32
	FILE *fp = _wfopen(reinterpret_cast<const wchar_t *>(partPath.utf16()), L"wb");
#else
	FILE *fp = std::fopen(partPath.toUtf8().constData(), "wb");
#endif
	if (!fp) {
		errorOut = QStringLiteral("Could not open %1 for writing").arg(partPath);
		return false;
	}
#ifndef _WIN32
	chmod(partPath.toUtf8().constData(), 0600);
#endif

	char errBuf[CURL_ERROR_SIZE] = {};
	FileWriteContext writeCtx{fp, false};
	ProgressContext progress{&cancel, onProgress};

	struct curl_slist *headers = nullptr;
	const std::string ua = std::string("User-Agent: WebMIX/") + CurrentVersionString().toStdString();
	headers = curl_slist_append(headers, ua.c_str());

	const QByteArray urlUtf8 = url.toUtf8();
	curl_easy_setopt(curl.get(), CURLOPT_URL, urlUtf8.constData());
	curl_easy_setopt(curl.get(), CURLOPT_HTTPHEADER, headers);
	curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 1L);
	curl_easy_setopt(curl.get(), CURLOPT_MAXREDIRS, 10L);
	curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT, 20L);
	curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_LIMIT, 1024L);
	curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_TIME, 30L);
	curl_easy_setopt(curl.get(), CURLOPT_FAILONERROR, 1L);
	curl_easy_setopt(curl.get(), CURLOPT_ERRORBUFFER, errBuf);
	curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, WriteToFile);
	curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &writeCtx);
	curl_easy_setopt(curl.get(), CURLOPT_NOPROGRESS, 0L);
	curl_easy_setopt(curl.get(), CURLOPT_XFERINFOFUNCTION, TransferProgressCallback);
	curl_easy_setopt(curl.get(), CURLOPT_XFERINFODATA, &progress);
	curl_obs_set_revoke_setting(curl.get());

	const CURLcode code = curl_easy_perform(curl.get());
	curl_slist_free_all(headers);
	std::fclose(fp);

	if (code != CURLE_OK || writeCtx.writeError) {
		QFile::remove(partPath);
		if (writeCtx.writeError) {
			errorOut = QStringLiteral("Disk write error while downloading update");
		} else {
			errorOut = errBuf[0] ? QString::fromUtf8(errBuf) : QString::fromUtf8(curl_easy_strerror(code));
		}
		return false;
	}

	QFile::remove(destPath);
	if (!QFile::rename(partPath, destPath)) {
		QFile::remove(partPath);
		errorOut = QStringLiteral("Could not finalize downloaded update file");
		return false;
	}
	return true;
}

/* ---- restart command-line builder --------------------------------------- */

QStringList BuildRestartArguments(const QStringList &originalArgs, const QString &host, quint16 port)
{
	QStringList out;
	/* Skip argv[0] and strip any previous web endpoint/chooser flags so the
	 * restarted instance binds the exact same address without prompting or
	 * opening an extra browser window on the host machine. */
	for (qsizetype i = 1; i < originalArgs.size(); ++i) {
		const QString &arg = originalArgs.at(i);
		if (arg == QLatin1String("--web-host") || arg == QLatin1String("--web-port")) {
			++i;
			continue;
		}
		if (arg == QLatin1String("--web-choose") || arg == QLatin1String("--no-browser")) {
			continue;
		}
		out << arg;
	}
	out << QStringLiteral("--web-host") << (host.isEmpty() ? QStringLiteral("127.0.0.1") : host);
	out << QStringLiteral("--web-port") << QString::number(port);
	out << QStringLiteral("--no-browser");
	return out;
}

#ifdef _WIN32
QString PowerShellSingleQuoted(QString text)
{
	return QLatin1Char('\'') + text.replace(QLatin1Char('\''), QLatin1String("''")) + QLatin1Char('\'');
}

bool LaunchHiddenPowerShellScript(const QString &scriptPath, QString &errorOut)
{
	QString cmdLine =
		QStringLiteral(
			"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%1\"")
			.arg(QDir::toNativeSeparators(scriptPath));
	std::wstring wideCmd = cmdLine.toStdWString();

	STARTUPINFOW si{};
	si.cb = sizeof(si);
	si.dwFlags = STARTF_USESHOWWINDOW;
	si.wShowWindow = SW_HIDE;
	PROCESS_INFORMATION pi{};

	if (!CreateProcessW(nullptr, wideCmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | DETACHED_PROCESS,
			    nullptr, nullptr, &si, &pi)) {
		errorOut = QStringLiteral("CreateProcessW(powershell.exe) failed (error %1)")
				   .arg(static_cast<qulonglong>(GetLastError()));
		return false;
	}
	CloseHandle(pi.hThread);
	CloseHandle(pi.hProcess);
	return true;
}
#endif

/* ---- controller state --------------------------------------------------- */

struct Manager {
	std::mutex mutex;
	std::thread worker;
	std::atomic<bool> cancelFlag{false};
	bool workerBusy = false;
	bool started = false;
	bool shuttingDown = false;

	QString listenHost;
	quint16 listenPort = 4456;
	QString startupExecutable;
	QStringList startupArguments;
	InstallTarget target;

	QTimer *periodicTimer = nullptr;

	QString state = QStringLiteral("idle");
	QString currentVersion;
	QString latestVersion;
	QString skippedVersion;
	bool autoCheck = true;
	bool updateAvailable = false;
	bool manualCheck = false;
	QString changelog;
	QString releaseUrl;
	QString publishedAt;
	AssetInfo asset;
	QString sha256SumsUrl;
	QString expectedSha256;
	QString cachedFilePath;
	bool readyToInstall = false;
	bool prefetching = false;
	bool installRequestedDuringPrefetch = false;
	QByteArray pendingSudoPassword;
	qint64 downloadedBytes = 0;
	qint64 totalBytes = 0;
	int progress = 0;
	qint64 lastCheckedAt = 0;
	QString error;

	bool hasPendingPosixRestart = false;
	QString pendingRestartExecutable;
	QStringList pendingRestartArguments;

	uint64_t lastEmitNs = 0;

	QJsonObject BuildStateLocked() const
	{
		QJsonObject out;
		out[QStringLiteral("ok")] = error.isEmpty() || state != QLatin1String("error");
		out[QStringLiteral("state")] = state;
		out[QStringLiteral("currentVersion")] = currentVersion;
		out[QStringLiteral("latestVersion")] = latestVersion;
		out[QStringLiteral("skippedVersion")] = skippedVersion;
		out[QStringLiteral("autoCheck")] = autoCheck;
		out[QStringLiteral("updateAvailable")] = updateAvailable;
		out[QStringLiteral("manualCheck")] = manualCheck;
		out[QStringLiteral("changelog")] = changelog;
		out[QStringLiteral("releaseUrl")] = releaseUrl;
		out[QStringLiteral("publishedAt")] = publishedAt;
		out[QStringLiteral("assetName")] = asset.name;
		out[QStringLiteral("assetSize")] = static_cast<double>(asset.size);
		out[QStringLiteral("downloadedBytes")] = static_cast<double>(downloadedBytes);
		out[QStringLiteral("totalBytes")] = static_cast<double>(totalBytes);
		out[QStringLiteral("progress")] = progress;
		out[QStringLiteral("readyToInstall")] = readyToInstall;
		out[QStringLiteral("prefetching")] = prefetching;
		out[QStringLiteral("canInstall")] = target.canInstall && !asset.url.isEmpty();
		out[QStringLiteral("installKind")] = QString::fromLatin1(InstallKindName(target.kind));
		out[QStringLiteral("needsPassword")] = target.needsPassword;
		out[QStringLiteral("lastCheckedAt")] = static_cast<double>(lastCheckedAt);
		out[QStringLiteral("error")] = error;
		return out;
	}

	void EmitState(bool throttle = false)
	{
		const uint64_t nowNs = os_gettime_ns();
		QJsonObject snapshot;
		{
			std::lock_guard<std::mutex> lock(mutex);
			if (shuttingDown) {
				return;
			}
			if (throttle && nowNs - lastEmitNs < 200000000ULL) {
				return; /* cap progress notifications at 5 Hz */
			}
			lastEmitNs = nowNs;
			snapshot = BuildStateLocked();
		}

		if (!qApp) {
			return;
		}
		QMetaObject::invokeMethod(
			qApp,
			[snapshot]() {
				if (WebMixControl::IsStarted()) {
					WebMixControl::Emit(QStringLiteral("WebMixUpdateStateChanged"), snapshot,
							    WebMixControl::Intent::General);
				}
			},
			Qt::QueuedConnection);
	}
};

Manager &Mgr()
{
	static Manager instance;
	return instance;
}

/* Downloads `asset` + `SHA256SUMS`, verifies SHA-256, and marks `readyToInstall`. */
bool EnsureAssetDownloaded(Manager &m, bool backgroundPrefetch, QString &errorOut)
{
	AssetInfo asset;
	QString latestVersion;
	QString sumsUrl;
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		asset = m.asset;
		latestVersion = m.latestVersion;
		sumsUrl = m.sha256SumsUrl;

		if (m.readyToInstall && !m.cachedFilePath.isEmpty() && QFileInfo::exists(m.cachedFilePath)) {
			if (m.expectedSha256.isEmpty() || ComputeFileSha256(m.cachedFilePath) == m.expectedSha256) {
				return true;
			}
		}

		m.state = (backgroundPrefetch && !m.installRequestedDuringPrefetch) ? QStringLiteral("available")
										    : QStringLiteral("downloading");
		m.downloadedBytes = 0;
		m.totalBytes = asset.size;
		m.progress = 0;
		if (!backgroundPrefetch || m.installRequestedDuringPrefetch) {
			m.error.clear();
		}
	}
	m.EmitState(false);

	if (asset.url.isEmpty() || asset.name.isEmpty()) {
		errorOut = QStringLiteral("No downloadable update package is available for this platform");
		return false;
	}

	const QString versionDir = QDir(CacheRootDirectory()).filePath(latestVersion);
	if (!QDir().mkpath(versionDir)) {
		errorOut = QStringLiteral("Could not create temporary update directory");
		return false;
	}
#ifndef _WIN32
	chmod(versionDir.toUtf8().constData(), 0700);
#endif

	QString expectedSha;
	if (!sumsUrl.isEmpty()) {
		QString sumsBody;
		QString sumsErr;
		if (!HttpGetString(sumsUrl, m.cancelFlag, false, sumsBody, sumsErr)) {
			errorOut = QStringLiteral("Could not download SHA256SUMS: %1").arg(sumsErr);
			return false;
		}
		expectedSha = ParseExpectedSha256(sumsBody, asset.name);
		if (expectedSha.isEmpty()) {
			errorOut = QStringLiteral("SHA256SUMS does not list %1").arg(asset.name);
			return false;
		}
	}

	const QString destPath = QDir(versionDir).filePath(asset.name);
	if (QFileInfo::exists(destPath) && !expectedSha.isEmpty() && ComputeFileSha256(destPath) == expectedSha) {
		std::lock_guard<std::mutex> lock(m.mutex);
		m.expectedSha256 = expectedSha;
		m.cachedFilePath = destPath;
		m.downloadedBytes = QFileInfo(destPath).size();
		m.totalBytes = m.downloadedBytes;
		m.progress = 100;
		m.readyToInstall = true;
		m.state = m.installRequestedDuringPrefetch ? QStringLiteral("installing") : QStringLiteral("ready");
		return true;
	}

	const auto onProgress = [&m, fallbackTotal = asset.size](qint64 dlNow, qint64 dlTotal) {
		const qint64 total = dlTotal > 0 ? dlTotal : fallbackTotal;
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.downloadedBytes = dlNow;
			m.totalBytes = total;
			m.progress = total > 0 ? static_cast<int>(std::clamp<qint64>((dlNow * 100) / total, 0, 100))
					       : 0;
		}
		m.EmitState(true);
	};

	if (!HttpDownloadFile(asset.url, destPath, m.cancelFlag, onProgress, errorOut)) {
		return false;
	}

	if (!expectedSha.isEmpty()) {
		const QString actualSha = ComputeFileSha256(destPath);
		if (actualSha != expectedSha) {
			QFile::remove(destPath);
			errorOut = QStringLiteral("SHA-256 verification failed for %1 (expected %2, got %3)")
					   .arg(asset.name, expectedSha, actualSha);
			return false;
		}
	}

	{
		std::lock_guard<std::mutex> lock(m.mutex);
		m.expectedSha256 = expectedSha;
		m.cachedFilePath = destPath;
		m.downloadedBytes = QFileInfo(destPath).size();
		m.totalBytes = m.downloadedBytes;
		m.progress = 100;
		m.readyToInstall = true;
		m.state = m.installRequestedDuringPrefetch ? QStringLiteral("installing") : QStringLiteral("ready");
	}
	blog(LOG_INFO, "[WebMIX] Update %s downloaded and verified (%s)", qUtf8Printable(latestVersion),
	     qUtf8Printable(asset.name));
	return true;
}

void RunInstallWorker(QByteArray passwordBytes);

void RunCheckWorker(bool manual)
{
	Manager &m = Mgr();
	QString currentVer;
	InstallTarget target;
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		currentVer = m.currentVersion;
		target = m.target;
	}

	const SemVer currentSem = ParseVersion(currentVer);
	QString body;
	QString fetchError;
	if (!HttpGetString(ReleasesApiUrl(), m.cancelFlag, true, body, fetchError)) {
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.workerBusy = false;
			if (!m.shuttingDown) {
				if (manual) {
					m.state = QStringLiteral("error");
					m.error = fetchError;
				} else {
					m.state = m.updateAvailable ? (m.readyToInstall ? QStringLiteral("ready")
											: QStringLiteral("available"))
								    : QStringLiteral("idle");
				}
			}
		}
		m.EmitState(false);
		return;
	}

	QJsonParseError jsonErr{};
	const QJsonDocument doc = QJsonDocument::fromJson(body.toUtf8(), &jsonErr);
	if (jsonErr.error != QJsonParseError::NoError || (!doc.isArray() && !doc.isObject())) {
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.workerBusy = false;
			if (manual) {
				m.state = QStringLiteral("error");
				m.error = QStringLiteral("Invalid releases JSON from GitHub");
			} else {
				m.state = QStringLiteral("idle");
			}
		}
		m.EmitState(false);
		return;
	}

	const QJsonArray releases = doc.isArray() ? doc.array() : QJsonArray{doc.object()};

	struct Candidate {
		SemVer sem;
		QString version;
		QJsonObject obj;
	};
	std::vector<Candidate> newer;

	for (const QJsonValue &entryVal : releases) {
		const QJsonObject rel = entryVal.toObject();
		if (rel.value(QStringLiteral("draft")).toBool(false)) {
			continue;
		}
		if (rel.value(QStringLiteral("prerelease")).toBool(false) && currentSem.prerelease.isEmpty()) {
			continue;
		}
		const QString tagName = rel.value(QStringLiteral("tag_name")).toString();
		const SemVer sem = ParseVersion(tagName);
		if (!sem.valid) {
			continue;
		}
		if (currentSem.valid && CompareVersions(sem, currentSem) > 0) {
			newer.push_back(Candidate{sem, NormalizeVersionString(tagName), rel});
		}
	}

	std::sort(newer.begin(), newer.end(),
		  [](const Candidate &a, const Candidate &b) { return CompareVersions(a.sem, b.sem) > 0; });

	const qint64 checkedAt = QDateTime::currentSecsSinceEpoch();
	if (newer.empty()) {
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.lastCheckedAt = checkedAt;
			m.updateAvailable = false;
			m.readyToInstall = false;
			m.latestVersion = currentVer;
			m.changelog.clear();
			m.asset = AssetInfo{};
			m.sha256SumsUrl.clear();
			m.expectedSha256.clear();
			m.cachedFilePath.clear();
			m.error.clear();
			m.state = QStringLiteral("up-to-date");
			m.workerBusy = false;
		}
		m.EmitState(false);
		return;
	}

	const Candidate &latest = newer.front();
	QStringList changelogParts;
	for (const Candidate &item : newer) {
		changelogParts
			<< ExtractReleaseChanges(item.version, item.obj.value(QStringLiteral("body")).toString());
	}

	QString sumsUrl;
	const AssetInfo selectedAsset = SelectPlatformAsset(latest.obj.value(QStringLiteral("assets")).toArray(),
							    latest.version, target, sumsUrl);

	PruneCacheExcept(latest.version);

	/* Check whether this version is already cached and verified on disk. */
	QString preCachedPath;
	QString preCachedSha;
	const QString candidatePath =
		QDir(QDir(CacheRootDirectory()).filePath(latest.version)).filePath(selectedAsset.name);
	if (!selectedAsset.name.isEmpty() && QFileInfo::exists(candidatePath) && !sumsUrl.isEmpty()) {
		QString sumsBody;
		QString sumsErr;
		if (HttpGetString(sumsUrl, m.cancelFlag, false, sumsBody, sumsErr)) {
			const QString expected = ParseExpectedSha256(sumsBody, selectedAsset.name);
			if (!expected.isEmpty() && ComputeFileSha256(candidatePath) == expected) {
				preCachedPath = candidatePath;
				preCachedSha = expected;
			}
		}
	}

	bool shouldBackgroundDownload = false;
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		m.lastCheckedAt = checkedAt;
		m.latestVersion = latest.version;
		m.updateAvailable = true;
		m.changelog = changelogParts.join(QStringLiteral("\n\n---\n\n"));
		m.releaseUrl = latest.obj.value(QStringLiteral("html_url")).toString();
		m.publishedAt = latest.obj.value(QStringLiteral("published_at")).toString();
		m.asset = selectedAsset;
		m.sha256SumsUrl = sumsUrl;
		m.error.clear();

		if (!preCachedPath.isEmpty()) {
			m.cachedFilePath = preCachedPath;
			m.expectedSha256 = preCachedSha;
			m.downloadedBytes = QFileInfo(preCachedPath).size();
			m.totalBytes = m.downloadedBytes;
			m.progress = 100;
			m.readyToInstall = true;
			m.state = QStringLiteral("ready");
		} else {
			m.cachedFilePath.clear();
			m.expectedSha256.clear();
			m.downloadedBytes = 0;
			m.totalBytes = selectedAsset.size;
			m.progress = 0;
			m.readyToInstall = false;
			m.state = QStringLiteral("available");

			const bool outputsIdle = !obs_frontend_streaming_active() && !obs_frontend_recording_active();
			shouldBackgroundDownload = !m.cancelFlag.load(std::memory_order_relaxed) && m.autoCheck &&
						   m.target.canInstall && !selectedAsset.url.isEmpty() &&
						   latest.version != m.skippedVersion && outputsIdle;
		}
		m.prefetching = shouldBackgroundDownload;
		m.installRequestedDuringPrefetch = false;
		m.pendingSudoPassword.clear();
		if (!shouldBackgroundDownload) {
			m.workerBusy = false;
		}
	}
	m.EmitState(false);

	if (shouldBackgroundDownload) {
		QString dlError;
		const bool downloaded = EnsureAssetDownloaded(m, true, dlError);
		bool chainInstall = false;
		QByteArray chainedPassword;
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.prefetching = false;
			if (m.installRequestedDuringPrefetch) {
				m.installRequestedDuringPrefetch = false;
				chainedPassword = std::move(m.pendingSudoPassword);
				m.pendingSudoPassword.clear();
				if (downloaded && !m.shuttingDown) {
					chainInstall = true;
				} else {
					chainedPassword.fill('\0');
					chainedPassword.clear();
					m.state = QStringLiteral("error");
					m.error = dlError;
					m.workerBusy = false;
				}
			} else {
				if (!downloaded && !m.shuttingDown) {
					/* Keep the update available so the user can retry on click. */
					m.state = QStringLiteral("available");
					if (!m.cancelFlag.load(std::memory_order_relaxed)) {
						blog(LOG_WARNING, "[WebMIX] Background update pre-download failed: %s",
						     qUtf8Printable(dlError));
					}
				}
				m.workerBusy = false;
			}
		}
		if (chainInstall) {
			RunInstallWorker(std::move(chainedPassword));
			return;
		}
		m.EmitState(false);
	}
}

#ifndef _WIN32
bool RunPrivilegedLinuxCommand(const QStringList &commandArgs, const QProcessEnvironment &extraEnv,
			       QByteArray &password, QString &errorOut)
{
	if (commandArgs.isEmpty()) {
		errorOut = QStringLiteral("Empty install command");
		return false;
	}

	const bool isRoot = geteuid() == 0;
	const bool noPasswd = !isRoot && CanRunRootWithoutPassword();

	if (!isRoot && !noPasswd) {
		if (password.isEmpty()) {
			errorOut = QStringLiteral("sudo-password-required");
			return false;
		}
		/* Validate sudo credentials first so a mistyped password fails
		 * cleanly before dpkg/pacman runs. */
		QProcess checkProc;
		checkProc.start(QStringLiteral("sudo"), {QStringLiteral("-S"), QStringLiteral("-k"),
							 QStringLiteral("-p"), QString(), QStringLiteral("true")});
		if (!checkProc.waitForStarted(3000)) {
			errorOut = QStringLiteral("Could not launch sudo");
			return false;
		}
		checkProc.write(password);
		checkProc.write("\n");
		checkProc.closeWriteChannel();
		if (!checkProc.waitForFinished(10000) || checkProc.exitCode() != 0) {
			errorOut = QStringLiteral("invalid-sudo-password");
			return false;
		}
	}

	QProcess proc;
	QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
	for (const QString &key : extraEnv.keys()) {
		env.insert(key, extraEnv.value(key));
	}
	proc.setProcessEnvironment(env);

	QString program;
	QStringList args;
	if (isRoot) {
		program = commandArgs.first();
		args = commandArgs.mid(1);
	} else {
		program = QStringLiteral("sudo");
		if (noPasswd) {
			args << QStringLiteral("-n");
		} else {
			args << QStringLiteral("-S") << QStringLiteral("-k") << QStringLiteral("-p") << QString();
		}
		args << QStringLiteral("env");
		for (const QString &key : extraEnv.keys()) {
			args << QStringLiteral("%1=%2").arg(key, extraEnv.value(key));
		}
		args.append(commandArgs);
	}

	proc.start(program, args);
	if (!proc.waitForStarted(5000)) {
		password.fill('\0');
		password.clear();
		errorOut = QStringLiteral("Could not start installer process (%1)").arg(program);
		return false;
	}
	if (!isRoot && !noPasswd) {
		proc.write(password);
		proc.write("\n");
	}
	password.fill('\0');
	password.clear();
	proc.closeWriteChannel();

	/* Package installation with CEF takes 10-60 seconds depending on disk speed. */
	if (!proc.waitForFinished(5 * 60 * 1000)) {
		proc.kill();
		proc.waitForFinished(2000);
		errorOut = QStringLiteral("Package installation timed out");
		return false;
	}

	if (proc.exitStatus() != QProcess::NormalExit || proc.exitCode() != 0) {
		const QString stderrText = QString::fromUtf8(proc.readAllStandardError()).trimmed();
		const QString stdoutText = QString::fromUtf8(proc.readAllStandardOutput()).trimmed();
		const QString detail = !stderrText.isEmpty() ? stderrText : stdoutText;
		errorOut = detail.isEmpty() ? QStringLiteral("Installer exited with code %1").arg(proc.exitCode())
					    : detail.right(600);
		return false;
	}
	return true;
}
#endif

void RunInstallWorker(QByteArray passwordBytes)
{
	Manager &m = Mgr();
	QString stepError;

	if (!EnsureAssetDownloaded(m, false, stepError)) {
		passwordBytes.fill('\0');
		passwordBytes.clear();
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.state = QStringLiteral("error");
			m.error = stepError;
			m.workerBusy = false;
		}
		m.EmitState(false);
		return;
	}

	QString cachedPath;
	QString expectedSha;
	QString latestVersion;
	InstallTarget target;
	QString listenHost;
	quint16 listenPort = 4456;
	QStringList startupArgs;
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		cachedPath = m.cachedFilePath;
		expectedSha = m.expectedSha256;
		latestVersion = m.latestVersion;
		target = m.target;
		listenHost = m.listenHost;
		listenPort = m.listenPort;
		startupArgs = m.startupArguments;
		m.state = QStringLiteral("installing");
		m.error.clear();
	}
	m.EmitState(false);

	/* Re-verify SHA-256 right before installation to prevent TOCTOU tampering. */
	if (!expectedSha.isEmpty() && ComputeFileSha256(cachedPath) != expectedSha) {
		passwordBytes.fill('\0');
		passwordBytes.clear();
		QFile::remove(cachedPath);
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.readyToInstall = false;
			m.cachedFilePath.clear();
			m.state = QStringLiteral("error");
			m.error = QStringLiteral("Cached update package failed SHA-256 verification");
			m.workerBusy = false;
		}
		m.EmitState(false);
		return;
	}

	const QStringList restartArgs = BuildRestartArguments(startupArgs, listenHost, listenPort);

	if (target.kind == InstallKind::TestArchive) {
		passwordBytes.fill('\0');
		passwordBytes.clear();
		QFile marker(QDir(target.installRoot).filePath(QStringLiteral("UPDATED_VERSION")));
		if (!marker.open(QIODevice::WriteOnly | QIODevice::Truncate) ||
		    marker.write(latestVersion.toUtf8()) < 0) {
			{
				std::lock_guard<std::mutex> lock(m.mutex);
				m.state = QStringLiteral("error");
				m.error = QStringLiteral("Could not write test update marker");
				m.workerBusy = false;
			}
			m.EmitState(false);
			return;
		}
		marker.close();
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.state = QStringLiteral("restarting");
			m.workerBusy = false;
		}
		m.EmitState(false);
		if (qEnvironmentVariableIntValue("WEBMIX_UPDATE_TEST_NO_RESTART") != 1) {
			{
				std::lock_guard<std::mutex> lock(m.mutex);
				m.hasPendingPosixRestart = true;
				m.pendingRestartExecutable = target.executablePath;
				m.pendingRestartArguments = restartArgs;
			}
			restart = true;
			QMetaObject::invokeMethod(
				qApp, []() { QTimer::singleShot(200, qApp, &QCoreApplication::quit); },
				Qt::QueuedConnection);
		}
		return;
	}

#ifdef _WIN32
	passwordBytes.fill('\0');
	passwordBytes.clear();

	const QString versionDir = QFileInfo(cachedPath).absolutePath();
	const QString extractDir = QDir(versionDir).filePath(QStringLiteral("extracted"));
	QDir(extractDir).removeRecursively();
	if (!QDir().mkpath(extractDir)) {
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.state = QStringLiteral("error");
			m.error = QStringLiteral("Could not create staging directory for extraction");
			m.workerBusy = false;
		}
		m.EmitState(false);
		return;
	}

	/* System32\tar.exe extracts 200 MB archives ~10x faster than Expand-Archive;
	 * fall back to .NET ZipFile if tar.exe is unavailable. */
	bool extracted = false;
	{
		QProcess tarProc;
		tarProc.start(QStringLiteral("tar.exe"), {QStringLiteral("-xf"), QDir::toNativeSeparators(cachedPath),
							  QStringLiteral("-C"), QDir::toNativeSeparators(extractDir)});
		if (tarProc.waitForFinished(3 * 60 * 1000) && tarProc.exitStatus() == QProcess::NormalExit &&
		    tarProc.exitCode() == 0) {
			extracted = true;
		}
	}
	if (!extracted) {
		QDir(extractDir).removeRecursively();
		QDir().mkpath(extractDir);
		const QString psExtract = QStringLiteral("Add-Type -AssemblyName System.IO.Compression.FileSystem; "
							 "[System.IO.Compression.ZipFile]::ExtractToDirectory(%1, %2)")
						  .arg(PowerShellSingleQuoted(QDir::toNativeSeparators(cachedPath)),
						       PowerShellSingleQuoted(QDir::toNativeSeparators(extractDir)));
		QProcess psProc;
		psProc.start(QStringLiteral("powershell.exe"),
			     {QStringLiteral("-NoProfile"), QStringLiteral("-NonInteractive"),
			      QStringLiteral("-Command"), psExtract});
		if (psProc.waitForFinished(5 * 60 * 1000) && psProc.exitStatus() == QProcess::NormalExit &&
		    psProc.exitCode() == 0) {
			extracted = true;
		}
	}

	QString stagedRoot = extractDir;
	if (extracted && !QFileInfo::exists(stagedRoot + QStringLiteral("/bin/64bit/obs64.exe"))) {
		const QFileInfoList subdirs = QDir(extractDir).entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot);
		if (subdirs.size() == 1 &&
		    QFileInfo::exists(subdirs.first().absoluteFilePath() + QStringLiteral("/bin/64bit/obs64.exe"))) {
			stagedRoot = subdirs.first().absoluteFilePath();
		} else {
			extracted = false;
		}
	}

	if (!extracted) {
		QDir(extractDir).removeRecursively();
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.state = QStringLiteral("error");
			m.error = QStringLiteral("Failed to unpack Windows update archive");
			m.workerBusy = false;
		}
		m.EmitState(false);
		return;
	}

	QStringList psArgsLiteral;
	for (const QString &arg : restartArgs) {
		psArgsLiteral << PowerShellSingleQuoted(arg);
	}

	const QString newExe = QDir::toNativeSeparators(target.installRoot + QStringLiteral("/bin/64bit/obs64.exe"));
	const QString newExeDir = QDir::toNativeSeparators(target.installRoot + QStringLiteral("/bin/64bit"));
	const QString scriptPath = QDir(versionDir).filePath(QStringLiteral("apply-update.ps1"));

	const QString script =
		QStringLiteral("$ErrorActionPreference = 'SilentlyContinue'\r\n"
			       "Wait-Process -Id %1 -Timeout 60\r\n"
			       "Start-Sleep -Milliseconds 400\r\n"
			       "$src = %2\r\n"
			       "$dst = %3\r\n"
			       "robocopy $src $dst /E /MOVE /IS /IT /NFL /NDL /NJH /NJS /R:15 /W:1 | Out-Null\r\n"
			       "$exe = %4\r\n"
			       "$wd = %5\r\n"
			       "$obsArgs = @(%6)\r\n"
			       "Start-Process -FilePath $exe -WorkingDirectory $wd -ArgumentList $obsArgs\r\n"
			       "Start-Sleep -Seconds 2\r\n"
			       "Remove-Item -LiteralPath %7 -Recurse -Force\r\n")
			.arg(QString::number(QCoreApplication::applicationPid()),
			     PowerShellSingleQuoted(QDir::toNativeSeparators(stagedRoot)),
			     PowerShellSingleQuoted(QDir::toNativeSeparators(target.installRoot)),
			     PowerShellSingleQuoted(newExe), PowerShellSingleQuoted(newExeDir),
			     psArgsLiteral.join(QLatin1String(", ")),
			     PowerShellSingleQuoted(QDir::toNativeSeparators(versionDir)));

	QFile scriptFile(scriptPath);
	if (!scriptFile.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.state = QStringLiteral("error");
			m.error = QStringLiteral("Could not write Windows update helper script");
			m.workerBusy = false;
		}
		m.EmitState(false);
		return;
	}
	/* UTF-8 BOM so Windows PowerShell 5.1 reads non-ASCII paths accurately. */
	scriptFile.write("\xEF\xBB\xBF", 3);
	scriptFile.write(script.toUtf8());
	scriptFile.close();

	QString launchErr;
	if (!LaunchHiddenPowerShellScript(scriptPath, launchErr)) {
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.state = QStringLiteral("error");
			m.error = launchErr;
			m.workerBusy = false;
		}
		m.EmitState(false);
		return;
	}

	blog(LOG_INFO, "[WebMIX] Update %s staged; quitting so background helper can replace binaries and restart",
	     qUtf8Printable(latestVersion));
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		m.state = QStringLiteral("restarting");
		m.workerBusy = false;
	}
	m.EmitState(false);
	QMetaObject::invokeMethod(
		qApp, []() { QTimer::singleShot(250, qApp, &QCoreApplication::quit); }, Qt::QueuedConnection);
#else
	QStringList installCmd;
	QProcessEnvironment extraEnv;
	if (target.kind == InstallKind::LinuxDeb) {
		extraEnv.insert(QStringLiteral("DEBIAN_FRONTEND"), QStringLiteral("noninteractive"));
		if (QFileInfo::exists(QStringLiteral("/usr/bin/apt-get"))) {
			installCmd = {QStringLiteral("/usr/bin/apt-get"),
				      QStringLiteral("install"),
				      QStringLiteral("-y"),
				      QStringLiteral("-o"),
				      QStringLiteral("Dpkg::Options::=--force-confdef"),
				      QStringLiteral("-o"),
				      QStringLiteral("Dpkg::Options::=--force-confold"),
				      QStringLiteral("--no-install-recommends"),
				      QStringLiteral("--allow-downgrades"),
				      cachedPath};
		} else {
			installCmd = {QStringLiteral("/usr/bin/dpkg"), QStringLiteral("-i"),
				      QStringLiteral("--force-confdef"), QStringLiteral("--force-confold"), cachedPath};
		}
	} else if (target.kind == InstallKind::LinuxArch) {
		installCmd = {QStringLiteral("/usr/bin/pacman"), QStringLiteral("-U"), QStringLiteral("--noconfirm"),
			      cachedPath};
	} else {
		passwordBytes.fill('\0');
		passwordBytes.clear();
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			m.state = QStringLiteral("error");
			m.error = QStringLiteral("Automatic installation is not supported for this installation type");
			m.workerBusy = false;
		}
		m.EmitState(false);
		return;
	}

	QString installErr;
	if (!RunPrivilegedLinuxCommand(installCmd, extraEnv, passwordBytes, installErr)) {
		{
			std::lock_guard<std::mutex> lock(m.mutex);
			/* Keep `ready` when sudo password failed so the user can retry immediately. */
			if (installErr == QLatin1String("invalid-sudo-password") ||
			    installErr == QLatin1String("sudo-password-required")) {
				m.state = QStringLiteral("ready");
			} else {
				m.state = QStringLiteral("error");
			}
			m.error = installErr;
			m.workerBusy = false;
		}
		m.EmitState(false);
		return;
	}

	QFile::remove(cachedPath);
	blog(LOG_INFO, "[WebMIX] Update %s installed; restarting WebMIX on %s:%u", qUtf8Printable(latestVersion),
	     qUtf8Printable(listenHost), listenPort);

	{
		std::lock_guard<std::mutex> lock(m.mutex);
		m.state = QStringLiteral("restarting");
		m.hasPendingPosixRestart = true;
		m.pendingRestartExecutable = target.executablePath;
		m.pendingRestartArguments = restartArgs;
		m.workerBusy = false;
	}
	restart = true;
	m.EmitState(false);
	QMetaObject::invokeMethod(
		qApp, []() { QTimer::singleShot(250, qApp, &QCoreApplication::quit); }, Qt::QueuedConnection);
#endif
}

} // namespace

void Start(const QString &listenHost, quint16 listenPort)
{
	Manager &m = Mgr();
	config_t *appConfig = App() ? App()->GetAppConfig() : nullptr;

	{
		std::lock_guard<std::mutex> lock(m.mutex);
		if (m.started) {
			return;
		}
		m.started = true;
		m.shuttingDown = false;
		m.cancelFlag.store(false, std::memory_order_relaxed);
		m.listenHost = listenHost;
		m.listenPort = listenPort;
		m.startupArguments = QCoreApplication::arguments();
		m.startupExecutable = QCoreApplication::applicationFilePath();
		/* When /proc/self/exe already has a symlink on PATH like /usr/bin/obs,
		 * prefer the canonical path recorded before any package upgrade. */
		const QFileInfo exeInfo(m.startupExecutable);
		if (exeInfo.exists()) {
			m.startupExecutable = exeInfo.canonicalFilePath();
		}
		m.currentVersion = CurrentVersionString();
		m.target = DetectInstallTarget(m.startupExecutable);
		m.autoCheck = !opt_cli_disable_updater &&
			      (!appConfig || config_get_bool(appConfig, "General", "WebAutoCheckUpdates"));
		const char *skipped = appConfig ? config_get_string(appConfig, "General", "WebSkippedUpdateVersion")
						: nullptr;
		m.skippedVersion = skipped ? QString::fromUtf8(skipped) : QString();
	}

	bool shouldAutoCheck = false;
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		shouldAutoCheck = m.autoCheck;
	}

	m.periodicTimer = new QTimer(qApp);
	m.periodicTimer->setInterval(kPeriodicCheckIntervalMs);
	QObject::connect(m.periodicTimer, &QTimer::timeout, qApp, []() {
		bool run = false;
		{
			Manager &mgr = Mgr();
			std::lock_guard<std::mutex> lock(mgr.mutex);
			run = mgr.started && !mgr.shuttingDown && mgr.autoCheck;
		}
		if (run) {
			Check(false);
		}
	});
	if (shouldAutoCheck) {
		m.periodicTimer->start();
		QTimer::singleShot(InitialCheckDelayMs(), qApp, []() {
			bool run = false;
			{
				Manager &mgr = Mgr();
				std::lock_guard<std::mutex> lock(mgr.mutex);
				run = mgr.started && !mgr.shuttingDown && mgr.autoCheck;
			}
			if (run) {
				Check(false);
			}
		});
	}
}

void Shutdown()
{
	Manager &m = Mgr();
	std::thread toJoin;
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		if (!m.started) {
			return;
		}
		m.shuttingDown = true;
		m.started = false;
		m.cancelFlag.store(true, std::memory_order_relaxed);
		if (m.periodicTimer) {
			m.periodicTimer->stop();
			delete m.periodicTimer;
			m.periodicTimer = nullptr;
		}
		if (m.worker.joinable()) {
			toJoin = std::move(m.worker);
		}
	}
	if (toJoin.joinable()) {
		toJoin.join();
	}
}

QJsonObject State()
{
	Manager &m = Mgr();
	std::lock_guard<std::mutex> lock(m.mutex);
	return m.BuildStateLocked();
}

void Check(bool manual)
{
	Manager &m = Mgr();
	std::thread previous;
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		if (!m.started || m.shuttingDown || m.workerBusy || m.state == QLatin1String("installing") ||
		    m.state == QLatin1String("restarting")) {
			return;
		}
		if (m.worker.joinable()) {
			previous = std::move(m.worker);
		}
		m.workerBusy = true;
		m.manualCheck = manual;
		m.state = QStringLiteral("checking");
		m.error.clear();
		m.cancelFlag.store(false, std::memory_order_relaxed);
	}
	if (previous.joinable()) {
		previous.join();
	}
	m.EmitState(false);
	m.worker = std::thread(RunCheckWorker, manual);
}

bool SkipVersion(const QString &version, QString &error)
{
	config_t *appConfig = App() ? App()->GetAppConfig() : nullptr;
	if (!appConfig) {
		error = QStringLiteral("Application config unavailable");
		return false;
	}
	const QString normalized = NormalizeVersionString(version);
	config_set_string(appConfig, "General", "WebSkippedUpdateVersion", qUtf8Printable(normalized));
	if (config_save_safe(appConfig, "tmp", nullptr) != CONFIG_SUCCESS) {
		error = QStringLiteral("Could not save global.ini.");
		return false;
	}
	{
		Manager &m = Mgr();
		std::lock_guard<std::mutex> lock(m.mutex);
		m.skippedVersion = normalized;
		if (!normalized.isEmpty() && m.prefetching && !m.installRequestedDuringPrefetch) {
			m.cancelFlag.store(true, std::memory_order_relaxed);
		}
	}
	Mgr().EmitState(false);
	return true;
}

void OnAutoCheckChanged(bool enabled)
{
	Manager &m = Mgr();
	bool triggerInitial = false;
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		m.autoCheck = enabled && !opt_cli_disable_updater;
		if (m.periodicTimer) {
			if (m.autoCheck) {
				m.periodicTimer->start();
				triggerInitial = (m.lastCheckedAt == 0 && !m.workerBusy);
			} else {
				m.periodicTimer->stop();
			}
		}
	}
	m.EmitState(false);
	if (triggerInitial) {
		Check(false);
	}
}

bool Install(const QString &sudoPassword, QString &error)
{
	Manager &m = Mgr();
	std::thread previous;
	bool attachedToPrefetch = false;
	{
		std::lock_guard<std::mutex> lock(m.mutex);
		if (!m.started || m.shuttingDown) {
			error = QStringLiteral("Updater is not running");
			return false;
		}
		if (m.state == QLatin1String("installing") || m.state == QLatin1String("restarting")) {
			error = QStringLiteral("An update operation is already in progress");
			return false;
		}
		if (!m.updateAvailable) {
			error = QStringLiteral("No update is available to install");
			return false;
		}
		if (!m.target.canInstall || m.asset.url.isEmpty()) {
			error = QStringLiteral("Automatic installation is not available for this build");
			return false;
		}
#ifndef _WIN32
		/* Re-evaluate passwordless sudo right before installing in case it changed. */
		if (m.target.kind == InstallKind::LinuxDeb || m.target.kind == InstallKind::LinuxArch) {
			m.target.needsPassword = !CanRunRootWithoutPassword();
			if (m.target.needsPassword && sudoPassword.isEmpty()) {
				error = QStringLiteral("sudo-password-required");
				return false;
			}
		}
#endif
		if (m.workerBusy) {
			if (m.prefetching && !m.installRequestedDuringPrefetch) {
				m.installRequestedDuringPrefetch = true;
				m.pendingSudoPassword = sudoPassword.toUtf8();
				m.state = QStringLiteral("downloading");
				m.error.clear();
				attachedToPrefetch = true;
			} else {
				error = QStringLiteral("An update operation is already in progress");
				return false;
			}
		} else {
			if (m.worker.joinable()) {
				previous = std::move(m.worker);
			}
			m.workerBusy = true;
			m.error.clear();
			m.cancelFlag.store(false, std::memory_order_relaxed);
		}
	}
	if (attachedToPrefetch) {
		m.EmitState(false);
		return true;
	}
	if (previous.joinable()) {
		previous.join();
	}

	QByteArray pwUtf8 = sudoPassword.toUtf8();
	m.worker = std::thread(RunInstallWorker, std::move(pwUtf8));
	return true;
}

bool TakePendingRestart(QString &executable, QStringList &arguments)
{
	Manager &m = Mgr();
	std::lock_guard<std::mutex> lock(m.mutex);
	if (!m.hasPendingPosixRestart || m.pendingRestartExecutable.isEmpty()) {
		return false;
	}
	executable = m.pendingRestartExecutable;
	arguments = m.pendingRestartArguments;
	m.hasPendingPosixRestart = false;
	return true;
}

} // namespace WebMixUpdater
