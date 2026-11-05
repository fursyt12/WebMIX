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

#include "WebMixAudio.hpp"

#include <obs-frontend-api.h>
#include <obs.hpp>

#include <media-io/audio-io.h>
#include <util/platform.h>

#include <QAbstractSocket>
#include <QCoreApplication>
#include <QMetaObject>
#include <QTcpSocket>
#include <QThread>
#include <QtEndian>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace WebMixAudio {

namespace {

constexpr uint16_t kChannels = 2;
constexpr int kSendBufferBytes = 32 * 1024;
/* Roughly 80 ms of 48 kHz stereo s16le (8 * 1932 bytes): enough headroom for
 * normal Wi-Fi jitter while preventing multi-second latency build-up. */
constexpr qint64 kMaxQueuedBytes = 16 * 1024;
constexpr float kSurroundMix = 0.70710678f;

std::atomic<int> activeStreamCount{0};
std::atomic<int> monitoredSourceCount{0};
std::atomic<uint32_t> currentSampleRate{48000};
std::atomic<uint64_t> sentPackets{0};
std::atomic<uint64_t> droppedPackets{0};

uint32_t QuerySampleRate()
{
	audio_t *audio = obs_initialized() ? obs_get_audio() : nullptr;
	const uint32_t rate = audio ? static_cast<uint32_t>(audio_output_get_sample_rate(audio)) : 0;
	return rate > 0 ? rate : 48000U;
}

uint32_t QuerySourceChannels()
{
	audio_t *audio = obs_initialized() ? obs_get_audio() : nullptr;
	const uint32_t ch = audio ? static_cast<uint32_t>(audio_output_get_channels(audio)) : 0;
	return ch > 0 ? ch : 2U;
}

bool IsAudioInput(obs_source_t *source)
{
	return source && obs_source_get_type(source) == OBS_SOURCE_TYPE_INPUT &&
	       (obs_source_get_output_flags(source) & OBS_SOURCE_AUDIO) != 0;
}

QByteArray BuildPacketHeader(uint16_t channels, uint16_t frames, uint32_t sampleRate)
{
	QByteArray packet;
	packet.resize(12 + static_cast<qsizetype>(frames) * channels * static_cast<qsizetype>(sizeof(int16_t)));
	char *raw = packet.data();
	raw[0] = 'W';
	raw[1] = 'M';
	raw[2] = 'A';
	raw[3] = '1';
	qToLittleEndian<quint16>(channels, raw + 4);
	qToLittleEndian<quint16>(frames, raw + 6);
	qToLittleEndian<quint32>(sampleRate, raw + 8);
	return packet;
}

int16_t FloatToS16(float sample)
{
	if (sample >= 1.0f) {
		return 32767;
	}
	if (sample <= -1.0f) {
		return -32768;
	}
	return static_cast<int16_t>(std::lrintf(sample * 32767.0f));
}

/* Per-source stereo ring buffer.
 *
 * libobs delivers AUDIO_OUTPUT_FRAMES (1024 frames ~= 21.3 ms at 48 kHz) per
 * callback, while the mixer drains 10 ms slices.  Waiting for ~30 ms before the
 * first drain keeps the read pointer safely behind the producer, and capping at
 * ~120 ms bounds any clock drift. */
struct SourceTrack {
	explicit SourceTrack(obs_source_t *src) : source(src) {}

