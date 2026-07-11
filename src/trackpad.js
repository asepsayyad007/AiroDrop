const WebSocket = require('ws');
const os = require('os');
const koffi = require('koffi');
const state = require('./state');
const utils = require('./utils');

// ─── Win32 FFI Initialization for Trackpad ──────────────────
let user32 = null;
let POINT = null;
let GetCursorPos = null;
let SetCursorPos = null;
let mouse_event = null;
let keybd_event = null;
let GetSystemMetrics = null;

if (os.platform() === 'win32') {
  try {
    user32 = koffi.load('user32.dll');
    POINT = koffi.struct('POINT', {
      x: 'long',
      y: 'long'
    });
    GetCursorPos = user32.func('int GetCursorPos(POINT* lpPoint)');
    SetCursorPos = user32.func('int SetCursorPos(int X, int Y)');
    mouse_event = user32.func('void mouse_event(uint dwFlags, int dx, int dy, uint dwData, uintptr_t dwExtraInfo)');
    keybd_event = user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint dwFlags, uintptr_t dwExtraInfo)');
    GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)');
  } catch (err) {
    console.error('Failed to load user32.dll:', err);
  }
}

function getVKCode(char) {
  const c = char.toUpperCase();
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0);
  if (c >= '0' && c <= '9') return c.charCodeAt(0);
  if (c === ' ') return 0x20;
  
  const map = {
    '\n': 0x0D, '\r': 0x0D, '\t': 0x09,
    ';': 0xBA, '=': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF, '`': 0xC0,
    '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE
  };
  return map[char] || null;
}

