'use strict';

/**
 * Behavioural tests of the real handler code in src/socketHandlers.js, driven
 * through an in-memory Socket.IO stand-in (test/helpers/fakeIo.js).
 * Real network transport is covered separately by test/integration.test.js.
 */
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
    INTEREST_MATCH_TIMEOUT_MS: '150',
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
  /** connect a client, each from a different IP unless told otherwise */
  const client = (opts = {}) => {
    n += 1;
    const res = io.connect({ ip: `10.0.${Math.floor(n / 250)}.${n % 250}`, ...opts });
    return res;
  };
  const user = (opts) => client(opts).socket;
  return { io, chat, config, moderation, client, user, close: () => chat.close() };
}

/** Connect two users and match them on `interest`. */
async function matchedPair(ctx, interest = 'music') {
  const a = ctx.user();
  const b = ctx.user();
  await a.send('find_stranger', { interest });
  await b.send('find_stranger', { interest });
  return { a, b };
}

/* ----------------------------------- sessions ------------------------------ */

test('a new connection gets a private session token and idle state', () => {
  const ctx = setup();
  const a = ctx.user();
  const session = a.last('session');
  assert.match(session.sid, /^[a-f0-9]{48}$/);
  assert.equal(session.state, 'idle');
  assert.equal(session.chat, null);
  assert.equal(session.limits.maxMessageLength, 500);
  ctx.close();
});

/* ----------------------------------- matching ------------------------------ */

