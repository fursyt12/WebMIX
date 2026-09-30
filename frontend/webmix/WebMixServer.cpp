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

#include "WebMixBridge.hpp"
#include "WebMixPreview.hpp"
#include "WebMixRemux.hpp"

#include "OBSApp.hpp"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QJsonDocument>
#include <QJsonObject>
#include <QImage>
#include <QMetaObject>
#include <QSharedPointer>
#include <QUrlQuery>
#include <QTcpServer>
#include <QTcpSocket>
#include <QUrl>
#include <QTimer>

#include <obs.hpp>
#include <util/platform.h>

#include <utility>

extern bool web_mode;

namespace {

constexpr int kMaxRequestBytes = 16 * 1024;

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
	candidates << appDir + "/../share/obs-studio/web";
	candidates << appDir + "/data/web";

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

	url = QStringLiteral("http://%1:%2/").arg(address.toString()).arg(server->serverPort());

	/* The UI is unauthenticated by design (it is a local control surface) and
	 * it has to hand the browser the obs-websocket password, so binding beyond
	 * loopback exposes both control of OBS and read access to itsconfig
	 * directory to anyone who can reach the port. */
	if (!address.isLoopback()) {
		blog(LOG_WARNING, "[WebMIX] ---------------------------------------------------------------");
		blog(LOG_WARNING, "[WebMIX] The web interface is reachable from the network (%s).",
		     qUtf8Printable(address.toString()));
		blog(LOG_WARNING, "[WebMIX] It is not authenticated and exposes the obs-websocket password, so anyone "
				  "who can reach this port can control OBS. Use it only on a trusted network, or put a "
				  "reverse proxy with authentication in front of it.");
		blog(LOG_WARNING, "[WebMIX] ---------------------------------------------------------------");
	}
	blog(LOG_INFO, "[WebMIX] ---------------------------------------------------------------");
	blog(LOG_INFO, "[WebMIX] Web interface: %s", qUtf8Printable(url));
	blog(LOG_INFO, "[WebMIX] Serving files from: %s", qUtf8Printable(webRoot));
	blog(LOG_INFO, "[WebMIX] The OBS window is hidden; use the web interface to control OBS.");
	blog(LOG_INFO, "[WebMIX] ---------------------------------------------------------------");
	return true;
}

