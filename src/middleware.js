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

  // 4. Authentication Middleware
  app.use((req, res, next) => {
    req.isLocalhost = true;
    req.deviceToken = 'public-device';
    req.device = { name: 'Mobile Device', ipAddress: req.ip || req.connection.remoteAddress };
    next();
  });
}

module.exports = { registerMiddleware };
