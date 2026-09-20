'use strict';

const crypto = require('crypto');

/** Interests shown in the UI. The server is the source of truth for validation. */
const INTERESTS = Object.freeze([
  'random',
  'music',
  'gaming',
  'movies',
  'technology',
  'school',
  'business',
  'relationships',
  'other',
]);

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function toList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the runtime configuration from environment variables.
 * Every value is clamped to a sane range so a typo cannot disable a safety limit.
 */
function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';

  return Object.freeze({
    env: isProd ? 'production' : 'development',
    isProd,
    port: toInt(env.PORT, 3000, 0, 65535),

    // Security / network
    corsOrigins: toList(env.CORS_ORIGINS).map((o) => o.replace(/\/+$/, '')),
    trustProxy: toInt(env.TRUST_PROXY, isProd ? 1 : 0, 0, 10),
    ipHashSecret: env.IP_HASH_SECRET || crypto.randomBytes(32).toString('hex'),
    adminToken: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24 ? env.ADMIN_TOKEN : '',

    // Message limits
    maxMessageLength: toInt(env.MAX_MESSAGE_LENGTH, 500, 1, 2000),
    messageRateMax: toInt(env.MESSAGE_RATE_MAX, 5, 1, 100),
    messageRateWindowMs: toInt(env.MESSAGE_RATE_WINDOW_MS, 5000, 500, 60000),
    typingRateMax: 15,
    typingRateWindowMs: 5000,
    findRateMax: 8,
    findRateWindowMs: 60000,
    reportRateMax: 3,
    reportRateWindowMs: 10 * 60 * 1000,
    eventRateMax: 80,
    eventRateWindowMs: 10000,
    maxConnectionsPerIp: toInt(env.MAX_CONNECTIONS_PER_IP, 5, 1, 100),
    maxRoomMessages: toInt(env.MAX_ROOM_MESSAGES, 300, 10, 2000),

    // Matching
    interestMatchTimeoutMs: toInt(env.INTEREST_MATCH_TIMEOUT_MS, 15000, 100, 300000),
    reconnectGraceMs: toInt(env.RECONNECT_GRACE_MS, 20000, 100, 300000),
    rematchCooldownMs: toInt(env.REMATCH_COOLDOWN_MS, 60000, 0, 3600000),
    allowSameIpMatch: !toBool(env.BLOCK_SAME_IP_MATCH, false),

    // Moderation
    allowLinks: toBool(env.ALLOW_LINKS, false),
    blockedWords: toList(env.BLOCKED_WORDS),
    strikeLimit: toInt(env.STRIKE_LIMIT, 8, 1, 100),
    strikeWindowMs: toInt(env.STRIKE_WINDOW_MS, 300000, 1000, 3600000),
    banDurationMs: toInt(env.BAN_DURATION_MS, 600000, 1000, 7 * 24 * 3600 * 1000),
    reportAutoBanThreshold: toInt(env.REPORT_AUTO_BAN_THRESHOLD, 3, 1, 50),
    reportIncludeMessages: toBool(env.REPORT_INCLUDE_MESSAGES, false),
  });
}

module.exports = { loadConfig, INTERESTS };
