'use strict';

const crypto = require('crypto');

const SID_RE = /^[a-f0-9]{48}$/;
const CHAT_ID_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// Characters allowed in Chat ID (unambiguous uppercase alphanumeric)
const CHARS = 'ACDEFGHJKLMNPQRTUVWXYZ23456789';

/**
 * Generate a random Chat ID in format XXXX-XXXX-XXXX.
 * High entropy makes guessing impractical.
 */
function generateChatId() {
  const bytes = crypto.randomBytes(12);
  let id = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) id += '-';
    id += CHARS[bytes[i] % CHARS.length];
  }
  return id;
}

function isValidChatId(chatId) {
  return typeof chatId === 'string' && CHAT_ID_RE.test(chatId);
}

/**
 * Ephemeral in-memory users identified primarily by their Chat ID.
 *  - `chatId`: Public anonymous Chat ID (e.g., AC7K-X92P-Q4LM)
 *  - `id`: Internal unique identifier
 *  - `sid`: Secret session token for reconnection
 */
class UserRegistry {
  constructor() {
    this.byId = new Map();
    this.bySid = new Map();
    this.byChatId = new Map();
  }

  create({ ipHash, requestedChatId = null }) {
    let chatId = requestedChatId;
    if (!chatId || !isValidChatId(chatId) || this.byChatId.has(chatId)) {
      chatId = generateChatId();
      while (this.byChatId.has(chatId)) {
        chatId = generateChatId();
      }
    }

    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      chatId,
      sid: crypto.randomBytes(24).toString('hex'),
      ipHash,
      socket: null,
      online: false,
      state: 'idle', // idle | chatting
      roomId: null,
      blockedChatIds: new Set(),
      blockedIps: new Set(),
      recentPartners: new Map(), // partnerChatId -> cooldown expiry
      recentTexts: [],
      graceTimer: null,
    };

    this.byId.set(user.id, user);
    this.bySid.set(user.sid, user);
    this.byChatId.set(user.chatId, user);
    return user;
  }

  getById(id) {
    return this.byId.get(id) || null;
  }

  getBySid(sid) {
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
    return this.bySid.get(sid) || null;
  }

  getByChatId(chatId) {
    if (typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) return null;
    return this.byChatId.get(chatId) || null;
  }

  remove(user) {
    this.byId.delete(user.id);
    this.bySid.delete(user.sid);
    this.byChatId.delete(user.chatId);
  }

  get size() {
    return this.byId.size;
  }
}

module.exports = { UserRegistry, generateChatId, isValidChatId };
