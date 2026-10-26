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

#include "WebMixServer.hpp"

#include "WebMixAuth.hpp"
#include "WebMixBridge.hpp"
#include "WebMixControl.hpp"
#include "WebMixPreview.hpp"
#include "WebMixRemux.hpp"
#include "WebMixStartup.hpp"
#include "WebMixWebSocket.hpp"

#include "OBSApp.hpp"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QImage>
#include <QMetaObject>
#include <QSharedPointer>
#include <QUrlQuery>
#include <QTcpServer>
#include <QTcpSocket>
#include <QUrl>
#include <QTimer>

#include <obs-frontend-api.h>
#include <obs.hpp>
#include <util/platform.h>

#include <utility>

extern bool web_mode;

namespace {

constexpr int kMaxRequestBytes = 16 * 1024;

/*! A query parameter, fully decoded.
 *
 * QUrlQuery decodes in PrettyDecoded mode by default, which leaves encoded
 * delimiters alone: "name=%D0%9C%D0%B8%D0%BA%D1%80%2F%D0%B4%D0%BE%D0%BF" (the
 * default microphone is called "Микр/доп") arrived undecoded and every lookup
 * failed. Names, paths and filters all have to be decoded completely.
 */
QString QueryValue(const QUrlQuery &query, const char *key)
{
	return query.queryItemValue(QString::fromLatin1(key), QUrl::FullyDecoded);
}

/*! A positive integer query parameter, or `fallback` when it is missing or
 *  nonsense (an absent parameter reads as 0).  The GNU `x ?: fallback`
 *  shorthand would be shorter, but MSVC rejects it. */
int QueryIntOr(const QUrlQuery &query, const char *name, int fallback)
{
	const int value = QueryValue(query, name).toInt();
	return value > 0 ? value : fallback;
}

const char *MimeForSuffix(const QString &suffix)
{
	if (suffix == "html" || suffix == "htm") {
		return "text/html; charset=utf-8";
	}
	if (suffix == "js" || suffix == "mjs") {
		return "text/javascript; charset=utf-8";
	}
	if (suffix == "css") {
		return "text/css; charset=utf-8";
	}
	if (suffix == "json" || suffix == "map") {
		return "application/json; charset=utf-8";
	}
	if (suffix == "svg") {
		return "image/svg+xml";
	}
	if (suffix == "png") {
		return "image/png";
	}
	if (suffix == "jpg" || suffix == "jpeg") {
		return "image/jpeg";
	}
	if (suffix == "webp") {
		return "image/webp";
	}
	if (suffix == "ico") {
		return "image/x-icon";
	}
	if (suffix == "ttf") {
		return "font/ttf";
	}
	if (suffix == "otf") {
		return "font/otf";
	}
	if (suffix == "woff2") {
		return "font/woff2";
	}
	return "application/octet-stream";
}

/*! Stops the server when OBS starts to exit; see WebMixServer::Start(). */
void OnFrontendExit(enum obs_frontend_event event, void *self)
{
	if (event == OBS_FRONTEND_EVENT_EXIT) {
		static_cast<WebMixServer *>(self)->Stop();
	}
}

/*! What a browser on another machine may fetch before it has signed in: the
 *  sign-in page and its two scripts, the theme it is drawn with, and OBS's
 *  strings. Nothing here controls OBS or reads its files. */
bool OpenWithoutSignIn(const QString &path)
{
	const QString decoded = QUrl::fromPercentEncoding(path.toUtf8());
	if (decoded.contains(QLatin1String("..")) || decoded.contains(QLatin1Char('\\'))) {
		return false;
	}
	return decoded == QLatin1String("/login.html") || decoded == QLatin1String("/src/login.js") ||
	       decoded == QLatin1String("/src/i18n.js") || decoded.startsWith(QLatin1String("/assets/")) ||
	       decoded == QLatin1String("/api/locale");
}

/*! Where a page that needs a sign-in is sent. Both the form and the address to
 *  return to are relative to the interface's root, so this also works behind a
 *  reverse proxy that serves the interface under a path of its own. */
QByteArray SignInLocation(const QString &target)
{
	const QString path = target.section(QLatin1Char('?'), 0, 0);
	const QByteArray up = QByteArray("../").repeated(qMax(0, static_cast<int>(path.count(QLatin1Char('/'))) - 1));
	return up + "login.html?next=" + QUrl::toPercentEncoding(QStringLiteral("./") + target.mid(1));
}

/*! Whether a state-changing request comes from a page served here.
 *
 * Any site the user has open can make the browser send requests to this
 * server - to a loopback one too - but it cannot forge the Origin header the
 * browser puts on them. Requests without one (curl, scripts) are not a
 * browser acting for some other page. Behind a TLS reverse proxy the scheme
 * differs and the proxy may rewrite Host, so the origin's authority is
 * compared with Host and X-Forwarded-Host. */
bool SameOrigin(const QByteArray &headers)
{
	QByteArray origin = WebMixAuth::HeaderValue(headers, "origin");
	if (origin.isEmpty()) {
		return true;
	}
	const qsizetype scheme = origin.indexOf("://");
	if (scheme < 0) {
		return false; /* "null": a sandboxed frame or a file */
	}
	origin = origin.mid(scheme + 3).toLower();

	const QByteArray host = WebMixAuth::HeaderValue(headers, "host").toLower();
	const QByteArray forwardedHost =
		WebMixAuth::HeaderValue(headers, "x-forwarded-host").split(',').first().trimmed().toLower();
	return origin == host || (!forwardedHost.isEmpty() && origin == forwardedHost);
}

/*! Path of obs-websocket's config.json, or an empty string. */
QString ObsWebSocketConfigPath()
{
	char path[512];
	if (GetAppConfigPath(path, sizeof(path), "obs-studio/plugin_config/obs-websocket/config.json") <= 0) {
		return QString();
	}
	return QString::fromUtf8(path);
}

} // namespace

WebMixServer::WebMixServer(QObject *parent) : QObject(parent) {}

WebMixServer::~WebMixServer()
{
	Stop();
}