	void Push(const struct audio_data *data)
	{
		if (!data || data->frames == 0 || activeStreamCount.load(std::memory_order_relaxed) <= 0) {
			return;
		}
		if (!obs_source_active(source)) {
			return;
		}

		const float volume = obs_source_get_volume(source);
		if (volume <= 0.00001f || !data->data[0]) {
			return;
		}

		const uint32_t rate = QuerySampleRate();
		const size_t maxFrames = std::max<size_t>(2048, (static_cast<size_t>(rate) * 12) / 100);
		const size_t primeFrames = std::max<size_t>(1280, (static_cast<size_t>(rate) * 3) / 100);
		const uint32_t ch = QuerySourceChannels();

		const auto *p0 = reinterpret_cast<const float *>(data->data[0]);
		const auto *p1 = reinterpret_cast<const float *>(data->data[1]);
		const auto *p2 = reinterpret_cast<const float *>(data->data[2]);
		const auto *p3 = reinterpret_cast<const float *>(data->data[3]);
		const auto *p4 = reinterpret_cast<const float *>(data->data[4]);
		const auto *p5 = reinterpret_cast<const float *>(data->data[5]);
		const auto *p6 = reinterpret_cast<const float *>(data->data[6]);
		const auto *p7 = reinterpret_cast<const float *>(data->data[7]);

		std::lock_guard<std::mutex> lock(fifoMutex);
		if (capacityFrames != maxFrames) {
			leftRing.assign(maxFrames, 0.0f);
			rightRing.assign(maxFrames, 0.0f);
			capacityFrames = maxFrames;
			readPos = 0;
			available = 0;
			primed = false;
		}

		size_t count = data->frames;
		size_t startOffset = 0;
		if (count > capacityFrames) {
			startOffset = count - capacityFrames;
			count = capacityFrames;
		}
		if (available + count > capacityFrames) {
			const size_t drop = (available + count) - capacityFrames;
			readPos = (readPos + drop) % capacityFrames;
			available -= drop;
		}

		size_t writePos = (readPos + available) % capacityFrames;
		for (size_t i = 0; i < count; i++) {
			const size_t idx = startOffset + i;
			float left = p0[idx];
			float right = (ch >= 2 && p1) ? p1[idx] : left;

			if (ch == 4 && p2 && p3) {
				const float center = (p2[idx] + p3[idx]) * kSurroundMix;
				left += center;
				right += center;
			} else if (ch >= 5) {
				const float fc = p2 ? p2[idx] * kSurroundMix : 0.0f;
				const float rl = p4 ? p4[idx] * kSurroundMix : 0.0f;
				const float rr = p5 ? p5[idx] * kSurroundMix : 0.0f;
				const float sl = (ch >= 7 && p6) ? p6[idx] * kSurroundMix : 0.0f;
				const float sr = (ch >= 8 && p7) ? p7[idx] * kSurroundMix : 0.0f;
				left += fc + rl + sl;
				right += fc + rr + sr;
			}

			leftRing[writePos] = left * volume;
			rightRing[writePos] = right * volume;
			writePos++;
			if (writePos == capacityFrames) {
				writePos = 0;
			}
		}

		available += count;
		if (!primed && available >= primeFrames) {
			primed = true;
		}
	}

	bool MixInto(float *outLeft, float *outRight, size_t frames)
	{
		std::lock_guard<std::mutex> lock(fifoMutex);
		if (!primed || available == 0 || capacityFrames == 0) {
			primed = false;
			return false;
		}

		const size_t take = std::min(frames, available);
		for (size_t i = 0; i < take; i++) {
			outLeft[i] += leftRing[readPos];
			outRight[i] += rightRing[readPos];
			readPos++;
			if (readPos == capacityFrames) {
				readPos = 0;
			}
		}
		available -= take;
		if (available == 0) {
			primed = false;
		}
		return true;
	}

	void Reset()
	{
		std::lock_guard<std::mutex> lock(fifoMutex);
		readPos = 0;
		available = 0;
		primed = false;
	}

