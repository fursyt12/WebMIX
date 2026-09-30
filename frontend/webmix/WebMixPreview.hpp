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
#include <QImage>
#include <QObject>
#include <QString>
#include <QStringList>

class QTcpSocket;
class QTimer;

/* WebMIX: live preview frames for the browser.
 *
 * obs-websocket can only take single screenshots (`GetSourceScreenshot`), which
 * costs a websocket round-trip and a base64 data URL per frame.  These helpers
 * render a source directly in the OBS process and stream JPEG frames over one
 * HTTP connection (`multipart/x-mixed-replace`), which the web UI feeds into a
 * WebGPU texture.  The capture path mirrors obs-websocket's screenshot code. */
namespace WebMixPreview {

/*! Render a source/scene into an RGBA image. Sets `ok` on success. */
QImage CaptureSource(const QString &sourceName, uint32_t width, uint32_t height, bool &ok);

/*!
 * Compose a grid of scenes into one image, like OBS's Multiview: every scene in
 * a tile, with the program scene outlined. An empty `sceneNames` uses the
 * current scene list in display order.
 */
QImage CaptureMultiview(const QStringList &sceneNames, uint32_t width, uint32_t height, bool &ok);

/*! Current scene names in display order (top of the OBS list first). */
QStringList SceneNamesInDisplayOrder();

/*! Encode an image as JPEG; returns an empty array when the plugin is missing. */
QByteArray EncodeJpeg(const QImage &image, int quality);

/*! Number of running streams, to bound the cost of many open tabs. */
int ActiveStreams();

/*!
 * Streams JPEG frames for one source to one socket.
 *
 * Writes the multipart headers immediately and then one part per tick.  The
 * stream stops when the client disconnects, the source disappears or the
 * connection errors out.
 */
class Stream : public QObject {
	Q_OBJECT

public:
	/** What a stream renders: one source, or the scene grid. */
	enum class Mode { Source, Multiview };

	Stream(QTcpSocket *socket, QString sourceName, int width, int height, int fps, int quality,
	       QObject *parent = nullptr, Mode mode = Mode::Source);

	/*! Send the response headers and start ticking. */
	void Start();

	/*! Maximum number of concurrent streams. */
	static constexpr int kMaxStreams = 4;

private:
	void Tick();

	QTcpSocket *socket;
	QString sourceName;
	int width;
	int height;
	int fps;
	int quality;
	QTimer *timer = nullptr;
	bool started = false;
	Mode mode = Mode::Source;
	QImage lastFrame;
};

} // namespace WebMixPreview
