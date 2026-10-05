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
#include <QHash>
#include <QObject>
#include <QString>

class QTcpServer;
class QTcpSocket;
class QTimer;

/* WebMIX: serves the browser frontend from inside OBS.
 *
 * In web mode - what a plain launch does; `--no-web` opts out - the Qt window
 * is never shown and this server is the only interface to the application.  It
 * delivers the static web frontend and it is the transport for the native
 * control service (WebMixControl):
 *
 *   POST /api/obs/request   one request  -> requestStatus + responseData
 *   POST /api/obs/batch     many requests in one round trip
 *   GET  /api/obs/requests  the request types this build implements
 *   GET  /api/obs/events    Server-Sent Events: every OBS event, live
 *
 * That channel replaces obs-websocket for the UI.  The remaining `/api/*`
 * endpoints cover the handful of operations the old protocol had no request
 * for at all, and are kept because they are the natural home for them.
 *
 * Deliberately built on QTcpServer rather than QtHttpServer so no extra Qt
 * module is required. */
class WebMixServer : public QObject {
	Q_OBJECT

public:
	explicit WebMixServer(QObject *parent = nullptr);
	~WebMixServer() override;

	/*! Start listening. Returns false and logs the reason on failure. */
	bool Start(const QString &host, quint16 port);

	/*! Stop listening and drop any in-flight request. */
	void Stop();

	bool IsRunning() const;
	QString Url() const;

	/*! Absolute path of the directory holding index.html. */
	static QString ResolveWebRoot();

private slots:
	void OnNewConnection();

private:
	void HandleRequest(QTcpSocket *socket, const QByteArray &request);

	/* ---- the native control channel ---------------------------------- */
	void HandleObsRequest(QTcpSocket *socket, const QByteArray &body);
	void HandleObsBatch(QTcpSocket *socket, const QByteArray &body);
	void OpenEventStream(QTcpSocket *socket, const QString &intents);
	void CloseEventStream(QTcpSocket *socket);
	void PingEventStreams();

	void SendFile(QTcpSocket *socket, const QString &path, int status = 200);
	void SendJson(QTcpSocket *socket, const QByteArray &json, int status = 200);
	void SendText(QTcpSocket *socket, const QString &text, int status = 200,
		      const char *type = "text/plain; charset=utf-8");
	void SendError(QTcpSocket *socket, int status, const QString &reason);

	QTcpServer *server = nullptr;
	QString webRoot;
	QString url;

	/*! Live event streams, and the WebMixControl subscription each one owns. */
	QHash<QTcpSocket *, quint64> eventStreams;
	QTimer *keepAlive = nullptr;
};