	obs_source_t *source = nullptr;

private:
	std::mutex fifoMutex;
	std::vector<float> leftRing;
	std::vector<float> rightRing;
	size_t capacityFrames = 0;
	size_t readPos = 0;
	size_t available = 0;
	bool primed = false;
};

void OnAudioCapture(void *param, obs_source_t *, const struct audio_data *data, bool muted)
{
	UNUSED_PARAMETER(muted);
	if (auto *track = static_cast<SourceTrack *>(param)) {
		track->Push(data);
	}
}

class Hub {
public:
	void Start()
	{
		std::unique_lock<std::mutex> attachLock(attachMutex);
		if (running) {
			return;
		}
		running = true;
		shuttingDown = false;

		{
			std::lock_guard<std::mutex> lock(hubMutex);
			quitWorker = false;
		}
		worker = std::thread([this]() { WorkerLoop(); });

		obs_frontend_add_event_callback(OnFrontendEvent, this);
		if (signal_handler_t *core = obs_get_signal_handler()) {
			signal_handler_connect(core, "source_create", OnCoreSourceCreate, this);
			signal_handler_connect(core, "source_create_canvas", OnCoreSourceCreate, this);
			signal_handler_connect(core, "source_destroy", OnCoreSourceDestroy, this);
			signal_handler_connect(core, "source_remove", OnCoreSourceDestroy, this);
		}

		attachLock.unlock();

		auto enumProc = [](void *param, obs_source_t *source) {
			static_cast<Hub *>(param)->RegisterSource(source);
			return true;
		};
		obs_enum_sources(enumProc, this);
	}

	void Shutdown()
	{
		std::unordered_set<obs_source_t *> toDisconnect;
		std::unordered_map<obs_source_t *, std::shared_ptr<SourceTrack>> toDetach;
		std::thread toJoin;

		{
			std::lock_guard<std::mutex> attachLock(attachMutex);
			if (!running || shuttingDown) {
				return;
			}
			shuttingDown = true;
			running = false;

			if (obs_initialized()) {
				if (signal_handler_t *core = obs_get_signal_handler()) {
					signal_handler_disconnect(core, "source_create", OnCoreSourceCreate, this);
					signal_handler_disconnect(core, "source_create_canvas", OnCoreSourceCreate,
								  this);
					signal_handler_disconnect(core, "source_destroy", OnCoreSourceDestroy, this);
					signal_handler_disconnect(core, "source_remove", OnCoreSourceDestroy, this);
				}
				obs_frontend_remove_event_callback(OnFrontendEvent, this);
			}

			toDisconnect.swap(observedSources);
			toDetach.swap(monitoredTracks);
			RebuildActiveTracksLocked();

			{
				std::lock_guard<std::mutex> lock(hubMutex);
				quitWorker = true;
			}
			wake.notify_all();
			toJoin = std::move(worker);

			if (obs_initialized()) {
				for (obs_source_t *source : toDisconnect) {
					if (signal_handler_t *sh = obs_source_get_signal_handler(source)) {
						signal_handler_disconnect(sh, "monitor", OnSourceMonitor, this);
					}
				}
				for (auto &pair : toDetach) {
					obs_source_remove_audio_capture_callback(pair.first, OnAudioCapture,
										 pair.second.get());
				}
			}
		}

		if (toJoin.joinable()) {
			toJoin.join();
		}

		/* Close any open client sockets on the Qt main thread. */
		if (QCoreApplication *app = QCoreApplication::instance()) {
			auto closeAll = [this]() {
				const std::vector<Stream *> copy = streams;
				for (Stream *stream : copy) {
					delete stream;
				}
			};
			if (QThread::currentThread() == app->thread()) {
				closeAll();
			} else {
				QMetaObject::invokeMethod(app, closeAll, Qt::QueuedConnection);
			}
		}
	}

	void AddStream(Stream *stream)
	{
		streams.push_back(stream);
		const int count = activeStreamCount.fetch_add(1, std::memory_order_relaxed) + 1;
		if (count == 1) {
			ResetAllTrackBuffers();
		}
		{
			std::lock_guard<std::mutex> lock(hubMutex);
			hasStreams = !streams.empty();
		}
		wake.notify_all();
	}

