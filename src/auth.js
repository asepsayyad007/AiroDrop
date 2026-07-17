const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const state = require('./state');

function generatePin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

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

function savePairedDevices() {
  if (!state.PAIRED_DEVICES_FILE) return;
  try {
    const list = Array.from(state.pairedDevices.values());
    fs.writeFileSync(state.PAIRED_DEVICES_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error('[AUTH] Failed to save paired devices:', err.message);
  }
}

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
  if (req.query && req.query.device_token) {
    return req.query.device_token;
  }
  return null;
}

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
    p === '/auth-pin'
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
  authMiddleware
};
