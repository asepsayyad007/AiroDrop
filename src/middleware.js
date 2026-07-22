const express = require('express');
const helmet = require('helmet');
const hpp = require('hpp');
const crypto = require('crypto');
const state = require('./state');
const { getLocalIP } = require('./utils');
const { getLogger } = require('./logger');

function registerMiddleware(app) {
  const logger = getLogger();

  // ─── 0. Trust proxy for correct IP resolution ──────────────
  app.set('trust proxy', 'loopback');

  // ─── 0b. Request ID Tracking ───────────────────────────────
  app.use((req, res, next) => {
    req.requestId = crypto.randomBytes(8).toString('hex');
    res.setHeader('X-Request-ID', req.requestId);
    next();
  });

  // ─── 1. Helmet — HTTP Security Headers ─────────────────────
  app.use(helmet({
    // CSP: allow inline scripts/styles (current frontend architecture requires it)
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        scriptSrcAttr: null, // Allow inline event handlers (onclick, etc.)
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        mediaSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        frameSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null // Disable — local network HTTP is intentional
      }
    },
    // Prevent clickjacking
    frameguard: { action: 'sameorigin' },
    // Prevent MIME sniffing
    noSniff: true,
    // Referrer policy
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Disable HSTS — local network HTTP must work
    hsts: false,
    // Disable crossOriginEmbedderPolicy — breaks local resource loading
    crossOriginEmbedderPolicy: false,
    // Disable crossOriginOpenerPolicy — Electron loads from file:// protocol
    crossOriginOpenerPolicy: false,
    // Allow cross-origin resource loading (Electron loads from file://)
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // DNS prefetch control
    dnsPrefetchControl: { allow: false },
    // Hide X-Powered-By (helmet does this by default)
    hidePoweredBy: true
  }));

  // ─── 2. HPP — HTTP Parameter Pollution Protection ──────────
  app.use(hpp());

  // ─── 3. Request Timeout ────────────────────────────────────
  app.use((req, res, next) => {
    // Long-running endpoints get extended timeouts
    const longPaths = ['/files/upload-chunk', '/files/upload', '/api/send', '/api/image', '/api/file', '/files/download'];
    const isLong = longPaths.some(p => req.path.startsWith(p));
    const timeout = isLong ? 10 * 60 * 1000 : 30 * 1000; // 10min for uploads, 30s for API

    req.setTimeout(timeout);
    res.setTimeout(timeout);

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn('Request timeout', { path: req.path, method: req.method, timeout });
        res.status(408).json({ error: 'Request timeout' });
      }
    }, timeout);

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  });

  // ─── 4. Rate Limiter (Sliding Window) ──────────────────────
  // Sliding window rate limiter with per-endpoint awareness
  const RATE_WINDOW_MS = 60000;
  const RATE_LIMITS = {
    default: 60,           // 60 requests/min for general API
    auth: 20,             // 20 requests/min for auth endpoints
    upload: 20,           // 20 requests/min for uploads
    control: 30           // 30 requests/min for control actions
  };

  function getRateCategory(path) {
    if (path.startsWith('/api/auth/')) return 'auth';
    if (path.startsWith('/files/upload') || path === '/api/send' || path === '/api/image' || path === '/api/file') return 'upload';
    if (path === '/api/control' || path === '/api/screencast/pause') return 'control';
    return 'default';
  }

  app.use((req, res, next) => {
    if (!state.RATE_LIMIT_ENABLED) return next();

    // Exempt localhost from rate limiting — the PC dashboard should never be throttled
    const remoteIp = (req.ip || req.connection.remoteAddress || '').replace(/^.*:/, '');
    if (remoteIp === '127.0.0.1' || remoteIp === 'localhost' || remoteIp === '1') {
      return next();
    }

    const cleanPath = req.path.toLowerCase();
    // Skip rate limiting for static assets, SSE, and health
    if (
      cleanPath === '/api/events' ||
      cleanPath === '/api/health' ||
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
      cleanPath.startsWith('/files/')
    ) {
      // Still allow /files/upload* to be rate limited
      if (!cleanPath.startsWith('/files/upload')) return next();
    }

    const ip = req.ip || req.connection.remoteAddress;
    const category = getRateCategory(cleanPath);
    const maxRequests = RATE_LIMITS[category];
    const now = Date.now();

    // Sliding window: store array of timestamps per IP+category
    const key = `${ip}:${category}`;
    let timestamps = state.rateLimitMap.get(key);

    if (!timestamps) {
      timestamps = [];
      state.rateLimitMap.set(key, timestamps);
    }

    // Remove timestamps outside the window
    while (timestamps.length > 0 && timestamps[0] <= now - RATE_WINDOW_MS) {
      timestamps.shift();
    }

    if (timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((timestamps[0] + RATE_WINDOW_MS - now) / 1000);
      logger.warn('Rate limit exceeded', { ip, path: req.path, category, limit: maxRequests });
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests. Slow down.',
        retryAfter
      });
    }

    timestamps.push(now);
    next();
  });

  // Periodic cleanup of stale rate limit entries (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of state.rateLimitMap.entries()) {
      // Remove entries with no recent activity
      if (!Array.isArray(timestamps)) {
        state.rateLimitMap.delete(key);
        continue;
      }
      while (timestamps.length > 0 && timestamps[0] <= now - RATE_WINDOW_MS) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        state.rateLimitMap.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  // ─── 5. Dynamic Content-Type Body Parsers (Differentiated Limits) ───
  const jsonParser = express.json({ limit: '1mb' });          // API payloads: 1mb max
  const jsonParserLarge = express.json({ limit: '10mb' });    // Text/content endpoints
  const urlencodedParser = express.urlencoded({ extended: true, limit: '1mb' });
  const rawParser = express.raw({ type: '*/*', limit: '50mb' }); // Binary uploads (image/file)

  // Paths that receive large text/JSON payloads (scratchpad, text content)
  const largeJsonPaths = ['/api/text', '/api/scratchpad', '/api/send'];

  app.use((req, res, next) => {
    // Chunked file uploads — skip body parsing entirely
    if (req.path === '/files/upload-chunk') {
      return next();
    }
    const contentType = req.headers['content-type'] || '';
    // Multer handles multipart and raw binary for /api/send
    if (req.path === '/api/send') {
      return next();
    }
    if (contentType.includes('multipart/form-data')) {
      next();
    } else if (contentType.includes('application/json')) {
      // Use larger limit for content-receiving endpoints
      if (largeJsonPaths.includes(req.path)) {
        jsonParserLarge(req, res, next);
      } else {
        jsonParser(req, res, next);
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      urlencodedParser(req, res, next);
    } else {
      rawParser(req, res, next);
    }
  });

  // ─── 6. CORS — Hardened Local Network Policy ───────────────
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigin = getValidatedOrigin(origin);

    if (allowedOrigin) {
      res.header('Access-Control-Allow-Origin', allowedOrigin);
      res.header('Access-Control-Allow-Credentials', 'true');
    } else if (!origin) {
      // No origin header — same-origin request, curl, iOS Shortcuts, or non-browser
      res.header('Access-Control-Allow-Origin', '*');
    }
    // If origin is present but not allowed, don't set the header (browser will block)

    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-AiroDrop-Token, X-Filename');
    res.header('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
    res.header('Access-Control-Max-Age', '86400'); // Cache preflight for 24h

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // ─── 7. HTTP Request Logging ─────────────────────────────────
  app.use((req, res, next) => {
    // Skip logging for static assets and SSE heartbeats
    const p = req.path.toLowerCase();
    if (p === '/api/events' || p.endsWith('.css') || p.endsWith('.js') || p.endsWith('.png') ||
        p.endsWith('.ico') || p.endsWith('.svg') || p.endsWith('.woff') || p.endsWith('.woff2') ||
        p === '/manifest.json') {
      return next();
    }

    const start = Date.now();
    const originalEnd = res.end;

    res.end = function (...args) {
      const duration = Date.now() - start;
      const logData = {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: `${duration}ms`,
        ip: req.ip
      };

      if (res.statusCode >= 500) {
        logger.error('Request failed', logData);
      } else if (res.statusCode >= 400) {
        logger.warn('Client error', logData);
      } else {
        logger.http('Request completed', logData);
      }

      originalEnd.apply(res, args);
    };

    next();
  });

  // ─── 8. CSRF Protection for State-Changing Endpoints ───────
  app.use((req, res, next) => {
    // Only protect state-changing methods
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }

    const remoteIp = (req.ip || req.connection.remoteAddress || '').replace(/^.*:/, '');
    const isLoopback = remoteIp === '127.0.0.1' || remoteIp === 'localhost' || remoteIp === '1';

    // Exempt localhost (Electron app)
    if (isLoopback) return next();

    // Exempt iOS Shortcut / automation requests (they use secret token auth)
    const hasShortcutAuth = req.headers['x-airodrop-token'] || (req.query && req.query.shortcut_secret);
    if (hasShortcutAuth) return next();

    // Exempt API requests with explicit auth header (Bearer token)
    const hasAuthHeader = req.headers['authorization'];
    if (hasAuthHeader) return next();

    // Exempt requests with X-Requested-With (XHR/fetch from same origin)
    if (req.headers['x-requested-with']) return next();

    // For browser requests: validate Origin or Referer
    const origin = req.headers.origin;
    const referer = req.headers.referer;

    if (origin) {
      if (isAllowedOrigin(origin)) return next();
      return res.status(403).json({ error: 'CSRF protection: origin not allowed' });
    }

    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (isAllowedOrigin(refUrl.origin)) return next();
      } catch {}
      return res.status(403).json({ error: 'CSRF protection: referer not allowed' });
    }

    // No origin/referer and no auth — allow (could be curl, non-browser tools)
    // This is permissive for local-network tool compatibility
    next();
  });

  // ─── 9. Authentication Middleware & Loopback Verification ──
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

  // ─── 10. Device Authentication Middleware ──────────────────
  const { authMiddleware } = require('./auth');
  app.use(authMiddleware);
}

// ─── CORS Helpers ─────────────────────────────────────────────

/**
 * Check if an origin is allowed (local network, localhost, or server's own IP)
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    const hostname = url.hostname;

    // Allow localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }

    // Allow local network IPs (RFC 1918)
    if (isPrivateIP(hostname)) {
      return true;
    }

    // Allow the server's own advertised IP
    const serverIP = getLocalIP();
    if (hostname === serverIP) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Return the origin if it's allowed, null otherwise
 */
function getValidatedOrigin(origin) {
  if (!origin) return null;
  return isAllowedOrigin(origin) ? origin : null;
}

/**
 * Check if an IP address belongs to a private/local network range
 */
function isPrivateIP(ip) {
  // IPv4 private ranges
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
  }
  return false;
}

module.exports = { registerMiddleware, isAllowedOrigin, isPrivateIP };
