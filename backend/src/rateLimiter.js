'use strict';

/**
 * Sliding-window rate limiter kept entirely in memory.
 *
 * Each key (a user id, for example) holds the timestamps of its recent
 * accepted hits. A hit is refused when `max` hits already happened inside the
 * last `windowMs` milliseconds. Refused hits are NOT recorded, so a client
 * that keeps hammering does not extend its own lockout.
 */
class RateLimiter {
  constructor({ windowMs, max }) {
    if (!(windowMs > 0) || !(max > 0)) throw new Error('RateLimiter needs windowMs > 0 and max > 0');
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  /**
   * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
   */
  consume(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    // Drop timestamps that fell out of the window (list is chronological).
    let drop = 0;
    while (drop < list.length && list[drop] <= cutoff) drop += 1;
    if (drop > 0) list.splice(0, drop);

    if (list.length >= this.max) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, list[0] + this.windowMs - now) };
    }
    list.push(now);
    return { allowed: true, remaining: this.max - list.length, retryAfterMs: 0 };
  }

  reset(key) {
    this.hits.delete(key);
  }

  /** Remove keys with no recent activity so the map cannot grow forever. */
  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.hits) {
      if (list.length === 0 || list[list.length - 1] <= cutoff) this.hits.delete(key);
    }
  }

  get size() {
    return this.hits.size;
  }
}

/** Caps the number of simultaneous connections per key (a hashed IP). */
class ConnectionLimiter {
  constructor(maxPerKey) {
    this.max = maxPerKey;
    this.counts = new Map();
  }

  acquire(key) {
    const current = this.counts.get(key) || 0;
    if (current >= this.max) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  release(key) {
    const current = this.counts.get(key) || 0;
    if (current <= 1) this.counts.delete(key);
    else this.counts.set(key, current - 1);
  }

  count(key) {
    return this.counts.get(key) || 0;
  }
}

module.exports = { RateLimiter, ConnectionLimiter };
