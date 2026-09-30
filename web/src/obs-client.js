/*
 * WebMIX - obs-websocket v5 client.
 *
 * Pure ES module client used by the WebMIX web frontend.  Implements the
 * obs-websocket 5.x protocol: Hello/Identify/Identified handshake, request /
 * response correlation, request batches, event dispatch and automatic
 * reconnection with exponential backoff.
 *
 * Works in browsers and in Node (global WebSocket), so the same code path is
 * exercised by the test-suite against a mock server.
 */
import { EventSubscription, RequestStatus, RequestBatchExecutionType } from './protocol.js';
import { buildAuthString } from './hash.js';

export const OpCode = Object.freeze({
  Hello: 0,
  Identify: 1,
  Identified: 2,
  Reidentify: 3,
  Event: 5,
  Request: 6,
  RequestResponse: 7,
  RequestBatch: 8,
  RequestBatchResponse: 9,
});

export const CLOSE_REASONS = Object.freeze({
  4000: 'Unknown reason',
  4002: 'Message decode error',
  4003: 'Missing data field',
  4004: 'Invalid data field type',
  4005: 'Invalid data field value',
  4006: 'Unknown op code',
  4007: 'Not identified',
  4008: 'Already identified',
  4009: 'Authentication failed',
  4010: 'Unsupported RPC version',
  4011: 'Session invalidated',
  4012: 'Unsupported feature',
});

/** Error thrown when OBS answers a request with a non-success status. */
export class ObsRequestError extends Error {
  constructor(requestType, requestStatus, responseData) {
    const code = requestStatus?.code;
    const comment = requestStatus?.comment ? `: ${requestStatus.comment}` : '';
    super(`${requestType} failed (code ${code}${comment})`);
    this.name = 'ObsRequestError';
    this.requestType = requestType;
    this.code = code;
    this.comment = requestStatus?.comment ?? '';
    this.responseData = responseData;
    this.isRequestError = true;
  }
}

/** Error thrown for transport / lifecycle problems (not OBS request errors). */
export class ObsConnectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ObsConnectionError';
    this.code = code;
  }
}

/* ----------------------------------------------------------------- emitter */

class Emitter {
  #listeners = new Map();

  on(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }

  once(type, fn) {
    const wrapped = (...args) => {
      this.off(type, wrapped);
      fn(...args);
    };
    return this.on(type, wrapped);
  }

  emit(type, ...args) {
    const set = this.#listeners.get(type);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(...args);
        } catch (err) {
          // A broken listener must not break the protocol loop.
          console.error(`[obs] listener for "${type}" threw`, err);
        }
      }
    }
    const any = this.#listeners.get('*');
    if (any) {
      for (const fn of [...any]) {
        try {
          fn(type, ...args);
        } catch (err) {
          console.error('[obs] wildcard listener threw', err);
        }
      }
    }
  }

  removeAllListeners() {
    this.#listeners.clear();
  }
}

/* ------------------------------------------------------------------ client */

const DEFAULT_SUBSCRIPTIONS =
  EventSubscription.All |
  EventSubscription.InputVolumeMeters |
  EventSubscription.InputActiveStateChanged |
  EventSubscription.InputShowStateChanged;

export class ObsClient extends Emitter {
  /**
   * @param {object} [options]
   * @param {string} [options.url]      e.g. ws://127.0.0.1:4455
   * @param {string} [options.host]
   * @param {number} [options.port]
   * @param {string} [options.password]
   * @param {boolean} [options.secure]  use wss://
   * @param {number}  [options.eventSubscriptions]
   * @param {boolean} [options.autoReconnect]
   * @param {number}  [options.requestTimeout]  ms, default 10000
   */
  constructor(options = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 4455;
    this.password = options.password ?? '';
    this.secure = options.secure ?? false;
    this.url = options.url ?? this.#buildUrl();
    this.eventSubscriptions = options.eventSubscriptions ?? DEFAULT_SUBSCRIPTIONS;
    this.autoReconnect = options.autoReconnect ?? true;
    this.requestTimeout = options.requestTimeout ?? 10000;
    this.reconnectBaseDelay = options.reconnectBaseDelay ?? 800;
    this.reconnectMaxDelay = options.reconnectMaxDelay ?? 15000;
    this.identifyTimeout = options.identifyTimeout ?? 8000;

    this.socket = null;
    this.identified = false;
    this.negotiatedRpcVersion = null;
    this.obsWebSocketVersion = null;
    this.version = null; // cached GetVersion response
    this.status = 'disconnected';
    this.lastError = null;

    this.#nextRequestId = 1;
    this.#pending = new Map();
    this.#reconnectAttempts = 0;
    this.#reconnectTimer = null;
    this.#intentionalClose = false;
    this.#connectPromise = null;
  }

