(() => {
  'use strict';

  // Backend configuration URL.
  // When running on GitHub Pages or external frontend, set this to the Render backend URL.
  // In development/local testing, fallback to location.origin if running on same server.
  const isRenderServer = location.hostname.includes('onrender.com') || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  window.CONFIG = Object.freeze({
    BACKEND_URL: isRenderServer ? window.location.origin : 'https://anonymous-chat-4whq.onrender.com',
  });
})();
