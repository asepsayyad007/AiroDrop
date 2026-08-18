const WebSocket = require('ws');
const state = require('./state');
const utils = require('./utils');
const logger = require('./logger');

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;

function startBeacon() {
  stopBeacon();
  
  const relayWsUrl = process.env.AIRODROP_RELAY_WS || 'wss://airodrop.site/ws';
  
  try {
    ws = new WebSocket(relayWsUrl, {
      handshakeTimeout: 5000
    });

    ws.on('open', () => {
      utils.writeLog('Connected to AiroDrop cloud radar beacon service');
      announcePresence();

      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          announcePresence();
        }
      }, 20000);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {}
    });

    ws.on('error', (err) => {
      // Silently handle offline network conditions
    });

    ws.on('close', () => {
      cleanup();
      reconnectTimer = setTimeout(startBeacon, 8000);
    });
  } catch (err) {
    cleanup();
    reconnectTimer = setTimeout(startBeacon, 8000);
  }
}

function announcePresence() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const ip = state.LOCAL_IP || utils.getLocalIP();
  const port = state.PORT || 3478;
  const devName = state.DEVICE_NAME || require('os').hostname() || 'AiroDrop PC';
  const pin = state.AUTH_PIN || '';

  const payload = {
    type: 'announce-host',
    host: `${ip}:${port}`,
    name: devName,
    platform: process.platform,
    pin: pin,
    https: !!state.HTTPS_ENABLED
  };

  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {}
}

function cleanup() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function stopBeacon() {
  cleanup();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }
}

module.exports = {
  startBeacon,
  announcePresence,
  stopBeacon
};