QString WebMixServer::ResolveWebRoot()
{
	QStringList candidates;

	/* Explicit override wins, for development and portable installs. */
	const QByteArray envRoot = qgetenv("WEBMIX_WEB_ROOT");
	if (!envRoot.isEmpty()) {
		candidates << QString::fromUtf8(envRoot);
	}

#ifdef WEBMIX_SOURCE_WEB_DIR
	/* Build-time location of the repository's web/ directory. */
	candidates << QStringLiteral(WEBMIX_SOURCE_WEB_DIR);
#endif

	const QString appDir = QCoreApplication::applicationDirPath();
	candidates << appDir + "/web";
	/* Windows packages: bin/64bit/obs.exe with the data under <root>/data
	 * (OBS_DATA_DESTINATION), so the web frontend sits next to obs-plugins. */
	candidates << appDir + "/../../data/obs-studio/web";
	candidates << appDir + "/../data/obs-studio/web";
	candidates << appDir + "/data/web";
	/* Linux packages: /usr/bin/obs with <prefix>/share/obs-studio/web. */
	candidates << appDir + "/../share/obs-studio/web";
	/* macOS app bundles keep it in Contents/Resources/data. */
	candidates << appDir + "/../Resources/data/obs-studio/web";

	for (const QString &candidate : candidates) {
		const QFileInfo info(candidate);
		if (info.isDir() && QFileInfo::exists(candidate + "/index.html")) {
			return info.canonicalFilePath();
		}
	}
	return QString();
}

bool WebMixServer::Start(const QString &host, quint16 port)
{
	webRoot = ResolveWebRoot();
	if (webRoot.isEmpty()) {
		blog(LOG_ERROR, "[WebMIX] Could not find the web frontend. Set WEBMIX_WEB_ROOT to the "
				"directory containing index.html.");
		return false;
	}

	server = new QTcpServer(this);
	connect(server, &QTcpServer::newConnection, this, &WebMixServer::OnNewConnection);

	QHostAddress address;
	if (host.isEmpty() || host == "localhost") {
		address = QHostAddress::LocalHost;
	} else if (!address.setAddress(host)) {
		blog(LOG_ERROR, "[WebMIX] Invalid --web-host address '%s'", qUtf8Printable(host));
		delete server;
		server = nullptr;
		return false;
	}

	if (!server->listen(address, port)) {
		blog(LOG_ERROR, "[WebMIX] Could not listen on %s:%u: %s", qUtf8Printable(address.toString()), port,
		     qUtf8Printable(server->errorString()));
		delete server;
		server = nullptr;
		return false;
	}

	/* A wildcard bind is not an address a browser can open, so the URL handed
	 * out (and opened) points at loopback. A specific address is used as-is:
	 * the browser may well be on another machine. */
	const bool wildcard = address == QHostAddress(QHostAddress::Any) ||
			      address == QHostAddress(QHostAddress::AnyIPv4) ||
			      address == QHostAddress(QHostAddress::AnyIPv6);
	const QHostAddress reachable = wildcard ? QHostAddress(QHostAddress::LocalHost) : address;
	url = QStringLiteral("http://%1:%2/").arg(reachable.toString()).arg(server->serverPort());
	WebMixAuth::Start(server->serverPort());

	/* Browsers on this machine need no sign-in; every other one signs in with
	 * the login from Tools > Web Interface Access. That is plain HTTP, so the
	 * login (and everything after it) crosses the network unencrypted. */
	if (!address.isLoopback()) {
		blog(LOG_WARNING, "[WebMIX] ---------------------------------------------------------------");
		blog(LOG_WARNING, "[WebMIX] The web interface is reachable from the network (%s).",
		     qUtf8Printable(address.toString()));
		if (WebMixAuth::Configured()) {
			blog(LOG_WARNING,
			     "[WebMIX] Other machines have to sign in as '%s'. The connection is not "
			     "encrypted: use it on a trusted network, or behind a reverse proxy with TLS.",
			     qUtf8Printable(WebMixAuth::Username()));
		} else {
			blog(LOG_WARNING,
			     "[WebMIX] No login is set, so only this machine can use it. Set one in "
			     "Tools > Web Interface Access (from %s on this machine).",
			     qUtf8Printable(url));
		}
		blog(LOG_WARNING, "[WebMIX] ---------------------------------------------------------------");
	}
	blog(LOG_INFO, "[WebMIX] ---------------------------------------------------------------");
	blog(LOG_INFO, "[WebMIX] Web interface: %s", qUtf8Printable(url));
	blog(LOG_INFO, "[WebMIX] Serving files from: %s", qUtf8Printable(webRoot));
	blog(LOG_INFO, "[WebMIX] The OBS window is hidden; use the web interface to control OBS.");
	blog(LOG_INFO, "[WebMIX] ---------------------------------------------------------------");

	/* The control service is what the browser actually talks to: it drives
	 * libobs directly, so the page needs neither obs-websocket nor the port
	 * and password that used to come with it.  Start it only once the server
	 * is listening, so an unusable port does not leave the event bridge
	 * metering audio for nobody. */
	/* The server is a child of the application object and would otherwise be
	 * torn down with it - after libobs has shut down, with sources still
	 * hooked and threads still running against it. Leave when OBS says it is
	 * leaving instead.  Registered before the control service so that its
	 * own handler (which announces the exit to the page) runs first. */
	obs_frontend_add_event_callback(OnFrontendExit, this);
	exitHooked = true;

	WebMixControl::Start();
	keepAlive = new QTimer(this);
	keepAlive->setInterval(15000);
	connect(keepAlive, &QTimer::timeout, this, &WebMixServer::PingEventStreams);
	keepAlive->start();

	return true;
}

void WebMixServer::Stop()
{
	if (exitHooked) {
		exitHooked = false;
		obs_frontend_remove_event_callback(OnFrontendExit, this);
	}

	/* A remux runs on its own thread and must not outlive libobs. */
	WebMixRemux::Shutdown();
	/* Neither may the preview captures: they hold GPU resources. */
	WebMixPreview::Shutdown();

	if (keepAlive) {
		keepAlive->stop();
		delete keepAlive;
		keepAlive = nullptr;
	}

	/* Drop the event streams before the control service forgets its sinks, so
	 * a socket is never left waiting on a callback that no longer exists. */
	for (auto it = eventStreams.begin(); it != eventStreams.end(); ++it) {
		WebMixControl::Unsubscribe(it.value());
		if (it.key()) {
			it.key()->disconnectFromHost();
		}
	}
	eventStreams.clear();
	WebMixControl::Stop();

	if (!server) {
		return;
	}
	server->close();
	server->deleteLater();
	server = nullptr;
	url.clear();
}

bool WebMixServer::IsRunning() const
{
	return server && server->isListening();
}

QString WebMixServer::Url() const
{
	return url;
}

