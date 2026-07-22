const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const state = require('./state');

// ─── Brute-Force Protection ──────────────────────────────────
const pinAttempts = new Map(); // IP → { count, firstAttempt, lockedUntil }
const BRUTE_FORCE_MAX_ATTEMPTS = 5;
const BRUTE_FORCE_WINDOW_MS = 5 * 60 * 1000;       // 5 minutes
const BRUTE_FORCE_LOCKOUT_MS = 5 * 60 * 1000;      // 5 min lockout after 5 attempts
const BRUTE_FORCE_HARD_LOCKOUT_MS = 30 * 60 * 1000; // 30 min lockout after 10 attempts
const BRUTE_FORCE_HARD_THRESHOLD = 10;

// Clean up expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of pinAttempts.entries()) {
    if (entry.lockedUntil && now > entry.lockedUntil) {
      pinAttempts.delete(ip);
    } else if (!entry.lockedUntil && (now - entry.firstAttempt > BRUTE_FORCE_WINDOW_MS)) {
      pinAttempts.delete(ip);
    }
  }
}, 10 * 60 * 1000);

/**
 * Check if an IP is currently locked out from PIN attempts.
 * @param {string} ip
 * @returns {{ locked: boolean, retryAfter: number|null }}
 */
function checkPinRateLimit(ip) {
  const entry = pinAttempts.get(ip);
  if (!entry) return { locked: false, retryAfter: null };

  const now = Date.now();

  // If locked, check if lockout has expired
  if (entry.lockedUntil) {
    if (now < entry.lockedUntil) {
      const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000);
      return { locked: true, retryAfter };
    }
    // Lockout expired — reset
    pinAttempts.delete(ip);
    return { locked: false, retryAfter: null };
  }

  return { locked: false, retryAfter: null };
}

/**
 * Record a failed PIN attempt for an IP.
 * @param {string} ip
 * @returns {{ locked: boolean, retryAfter: number|null }}
 */
function recordFailedPinAttempt(ip) {
  const now = Date.now();
  let entry = pinAttempts.get(ip);

  if (!entry) {
    entry = { count: 1, firstAttempt: now, lockedUntil: null };
    pinAttempts.set(ip, entry);
    return { locked: false, retryAfter: null };
  }

  // If window has expired, reset
  if (now - entry.firstAttempt > BRUTE_FORCE_WINDOW_MS && !entry.lockedUntil) {
    entry.count = 1;
    entry.firstAttempt = now;
    entry.lockedUntil = null;
    return { locked: false, retryAfter: null };
  }

  entry.count++;

  // Hard lockout (30 min) after 10 attempts
  if (entry.count >= BRUTE_FORCE_HARD_THRESHOLD) {
    entry.lockedUntil = now + BRUTE_FORCE_HARD_LOCKOUT_MS;
    const retryAfter = Math.ceil(BRUTE_FORCE_HARD_LOCKOUT_MS / 1000);
    console.warn(`[AUTH] Hard lockout triggered for IP ${ip} after ${entry.count} failed PIN attempts`);
    return { locked: true, retryAfter };
  }

  // Soft lockout (5 min) after 5 attempts
  if (entry.count >= BRUTE_FORCE_MAX_ATTEMPTS) {
    entry.lockedUntil = now + BRUTE_FORCE_LOCKOUT_MS;
    const retryAfter = Math.ceil(BRUTE_FORCE_LOCKOUT_MS / 1000);
    console.warn(`[AUTH] Lockout triggered for IP ${ip} after ${entry.count} failed PIN attempts`);
    return { locked: true, retryAfter };
  }

  return { locked: false, retryAfter: null };
}

/**
 * Clear PIN attempt tracking for an IP (on successful auth).
 * @param {string} ip
 */
function clearPinAttempts(ip) {
  pinAttempts.delete(ip);
}

/**
 * Generate a random 4-digit PIN code.
 * @returns {string} A 4-digit numeric string
 */
function generatePin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/**
 * Initialize the authentication subsystem.
 * Ensures a PIN is set and loads paired devices from disk.
 */
function initAuth() {
  // Ensure a 4-digit PIN is set
  if (!state.PIN_CODE) {
    state.PIN_CODE = generatePin();
  }

  // Load Paired Devices from JSON
  if (state.PAIRED_DEVICES_FILE) {
    try {
      if (fs.existsSync(state.PAIRED_DEVICES_FILE)) {
        const raw = fs.readFileSync(state.PAIRED_DEVICES_FILE, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          state.pairedDevices.clear();
          list.forEach(dev => {
            if (dev.token) {
              state.pairedDevices.set(dev.token, dev);
            }
          });
        }
      }
    } catch (err) {
      console.error('[AUTH] Failed to load paired devices:', err.message);
    }
  }
}

/**
 * Persist paired devices to disk.
 */
