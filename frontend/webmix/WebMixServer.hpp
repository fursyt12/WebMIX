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
#include <QObject>
#include <QString>

class QTcpServer;
class QTcpSocket;

/* WebMIX: serves the browser frontend from inside OBS.
 *
 * In `--web` mode the Qt window is never shown and this server is the only
 * interface to the application: it delivers the static web frontend, exposes
 * the obs-websocket connection details to it, and provides the few control
 * endpoints the websocket protocol does not cover (currently shutdown).
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

	void SendFile(QTcpSocket *socket, const QString &path, int status = 200);
	void SendJson(QTcpSocket *socket, const QByteArray &json, int status = 200);
	void SendText(QTcpSocket *socket, const QString &text, int status = 200,
		      const char *type = "text/plain; charset=utf-8");
	void SendError(QTcpSocket *socket, int status, const QString &reason);

	QTcpServer *server = nullptr;
	QString webRoot;
	QString url;
};