void WebMixServer::OnNewConnection()
{
	while (server && server->hasPendingConnections()) {
		QTcpSocket *socket = server->nextPendingConnection();
		if (!socket) {
			return;
		}

		socket->setParent(this);
		connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);

		/* Request headers are accumulated in a shared buffer that lives as
		 * long as the connection: the socket is the connection context, so the
		 * lambda (and the buffer with it) is released with the socket. */
		auto buffer = QSharedPointer<QByteArray>::create();
		connect(socket, &QTcpSocket::readyRead, socket, [this, socket, buffer]() {
			buffer->append(socket->readAll());
			if (buffer->size() > kMaxRequestBytes) {
				SendError(socket, 431, "Request too large");
				return;
			}
			const int headerEnd = buffer->indexOf("\r\n\r\n");
			if (headerEnd < 0) {
				return; /* wait for the rest of the headers */
			}

			/* Wait for the body too: several bridge endpoints POST JSON. */
			const QByteArray headers = buffer->left(headerEnd);
			int contentLength = 0;
			for (const QByteArray &line : headers.split('\n')) {
				const QByteArray trimmed = line.trimmed();
				if (trimmed.toLower().startsWith("content-length:")) {
					contentLength = trimmed.mid(15).trimmed().toInt();
				}
			}
			if (buffer->size() < headerEnd + 4 + contentLength) {
				return; /* wait for the rest of the body */
			}

			const QByteArray request = buffer->left(headerEnd + 4 + contentLength);
			buffer->clear();
			HandleRequest(socket, request);
		});
	}
}