function savePairedDevices() {
  if (!state.PAIRED_DEVICES_FILE) return;
  try {
    const list = Array.from(state.pairedDevices.values());
    fs.writeFileSync(state.PAIRED_DEVICES_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error('[AUTH] Failed to save paired devices:', err.message);
  }
}

/**
 * Pair a new device and persist to disk.
 * @param {string} deviceName - Human-readable device name
 * @param {string} ip - IP address of the device
 * @returns {{ token: string, deviceName: string, ip: string, pairedAt: string }}
 */
function pairDevice(deviceName, ip) {
  const token = crypto.randomBytes(24).toString('hex');
  const deviceObj = {
    token,
    deviceName: deviceName || 'Mobile Device',
    ip: ip || 'Unknown IP',
    pairedAt: new Date().toISOString()
  };
  state.pairedDevices.set(token, deviceObj);
  savePairedDevices();
  return deviceObj;
}

/**
 * Unpair a device by token. Revokes active WS/SSE connections.
 * @param {string} token - Device token to unpair
 * @returns {boolean} True if device was found and removed
 */
function unpairDevice(token) {
  if (state.pairedDevices.has(token)) {
    state.pairedDevices.delete(token);
    savePairedDevices();

    // Revoke open WebSocket connections matching this token
    if (state.wss) {
      for (const client of state.wss.clients) {
        if (client.deviceToken === token) {
          try {
            client.send(JSON.stringify({ type: 'revoked' }));
            setTimeout(() => { client.terminate(); }, 100);
          } catch (e) {}
        }
      }
    }

    // Revoke open SSE connections matching this token
    if (state.sseClients) {
      for (const client of state.sseClients) {
        if (client.deviceToken === token) {
          try {
            client.write(`event: revoked\ndata: ${JSON.stringify({ error: 'Device revoked' })}\n\n`);
            setTimeout(() => { client.end(); }, 100);
          } catch (e) {}
          state.sseClients.delete(client);
        }
      }
    }
    return true;
  }
  return false;
}

function clearAllPairedDevices() {
  state.pairedDevices.clear();
  savePairedDevices();

  // Revoke all open remote WebSocket connections
  if (state.wss) {
    for (const client of state.wss.clients) {
      if (client.deviceToken && client.deviceToken !== 'localhost') {
        try {
          client.send(JSON.stringify({ type: 'revoked' }));
          setTimeout(() => { client.terminate(); }, 100);
        } catch (e) {}
      }
    }
  }

  // Revoke all open remote SSE connections
  if (state.sseClients) {
    for (const client of state.sseClients) {
      if (client.deviceToken && client.deviceToken !== 'localhost') {
        try {
          client.write(`event: revoked\ndata: ${JSON.stringify({ error: 'Device revoked' })}\n\n`);
          setTimeout(() => { client.end(); }, 100);
        } catch (e) {}
        state.sseClients.delete(client);
      }
    }
  }
}

function extractToken(req) {
  // 1. Check HTTP-only cookie
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const c of cookies) {
      const [name, val] = c.trim().split('=');
      if (name === 'airodrop_session' && val) {
        return val;
      }
    }
  }
  // 2. Check Authorization Header
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  // 3. Check Query parameter
  if (req.query) {
    if (req.query.device_token) return req.query.device_token;
    if (req.query.token) return req.query.token;
  }
  return null;
}

/**
 * Express middleware that enforces authentication on non-exempt routes.
 * Exempts localhost, static assets, and auth endpoints.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function authMiddleware(req, res, next) {
  // Always exempt localhost / loopback connections from authentication
  const remoteIp = (req.ip || req.connection.remoteAddress || '').replace(/^.*:/, '');
  const isLoopback = remoteIp === '127.0.0.1' || remoteIp === 'localhost' || remoteIp === '1' || req.isLocalhost;
  if (isLoopback) {
    return next();
  }

  // Mode = open: disable authentication checks
  if (state.SECURITY_MODE === 'open') {
    return next();
  }

  // Exempt internal static assets & P2P share tunnel routes
  const p = req.path;
  if (
    p.startsWith('/u/') || 
    p.startsWith('/d/') ||
    p.startsWith('/api/auth/') ||
    p === '/favicon.ico' ||
    p === '/logo.png' ||
    p === '/logo.ico' ||
    p === '/logo.svg' ||
    p === '/logo-192.png' ||
    p === '/style.css' ||
    p === '/auth-pin' ||
    p === '/auth-pin.html'
  ) {
    return next();
  }

  // Shortcut Secret Check (Header or Query parameter)
  const secretHeader = req.headers['x-airodrop-token'];
  const secretQuery = req.query ? (req.query.shortcut_secret || req.query.token) : null;
  if (state.SHORTCUT_SECRET && (secretHeader === state.SHORTCUT_SECRET || secretQuery === state.SHORTCUT_SECRET)) {
    return next();
  }

  // Paired Device Token Verification
  const deviceToken = extractToken(req);
  if (deviceToken && state.pairedDevices.has(deviceToken)) {
    return next();
  }

  // Request is unauthenticated
  const acceptsJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));

  // For /files page navigation (HTML), redirect to auth-pin  
  if (p === '/files' || p === '/files/') {
    return res.redirect('/auth-pin');
  }

  if (acceptsJson || p.startsWith('/api/') || p.startsWith('/files/')) {
    return res.status(401).json({
      error: 'Authentication required',
      authRequired: true,
      mode: state.SECURITY_MODE
    });
  }

  // For full page HTML requests, serve the lock screen
  return res.redirect('/auth-pin');
}

module.exports = {
  generatePin,
  initAuth,
  savePairedDevices,
  pairDevice,
  unpairDevice,
  clearAllPairedDevices,
  authMiddleware,
  extractToken,
  checkPinRateLimit,
  recordFailedPinAttempt,
  clearPinAttempts
};
