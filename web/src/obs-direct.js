/*
 * WebMIX - native control client.
 *
 * This is the transport the UI is meant to use: the page is served by OBS
 * itself and talks to the control service *inside* OBS over plain HTTP and
 * Server-Sent Events.  No obs-websocket, no second port, no password, no
 * plugin to enable - the browser addresses the program directly.
 *
 *   POST api/obs/request   {requestType, requestData}
 *                          -> {requestType, requestStatus, responseData}
 *   POST api/obs/batch     {requests:[...]}
 *                          -> {results:[...]}
 *   GET  api/obs/events    text/event-stream of
 *                          {eventType, eventIntent, eventData}
 *
 * The class deliberately mirrors ObsClient's surface exactly (connect,
 * request, requestBatch, getVersion, the same events and error types), so the
 * rest of the frontend - the store reducers, ObsApi and every panel - is
 * transport-agnostic and needed no changes.
 *
 * Why fetch() and not EventSource: the stream has to be abortable on
 * disconnect and reconnected with our own backoff, and EventSource offers
 * neither.  Reading the body stream also keeps the reconnect policy in one
 * place instead of split between the browser and this file.
 */
import { Emitter, ObsConnectionError, ObsRequestError } from './obs-client.js';
import { RequestBatchExecutionType } from './protocol.js';

/** Request types the batch endpoint will accept in one round trip. */
const MAX_BATCH = 512;

export class ObsDirectClient extends Emitter {
  /**
   * @param {object} [options]
   * @param {string} [options.base]   absolute base URL; '' means same origin
   * @param {number} [options.intents] event subscription bits (server default
   *                                   when omitted)
   * @param {boolean} [options.autoReconnect]
   * @param {number}  [options.requestTimeout] ms, default 10000
   */
  constructor(options = {}) {
    super();
    this.base = options.base ?? '';
    this.intents = options.intents;
    this.autoReconnect = options.autoReconnect ?? true;
    this.requestTimeout = options.requestTimeout ?? 10000;
    this.reconnectBaseDelay = options.reconnectBaseDelay ?? 800;
    this.reconnectMaxDelay = options.reconnectMaxDelay ?? 15000;

    this.url = `${this.base || (typeof location !== 'undefined' ? location.origin : '')} (native)`;
    this.status = 'disconnected';
    this.lastError = null;
    this.version = null;

    this.#streamAbort = null;
    this.#reconnectAttempts = 0;
    this.#reconnectTimer = null;
    this.#intentionalClose = false;
    this.#connectPromise = null;
  }

  #open = false;
  #streamAbort;
  #reconnectAttempts;
  #reconnectTimer;
  #intentionalClose;
  #connectPromise;

  get connected() {
    return this.#open;
  }

  /** Native mode has nothing to configure; kept for interface parity. */
  configure({ base } = {}) {
    if (base !== undefined) {
      this.base = base;
      this.url = `${base} (native)`;
    }
    return this;
  }

