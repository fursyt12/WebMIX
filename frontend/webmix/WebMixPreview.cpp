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
#include <QCoreApplication>
#include <QDateTime>
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
#include <util/threading.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>
#include <cmath>
#include <string.h>

namespace WebMixPreview {

/*! Every frame that reached a socket; see FramesSent(). */
std::atomic<uint64_t> sentFrames{0};
/*! Frames encoded, frames a busy socket skipped, and the last encode time. */
std::atomic<uint64_t> encodedFrames{0};
std::atomic<uint64_t> skippedFrames{0};
/*! Frames not sent because the picture had not changed, and frames not made
 *  because the encoder was still on the previous one. Together with the two
 *  above they say where a low frame rate comes from. */
std::atomic<uint64_t> stillFrames{0};
std::atomic<uint64_t> busyFrames{0};
std::atomic<uint32_t> lastEncodeMicros{0};

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

	ok = rendered > 0;
	return ok ? image : QImage();
}

/* ------------------------------------------------------------------ JPEG -- */

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

/*! Compress tightly or loosely packed rows into a malloc'ed JPEG.
 *
 * Only plain C state lives between setjmp and longjmp, so escaping from a
 * libjpeg error does not skip a C++ destructor - which is why this takes raw
 * pointers and hands back a buffer the caller frees. */
bool CompressJpeg(const uint8_t *pixels, int width, int height, int stride, int components, J_COLOR_SPACE space,
		  int quality, unsigned char **out, unsigned long *outSize)
{
	jpeg_compress_struct compress = {};
	JpegErrorHandler error = {};

	compress.err = jpeg_std_error(&error.base);
	error.base.error_exit = OnJpegError;

	if (setjmp(error.escape)) {
		jpeg_destroy_compress(&compress);
		free(*out);
		*out = nullptr;
		*outSize = 0;
		return false;
	}

	jpeg_create_compress(&compress);
	jpeg_mem_dest(&compress, out, outSize);
	compress.image_width = static_cast<JDIMENSION>(width);
	compress.image_height = static_cast<JDIMENSION>(height);
	compress.input_components = components;
	compress.in_color_space = space;
	jpeg_set_defaults(&compress);
	/* Huffman optimisation costs about three times the encode time to save a
	 * few percent of size, and encode time is what a live preview is short of. */
	compress.optimize_coding = FALSE;
	/* 4:4:4 colour above quality 90, which is what stops coloured text from
	 * smearing; below it the default 4:2:0 halves the frame size. */
	if (quality >= 91) {
		for (int i = 0; i < 3; i++) {
			compress.comp_info[i].h_samp_factor = 1;
			compress.comp_info[i].v_samp_factor = 1;
		}
	}
	jpeg_set_quality(&compress, std::clamp(quality, 1, 100), TRUE);

	jpeg_start_compress(&compress, TRUE);
	while (compress.next_scanline < compress.image_height) {
		JSAMPROW row = const_cast<JSAMPROW>(pixels + static_cast<size_t>(compress.next_scanline) * stride);
		jpeg_write_scanlines(&compress, &row, 1);
	}
	jpeg_finish_compress(&compress);
	jpeg_destroy_compress(&compress);
	return true;
}
#endif

/*! Encode rows of R, G, B, X bytes - what the GPU read-back produces - as JPEG.
 *
 * libjpeg-turbo takes that layout as it is, so a frame goes from the staging
 * surface to the encoder without a conversion pass in between. */
