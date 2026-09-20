'use strict';

const crypto = require('crypto');

/* -------------------------------------------------------------------------- */
/* Identity helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Turn an IP address into a short opaque token. The raw IP is never stored or
 * logged; the token only lets us rate-limit, ban and count distinct reporters.
 */
function hashIp(ip, secret) {
  return crypto.createHmac('sha256', secret).update(String(ip)).digest('hex').slice(0, 16);
}

const REPORT_REASONS = Object.freeze([
  'spam',
  'harassment',
  'sexual_content',
  'hate_speech',
  'underage',
  'other',
]);

/* -------------------------------------------------------------------------- */
/* Text sanitising                                                             */
/* -------------------------------------------------------------------------- */

// Control characters (except \n and \t), soft hyphen, zero-width space, LTR/RTL
// marks, bidi overrides/isolates, word joiner and BOM. ZWJ/ZWNJ (U+200C/D) are
// kept because emoji sequences and some scripts need them.
// eslint-disable-next-line no-control-regex
const STRIP_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g;

/**
 * Clean user text. This is NOT HTML escaping: the client renders every message
 * with `textContent`, so markup is displayed literally and can never execute,
 * and the Content-Security-Policy forbids inline scripts as a second layer.
 * Escaping here as well would show users `&lt;` instead of `<`.
 * What this does: normalise Unicode, drop invisible/control/bidi-override
 * characters, cap "zalgo" stacks of combining marks, collapse whitespace.
 */
function sanitizeText(input) {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFC').replace(STRIP_CHARS, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[^\S\n]+/g, ' '); // any run of horizontal whitespace -> one space
  s = s.replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
  s = s.replace(/(\p{M}{3})\p{M}+/gu, '$1'); // limit stacked combining marks
  return s.trim();
}

/** Length in Unicode code points (so an emoji counts as 1). */
function textLength(s) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of s) n += 1;
  return n;
}

const LINK_RE = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(?:com|net|org|io|me|co|ly|gg|xyz|ru|info|biz|tk|cc|to|app|link|click)\b/i;
function containsLink(text) {
  return LINK_RE.test(text);
}

/* -------------------------------------------------------------------------- */
/* Word filter                                                                 */
/* -------------------------------------------------------------------------- */

// Mild profanity is masked with asterisks. Extend with the BLOCKED_WORDS env var.
const MILD_WORDS = [
  'fuck', 'motherfucker', 'shit', 'bullshit', 'bitch', 'bastard', 'asshole', 'ass',
  'dumbass', 'jackass', 'dick', 'dickhead', 'cock', 'pussy', 'cunt', 'whore', 'slut',
  'twat', 'wanker', 'prick', 'douche', 'douchebag',
];

// Slurs and self-harm incitement: the whole message is rejected and it counts as an abuse strike.
const SEVERE_WORDS = ['nigger', 'nigga', 'faggot', 'retard', 'kike', 'spic', 'tranny', 'kys'];
const SEVERE_PHRASES = [
  /\bkill\s*your\s*self\b/i,
  /\bgo\s+die\b/i,
  /\brape\s+(?:you|u|her|him|them)\b/i,
];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
const SUFFIXES = ['s', 'es', 'ed', 'er', 'ers', 'ing', 'in', 'y', 'ies'];

function normalizeToken(token) {
  let t = token.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  // Only de-leet tokens that contain at least one real letter, so "455" stays a number.
  if (/\p{L}/u.test(t)) t = t.replace(/[013457@$]/g, (c) => LEET[c]);
  return t;
}

function variantsOf(t) {
  const out = new Set([t]);
  const collapsed = t.replace(/(.)\1{2,}/g, '$1'); // "fuuuck" -> "fuck"
  out.add(collapsed);
  for (const base of [t, collapsed]) {
    for (const suf of SUFFIXES) {
      if (base.length > suf.length + 2 && base.endsWith(suf)) {
        const stem = base.slice(0, -suf.length);
        out.add(stem);
        if (/(.)\1$/.test(stem)) out.add(stem.slice(0, -1)); // "shitt" -> "shit"
      }
    }
  }
  return out;
}

/**
 * Build a text checker.
 * @param {string[]} extraWords additional words to mask
 * @returns {(text: string) => {text: string, masked: boolean, severe: boolean}}
 */
function buildTextChecker(extraWords = []) {
  const mild = new Set(MILD_WORDS);
  for (const w of extraWords) {
    const n = normalizeToken(w);
    if (n) mild.add(n);
  }
  const severe = new Set(SEVERE_WORDS);

  return function check(text) {
    if (SEVERE_PHRASES.some((re) => re.test(text))) {
      return { text, masked: false, severe: true };
    }
    let isSevere = false;
    let masked = false;
    const cleaned = text.replace(/[\p{L}\p{N}@$]+/gu, (token) => {
      const forms = variantsOf(normalizeToken(token));
      for (const f of forms) {
        if (severe.has(f)) {
          isSevere = true;
          return token;
        }
      }
      for (const f of forms) {
        if (mild.has(f)) {
          masked = true;
          return '*'.repeat(token.length);
        }
      }
      return token;
    });
    return { text: isSevere ? text : cleaned, masked, severe: isSevere };
  };
}

