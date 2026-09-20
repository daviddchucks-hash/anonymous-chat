'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RateLimiter, ConnectionLimiter } = require('../src/rateLimiter');
const { MatchQueue } = require('../src/matching');
const { RoomManager } = require('../src/rooms');
const { loadConfig, INTERESTS } = require('../src/config');
const {
  sanitizeText,
  textLength,
  containsLink,
  buildTextChecker,
  StrikeTracker,
  ModerationStore,
  hashIp,
} = require('../src/moderation');

/* ------------------------------- rate limiter ------------------------------ */

test('RateLimiter allows max hits per window then blocks', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 3 });
  const t = 10000;
  assert.equal(rl.consume('a', t).allowed, true);
  assert.equal(rl.consume('a', t + 1).allowed, true);
  assert.equal(rl.consume('a', t + 2).allowed, true);
  const blocked = rl.consume('a', t + 3);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000);
  // other keys are independent
  assert.equal(rl.consume('b', t + 3).allowed, true);
});

test('RateLimiter recovers after the window and refused hits do not extend the lockout', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 2 });
  rl.consume('a', 0);
  rl.consume('a', 10);
  for (let i = 0; i < 50; i += 1) assert.equal(rl.consume('a', 500 + i).allowed, false);
  assert.equal(rl.consume('a', 1001).allowed, true); // first hit expired at t=1000
});

test('RateLimiter sweep frees idle keys', () => {
  const rl = new RateLimiter({ windowMs: 100, max: 1 });
  rl.consume('x', 0);
  assert.equal(rl.size, 1);
  rl.sweep(10000);
  assert.equal(rl.size, 0);
});

test('ConnectionLimiter caps and releases', () => {
  const cl = new ConnectionLimiter(2);
  assert.equal(cl.acquire('ip'), true);
  assert.equal(cl.acquire('ip'), true);
  assert.equal(cl.acquire('ip'), false);
  cl.release('ip');
  assert.equal(cl.acquire('ip'), true);
  cl.release('ip');
  cl.release('ip');
  assert.equal(cl.count('ip'), 0);
});

/* --------------------------------- matching -------------------------------- */

const entry = (userId, interest, anyone = interest === 'random') => ({ userId, interest, anyone, since: 0 });

test('MatchQueue pairs users with the same interest', () => {
  const q = new MatchQueue();
  assert.equal(q.enqueueOrMatch(entry('a', 'music')), null);
  const partner = q.enqueueOrMatch(entry('b', 'music'));
  assert.equal(partner.userId, 'a');
  assert.equal(q.size, 0);
});

test('MatchQueue does not pair different interests unless one side accepts anyone', () => {
  const q = new MatchQueue();
  assert.equal(q.enqueueOrMatch(entry('a', 'music', false)), null);
  assert.equal(q.enqueueOrMatch(entry('b', 'gaming', false)), null);
  assert.equal(q.size, 2);
  // a random user accepts anyone, but the strict users do not accept a random user
  assert.equal(q.enqueueOrMatch(entry('c', 'random')), null);
  assert.equal(q.size, 3);
  // when a strict user opts in to "anyone" they can be matched with the random user
  const partner = q.enqueueOrMatch(entry('a', 'music', true));
  assert.equal(partner.userId, 'c');
  assert.equal(q.size, 1); // only the strict gaming user is still waiting
  assert.equal(q.has('b'), true);
});

test('MatchQueue prefers same-interest partner over an older different-interest one', () => {
  const q = new MatchQueue();
  // 'old' accepts anyone; 'same' is strict music. They cannot pair with each other, so both wait.
  assert.equal(q.enqueueOrMatch(entry('old', 'gaming', true)), null);
  assert.equal(q.enqueueOrMatch(entry('same', 'music', false)), null);
  // 'new' is compatible with both, and must pick the same-interest one even though 'old' waited longer.
  const partner = q.enqueueOrMatch(entry('new', 'music', true));
  assert.equal(partner.userId, 'same');
});

test('MatchQueue never matches a user with themselves and never duplicates entries', () => {
  const q = new MatchQueue();
  assert.equal(q.enqueueOrMatch(entry('a', 'music')), null);
  assert.equal(q.enqueueOrMatch(entry('a', 'music')), null);
  assert.equal(q.size, 1);
});

