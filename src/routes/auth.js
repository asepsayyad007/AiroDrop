const express = require('express');
const router = express.Router();
const state = require('../state');
const auth = require('../auth');
const utils = require('../utils');
const { getLogger } = require('../logger');

const logger = getLogger();

/**
 * Helper: Build secure cookie options based on current server config.
 * Note: httpOnly is false because mobile-app.js reads the cookie via document.cookie
 * to use as a Bearer token in API requests. This is by design for local-network operation.
 */
function getSecureCookieOptions() {
  return {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: false,
    sameSite: 'lax',
    secure: state.HTTPS_ENABLED,
    path: '/'
  };
}

// Check authentication status
router.get('/status', (req, res) => {
  const isPaired = !!(req.headers.cookie && req.headers.cookie.includes('airodrop_session'));
  res.json({
    mode: state.SECURITY_MODE,
    pin: state.PIN_CODE,
    shortcutSecretConfigured: !!state.SHORTCUT_SECRET,
    isPaired,
    pairedCount: state.pairedDevices.size
  });
});

// Verify 4-digit PIN code submitted from phone
router.post('/verify-pin', (req, res) => {
  const { pin, deviceName } = req.body || {};
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

  // Check brute-force lockout
  const rateCheck = auth.checkPinRateLimit(clientIp);
  if (rateCheck.locked) {
    res.set('Retry-After', String(rateCheck.retryAfter));
    return res.status(429).json({
      success: false,
      error: 'Too many failed attempts. Please try again later.',
      retryAfter: rateCheck.retryAfter
    });
  }

  if (!pin) {
    return res.status(400).json({ error: 'PIN code is required' });
  }

  if (String(pin).trim() !== String(state.PIN_CODE).trim()) {
    // Record failed attempt and check if lockout should trigger
    const result = auth.recordFailedPinAttempt(clientIp);
    utils.writeLog(`[SECURITY] Failed PIN verification attempt from IP ${clientIp}`);

    if (result.locked) {
      res.set('Retry-After', String(result.retryAfter));
      return res.status(429).json({
        success: false,
        error: 'Too many failed attempts. Account locked temporarily.',
        retryAfter: result.retryAfter
      });
    }

    return res.status(401).json({ success: false, error: 'Invalid PIN code' });
  }

  // Successful verification — clear failed attempts and pair device
  auth.clearPinAttempts(clientIp);
  const device = auth.pairDevice(deviceName || 'Mobile Device', clientIp);

  // Set secure session cookie
  res.cookie('airodrop_session', device.token, getSecureCookieOptions());

  utils.writeLog(`Device successfully paired via PIN: ${device.deviceName} (${clientIp})`);
  utils.broadcastSSE('device-change', { count: state.pairedDevices.size });

  res.json({
    success: true,
    deviceToken: device.token,
    deviceName: device.deviceName
  });
});

// Request direct approval popup on PC host
router.post('/request-approval', (req, res) => {
  const { deviceName } = req.body || {};
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

  // Also rate-limit approval requests to prevent spam
  const rateCheck = auth.checkPinRateLimit(clientIp);
  if (rateCheck.locked) {
    res.set('Retry-After', String(rateCheck.retryAfter));
    return res.status(429).json({
      success: false,
      error: 'Too many requests. Please try again later.',
      retryAfter: rateCheck.retryAfter
    });
  }

  const serverEvents = require('../../server').serverEvents;

  if (serverEvents) {
    let handled = false;
    
    // Set a 30-second timeout for the host response
    const timeout = setTimeout(() => {
      if (!handled) {
        handled = true;
        res.status(504).json({ success: false, error: 'Approval request timed out on PC host' });
      }
    }, 30000);

    serverEvents.emit('request-host-approval', {
      deviceName: deviceName || 'Unknown Device',
      ip: clientIp,
      respond: (approved) => {
        if (handled) return;
        handled = true;
        clearTimeout(timeout);

        if (approved) {
          auth.clearPinAttempts(clientIp);
          const device = auth.pairDevice(deviceName || 'Mobile Device', clientIp);
          res.cookie('airodrop_session', device.token, getSecureCookieOptions());
          utils.writeLog(`Device paired via Host Approval: ${device.deviceName} (${clientIp})`);
          utils.broadcastSSE('device-change', { count: state.pairedDevices.size });
          res.json({ success: true, approved: true, deviceToken: device.token });
        } else {
          auth.recordFailedPinAttempt(clientIp);
          utils.writeLog(`Host denied pairing request from: ${deviceName} (${clientIp})`);
          res.status(403).json({ success: false, approved: false, error: 'Host denied connection request' });
        }
      }
    });
  } else {
    res.status(500).json({ error: 'Server event dispatcher unavailable' });
  }
});

// Regenerate 4-digit PIN code (PC Settings action)
router.post('/regenerate-pin', (req, res) => {
  state.PIN_CODE = auth.generatePin();

  // Persist to config.json
  const fs = require('fs');
  try {
    if (state.CONFIG_FILE) {
      let data = {};
      if (fs.existsSync(state.CONFIG_FILE)) {
        data = JSON.parse(fs.readFileSync(state.CONFIG_FILE, 'utf8'));
      }
      data.pinCode = state.PIN_CODE;
      fs.writeFileSync(state.CONFIG_FILE, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    logger.warn('Failed to persist PIN to config', { error: err.message });
  }

  utils.writeLog(`Regenerated local PIN code: ${state.PIN_CODE}`);
  res.json({ success: true, pin: state.PIN_CODE });
});

// Get list of paired devices (PC Settings)
router.get('/paired-devices', (req, res) => {
  const devices = Array.from(state.pairedDevices.values()).map(d => ({
    token: d.token,
    deviceName: d.deviceName,
    ip: d.ip,
    pairedAt: d.pairedAt
  }));
  res.json({ devices });
});

// Unpair specific device (PC Settings)
router.post('/unpair', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Device token required' });
  
  const ok = auth.unpairDevice(token);
  if (ok) {
    utils.writeLog(`Unpaired device token: ${token.slice(0, 8)}...`);
    utils.broadcastSSE('device-change', { count: state.pairedDevices.size });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

// Revoke all paired devices (PC Settings)
router.post('/unpair-all', (req, res) => {
  auth.clearAllPairedDevices();
  utils.writeLog('Revoked all paired devices');
  utils.broadcastSSE('device-change', { count: state.pairedDevices.size });
  res.json({ success: true });
});

module.exports = router;
