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
#include <QJsonObject>
#include <QObject>
#include <QPointer>
#include <QString>
#include <QStringList>

#include <memory>

class QTcpSocket;

/* WebMIX: live preview frames for the browser.
 *
 * Frames are produced where OBS produces its own: on the graphics thread, right
 * after the program has been rendered.  The picture is drawn into a small
 * texture that is kept between frames, read back and JPEG-encoded on a worker
 * thread, and handed to the Qt main thread only to be written to the sockets
 * (`multipart/x-mixed-replace`, one JPEG per part).
 *
 * Three properties follow from that split, and they are the point of it:
 *
 *  - The main thread never renders, never waits for the GPU and never encodes,
 *    so the control channel it also serves stays responsive.
 *  - A frame is only made when a client can take it.  A socket that still has
 *    bytes queued skips the frame instead of queueing another one, so a slow
 *    reader costs neither memory nor latency - it just sees fewer frames.
 *  - The program pane is the program texture OBS already rendered (transitions
 *    included), so showing it costs one scaled blit, not a second render. */
namespace WebMixPreview {

/*! Render a source/scene into an RGBA image, once. Sets `ok` on success.
 *  For single frames (screenshots, checks); streams do not go through here. */
QImage CaptureSource(const QString &sourceName, uint32_t width, uint32_t height, bool &ok);

/*!
 * Compose a grid of scenes into one image, like OBS's Multiview: every scene in
 * a tile, with the program scene outlined. An empty `sceneNames` uses the
 * current scene list in display order.
 */
QImage CaptureMultiview(const QStringList &sceneNames, uint32_t width, uint32_t height, bool &ok);

/*! Current scene names in display order (top of the OBS list first). */
QStringList SceneNamesInDisplayOrder();

/*! Encode an image as JPEG; returns an empty array on failure. */
QByteArray EncodeJpeg(const QImage &image, int quality);

/*! Number of open streams, to bound the cost of many open tabs. */
int ActiveStreams();

/*! Frames written to every preview client since start. */
quint64 FramesSent();

/*! What the pipeline is doing, for `/api/status` and for "why is it slow?". */
QJsonObject Stats();

/*! Stop every capture and release its GPU resources. Safe to call twice; must
 *  run before libobs shuts down. */
void Shutdown();

/*! One picture a client asked for. Streams asking for the same picture share
 *  the render, the read-back and the encode. */
struct Target {
	enum class Kind {
		Program,   /*!< the program output, as rendered (transitions included) */
		Source,    /*!< one source or scene, by name */
		Multiview, /*!< every scene in a grid */
	};

	Kind kind = Kind::Source;
	QString source;
	QStringList scenes;
	uint32_t width = 0;
	uint32_t height = 0;
	int fps = 30;
	int quality = 80;

	QString Key() const;
};

class Capture;

/*!
 * One client of a capture: writes the multipart headers, then each frame the
 * socket has room for.  Ends when the client disconnects.
 */
class Stream : public QObject {
	Q_OBJECT

public:
	Stream(QTcpSocket *socket, Target target, QObject *parent = nullptr);
	~Stream() override;

	/*! Send the response headers and subscribe to the capture. */
	void Start();

	/*! Write one multipart part, unless the previous one is still queued. */
	bool Send(const QByteArray &part);

	/*! Whether the socket could take a frame right now. */
	bool Ready() const;

	/*! Maximum number of concurrent streams. */
	static constexpr int kMaxStreams = 8;

private:
	void Detach();

	QPointer<QTcpSocket> socket;
	Target target;
	std::shared_ptr<Capture> capture;
	bool started = false;
	bool detached = false;
};

} // namespace WebMixPreview
