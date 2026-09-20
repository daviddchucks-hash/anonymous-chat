'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

/**
 * Small JSON API over the moderation store, ready for a future admin dashboard.
 * It is only mounted when ADMIN_TOKEN (24+ characters) is set, and every request
 * must send `Authorization: Bearer <token>`.
 *
 *   GET  /admin/api/stats
 *   GET  /admin/api/reports?status=open&limit=50
 *   POST /admin/api/reports/:id/resolve   body: {"status":"resolved"|"dismissed"}
 */
function createAdminRouter({ config, moderation, chat }) {
  const router = express.Router();

  router.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 60,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests' },
    })
  );
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const expected = Buffer.from(config.adminToken);
  router.use((req, res, next) => {
    const header = req.get('authorization') || '';
    const match = /^Bearer (.+)$/.exec(header);
    const given = Buffer.from(match ? match[1] : '');
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  });

  router.get('/stats', (req, res) => {
    res.json({ moderation: moderation.stats(), live: chat.stats() });
  });

  router.get('/reports', (req, res) => {
    const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : undefined;
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    res.json({ reports: moderation.list({ status, limit }) });
  });

  router.post('/reports/:id/resolve', express.json({ limit: '1kb' }), (req, res) => {
    const status = req.body && req.body.status === 'dismissed' ? 'dismissed' : 'resolved';
    const report = moderation.resolve(String(req.params.id).slice(0, 20), status);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    return res.json({ report });
  });

  return router;
}

module.exports = { createAdminRouter };