void WebMixServer::HandleRequest(QTcpSocket *socket, const QByteArray &request)
{
	const int lineEnd = request.indexOf("\r\n");
	const QByteArray requestLine = lineEnd >= 0 ? request.left(lineEnd) : request;
	const QList<QByteArray> parts = requestLine.split(' ');
	if (parts.size() < 2) {
		SendError(socket, 400, "Malformed request");
		return;
	}

	const QByteArray method = parts.at(0).toUpper();
	const QString target = QString::fromUtf8(parts.at(1));
	const QString path = target.section('?', 0, 0);
	const QUrlQuery query(target.section('?', 1));
	const QString body = QString::fromUtf8(request.mid(request.indexOf("\r\n\r\n") + 4));
	UNUSED_PARAMETER(body);

	/* --- who is asking ------------------------------------------------------ */
	const QByteArray headers = request.left(request.indexOf("\r\n\r\n"));
	if (method != "GET" && method != "HEAD" && !SameOrigin(headers)) {
		blog(LOG_WARNING, "[WebMIX] Refused %s %s from another site (%s)", method.constData(),
		     qUtf8Printable(path), WebMixAuth::HeaderValue(headers, "origin").constData());
		SendError(socket, 403, "Cross-site request refused");
		return;
	}

	const WebMixAuth::Client client = WebMixAuth::Identify(socket->peerAddress(), headers);
	if (path.startsWith(QLatin1String("/api/auth/"))) {
		HandleAuth(socket, method, path, request.mid(request.indexOf("\r\n\r\n") + 4), client);
		return;
	}
	if (!client.Authorized() && !OpenWithoutSignIn(path)) {
		/* A page is sent to the sign-in form, which comes back here when it
		 * is done; anything a script asked for gets a 401 it can act on. */
		if ((method == "GET" || method == "HEAD") && !path.startsWith(QLatin1String("/api/")) &&
		    path != QLatin1String("/obs-config.json")) {
			SendRedirect(socket, SignInLocation(target));
			return;
		}
		SendJson(socket, R"({"ok":false,"error":"Sign-in required","signIn":"login.html"})", 401);
		return;
	}

	/* --- the native control channel ---------------------------------------- */
	if (path.startsWith(QLatin1String("/api/obs/"))) {
		if (method == "GET" || method == "HEAD") {
			if (path == "/api/obs/events") {
				OpenEventStream(socket, QueryValue(query, "intents"));
				return;
			}
			if (path == "/api/obs/requests") {
				QJsonObject payload;
				payload["requests"] = QJsonArray::fromStringList(WebMixControl::RequestTypes());
				SendJson(socket, QJsonDocument(payload).toJson(QJsonDocument::Compact));
				return;
			}
			SendError(socket, 404, "Unknown control endpoint");
			return;
		}
		if (method != "POST") {
			SendError(socket, 405, "Method not allowed");
			return;
		}
		if (path == "/api/obs/request") {
			HandleObsRequest(socket, request.mid(request.indexOf("\r\n\r\n") + 4));
			return;
		}
		if (path == "/api/obs/batch") {
			HandleObsBatch(socket, request.mid(request.indexOf("\r\n\r\n") + 4));
			return;
		}
		SendError(socket, 404, "Unknown control endpoint");
		return;
	}

	/* --- live preview frames ------------------------------------------------ */
	if (path == "/api/preview.mjpg" || path == "/api/preview.jpg" || path == "/api/preview/multiview.mjpg" ||
	    path == "/api/preview/multiview.jpg") {
		const bool multiview = path.contains(QLatin1String("multiview"));
		const bool singleFrame = path.endsWith(QLatin1String(".jpg"));
		const QString source = QueryValue(query, "source");
		/* `view=program` is the program output itself - what is going out,
		 * transitions included - rather than a scene rendered again by name. */
		const bool program = !multiview && !singleFrame &&
				     QueryValue(query, "view") == QLatin1String("program");

		if (!multiview && !program && source.isEmpty()) {
			SendError(socket, 400, "Missing source");
			return;
		}

		/* Multiview defaults to a 16:9 grid; a single source uses its own size
		 * when no dimensions are given. */
		int width = QueryValue(query, "width").toInt();
		int height = QueryValue(query, "height").toInt();
		if (multiview && (width <= 0 || height <= 0)) {
			width = 1280;
			height = 720;
		}
		const int quality = qBound(1, QueryIntOr(query, "quality", 75), 100);

		/* A caller may pin the tile order (and selection) explicitly. */
		QStringList sceneList;
		const QString scenes = QueryValue(query, "scenes");
		if (multiview && !scenes.isEmpty()) {
			sceneList = scenes.split(',', Qt::SkipEmptyParts);
		}

		if (singleFrame) {
			bool ok = false;
			const QImage frame = multiview ? WebMixPreview::CaptureMultiview(sceneList, width, height, ok)
						       : WebMixPreview::CaptureSource(source, width, height, ok);
			if (!ok) {
				SendError(socket, 503, multiview ? "No scenes to compose" : "Source is not renderable");
				return;
			}
			const QByteArray jpeg = WebMixPreview::EncodeJpeg(frame, quality);
			if (jpeg.isEmpty()) {
				SendError(socket, 500, "JPEG encoding unavailable");
				return;
			}
			QByteArray header;
			header += "HTTP/1.1 200 OK\r\n";
			header += "Content-Type: image/jpeg\r\n";
			header += "Content-Length: " + QByteArray::number(jpeg.size()) + "\r\n";
			header += "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
			socket->write(header);
			socket->write(jpeg);
			socket->disconnectFromHost();
			return;
		}

		if (WebMixPreview::ActiveStreams() >= WebMixPreview::Stream::kMaxStreams) {
			SendError(socket, 503, "Too many preview streams");
			return;
		}

		WebMixPreview::Target target;
		target.kind = multiview ? WebMixPreview::Target::Kind::Multiview
			      : program ? WebMixPreview::Target::Kind::Program
					: WebMixPreview::Target::Kind::Source;
		target.source = program ? QString() : source;
		target.scenes = sceneList;
		target.width = static_cast<uint32_t>(qMax(0, width));
		target.height = static_cast<uint32_t>(qMax(0, height));
		/* OBS's own frame rate is the ceiling whatever is asked for: a frame
		 * is only made when OBS has rendered one. */
		target.fps = qBound(1, QueryIntOr(query, "fps", 30), 240);
		target.quality = quality;

		/* The stream owns the socket from here on.  The request buffer was
		 * connected as a lambda with the socket as its context, so the
		 * signal itself has to be disconnected - matching on `this` would
		 * leave the buffer consuming the stream's own bytes. */
		disconnect(socket, &QTcpSocket::readyRead, nullptr, nullptr);
		auto *stream = new WebMixPreview::Stream(socket, target, this);
		stream->Start();
		return;
	}

	if (path == "/api/locale") {
		SendJson(socket, QJsonDocument(WebMixBridge::LocaleStrings()).toJson(QJsonDocument::Compact));
		return;
	}

	if (path == "/api/encoders") {
		SendJson(socket, QJsonDocument(WebMixBridge::EncoderOptions()).toJson(QJsonDocument::Compact));
		return;
	}

	/* --- file access (recordings, logs, settings) -------------------------- */
	if (path == "/api/files/list") {
		const QString kind = QueryValue(query, "kind");
		QJsonObject listing = WebMixBridge::ListDirectory(kind, QueryValue(query, "path"));
		if (listing.contains("error")) {
			SendJson(socket, QJsonDocument(listing).toJson(QJsonDocument::Compact), 400);
			return;
		}
		SendJson(socket, QJsonDocument(listing).toJson(QJsonDocument::Compact));
		return;
	}

	if (path == "/api/files/text") {
		const QString kind = QueryValue(query, "kind");
		const QString file = QueryValue(query, "path");
		QString text;
		QString error;
		const int limit = QueryIntOr(query, "limit", 128 * 1024);
		if (!WebMixBridge::ReadTextTail(kind, file, limit, text, error)) {
			SendError(socket, 404, error);
			return;
		}
		SendText(socket, text);
		return;
	}

	if (path == "/api/files/download") {
		const QString kind = QueryValue(query, "kind");
		const QString name = QueryValue(query, "path");
		QString filePath;
		QString error;
		if (!WebMixBridge::ResolveFileForDownload(kind, name, filePath, error)) {
			blog(LOG_WARNING, "[WebMIX] Download of '%s' (%s) refused: %s", qUtf8Printable(name),
			     qUtf8Printable(kind), qUtf8Printable(error));
			SendError(socket, 404, error);
			return;
		}

		QFile file(filePath);
		if (!file.open(QIODevice::ReadOnly)) {
			SendError(socket, 500, "could not open the file");
			return;
		}

		blog(LOG_INFO, "[WebMIX] Serving '%s' (%lld bytes)", qUtf8Printable(name), file.size());
		QByteArray header;
		header += "HTTP/1.1 200 OK\r\n";
		header += "Content-Type: application/octet-stream\r\n";
		header += "Content-Length: " + QByteArray::number(file.size()) + "\r\n";
		/* RFC 5987: a plain quoted name for legacy clients plus the UTF-8
		 * form browsers actually use. The plain name must stay ASCII. */
		const QString downloadName = QFileInfo(filePath).fileName();
		QString asciiName;
		for (const QChar &character : downloadName) {
			asciiName.append(character.unicode() < 127 && character != '"' && character != '\\'
						 ? character
						 : QLatin1Char('_'));
		}
		header += "Content-Disposition: attachment; filename=\"" + asciiName.toUtf8() +
			  "\"; filename*=UTF-8''" + downloadName.toUtf8().toPercentEncoding() + "\r\n";
		header += "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
		socket->write(header);

		/* Stream in chunks so a large recording does not sit in memory. */
		while (!file.atEnd()) {
			const QByteArray chunk = file.read(256 * 1024);
			if (chunk.isEmpty()) {
				break;
			}
			if (socket->write(chunk) < 0) {
				break;
			}
			socket->waitForBytesWritten(5000);
		}
		socket->disconnectFromHost();
		return;
	}

	/* --- remuxing (the WebMIX bridge) -------------------------------------- */
	if (path.startsWith("/api/remux")) {
		if (path == "/api/remux" && method == "GET") {
			SendJson(socket, QJsonDocument(WebMixRemux::State()).toJson(QJsonDocument::Compact));
			return;
		}

		if (method != "POST") {
			SendError(socket, 405, "Method not allowed");
			return;
		}

		QJsonObject result = WebMixRemux::State();
		QString error;
		bool ok = true;
		int status = 200;

		if (path == "/api/remux/add") {
			QString format = QueryValue(query, "format");
			if (format.isEmpty()) {
				format = QStringLiteral("mp4");
			}

			QString id;
			QString source;
			QString target;
			bool conflict = false;
			ok = WebMixRemux::Add(QueryValue(query, "path"), format,
					      QueryValue(query, "overwrite") == QLatin1String("1"), id, source, target,
					      conflict, error);
			if (ok) {
				result["id"] = id;
				result["source"] = source;
				result["target"] = target;
			} else if (conflict) {
				/* The UI asks before replacing, like Remux.FileExists does. */
				result["source"] = source;
				result["target"] = target;
				result["conflict"] = true;
				status = 409;
			} else {
				status = 400;
			}
		} else if (path == "/api/remux/start") {
			ok = WebMixRemux::Start(error);
			if (!ok) {
				status = 400;
			}
			result = WebMixRemux::State();
		} else if (path == "/api/remux/stop") {
			WebMixRemux::Stop();
			result = WebMixRemux::State();
		} else if (path == "/api/remux/clear") {
			WebMixRemux::ClearFinished();
			result = WebMixRemux::State();
		} else if (path == "/api/remux/clearall") {
			WebMixRemux::ClearAll();
			result = WebMixRemux::State();
		} else {
			SendError(socket, 404, "Unknown remux endpoint");
			return;
		}

		result["ok"] = ok;
		if (!ok) {
			result["error"] = error;
			blog(LOG_WARNING, "[WebMIX] %s failed: %s", qUtf8Printable(path), qUtf8Printable(error));
		}
		SendJson(socket, QJsonDocument(result).toJson(QJsonDocument::Compact), status);
		return;
	}

	/* --- Settings > General: starting with the computer --------------------- */
	if (path == "/api/startup") {
		config_t *appConfig = App()->GetAppConfig();
		QString error;
		bool ok = true;
		if (method == "POST") {
			const QJsonObject requestData =
				QJsonDocument::fromJson(request.mid(request.indexOf("\r\n\r\n") + 4)).object();
			if (requestData.contains("autostart")) {
				/* The entry serves where this instance serves now. */
				ok = WebMixStartup::SetAutostart(requestData.value("autostart").toBool(),
								 server->serverAddress().toString(),
								 server->serverPort(), error);
			}
			if (ok && requestData.contains("openBrowser")) {
				config_set_bool(appConfig, "General", "WebOpenBrowser",
						requestData.value("openBrowser").toBool());
				ok = config_save_safe(appConfig, "tmp", nullptr) == CONFIG_SUCCESS;
				if (!ok) {
					error = QStringLiteral("Could not save global.ini.");
				}
			}
		} else if (method != "GET" && method != "HEAD") {
			SendError(socket, 405, "Method not allowed");
			return;
		}

		QJsonObject state;
		state["ok"] = ok;
		if (!ok) {
			state["error"] = error;
			blog(LOG_WARNING, "[WebMIX] /api/startup failed: %s", qUtf8Printable(error));
		}
		state["autostartSupported"] = WebMixStartup::AutostartSupported();
		state["autostart"] = WebMixStartup::AutostartEnabled();
		/* --no-browser for every launch; the command-line flag still wins. */
		state["openBrowser"] = config_get_bool(appConfig, "General", "WebOpenBrowser");
		state["address"] =
			QStringLiteral("%1:%2").arg(server->serverAddress().toString()).arg(server->serverPort());
		SendJson(socket, QJsonDocument(state).toJson(QJsonDocument::Compact), ok ? 200 : 400);
		return;
	}

	/* --- Tools > WebSocket Server Settings (WebMixWebSocket) --------------- */
	if (path == "/api/websocket" || path == "/api/websocket/kick") {
		if (path == "/api/websocket" && (method == "GET" || method == "HEAD")) {
			const QJsonObject state =
				WebMixWebSocket::State(QueryValue(query, "connect") == QLatin1String("1"));
			SendJson(socket, QJsonDocument(state).toJson(QJsonDocument::Compact));
			return;
		}
		if (method != "POST") {
			SendError(socket, 405, "Method not allowed");
			return;
		}

		const QJsonObject requestData =
			QJsonDocument::fromJson(request.mid(request.indexOf("\r\n\r\n") + 4)).object();
		QString error;
		const bool ok = path == "/api/websocket"
					? WebMixWebSocket::Apply(requestData, error)
					: WebMixWebSocket::Kick(requestData.value("address").toString(), error);

		QJsonObject result = WebMixWebSocket::State(false);
		result["ok"] = ok;
		if (!ok) {
			result["error"] = error;
			blog(LOG_WARNING, "[WebMIX] %s failed: %s", qUtf8Printable(path), qUtf8Printable(error));
		}
		SendJson(socket, QJsonDocument(result).toJson(QJsonDocument::Compact), ok ? 200 : 400);
		return;
	}

	/* --- operations obs-websocket has no request for ----------------------- */
	if (path.startsWith("/api/hotkeys") || path.startsWith("/api/scenes/") ||
	    path.startsWith("/api/transitions/")) {
		if (path == "/api/hotkeys" && method == "GET") {
			QJsonObject payload;
			payload["hotkeys"] = WebMixBridge::Hotkeys();
			SendJson(socket, QJsonDocument(payload).toJson(QJsonDocument::Compact));
			return;
		}

		if (method != "POST") {
			SendError(socket, 405, "Method not allowed");
			return;
		}

		QString error;
		bool ok = false;
		if (path == "/api/hotkeys/bind") {
			ok = WebMixBridge::SetHotkeyBinding(QueryValue(query, "name"), QueryValue(query, "key"),
							    QueryValue(query, "modifiers"), error);
		} else if (path == "/api/hotkeys/clear") {
			ok = WebMixBridge::ClearHotkeyBinding(QueryValue(query, "name"), error);
		} else if (path == "/api/scenes/move") {
			ok = WebMixBridge::MoveScene(QueryValue(query, "from").toInt(), QueryValue(query, "to").toInt(),
						     error);
		} else if (path == "/api/transitions/add") {
			ok = WebMixBridge::AddTransition(QueryValue(query, "kind"), QueryValue(query, "name"), error);
		} else if (path == "/api/transitions/rename") {
			ok = WebMixBridge::RenameTransition(QueryValue(query, "name"), QueryValue(query, "newName"),
							    error);
		} else if (path == "/api/transitions/remove") {
			ok = WebMixBridge::RemoveTransition(QueryValue(query, "name"), error);
		} else {
			SendError(socket, 404, "Unknown endpoint");
			return;
		}

		QJsonObject result;
		result["ok"] = ok;
		if (!ok) {
			result["error"] = error;
			blog(LOG_WARNING, "[WebMIX] %s failed: %s", qUtf8Printable(path), qUtf8Printable(error));
		}
		SendJson(socket, QJsonDocument(result).toJson(QJsonDocument::Compact), ok ? 200 : 400);
		return;
	}

	/* --- property schema (the WebMIX bridge) ------------------------------- */
	if (path == "/api/properties/press" && method == "POST") {
		QString error;
		const bool ok = WebMixBridge::PressButton(QueryValue(query, "scope"), QueryValue(query, "name"),
							  QueryValue(query, "filter"), QueryValue(query, "property"),
							  error);
		QJsonObject result;
		result["ok"] = ok;
		if (!ok) {
			result["error"] = error;
		}
		SendJson(socket, QJsonDocument(result).toJson(QJsonDocument::Compact), ok ? 200 : 400);
		return;
	}

	if (path.startsWith("/api/properties/")) {
		QJsonObject result;
		if (path == "/api/properties/source") {
			result = WebMixBridge::SourceProperties(QueryValue(query, "name"));
		} else if (path == "/api/properties/filter") {
			result = WebMixBridge::FilterProperties(QueryValue(query, "source"),
								QueryValue(query, "filter"));
		} else if (path == "/api/properties/transition") {
			result = WebMixBridge::TransitionProperties(QueryValue(query, "name"));
		} else {
			SendError(socket, 404, "Unknown properties endpoint");
			return;
		}
		if (result.contains("error")) {
			blog(LOG_WARNING, "[WebMIX] %s: %s", qUtf8Printable(path),
			     qUtf8Printable(result.value("error").toString()));
			SendJson(socket, QJsonDocument(result).toJson(QJsonDocument::Compact), 404);
			return;
		}
		SendJson(socket, QJsonDocument(result).toJson(QJsonDocument::Compact));
		return;
	}

	/* --- control endpoints ------------------------------------------------- */
	if (method == "POST" && path == "/api/shutdown") {
		/* Stopping mid-remux leaves a partial file, so the UI has to ask
		 * first and then say so explicitly. */
		const int activeRemux = WebMixRemux::ActiveCount();
		if (activeRemux > 0 && QueryValue(query, "force") != QLatin1String("1")) {
			QJsonObject result;
			result["ok"] = false;
			result["activeRemux"] = activeRemux;
			result["error"] = "a remux is in progress";
			SendJson(socket, QJsonDocument(result).toJson(QJsonDocument::Compact), 409);
			return;
		}

		blog(LOG_WARNING, "[WebMIX] Shutdown requested from the web interface");
		SendJson(socket, R"({"ok":true,"message":"OBS is shutting down"})");
		QTimer::singleShot(150, qApp, []() { QCoreApplication::quit(); });
		return;
	}

	if (path == "/api/status") {
		QJsonObject status;
		status["webmix"] = true;
		status["web"] = true;
		status["webRoot"] = webRoot;
		status["version"] = QString::fromUtf8(obs_get_version_string());
		/* The native control channel: the page talks to libobs directly,
		 * with no obs-websocket and no second port. */
		status["obsControl"] = true;
		status["obsRequestEndpoint"] = QStringLiteral("/api/obs/request");
		status["obsEventEndpoint"] = QStringLiteral("/api/obs/events");
		status["obsRequestTypes"] = WebMixControl::RequestTypes().size();
		status["obsEventStreams"] = eventStreams.size();
		/* Preview frames delivered so far: the page samples this twice to
		 * report the rate it is really getting, which it cannot see itself. */
		status["previewFrames"] = static_cast<double>(WebMixPreview::FramesSent());
		status["preview"] = WebMixPreview::Stats();
		/* The page uses this to ask for the program output itself. */
		status["previewProgram"] = true;
		status["shutdownEndpoint"] = true;
		status["propertySchema"] = true;
		status["previewStream"] = true;
		status["multiview"] = true;
		status["operations"] = true;
		status["fileAccess"] = true;
		status["remux"] = true;
		SendJson(socket, QJsonDocument(status).toJson(QJsonDocument::Compact));
		return;
	}

	/* The browser frontend reads this to prefill the connection form. */
	if (path == "/obs-config.json") {
		QJsonObject config;
		const QString configPath = ObsWebSocketConfigPath();
		QFile file(configPath);
		bool loaded = false;

		if (!configPath.isEmpty() && file.open(QIODevice::ReadOnly)) {
			const QJsonDocument document = QJsonDocument::fromJson(file.readAll());
			if (document.isObject()) {
				const QJsonObject source = document.object();
				config["available"] = true;
				config["server_enabled"] = source.value("server_enabled").toBool(false);
				config["server_port"] = source.value("server_port").toInt(4455);
				config["server_password"] = source.value("server_password").toString();
				config["auth_required"] = source.value("auth_required").toBool(true);
				loaded = true;
			}
		}
		if (!loaded) {
			config["available"] = false;
			config["reason"] = "obs-websocket config not found";
		}
		SendJson(socket, QJsonDocument(config).toJson(QJsonDocument::Compact));
		return;
	}

	/* --- static files ------------------------------------------------------ */
	if (method != "GET" && method != "HEAD") {
		SendError(socket, 405, "Method not allowed");
		return;
	}

	QString relative = path;
	if (relative == "/" || relative.isEmpty()) {
		relative = "/index.html";
	}

	/* Reject traversal outright (percent-decoded, so encoded attempts are
	 * caught too) and then, as a second line of defence, require the resolved
	 * path to stay inside the web root. */
	const QString decoded = QUrl::fromPercentEncoding(relative.toUtf8());
	if (decoded.contains(QLatin1String("..")) || decoded.contains(QLatin1Char('\\'))) {
		SendError(socket, 403, "Forbidden");
		return;
	}

	const QString resolved = QDir(webRoot).absoluteFilePath(decoded.mid(1));
	const QString canonicalRoot = QDir(webRoot).canonicalPath();
	const QFileInfo info(resolved);
	const QString canonical = info.exists() ? info.canonicalFilePath() : resolved;

	if (!canonical.startsWith(canonicalRoot + "/") && canonical != canonicalRoot) {
		SendError(socket, 403, "Forbidden");
		return;
	}
	if (!info.exists() || !info.isFile()) {
		/* Single-page app: unknown paths fall back to the shell. */
		SendFile(socket, webRoot + "/index.html");
		return;
	}
	SendFile(socket, canonical);
}

