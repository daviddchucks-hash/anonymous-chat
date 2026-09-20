'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');
const { ModerationStore } = require('../src/moderation');
const { registerSocketHandlers } = require('../src/socketHandlers');
const { FakeIO } = require('./helpers/fakeIo');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(env = {}) {
  const config = loadConfig({
    IP_HASH_SECRET: 'test-secret',
    RECONNECT_GRACE_MS: '150',
    MAX_CONNECTIONS_PER_IP: '50',
    ...env,
  });
  const io = new FakeIO();
  const moderation = new ModerationStore({
    autoBanThreshold: config.reportAutoBanThreshold,
    banDurationMs: config.banDurationMs,
  });
  const chat = registerSocketHandlers(io, { config, moderation });
  let n = 1;
  const client = (opts = {}) => {
    n += 1;
    const res = io.connect({ ip: `10.0.${Math.floor(n / 250)}.${n % 250}`, ...opts });
    return res;
  };
  const user = (opts) => client(opts).socket;
  return { io, chat, config, moderation, client, user, close: () => chat.close() };
}

async function startChatPair(ctx) {
  const u1 = ctx.user();
  const u2 = ctx.user();
  const chatId1 = u1.last('session').chatId;
  const chatId2 = u2.last('session').chatId;
  const res = await u1.send('start_chat_id', { targetChatId: chatId2 });
  return { u1, u2, chatId1, chatId2, res };
}

/* ----------------------------------- sessions ------------------------------ */