	void RemoveStream(Stream *stream)
	{
		streams.erase(std::remove(streams.begin(), streams.end(), stream), streams.end());
		activeStreamCount.fetch_sub(1, std::memory_order_relaxed);
		{
			std::lock_guard<std::mutex> lock(hubMutex);
			hasStreams = !streams.empty();
		}
		wake.notify_all();
	}

private:
	static void OnFrontendEvent(enum obs_frontend_event event, void *param)
	{
		if (event == OBS_FRONTEND_EVENT_EXIT || event == OBS_FRONTEND_EVENT_SCRIPTING_SHUTDOWN) {
			static_cast<Hub *>(param)->Shutdown();
		}
	}

	static void OnCoreSourceCreate(void *param, calldata_t *data)
	{
		auto *source = static_cast<obs_source_t *>(calldata_ptr(data, "source"));
		if (source) {
			static_cast<Hub *>(param)->RegisterSource(source);
		}
	}

	static void OnCoreSourceDestroy(void *param, calldata_t *data)
	{
		auto *source = static_cast<obs_source_t *>(calldata_ptr(data, "source"));
		if (source) {
			static_cast<Hub *>(param)->UnregisterSource(source);
		}
	}

	static void OnSourceMonitor(void *param, calldata_t *data)
	{
		auto *source = static_cast<obs_source_t *>(calldata_ptr(data, "source"));
		if (!source) {
			return;
		}
		/* libobs emits "monitor" before updating source->monitoring_enabled, so
		 * the new state must be read from the signal's calldata. */
		const bool enabled = calldata_bool(data, "monitor");
		static_cast<Hub *>(param)->SetSourceMonitored(source, enabled);
	}

	void RegisterSource(obs_source_t *source)
	{
		if (!IsAudioInput(source)) {
			return;
		}

		std::lock_guard<std::mutex> attachLock(attachMutex);
		if (!running || shuttingDown) {
			return;
		}
		if (observedSources.insert(source).second) {
			if (signal_handler_t *sh = obs_source_get_signal_handler(source)) {
				signal_handler_connect(sh, "monitor", OnSourceMonitor, this);
			}
		}
		SetSourceMonitoredLocked(source, obs_source_get_monitoring_enabled(source));
	}

	void UnregisterSource(obs_source_t *source)
	{
		std::shared_ptr<SourceTrack> removedTrack;
		{
			std::lock_guard<std::mutex> attachLock(attachMutex);
			if (observedSources.erase(source) > 0) {
				if (signal_handler_t *sh = obs_source_get_signal_handler(source)) {
					signal_handler_disconnect(sh, "monitor", OnSourceMonitor, this);
				}
			}
			auto it = monitoredTracks.find(source);
			if (it != monitoredTracks.end()) {
				removedTrack = std::move(it->second);
				monitoredTracks.erase(it);
				RebuildActiveTracksLocked();
				obs_source_remove_audio_capture_callback(source, OnAudioCapture, removedTrack.get());
			}
		}
	}

	void SetSourceMonitored(obs_source_t *source, bool enabled)
	{
		if (!IsAudioInput(source)) {
			return;
		}
		std::lock_guard<std::mutex> attachLock(attachMutex);
		if (!running || shuttingDown) {
			return;
		}
		SetSourceMonitoredLocked(source, enabled);
	}

	void SetSourceMonitoredLocked(obs_source_t *source, bool enabled)
	{
		auto it = monitoredTracks.find(source);
		if (enabled) {
			if (it != monitoredTracks.end()) {
				return;
			}
			auto track = std::make_shared<SourceTrack>(source);
			monitoredTracks.emplace(source, track);
			obs_source_add_audio_capture_callback(source, OnAudioCapture, track.get());
			RebuildActiveTracksLocked();
		} else if (it != monitoredTracks.end()) {
			std::shared_ptr<SourceTrack> removed = std::move(it->second);
			monitoredTracks.erase(it);
			RebuildActiveTracksLocked();
			obs_source_remove_audio_capture_callback(source, OnAudioCapture, removed.get());
		}
	}

