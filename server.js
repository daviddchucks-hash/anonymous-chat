'use strict';

const { start, createServer } = require('./backend/server.js');

if (require.main === module) {
  start();
}

module.exports = { start, createServer };
