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

#pragma once

#include <QByteArray>
#include <QString>

class QHostAddress;

/* WebMIX: sign-in for browsers on other machines.
 *
 * A browser on this computer (loopback) uses the interface as it always has.
 * Every other browser has to sign in with the one login set in Tools > Web
 * Interface Access; until a login is set, the interface is closed to them.
 *
 * The login lives in global.ini ([General] WebAuthUser, and WebAuthPassword as
 * a salted PBKDF2-SHA256 hash). A successful sign-in opens a session that the
 * browser carries in an HttpOnly, SameSite=Strict cookie; sessions are kept in
 * memory only, so restarting OBS signs everybody out. Repeated failures from
 * one address lock it out for a while. */
namespace WebMixAuth {

/*! Who sent a request, as far as the server can tell. */
struct Client {
	/*! Loopback, not relayed by a proxy, and addressed by a loopback name. */
	bool local = false;
	/*! The peer address, for the log and the lockout. */
	QString address;
	/*! The session the request carried, when it is a live one. */
	QString token;
	/*! The signed-in user, when there is a session. */
	QString user;

	bool Authorized() const { return local || !user.isEmpty(); }
};

enum class LoginResult { Ok, Invalid, NotConfigured, Throttled };

/*! Name the session cookie after the port, so two instances on one machine do
 *  not sign each other out (cookies are per host, not per port). */
void Start(quint16 port);

/*! Classify a request from its peer and its header block. */
Client Identify(const QHostAddress &peer, const QByteArray &headers);

/*! The value of one request header (case-insensitive name), or empty. */
QByteArray HeaderValue(const QByteArray &headers, const QByteArray &name);

bool Configured();
QString Username();
int SessionCount();
int MinPasswordLength();

/*! Check a login and open a session; `retryAfter` is set when throttled. */
LoginResult Login(const Client &client, const QString &user, const QString &password, QString &token, int &retryAfter);
void Logout(const QString &token);

/*! Replace the login. Ends every session except `keepToken`'s. */
bool SetCredentials(const QString &user, const QString &password, const QString &keepToken, QString &error);
/*! Remove the login: other machines can no longer get in at all. */
void ClearCredentials();

/*! Set-Cookie values that start and end a session. */
QByteArray SessionCookie(const QString &token);
QByteArray ExpiredCookie();

} // namespace WebMixAuth