  #nextRequestId;
  #pending;
  #reconnectAttempts;
  #reconnectTimer;
  #intentionalClose;
  #connectPromise;

  #buildUrl() {
    const scheme = this.secure ? 'wss' : 'ws';
    return `${scheme}://${this.host}:${this.port}`;
  }

  get connected() {
    return this.identified && this.socket?.readyState === 1;
  }

  /** Update connection target; takes effect on the next connect(). */
  configure({ host, port, password, secure, url } = {}) {
    if (host !== undefined) this.host = host;
    if (port !== undefined) this.port = port;
    if (password !== undefined) this.password = password;
    if (secure !== undefined) this.secure = secure;
    this.url = url ?? this.#buildUrl();
    return this;
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Open the connection and complete the handshake.
   * @returns {Promise<{obsWebSocketVersion: string, negotiatedRpcVersion: number}>}
   */
  connect() {
    if (this.connected) return Promise.resolve(this.#identifiedInfo());
    if (this.#connectPromise) return this.#connectPromise;

    this.#intentionalClose = false;
    this.#setStatus(this.#reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const promise = new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        this.#setStatus('disconnected');
        reject(new ObsConnectionError(`Cannot open ${this.url}: ${err.message}`));
        return;
      }
      this.socket = socket;

      const identifyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#connectPromise = null;
        try { socket.close(); } catch { /* ignore */ }
        reject(new ObsConnectionError(`Handshake with ${this.url} timed out`));
      }, this.identifyTimeout);

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(identifyTimer);
        reject(err);
      };

      socket.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          this.emit('protocolError', 'Received non-JSON message');
          return;
        }

        switch (msg.op) {
          case OpCode.Hello: {
            this.obsWebSocketVersion = msg.d?.obsWebSocketVersion ?? null;
            this.emit('hello', msg.d);
            const identify = {
              rpcVersion: msg.d?.rpcVersion ?? 1,
              eventSubscriptions: this.eventSubscriptions,
            };
            const auth = msg.d?.authentication;
            if (auth) {
              if (!this.password) {
                fail(
                  new ObsConnectionError(
                    'OBS requires a password, but none was provided',
                    4009
                  )
                );
                try { socket.close(); } catch { /* ignore */ }
                return;
              }
              identify.authentication = buildAuthString(this.password, auth.salt, auth.challenge);
            }
            socket.send(JSON.stringify({ op: OpCode.Identify, d: identify }));
            break;
          }

          case OpCode.Identified: {
            this.identified = true;
            this.negotiatedRpcVersion = msg.d?.negotiatedRpcVersion ?? null;
            this.#reconnectAttempts = 0;
            this.#setStatus('connected');
            clearTimeout(identifyTimer);
            if (!settled) {
              settled = true;
              resolve(this.#identifiedInfo());
            }
            this.emit('connected', this.#identifiedInfo());
            break;
          }

          case OpCode.Event: {
            const { eventType, eventIntent, eventData } = msg.d ?? {};
            this.emit(eventType, eventData ?? {}, eventIntent);
            this.emit('event', { eventType, eventIntent, eventData: eventData ?? {} });
            break;
          }

          case OpCode.RequestResponse: {
            this.#handleResponse(msg.d);
            break;
          }

          case OpCode.RequestBatchResponse: {
            this.#handleBatchResponse(msg.d);
            break;
          }

          default:
            this.emit('protocolError', `Unknown op code ${msg.op}`);
        }
      };

      socket.onerror = () => {
        // The error event carries no detail; onclose reports the reason.
        this.emit('socketError');
      };

      socket.onclose = (event) => {
        const wasIdentified = this.identified;
        this.identified = false;
        this.socket = null;
        this.#rejectAllPending(
          new ObsConnectionError(
            `Disconnected from OBS (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`,
            event.code
          )
        );

        if (!settled) {
          settled = true;
          clearTimeout(identifyTimer);
          reject(this.#closeError(event));
        } else if (wasIdentified) {
          this.#setStatus('disconnected');
          this.emit('disconnected', { code: event.code, reason: event.reason });
        }

        if (!this.#intentionalClose) this.#scheduleReconnect(event.code);
      };
    });

    this.#connectPromise = promise;
    const clear = () => {
      if (this.#connectPromise === promise) this.#connectPromise = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  disconnect(code = 1000, reason = 'WebMIX client closing') {
    this.#intentionalClose = true;
    this.#clearReconnect();
    this.#reconnectAttempts = 0;
    if (this.socket) {
      try {
        this.socket.close(code, reason);
      } catch { /* ignore */ }
    }
    this.socket = null;
    this.identified = false;
    this.#setStatus('disconnected');
  }

  /** Re-identify with a changed event subscription set (op 3). */
  reidentify(eventSubscriptions = this.eventSubscriptions) {
    this.eventSubscriptions = eventSubscriptions;
    if (this.connected) {
      this.socket.send(
        JSON.stringify({ op: OpCode.Reidentify, d: { eventSubscriptions } })
      );
    }
    return this;
  }

  #identifiedInfo() {
    return {
      obsWebSocketVersion: this.obsWebSocketVersion,
      negotiatedRpcVersion: this.negotiatedRpcVersion,
      url: this.url,
    };
  }

  #closeError(event) {
    const reason = CLOSE_REASONS[event.code];
    return new ObsConnectionError(
      `Could not connect to ${this.url} (code ${event.code}${reason ? `: ${reason}` : ''})`,
      event.code
    );
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  /* ------------------------------------------------------------- request */

  request(requestType, requestData = {}, { timeout = this.requestTimeout } = {}) {
    if (!this.connected) {
      return Promise.reject(new ObsConnectionError('Not connected to OBS'));
    }
    const requestId = String(this.#nextRequestId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new ObsConnectionError(`Request ${requestType} timed out after ${timeout} ms`));
      }, timeout);

      this.#pending.set(requestId, { requestType, resolve, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({ op: OpCode.Request, d: { requestType, requestId, requestData } })
        );
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(new ObsConnectionError(`Failed to send ${requestType}: ${err.message}`));
      }
    });
  }

  /**
   * Run a batch of requests in one round-trip.
   * @param {Array<{requestType: string, requestData?: object}>} requests
   * @param {number} [executionType] RequestBatchExecutionType
   * @returns {Promise<Array<{requestType: string, requestStatus: object, responseData: object}>>}
   */
  requestBatch(requests, executionType = RequestBatchExecutionType.SerialRealtime) {
    if (!this.connected) {
      return Promise.reject(new ObsConnectionError('Not connected to OBS'));
    }
    const requestId = `batch-${this.#nextRequestId++}`;
    const normalized = requests.map((r) =>
      typeof r === 'string' ? { requestType: r } : { requestType: r.requestType, requestData: r.requestData ?? {} }
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new ObsConnectionError('Request batch timed out'));
      }, this.requestTimeout);
      this.#pending.set(requestId, { requestType: 'RequestBatch', resolve, reject, timer, isBatch: true });
      try {
        this.socket.send(
          JSON.stringify({
            op: OpCode.RequestBatch,
            d: { requestId, requests: normalized, executionType },
          })
        );
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(new ObsConnectionError(`Failed to send batch: ${err.message}`));
      }
    });
  }

  #handleResponse(d) {
    const entry = this.#pending.get(d.requestId);
    if (!entry) return;
    this.#pending.delete(d.requestId);
    clearTimeout(entry.timer);
    this.emit('response', d);
    if (d.requestStatus?.result) {
      entry.resolve(d.responseData ?? {});
    } else {
      entry.reject(new ObsRequestError(d.requestType, d.requestStatus, d.responseData));
    }
  }

  #handleBatchResponse(d) {
    const entry = this.#pending.get(d.requestId);
    if (!entry) return;
    this.#pending.delete(d.requestId);
    clearTimeout(entry.timer);
    entry.resolve(d.results ?? []);
  }

  #rejectAllPending(err) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.#pending.clear();
  }

  /* ----------------------------------------------------------- reconnect */

  #scheduleReconnect(code) {
    if (!this.autoReconnect || this.#intentionalClose) return;
    // A failed authentication or an invalidated session is not helped by an
    // immediate retry loop; surface it and let the UI re-prompt for details.
    if (code === 4009 || code === 4011) {
      this.emit('authfailed', code);
      return;
    }
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

  /* ------------------------------------------------------------ helpers */

  /** Cached GetVersion (cleared on reconnect). */
  async getVersion({ force = false } = {}) {
    if (!this.version || force) {
      this.version = await this.request('GetVersion');
    }
    return this.version;
  }

  /**
   * Resolve request names to request types from protocol metadata, and
   * validate the fields being sent.  Throws on unknown request types and
   * reports unknown/misspelled fields, which catches typos early.
   * @returns {{ok: true} | {ok: false, errors: string[]}}
   */
  static validate(requestType, requestData, REQUESTS) {
    const meta = REQUESTS[requestType];
    if (!meta) return { ok: false, errors: [`Unknown request type "${requestType}"`] };
    const known = new Set(meta.fields.map((f) => f.name));
    const errors = [];
    for (const key of Object.keys(requestData ?? {})) {
      if (!known.has(key)) errors.push(`${requestType}: unknown field "${key}"`);
    }
    for (const f of meta.fields) {
      if (!f.optional && !(f.name in (requestData ?? {}))) {
        errors.push(`${requestType}: missing required field "${f.name}"`);
      }
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  }
}

export { EventSubscription, RequestStatus, DEFAULT_SUBSCRIPTIONS };
