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
#include <QJsonObject>
#include <QObject>
#include <QPointer>

class QTcpSocket;

/* WebMIX: live audio monitoring for the browser.
 *
 * In web mode OBS suppresses its local OS monitoring backend (see
 * obs_set_audio_monitoring_suppressed) so monitored sources never play out of
 * the host machine's speakers.  Instead, every input with monitoring enabled is
 * tapped here through obs_source_add_audio_capture_callback, mixed into 10 ms
 * stereo PCM packets on a dedicated worker thread, and streamed over HTTP
 * (`GET /api/audio`) to every open browser tab.
 *
 * Each packet starts with a 12-byte little-endian header:
 *
 *   0..3   "WMA1"
 *   4..5   uint16 channels   (2)
 *   6..7   uint16 frames     (0 for a keep-alive packet)
 *   8..11  uint32 sampleRate (OBS's audio output rate, typically 48000)
 *
 * followed by `frames * channels * 2` bytes of interleaved signed 16-bit
 * little-endian PCM.  Dropping whole packets when a slow client's send buffer
 * fills keeps latency bounded without ever breaking sample or channel
 * alignment. */
namespace WebMixAudio {

/*! Hook libobs signals and start the mixer thread. */
void Start();

/*! Detach every source callback, stop the mixer thread and close streams.
 *  Safe to call more than once; must run before libobs shuts down. */
void Shutdown();

/*! Open `/api/audio` client count. */
int ActiveStreams();

/*! Number of inputs that currently have audio monitoring enabled. */
int MonitoredSources();

/*! Pipeline state for `/api/status`. */
QJsonObject Stats();

/*!
 * One browser client listening on `/api/audio`: writes the HTTP headers, then
 * forwards framed PCM packets while the socket keeps up.
 */
class Stream : public QObject {
	Q_OBJECT

public:
	explicit Stream(QTcpSocket *socket, QObject *parent = nullptr);
	~Stream() override;

	/*! Send response headers and subscribe to the live monitor mix. */
	void Start();

	/*! Write one framed packet if the socket send queue is within bounds. */
	bool Send(const QByteArray &packet);

	/*! Maximum concurrent `/api/audio` clients. */
	static constexpr int kMaxStreams = 16;

private:
	void Detach();

	QPointer<QTcpSocket> socket;
	bool started = false;
	bool detached = false;
};

} // namespace WebMixAudio
