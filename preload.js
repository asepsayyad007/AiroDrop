const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_SEND_CHANNELS = [
  'get-port-sync',
  'get-protocol-sync',
  'restore-window',
  'open-file-folder',
  'open-save-directory',
  'get-dir',
  'change-dir',
  'start-server',
  'restart-server',
  'stop-server',
  'force-kill-all',
  'manual-check-update',
  'send-webrtc-candidate',
  'send-webrtc-offer',
  'send-mic-candidate',
  'send-mic-answer',
  'receive-file-start',
  'receive-file-chunk',
  'receive-file-end',
  'receive-file-error'
];

const ALLOWED_INVOKE_CHANNELS = [
  'get-screen-source'
];

const ALLOWED_ON_CHANNELS = [
  'server-status',
  'dir-updated',
  'receive-file-completed',
  'update-status',
  'update-download-progress',
  'screencast-start',
  'webrtc-answer',
  'webrtc-ice-candidate',
  'screencast-stop',
  'mic-offer',
  'mic-ice-candidate',
  'mic-stop'
];

contextBridge.exposeInMainWorld('electronAPI', {
  sendSync: (channel, ...args) => {
    if (ALLOWED_SEND_CHANNELS.includes(channel)) {
      return ipcRenderer.sendSync(channel, ...args);
    }
    console.warn(`[SECURITY] Blocked unauthorized sendSync channel: ${channel}`);
  },
  send: (channel, ...args) => {
    if (ALLOWED_SEND_CHANNELS.includes(channel)) {
      ipcRenderer.send(channel, ...args);
    } else {
      console.warn(`[SECURITY] Blocked unauthorized send channel: ${channel}`);
    }
  },
  invoke: (channel, ...args) => {
    if (ALLOWED_INVOKE_CHANNELS.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    console.warn(`[SECURITY] Blocked unauthorized invoke channel: ${channel}`);
    return Promise.reject(new Error(`Unauthorized IPC invoke channel: ${channel}`));
  },
  on: (channel, callback) => {
    if (ALLOWED_ON_CHANNELS.includes(channel)) {
      const subscription = (event, ...args) => callback(event, ...args);
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    }
    console.warn(`[SECURITY] Blocked unauthorized on listener channel: ${channel}`);
  }
});
