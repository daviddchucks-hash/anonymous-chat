'use strict';

const express = require('express');

/** Minimal liveness probe for the hosting platform. Reveals nothing about users. */
function createHealthRouter() {
  const router = express.Router();
  router.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  return router;
}

module.exports = { createHealthRouter };
