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

#include "WebMixAuth.hpp"

#include "OBSApp.hpp"

#include <QCryptographicHash>
#include <QDateTime>
#include <QHash>
#include <QHostAddress>
#include <QList>
#include <QPasswordDigestor>
#include <QRandomGenerator>
#include <QStringList>

#include <util/config-file.h>

namespace WebMixAuth {

namespace {

constexpr const char *kSection = "General";
constexpr const char *kUserKey = "WebAuthUser";
constexpr const char *kPasswordKey = "WebAuthPassword";
constexpr const char *kScheme = "pbkdf2-sha256";

/* About 40 ms on a current desktop CPU. A sign-in runs on the main thread, and
 * the lockout below keeps anyone from making it run often. */
constexpr int kIterations = 100000;
constexpr int kMinPasswordLength = 8;
constexpr int kMaxUserLength = 64;

/* A session ends after a week unused, and after a month regardless. */
constexpr qint64 kIdleLimitMs = 7LL * 24 * 60 * 60 * 1000;
constexpr qint64 kLifetimeMs = 30LL * 24 * 60 * 60 * 1000;
constexpr int kMaxSessions = 64;

/* Five free attempts, then 30 s, 1 min, 2 min... up to 15 min per address. */
constexpr int kFreeAttempts = 5;
constexpr int kBaseLockoutSeconds = 30;
constexpr int kMaxLockoutSeconds = 15 * 60;
constexpr qint64 kForgetFailuresMs = 60LL * 60 * 1000;

struct Session {
	QString user;
	qint64 created = 0;
	qint64 lastSeen = 0;
};

struct Failures {
	int count = 0;
	qint64 last = 0;
	qint64 blockedUntil = 0;
};

QHash<QString, Session> &Sessions()
{
	static QHash<QString, Session> sessions;
	return sessions;
}

QHash<QString, Failures> &FailureLog()
{
	static QHash<QString, Failures> failures;
	return failures;
}

QByteArray &CookieName()
{
	static QByteArray name = "webmix_session";
	return name;
}

qint64 Now()
{
	return QDateTime::currentMSecsSinceEpoch();
}

QByteArray RandomBytes(int count)
{
	QByteArray bytes(count, Qt::Uninitialized);
	for (int i = 0; i < count; i++) {
		bytes[i] = static_cast<char>(QRandomGenerator::system()->bounded(256));
	}
	return bytes;
}

QByteArray Derive(const QString &password, const QByteArray &salt, int iterations)
{
	return QPasswordDigestor::deriveKeyPbkdf2(QCryptographicHash::Sha256, password.toUtf8(), salt, iterations, 32);
}

/*! Equal-length comparison that takes the same time wherever they differ. */
bool SameBytes(const QByteArray &a, const QByteArray &b)
{
	if (a.size() != b.size()) {
		return false;
	}
	unsigned char difference = 0;
	for (qsizetype i = 0; i < a.size(); i++) {
		difference |= static_cast<unsigned char>(a.at(i) ^ b.at(i));
	}
	return difference == 0;
}

QString StoredRecord()
{
	const char *record = config_get_string(App()->GetAppConfig(), kSection, kPasswordKey);
	return record ? QString::fromUtf8(record) : QString();
}

/*! Whether `password` hashes to `record` ("scheme$iterations$salt$hash"). An
 *  unreadable record still costs a full derivation, so a wrong user name and a
 *  wrong password cannot be told apart by how long the answer takes. */
bool Matches(const QString &password, const QString &record)
{
	const QStringList parts = record.split(QLatin1Char('$'));
	bool ok = parts.size() == 4 && parts.at(0) == QLatin1String(kScheme);
	const int iterations = ok ? parts.at(1).toInt(&ok) : 0;
	ok = ok && iterations > 0 && iterations <= 10000000;
	const QByteArray salt = ok ? QByteArray::fromBase64(parts.at(2).toLatin1()) : QByteArray("webmix");
	const QByteArray expected = ok ? QByteArray::fromBase64(parts.at(3).toLatin1()) : QByteArray();

	const QByteArray derived = Derive(password, salt, ok ? iterations : kIterations);
	return ok && SameBytes(derived, expected);
}

/*! "host", "host:port", "[v6]:port" -> whether it names this machine's loopback. */
bool IsLoopbackHost(const QByteArray &hostHeader)
{
	QString host = QString::fromLatin1(hostHeader).trimmed().toLower();
	if (host.isEmpty()) {
		return true; /* HTTP/1.0 has no Host; the peer check still applies */
	}
	if (host.startsWith(QLatin1Char('['))) {
		host = host.mid(1, host.indexOf(QLatin1Char(']')) - 1);
	} else if (host.count(QLatin1Char(':')) == 1) {
		host = host.section(QLatin1Char(':'), 0, 0);
	}
	if (host == QLatin1String("localhost") || host.endsWith(QLatin1String(".localhost"))) {
		return true;
	}
	const QHostAddress address(host);
	return !address.isNull() && address.isLoopback();
}

QString CookieValue(const QByteArray &cookieHeader)
{
	const QByteArray prefix = CookieName() + '=';
	for (const QByteArray &part : cookieHeader.split(';')) {
		const QByteArray trimmed = part.trimmed();
		if (trimmed.startsWith(prefix)) {
			return QString::fromLatin1(trimmed.mid(prefix.size()));
		}
	}
	return QString();
}

void PruneSessions(qint64 now)
{
	auto &sessions = Sessions();
	for (auto it = sessions.begin(); it != sessions.end();) {
		if (now - it->lastSeen > kIdleLimitMs || now - it->created > kLifetimeMs) {
			it = sessions.erase(it);
		} else {
			++it;
		}
	}
	/* Over the cap, the session used least recently goes first. */
	while (sessions.size() >= kMaxSessions) {
		auto oldest = sessions.begin();
		for (auto it = sessions.begin(); it != sessions.end(); ++it) {
			if (it->lastSeen < oldest->lastSeen) {
				oldest = it;
			}
		}
		sessions.erase(oldest);
	}
}

void PruneFailures(qint64 now)
{
	auto &failures = FailureLog();
	for (auto it = failures.begin(); it != failures.end();) {
		if (it->blockedUntil <= now && now - it->last > kForgetFailuresMs) {
			it = failures.erase(it);
		} else {
			++it;
		}
	}
}

} // namespace

void Start(quint16 port)
{
	CookieName() = "webmix_session_" + QByteArray::number(port);
}

QByteArray HeaderValue(const QByteArray &headers, const QByteArray &name)
{
	const QByteArray wanted = name.toLower();
	const QList<QByteArray> lines = headers.split('\n');
	/* The first line is the request line, never a header. */
	for (qsizetype i = 1; i < lines.size(); i++) {
		const QByteArray &line = lines.at(i);
		const qsizetype colon = line.indexOf(':');
		if (colon <= 0) {
			continue;
		}
		if (line.left(colon).trimmed().toLower() == wanted) {
			return line.mid(colon + 1).trimmed();
		}
	}
	return QByteArray();
}

Client Identify(const QHostAddress &peer, const QByteArray &headers)
{
	Client client;

	/* A dual-stack listener reports IPv4 peers as ::ffff:a.b.c.d. */
	QHostAddress address = peer;
	bool mapped = false;
	const quint32 v4 = peer.toIPv4Address(&mapped);
	if (mapped) {
		address = QHostAddress(v4);
	}
	client.address = address.toString();

	/* "Not from localhost" is about the browser, not the last hop: a reverse
	 * proxy on this machine connects from loopback on behalf of somebody else,
	 * and says so in a forwarding header. A Host that is not a loopback name
	 * means the page was opened through a DNS name that points here - which is
	 * also how a DNS-rebinding page would reach a loopback server - so that
	 * browser signs in too. */
	const bool forwarded = !HeaderValue(headers, "x-forwarded-for").isEmpty() ||
			       !HeaderValue(headers, "forwarded").isEmpty() ||
			       !HeaderValue(headers, "x-real-ip").isEmpty();
	client.local = address.isLoopback() && !forwarded && IsLoopbackHost(HeaderValue(headers, "host"));

	const QString token = CookieValue(HeaderValue(headers, "cookie"));
	if (!token.isEmpty()) {
		const qint64 now = Now();
		auto it = Sessions().find(token);
		if (it != Sessions().end()) {
			if (now - it->lastSeen > kIdleLimitMs || now - it->created > kLifetimeMs) {
				Sessions().erase(it);
			} else {
				it->lastSeen = now;
				client.token = token;
				client.user = it->user;
			}
		}
	}
	return client;
}

bool Configured()
{
	return !Username().isEmpty() && !StoredRecord().isEmpty();
}

QString Username()
{
	const char *user = config_get_string(App()->GetAppConfig(), kSection, kUserKey);
	return user ? QString::fromUtf8(user) : QString();
}

int SessionCount()
{
	PruneSessions(Now());
	return static_cast<int>(Sessions().size());
}

int MinPasswordLength()
{
	return kMinPasswordLength;
}

LoginResult Login(const Client &client, const QString &user, const QString &password, QString &token, int &retryAfter)
{
	const qint64 now = Now();
	PruneFailures(now);

	Failures &failures = FailureLog()[client.address];
	if (failures.blockedUntil > now) {
		retryAfter = static_cast<int>((failures.blockedUntil - now + 999) / 1000);
		return LoginResult::Throttled;
	}
	if (!Configured()) {
		FailureLog().remove(client.address);
		return LoginResult::NotConfigured;
	}

	/* Both checks always run: see Matches(). */
	const bool userMatches = SameBytes(user.toUtf8(), Username().toUtf8());
	const bool passwordMatches = Matches(password, StoredRecord());
	if (!userMatches || !passwordMatches) {
		failures.count++;
		failures.last = now;
		if (failures.count >= kFreeAttempts) {
			const int doublings = qMin(failures.count - kFreeAttempts, 5);
			const int seconds = qMin(kBaseLockoutSeconds << doublings, kMaxLockoutSeconds);
			failures.blockedUntil = now + seconds * 1000LL;
			retryAfter = seconds;
		}
		blog(LOG_WARNING, "[WebMIX] Failed sign-in to the web interface from %s (%d in a row)",
		     qUtf8Printable(client.address), failures.count);
		return LoginResult::Invalid;
	}

	FailureLog().remove(client.address);
	PruneSessions(now);
	token = QString::fromLatin1(RandomBytes(32).toHex());
	Session session;
	session.user = user;
	session.created = now;
	session.lastSeen = now;
	Sessions().insert(token, session);
	blog(LOG_INFO, "[WebMIX] '%s' signed in to the web interface from %s", qUtf8Printable(user),
	     qUtf8Printable(client.address));
	return LoginResult::Ok;
}

void Logout(const QString &token)
{
	if (!token.isEmpty()) {
		Sessions().remove(token);
	}
}

bool SetCredentials(const QString &user, const QString &password, const QString &keepToken, QString &error)
{
	const QString name = user.trimmed();
	if (name.isEmpty()) {
		error = QStringLiteral("The login must not be empty.");
		return false;
	}
	if (name.size() > kMaxUserLength) {
		error = QStringLiteral("The login is longer than %1 characters.").arg(kMaxUserLength);
		return false;
	}
	if (password.size() < kMinPasswordLength) {
		error = QStringLiteral("The password must be at least %1 characters long.").arg(kMinPasswordLength);
		return false;
	}

	const QByteArray salt = RandomBytes(16);
	const QString record = QStringLiteral("%1$%2$%3$%4")
				       .arg(QLatin1String(kScheme))
				       .arg(kIterations)
				       .arg(QString::fromLatin1(salt.toBase64()))
				       .arg(QString::fromLatin1(Derive(password, salt, kIterations).toBase64()));

	config_t *config = App()->GetAppConfig();
	config_set_string(config, kSection, kUserKey, name.toUtf8().constData());
	config_set_string(config, kSection, kPasswordKey, record.toUtf8().constData());
	if (config_save_safe(config, "tmp", nullptr) != CONFIG_SUCCESS) {
		error = QStringLiteral("Could not save global.ini.");
		return false;
	}

	/* Whoever knew the old login is out; the browser that set the new one
	 * stays signed in, under the new name. */
	auto &sessions = Sessions();
	const auto kept = sessions.constFind(keepToken);
	Session keep;
	const bool keeping = !keepToken.isEmpty() && kept != sessions.constEnd();
	if (keeping) {
		keep = kept.value();
		keep.user = name;
	}
	sessions.clear();
	if (keeping) {
		sessions.insert(keepToken, keep);
	}
	FailureLog().clear();

	blog(LOG_INFO, "[WebMIX] The web interface login was changed (user '%s')", qUtf8Printable(name));
	return true;
}

void ClearCredentials()
{
	config_t *config = App()->GetAppConfig();
	config_remove_value(config, kSection, kUserKey);
	config_remove_value(config, kSection, kPasswordKey);
	config_save_safe(config, "tmp", nullptr);
	Sessions().clear();
	FailureLog().clear();
	blog(LOG_INFO, "[WebMIX] The web interface login was removed; other machines cannot sign in");
}

QByteArray SessionCookie(const QString &token)
{
	/* Plain HTTP, so no Secure flag; HttpOnly keeps it from scripts, and
	 * SameSite=Strict keeps other sites from riding on it. */
	return CookieName() + '=' + token.toLatin1() +
	       "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + QByteArray::number(kLifetimeMs / 1000);
}

QByteArray ExpiredCookie()
{
	return CookieName() + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}

} // namespace WebMixAuth