QByteArray EncodeJpegRgbx(const uint8_t *pixels, int width, int height, int stride, int quality)
{
	if (!pixels || width <= 0 || height <= 0) {
		return QByteArray();
	}

#ifdef WEBMIX_HAVE_LIBJPEG
	unsigned char *out = nullptr;
	unsigned long outSize = 0;
	bool ok = false;

#ifdef JCS_EXTENSIONS
	ok = CompressJpeg(pixels, width, height, stride, 4, JCS_EXT_RGBX, quality, &out, &outSize);
#else
	/* Plain libjpeg has no four-byte input format: drop the fourth byte. */
	std::vector<uint8_t> rgb(static_cast<size_t>(width) * height * 3);
	for (int y = 0; y < height; y++) {
		const uint8_t *from = pixels + static_cast<size_t>(y) * stride;
		uint8_t *to = rgb.data() + static_cast<size_t>(y) * width * 3;
		for (int x = 0; x < width; x++) {
			to[x * 3] = from[x * 4];
			to[x * 3 + 1] = from[x * 4 + 1];
			to[x * 3 + 2] = from[x * 4 + 2];
		}
	}
	ok = CompressJpeg(rgb.data(), width, height, width * 3, 3, JCS_RGB, quality, &out, &outSize);
#endif

	if (!ok) {
		blog(LOG_WARNING, "[WebMIX] JPEG encoding failed");
		return QByteArray();
	}
	const QByteArray encoded(reinterpret_cast<const char *>(out), static_cast<qsizetype>(outSize));
	free(out);
	return encoded;
#else
	/* Builds without libjpeg - the Windows dependency bundle does not expose it,
	 * and a codec the preview merely prefers must not fail a configure. Qt's
	 * writer is slower (it optimises the Huffman tables), but it runs on the
	 * same worker thread and wraps the pixels without copying them. */
	const QImage image(pixels, width, height, stride, QImage::Format_RGBX8888);
	QByteArray encoded;
	QBuffer buffer(&encoded);
	if (!buffer.open(QIODevice::WriteOnly) || !image.save(&buffer, "JPEG", quality)) {
		blog(LOG_WARNING, "[WebMIX] JPEG encoding failed");
		return QByteArray();
	}
	return encoded;
#endif
}

QByteArray EncodeJpeg(const QImage &image, int quality)
{
	if (image.isNull()) {
		return QByteArray();
	}
	/* RGBA8888 and RGBX8888 share a byte layout; the alpha is ignored. */
	const bool usable = image.format() == QImage::Format_RGBX8888 || image.format() == QImage::Format_RGBA8888;
	const QImage rgbx = usable ? image : image.convertToFormat(QImage::Format_RGBX8888);
	if (rgbx.isNull()) {
		return QByteArray();
	}
	return EncodeJpegRgbx(rgbx.constBits(), rgbx.width(), rgbx.height(), static_cast<int>(rgbx.bytesPerLine()),
			      quality);
}

/* --------------------------------------------------------------- capture -- */

QString Target::Key() const
{
	const char *name = kind == Kind::Program ? "program" : kind == Kind::Multiview ? "multiview" : "source";
	return QStringLiteral("%1|%2|%3|%4x%5|%6|%7")
		.arg(QLatin1String(name), source, scenes.join(QLatin1Char(',')))
		.arg(width)
		.arg(height)
		.arg(fps)
		.arg(quality);
}

namespace {

/* How much of a frame the kernel may hold for a client.  Small on purpose: what
 * sits in a socket buffer is latency the client cannot skip, and the default
 * (megabytes, auto-tuned) hides a slow reader for a second or more. */
constexpr int kSendBufferBytes = 256 * 1024;

/* A picture that does not change is not re-sent, except this often - enough
 * for a client to tell a still scene from a dead stream. */
constexpr uint64_t kStillFrameIntervalNs = 1000000000ULL;

constexpr uint64_t kSourceRetryNs = 250000000ULL;
constexpr uint32_t kMaxDimension = 4096;

/*! The size to render at: what was asked for, completed from the aspect ratio
 *  when only one side (or neither) was given. */
bool FitSize(uint32_t sourceWidth, uint32_t sourceHeight, uint32_t askedWidth, uint32_t askedHeight, uint32_t &width,
	     uint32_t &height)
{
	if (sourceWidth == 0 || sourceHeight == 0) {
		return false;
	}
	const double aspect = static_cast<double>(sourceWidth) / static_cast<double>(sourceHeight);

	width = askedWidth;
	height = askedHeight;
	if (width && !height) {
		height = static_cast<uint32_t>(width / aspect);
	} else if (height && !width) {
		width = static_cast<uint32_t>(height * aspect);
	} else if (!width && !height) {
		width = sourceWidth;
		height = sourceHeight;
	}
	width = std::min(width, kMaxDimension);
	height = std::min(height, kMaxDimension);
	return width > 0 && height > 0;
}

/*! Fill a rectangle of the current render target with one colour. */
void FillRect(int left, int top, int width, int height, uint32_t rgba)
{
	if (width <= 0 || height <= 0) {
		return;
	}
	gs_effect_t *solid = obs_get_base_effect(OBS_EFFECT_SOLID);
	gs_eparam_t *color = gs_effect_get_param_by_name(solid, "color");

	vec4 value;
	vec4_set(&value, (rgba & 0xFF) / 255.0f, ((rgba >> 8) & 0xFF) / 255.0f, ((rgba >> 16) & 0xFF) / 255.0f, 1.0f);
	gs_effect_set_vec4(color, &value);

	gs_viewport_push();
	gs_projection_push();
	gs_set_viewport(left, top, width, height);
	gs_ortho(0.0f, 1.0f, 0.0f, 1.0f, -100.0f, 100.0f);
	while (gs_effect_loop(solid, "Solid")) {
		gs_draw_sprite(nullptr, 0, 1, 1);
	}
	gs_projection_pop();
	gs_viewport_pop();
}

/*! A source this capture keeps "showing" for as long as it is drawn, the way
 *  OBS's own projectors do - a browser or media source that nobody shows may
 *  stop producing frames altogether. */
struct ShownSource {
	QByteArray name;
	OBSWeakSource weak;
	uint64_t lastLookup = 0;

