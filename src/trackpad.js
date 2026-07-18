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
      for (let i = 0; i < charOrCode.length; i++) {
        sendKeystroke(charOrCode[i]);
      }
    }
  }
}

function setupWebSocket(serverInstance, serverEvents) {
  // Only instantiate the WebSocket.Server once
  if (!state.wss) {
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

    state.wss.on('connection', (ws) => {
      console.log('[TRACKPAD] Phone connected via WebSocket');
      if (state.screencastStopTimeout) {
        clearTimeout(state.screencastStopTimeout);
        state.screencastStopTimeout = null;
      }
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
            case 'move_abs':
              if (SetCursorPos && GetSystemMetrics) {
                const screenWidth = GetSystemMetrics(0);
                const screenHeight = GetSystemMetrics(1);
                const targetX = Math.round(data.xRatio * screenWidth);
                const targetY = Math.round(data.yRatio * screenHeight);
                SetCursorPos(targetX, targetY);
              }
              break;
            case 'click_abs':
              if (SetCursorPos && GetSystemMetrics && mouse_event) {
                const screenWidth = GetSystemMetrics(0);
                const screenHeight = GetSystemMetrics(1);
                const targetX = Math.round(data.xRatio * screenWidth);
                const targetY = Math.round(data.yRatio * screenHeight);
                SetCursorPos(targetX, targetY);
                
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
                const isSpecial = data.isSpecial;
                const activeModifiers = data.modifiers || [];
                
                // key mapping ...
                if (isSpecial) {
                  const keyMap = {
                    'backspace': 0x08, 'tab': 0x09, 'enter': 0x0D, 'escape': 0x1B, 'space': 0x20,
                    'arrowup': 0x26, 'arrowdown': 0x28, 'arrowleft': 0x25, 'arrowright': 0x27, 'delete': 0x2E
                  };
                  const vk = keyMap[key.toLowerCase()];
                  if (vk) {
                    keybd_event(vk, 0, 0, 0);
                    keybd_event(vk, 0, 2, 0);
                  }
                } else if (key) {
                  // Standard character typing
                  const vkMap = {
                    'a':0x41,'b':0x42,'c':0x43,'d':0x44,'e':0x45,'f':0x46,'g':0x47,'h':0x48,'i':0x49,'j':0x4A,
                    'k':0x4B,'l':0x4C,'m':0x4D,'n':0x4E,'o':0x4F,'p':0x50,'q':0x51,'r':0x52,'s':0x53,'t':0x54,
                    'u':0x55,'v':0x56,'w':0x57,'x':0x58,'y':0x59,'z':0x5A,'0':0x30,'1':0x31,'2':0x32,'3':0x33,
                    '4':0x34,'5':0x35,'6':0x36,'7':0x37,'8':0x38,'9':0x39
                  };
                  const lower = key.toLowerCase();
                  if (vkMap[lower]) {
                    const vk = vkMap[lower];
                    const needsShift = key !== lower;
                    if (needsShift) keybd_event(0x10, 0, 0, 0);
                    keybd_event(vk, 0, 0, 0);
                    keybd_event(vk, 0, 2, 0);
                    if (needsShift) keybd_event(0x10, 0, 2, 0);
                  }
                }
              } catch (e) {}
              break;
            case 'identify':
              ws.deviceName = data.deviceName || 'Mobile Device';
              console.log('[TRACKPAD] Device identified:', ws.deviceName);
              utils.broadcastSSE('trackpad_status', { connected: true, deviceName: data.deviceName });
              break;
            case 'screencast_start':
              if (state.screencastStopTimeout) {
                clearTimeout(state.screencastStopTimeout);
                state.screencastStopTimeout = null;
              }
              serverEvents.emit('screencast_start', ws, data.audioOnly);
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

  // Register the upgrade listener for this serverInstance
  serverInstance.on('upgrade', (request, socket, head) => {
    try {
      let pathname = request.url.split('?')[0];
      // Normalize pathname (ignore trailing slashes)
      if (pathname.endsWith('/') && pathname.length > 1) {
        pathname = pathname.slice(0, -1);
      }
      
      if (pathname === '/trackpad') {
        const urlParams = new URLSearchParams(request.url.split('?')[1] || '');
        const token = urlParams.get('token') || urlParams.get('device_token');
        
        console.log('[WS-UPGRADE] Upgrading /trackpad connection. Security Mode:', state.SECURITY_MODE, 'Token:', token);
        console.log('[WS-UPGRADE] Currently paired device tokens:', Array.from(state.pairedDevices.keys()));

        // Reject WebSocket upgrade if security mode is not open and token is invalid/unpaired
        if (state.SECURITY_MODE !== 'open' && token !== 'localhost') {
          if (!token || !state.pairedDevices.has(token)) {
            console.warn('[WS-UPGRADE] Rejecting WebSocket connection. Token not paired or invalid:', token);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }
        
        state.wss.handleUpgrade(request, socket, head, (ws) => {
          ws.deviceToken = token || 'localhost';
          state.wss.emit('connection', ws, request);
        });
      }
    } catch (err) {
      console.error('[WS-UPGRADE] Upgrade failed:', err.message);
      try {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      } catch (e) {}
    }
  });
}

module.exports = { setupWebSocket };