/* --------------------------------------------------------------- sign-in -- */

QJsonObject WebMixServer::AccessState(const WebMixAuth::Client &client) const
{
	QJsonObject state;
	state["configured"] = WebMixAuth::Configured();
	state["username"] = WebMixAuth::Username();
	state["sessions"] = WebMixAuth::SessionCount();
	state["minPasswordLength"] = WebMixAuth::MinPasswordLength();
	state["local"] = client.local;
	state["user"] = client.user;
	/* Whether anybody else can reach the interface at all. */
	state["network"] = server && !server->serverAddress().isLoopback();
	state["port"] = server ? static_cast<int>(server->serverPort()) : 0;
	return state;
}

void WebMixServer::HandleAuth(QTcpSocket *socket, const QByteArray &method, const QString &path, const QByteArray &body,
			      const WebMixAuth::Client &client)
{
	const auto json = [](const QJsonObject &object) {
		return QJsonDocument(object).toJson(QJsonDocument::Compact);
	};

	/* What the sign-in page needs to know; open to everybody, and naming
	 * nobody but the caller. */
	if (path == "/api/auth/status") {
		QJsonObject status;
		status["local"] = client.local;
		status["authorized"] = client.Authorized();
		status["user"] = client.user;
		status["configured"] = WebMixAuth::Configured();
		SendJson(socket, json(status));
		return;
	}

	if (path == "/api/auth/config" && (method == "GET" || method == "HEAD")) {
		if (!client.Authorized()) {
			SendJson(socket, R"({"ok":false,"error":"Sign-in required"})", 401);
			return;
		}
		SendJson(socket, json(AccessState(client)));
		return;
	}

	if (method != "POST") {
		SendError(socket, 405, "Method not allowed");
		return;
	}

	const QJsonObject request = QJsonDocument::fromJson(body).object();

	if (path == "/api/auth/login") {
		QString token;
		int retryAfter = 0;
		const WebMixAuth::LoginResult outcome = WebMixAuth::Login(client, request.value("username").toString(),
									  request.value("password").toString(), token,
									  retryAfter);

		QJsonObject result;
		result["ok"] = outcome == WebMixAuth::LoginResult::Ok;
		if (retryAfter > 0) {
			result["retryAfter"] = retryAfter;
		}
		switch (outcome) {
		case WebMixAuth::LoginResult::Ok:
			result["user"] = request.value("username").toString();
			SendJson(socket, json(result), 200, "Set-Cookie: " + WebMixAuth::SessionCookie(token) + "\r\n");
			return;
		case WebMixAuth::LoginResult::NotConfigured:
			result["error"] = QStringLiteral("not-configured");
			SendJson(socket, json(result), 403);
			return;
		case WebMixAuth::LoginResult::Throttled:
			result["error"] = QStringLiteral("throttled");
			SendJson(socket, json(result), 429, "Retry-After: " + QByteArray::number(retryAfter) + "\r\n");
			return;
		case WebMixAuth::LoginResult::Invalid:
			result["error"] = QStringLiteral("invalid");
			SendJson(socket, json(result), 401);
			return;
		}
		return;
	}

	if (path == "/api/auth/logout") {
		WebMixAuth::Logout(client.token);
		SendJson(socket, R"({"ok":true})", 200, "Set-Cookie: " + WebMixAuth::ExpiredCookie() + "\r\n");
		return;
	}

	if (path == "/api/auth/config") {
		if (!client.Authorized()) {
			SendJson(socket, R"({"ok":false,"error":"Sign-in required"})", 401);
			return;
		}

		QString error;
		bool ok = true;
		if (request.value("remove").toBool()) {
			/* Only from this machine: a browser elsewhere would be locking
			 * every other one out, itself included once it signs out. */
			if (!client.local) {
				ok = false;
				error = QStringLiteral("remote-remove");
			} else {
				WebMixAuth::ClearCredentials();
			}
		} else {
			ok = WebMixAuth::SetCredentials(request.value("username").toString(),
							request.value("password").toString(), client.token, error);
		}

		/* The caller's own session survives a change; re-read it so the
		 * reply names the new user. */
		WebMixAuth::Client after = client;
		if (!client.token.isEmpty() && ok) {
			after.user = request.value("remove").toBool() ? QString() : WebMixAuth::Username();
		}
		QJsonObject result = AccessState(after);
		result["ok"] = ok;
		if (!ok) {
			result["error"] = error;
		}
		SendJson(socket, json(result), ok ? 200 : 400);
		return;
	}

	SendError(socket, 404, "Unknown sign-in endpoint");
}

