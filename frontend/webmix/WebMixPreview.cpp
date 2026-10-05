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
#include <QStringList>

#ifdef WEBMIX_HAVE_LIBJPEG
#include <jpeglib.h>
#endif

#include <csetjmp>
#include <cstdlib>
#include <QTcpSocket>
#include <QTimer>

#include <obs-frontend-api.h>
#include <obs.hpp>
#include <graphics/graphics.h>
#include <util/platform.h>

#include <algorithm>
#include <atomic>
#include <vector>
#include <cmath>
#include <string.h>

namespace WebMixPreview {

/*! Every frame that reached a socket; see FramesSent(). */
std::atomic<uint64_t> sentFrames{0};

/* Tile colours for the multiview grid, packed for QImage::Format_RGBA8888
 * (byte order R, G, B, A in memory). */
constexpr uint32_t PackRGBA(uint8_t r, uint8_t g, uint8_t b, uint8_t a = 255)
{
	return static_cast<uint32_t>(r) | (static_cast<uint32_t>(g) << 8) | (static_cast<uint32_t>(b) << 16) |
	       (static_cast<uint32_t>(a) << 24);
}

/* Border grey, program blue and canvas background, from the OBS theme. */
constexpr uint32_t kBorderColor = PackRGBA(0x3C, 0x40, 0x4D);
constexpr uint32_t kProgramColor = PackRGBA(0x28, 0x4C, 0xB8);
constexpr uint32_t kBackgroundColor = PackRGBA(0x13, 0x14, 0x1A);

namespace {

int activeStreams = 0;

} // namespace

quint64 FramesSent()
{
	return sentFrames.load(std::memory_order_relaxed);
}

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

QStringList SceneNamesInDisplayOrder()
{
	QStringList names;

	obs_frontend_source_list scenes = {};
	obs_frontend_get_scenes(&scenes);
	/* The frontend list is top-first, which is the order the UI shows and the
	 * order a multiview should read in. */
	for (size_t i = 0; i < scenes.sources.num; i++) {
		const char *name = obs_source_get_name(scenes.sources.array[i]);
		if (name) {
			names.append(QString::fromUtf8(name));
		}
	}
	obs_frontend_source_list_free(&scenes);
	return names;
}

QImage CaptureMultiview(const QStringList &requested, uint32_t width, uint32_t height, bool &ok)
{
	ok = false;

	const QStringList names = requested.isEmpty() ? SceneNamesInDisplayOrder() : requested;
	if (names.isEmpty() || width == 0 || height == 0) {
		return QImage();
	}

	/* Each tile is rendered on its own with the same code path as the single
	 * preview (which handles aspect fitting), then blitted onto the grid on the
	 * CPU. Composing with nested viewports/projections inside one render pass
	 * interacts badly with the projection a scene sets up for itself; this way
	 * the result is exactly the tiles at the coordinates we asked for. */
	const int count = names.size();
	const int columns = static_cast<int>(std::ceil(std::sqrt(static_cast<double>(count))));
	const int rows = static_cast<int>(std::ceil(static_cast<double>(count) / columns));
	const int tileWidth = static_cast<int>(width) / columns;
	const int tileHeight = static_cast<int>(height) / rows;
	const int border = 2;

	QImage image(width, height, QImage::Format_RGBA8888);
	image.fill(Qt::transparent);

	/* Paint the whole surface with the canvas colour first. */
	const auto fillAll = [&image](uint32_t color) {
		for (int y = 0; y < image.height(); y++) {
			auto *line = reinterpret_cast<uint32_t *>(image.scanLine(y));
			for (int x = 0; x < image.width(); x++) {
				line[x] = color;
			}
		}
	};
	fillAll(kBackgroundColor);

	const auto fillRect = [&image](int left, int top, int rectWidth, int rectHeight, uint32_t color) {
		const int x0 = std::max(0, left);
		const int y0 = std::max(0, top);
		const int x1 = std::min(image.width(), left + rectWidth);
		const int y1 = std::min(image.height(), top + rectHeight);
		for (int y = y0; y < y1; y++) {
			auto *line = reinterpret_cast<uint32_t *>(image.scanLine(y));
			for (int x = x0; x < x1; x++) {
				line[x] = color;
			}
		}
	};

	const auto blit = [&image](const QImage &tile, int centerX, int centerY) {
		const int left = centerX - tile.width() / 2;
		const int top = centerY - tile.height() / 2;
		for (int y = 0; y < tile.height(); y++) {
			const int destY = top + y;
			if (destY < 0 || destY >= image.height()) {
				continue;
			}
			const int copyLeft = std::max(0, left);
			const int copyRight = std::min(image.width(), left + tile.width());
			if (copyRight <= copyLeft) {
				continue;
			}
			memcpy(image.scanLine(destY) + copyLeft * 4, tile.constScanLine(y) + (copyLeft - left) * 4,
			       static_cast<size_t>(copyRight - copyLeft) * 4);
		}
	};

	OBSSourceAutoRelease program = obs_frontend_get_current_scene();
	const char *programName = program ? obs_source_get_name(program) : nullptr;

	QStringList composed;
	int rendered = 0;

	for (int index = 0; index < count; index++) {
		const QString &name = names[index];
		const int column = index % columns;
		const int row = index / columns;
		const int left = column * tileWidth;
		const int top = row * tileHeight;

		/* Multiview uses the program scene's name to outline its tile. */
		const bool isProgram = programName && name == QString::fromUtf8(programName);
		fillRect(left, top, tileWidth, tileHeight, isProgram ? kProgramColor : kBorderColor);
		fillRect(left + border, top + border, tileWidth - border * 2, tileHeight - border * 2,
			 kBackgroundColor);

		bool tileOk = false;
		const QImage tile = CaptureSource(name, static_cast<uint32_t>(tileWidth - border * 4),
						  static_cast<uint32_t>(tileHeight - border * 4), tileOk);
		if (tileOk) {
			blit(tile, left + tileWidth / 2, top + tileHeight / 2);
			rendered++;
			composed.append(name);
		} else {
			composed.append(name + QLatin1String(" (empty)"));
		}
	}

	blog(LOG_INFO, "[WebMIX] Multiview %dx%d grid from %d scene(s): %s", columns, rows, rendered,
	     qUtf8Printable(composed.join(QLatin1String(" | "))));

	ok = rendered > 0;
	return ok ? image : QImage();
}

#ifdef WEBMIX_HAVE_LIBJPEG
/* libjpeg reports errors by longjmp-ing out of the encoder; the default
 * handler calls exit(), which would take OBS down with it. */
struct JpegErrorHandler {
	jpeg_error_mgr base;
	jmp_buf escape;
};

void OnJpegError(j_common_ptr info)
{
	auto *handler = reinterpret_cast<JpegErrorHandler *>(info->err);
	longjmp(handler->escape, 1);
}

/*! Encode an image as JPEG, directly with libjpeg.
 *
 * Qt's writer is used everywhere else, but not here: it enables Huffman
 * optimisation, which costs about three times the encode time to save a few
 * percent of size - and encode time is exactly what keeps a 60 fps preview
 * from holding its frame rate at larger pane sizes. This way the options that
 * matter are also explicit: no optimisation, and 4:4:4 colour above quality
 * 90 (Qt's own threshold), which is what stops coloured text from smearing.
 */
QByteArray EncodeJpeg(const QImage &image, int quality)
{
	if (image.isNull()) {
		return QByteArray();
	}

	/* libjpeg has no alpha channel and the preview is opaque. */
	const QImage rgb = image.format() == QImage::Format_RGB888 ? image
								   : image.convertToFormat(QImage::Format_RGB888);
	if (rgb.isNull() || rgb.width() <= 0 || rgb.height() <= 0) {
		return QByteArray();
	}

	jpeg_compress_struct compress = {};
	JpegErrorHandler error = {};
	unsigned char *out = nullptr;
	unsigned long outSize = 0;

	compress.err = jpeg_std_error(&error.base);
	error.base.error_exit = OnJpegError;

	/* Only plain C state lives between setjmp and longjmp, so escaping from a
	 * libjpeg error does not skip a C++ destructor. */
	if (setjmp(error.escape)) {
		jpeg_destroy_compress(&compress);
		free(out);
		blog(LOG_WARNING, "[WebMIX] JPEG encoding failed");
		return QByteArray();
	}

	jpeg_create_compress(&compress);
	jpeg_mem_dest(&compress, &out, &outSize);
	compress.image_width = static_cast<JDIMENSION>(rgb.width());
	compress.image_height = static_cast<JDIMENSION>(rgb.height());
	compress.input_components = 3;
	compress.in_color_space = JCS_RGB;
	jpeg_set_defaults(&compress);
	compress.optimize_coding = FALSE;
	if (quality >= 91) {
		for (int i = 0; i < 3; i++) {
			compress.comp_info[i].h_samp_factor = 1;
			compress.comp_info[i].v_samp_factor = 1;
		}
	}
	jpeg_set_quality(&compress, std::clamp(quality, 1, 100), TRUE);

	jpeg_start_compress(&compress, TRUE);
	while (compress.next_scanline < compress.image_height) {
		JSAMPROW row = const_cast<JSAMPROW>(rgb.constScanLine(static_cast<int>(compress.next_scanline)));
		jpeg_write_scanlines(&compress, &row, 1);
	}
	jpeg_finish_compress(&compress);
	jpeg_destroy_compress(&compress);

	const QByteArray encoded(reinterpret_cast<const char *>(out), static_cast<int>(outSize));
	free(out);
	return encoded;
}
#else
/*! Encode an image as JPEG with Qt's writer.
 *
 * Fallback for builds without libjpeg - the Windows dependency bundle does not
 * expose it, and a codec the preview merely prefers must not fail a configure.
 * Qt enables Huffman optimisation, so this is slower at large pane sizes, but
 * it produces a valid JPEG and keeps the preview working everywhere.
 */
QByteArray EncodeJpeg(const QImage &image, int quality)
{
	if (image.isNull()) {
		return QByteArray();
	}

	QByteArray encoded;
	QBuffer buffer(&encoded);
	if (!buffer.open(QIODevice::WriteOnly)) {
		blog(LOG_WARNING, "[WebMIX] JPEG encoding failed: cannot open a buffer");
		return QByteArray();
	}
	if (!image.save(&buffer, "JPEG", quality)) {
		blog(LOG_WARNING, "[WebMIX] JPEG encoding failed");
		return QByteArray();
	}
	return encoded;
}
#endif

Stream::Stream(QTcpSocket *socket_, QString sourceName_, int width_, int height_, int fps_, int quality_,
	       QObject *parent, Mode mode_)
	: QObject(parent),
	  socket(socket_),
	  sourceName(std::move(sourceName_)),
	  width(width_),
	  height(height_),
	  fps(fps_),
	  quality(quality_),
	  mode(mode_)
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
	if (!jpeg.isEmpty()) {
		sentFrames.fetch_add(1, std::memory_order_relaxed);
	}
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