void WebMixServer::Stop()
{
	/* A remux runs on its own thread and must not outlive libobs. */
	WebMixRemux::Shutdown();

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

	/* --- live preview frames ------------------------------------------------ */
	if (path == "/api/preview.mjpg" || path == "/api/preview.jpg" || path == "/api/preview/multiview.mjpg" ||
	    path == "/api/preview/multiview.jpg") {
		const bool multiview = path.contains(QLatin1String("multiview"));
		const bool singleFrame = path.endsWith(QLatin1String(".jpg"));
		const QString source = query.queryItemValue("source");

		if (!multiview && source.isEmpty()) {
			SendError(socket, 400, "Missing source");
			return;
		}

		/* Multiview defaults to a 16:9 grid; a single source uses its own size
		 * when no dimensions are given. */
		int width = query.queryItemValue("width").toInt();
		int height = query.queryItemValue("height").toInt();
		if (multiview && (width <= 0 || height <= 0)) {
			width = 1280;
			height = 720;
		}
		const int quality = qBound(1, query.queryItemValue("quality").toInt() ?: 75, 100);

		/* A caller may pin the tile order (and selection) explicitly. */
		QStringList sceneList;
		const QString scenes = query.queryItemValue("scenes");
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

		const int fps = qBound(1, query.queryItemValue("fps").toInt() ?: 15, 60);
		/* The stream owns the socket from here on. */
		disconnect(socket, nullptr, this, nullptr);
		auto *stream = new WebMixPreview::Stream(socket, source, width, height, fps, quality, this,
							 multiview ? WebMixPreview::Stream::Mode::Multiview
								   : WebMixPreview::Stream::Mode::Source);
		stream->Start();
		return;
	}

	if (path == "/api/encoders") {
		SendJson(socket, QJsonDocument(WebMixBridge::EncoderOptions()).toJson(QJsonDocument::Compact));
		return;
	}

	/* --- file access (recordings, logs, settings) -------------------------- */
	if (path == "/api/files/list") {
		const QString kind = query.queryItemValue("kind");
		QJsonObject listing = WebMixBridge::ListDirectory(kind, query.queryItemValue("path"));
		if (listing.contains("error")) {
			SendJson(socket, QJsonDocument(listing).toJson(QJsonDocument::Compact), 400);
			return;
		}
		SendJson(socket, QJsonDocument(listing).toJson(QJsonDocument::Compact));
		return;
	}

	if (path == "/api/files/text") {
		const QString kind = query.queryItemValue("kind");
		const QString file = query.queryItemValue("path");
		QString text;
		QString error;
		const int limit = query.queryItemValue("limit").toInt() ?: (128 * 1024);
		if (!WebMixBridge::ReadTextTail(kind, file, limit, text, error)) {
			SendError(socket, 404, error);
			return;
		}
		SendText(socket, text);
		return;
	}

	if (path == "/api/files/download") {
		const QString kind = query.queryItemValue("kind");
		const QString name = query.queryItemValue("path");
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
			QString format = query.queryItemValue("format");
			if (format.isEmpty()) {
				format = QStringLiteral("mp4");
			}

			QString id;
			QString source;
			QString target;
			bool conflict = false;
			ok = WebMixRemux::Add(query.queryItemValue("path"), format,
					      query.queryItemValue("overwrite") == QLatin1String("1"), id, source,
					      target, conflict, error);
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
			ok = WebMixBridge::SetHotkeyBinding(query.queryItemValue("name"), query.queryItemValue("key"),
							    query.queryItemValue("modifiers"), error);
		} else if (path == "/api/hotkeys/clear") {
			ok = WebMixBridge::ClearHotkeyBinding(query.queryItemValue("name"), error);
		} else if (path == "/api/scenes/move") {
			ok = WebMixBridge::MoveScene(query.queryItemValue("from").toInt(),
						     query.queryItemValue("to").toInt(), error);
		} else if (path == "/api/transitions/add") {
			ok = WebMixBridge::AddTransition(query.queryItemValue("kind"), query.queryItemValue("name"),
							 error);
		} else if (path == "/api/transitions/rename") {
			ok = WebMixBridge::RenameTransition(query.queryItemValue("name"),
							    query.queryItemValue("newName"), error);
		} else if (path == "/api/transitions/remove") {
			ok = WebMixBridge::RemoveTransition(query.queryItemValue("name"), error);
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
		const bool ok = WebMixBridge::PressButton(query.queryItemValue("scope"), query.queryItemValue("name"),
							  query.queryItemValue("filter"),
							  query.queryItemValue("property"), error);
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
			result = WebMixBridge::SourceProperties(query.queryItemValue("name"));
		} else if (path == "/api/properties/filter") {
			result = WebMixBridge::FilterProperties(query.queryItemValue("source"),
								query.queryItemValue("filter"));
		} else if (path == "/api/properties/transition") {
			result = WebMixBridge::TransitionProperties(query.queryItemValue("name"));
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
		if (activeRemux > 0 && query.queryItemValue("force") != QLatin1String("1")) {
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

void WebMixServer::SendJson(QTcpSocket *socket, const QByteArray &json, int status)
{
	QByteArray header;
	header += "HTTP/1.1 " + QByteArray::number(status) + " OK\r\n";
	header += "Content-Type: application/json; charset=utf-8\r\n";
	header += "Content-Length: " + QByteArray::number(json.size()) + "\r\n";
	header += "Cache-Control: no-store\r\n";
	header += "Connection: close\r\n\r\n";

	socket->write(header);
	socket->write(json);
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