/* ------------------------------------------------------- control channel -- */

void WebMixServer::HandleObsRequest(QTcpSocket *socket, const QByteArray &body)
{
	const QJsonDocument document = QJsonDocument::fromJson(body);
	if (!document.isObject()) {
		SendError(socket, 400, "Expected a JSON object");
		return;
	}
	const QJsonObject root = document.object();
	const QString requestType = root.value(QStringLiteral("requestType")).toString();
	if (requestType.isEmpty()) {
		SendError(socket, 400, "Missing requestType");
		return;
	}

	const WebMixControl::Response response =
		WebMixControl::Request(requestType, root.value(QStringLiteral("requestData")).toObject());

	QJsonObject status;
	status["result"] = response.ok;
	status["code"] = response.code;
	if (!response.comment.isEmpty()) {
		status["comment"] = response.comment;
	}

	QJsonObject result;
	result["requestType"] = requestType;
	result["requestStatus"] = status;
	result["responseData"] = response.data;

	/* A refused request is still an HTTP success: the outcome lives in
	 * `requestStatus`, exactly as it did on the protocol the frontend was
	 * written against, so the client needs no transport-specific error path. */
	SendJson(socket, QJsonDocument(result).toJson(QJsonDocument::Compact));
}

void WebMixServer::HandleObsBatch(QTcpSocket *socket, const QByteArray &body)
{
	const QJsonDocument document = QJsonDocument::fromJson(body);
	if (!document.isObject()) {
		SendError(socket, 400, "Expected a JSON object");
		return;
	}
	const QJsonObject root = document.object();
	const QJsonArray requests = root.value(QStringLiteral("requests")).toArray();
	if (requests.isEmpty()) {
		SendError(socket, 400, "A batch needs at least one request");
		return;
	}
	/* The frontend batches per-input audio reads; a runaway list would block
	 * the main thread for the whole round trip. */
	if (requests.size() > 512) {
		SendError(socket, 413, "Batch too large");
		return;
	}

	QJsonArray results;
	for (const QJsonValue &value : requests) {
		const QJsonObject request = value.toObject();
		const QString requestType = request.value(QStringLiteral("requestType")).toString();

		QJsonObject status;
		QJsonObject responseData;
		if (requestType.isEmpty()) {
			status["result"] = false;
			status["code"] = WebMixControl::Status::MissingRequestData;
			status["comment"] = QStringLiteral("Missing requestType");
		} else {
			const WebMixControl::Response response = WebMixControl::Request(
				requestType, request.value(QStringLiteral("requestData")).toObject());
			status["result"] = response.ok;
			status["code"] = response.code;
			if (!response.comment.isEmpty()) {
				status["comment"] = response.comment;
			}
			responseData = response.data;
		}

		QJsonObject entry;
		entry["requestType"] = requestType;
		entry["requestStatus"] = status;
		entry["responseData"] = responseData;
		results.append(entry);
	}

	QJsonObject payload;
	payload["results"] = results;
	SendJson(socket, QJsonDocument(payload).toJson(QJsonDocument::Compact));
}