test('two simultaneous users with the same interest are matched with distinct aliases', async () => {
  const ctx = setup();
  const a = ctx.user();
  const b = ctx.user();
  const [ra, rb] = await Promise.all([
    a.send('find_stranger', { interest: 'music' }),
    b.send('find_stranger', { interest: 'music' }),
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  const ma = a.last('match_found');
  const mb = b.last('match_found');
  assert.ok(ma && mb, 'both users are told about the match');
  assert.match(ma.you, /^Stranger-\d{5}$/);
  assert.match(ma.stranger, /^Stranger-\d{5}$/);
  assert.equal(ma.you, mb.stranger);
  assert.equal(ma.stranger, mb.you);
  assert.notEqual(ma.you, ma.stranger);
  assert.equal(ma.interest, 'music');
  assert.deepEqual(ctx.chat.stats(), { users: 2, waiting: 0, rooms: 1 });
  ctx.close();
});

test('match_found leaks no socket id, session token, ip or room name', async () => {
  const ctx = setup();
  const a = ctx.user({ ip: '203.0.113.7' });
  const b = ctx.user({ ip: '198.51.100.9' });
  await a.send('find_stranger', { interest: 'gaming' });
  await b.send('find_stranger', { interest: 'gaming' });
  const everything = JSON.stringify([...a.received, ...b.received].filter((r) => r.event !== 'session'));
  for (const secret of [a.id, b.id, a.last('session').sid, b.last('session').sid, '203.0.113.7', '198.51.100.9', 'room:']) {
    assert.equal(everything.includes(secret), false, `leaked ${secret}`);
  }
  // and the other user's session token is never sent to anyone else
  assert.equal(JSON.stringify(a.received).includes(b.last('session').sid), false);
  ctx.close();
});

test('different interests are not matched; queue keeps them waiting', async () => {
  const ctx = setup();
  const a = ctx.user();
  const b = ctx.user();
  await a.send('find_stranger', { interest: 'music' });
  await b.send('find_stranger', { interest: 'gaming' });
  assert.equal(a.last('match_found'), undefined);
  assert.equal(b.last('match_found'), undefined);
  assert.equal(ctx.chat.stats().waiting, 2);
  ctx.close();
});

test('when nobody shares the interest the user is offered a choice, and "anyone" then matches', async () => {
  const ctx = setup();
  const a = ctx.user();
  const b = ctx.user();
  await a.send('find_stranger', { interest: 'music' });
  await b.send('find_stranger', { interest: 'random' });
  assert.equal(a.last('match_found'), undefined); // strict music does not accept a random user
  await sleep(250);
  assert.deepEqual(a.last('no_interest_match'), { interest: 'music' });
  // the user chooses to match with anyone
  const res = await a.send('find_stranger', { interest: 'music', anyone: true });
  assert.equal(res.status, 'matched');
  assert.ok(a.last('match_found') && b.last('match_found'));
  assert.equal(a.last('match_found').interest, null); // different topics: no shared interest shown
  ctx.close();
});

test('random users match each other', async () => {
  const ctx = setup();
  const { a, b } = await matchedPair(ctx, 'random');
  assert.ok(a.last('match_found') && b.last('match_found'));
  ctx.close();
});

test('a user cannot be matched with themselves (repeat find is a single queue entry)', async () => {
  const ctx = setup();
  const a = ctx.user();
  await a.send('find_stranger', { interest: 'music' });
  const again = await a.send('find_stranger', { interest: 'music' });
  assert.equal(again.status, 'waiting');
  assert.equal(a.last('match_found'), undefined);
  assert.equal(ctx.chat.stats().waiting, 1);
  ctx.close();
});

test('BLOCK_SAME_IP_MATCH stops two tabs on one network from matching', async () => {
  const ctx = setup({ BLOCK_SAME_IP_MATCH: 'true' });
  const a = ctx.user({ ip: '192.0.2.1' });
  const b = ctx.user({ ip: '192.0.2.1' });
  await a.send('find_stranger', { interest: 'music' });
  await b.send('find_stranger', { interest: 'music' });
  assert.equal(a.last('match_found'), undefined);
  ctx.close();
});

test('cancel_matching removes the user from the queue', async () => {
  const ctx = setup();
  const a = ctx.user();
  await a.send('find_stranger', { interest: 'music' });
  assert.equal(ctx.chat.stats().waiting, 1);
  const res = await a.send('cancel_matching');
  assert.equal(res.ok, true);
  assert.equal(ctx.chat.stats().waiting, 0);
  const b = ctx.user();
  await b.send('find_stranger', { interest: 'music' });
  assert.equal(b.last('match_found'), undefined, 'a cancelled user must not be matched');
  ctx.close();
});

test('disconnecting while queued removes the user from the queue immediately', async () => {
  const ctx = setup();
  const a = ctx.user();
  await a.send('find_stranger', { interest: 'music' });
  a.drop();
  assert.equal(ctx.chat.stats().waiting, 0);
  const b = ctx.user();
  await b.send('find_stranger', { interest: 'music' });
  assert.equal(b.last('match_found'), undefined);
  ctx.close();
});

test('no duplicate matches under load: 200 users all get exactly one partner', async () => {
  const ctx = setup();
  const sockets = Array.from({ length: 200 }, () => ctx.user());
  await Promise.all(sockets.map((s, i) => s.send('find_stranger', { interest: i % 2 ? 'music' : 'gaming' })));
  for (const s of sockets) {
    const matches = s.events('match_found');
    assert.equal(matches.length, 1, 'each user is matched exactly once');
    assert.notEqual(matches[0].you, matches[0].stranger);
  }
  assert.deepEqual(ctx.chat.stats(), { users: 200, waiting: 0, rooms: 100 });
  ctx.close();
});

test('find_stranger while already chatting is refused', async () => {
  const ctx = setup();
  const { a } = await matchedPair(ctx);
  const res = await a.send('find_stranger', { interest: 'music' });
  assert.deepEqual(res, { ok: false, error: 'already_in_chat' });
  ctx.close();
});

test('invalid interest and malformed payloads are rejected without crashing', async () => {
  const ctx = setup({ STRIKE_LIMIT: '100' }); // (each malformed event is a strike; see the abuse tests for bans)
  const a = ctx.user();
  for (const bad of [undefined, null, 5, 'music', [], { interest: 7 }, { interest: '' }, { interest: 'nope' }, { interest: {} }]) {
    const res = await a.send('find_stranger', bad);
    assert.equal(res.ok, false);
  }
  assert.equal(a.connected, true);
  ctx.close();
});

/* ---------------------------------- messaging ------------------------------ */

test('messages reach only the matched stranger, with correct self flags and timestamps', async () => {
  const ctx = setup();
  const { a, b } = await matchedPair(ctx);
  const outsider = ctx.user();
  const c = ctx.user();
  await outsider.send('find_stranger', { interest: 'gaming' });
  await c.send('find_stranger', { interest: 'gaming' }); // outsider + c are another pair

  const res = await a.send('send_message', { text: 'Hello there' });
  assert.equal(res.ok, true);
  const ma = a.last('receive_message');
  const mb = b.last('receive_message');
  assert.equal(ma.text, 'Hello there');
  assert.equal(ma.self, true);
  assert.equal(mb.text, 'Hello there');
  assert.equal(mb.self, false);
  assert.equal(ma.id, mb.id);
  assert.ok(Math.abs(Date.now() - mb.ts) < 2000);
  assert.equal(outsider.last('receive_message'), undefined);
  assert.equal(c.last('receive_message'), undefined);
  ctx.close();
});

test('typing_start / typing_stop are relayed to the partner only', async () => {
  const ctx = setup();
  const { a, b } = await matchedPair(ctx);
  const other = ctx.user();
  await other.send('find_stranger', { interest: 'school' });
  await a.send('typing_start');
  assert.ok(b.last('typing_start'));
  assert.equal(a.last('typing_start'), undefined);
  assert.equal(other.last('typing_start'), undefined);
  await a.send('typing_stop');
  assert.ok(b.last('typing_stop'));
  ctx.close();
});

test('typing events outside a chat are ignored', async () => {
  const ctx = setup();
  const a = ctx.user();
  const res = await a.send('typing_start');
  assert.equal(res, undefined);
  ctx.close();
});

test('cannot send when not in a chat', async () => {
  const ctx = setup();
  const a = ctx.user();
  assert.deepEqual(await a.send('send_message', { text: 'hi' }), { ok: false, error: 'not_in_chat' });
  ctx.close();
});

test('message validation: empty, too long, wrong types', async () => {
  const ctx = setup({ MESSAGE_RATE_MAX: '100', STRIKE_LIMIT: '100' });
  const { a } = await matchedPair(ctx);
  assert.equal((await a.send('send_message', { text: '   \u200B  ' })).error, 'empty');
  assert.equal((await a.send('send_message', { text: 'x'.repeat(501) })).error, 'too_long');
  assert.equal((await a.send('send_message', { text: 'x'.repeat(500) })).ok, true);
  assert.equal((await a.send('send_message', { text: 'x'.repeat(50000) })).error, 'too_long');
  for (const bad of [undefined, null, 'hi', 42, [], { text: 5 }, { text: null }, { text: {} }, { text: ['a'] }]) {
    assert.equal((await a.send('send_message', bad)).ok, false);
  }
  assert.equal(a.connected, true);
  ctx.close();
});

test('message length counts characters, not bytes', async () => {
  const ctx = setup();
  const { a } = await matchedPair(ctx);
  assert.equal((await a.send('send_message', { text: '😀'.repeat(500) })).ok, true);
  ctx.close();
});

test('rate limit: the 6th message inside the window is refused, then allowed after it', async () => {
  const ctx = setup({ MESSAGE_RATE_WINDOW_MS: '500', STRIKE_LIMIT: '100' });
  const { a } = await matchedPair(ctx);
  for (let i = 0; i < 5; i += 1) assert.equal((await a.send('send_message', { text: `msg ${i}` })).ok, true);
  const blocked = await a.send('send_message', { text: 'msg 6' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'rate_limited');
  assert.ok(blocked.retryAfterMs > 0);
  await sleep(550);
  assert.equal((await a.send('send_message', { text: 'later' })).ok, true);
  ctx.close();
});

test('XSS / markup strings are delivered as inert data; control and bidi characters are removed', async () => {
  const ctx = setup({ STRIKE_LIMIT: '100' });
  const { a, b } = await matchedPair(ctx);
  const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  await a.send('send_message', { text: payload });
  assert.equal(b.last('receive_message').text, payload); // literal text; client uses textContent
  await a.send('send_message', { text: 'safe\u202Etext\u0000here' });
  assert.equal(b.last('receive_message').text, 'safetexthere');
  ctx.close();
});

test('profanity is masked, slurs are rejected, links are refused', async () => {
  const ctx = setup({ STRIKE_LIMIT: '100' });
  const { a, b } = await matchedPair(ctx);
  const masked = await a.send('send_message', { text: 'this is bullshit' });
  assert.equal(masked.ok, true);
  assert.equal(b.last('receive_message').text, 'this is ********');
  assert.equal((await a.send('send_message', { text: 'kys' })).error, 'blocked_content');
  assert.equal((await a.send('send_message', { text: 'go to https://spam.example' })).error, 'links_not_allowed');
  ctx.close();
});

test('ALLOW_LINKS=true permits links', async () => {
  const ctx = setup({ ALLOW_LINKS: 'true' });
  const { a } = await matchedPair(ctx);
  assert.equal((await a.send('send_message', { text: 'see https://example.org' })).ok, true);
  ctx.close();
});

test('duplicate spam: the same text a third time within 20s is refused', async () => {
  const ctx = setup({ STRIKE_LIMIT: '100' });
  const { a } = await matchedPair(ctx);
  assert.equal((await a.send('send_message', { text: 'buy now' })).ok, true);
  assert.equal((await a.send('send_message', { text: 'buy now' })).ok, true);
  assert.equal((await a.send('send_message', { text: 'Buy   NOW' })).error, 'duplicate');
  ctx.close();
});

/* ----------------------------------- ending -------------------------------- */

test('end_chat ends the room for both, deletes it, and blocks further messages', async () => {
  const ctx = setup();
  const { a, b } = await matchedPair(ctx);
  await a.send('send_message', { text: 'hi' });
  const res = await a.send('end_chat');
  assert.deepEqual(res, { ok: true, ended: true });
  assert.deepEqual(a.last('chat_ended'), { reason: 'you_ended' });
  assert.deepEqual(b.last('chat_ended'), { reason: 'partner_ended' });
  assert.equal(ctx.chat.stats().rooms, 0);
  assert.equal((await a.send('send_message', { text: 'x' })).error, 'not_in_chat');
  assert.equal((await b.send('send_message', { text: 'x' })).error, 'not_in_chat');
  // the remaining user can immediately look for someone else
  const c = ctx.user();
  await c.send('find_stranger', { interest: 'music' });
  assert.equal((await b.send('find_stranger', { interest: 'music' })).status, 'matched');
  ctx.close();
});

test('end_chat is idempotent', async () => {
  const ctx = setup();
  const a = ctx.user();
  assert.deepEqual(await a.send('end_chat'), { ok: true, ended: false });
  ctx.close();
});

test('re-matching the same pair is prevented during the cooldown', async () => {
  const ctx = setup();
  const { a, b } = await matchedPair(ctx);
  await a.send('end_chat');
  a.clear(); b.clear();
  await a.send('find_stranger', { interest: 'music' });
  const res = await b.send('find_stranger', { interest: 'music' });
  assert.equal(res.status, 'waiting');
  assert.equal(a.last('match_found'), undefined);
  ctx.close();
});

/* ----------------------------- disconnect / reconnect ---------------------- */

test('stranger disconnect: partner sees offline status, then chat ends after the grace period', async () => {
  const ctx = setup();
  const { a, b } = await matchedPair(ctx);
  a.drop();
  assert.deepEqual(b.last('partner_status'), { online: false });
  assert.equal(b.last('chat_ended'), undefined, 'not ended yet: the stranger may come back');
  await sleep(300);
  assert.deepEqual(b.last('chat_ended'), { reason: 'partner_disconnected' });
  assert.deepEqual(ctx.chat.stats(), { users: 1, waiting: 0, rooms: 0 });
  assert.equal((await b.send('send_message', { text: 'hello?' })).error, 'not_in_chat');
  ctx.close();
});

test('reconnecting with the session token resumes the chat with history', async () => {
  const ctx = setup();
  const { a, b } = await matchedPair(ctx);
  await a.send('send_message', { text: 'before drop' });
  await b.send('send_message', { text: 'reply' });
  const sid = a.last('session').sid;
  const youBefore = a.last('match_found').you;
  a.drop();
  assert.deepEqual(b.last('partner_status'), { online: false });
  await b.send('send_message', { text: 'sent while you were away' });

  const a2 = ctx.user({ auth: { sid } });
  const session = a2.last('session');
  assert.equal(session.state, 'chatting');
  assert.equal(session.sid, sid);
  assert.equal(session.chat.you, youBefore);
  assert.equal(session.chat.stranger, b.last('match_found').you);
  assert.equal(session.chat.partnerOnline, true);
  assert.deepEqual(session.chat.messages.map((m) => [m.text, m.self]), [
    ['before drop', true],
    ['reply', false],
    ['sent while you were away', false],
  ]);
  assert.deepEqual(b.last('partner_status'), { online: true });
  await sleep(300); // the grace timer must have been cancelled
  assert.equal(ctx.chat.stats().rooms, 1);
  // and messaging works again
  await a2.send('send_message', { text: 'back' });
  assert.equal(b.last('receive_message').text, 'back');
  ctx.close();
});

test('an unknown or forged session token creates a fresh, unrelated session', () => {
  const ctx = setup();
  for (const sid of ['nope', 'a'.repeat(48), 12345, null, {}, ['x']]) {
    const s = ctx.user({ auth: { sid } });
    assert.equal(s.last('session').state, 'idle');
    assert.notEqual(s.last('session').sid, sid);
  }
  ctx.close();
});

test('opening the same session in a second tab replaces the first', async () => {
  const ctx = setup();
  const a = ctx.user();
  const sid = a.last('session').sid;
  const a2 = ctx.user({ auth: { sid } });
  assert.equal(a.last('connection_error').code, 'session_replaced');
  assert.equal(a.connected, false);
  assert.equal((await a2.send('find_stranger', { interest: 'music' })).ok, true);
  ctx.close();
});

test('when both users disconnect the room and its messages are destroyed', async () => {
  const ctx = setup();
  const { a, b } = await matchedPair(ctx);
  await a.send('send_message', { text: 'secret' });
  a.drop();
  b.drop();
  await sleep(350);
  assert.deepEqual(ctx.chat.stats(), { users: 0, waiting: 0, rooms: 0 });
  ctx.close();
});

test('a queued user who refreshes must search again (queue entry is not kept)', async () => {
  const ctx = setup();
  const a = ctx.user();
  const sid = a.last('session').sid;
  await a.send('find_stranger', { interest: 'music' });
  a.drop();
  const a2 = ctx.user({ auth: { sid } });
  assert.equal(a2.last('session').state, 'idle');
  assert.equal(ctx.chat.stats().waiting, 0);
  ctx.close();
});

/* ----------------------------- report / block ------------------------------ */

test('report_user stores a minimal report (no message text, no reporter identity)', async () => {
  const ctx = setup();
  const { a, b } = await matchedPair(ctx);
  await b.send('send_message', { text: 'private words' });
  const res = await a.send('report_user', { reason: 'harassment', note: 'rude' });
  assert.equal(res.ok, true);
  const [report] = ctx.moderation.list();
  assert.equal(report.reason, 'harassment');
  assert.equal(report.note, 'rude');
  assert.equal(report.alias, a.last('match_found').stranger);
  assert.equal(report.messageCount, 1);
  const dump = JSON.stringify(report);
  assert.equal(dump.includes('private words'), false);
  assert.equal(dump.includes(a.id), false);
  // chat stays open after a report, and duplicates are refused
  assert.equal(ctx.chat.stats().rooms, 1);
  assert.equal((await a.send('report_user', { reason: 'spam' })).error, 'already_reported');
  ctx.close();
});

test('REPORT_INCLUDE_MESSAGES=true attaches the reported user\'s last messages only', async () => {
  const ctx = setup({ REPORT_INCLUDE_MESSAGES: 'true' });
  const { a, b } = await matchedPair(ctx);
  await a.send('send_message', { text: 'mine' });
  await b.send('send_message', { text: 'theirs' });
  await a.send('report_user', { reason: 'spam' });
  assert.deepEqual(ctx.moderation.list()[0].context, ['theirs']);
  ctx.close();
});

test('report_user validates reason and requires an active chat', async () => {
  const ctx = setup();
  const lonely = ctx.user();
  assert.equal((await lonely.send('report_user', { reason: 'spam' })).error, 'not_in_chat');
  const { a } = await matchedPair(ctx);
  for (const bad of [undefined, {}, { reason: 'because' }, { reason: 5 }, 'spam']) {
    assert.equal((await a.send('report_user', bad)).error, 'invalid_reason');
  }
  assert.equal(ctx.moderation.list().length, 0);
  ctx.close();
});

test('enough distinct reporters auto-ban the reported user, who is disconnected and cannot reconnect', async () => {
  const ctx = setup({ REPORT_AUTO_BAN_THRESHOLD: '3' });
  const badIp = '198.51.100.66';
  let bad;
  for (let i = 0; i < 3; i += 1) {
    bad = ctx.user({ ip: badIp });
    const victim = ctx.user();
    await bad.send('find_stranger', { interest: `music` });
    await victim.send('find_stranger', { interest: 'music' });
    await victim.send('report_user', { reason: 'harassment' });
    if (i < 2) {
      await victim.send('end_chat');
      bad.drop();
    }
  }
  assert.equal(bad.connected, false, 'auto-banned user is disconnected');
  assert.equal(bad.last('connection_error').code, 'banned');
  const retry = ctx.client({ ip: badIp });
  assert.ok(retry.error, 'reconnect attempt is rejected');
  assert.equal(retry.error.data.code, 'banned');
  ctx.close();
});

test('block_user ends the chat, hides the block from the stranger, and prevents re-matching', async () => {
  const ctx = setup({ REMATCH_COOLDOWN_MS: '0' });
  const { a, b } = await matchedPair(ctx);
  assert.equal((await a.send('block_user')).ok, true);
  assert.deepEqual(a.last('chat_ended'), { reason: 'you_ended' });
  assert.deepEqual(b.last('chat_ended'), { reason: 'partner_ended' }); // indistinguishable from a normal leave
  assert.equal(JSON.stringify(b.received).includes('block'), false);
  a.clear(); b.clear();
  await a.send('find_stranger', { interest: 'music' });
  const res = await b.send('find_stranger', { interest: 'music' });
  assert.equal(res.status, 'waiting', 'blocked pair is never matched again');
  // ...but a's other partners are fine
  const c = ctx.user();
  assert.equal((await c.send('find_stranger', { interest: 'music' })).status, 'matched');
  ctx.close();
});

test('block_user requires an active chat', async () => {
  const ctx = setup();
  const a = ctx.user();
  assert.equal((await a.send('block_user')).error, 'not_in_chat');
  ctx.close();
});

/* ------------------------------ abuse handling ----------------------------- */

test('repeated abusive messages get the client disconnected and temporarily banned', async () => {
  const ctx = setup({ STRIKE_LIMIT: '8', MESSAGE_RATE_MAX: '100' });
  const ip = '203.0.113.50';
  const a = ctx.user({ ip });
  const b = ctx.user();
  await a.send('find_stranger', { interest: 'music' });
  await b.send('find_stranger', { interest: 'music' });
  // each rejected slur costs 3 strikes -> banned on the 3rd
  await a.send('send_message', { text: 'kys' });
  await a.send('send_message', { text: 'kill yourself' });
  assert.equal(a.connected, true);
  await a.send('send_message', { text: 'go die' });
  assert.equal(a.connected, false);
  assert.equal(a.last('connection_error').code, 'banned');
  assert.deepEqual(b.last('chat_ended'), { reason: 'partner_disconnected' });
  assert.ok(ctx.client({ ip }).error, 'banned network cannot reconnect');
  assert.equal(b.events('receive_message').length, 0, 'abusive messages never reached the stranger');
  ctx.close();
});

test('event flooding is dropped and eventually banned', async () => {
  const ctx = setup({ STRIKE_LIMIT: '5' });
  const a = ctx.user();
  let dropped = 0;
  for (let i = 0; i < 200; i += 1) {
    if (!a.connected) break;
    const r = await a.send('typing_start');
    if (r && r.dropped) dropped += 1;
  }
  assert.ok(dropped > 0);
  assert.equal(a.connected, false);
  ctx.close();
});

test('per-IP connection limit', () => {
  const ctx = setup({ MAX_CONNECTIONS_PER_IP: '2' });
  const s1 = ctx.user({ ip: '192.0.2.9' });
  const s2 = ctx.user({ ip: '192.0.2.9' });
  const s3 = ctx.user({ ip: '192.0.2.9' });
  assert.equal(s1.connected && s2.connected, true);
  assert.equal(s3.connected, false);
  assert.equal(s3.last('connection_error').code, 'too_many_connections');
  s1.drop();
  const s4 = ctx.user({ ip: '192.0.2.9' });
  assert.equal(s4.connected, true);
  ctx.close();
});

test('a handler exception is contained and reported generically', async () => {
  const ctx = setup();
  const { a } = await matchedPair(ctx);
  // force an internal error by corrupting server state through a hostile getter payload
  const evil = { get text() { throw new Error('boom'); } };
  const res = await a.send('send_message', evil);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'server_error');
  assert.equal(a.last('connection_error').code, 'server_error');
  assert.equal(a.connected, true);
  ctx.close();
});

test('X-Forwarded-For is honoured only when TRUST_PROXY > 0 (ban follows the real client, not the proxy)', async () => {
  const ctx = setup({ TRUST_PROXY: '1', STRIKE_LIMIT: '3' });
  const proxied = (xff) => ({ ip: '10.9.9.9', headers: { 'x-forwarded-for': xff } });
  const a = ctx.user(proxied('1.1.1.1, 198.51.100.5'));
  const b = ctx.user(proxied('9.9.9.9'));
  await a.send('find_stranger', { interest: 'music' });
  await b.send('find_stranger', { interest: 'music' });
  await a.send('send_message', { text: 'kys' }); // 3 strikes -> banned
  assert.equal(a.connected, false);
  // same proxy address, different real client: not banned
  assert.equal(ctx.client(proxied('7.7.7.7')).error, null);
  // spoofed leading entry does not evade the ban: rightmost trusted hop still identifies the client
  assert.ok(ctx.client(proxied('8.8.8.8, 198.51.100.5')).error);
  ctx.close();
});