/* -------------------------------------------------------------------------- */
/* Strikes (abuse score per user)                                              */
/* -------------------------------------------------------------------------- */

/** Weighted violation counter over a rolling time window. */
class StrikeTracker {
  constructor({ windowMs }) {
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  /** Record a violation and return the user's current total inside the window. */
  add(key, weight = 1, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const list = (this.entries.get(key) || []).filter((e) => e.ts > cutoff);
    list.push({ ts: now, weight });
    this.entries.set(key, list);
    return list.reduce((sum, e) => sum + e.weight, 0);
  }

  total(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    return (this.entries.get(key) || []).filter((e) => e.ts > cutoff).reduce((s, e) => s + e.weight, 0);
  }

  clear(key) {
    this.entries.delete(key);
  }

  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.entries) {
      if (!list.some((e) => e.ts > cutoff)) this.entries.delete(key);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Moderation store (reports + temporary bans)                                 */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory moderation state. It is deliberately small and exposes plain
 * methods so an admin dashboard (or a database-backed replacement) can be
 * attached later without touching the chat code.
 *
 * A report contains only: id, time, reason code, optional short note, an opaque
 * network token of the reported person, the temporary alias, and two counters.
 * It never contains the reporter's identity or (by default) any message text.
 */
class ModerationStore {
  constructor({ maxReports = 1000, autoBanThreshold = 3, banDurationMs = 600000, now = () => Date.now() } = {}) {
    this.maxReports = maxReports;
    this.autoBanThreshold = autoBanThreshold;
    this.banDurationMs = banDurationMs;
    this.now = now;
    this.reports = [];
    this.bans = new Map(); // ipHash -> { until, reason }
    this.reporters = new Map(); // reportedIpHash -> Map(reporterIpHash -> ts)
    this.counter = 0;
    this.totalBans = 0;
  }

  isBanned(ipHash) {
    const ban = this.bans.get(ipHash);
    if (!ban) return { banned: false, retryAfterMs: 0 };
    const remaining = ban.until - this.now();
    if (remaining <= 0) {
      this.bans.delete(ipHash);
      return { banned: false, retryAfterMs: 0 };
    }
    return { banned: true, retryAfterMs: remaining, reason: ban.reason };
  }

  ban(ipHash, durationMs = this.banDurationMs, reason = 'abuse') {
    this.bans.set(ipHash, { until: this.now() + durationMs, reason });
    this.totalBans += 1;
  }

  /**
   * @returns {{report: object, autoBanned: boolean}}
   */
  addReport({ reason, note = '', reportedRef, reporterRef, alias, conversationAgeSec = 0, messageCount = 0, context }) {
    this.counter += 1;
    const report = {
      id: `r${this.counter}`,
      createdAt: new Date(this.now()).toISOString(),
      status: 'open',
      reason,
      note: note || undefined,
      reportedRef,
      alias,
      conversationAgeSec,
      messageCount,
    };
    if (Array.isArray(context) && context.length) report.context = context;

    this.reports.push(report);
    if (this.reports.length > this.maxReports) this.reports.shift();

    // Count distinct reporters (by network token) for this target over 24h.
    let autoBanned = false;
    if (reporterRef && reporterRef !== reportedRef) {
      let map = this.reporters.get(reportedRef);
      if (!map) {
        map = new Map();
        this.reporters.set(reportedRef, map);
      }
      map.set(reporterRef, this.now());
      for (const [ref, ts] of map) if (this.now() - ts > DAY_MS) map.delete(ref);
      if (map.size >= this.autoBanThreshold) {
        this.ban(reportedRef, this.banDurationMs, 'reports');
        map.clear();
        autoBanned = true;
      }
    }
    return { report, autoBanned };
  }

  list({ status, limit = 100 } = {}) {
    const filtered = status ? this.reports.filter((r) => r.status === status) : this.reports;
    return filtered.slice(-limit).reverse();
  }

  resolve(id, status = 'resolved') {
    const report = this.reports.find((r) => r.id === id);
    if (!report) return null;
    report.status = status;
    return report;
  }

  stats() {
    const open = this.reports.filter((r) => r.status === 'open').length;
    return {
      reportsTotal: this.counter,
      reportsOpen: open,
      activeBans: [...this.bans.keys()].filter((k) => this.isBanned(k).banned).length,
      bansIssued: this.totalBans,
    };
  }

  sweep() {
    for (const key of this.bans.keys()) this.isBanned(key);
    const now = this.now();
    for (const [target, map] of this.reporters) {
      for (const [ref, ts] of map) if (now - ts > DAY_MS) map.delete(ref);
      if (map.size === 0) this.reporters.delete(target);
    }
  }
}

module.exports = {
  hashIp,
  REPORT_REASONS,
  sanitizeText,
  textLength,
  containsLink,
  buildTextChecker,
  StrikeTracker,
  ModerationStore,
};