void WebMixServer::OpenEventStream(QTcpSocket *socket, const QString &intents)
{
	/* From here on the socket is an event stream, not a request: stop reading
	 * it, or the next byte would be parsed as another request. */
	disconnect(socket, &QTcpSocket::readyRead, nullptr, nullptr);

	int subscribed = WebMixControl::Intent::All | WebMixControl::Intent::InputVolumeMeters |
			 WebMixControl::Intent::InputActiveStateChanged | WebMixControl::Intent::InputShowStateChanged |
			 WebMixControl::Intent::SceneItemTransformChanged;
	if (!intents.isEmpty()) {
		bool ok = false;
		const int parsed = intents.toInt(&ok);
		if (ok) {
			subscribed = parsed;
		}
	}

	QByteArray header;
	header += "HTTP/1.1 200 OK\r\n";
	header += "Content-Type: text/event-stream; charset=utf-8\r\n";
	header += "Cache-Control: no-store\r\n";
	header += "Connection: keep-alive\r\n";
	/* Ask reverse proxies not to buffer: the whole point is live events. */
	header += "X-Accel-Buffering: no\r\n\r\n";
	socket->write(header);
	socket->write(": webmix control stream\n\n");
	socket->flush();

	const quint64 token = WebMixControl::Subscribe(
		[socket](const QString &eventType, const QJsonObject &eventData, int intent) {
			QJsonObject frame;
			frame["eventType"] = eventType;
			frame["eventIntent"] = intent;
			frame["eventData"] = eventData;
			const QByteArray payload =
				"data: " + QJsonDocument(frame).toJson(QJsonDocument::Compact) + "\n\n";

			/* A slow reader must not turn meters into unbounded memory:
			 * everything is time-sensitive, so drop the newest frame
			 * rather than queueing megabytes of stale levels. */
			if (socket->bytesToWrite() > 512 * 1024 &&
			    (intent == WebMixControl::Intent::InputVolumeMeters ||
			     intent == WebMixControl::Intent::SceneItemTransformChanged)) {
				return;
			}
			socket->write(payload);
		},
		subscribed);

	eventStreams.insert(socket, token);
	blog(LOG_INFO, "[WebMIX] Event stream opened (%lld active)", (long long)eventStreams.size());

	/* The connection outlives the request, so it needs its own teardown. */
	connect(socket, &QTcpSocket::disconnected, this, [this, socket]() { CloseEventStream(socket); });
}