	/*! The source, or null while it does not exist. Graphics thread. */
	OBSSource Resolve(uint64_t now)
	{
		OBSSource source = OBSGetStrongRef(weak);
		if (source && !obs_source_removed(source)) {
			return source;
		}
		if (source) {
			obs_source_dec_showing(source);
		}
		weak = nullptr;

		/* Not there (yet, or any more): look again, but not every frame. */
		if (lastLookup && now - lastLookup < kSourceRetryNs) {
			return nullptr;
		}
		lastLookup = now;

		OBSSourceAutoRelease found = obs_get_source_by_name(name.constData());
		if (!found || obs_source_removed(found)) {
			return nullptr;
		}
		obs_source_inc_showing(found);
		weak = OBSGetWeakRef(found);
		return found.Get();
	}

	void Release()
	{
		OBSSource source = OBSGetStrongRef(weak);
		if (source) {
			obs_source_dec_showing(source);
		}
		weak = nullptr;
	}
};

class Hub;
Hub *hub = nullptr;
bool hubShutDown = false;

} // namespace

/*!
 * One picture, rendered once per frame for every stream that wants it.
 *
 * Three threads meet here and each owns one step:
 *
 *   graphics thread   Render()      draw into the texture, start the read-back
 *   worker thread     WorkerLoop()  finish the read-back, compare, encode
 *   main thread       Deliver()     write the JPEG to the sockets
 *
 * `staged` and `busy` hand a frame from the first to the second: the graphics
 * thread only draws when the worker is idle, so a slow encoder lowers the frame
 * rate instead of building a queue.
 */
class Capture : public std::enable_shared_from_this<Capture> {
public:
	explicit Capture(Target target_) : target(std::move(target_))
	{
		const int fps = std::clamp(target.fps, 1, 240);
		const uint64_t interval = 1000000000ULL / static_cast<uint64_t>(fps);
		/* A tenth of slack, so asking for the rate OBS renders at takes every
		 * frame instead of losing one to timer jitter now and then. */
		minIntervalNs = interval - interval / 10;
		shown.name = target.source.toUtf8();
	}

	~Capture() { Stop(); }

	void StartWorker()
	{
		worker = std::thread([this]() {
			os_set_thread_name("webmix-preview");
			WorkerLoop();
		});
	}

	/*! Stop the worker and free the GPU resources. Main thread. */
	void Stop()
	{
		if (stopped.exchange(true)) {
			return;
		}
		{
			std::lock_guard<std::mutex> lock(mutex);
			quit = true;
		}
		wake.notify_all();
		if (worker.joinable()) {
			worker.join();
		}

		/* Entering the graphics context waits for the graphics thread to
		 * leave it, so no Render() is in flight past this point.  If libobs
		 * is already gone there is nothing left to free. */
		if (obs_initialized()) {
			obs_enter_graphics();
			if (stage) {
				gs_stagesurface_destroy(stage);
			}
			if (texrender) {
				gs_texrender_destroy(texrender);
			}
			obs_leave_graphics();

			shown.Release();
			for (ShownSource &tile : tiles) {
				tile.Release();
			}
		}
		stage = nullptr;
		texrender = nullptr;
		tiles.clear();
		streams.clear();
	}

	/* ---- main thread ---------------------------------------------------- */

	void Add(Stream *stream)
	{
		streams.push_back(stream);
		/* A late joiner should not wait for the picture to change. */
		if (!lastPart.isEmpty()) {
			stream->Send(lastPart);
		}
		forceFrame.store(true, std::memory_order_relaxed);
		UpdateDemand();
	}

