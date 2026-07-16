const express = require('express');
const router = express.Router();
const state = require('../state');
const auth = require('../auth');
const utils = require('../utils');

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
  if (!pin) {
    return res.status(400).json({ error: 'PIN code is required' });
  }

  if (String(pin).trim() !== String(state.PIN_CODE).trim()) {
    utils.writeLog(`Failed PIN verification attempt from IP ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Invalid 4-digit PIN code' });
  }

  const device = auth.pairDevice(deviceName || 'Mobile Device', req.ip);
  
  // Set 1-year persistent session cookie
  res.cookie('airodrop_session', device.token, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: false,
    sameSite: 'lax'
  });

  utils.writeLog(`Device successfully paired via PIN: ${device.deviceName} (${req.ip})`);
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
      ip: req.ip,
      respond: (approved) => {
        if (handled) return;
        handled = true;
        clearTimeout(timeout);

        if (approved) {
          const device = auth.pairDevice(deviceName || 'Mobile Device', req.ip);
          res.cookie('airodrop_session', device.token, {
            maxAge: 365 * 24 * 60 * 60 * 1000,
            httpOnly: false,
            sameSite: 'lax'
          });
          utils.writeLog(`Device paired via Host Approval: ${device.deviceName} (${req.ip})`);
          utils.broadcastSSE('device-change', { count: state.pairedDevices.size });
          res.json({ success: true, approved: true, deviceToken: device.token });
        } else {
          utils.writeLog(`Host denied pairing request from: ${deviceName} (${req.ip})`);
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
    console.error('[AUTH] Failed to persist PIN to config:', err.message);
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