void WebMixServer::CloseEventStream(QTcpSocket *socket)
{
	const auto entry = eventStreams.find(socket);
	if (entry == eventStreams.end()) {
		return;
	}
	WebMixControl::Unsubscribe(entry.value());
	eventStreams.erase(entry);
	blog(LOG_INFO, "[WebMIX] Event stream closed (%lld still active)", (long long)eventStreams.size());
}

void WebMixServer::PingEventStreams()
{
	if (eventStreams.isEmpty()) {
		return;
	}
	/* A comment line keeps intermediaries from closing an idle stream. */
	const QByteArray ping = ": ping\n\n";
	for (QTcpSocket *socket : eventStreams.keys()) {
		if (!socket) {
			continue;
		}
		/* A peer that vanished without closing (a killed browser, a suspended
		 * machine) never emits disconnected, and the entry would sit here
		 * forever. The keep-alive is the natural place to notice and drop it. */
		if (socket->state() != QAbstractSocket::ConnectedState) {
			CloseEventStream(socket);
			socket->deleteLater();
			continue;
		}
		socket->write(ping);
	}
}

void WebMixServer::SendFile(QTcpSocket *socket, const QString &path, int status)
{
	QFile file(path);
	if (!file.open(QIODevice::ReadOnly)) {
		SendError(socket, 404, "Not found");
		return;
	}
	const QByteArray body = file.readAll();
	const QFileInfo info(path);
	const char *type = MimeForSuffix(info.suffix().toLower());

	QByteArray header;
	header += "HTTP/1.1 " + QByteArray::number(status) + " OK\r\n";
	header += QByteArray("Content-Type: ") + type + "\r\n";
	header += "Content-Length: " + QByteArray::number(body.size()) + "\r\n";
	header += "Cache-Control: no-cache\r\n";
	header += "Connection: close\r\n\r\n";

	socket->write(header);
	socket->write(body);
	socket->disconnectFromHost();
}

void WebMixServer::SendJson(QTcpSocket *socket, const QByteArray &json, int status, const QByteArray &headers)
{
	QByteArray header;
	header += "HTTP/1.1 " + QByteArray::number(status) + " OK\r\n";
	header += "Content-Type: application/json; charset=utf-8\r\n";
	header += "Content-Length: " + QByteArray::number(json.size()) + "\r\n";
	header += "Cache-Control: no-store\r\n";
	header += headers;
	header += "Connection: close\r\n\r\n";

	socket->write(header);
	socket->write(json);
	socket->disconnectFromHost();
}

void WebMixServer::SendRedirect(QTcpSocket *socket, const QByteArray &location)
{
	QByteArray header;
	header += "HTTP/1.1 303 See Other\r\n";
	header += "Location: " + location + "\r\n";
	header += "Content-Length: 0\r\n";
	header += "Cache-Control: no-store\r\n";
	header += "Connection: close\r\n\r\n";

	socket->write(header);
	socket->disconnectFromHost();
}

void WebMixServer::SendText(QTcpSocket *socket, const QString &text, int status, const char *type)
{
	const QByteArray body = text.toUtf8();
	QByteArray header;
	header += "HTTP/1.1 " + QByteArray::number(status) + " OK\r\n";
	header += QByteArray("Content-Type: ") + type + "\r\n";
	header += "Content-Length: " + QByteArray::number(body.size()) + "\r\n";
	header += "Connection: close\r\n\r\n";

	socket->write(header);
	socket->write(body);
	socket->disconnectFromHost();
}

void WebMixServer::SendError(QTcpSocket *socket, int status, const QString &reason)
{
	SendText(socket, reason, status);
}