	void Remove(Stream *stream)
	{
		streams.erase(std::remove(streams.begin(), streams.end(), stream), streams.end());
		UpdateDemand();
	}

	bool Empty() const { return streams.empty(); }

	/*! Frames are only made while some socket can take one. */
	void UpdateDemand()
	{
		bool any = false;
		for (const Stream *stream : streams) {
			any = any || stream->Ready();
		}
		const bool was = demand.exchange(any, std::memory_order_relaxed);
		if (any && !was) {
			/* Whoever was waiting is now behind: send the current picture
			 * even if it has not changed since the last one. */
			forceFrame.store(true, std::memory_order_relaxed);
		}
	}

	void Deliver(const QByteArray &jpeg, qint64 renderedAtMs)
	{
		if (stopped.load()) {
			return;
		}
		/* The boundary that *ends* a part is written right behind it, not
		 * in front of the next one.  A browser showing the stream in an
		 * <img> paints a part only once it has seen that boundary, so
		 * leading with it kept every frame back until its successor
		 * arrived - one frame of latency always, and a whole second on a
		 * picture that is not changing. */
		QByteArray part;
		part.reserve(jpeg.size() + 160);
		part += "Content-Type: image/jpeg\r\n";
		part += "X-Timestamp: " + QByteArray::number(renderedAtMs) + "\r\n";
		part += "Content-Length: " + QByteArray::number(jpeg.size()) + "\r\n\r\n";
		part += jpeg;
		part += "\r\n--webmixframe\r\n";
		lastPart = part;

		for (Stream *stream : streams) {
			if (stream->Send(part)) {
				sentFrames.fetch_add(1, std::memory_order_relaxed);
			} else {
				skippedFrames.fetch_add(1, std::memory_order_relaxed);
			}
		}
		UpdateDemand();
	}

	/*! The scene grid a multiview draws, resolved on the main thread because
	 *  the frontend API it comes from belongs there. */
	void SetLayout(const QStringList &names, const QString &program)
	{
		std::lock_guard<std::mutex> lock(mutex);
		if (names != layoutNames || program != layoutProgram) {
			layoutNames = names;
			layoutProgram = program;
			layoutChanged = true;
		}
	}

	/* ---- graphics thread ------------------------------------------------ */

	void Render(uint64_t frameTime)
	{
		if (stopped.load(std::memory_order_relaxed) || !demand.load(std::memory_order_relaxed)) {
			return;
		}
		if (lastRender && frameTime > lastRender && frameTime - lastRender < minIntervalNs) {
			return;
		}
		{
			std::lock_guard<std::mutex> lock(mutex);
			if (quit) {
				return;
			}
			if (staged || busy) {
				busyFrames.fetch_add(1, std::memory_order_relaxed);
				return;
			}
		}

		uint32_t width = 0;
		uint32_t height = 0;
		bool drawn = false;
		switch (target.kind) {
		case Target::Kind::Program:
			drawn = RenderProgram(width, height);
			break;
		case Target::Kind::Source:
			drawn = RenderSource(frameTime, width, height);
			break;
		case Target::Kind::Multiview:
			drawn = RenderMultiview(frameTime, width, height);
			break;
		}
		if (!drawn) {
			return;
		}

		gs_stage_texture(stage, gs_texrender_get_texture(texrender));
		lastRender = frameTime;
		{
			std::lock_guard<std::mutex> lock(mutex);
			staged = true;
			stagedWidth = width;
			stagedHeight = height;
			stagedAtMs = QDateTime::currentMSecsSinceEpoch();
		}
		wake.notify_one();
	}

	const Target target;

private:
	bool EnsureSurfaces(uint32_t width, uint32_t height)
	{
		if (!texrender) {
			texrender = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
		}
		if (!stage || stageWidth != width || stageHeight != height) {
			if (stage) {
				gs_stagesurface_destroy(stage);
			}
			stage = gs_stagesurface_create(width, height, GS_RGBA);
			stageWidth = width;
			stageHeight = height;
		}
		return texrender && stage;
	}

