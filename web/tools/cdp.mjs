/*
 * Shared plumbing for the browser-driven checks: find a Chromium, launch it
 * headless with a private profile, attach to its DevTools endpoint and evaluate
 * expressions in the page.
 *
 * Both browser tools need exactly this and nothing more, so it lives here
 * rather than in one of them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CHROMIUM_CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

/** Absolute path of a Chromium binary, or null when none is installed. */
export function findChromium() {
  for (const name of CHROMIUM_CANDIDATES) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
  }
  return null;
}

/** A private profile directory: without one Chromium hands the request to an
 *  already-running instance and never opens the debugging port. */
export function profileDir(name) {
  return join(tmpdir(), `webmix-chrome-profile-${name}`);
}

/** Minimal DevTools-protocol client over the page target's websocket. */
export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const fn of this.handlers.get(message.method) ?? []) fn(message.params);
      }
    };
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 20000);
    });
  }

  /**
   * Evaluate an expression in the page and return its value.
   * @param {string} expression
   * @param {{awaitPromise?: boolean}} [options] set awaitPromise for a promise
   */
  async evaluate(expression, { awaitPromise = false } = {}) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluation failed');
    }
    return result.value;
  }
}

/** Wait for a page target's debugging websocket URL to appear. */
export async function waitForTarget(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await delay(150);
  }
  throw new Error('Chromium DevTools target did not appear');
}

/** Poll an HTTP URL until it answers 2xx. */
export async function waitForHttp(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* retry */
    }
    await delay(120);
  }
  return false;
}

/**
 * Launch headless Chromium with remote debugging.
 * @returns {import('node:child_process').ChildProcess}
 */
export function launchChromium(chromium, { port, profileDir: dir, windowSize = '1600,900' }) {
  return spawn(
    chromium,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      `--window-size=${windowSize}`,
      `--user-data-dir=${dir}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
}

/** Attach to the browser and return `{ socket, cdp }`. */
export async function attach(port) {
  const target = await waitForTarget(port);
  const socket = new WebSocket(target);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('could not attach to Chromium'));
  });
  return { socket, cdp: new Cdp(socket) };
}

/**
 * A tiny pass/fail recorder with the output style the other checks use.
 * @returns {{check: (label: string, ok: unknown) => void, passed: number, failed: number}}
 */
export function createChecks() {
  const state = { passed: 0, failed: 0 };
  return {
    get passed() {
      return state.passed;
    },
    get failed() {
      return state.failed;
    },
    check(label, ok, detail) {
      if (ok) {
        state.passed++;
        console.log(`ok   ${label}`);
      } else {
        state.failed++;
        const extra = detail === undefined ? '' : ` — ${JSON.stringify(detail)}`;
        console.log(`FAIL ${label}${extra}`);
      }
    },
  };
}