  #endpoint(path) {
    return `${this.base}${path}`;
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Verify the control channel exists, then open the event stream.
   * @returns {Promise<{native: true, requestTypes: number, url: string}>}
   */
  connect() {
    if (this.connected) return Promise.resolve(this.#info());
    if (this.#connectPromise) return this.#connectPromise;

    this.#intentionalClose = false;
    this.#setStatus(this.#reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const promise = this.#openStream()
      .then((info) => {
        this.#reconnectAttempts = 0;
        return info;
      })
      .catch((err) => {
        this.#setStatus('disconnected');
        this.lastError = err;
        if (!this.#intentionalClose) this.#scheduleReconnect();
        throw err;
      });

    this.#connectPromise = promise;
    const clear = () => {
      if (this.#connectPromise === promise) this.#connectPromise = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  async #openStream() {
    /* One cheap request first: a page served by a static host that happens to
     * answer /api/obs/events with index.html must fail here, loudly, instead
     * of appearing to connect and then never producing an event. */
    let requestTypes = 0;
    try {
      const response = await fetch(this.#endpoint('api/obs/requests'), { cache: 'no-store' });
      if (!response.ok) {
        throw new ObsConnectionError(
          `No native OBS control channel at ${this.base || location.origin} (HTTP ${response.status})`
        );
      }
      const payload = await response.json();
      requestTypes = Array.isArray(payload?.requests) ? payload.requests.length : 0;
    } catch (err) {
      if (err instanceof ObsConnectionError) throw err;
      throw new ObsConnectionError(
        `No native OBS control channel at ${this.base || location.origin}: ${err.message}`
      );
    }

    const abort = new AbortController();
    this.#streamAbort = abort;
    const query = this.intents === undefined ? '' : `?intents=${Number(this.intents)}`;
    let response;
    try {
      response = await fetch(this.#endpoint(`api/obs/events${query}`), {
        cache: 'no-store',
        headers: { Accept: 'text/event-stream' },
        signal: abort.signal,
      });
    } catch (err) {
      throw new ObsConnectionError(`Could not open the event stream: ${err.message}`);
    }
    if (!response.ok || !response.body) {
      throw new ObsConnectionError(`The event stream was refused (HTTP ${response.status})`);
    }

    this.#open = true;
    this.#setStatus('connected');
    const info = { ...this.#info(), requestTypes };
    this.emit('connected', info);

    /* The reader loop runs until the stream ends or is aborted; the connect()
     * promise must resolve now, not when the stream eventually closes. */
    this.#readStream(response.body).catch((err) => {
      if (this.#intentionalClose) return;
      this.#open = false;
      this.#setStatus('disconnected');
      this.emit('disconnected', { code: 1006, reason: err.message });
      this.#scheduleReconnect();
    });

    return info;
  }

  async #readStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      /* SSE frames are separated by a blank line. */
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.#handleFrame(frame);
      }
      // A very long line with no terminator would grow without bound.
      if (buffer.length > 8 * 1024 * 1024) buffer = '';
    }

    if (!this.#intentionalClose) {
      throw new ObsConnectionError('The OBS event stream ended');
    }
  }

  #handleFrame(frame) {
    const data = [];
    for (const line of frame.split('\n')) {
      // Comments (`: ping`) and unknown fields are ignored by the SSE spec.
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;

    let message;
    try {
      message = JSON.parse(data.join('\n'));
    } catch {
      this.emit('protocolError', 'Received a non-JSON event frame');
      return;
    }

    const { eventType, eventIntent, eventData } = message ?? {};
    if (!eventType) {
      this.emit('protocolError', 'Received an event frame without an eventType');
      return;
    }
    this.emit(eventType, eventData ?? {}, eventIntent);
    this.emit('event', { eventType, eventIntent, eventData: eventData ?? {} });
  }

  disconnect() {
    this.#intentionalClose = true;
    this.#clearReconnect();
    this.#reconnectAttempts = 0;
    this.#open = false;
    if (this.#streamAbort) {
      try {
        this.#streamAbort.abort();
      } catch {
        /* already gone */
      }
      this.#streamAbort = null;
    }
    this.#setStatus('disconnected');
  }

  #info() {
    return { native: true, url: this.url, obsWebSocketVersion: null, negotiatedRpcVersion: null };
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  /* ------------------------------------------------------------ requests */

  async request(requestType, requestData = {}, { timeout = this.requestTimeout } = {}) {
    if (!this.connected) {
      throw new ObsConnectionError('Not connected to OBS');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let payload;
    try {
      const response = await fetch(this.#endpoint('api/obs/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType, requestData }),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new ObsConnectionError(`${requestType} failed (HTTP ${response.status})`);
      }
      payload = await response.json();
    } catch (err) {
      if (err instanceof ObsConnectionError) throw err;
      if (err.name === 'AbortError') {
        throw new ObsConnectionError(`Request ${requestType} timed out after ${timeout} ms`);
      }
      throw new ObsConnectionError(`Failed to send ${requestType}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    this.emit('response', payload);
    if (!payload?.requestStatus?.result) {
      throw new ObsRequestError(payload?.requestType ?? requestType, payload?.requestStatus, payload?.responseData);
    }
    return payload.responseData ?? {};
  }

  /**
   * Run a batch of requests in one round trip.  Like ObsClient, individual
   * failures do not reject: the caller inspects each `requestStatus`, which is
   * what `ObsApi.refreshAll` does.
   */
  async requestBatch(requests, executionType = RequestBatchExecutionType.SerialRealtime) {
    if (!this.connected) {
      throw new ObsConnectionError('Not connected to OBS');
    }
    const normalized = requests.map((entry) =>
      typeof entry === 'string'
        ? { requestType: entry }
        : { requestType: entry.requestType, requestData: entry.requestData ?? {} }
    );

    /* The server bounds a batch; split rather than refusing to work. */
    const results = [];
    for (let index = 0; index < normalized.length; index += MAX_BATCH) {
      const slice = normalized.slice(index, index + MAX_BATCH);
      let payload;
      try {
        const response = await fetch(this.#endpoint('api/obs/batch'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: slice, executionType }),
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new ObsConnectionError(`Request batch failed (HTTP ${response.status})`);
        }
        payload = await response.json();
      } catch (err) {
        if (err instanceof ObsConnectionError) throw err;
        throw new ObsConnectionError(`Failed to send batch: ${err.message}`);
      }
      results.push(...(payload?.results ?? []));
    }
    return results;
  }

  /* ------------------------------------------------------------ reconnect */

  #scheduleReconnect() {
    if (!this.autoReconnect || this.#intentionalClose) return;
    this.#reconnectAttempts++;
    const delay = Math.min(
      this.reconnectBaseDelay * 2 ** (this.#reconnectAttempts - 1),
      this.reconnectMaxDelay
    );
    const jittered = delay * (0.8 + Math.random() * 0.4);
    this.emit('reconnecting', { attempt: this.#reconnectAttempts, delay: Math.round(jittered) });
    this.#clearReconnect();
    this.#reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.lastError = err;
        this.emit('reconnectFailed', err);
      });
    }, jittered);
    if (this.#reconnectTimer?.unref) this.#reconnectTimer.unref();
  }

  #clearReconnect() {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  /* -------------------------------------------------------------- helpers */

  /** Cached GetVersion (cleared on reconnect). */
  async getVersion({ force = false } = {}) {
    if (!this.version || force) {
      this.version = await this.request('GetVersion');
    }
    return this.version;
  }
}