	/*! The program, from the texture OBS has just rendered it into. */
	bool RenderProgram(uint32_t &width, uint32_t &height)
	{
		obs_video_info ovi;
		if (!obs_get_video_info(&ovi) || !obs_get_main_texture()) {
			return false;
		}
		if (!FitSize(ovi.base_width, ovi.base_height, target.width, target.height, width, height) ||
		    !EnsureSurfaces(width, height)) {
			return false;
		}

		gs_texrender_reset(texrender);
		if (!gs_texrender_begin(texrender, width, height)) {
			return false;
		}
		vec4 background;
		vec4_zero(&background);
		gs_clear(GS_CLEAR_COLOR, &background, 0.0f, 0);
		gs_ortho(0.0f, static_cast<float>(ovi.base_width), 0.0f, static_cast<float>(ovi.base_height), -100.0f,
			 100.0f);
		obs_render_main_texture_src_color_only();
		gs_texrender_end(texrender);
		return true;
	}

	bool RenderSource(uint64_t frameTime, uint32_t &width, uint32_t &height)
	{
		OBSSource source = shown.Resolve(frameTime);
		if (!source) {
			return false;
		}
		const uint32_t sourceWidth = obs_source_get_width(source);
		const uint32_t sourceHeight = obs_source_get_height(source);
		if (!FitSize(sourceWidth, sourceHeight, target.width, target.height, width, height) ||
		    !EnsureSurfaces(width, height)) {
			return false;
		}

		gs_texrender_reset(texrender);
		if (!gs_texrender_begin(texrender, width, height)) {
			return false;
		}
		vec4 background;
		vec4_zero(&background);
		gs_clear(GS_CLEAR_COLOR, &background, 0.0f, 0);
		gs_ortho(0.0f, static_cast<float>(sourceWidth), 0.0f, static_cast<float>(sourceHeight), -100.0f,
			 100.0f);

		gs_blend_state_push();
		gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
		obs_source_video_render(source);
		gs_blend_state_pop();

		gs_texrender_end(texrender);
		return true;
	}

	/*! Every scene in a tile of one texture, the program's outlined. */
	bool RenderMultiview(uint64_t frameTime, uint32_t &width, uint32_t &height)
	{
		QByteArray program;
		{
			std::lock_guard<std::mutex> lock(mutex);
			if (layoutChanged) {
				layoutChanged = false;
				/* Keep what is still in the grid (and its showing reference),
				 * let go of what left it. */
				std::vector<ShownSource> next;
				for (const QString &name : layoutNames) {
					const QByteArray utf8 = name.toUtf8();
					auto existing = std::find_if(tiles.begin(), tiles.end(),
								     [&utf8](const ShownSource &tile) {
									     return tile.name == utf8;
								     });
					if (existing != tiles.end()) {
						next.push_back(*existing);
						tiles.erase(existing);
					} else {
						ShownSource tile;
						tile.name = utf8;
						next.push_back(tile);
					}
				}
				for (ShownSource &gone : tiles) {
					gone.Release();
				}
				tiles = std::move(next);
			}
			program = layoutProgram.toUtf8();
		}

		const int count = static_cast<int>(tiles.size());
		width = target.width ? std::min(target.width, kMaxDimension) : 1280;
		height = target.height ? std::min(target.height, kMaxDimension) : 720;
		if (count == 0 || !EnsureSurfaces(width, height)) {
			return false;
		}

		const int columns = static_cast<int>(std::ceil(std::sqrt(static_cast<double>(count))));
		const int rows = static_cast<int>(std::ceil(static_cast<double>(count) / columns));
		const int tileWidth = static_cast<int>(width) / columns;
		const int tileHeight = static_cast<int>(height) / rows;
		const int border = 2;

		gs_texrender_reset(texrender);
		if (!gs_texrender_begin(texrender, width, height)) {
			return false;
		}
		vec4 background;
		vec4_set(&background, 0x13 / 255.0f, 0x14 / 255.0f, 0x1A / 255.0f, 1.0f);
		gs_clear(GS_CLEAR_COLOR, &background, 0.0f, 0);

		for (int index = 0; index < count; index++) {
			ShownSource &tile = tiles[static_cast<size_t>(index)];
			const int left = (index % columns) * tileWidth;
			const int top = (index / columns) * tileHeight;

			FillRect(left, top, tileWidth, tileHeight, tile.name == program ? kProgramColor : kBorderColor);
			FillRect(left + border, top + border, tileWidth - border * 2, tileHeight - border * 2,
				 kBackgroundColor);

			OBSSource source = tile.Resolve(frameTime);
			const uint32_t sourceWidth = source ? obs_source_get_width(source) : 0;
			const uint32_t sourceHeight = source ? obs_source_get_height(source) : 0;
			const int roomWidth = tileWidth - border * 4;
			const int roomHeight = tileHeight - border * 4;
			if (!sourceWidth || !sourceHeight || roomWidth <= 0 || roomHeight <= 0) {
				continue;
			}

			/* Aspect-fit the scene into its tile, centred. */
			const double scale = std::min(static_cast<double>(roomWidth) / sourceWidth,
						      static_cast<double>(roomHeight) / sourceHeight);
			const int drawWidth = std::max(1, static_cast<int>(sourceWidth * scale));
			const int drawHeight = std::max(1, static_cast<int>(sourceHeight * scale));

			gs_viewport_push();
			gs_projection_push();
			gs_set_viewport(left + (tileWidth - drawWidth) / 2, top + (tileHeight - drawHeight) / 2,
					drawWidth, drawHeight);
			gs_ortho(0.0f, static_cast<float>(sourceWidth), 0.0f, static_cast<float>(sourceHeight), -100.0f,
				 100.0f);
			gs_blend_state_push();
			gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
			obs_source_video_render(source);
			gs_blend_state_pop();
			gs_projection_pop();
			gs_viewport_pop();
		}

		gs_texrender_end(texrender);
		return true;
	}

