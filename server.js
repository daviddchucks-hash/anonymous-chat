'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const { loadConfig } = require('./src/config');
const { ModerationStore } = require('./src/moderation');
const { registerSocketHandlers } = require('./src/socketHandlers');
const { createHealthRouter } = require('./routes/health');
const { createAdminRouter } = require('./routes/admin');

/**
 * Build the HTTP + WebSocket server without starting to listen, so tests can
 * boot it on a random port with their own settings.
 */
function createServer(env = process.env) {
  const config = loadConfig(env);
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  /* ----------------------------- security headers ---------------------------- */
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"], // no inline scripts, no third-party scripts
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"], // system fonts only: no third-party font requests
          // ws:/wss: are listed explicitly because some Safari versions do not treat 'self' as covering WebSockets.
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginEmbedderPolicy: false,
    })
  );

  /* ----------------------------------- CORS ---------------------------------- */
  // Same-origin by default. Extra origins must be listed in CORS_ORIGINS.
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      methods: ['GET', 'POST'],
      credentials: false,
    })
  );

  /* ------------------------------ HTTP rate limit ---------------------------- */
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: 'Too many requests, please slow down.',
    })
  );

  /* ---------------------------- moderation + sockets ------------------------- */
  const moderation = new ModerationStore({
    autoBanThreshold: config.reportAutoBanThreshold,
    banDurationMs: config.banDurationMs,
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: config.corsOrigins.length ? config.corsOrigins : false, methods: ['GET', 'POST'] },
    // Cross-site WebSocket hijacking guard: browsers must come from this site or an allowed origin.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (!origin) return callback(null, true); // non-browser client: nothing to hijack
      try {
        if (new URL(origin).host === req.headers.host || config.corsOrigins.includes(origin)) {
          return callback(null, true);
        }
      } catch (_) {
        /* fall through */
      }
      return callback('Origin not allowed', false);
    },
    maxHttpBufferSize: 8 * 1024, // a message is at most a few KB; refuse anything bigger
    pingInterval: 25000,
    pingTimeout: 20000,
    connectTimeout: 10000,
    perMessageDeflate: false,
  });
  const chat = registerSocketHandlers(io, { config, moderation });

  /* ---------------------------------- routes --------------------------------- */
  app.use(createHealthRouter());
  if (config.adminToken) {
    app.use('/admin/api', createAdminRouter({ config, moderation, chat }));
  }

  app.use(
    express.static(path.join(__dirname, 'public'), {
      maxAge: config.isProd ? '1h' : 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.use((req, res) => {
    res.status(404);
    if (req.accepts(['html', 'json']) === 'json') return res.json({ error: 'Not found' });
    return res.type('text/plain').send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`[http] ${err && err.message}`);
    if (res.headersSent) return;
    res.status(err && err.status && err.status < 500 ? err.status : 500).json({ error: 'Request failed' });
  });

  function close() {
    return new Promise((resolve) => {
      chat.close();
      io.close(() => resolve());
    });
  }

  return { app, server, io, config, moderation, chat, close };
}

function start() {
  const { server, config, close } = createServer();

  server.listen(config.port, () => {
    console.log(`Passerby listening on port ${config.port} (${config.env})`);
    if (config.isProd && !process.env.IP_HASH_SECRET) {
      console.warn('IP_HASH_SECRET is not set: a random one is used, so bans reset on every restart.');
    }
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.message ? reason.message : 'unknown');
  });
}

if (require.main === module) start();

module.exports = { createServer };
