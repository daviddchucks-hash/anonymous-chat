'use strict';

/**
 * End-to-end test over real HTTP + WebSocket: boots the actual server
 * (Express + helmet + Socket.IO) on a random port and talks to it with
 * socket.io-client. Requires `npm install` (needs the dev dependency).
 *
 *   npm run test:integration
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: connectClient } = require('socket.io-client');

const { createServer } = require('../server');

const BASE_ENV = {
  NODE_ENV: 'test',
  PORT: '0',
  IP_HASH_SECRET: 'integration-secret',
  MAX_CONNECTIONS_PER_IP: '50', // every test client comes from 127.0.0.1
  RECONNECT_GRACE_MS: '300',
  INTEREST_MATCH_TIMEOUT_MS: '300',
  ADMIN_TOKEN: 'integration-admin-token-0123456789',
};

async function boot(extraEnv = {}) {
  const app = createServer({ ...BASE_ENV, ...extraEnv });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  return { ...app, port, url: `http://127.0.0.1:${port}` };
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function waitFor(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

const emit = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
  });

async function client(url, opts = {}) {
  const socket = connectClient(url, { transports: ['websocket'], reconnection: false, forceNew: true, ...opts });
  const session = await waitFor(socket, 'session');
  return { socket, session };
}

async function matched(url, interest = 'music') {
  const a = await client(url);
  const b = await client(url);
  const ma = waitFor(a.socket, 'match_found');
  const mb = waitFor(b.socket, 'match_found');
  await emit(a.socket, 'find_stranger', { interest });
  await emit(b.socket, 'find_stranger', { interest });
  return { a, b, ma: await ma, mb: await mb };
}

test('HTTP: pages, health check, security headers, 404s', async (t) => {
  const s = await boot();
  t.after(() => s.close());

  const index = await get(`${s.url}/`);
  assert.equal(index.status, 200);
  assert.match(index.body, /Start Chatting/);
  assert.equal((await get(`${s.url}/chat.html`)).status, 200);
  assert.equal((await get(`${s.url}/css/style.css`)).status, 200);
  assert.equal((await get(`${s.url}/js/chat.js`)).status, 200);
  assert.equal((await get(`${s.url}/socket.io/socket.io.js`)).status, 200);

  const health = await get(`${s.url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });

  const h = index.headers;
  assert.equal(h['x-powered-by'], undefined);
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.match(h['content-security-policy'], /script-src 'self'/);
  assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(h['referrer-policy'], 'no-referrer');

  assert.equal((await get(`${s.url}/nope`, { Accept: 'application/json' })).status, 404);
  assert.equal((await get(`${s.url}/..%2f..%2fpackage.json`)).status === 200, false, 'no path traversal');
});

test('admin API: needs the token, lists reports, hidden when no token configured', async (t) => {
  const s = await boot();
  const off = await boot({ ADMIN_TOKEN: '' });
  t.after(() => Promise.all([s.close(), off.close()]));

  assert.equal((await get(`${s.url}/admin/api/stats`)).status, 401);
  assert.equal((await get(`${s.url}/admin/api/stats`, { Authorization: 'Bearer wrong' })).status, 401);
  const ok = await get(`${s.url}/admin/api/stats`, { Authorization: `Bearer ${BASE_ENV.ADMIN_TOKEN}` });
  assert.equal(ok.status, 200);
  assert.ok('moderation' in JSON.parse(ok.body));
  assert.equal((await get(`${off.url}/admin/api/stats`)).status, 404);
});

test('two strangers match, chat, see typing, and the chat can be ended', async (t) => {
  const s = await boot();
  t.after(() => s.close());
  const { a, b, ma, mb } = await matched(s.url);
  t.after(() => { a.socket.close(); b.socket.close(); });

  assert.match(ma.you, /^Stranger-\d{5}$/);
  assert.equal(ma.you, mb.stranger);
  assert.equal(ma.stranger, mb.you);

  // typing
  const typing = waitFor(b.socket, 'typing_start');
  a.socket.emit('typing_start');
  await typing;

  // messages (both sides get them, sender flagged as self)
  const gotB = waitFor(b.socket, 'receive_message');
  const gotA = waitFor(a.socket, 'receive_message');
  const res = await emit(a.socket, 'send_message', { text: 'Hello over a real socket' });
  assert.equal(res.ok, true);
  assert.deepEqual([(await gotA).self, (await gotB).self], [true, false]);

  // the third party gets nothing
  const c = await client(s.url);
  t.after(() => c.socket.close());
  let leaked = false;
  c.socket.on('receive_message', () => { leaked = true; });
  await emit(a.socket, 'send_message', { text: 'still private' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(leaked, false);

  // end
  const endedB = waitFor(b.socket, 'chat_ended');
  await emit(a.socket, 'end_chat');
  assert.deepEqual(await endedB, { reason: 'partner_ended' });
  assert.equal((await emit(b.socket, 'send_message', { text: 'x' })).error, 'not_in_chat');
  assert.equal(s.chat.stats().rooms, 0);
});

test('no identifiers leak in match_found (socket id, ip, room name)', async (t) => {
  const s = await boot();
  t.after(() => s.close());
  const { a, b, ma, mb } = await matched(s.url, 'gaming');
  t.after(() => { a.socket.close(); b.socket.close(); });
  const dump = JSON.stringify([ma, mb]);
  for (const secret of [a.socket.id, b.socket.id, '127.0.0.1', 'room:', a.session.sid, b.session.sid]) {
    assert.equal(dump.includes(secret), false, `leaked ${secret}`);
  }
});

test('markup is delivered as inert text; rate limit and validation work over the wire', async (t) => {
  const s = await boot({ MESSAGE_RATE_WINDOW_MS: '5000', STRIKE_LIMIT: '100' });
  t.after(() => s.close());
  const { a, b } = await matched(s.url);
  t.after(() => { a.socket.close(); b.socket.close(); });

  const evil = '<script>alert(document.cookie)</script><img src=x onerror=alert(1)>';
  const got = waitFor(b.socket, 'receive_message');
  await emit(a.socket, 'send_message', { text: evil });
  assert.equal((await got).text, evil); // literal text; the browser renders it with textContent

  assert.equal((await emit(a.socket, 'send_message', { text: 'x'.repeat(501) })).error, 'too_long');
  assert.equal((await emit(a.socket, 'send_message', { text: 42 })).error, 'invalid_payload');
  let limited;
  for (let i = 0; i < 8 && !limited; i += 1) {
    const r = await emit(a.socket, 'send_message', { text: `spam ${i}` });
    if (!r.ok && r.error === 'rate_limited') limited = r;
  }
  assert.ok(limited, 'rate limit kicks in');
});

test('queue: cancel and disconnect remove waiting users; different interests do not match', async (t) => {
  const s = await boot();
  t.after(() => s.close());
  const a = await client(s.url);
  const b = await client(s.url);
  t.after(() => { a.socket.close(); b.socket.close(); });

  await emit(a.socket, 'find_stranger', { interest: 'music' });
  await emit(b.socket, 'find_stranger', { interest: 'gaming' });
  assert.equal(s.chat.stats().waiting, 2);
  await emit(a.socket, 'cancel_matching');
  assert.equal(s.chat.stats().waiting, 1);
  b.socket.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.chat.stats().waiting, 0);
});

test('reconnect within the grace period resumes the chat; leaving for good ends it', async (t) => {
  const s = await boot();
  t.after(() => s.close());
  const { a, b, ma } = await matched(s.url);
  t.after(() => b.socket.close());

  await emit(a.socket, 'send_message', { text: 'before' });
  const offline = waitFor(b.socket, 'partner_status');
  a.socket.close();
  assert.deepEqual(await offline, { online: false });

  const back = await client(s.url, { auth: { sid: a.session.sid } });
  t.after(() => back.socket.close());
  assert.equal(back.session.state, 'chatting');
  assert.equal(back.session.chat.you, ma.you);
  assert.equal(back.session.chat.messages[0].text, 'before');

  const gone = waitFor(b.socket, 'chat_ended', 4000);
  back.socket.close();
  assert.deepEqual(await gone, { reason: 'partner_disconnected' });
});

test('report and block work over the wire', async (t) => {
  const s = await boot();
  t.after(() => s.close());
  const { a, b } = await matched(s.url);
  t.after(() => { a.socket.close(); b.socket.close(); });

  assert.equal((await emit(a.socket, 'report_user', { reason: 'spam', note: 'ads' })).ok, true);
  assert.equal(s.moderation.list().length, 1);
  assert.equal((await emit(a.socket, 'report_user', { reason: 'nope' })).error, 'invalid_reason');

  const ended = waitFor(b.socket, 'chat_ended');
  assert.equal((await emit(a.socket, 'block_user')).ok, true);
  assert.deepEqual(await ended, { reason: 'partner_ended' });
});

test('cross-origin WebSocket connections are refused unless the origin is allowed', async (t) => {
  const s = await boot({ CORS_ORIGINS: 'https://chat.example.com' });
  t.after(() => s.close());

  const evil = connectClient(s.url, { transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { Origin: 'https://evil.example' } });
  await waitFor(evil, 'connect_error');
  evil.close();

  const allowed = connectClient(s.url, { transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { Origin: 'https://chat.example.com' } });
  await waitFor(allowed, 'session');
  allowed.close();
});

test('abusive client is disconnected and cannot reconnect', async (t) => {
  const s = await boot({ STRIKE_LIMIT: '3' });
  t.after(() => s.close());
  const { a, b } = await matched(s.url);
  t.after(() => { a.socket.close(); b.socket.close(); });

  const kicked = waitFor(a.socket, 'connection_error');
  a.socket.emit('send_message', { text: 'kys' }); // don't await the ack: the server disconnects right after replying
  assert.equal((await kicked).code, 'banned');

  const retry = connectClient(s.url, { transports: ['websocket'], reconnection: false, forceNew: true });
  const err = await waitFor(retry, 'connect_error');
  assert.equal(err.data.code, 'banned');
  retry.close();
});