test('MatchQueue honours the canPair callback', () => {
  const q = new MatchQueue();
  q.enqueueOrMatch(entry('a', 'music'));
  q.enqueueOrMatch(entry('b', 'music'), (o) => o.userId !== 'a'); // b refuses a
  assert.equal(q.size, 2);
});

test('MatchQueue.remove works', () => {
  const q = new MatchQueue();
  q.enqueueOrMatch(entry('a', 'music'));
  assert.equal(q.remove('a'), true);
  assert.equal(q.has('a'), false);
});

/* ----------------------------------- rooms --------------------------------- */

test('RoomManager creates distinct aliases in Stranger-NNNNN form and destroys data', () => {
  const rm = new RoomManager({ maxMessages: 3 });
  const room = rm.create('u1', 'u2');
  assert.match(room.aliases.u1, /^Stranger-\d{5}$/);
  assert.match(room.aliases.u2, /^Stranger-\d{5}$/);
  assert.notEqual(room.aliases.u1, room.aliases.u2);
  for (let i = 0; i < 5; i += 1) rm.addMessage(room.id, 'u1', `m${i}`);
  assert.equal(room.messages.length, 3); // capped
  assert.equal(room.messages[0].text, 'm2');
  assert.equal(rm.partnerId(room, 'u1'), 'u2');
  const messages = room.messages;
  assert.equal(rm.destroy(room.id), true);
  assert.equal(messages.length, 0); // message data wiped
  assert.equal(rm.get(room.id), null);
  assert.equal(rm.size, 0);
});

/* --------------------------------- sanitising ------------------------------ */

test('sanitizeText strips control, bidi and zero-width characters', () => {
  assert.equal(sanitizeText('he\u0000llo\u200B wor\u202Eld'), 'hello world');
  assert.equal(sanitizeText('a\u0007b'), 'ab');
});

test('sanitizeText keeps emoji ZWJ sequences and normal text', () => {
  const family = '👨‍👩‍👧';
  assert.equal(sanitizeText(family), family);
  assert.equal(sanitizeText('  hi   there  '), 'hi there');
});

test('sanitizeText collapses excess newlines and limits zalgo stacks', () => {
  assert.equal(sanitizeText('a\n\n\n\n\nb'), 'a\n\nb');
  const zalgo = 'x' + '\u0301'.repeat(30); // 'x' does not compose with the mark under NFC
  assert.equal(sanitizeText(zalgo), 'x' + '\u0301'.repeat(3));
});

test('sanitizeText returns empty string for non-strings', () => {
  for (const v of [null, undefined, 42, {}, [], true]) assert.equal(sanitizeText(v), '');
});

test('sanitizeText does NOT HTML-escape (client renders with textContent)', () => {
  assert.equal(sanitizeText('<script>alert(1)</script>'), '<script>alert(1)</script>');
});

test('textLength counts code points', () => {
  assert.equal(textLength('a😀b'), 3);
});

/* --------------------------------- text checker ---------------------------- */

const check = buildTextChecker([]);

test('word filter masks mild profanity and variants', () => {
  assert.equal(check('what the fuck').text, 'what the ****');
  assert.equal(check('you are FUCKING dumb').text, 'you are ******* dumb');
  assert.equal(check('sh1t').text, '****');
  assert.equal(check('$hit happens').text, '**** happens');
  assert.equal(check('fuuuuck').masked, true);
  assert.equal(check('shitty day').text, '****** day');
});

test('word filter leaves innocent words and numbers alone', () => {
  for (const ok of ['class', 'assess', 'Scunthorpe', 'classic', 'pass the bass', 'cockatoo', '455', 'Dickens', 'grass']) {
    const r = check(ok);
    assert.equal(r.masked, false, ok);
    assert.equal(r.text, ok);
  }
});

test('word filter flags severe content', () => {
  assert.equal(check('kys').severe, true);
  assert.equal(check('go kill yourself').severe, true);
  assert.equal(check('kill your self').severe, true);
  assert.equal(check('hello friend').severe, false);
});

test('BLOCKED_WORDS extends the mask list', () => {
  const custom = buildTextChecker(['bananas']);
  assert.equal(custom('I like bananas').text, 'I like *******');
});

