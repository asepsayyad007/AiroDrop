const express = require('express');
const router = express.Router();
const state = require('../state');
const pkg = require('../../package.json');

/**
 * GET /api/discovery
 * Lightweight, unauthenticated discovery endpoint for LAN PWA discovery.
 * Returns safe server metadata and capabilities without exposing private data.
 */
router.get('/discovery', (req, res) => {
  // Hardened discovery response headers
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const port = state.PORT || 3478;
  const devName = state.DEVICE_NAME || require('os').hostname() || 'AiroDrop PC';

  res.json({
    service: 'airodrop',
    version: pkg.version || '6.4.86',
    name: devName,
    platform: process.platform,
    protocol: state.HTTPS_ENABLED ? 'https' : 'http',
    port: port,
    fallbackPort: port + 1,
    authRequired: state.SECURITY_MODE === 'pin' && !!state.PIN_CODE,
    capabilities: {
      fileTransfer: true,
      clipboard: true,
      screencast: true,
      trackpad: true,
      mediaControl: true
    }
  });
});

module.exports = router;
