'use strict';

const crypto = require('crypto');

const SID_RE = /^[a-f0-9]{48}$/;

/**
 * Ephemeral in-memory users. There is no account: a user is just a random
 * session token (`sid`) held by one browser tab, plus some short-lived state.
 *  - `id`  internal identifier, never sent to any client
 *  - `sid` secret bearer token sent only to the owning tab so it can resume after a refresh
 */
class UserRegistry {
  constructor() {
    this.byId = new Map();
    this.bySid = new Map();
  }

  create({ ipHash }) {
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      sid: crypto.randomBytes(24).toString('hex'),
      ipHash,
      socket: null,
      online: false,
      state: 'idle', // idle | waiting | chatting
      interest: 'random',
      anyone: true,
      roomId: null,
      blockedIds: new Set(),
      blockedIps: new Set(),
      recentPartners: new Map(), // partnerId -> cooldown expiry
      recentTexts: [],
      graceTimer: null,
      waitTimer: null,
    };
    this.byId.set(user.id, user);
    this.bySid.set(user.sid, user);
    return user;
  }

  getById(id) {
    return this.byId.get(id) || null;
  }

  getBySid(sid) {
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
    return this.bySid.get(sid) || null;
  }

  remove(user) {
    this.byId.delete(user.id);
    this.bySid.delete(user.sid);
  }

  get size() {
    return this.byId.size;
  }
}

module.exports = { UserRegistry };