test('a new connection gets a valid Chat ID, private session token, and idle state', () => {
  const ctx = setup();
  const a = ctx.user();
  const session = a.last('session');
  assert.match(session.chatId, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(session.sid, /^[a-f0-9]{48}$/);
  assert.equal(session.state, 'idle');
  assert.equal(session.chat, null);
  assert.equal(session.limits.maxMessageLength, 500);
  ctx.close();
});

test('connecting with a valid requested Chat ID assigns or restores that Chat ID', () => {
  const ctx = setup();
  const targetId = 'AC7K-X92P-Q4LM';
  const a = ctx.user({ auth: { chatId: targetId } });
  assert.equal(a.last('session').chatId, targetId);
  ctx.close();
});

/* -------------------------------- Chat ID chat start ----------------------- */

test('starting a chat with a valid Chat ID connects two users', async () => {
  const ctx = setup();
  const { u1, u2, chatId1, chatId2, res } = await startChatPair(ctx);

  assert.equal(res.ok, true);
  assert.equal(res.peerChatId, chatId2);

  const m1 = u1.last('chat_started');
  const m2 = u2.last('chat_started');
  assert.ok(m1 && m2, 'both users receive chat_started');
  assert.equal(m1.peerChatId, chatId2);
  assert.equal(m2.peerChatId, chatId1);
  assert.deepEqual(ctx.chat.stats(), { users: 2, rooms: 1 });
  ctx.close();
});

test('starting a chat fails for non-existent, invalid, or self Chat IDs', async () => {
  const ctx = setup();
  const u1 = ctx.user();
  const chatId1 = u1.last('session').chatId;

  // invalid format
  assert.equal((await u1.send('start_chat_id', { targetChatId: 'invalid-id' })).error, 'invalid_chat_id');
  // self
  assert.equal((await u1.send('start_chat_id', { targetChatId: chatId1 })).error, 'cannot_chat_self');
  // non-existent
  assert.equal((await u1.send('start_chat_id', { targetChatId: 'AC7K-9999-XXXX' })).error, 'chat_id_not_found');

  ctx.close();
});

test('starting a chat fails if target user is busy in another chat', async () => {
  const ctx = setup();
  const { u1, u2, chatId2 } = await startChatPair(ctx);
  const u3 = ctx.user();

  const res = await u3.send('start_chat_id', { targetChatId: chatId2 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'user_busy');

  ctx.close();
});

test('generate_new_chat_id updates user identity and notifies client', async () => {
  const ctx = setup();
  const u1 = ctx.user();
  const oldChatId = u1.last('session').chatId;

  const res = await u1.send('generate_new_chat_id');
  assert.equal(res.ok, true);
  assert.notEqual(res.chatId, oldChatId);
  assert.match(res.chatId, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const updated = u1.last('identity_updated');
  assert.equal(updated.chatId, res.chatId);

  ctx.close();
});

/* ---------------------------------- messaging ------------------------------ */

test('messages reach only the connected chat partner', async () => {
  const ctx = setup();
  const { u1, u2 } = await startChatPair(ctx);
  const outsider = ctx.user();

  const res = await u1.send('send_message', { text: 'Hello private chat' });
  assert.equal(res.ok, true);

  const m1 = u1.last('receive_message');
  const m2 = u2.last('receive_message');
  assert.equal(m1.text, 'Hello private chat');
  assert.equal(m1.self, true);
  assert.equal(m2.text, 'Hello private chat');
  assert.equal(m2.self, false);
  assert.equal(outsider.last('receive_message'), undefined);

  ctx.close();
});

test('typing_start / typing_stop are relayed to partner', async () => {
  const ctx = setup();
  const { u1, u2 } = await startChatPair(ctx);

  await u1.send('typing_start');
  assert.ok(u2.last('typing_start'));
  assert.equal(u1.last('typing_start'), undefined);

  await u1.send('typing_stop');
  assert.ok(u2.last('typing_stop'));

  ctx.close();
});

/* ----------------------------------- ending -------------------------------- */

test('end_chat ends the room for both users', async () => {
  const ctx = setup();
  const { u1, u2 } = await startChatPair(ctx);

  const res = await u1.send('end_chat');
  assert.deepEqual(res, { ok: true, ended: true });
  assert.deepEqual(u1.last('chat_ended'), { reason: 'you_ended' });
  assert.deepEqual(u2.last('chat_ended'), { reason: 'partner_ended' });
  assert.equal(ctx.chat.stats().rooms, 0);

  assert.equal((await u1.send('send_message', { text: 'test' })).error, 'not_in_chat');
  ctx.close();
});

/* ----------------------------- disconnect / reconnect ---------------------- */

test('reconnecting with session token resumes the chat session', async () => {
  const ctx = setup();
  const { u1, u2, chatId2 } = await startChatPair(ctx);

  await u1.send('send_message', { text: 'message 1' });
  const sid = u1.last('session').sid;

  u1.drop();
  assert.deepEqual(u2.last('partner_status'), { online: false });

  const u1b = ctx.user({ auth: { sid } });
  const session = u1b.last('session');
  assert.equal(session.state, 'chatting');
  assert.equal(session.chat.peerChatId, chatId2);
  assert.equal(session.chat.messages[0].text, 'message 1');

  ctx.close();
});

/* ----------------------------- report / block ------------------------------ */

test('report_user stores minimal report with partner Chat ID', async () => {
  const ctx = setup();
  const { u1, u2, chatId2 } = await startChatPair(ctx);

  const res = await u1.send('report_user', { reason: 'spam', note: 'annoying' });
  assert.equal(res.ok, true);

  const [report] = ctx.moderation.list();
  assert.equal(report.reason, 'spam');
  assert.equal(report.alias, chatId2);

  ctx.close();
});

test('block_user ends chat and prevents future chat initiation with that Chat ID', async () => {
  const ctx = setup();
  const { u1, u2, chatId2 } = await startChatPair(ctx);

  assert.equal((await u1.send('block_user')).ok, true);
  assert.deepEqual(u1.last('chat_ended'), { reason: 'you_ended' });
  assert.deepEqual(u2.last('chat_ended'), { reason: 'partner_ended' });

  // Attempt to start chat again with blocked user fails
  const retryRes = await u1.send('start_chat_id', { targetChatId: chatId2 });
  assert.equal(retryRes.ok, false);
  assert.equal(retryRes.error, 'chat_id_not_found');

  ctx.close();
});
