/**
 * AiroDrop — Real-Time Local IP Monitor & Persistence
 * 
 * Periodically monitors active network interfaces to detect DHCP IP changes
 * or network switching. Persists last known IP to disk across app restarts,
 * updates the cloud radar beacon, and broadcasts warning alerts to the PC
 * Dashboard and paired clients.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const utils = require('./utils');
const state = require('./state');
const logger = require('./logger');

let lastKnownIp = null;
let monitorInterval = null;
let onIpChangeCallback = null;

function getIpFilePath() {
  if (state.LAST_KNOWN_IP_FILE) return state.LAST_KNOWN_IP_FILE;
  if (state.CONFIG_FILE) return path.join(path.dirname(state.CONFIG_FILE), 'last_known_ip.json');
  return path.join(os.homedir(), '.airodrop_last_ip.json');
}

function getSavedIp() {
  try {
    const filePath = getIpFilePath();
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && raw.ip && typeof raw.ip === 'string') {
        return raw.ip.trim();
      }
    }
  } catch (err) {
    console.error('[IP-MONITOR] Failed to read saved IP:', err.message);
  }
  return null;
}

function saveIpToDisk(ip) {
  if (!ip || ip === '127.0.0.1') return;
  try {
    const filePath = getIpFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ ip, timestamp: new Date().toISOString() }, null, 2), 'utf8');
  } catch (err) {
    console.error('[IP-MONITOR] Failed to save IP to disk:', err.message);
  }
}

function startIpMonitor(onChanged) {
  stopIpMonitor();
  onIpChangeCallback = onChanged;

  const activeIp = utils.getLocalIP();
  const savedIp = getSavedIp();

  // Check if IP changed while AiroDrop was closed or system rebooted
  if (savedIp && savedIp !== activeIp && savedIp !== '127.0.0.1' && activeIp !== '127.0.0.1') {
    const previous = savedIp;
    lastKnownIp = activeIp;
    state.LOCAL_IP = activeIp;
    saveIpToDisk(activeIp);

    const payload = {
      oldIP: previous,
      newIP: activeIp,
      pinCode: state.PIN_CODE || state.AUTH_PIN || '1405',
      qrUrl: 'https://airodrop.site/install',
      timestamp: new Date().toISOString()
    };
    state.PENDING_IP_CHANGE = payload;

    utils.writeLog(`[NETWORK] Startup IP change detected: ${previous} -> ${activeIp}`);
    console.log(`[NETWORK] Startup IP change detected: ${previous} -> ${activeIp}`);

    // Fire callback & SSE with short delay so webContents and SSE stream can attach
    setTimeout(() => {
      utils.broadcastSSE('network-ip-changed', payload);
      try {
        const radarBeacon = require('./radarBeacon');
        radarBeacon.announcePresence();
      } catch (_) {}

      if (typeof onIpChangeCallback === 'function') {
        onIpChangeCallback(payload);
      }
    }, 1200);
  } else {
    lastKnownIp = activeIp;
    saveIpToDisk(activeIp);
  }

  // Poll every 3 seconds for active runtime changes
  monitorInterval = setInterval(() => {
    try {
      const currentIp = utils.getLocalIP();
      if (!currentIp || currentIp === '127.0.0.1') return;

      if (lastKnownIp && currentIp !== lastKnownIp) {
        const previous = lastKnownIp;
        lastKnownIp = currentIp;
        state.LOCAL_IP = currentIp;
        saveIpToDisk(currentIp);

        utils.writeLog(`[NETWORK] Wi-Fi IP change detected: ${previous} -> ${currentIp}`);
        console.log(`[NETWORK] Wi-Fi IP changed from ${previous} to ${currentIp}`);

        const payload = {
          oldIP: previous,
          newIP: currentIp,
          pinCode: state.PIN_CODE || state.AUTH_PIN || '1405',
          qrUrl: 'https://airodrop.site/install',
          timestamp: new Date().toISOString()
        };
        state.PENDING_IP_CHANGE = payload;

        // Broadcast to PC Dashboard via SSE
        utils.broadcastSSE('network-ip-changed', payload);

        // Announce new IP to cloud radar beacon immediately
        try {
          const radarBeacon = require('./radarBeacon');
          radarBeacon.announcePresence();
        } catch (_) {}

        if (typeof onIpChangeCallback === 'function') {
          onIpChangeCallback(payload);
        }
      }
    } catch (err) {
      console.error('[IP-MONITOR] Error monitoring network IP:', err);
    }
  }, 3000);
}

function stopIpMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

function triggerSimulatedChange(fakeNewIp) {
  const old = lastKnownIp || utils.getLocalIP();
  const simulated = fakeNewIp || '192.168.1.99';
  const payload = {
    oldIP: old,
    newIP: simulated,
    pinCode: state.PIN_CODE || state.AUTH_PIN || '1405',
    qrUrl: 'https://airodrop.site/install',
    timestamp: new Date().toISOString()
  };

  state.PENDING_IP_CHANGE = payload;
  utils.broadcastSSE('network-ip-changed', payload);
  if (typeof onIpChangeCallback === 'function') {
    onIpChangeCallback(payload);
  }
  return payload;
}

function getCurrentIP() {
  return lastKnownIp || utils.getLocalIP();
}

module.exports = {
  startIpMonitor,
  stopIpMonitor,
  triggerSimulatedChange,
  getCurrentIP,
  getSavedIp,
  saveIpToDisk
};