	void RebuildActiveTracksLocked()
	{
		std::vector<std::shared_ptr<SourceTrack>> list;
		list.reserve(monitoredTracks.size());
		for (const auto &pair : monitoredTracks) {
			list.push_back(pair.second);
		}
		monitoredSourceCount.store(static_cast<int>(list.size()), std::memory_order_relaxed);
		{
			std::lock_guard<std::mutex> lock(hubMutex);
			activeTracks.swap(list);
		}
		wake.notify_all();
	}

	void ResetAllTrackBuffers()
	{
		std::vector<std::shared_ptr<SourceTrack>> snapshot;
		{
			std::lock_guard<std::mutex> lock(hubMutex);
			snapshot = activeTracks;
		}
		for (const auto &track : snapshot) {
			track->Reset();
		}
	}

	void Deliver(const QByteArray &packet)
	{
		QCoreApplication *app = QCoreApplication::instance();
		if (!app) {
			return;
		}
		QMetaObject::invokeMethod(
			app,
			[this, packet]() {
				/* Copy in case a write error disconnects a socket mid-loop. */
				const std::vector<Stream *> copy = streams;
				for (Stream *stream : copy) {
					stream->Send(packet);
				}
			},
			Qt::QueuedConnection);
	}

	void WorkerLoop()
	{
		std::vector<float> mixLeft;
		std::vector<float> mixRight;
		uint64_t nextTickNs = 0;

		for (;;) {
			std::vector<std::shared_ptr<SourceTrack>> snapshot;
			bool sendKeepAlive = false;

			{
				std::unique_lock<std::mutex> lock(hubMutex);
				if (!quitWorker && !hasStreams) {
					nextTickNs = 0;
					wake.wait(lock, [this]() { return quitWorker || hasStreams; });
				}
				if (quitWorker) {
					return;
				}
				if (activeTracks.empty()) {
					nextTickNs = 0;
					const bool woke = wake.wait_for(lock, std::chrono::seconds(15), [this]() {
						return quitWorker || !hasStreams || !activeTracks.empty();
					});
					if (quitWorker) {
						return;
					}
					if (!woke && hasStreams && activeTracks.empty()) {
						sendKeepAlive = true;
					} else {
						continue;
					}
				} else {
					snapshot = activeTracks;
				}
			}

			const uint32_t sampleRate = QuerySampleRate();
			currentSampleRate.store(sampleRate, std::memory_order_relaxed);

			if (sendKeepAlive) {
				Deliver(BuildPacketHeader(kChannels, 0, sampleRate));
				continue;
			}

			/* 10 ms slices (480 frames at 48 kHz, 441 frames at 44.1 kHz). */
			const uint16_t chunkFrames = static_cast<uint16_t>(std::max<uint32_t>(1, sampleRate / 100));
			const uint64_t intervalNs = (static_cast<uint64_t>(chunkFrames) * 1000000000ULL) / sampleRate;

			const uint64_t now = os_gettime_ns();
			if (nextTickNs == 0 || now > nextTickNs + 50000000ULL) {
				nextTickNs = now + intervalNs;
			} else {
				nextTickNs += intervalNs;
			}

			mixLeft.assign(chunkFrames, 0.0f);
			mixRight.assign(chunkFrames, 0.0f);

			bool mixedAny = false;
			for (const auto &track : snapshot) {
				if (track->MixInto(mixLeft.data(), mixRight.data(), chunkFrames)) {
					mixedAny = true;
				}
			}

			if (mixedAny) {
				QByteArray packet = BuildPacketHeader(kChannels, chunkFrames, sampleRate);
				char *payload = packet.data() + 12;
				for (uint16_t i = 0; i < chunkFrames; i++) {
					qToLittleEndian<qint16>(FloatToS16(mixLeft[i]), payload);
					qToLittleEndian<qint16>(FloatToS16(mixRight[i]), payload + 2);
					payload += 4;
				}
				Deliver(packet);
				lastKeepAliveNs = nextTickNs;
			} else if (now - lastKeepAliveNs >= 15000000000ULL) {
				Deliver(BuildPacketHeader(kChannels, 0, sampleRate));
				lastKeepAliveNs = now;
			}

			os_sleepto_ns(nextTickNs);
		}
	}