	void WorkerLoop();

	/* Written by the graphics thread while the worker is idle, read by the
	 * worker while it is busy - the hand-over below is what keeps them apart. */
	gs_texrender_t *texrender = nullptr;
	gs_stagesurf_t *stage = nullptr;
	uint32_t stageWidth = 0;
	uint32_t stageHeight = 0;

	/* Graphics thread only. */
	uint64_t lastRender = 0;
	uint64_t minIntervalNs = 0;
	ShownSource shown;
	std::vector<ShownSource> tiles;

	std::mutex mutex;
	std::condition_variable wake;
	bool staged = false;
	bool busy = false;
	bool quit = false;
	uint32_t stagedWidth = 0;
	uint32_t stagedHeight = 0;
	qint64 stagedAtMs = 0;
	QStringList layoutNames;
	QString layoutProgram;
	bool layoutChanged = false;

	std::atomic<bool> demand{false};
	std::atomic<bool> forceFrame{true};
	std::atomic<bool> stopped{false};
	std::thread worker;

	/* Main thread only. */
	std::vector<Stream *> streams;
	QByteArray lastPart;
};

namespace {

/*! The captures, and the two hooks that drive them: OBS's "main texture
 *  rendered" callback, and the queued call that brings a frame back to the main
 *  thread. */
class Hub : public QObject {
public:
	Hub() : QObject(qApp)
	{
		obs_add_main_rendered_callback(OnRendered, this);
		obs_frontend_add_event_callback(OnFrontendEvent, this);

		/* Multiview needs the scene list, which only the main thread may ask
		 * the frontend for. */
		layoutTimer = new QTimer(this);
		layoutTimer->setInterval(500);
		connect(layoutTimer, &QTimer::timeout, this, &Hub::RefreshLayouts);
	}

	std::shared_ptr<Capture> Acquire(const Target &target)
	{
		const QString key = target.Key();
		for (const auto &capture : captures) {
			if (capture->target.Key() == key) {
				return capture;
			}
		}

		auto capture = std::make_shared<Capture>(target);
		if (target.kind == Target::Kind::Multiview) {
			ApplyLayout(*capture);
			layoutTimer->start();
		}
		capture->StartWorker();
		{
			std::lock_guard<std::mutex> lock(mutex);
			captures.push_back(capture);
		}
		return capture;
	}

	void Release(const std::shared_ptr<Capture> &capture)
	{
		if (!capture->Empty()) {
			return;
		}
		{
			std::lock_guard<std::mutex> lock(mutex);
			captures.erase(std::remove(captures.begin(), captures.end(), capture), captures.end());
		}
		capture->Stop();
	}

	void StopAll()
	{
		if (stoppedAll) {
			return;
		}
		stoppedAll = true;

		std::vector<std::shared_ptr<Capture>> all;
		{
			std::lock_guard<std::mutex> lock(mutex);
			all.swap(captures);
		}
		for (const auto &capture : all) {
			capture->Stop();
		}
		layoutTimer->stop();
		if (obs_initialized()) {
			obs_remove_main_rendered_callback(OnRendered, this);
			obs_frontend_remove_event_callback(OnFrontendEvent, this);
		}
	}

