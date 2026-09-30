/*
 * Minimal RFC 6455 WebSocket server used by the WebMIX test-suite.
 *
 * Implementing this here keeps the tests dependency-free (no `ws` package
 * needed) and lets the tests run offline.  Only the subset of the protocol
 * obs-websocket needs is implemented: text frames, close and ping/pong,
 * with client-to-server masking required as per the RFC.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(payload, opcode = OP.TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

export class WsConnection extends EventEmitter {
  #socket;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOp = null;
  #closed = false;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#onClose());
    socket.on('error', () => this.#onClose());
  }

  get closed() {
    return this.#closed;
  }

  send(text) {
    if (this.#closed) return;
    this.#socket.write(encodeFrame(text, OP.TEXT));
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.#socket.write(encodeFrame(payload, OP.CLOSE));
    this.#closed = true;
    this.#socket.end();
  }

  /** Hard-destroy the socket, simulating a network drop. */
  destroy() {
    this.#closed = true;
    this.#socket.destroy();
  }

  #onClose() {
    if (this.#closed) {
      this.emit('close', 1006, '');
      return;
    }
    this.#closed = true;
    this.emit('close', 1006, '');
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) break;
      this.#handleFrame(frame);
    }
  }

  #readFrame() {
    const buf = this.#buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > 64n * 1024n * 1024n) throw new Error('frame too large');
      len = Number(big);
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;

    let payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.#buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.TEXT:
      case OP.BINARY:
        if (fin) {
          this.emit('message', payload.toString('utf8'));
        } else {
          this.#fragmentOp = opcode;
          this.#fragments = [payload];
        }
        break;
      case OP.CONT: {
        this.#fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.#fragments);
          this.#fragments = [];
          this.emit('message', full.toString('utf8'));
        }
        break;
      }
      case OP.PING:
        this.#socket.write(encodeFrame(payload, OP.PONG));
        break;
      case OP.PONG:
        break;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.#closed) {
          this.#closed = true;
          this.#socket.write(encodeFrame(payload, OP.CLOSE));
          this.#socket.end();
        }
        this.emit('close', code, reason);
        break;
      }
      default:
        this.#socket.destroy();
    }
  }
}

/**
 * Start a WebSocket server.
 * @param {(conn: WsConnection, req: import('node:http').IncomingMessage) => void} onConnection
 * @returns {Promise<{port: number, url: string, close: () => Promise<void>}>}
 */
export function startWsServer(onConnection) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket only');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(new WsConnection(socket), req);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `ws://127.0.0.1:${port}`,
        /** Destroy every live socket so close() cannot deadlock on teardown. */
        destroySockets: () => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
        },
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
