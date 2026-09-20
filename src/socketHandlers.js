'use strict';

const { INTERESTS } = require('./config');
const { MatchQueue } = require('./matching');
const { RoomManager } = require('./rooms');
const { UserRegistry } = require('./users');
const { RateLimiter, ConnectionLimiter } = require('./rateLimiter');
const {
  hashIp,
  REPORT_REASONS,
  sanitizeText,
  textLength,
  containsLink,
  buildTextChecker,
  StrikeTracker,
} = require('./moderation');

const ERROR_MESSAGES = Object.freeze({
  banned: 'You have been temporarily removed for breaking the rules. Please try again later.',
  too_many_connections: 'Too many connections from your network. Close other tabs and try again.',
  session_replaced: 'This chat was opened in another tab, so this one was closed.',
  rate_limited: 'You are sending too many requests. Slow down.',
  server_error: 'Something went wrong. Please try again.',
  server_restarting: 'The server is restarting. Please reconnect in a moment.',
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const reply = (ack, body) => {
  if (typeof ack === 'function') ack(body);
};

/**
 * Work out the client IP for rate limits and bans. `hops` is the number of
 * trusted reverse proxies (same meaning as Express "trust proxy" = N): the
 * client address is the Nth entry from the right of X-Forwarded-For.
 * The raw value is hashed immediately and never stored, sent or logged.
 */
function getClientIp(handshake, hops) {
  if (hops > 0) {
    const list = String((handshake.headers && handshake.headers['x-forwarded-for']) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) return list[Math.max(0, list.length - hops)];
  }
  return handshake.address || 'unknown';
}

/**
 * Wire all chat behaviour onto a Socket.IO server (or a compatible fake in tests).
 * @returns {{stats: () => object, close: () => void}}
 */
function registerSocketHandlers(io, { config, moderation }) {
  const users = new UserRegistry();
  const queue = new MatchQueue();
  const rooms = new RoomManager({ maxMessages: config.maxRoomMessages });
  const checkText = buildTextChecker(config.blockedWords);
  const strikes = new StrikeTracker({ windowMs: config.strikeWindowMs });
  const connections = new ConnectionLimiter(config.maxConnectionsPerIp);
  const limiters = {
    event: new RateLimiter({ windowMs: config.eventRateWindowMs, max: config.eventRateMax }),
    message: new RateLimiter({ windowMs: config.messageRateWindowMs, max: config.messageRateMax }),
    typing: new RateLimiter({ windowMs: config.typingRateWindowMs, max: config.typingRateMax }),
    find: new RateLimiter({ windowMs: config.findRateWindowMs, max: config.findRateMax }),
    report: new RateLimiter({ windowMs: config.reportRateWindowMs, max: config.reportRateMax }),
  };

  /* ------------------------------ small helpers ----------------------------- */

  const emitTo = (user, event, payload) => {
    if (user && user.online && user.socket) user.socket.emit(event, payload);
  };

  const getActiveRoom = (user) => (user.state === 'chatting' ? rooms.get(user.roomId) : null);
  const partnerOf = (room, user) => users.getById(rooms.partnerId(room, user.id));

  const toClientMessage = (message, viewerId) => ({
    id: message.id,
    text: message.text,
    ts: message.ts,
    self: message.senderId === viewerId,
  });

  const sharedInterest = (a, b) => (a.interest === b.interest && a.interest !== 'random' ? a.interest : null);

  function clearTimers(user) {
    if (user.graceTimer) clearTimeout(user.graceTimer);
    if (user.waitTimer) clearTimeout(user.waitTimer);
    user.graceTimer = null;
    user.waitTimer = null;
  }

  function leaveQueue(user) {
    queue.remove(user.id);
    if (user.waitTimer) clearTimeout(user.waitTimer);
    user.waitTimer = null;
    if (user.state === 'waiting') user.state = 'idle';
  }

  /** May these two users be paired? (interest rules live in the queue itself) */
  function canPair(a, b, now = Date.now()) {
    if (!a || !b || a.id === b.id || a.sid === b.sid) return false;
    if (a.blockedIds.has(b.id) || b.blockedIds.has(a.id)) return false;
    if (a.blockedIps.has(b.ipHash) || b.blockedIps.has(a.ipHash)) return false;
    if (!config.allowSameIpMatch && a.ipHash === b.ipHash) return false;
    const cooldown = a.recentPartners.get(b.id);
    if (cooldown && cooldown > now) return false;
    if (cooldown) a.recentPartners.delete(b.id);
    return true;
  }

  /* --------------------------- conversation lifecycle ------------------------ */

  function createMatch(a, b) {
    leaveQueue(a);
    leaveQueue(b);
    const room = rooms.create(a.id, b.id);
    const now = Date.now();
    for (const [user, other] of [[a, b], [b, a]]) {
      user.state = 'chatting';
      user.roomId = room.id;
      user.recentPartners.set(other.id, now + config.rematchCooldownMs);
      if (user.online && user.socket) user.socket.join(room.name);
    }
    for (const [user, other] of [[a, b], [b, a]]) {
      emitTo(user, 'match_found', {
        you: room.aliases[user.id],
        stranger: room.aliases[other.id],
        interest: sharedInterest(a, b),
        maxMessageLength: config.maxMessageLength,
      });
    }
  }

  /** End a conversation for everyone in it and destroy the room and its messages. */
  function endRoom(room, initiatorId, reasonForOthers) {
    for (const id of [...room.members]) {
      const user = users.getById(id);
      if (!user) continue;
      user.state = 'idle';
      user.roomId = null;
      if (user.online && user.socket) {
        user.socket.leave(room.name);
        user.socket.emit('chat_ended', { reason: id === initiatorId ? 'you_ended' : reasonForOthers });
      }
    }
    rooms.destroy(room.id);
  }

  /** Forget a user completely (grace period over, or removed for abuse). Idempotent. */
  function finalizeUser(user, reasonForPartner = 'partner_disconnected') {
    if (!users.getById(user.id)) return;
    leaveQueue(user);
    clearTimers(user);
    const room = rooms.get(user.roomId);
    if (room) endRoom(room, user.id, reasonForPartner);
    strikes.clear(user.id);
    for (const limiter of Object.values(limiters)) limiter.reset(user.id);
    user.recentTexts.length = 0;
    users.remove(user);
  }

  /** Disconnect an abusive client right away. */
  function forceRemove(user, code) {
    const socket = user.socket;
    user.socket = null;
    user.online = false;
    if (socket) {
      socket.emit('connection_error', { code, message: ERROR_MESSAGES[code] || ERROR_MESSAGES.banned });
    }
    finalizeUser(user, 'partner_disconnected');
    if (socket) socket.disconnect(true);
  }

  /**
   * Add abuse strikes. When the total inside the window reaches the limit the
   * client is banned (by hashed IP) and disconnected. Returns true if removed.
   */
  function punish(user, weight) {
    const total = strikes.add(user.id, weight);
    if (total >= config.strikeLimit) {
      moderation.ban(user.ipHash, config.banDurationMs, 'abuse');
      forceRemove(user, 'banned');
      return true;
    }
    return false;
  }

  /* -------------------------------- matching -------------------------------- */

  function startInterestTimer(user) {
    if (user.waitTimer) clearTimeout(user.waitTimer);
    user.waitTimer = null;
    if (user.anyone) return;
    user.waitTimer = setTimeout(() => {
      user.waitTimer = null;
      if (user.state === 'waiting' && !user.anyone) {
        emitTo(user, 'no_interest_match', { interest: user.interest });
      }
    }, config.interestMatchTimeoutMs);
    if (user.waitTimer.unref) user.waitTimer.unref();
  }

  function handleFind(user, payload, ack) {
    if (!isObject(payload) || typeof payload.interest !== 'string') {
      reply(ack, { ok: false, error: 'invalid_payload' });
      punish(user, 1);
      return;
    }
    const interest = payload.interest.trim().toLowerCase();
    if (!INTERESTS.includes(interest)) {
      reply(ack, { ok: false, error: 'invalid_interest' });
      punish(user, 1);
      return;
    }
    if (user.state === 'chatting') {
      reply(ack, { ok: false, error: 'already_in_chat' });
      return;
    }
    if (!limiters.find.consume(user.id).allowed) {
      reply(ack, { ok: false, error: 'rate_limited' });
      punish(user, 0.5);
      return;
    }

    const anyone = interest === 'random' || payload.anyone === true;
    const previous = queue.get(user.id);
    const since = previous && previous.interest === interest ? previous.since : Date.now();

    leaveQueue(user);
    user.interest = interest;
    user.anyone = anyone;
    user.state = 'waiting';

    const entry = { userId: user.id, interest, anyone, since };
    const partnerEntry = queue.enqueueOrMatch(entry, (other) => canPair(user, users.getById(other.userId)));
    const partner = partnerEntry ? users.getById(partnerEntry.userId) : null;

    if (partner) {
      reply(ack, { ok: true, status: 'matched' });
      createMatch(user, partner);
    } else {
      reply(ack, { ok: true, status: 'waiting' });
      startInterestTimer(user);
    }
  }

  function handleCancel(user, _payload, ack) {
    if (user.state === 'waiting') leaveQueue(user);
    reply(ack, { ok: true });
  }

  /* -------------------------------- messaging ------------------------------- */

  function handleSend(user, payload, ack) {
    const room = getActiveRoom(user);
    if (!room) {
      reply(ack, { ok: false, error: 'not_in_chat' });
      return;
    }
    const fail = (error, weight = 0, extra = {}) => {
      reply(ack, { ok: false, error, ...extra });
      if (weight) punish(user, weight);
    };

    const rate = limiters.message.consume(user.id);
    if (!rate.allowed) return fail('rate_limited', 0.5, { retryAfterMs: rate.retryAfterMs });
    if (!isObject(payload) || typeof payload.text !== 'string') return fail('invalid_payload', 1);
    if (payload.text.length > config.maxMessageLength * 4) return fail('too_long', 1);

    let text = sanitizeText(payload.text);
    if (!text) return fail('empty');
    if (textLength(text) > config.maxMessageLength) return fail('too_long');
    if (!config.allowLinks && containsLink(text)) return fail('links_not_allowed', 0.5);

    const check = checkText(text);
    if (check.severe) return fail('blocked_content', 3);
    text = check.text;

    // Simple duplicate-spam detection: the same text 3 times within 20 seconds.
    const now = Date.now();
    const key = text.toLowerCase();
    user.recentTexts = user.recentTexts.filter((r) => now - r.ts < 20000);
    if (user.recentTexts.filter((r) => r.key === key).length >= 2) return fail('duplicate', 1);
    user.recentTexts.push({ key, ts: now });
    if (user.recentTexts.length > 10) user.recentTexts.shift();

    const message = rooms.addMessage(room.id, user.id, text, now);
    for (const id of room.members) {
      emitTo(users.getById(id), 'receive_message', toClientMessage(message, id));
    }
    reply(ack, { ok: true, id: message.id, masked: check.masked });
  }

  function relayTyping(user, event) {
    if (!limiters.typing.consume(user.id).allowed) return; // silently drop typing spam
    const room = getActiveRoom(user);
    if (!room) return;
    emitTo(partnerOf(room, user), event, {});
  }

  /* ---------------------------- ending / reporting -------------------------- */

  function handleEnd(user, _payload, ack) {
    const room = getActiveRoom(user);
    if (!room) {
      reply(ack, { ok: true, ended: false });
      return;
    }
    endRoom(room, user.id, 'partner_ended');
    reply(ack, { ok: true, ended: true });
  }

  function handleReport(user, payload, ack) {
    const room = getActiveRoom(user);
    if (!room) return reply(ack, { ok: false, error: 'not_in_chat' });
    if (!isObject(payload) || !REPORT_REASONS.includes(payload.reason)) {
      reply(ack, { ok: false, error: 'invalid_reason' });
      punish(user, 1);
      return undefined;
    }
    if (!limiters.report.consume(user.id).allowed) return reply(ack, { ok: false, error: 'rate_limited' });
    if (room.reportedBy.has(user.id)) return reply(ack, { ok: false, error: 'already_reported' });

    const partner = partnerOf(room, user);
    if (!partner) return reply(ack, { ok: false, error: 'not_in_chat' });

    let note = '';
    if (typeof payload.note === 'string') {
      note = sanitizeText(payload.note.slice(0, 600)).replace(/\s+/g, ' ');
      note = [...note].slice(0, 200).join('');
    }
    const context = config.reportIncludeMessages
      ? room.messages.filter((m) => m.senderId === partner.id).slice(-5).map((m) => m.text)
      : undefined;

    const { autoBanned } = moderation.addReport({
      reason: payload.reason,
      note,
      reportedRef: partner.ipHash,
      reporterRef: user.ipHash,
      alias: room.aliases[partner.id],
      conversationAgeSec: Math.round((Date.now() - room.createdAt) / 1000),
      messageCount: room.messages.length,
      context,
    });
    room.reportedBy.add(user.id);

    reply(ack, { ok: true });
    if (autoBanned) forceRemove(partner, 'banned');
    return undefined;
  }

  function handleBlock(user, _payload, ack) {
    const room = getActiveRoom(user);
    if (!room) return reply(ack, { ok: false, error: 'not_in_chat' });
    const partner = partnerOf(room, user);
    if (partner) {
      user.blockedIds.add(partner.id);
      if (partner.ipHash !== user.ipHash) user.blockedIps.add(partner.ipHash);
    }
    // Ack first so the client knows this end was a block before `chat_ended` arrives.
    // The other person only sees that the stranger left; they are never told they were blocked.
    reply(ack, { ok: true });
    endRoom(room, user.id, 'partner_ended');
    return undefined;
  }

  /* --------------------------------- sockets -------------------------------- */

  io.use((socket, next) => {
    const ipHash = hashIp(getClientIp(socket.handshake, config.trustProxy), config.ipHashSecret);
    const ban = moderation.isBanned(ipHash);
    if (ban.banned) {
      const err = new Error('banned');
      err.data = { code: 'banned', message: ERROR_MESSAGES.banned, retryAfterMs: ban.retryAfterMs };
      return next(err);
    }
    socket.data.ipHash = ipHash;
    return next();
  });

  io.on('connection', (socket) => {
    const ipHash = socket.data.ipHash;

    if (!connections.acquire(ipHash)) {
      socket.emit('connection_error', { code: 'too_many_connections', message: ERROR_MESSAGES.too_many_connections });
      socket.disconnect(true);
      return;
    }
    socket.on('disconnect', () => connections.release(ipHash));

    // Resume an existing session (refresh / network drop) or start a new one.
    const sid = socket.handshake.auth && socket.handshake.auth.sid;
    const user = users.getBySid(sid) || users.create({ ipHash });
    user.ipHash = ipHash;

    if (user.socket && user.socket !== socket) {
      const old = user.socket;
      user.socket = null;
      old.emit('connection_error', { code: 'session_replaced', message: ERROR_MESSAGES.session_replaced });
      old.disconnect(true);
    }
    if (user.graceTimer) clearTimeout(user.graceTimer);
    user.graceTimer = null;
    user.socket = socket;
    user.online = true;

    // Global per-connection flood guard.
    socket.use((packet, next) => {
      if (limiters.event.consume(user.id).allowed) return next();
      socket.emit('connection_error', { code: 'rate_limited', message: ERROR_MESSAGES.rate_limited });
      punish(user, 1);
      return undefined; // packet dropped
    });

    const on = (event, handler) => {
      socket.on(event, (payload, ack) => {
        if (user.socket !== socket) return; // stale socket
        if (typeof payload === 'function') {
          ack = payload; // eslint-disable-line no-param-reassign
          payload = undefined; // eslint-disable-line no-param-reassign
        }
        try {
          handler(user, payload, ack);
        } catch (err) {
          // Never log payloads: they can contain message text.
          console.error(`[socket] handler "${event}" failed: ${err && err.message}`);
          reply(ack, { ok: false, error: 'server_error' });
          socket.emit('connection_error', { code: 'server_error', message: ERROR_MESSAGES.server_error });
        }
      });
    };

    on('find_stranger', handleFind);
    on('cancel_matching', handleCancel);
    on('send_message', handleSend);
    on('typing_start', (u) => relayTyping(u, 'typing_start'));
    on('typing_stop', (u) => relayTyping(u, 'typing_stop'));
    on('end_chat', handleEnd);
    on('report_user', handleReport);
    on('block_user', handleBlock);

    socket.on('disconnect', () => {
      if (user.socket !== socket) return; // replaced by a newer socket, or removed
      user.socket = null;
      user.online = false;
      leaveQueue(user); // never keep an offline user in the waiting queue

      const room = getActiveRoom(user);
      if (room) {
        const partner = partnerOf(room, user);
        emitTo(partner, 'typing_stop', {});
        emitTo(partner, 'partner_status', { online: false });
      }
      // Give refreshes and network blips a short window to come back.
      if (user.graceTimer) clearTimeout(user.graceTimer);
      user.graceTimer = setTimeout(() => finalizeUser(user, 'partner_disconnected'), config.reconnectGraceMs);
      if (user.graceTimer.unref) user.graceTimer.unref();
    });

    // Tell this tab who it is and what state it is in.
    const room = getActiveRoom(user);
    let chat = null;
    if (room) {
      socket.join(room.name);
      const partner = partnerOf(room, user);
      chat = {
        you: room.aliases[user.id],
        stranger: room.aliases[partner.id],
        interest: sharedInterest(user, partner),
        partnerOnline: !!(partner && partner.online),
        messages: room.messages.map((m) => toClientMessage(m, user.id)),
      };
      emitTo(partner, 'partner_status', { online: true });
    }
    socket.emit('session', {
      sid: user.sid,
      state: room ? 'chatting' : 'idle',
      limits: { maxMessageLength: config.maxMessageLength },
      chat,
    });
  });

  /* -------------------------------- upkeep --------------------------------- */

  const sweeper = setInterval(() => {
    for (const limiter of Object.values(limiters)) limiter.sweep();
    strikes.sweep();
    moderation.sweep();
  }, 60000);
  if (sweeper.unref) sweeper.unref();

  return {
    stats: () => ({ users: users.size, waiting: queue.size, rooms: rooms.size }),
    close: () => {
      clearInterval(sweeper);
      for (const user of [...users.byId.values()]) {
        clearTimers(user);
        if (user.socket) {
          user.socket.emit('connection_error', {
            code: 'server_restarting',
            message: ERROR_MESSAGES.server_restarting,
          });
        }
      }
    },
  };
}

module.exports = { registerSocketHandlers, getClientIp, ERROR_MESSAGES };