	int Count()
	{
		std::lock_guard<std::mutex> lock(mutex);
		return static_cast<int>(captures.size());
	}

private:
	static void OnRendered(void *param)
	{
		auto *self = static_cast<Hub *>(param);

		/* The callback fires once per video mix; one pass per frame is
		 * enough, and it has to be one where the program texture exists. */
		const uint64_t frameTime = obs_get_video_frame_time();
		if (frameTime == self->lastFrameTime || !obs_get_main_texture()) {
			return;
		}
		self->lastFrameTime = frameTime;

		std::vector<std::shared_ptr<Capture>> snapshot;
		{
			std::lock_guard<std::mutex> lock(self->mutex);
			snapshot = self->captures;
		}
		for (const auto &capture : snapshot) {
			capture->Render(frameTime);
		}
	}

	static void OnFrontendEvent(enum obs_frontend_event event, void *)
	{
		/* The sockets outlive libobs (they belong to the application object),
		 * so the captures have to be gone before it shuts down. */
		if (event == OBS_FRONTEND_EVENT_EXIT || event == OBS_FRONTEND_EVENT_SCRIPTING_SHUTDOWN) {
			Shutdown();
		}
	}

	void ApplyLayout(Capture &capture)
	{
		const QStringList names = capture.target.scenes.isEmpty() ? SceneNamesInDisplayOrder()
									  : capture.target.scenes;
		OBSSourceAutoRelease program = obs_frontend_get_current_scene();
		const char *programName = program ? obs_source_get_name(program) : nullptr;
		capture.SetLayout(names, programName ? QString::fromUtf8(programName) : QString());
	}

	void RefreshLayouts()
	{
		bool any = false;
		std::vector<std::shared_ptr<Capture>> snapshot;
		{
			std::lock_guard<std::mutex> lock(mutex);
			snapshot = captures;
		}
		for (const auto &capture : snapshot) {
			if (capture->target.kind == Target::Kind::Multiview) {
				ApplyLayout(*capture);
				any = true;
			}
		}
		if (!any) {
			layoutTimer->stop();
		}
	}

	std::mutex mutex;
	std::vector<std::shared_ptr<Capture>> captures;
	uint64_t lastFrameTime = 0;
	QTimer *layoutTimer = nullptr;
	bool stoppedAll = false;
};

Hub *EnsureHub()
{
	if (hubShutDown) {
		return nullptr;
	}
	if (!hub) {
		hub = new Hub();
	}
	return hub;
}

} // namespace

void Capture::WorkerLoop()
{
	std::vector<uint8_t> pixels;
	std::vector<uint8_t> previous;
	uint32_t previousWidth = 0;
	uint32_t previousHeight = 0;
	uint64_t lastPublished = 0;

	for (;;) {
		uint32_t width = 0;
		uint32_t height = 0;
		qint64 renderedAtMs = 0;
		{
			std::unique_lock<std::mutex> lock(mutex);
			wake.wait(lock, [this]() { return quit || staged; });
			if (quit) {
				return;
			}
			staged = false;
			busy = true;
			width = stagedWidth;
			height = stagedHeight;
			renderedAtMs = stagedAtMs;
		}

		/* Mapping waits for the GPU to finish the frame. Doing that here, and
		 * not on the graphics thread, is what keeps the wait out of OBS's own
		 * frame time. */
		bool mapped = false;
		const size_t rowBytes = static_cast<size_t>(width) * 4;
		pixels.resize(rowBytes * height);
		obs_enter_graphics();
		uint8_t *data = nullptr;
		uint32_t linesize = 0;
		if (stage && gs_stagesurface_map(stage, &data, &linesize)) {
			for (uint32_t y = 0; y < height; y++) {
				memcpy(pixels.data() + y * rowBytes, data + static_cast<size_t>(y) * linesize,
				       rowBytes);
			}
			gs_stagesurface_unmap(stage);
			mapped = true;
		}
		obs_leave_graphics();

		if (mapped) {
			const uint64_t now = os_gettime_ns();
			const bool same = width == previousWidth && height == previousHeight &&
					  previous.size() == pixels.size() &&
					  memcmp(previous.data(), pixels.data(), pixels.size()) == 0;
			const bool forced = forceFrame.exchange(false, std::memory_order_relaxed);

			/* A still picture is not worth encoding and sending again. */
			if (same && !forced && now - lastPublished < kStillFrameIntervalNs) {
				stillFrames.fetch_add(1, std::memory_order_relaxed);
			} else {
				const QByteArray jpeg = EncodeJpegRgbx(pixels.data(), static_cast<int>(width),
								       static_cast<int>(height),
								       static_cast<int>(rowBytes), target.quality);
				lastEncodeMicros.store(static_cast<uint32_t>((os_gettime_ns() - now) / 1000),
						       std::memory_order_relaxed);
				if (!jpeg.isEmpty()) {
					encodedFrames.fetch_add(1, std::memory_order_relaxed);
					lastPublished = now;
					previous.swap(pixels);
					previousWidth = width;
					previousHeight = height;

					std::weak_ptr<Capture> weak = weak_from_this();
					QMetaObject::invokeMethod(
						qApp,
						[weak, jpeg, renderedAtMs]() {
							if (auto self = weak.lock()) {
								self->Deliver(jpeg, renderedAtMs);
							}
						},
						Qt::QueuedConnection);
				}
			}
		}

		{
			std::lock_guard<std::mutex> lock(mutex);
			busy = false;
		}
	}
}

