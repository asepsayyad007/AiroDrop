const express = require('express');
const state = require('./state');

function registerMiddleware(app) {
  // 1. Simple Rate Limiter
  app.use((req, res, next) => {
    if (!state.RATE_LIMIT_ENABLED) return next();

    const cleanPath = req.path.toLowerCase();
    if (
      cleanPath === '/api/events' ||
      cleanPath === '/' ||
      cleanPath === '/m' ||
      cleanPath === '/style.css' ||
      cleanPath === '/app.js' ||
      cleanPath === '/manifest.json' ||
      cleanPath === '/sw.js' ||
      cleanPath === '/logo.png' ||
      cleanPath === '/logo-192.png' ||
      cleanPath === '/logo.svg' ||
      cleanPath === '/favicon.ico' ||
      cleanPath.startsWith('/vendor/') ||
      cleanPath.startsWith('/received/') ||
      cleanPath.startsWith('/files')
    ) {
      return next();
    }

    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const entry = state.rateLimitMap.get(ip) || { count: 0, start: now };
    const RATE_WINDOW = 60000;
    const RATE_MAX = 60;

    if (now - entry.start > RATE_WINDOW) {
      entry.count = 0;
      entry.start = now;
    }
    entry.count++;

    if (entry.count > RATE_MAX) {
      return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }

    state.rateLimitMap.set(ip, entry);
    next();
  });

  // 2. Dynamic Content-Type body parsers
  const jsonParser = express.json({ limit: '10mb' });
  const urlencodedParser = express.urlencoded({ extended: true, limit: '10mb' });
  const rawParser = express.raw({ type: '*/*', limit: '50mb' });

  app.use((req, res, next) => {
    if (req.path === '/files/upload-chunk') {
      return next();
    }
    const contentType = req.headers['content-type'] || '';
    // Skip body parsing for /api/send — multer handles it directly (raw binary + multipart)
    if (req.path === '/api/send') {
      return next();
    }
    if (contentType.includes('multipart/form-data')) {
      next();
    } else if (contentType.includes('application/json')) {
      jsonParser(req, res, next);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      urlencodedParser(req, res, next);
    } else {
      rawParser(req, res, next);
    }
  });

  // 3. CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // 4. Authentication Middleware & Loopback Verification
  app.use((req, res, next) => {
    const remoteIp = (req.ip || req.connection.remoteAddress || '').replace(/^.*:/, '');
    const isLoopback = remoteIp === '127.0.0.1' || remoteIp === 'localhost' || remoteIp === '1';

    req.isLocalhost = isLoopback;
    req.deviceToken = 'public-device';
    req.device = { name: 'Mobile Device', ipAddress: req.ip || req.connection.remoteAddress };

    // Protect administrative paths against unauthorized LAN remote requests
    const hostOnlyPaths = [
      '/api/settings/browse',
      '/api/screencast/pause'
    ];

    if (!isLoopback && hostOnlyPaths.includes(req.path.toLowerCase())) {
      return res.status(403).json({ error: 'Access denied: Administrative path restricted to host machine loopback' });
    }

    next();
  });

  // 5. Device Authentication Middleware
  const { authMiddleware } = require('./auth');
  app.use(authMiddleware);
}

module.exports = { registerMiddleware };
