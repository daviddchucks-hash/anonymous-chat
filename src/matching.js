'use strict';

/**
 * Server-side waiting queue.
 *
 * An entry is { userId, interest, anyone, since }.
 *  - `interest` is what the user picked ("random" means no preference).
 *  - `anyone` is true for "random" users and for users who agreed to be matched
 *    with any topic after their own interest timed out.
 *
 * Two entries are compatible only if BOTH accept the other:
 *   accepts(a, b) = a.anyone || a.interest === b.interest
 *
 * Everything here is synchronous. Node runs one JS task at a time, so
 * `enqueueOrMatch` cannot interleave with another call: a user is either
 * removed from the queue as part of a match or left in it, never both.
 */
function accepts(a, b) {
  return a.anyone || a.interest === b.interest;
}

class MatchQueue {
  constructor() {
    this.entries = new Map(); // userId -> entry (insertion order = arrival order)
  }

  has(userId) {
    return this.entries.has(userId);
  }

  get(userId) {
    return this.entries.get(userId);
  }

  remove(userId) {
    return this.entries.delete(userId);
  }

  get size() {
    return this.entries.size;
  }

  /**
   * Try to pair `entry` with someone already waiting. If a partner is found it
   * is removed from the queue and returned; otherwise `entry` is queued and
   * null is returned.
   *
   * @param {object} entry
   * @param {(other: object) => boolean} canPair extra per-user rules (blocks, cooldown, self)
   */
  enqueueOrMatch(entry, canPair = () => true) {
    this.entries.delete(entry.userId); // defensive: never allow a duplicate entry

    let sameInterest = null;
    let fallback = null;
    for (const other of this.entries.values()) {
      if (other.userId === entry.userId) continue;
      if (!(accepts(entry, other) && accepts(other, entry))) continue;
      if (!canPair(other)) continue;
      if (other.interest === entry.interest) {
        sameInterest = other;
        break; // oldest waiting user with the same interest wins
      }
      if (!fallback) fallback = other;
    }

    const partner = sameInterest || fallback;
    if (partner) {
      this.entries.delete(partner.userId);
      return partner;
    }
    this.entries.set(entry.userId, entry);
    return null;
  }
}

module.exports = { MatchQueue, accepts };