function sendKeystroke(charOrCode) {
  if (!keybd_event) return;
  if (typeof charOrCode === 'number') {
    keybd_event(charOrCode, 0, 0, 0);
    keybd_event(charOrCode, 0, 0x0002, 0);
  } else if (typeof charOrCode === 'string') {
    if (charOrCode.length === 1) {
      const code = getVKCode(charOrCode);
      if (code) {
        const needsShift = charOrCode.match(/[A-Z!@#$%^&*()_+{}|:"<>?]/);
        if (needsShift) {
          keybd_event(0x10, 0, 0, 0);
        }
        keybd_event(code, 0, 0, 0);
        keybd_event(code, 0, 0x0002, 0);
        if (needsShift) {
          keybd_event(0x10, 0, 0x0002, 0);
        }
      }
    } else {
      const { exec } = require('child_process');
      const escaped = charOrCode.replace(/'/g, "''").replace(/([{}()+^%~[\]])/g, '{$1}');
      exec(`powershell -NoProfile -Command "[System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`);
    }
  }
}

function setupWebSocket(serverInstance, serverEvents) {
  state.wss = new WebSocket.Server({ noServer: true });
  
  // ─── Keepalive: ping every 15s, terminate unresponsive clients ───
  const WS_PING_INTERVAL = 15000;
  if (!state._wsPingTimer) {
    state._wsPingTimer = setInterval(() => {
      if (!state.wss) return;
      for (const ws of state.wss.clients) {
        if (ws._isAlive === false) {
          ws.terminate();
          continue;
        }
        ws._isAlive = false;
        ws.ping();
      }
    }, WS_PING_INTERVAL);
  }

  serverInstance.on('upgrade', (request, socket, head) => {
    try {
      const pathname = request.url.split('?')[0];
      if (pathname === '/trackpad') {
        const urlParams = new URLSearchParams(request.url.split('?')[1] || '');
        const token = urlParams.get('token');
        
        state.wss.handleUpgrade(request, socket, head, (ws) => {
          ws.deviceToken = token || 'localhost';
          state.wss.emit('connection', ws, request);
        });
      }
    } catch (err) {
      console.error('[WS-UPGRADE] Upgrade failed:', err.message);
    }
  });

  state.wss.on('connection', (ws) => {
    console.log('[TRACKPAD] Phone connected via WebSocket');
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });
    serverEvents.emit('phone_connected', ws);
    let accumX = 0;
    let accumY = 0;
    
    ws.on('message', (message) => {
      try {
        let messageStr;
        if (typeof message === 'string') {
          messageStr = message;
        } else {
          messageStr = Buffer.from(message).toString('utf8');
        }
        const data = JSON.parse(messageStr);
        
        switch (data.type) {
          case 'move':
            try {
              accumX += data.dx;
              accumY += data.dy;
              const moveX = Math.trunc(accumX);
              const moveY = Math.trunc(accumY);
              if (moveX !== 0 || moveY !== 0) {
                accumX -= moveX;
                accumY -= moveY;
                if (mouse_event) {
                  mouse_event(0x0001, moveX, moveY, 0, 0);
                }
              }
            } catch (moveErr) {
              const moveX = Math.round(data.dx);
              const moveY = Math.round(data.dy);
              if (mouse_event) {
                mouse_event(0x0001, moveX, moveY, 0, 0);
              }
            }
            break;
          case 'click':
            if (mouse_event) {
              const button = data.button || 'left';
              const downFlag = button === 'left' ? 0x0002 : 0x0008; // LEFTDOWN : RIGHTDOWN
              const upFlag = button === 'left' ? 0x0004 : 0x0010;   // LEFTUP : RIGHTUP
              mouse_event(downFlag, 0, 0, 0, 0);
              mouse_event(upFlag, 0, 0, 0, 0);
            }
            break;
          case 'scroll':
            if (mouse_event) {
              const amount = Math.round(data.amount);
              mouse_event(0x0800, 0, 0, amount, 0); // MOUSEEVENTF_WHEEL
            }
            break;
          case 'keyboard':
            try {
              const key = data.key;
              const type = data.action || 'press';
              if (type === 'press') {
                if (key.length === 1) {
                  // Text typing
                  const ks = require('node-key-sender');
                  ks.sendText(key);
                } else {
                  // Special key
                  const ks = require('node-key-sender');
                  ks.sendKey(key.toLowerCase());
                }
              }
            } catch (keyErr) {
              console.error('[TRACKPAD] Key event processing failed:', keyErr.message);
            }
            break;
          case 'identify':
            if (data.deviceName) {
              console.log(`[TRACKPAD] Device identified: ${data.deviceName}`);
              utils.broadcastSSE('trackpad_status', { connected: true, deviceName: data.deviceName });
            }
            break;
          case 'type':
            sendKeystroke(data.text);
            break;
          case 'key':
            sendKeystroke(data.code);
            break;
          case 'move_abs':
            if (SetCursorPos && GetSystemMetrics) {
              const screenW = GetSystemMetrics(0); // SM_CXSCREEN
              const screenH = GetSystemMetrics(1); // SM_CYSCREEN
              const absX = Math.round((data.xRatio || 0) * screenW);
              const absY = Math.round((data.yRatio || 0) * screenH);
              SetCursorPos(absX, absY);
            }
            break;
          case 'click_abs':
            if (SetCursorPos && mouse_event && GetSystemMetrics) {
              const screenW = GetSystemMetrics(0); // SM_CXSCREEN
              const screenH = GetSystemMetrics(1); // SM_CYSCREEN
              const absX = Math.round((data.xRatio || 0) * screenW);
              const absY = Math.round((data.yRatio || 0) * screenH);
              SetCursorPos(absX, absY);
              if (data.button === 'right') {
                mouse_event(0x0008, 0, 0, 0, 0); // MOUSEEVENTF_RIGHTDOWN
                mouse_event(0x0010, 0, 0, 0, 0); // MOUSEEVENTF_RIGHTUP
              } else {
                mouse_event(0x0002, 0, 0, 0, 0); // MOUSEEVENTF_LEFTDOWN
                mouse_event(0x0004, 0, 0, 0, 0); // MOUSEEVENTF_LEFTUP
              }
            }
            break;
          case 'screencast_start':
            if (state.screencastStopTimeout) {
              clearTimeout(state.screencastStopTimeout);
              state.screencastStopTimeout = null;
              console.log('[TRACKPAD] screencastStopTimeout cleared on reconnection');
            }
            serverEvents.emit('screencast_start', ws);
            break;
          case 'screencast_stop':
            serverEvents.emit('screencast_stop', ws);
            break;
          case 'webrtc_answer':
            serverEvents.emit('webrtc_answer', ws, data.answer);
            break;
          case 'webrtc_ice_candidate':
            serverEvents.emit('webrtc_ice_candidate', ws, data.candidate);
            break;
          case 'mic_offer':
            serverEvents.emit('mic_offer', ws, data.offer);
            break;
          case 'mic_ice_candidate':
            serverEvents.emit('mic_ice_candidate', ws, data.candidate);
            break;
          case 'mic_stop':
            serverEvents.emit('mic_stop', ws);
            break;
          case 'ping_pc':
            utils.broadcastSSE('ping-pc', { device: ws.deviceToken || 'mobile' });
            serverEvents.emit('ping_pc', ws);
            break;
        }
      } catch (err) {
        console.error('[TRACKPAD] WS Message parsing failed:', err.message);
      }
    });
    
    ws.on('close', () => {
      console.log('[TRACKPAD] Phone disconnected');
      serverEvents.emit('phone_disconnected', ws);
      if (state.screencastStopTimeout) clearTimeout(state.screencastStopTimeout);
      state.screencastStopTimeout = setTimeout(() => {
        console.log('[TRACKPAD] screencastStopTimeout triggered; stopping screencast');
        serverEvents.emit('screencast_stop', ws);
      }, 30000);
      utils.broadcastSSE('trackpad_status', { connected: false });
    });
  });
}

module.exports = { setupWebSocket };
