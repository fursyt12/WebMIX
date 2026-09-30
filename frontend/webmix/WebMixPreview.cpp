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

#include "WebMixPreview.hpp"

#include <QBuffer>
#include <QTcpSocket>
#include <QTimer>

#include <obs.hpp>
#include <graphics/graphics.h>
#include <util/platform.h>

#include <string.h>

namespace WebMixPreview {

namespace {

int activeStreams = 0;

} // namespace

int ActiveStreams()
{
	return activeStreams;
}

QImage CaptureSource(const QString &sourceName, uint32_t width, uint32_t height, bool &ok)
{
	ok = false;

	OBSSourceAutoRelease source = obs_get_source_by_name(sourceName.toUtf8().constData());
	if (!source) {
		return QImage();
	}

	const uint32_t sourceWidth = obs_source_get_width(source);
	const uint32_t sourceHeight = obs_source_get_height(source);
	if (sourceWidth == 0 || sourceHeight == 0) {
		return QImage();
	}

	const double aspect = static_cast<double>(sourceWidth) / static_cast<double>(sourceHeight);

	uint32_t imgWidth = width;
	uint32_t imgHeight = height;
	if (imgWidth && !imgHeight) {
		imgHeight = static_cast<uint32_t>(imgWidth / aspect);
	} else if (imgHeight && !imgWidth) {
		imgWidth = static_cast<uint32_t>(imgHeight * aspect);
	} else if (!imgWidth && !imgHeight) {
		imgWidth = sourceWidth;
		imgHeight = sourceHeight;
	}
	if (imgWidth == 0 || imgHeight == 0) {
		return QImage();
	}

	QImage image(imgWidth, imgHeight, QImage::Format_RGBA8888);
	image.fill(0);

	obs_enter_graphics();

	gs_texrender_t *texRender = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	gs_stagesurf_t *stageSurface = gs_stagesurface_create(imgWidth, imgHeight, GS_RGBA);

	if (texRender && stageSurface) {
		gs_texrender_reset(texRender);
		if (gs_texrender_begin(texRender, imgWidth, imgHeight)) {
			vec4 background;
			vec4_zero(&background);

			gs_clear(GS_CLEAR_COLOR, &background, 0.0f, 0);
			gs_ortho(0.0f, static_cast<float>(sourceWidth), 0.0f, static_cast<float>(sourceHeight), -100.0f,
				 100.0f);

			gs_blend_state_push();
			gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);

			obs_source_inc_showing(source);
			obs_source_video_render(source);
			obs_source_dec_showing(source);

			gs_blend_state_pop();
			gs_texrender_end(texRender);

			gs_stage_texture(stageSurface, gs_texrender_get_texture(texRender));

			uint8_t *videoData = nullptr;
			uint32_t videoLinesize = 0;
			if (gs_stagesurface_map(stageSurface, &videoData, &videoLinesize)) {
				const int lineSize = image.bytesPerLine();
				for (uint32_t y = 0; y < imgHeight; y++) {
					memcpy(image.scanLine(y), videoData + (y * videoLinesize), lineSize);
				}
				gs_stagesurface_unmap(stageSurface);
				ok = true;
			}
		}
	}

	if (stageSurface) {
		gs_stagesurface_destroy(stageSurface);
	}
	if (texRender) {
		gs_texrender_destroy(texRender);
	}

	obs_leave_graphics();

	return ok ? image : QImage();
}

QByteArray EncodeJpeg(const QImage &image, int quality)
{
	if (image.isNull()) {
		return QByteArray();
	}

	QByteArray encoded;
	QBuffer buffer(&encoded);
	buffer.open(QBuffer::WriteOnly);
	if (!image.save(&buffer, "JPEG", quality)) {
		return QByteArray();
	}
	buffer.close();
	return encoded;
}

Stream::Stream(QTcpSocket *socket_, QString sourceName_, int width_, int height_, int fps_, int quality_,
	       QObject *parent)
	: QObject(parent),
	  socket(socket_),
	  sourceName(std::move(sourceName_)),
	  width(width_),
	  height(height_),
	  fps(fps_),
	  quality(quality_)
{
}

void Stream::Start()
{
	if (started || !socket) {
		return;
	}
	started = true;
	activeStreams++;

	/* multipart/x-mixed-replace is what an <img> tag and a fetch reader both
	 * understand; each part is one JPEG frame. */
	QByteArray header;
	header += "HTTP/1.1 200 OK\r\n";
	header += "Content-Type: multipart/x-mixed-replace; boundary=webmixframe\r\n";
	header += "Cache-Control: no-store, no-cache\r\n";
	header += "Pragma: no-cache\r\n";
	header += "Connection: close\r\n\r\n";
	socket->write(header);
	socket->flush();

	timer = new QTimer(this);
	connect(timer, &QTimer::timeout, this, &Stream::Tick);
	timer->start(qMax(10, 1000 / qMax(1, fps)));

	connect(socket, &QTcpSocket::disconnected, this, [this]() {
		activeStreams--;
		deleteLater();
	});

	Tick();
}

void Stream::Tick()
{
	if (!socket || socket->state() != QAbstractSocket::ConnectedState) {
		if (timer) {
			timer->stop();
		}
		return;
	}

	bool ok = false;
	const QImage frame = CaptureSource(sourceName, static_cast<uint32_t>(width), static_cast<uint32_t>(height), ok);
	if (!ok) {
		/* The source may not exist yet (or was removed); keep the connection
		 * open and retry, clients show their own placeholder. */
		return;
	}

	const QByteArray jpeg = EncodeJpeg(frame, quality);
	if (jpeg.isEmpty()) {
		return;
	}

	QByteArray part;
	part += "--webmixframe\r\n";
	part += "Content-Type: image/jpeg\r\n";
	part += "Content-Length: " + QByteArray::number(jpeg.size()) + "\r\n\r\n";
	part += jpeg;
	part += "\r\n";

	if (socket->write(part) < 0) {
		if (timer) {
			timer->stop();
		}
		return;
	}
	socket->flush();
}

} // namespace WebMixPreview