test('containsLink detects urls and bare domains but not normal text', () => {
  assert.equal(containsLink('visit https://evil.example/x'), true);
  assert.equal(containsLink('go to www.spam.biz'), true);
  assert.equal(containsLink('check spam.xyz now'), true);
  assert.equal(containsLink('I am from the U.S. and love music'), false);
  assert.equal(containsLink('hello there. how are you?'), false);
});

/* ---------------------------------- strikes -------------------------------- */

test('StrikeTracker sums weights within the window and forgets old ones', () => {
  const st = new StrikeTracker({ windowMs: 1000 });
  assert.equal(st.add('u', 1, 0), 1);
  assert.equal(st.add('u', 2.5, 500), 3.5);
  assert.equal(st.add('u', 1, 1200), 3.5); // the first (t=0) has expired
  st.clear('u');
  assert.equal(st.total('u', 1200), 0);
});

/* ------------------------------ moderation store --------------------------- */

test('ModerationStore keeps minimal reports and supports resolve/list/stats', () => {
  let now = 1000;
  const ms = new ModerationStore({ autoBanThreshold: 3, banDurationMs: 5000, now: () => now });
  const { report, autoBanned } = ms.addReport({
    reason: 'spam', note: 'ads', reportedRef: 'T', reporterRef: 'R1', alias: 'Stranger-11111', messageCount: 4,
  });
  assert.equal(autoBanned, false);
  assert.deepEqual(Object.keys(report).sort(), [
    'alias', 'conversationAgeSec', 'createdAt', 'id', 'messageCount', 'note', 'reason', 'reportedRef', 'status',
  ]);
  assert.equal(report.context, undefined); // no message text by default
  assert.equal(ms.list({ status: 'open' }).length, 1);
  assert.equal(ms.resolve(report.id, 'dismissed').status, 'dismissed');
  assert.equal(ms.list({ status: 'open' }).length, 0);
  assert.equal(ms.resolve('nope'), null);
  assert.equal(ms.stats().reportsTotal, 1);
});

test('ModerationStore auto-bans after enough DISTINCT reporters, ban expires', () => {
  let now = 0;
  const ms = new ModerationStore({ autoBanThreshold: 3, banDurationMs: 5000, now: () => now });
  const rep = (reporterRef) => ms.addReport({ reason: 'harassment', reportedRef: 'T', reporterRef, alias: 'x' });
  assert.equal(rep('R1').autoBanned, false);
  assert.equal(rep('R1').autoBanned, false); // same reporter again does not count twice
  assert.equal(rep('R2').autoBanned, false);
  assert.equal(rep('R3').autoBanned, true);
  assert.equal(ms.isBanned('T').banned, true);
  now = 6000;
  assert.equal(ms.isBanned('T').banned, false);
});

test('ModerationStore ignores self-reports from the same network for auto-ban', () => {
  const ms = new ModerationStore({ autoBanThreshold: 1 });
  assert.equal(ms.addReport({ reason: 'spam', reportedRef: 'X', reporterRef: 'X', alias: 'a' }).autoBanned, false);
});

test('hashIp is stable, secret-dependent and does not contain the ip', () => {
  const a = hashIp('203.0.113.9', 'secret1');
  assert.equal(a, hashIp('203.0.113.9', 'secret1'));
  assert.notEqual(a, hashIp('203.0.113.9', 'secret2'));
  assert.equal(a.includes('203'), false);
  assert.equal(a.length, 16);
});

/* ---------------------------------- config --------------------------------- */

test('loadConfig clamps unsafe values and defaults sensibly', () => {
  const c = loadConfig({ NODE_ENV: 'production', MAX_MESSAGE_LENGTH: '999999', MESSAGE_RATE_MAX: '-4', PORT: 'abc' });
  assert.equal(c.isProd, true);
  assert.equal(c.trustProxy, 1);
  assert.equal(c.maxMessageLength, 2000);
  assert.equal(c.messageRateMax, 1);
  assert.equal(c.port, 3000);
  assert.equal(c.adminToken, '');
  assert.equal(loadConfig({ ADMIN_TOKEN: 'short' }).adminToken, '');
  assert.equal(loadConfig({ ADMIN_TOKEN: 'x'.repeat(30) }).adminToken.length, 30);
  assert.deepEqual(loadConfig({ CORS_ORIGINS: 'https://a.com/, https://b.com' }).corsOrigins, ['https://a.com', 'https://b.com']);
  assert.ok(INTERESTS.includes('random') && INTERESTS.length === 9);
});
