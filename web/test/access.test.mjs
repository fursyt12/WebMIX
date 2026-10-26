/*
 * Sign-in for browsers on other computers: where the sign-in form sends the
 * browser back to, how a lost session is noticed, and the obs-websocket
 * password generator the WebSocket Server Settings dialog uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNext, loginError } from '../src/login.js';
import { signInUrl, installSignInGuard } from '../src/access.js';
import { generatePassword } from '../src/ui/websocket.js';

const page = 'http://192.168.1.20:4456/login.html?next=x';

test('the sign-in form returns to a page of this interface', () => {
  assert.equal(resolveNext(null, page), 'http://192.168.1.20:4456/');
  assert.equal(resolveNext('', page), 'http://192.168.1.20:4456/');
  assert.equal(resolveNext('./', page), 'http://192.168.1.20:4456/');
  assert.equal(resolveNext('./?host=a&port=1#x', page), 'http://192.168.1.20:4456/?host=a&port=1#x');
});

test('the sign-in form never sends the browser to another site', () => {
  for (const next of [
    'http://evil.example/',
    '//evil.example/',
    '/\\evil.example/',
    'https://192.168.1.20:4456/',
    'javascript:alert(1)',
    'data:text/html,hi',
  ]) {
    assert.equal(resolveNext(next, page), 'http://192.168.1.20:4456/', next);
  }
});

test('behind a reverse proxy the way back keeps the proxy path', () => {
  const proxied = 'https://studio.example/obs/login.html?next=.%2F';
  assert.equal(resolveNext('./', proxied), 'https://studio.example/obs/');
  assert.equal(resolveNext('./?a=1', proxied), 'https://studio.example/obs/?a=1');
});

test('a refused sign-in says why', () => {
  /* Without a locale the keys come back as themselves, with %1 filled in. */
  assert.equal(loginError({ error: 'invalid' }, 401), 'WebMix.Login.Invalid');
  assert.equal(loginError({ error: 'invalid', retryAfter: 30 }, 401), 'WebMix.Login.Throttled');
  assert.equal(loginError({ error: 'throttled', retryAfter: 60 }, 429), 'WebMix.Login.Throttled');
  assert.equal(loginError({ error: 'not-configured' }, 403), 'WebMix.Login.NotConfigured');
  assert.equal(loginError(null, 502), 'WebMix.Login.Failed (502)');
});

test('the sign-in address carries the page to come back to', () => {
  const url = signInUrl({ search: '?host=a', hash: '#b' });
  assert.equal(url, 'login.html?next=.%2F%3Fhost%3Da%23b');
  assert.equal(new URLSearchParams(url.split('?')[1]).get('next'), './?host=a#b');
});

test('a 401 from this interface leaves for the sign-in form, once', async () => {
  const replaced = [];
  const statuses = [200, 401, 401];
  const win = {
    location: {
      href: 'http://192.168.1.20:4456/',
      origin: 'http://192.168.1.20:4456',
      search: '',
      hash: '',
      replace: (url) => replaced.push(url),
    },
    fetch: async () => ({ status: statuses.shift() }),
  };
  installSignInGuard(win);
  installSignInGuard(win); // idempotent

  assert.equal((await win.fetch('api/status')).status, 200);
  assert.equal(replaced.length, 0);
  assert.equal((await win.fetch('api/obs/request')).status, 401);
  assert.equal((await win.fetch('api/obs/events')).status, 401);
  assert.deepEqual(replaced, ['login.html?next=.%2F']);
});

test("another site's 401 is none of the interface's business", async () => {
  const replaced = [];
  const win = {
    location: { href: 'http://10.0.0.2:4456/', origin: 'http://10.0.0.2:4456', search: '', hash: '', replace: (u) => replaced.push(u) },
    fetch: async () => ({ status: 401 }),
  };
  installSignInGuard(win);
  await win.fetch('https://api.example/thing');
  assert.equal(replaced.length, 0);
});

test('generated obs-websocket passwords look like the plugin’s', () => {
  const password = generatePassword();
  assert.equal(password.length, 16);
  assert.match(password, /^[A-Za-z0-9]{16}$/);
  assert.notEqual(generatePassword(), password);
  assert.equal(generatePassword(32).length, 32);
});

test('the password generator skips values that would bias it', () => {
  /* 0xFFFFFFFF is above the last whole multiple of 62 and must be redrawn. */
  const draws = [[0xffffffff, 0, 61], [1]];
  const password = generatePassword(3, () => draws.shift());
  assert.equal(password, 'A9B');
});