	std::mutex attachMutex;
	bool running = false;
	bool shuttingDown = false;
	std::unordered_set<obs_source_t *> observedSources;
	std::unordered_map<obs_source_t *, std::shared_ptr<SourceTrack>> monitoredTracks;

	std::mutex hubMutex;
	std::condition_variable wake;
	std::vector<std::shared_ptr<SourceTrack>> activeTracks;
	bool hasStreams = false;
	bool quitWorker = false;
	uint64_t lastKeepAliveNs = 0;
	std::thread worker;

	/* Main thread only. */
	std::vector<Stream *> streams;
};

Hub &AudioHub()
{
	static Hub hub;
	return hub;
}

} // namespace

void Start()
{
	AudioHub().Start();
}

void Shutdown()
{
	AudioHub().Shutdown();
}

int ActiveStreams()
{
	return activeStreamCount.load(std::memory_order_relaxed);
}

int MonitoredSources()
{
	return monitoredSourceCount.load(std::memory_order_relaxed);
}

QJsonObject Stats()
{
	QJsonObject stats;
	stats["streams"] = ActiveStreams();
	stats["monitoredSources"] = MonitoredSources();
	stats["sampleRate"] = static_cast<int>(currentSampleRate.load(std::memory_order_relaxed));
	stats["channels"] = static_cast<int>(kChannels);
	stats["sent"] = static_cast<double>(sentPackets.load(std::memory_order_relaxed));
	stats["dropped"] = static_cast<double>(droppedPackets.load(std::memory_order_relaxed));
	return stats;
}

/* ---------------------------------------------------------------- stream -- */

Stream::Stream(QTcpSocket *socket_, QObject *parent) : QObject(parent), socket(socket_) {}

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

	socket->setSocketOption(QAbstractSocket::LowDelayOption, 1);
	socket->setSocketOption(QAbstractSocket::SendBufferSizeSocketOption, kSendBufferBytes);

	QByteArray header;
	header += "HTTP/1.1 200 OK\r\n";
	header += "Content-Type: application/octet-stream\r\n";
	header += "Cache-Control: no-store, no-cache\r\n";
	header += "Pragma: no-cache\r\n";
	header += "X-Accel-Buffering: no\r\n";
	header += "Connection: close\r\n\r\n";
	socket->write(header);

	/* Send an immediate 0-frame header packet so fetch() resolves its
	 * response and knows the sample rate right away even while sources are
	 * silent. */
	const uint32_t sampleRate = QuerySampleRate();
	currentSampleRate.store(sampleRate, std::memory_order_relaxed);
	socket->write(BuildPacketHeader(kChannels, 0, sampleRate));
	socket->flush();

	connect(socket, &QTcpSocket::disconnected, this, [this]() {
		Detach();
		deleteLater();
	});

	AudioHub().AddStream(this);
}

bool Stream::Send(const QByteArray &packet)
{
	if (!socket || socket->state() != QAbstractSocket::ConnectedState) {
		return false;
	}
	if (socket->bytesToWrite() > kMaxQueuedBytes) {
		droppedPackets.fetch_add(1, std::memory_order_relaxed);
		return false;
	}
	if (socket->write(packet) < 0) {
		return false;
	}
	socket->flush();
	sentPackets.fetch_add(1, std::memory_order_relaxed);
	return true;
}

void Stream::Detach()
{
	if (detached) {
		return;
	}
	detached = true;
	if (started) {
		AudioHub().RemoveStream(this);
		if (socket && socket->state() == QAbstractSocket::ConnectedState) {
			socket->disconnectFromHost();
		}
	}
}

} // namespace WebMixAudio