QJsonObject Stats()
{
	QJsonObject stats;
	stats["streams"] = activeStreams;
	stats["captures"] = hub ? hub->Count() : 0;
	stats["sent"] = static_cast<double>(sentFrames.load(std::memory_order_relaxed));
	stats["encoded"] = static_cast<double>(encodedFrames.load(std::memory_order_relaxed));
	stats["skipped"] = static_cast<double>(skippedFrames.load(std::memory_order_relaxed));
	stats["still"] = static_cast<double>(stillFrames.load(std::memory_order_relaxed));
	stats["busy"] = static_cast<double>(busyFrames.load(std::memory_order_relaxed));
	stats["encodeMs"] = lastEncodeMicros.load(std::memory_order_relaxed) / 1000.0;
	return stats;
}

void Shutdown()
{
	hubShutDown = true;
	if (hub) {
		hub->StopAll();
	}
}

/* ---------------------------------------------------------------- stream -- */

Stream::Stream(QTcpSocket *socket_, Target target_, QObject *parent)
	: QObject(parent),
	  socket(socket_),
	  target(std::move(target_))
{
}

Stream::~Stream()
{
	Detach();
}

void Stream::Start()
{
	if (started || !socket) {
		return;
	}
	started = true;
	activeStreams++;

	/* A frame should leave as soon as it is written, and should not be able
	 * to hide behind megabytes of earlier ones. */
	socket->setSocketOption(QAbstractSocket::LowDelayOption, 1);
	socket->setSocketOption(QAbstractSocket::SendBufferSizeSocketOption, kSendBufferBytes);

	/* multipart/x-mixed-replace is what an <img> tag and a fetch reader both
	 * understand; each part is one JPEG frame. */
	QByteArray header;
	header += "HTTP/1.1 200 OK\r\n";
	header += "Content-Type: multipart/x-mixed-replace; boundary=webmixframe\r\n";
	header += "Cache-Control: no-store, no-cache\r\n";
	header += "Pragma: no-cache\r\n";
	header += "Connection: close\r\n\r\n";
	/* The first boundary; every part then carries the one that follows it
	 * (see Capture::Deliver). */
	header += "--webmixframe\r\n";
	socket->write(header);
	socket->flush();

	connect(socket, &QTcpSocket::disconnected, this, [this]() {
		Detach();
		deleteLater();
	});
	/* Room again: the capture may have stopped rendering while every client
	 * was busy, and this is what starts it again. */
	connect(socket, &QTcpSocket::bytesWritten, this, [this]() {
		if (capture && socket && socket->bytesToWrite() == 0) {
			capture->UpdateDemand();
		}
	});

	Hub *owner = EnsureHub();
	if (!owner) {
		socket->disconnectFromHost();
		return;
	}
	capture = owner->Acquire(target);
	capture->Add(this);
}

bool Stream::Ready() const
{
	return socket && socket->state() == QAbstractSocket::ConnectedState && socket->bytesToWrite() == 0;
}

bool Stream::Send(const QByteArray &part)
{
	/* The previous frame has not left yet: this client gets the next one it
	 * has room for, not a growing queue of old ones. */
	if (!Ready()) {
		return false;
	}
	if (socket->write(part) < 0) {
		return false;
	}
	socket->flush();
	return true;
}

void Stream::Detach()
{
	if (detached) {
		return;
	}
	detached = true;
	if (started) {
		activeStreams--;
	}
	if (capture) {
		capture->Remove(this);
		if (hub) {
			hub->Release(capture);
		}
		capture.reset();
	}
}

} // namespace WebMixPreview
