'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: connectClient } = require('socket.io-client');

const { createServer } = require('../server');

const BASE_ENV = {
  NODE_ENV: 'test',
  PORT: '0',
  IP_HASH_SECRET: 'integration-secret',
  MAX_CONNECTIONS_PER_IP: '50',
  RECONNECT_GRACE_MS: '300',
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

test('HTTP: health check, security headers, 404s', async (t) => {
  const s = await boot();
  t.after(() => s.close());

  const health = await get(`${s.url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });

  assert.equal((await get(`${s.url}/nope`, { Accept: 'application/json' })).status, 404);
});

test('Chat ID connection, chat start, messaging, and chat ending', async (t) => {
  const s = await boot();
  t.after(() => s.close());

  const u1 = await client(s.url);
  const u2 = await client(s.url);
  t.after(() => { u1.socket.close(); u2.socket.close(); });

  assert.match(u1.session.chatId, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(u2.session.chatId, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const startMsg = waitFor(u2.socket, 'chat_started');
  const startRes = await emit(u1.socket, 'start_chat_id', { targetChatId: u2.session.chatId });
  assert.equal(startRes.ok, true);
  assert.equal((await startMsg).peerChatId, u1.session.chatId);

  // Messaging
  const msgPromise = waitFor(u2.socket, 'receive_message');
  await emit(u1.socket, 'send_message', { text: 'Hello via Chat ID' });
  const received = await msgPromise;
  assert.equal(received.text, 'Hello via Chat ID');
  assert.equal(received.self, false);

  // End chat
  const endedPromise = waitFor(u2.socket, 'chat_ended');
  await emit(u1.socket, 'end_chat');
  assert.deepEqual(await endedPromise, { reason: 'partner_ended' });
});
