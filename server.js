'use strict';

// Proxy entrypoint for root directory so 'node server.js' on Render works seamlessly
module.exports = require('./backend/server.js');
