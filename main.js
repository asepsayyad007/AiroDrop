const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, desktopCapturer } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const os = require('os');
const server = require('./server'); // Our refactored server.js

let mainWindow = null;
let tray = null;
let isQuitting = false;
let serverRunning = false;
let serverPort = null;

// ─── Single Instance Lock ─────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ─── Main Initialization ──────────────────────────────────────
app.whenReady().then(() => {
  app.setAppUserModelId('com.asep-ios-integration.airodrop');
  
  // Initialize server with userData path for persistent data
  const userDataPath = app.getPath('userData');
  server.init(userDataPath);

  // Start the server FIRST so it's ready when window loads
  server.startServer((port, err) => {
    serverRunning = !err;
    serverPort = port || server.getPort();
    updateTrayMenu(serverRunning);
    // If window is already loaded, send status immediately
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('server-status', { 
        running: serverRunning, 
        port: serverPort,
        ip: server.getLocalIP(),
        error: err ? err.message : null 
      });
    }
  });

  createWindow();
  createTray();
  setupAutoUpdater();
});

let isManualCheck = false;

function checkUpdatesManually() {
  isManualCheck = true;
  if (mainWindow) {
    mainWindow.webContents.send('update-status', 'checking');
  }

  // Handle unpackaged dev environment checks to show direct feedback
  if (!app.isPackaged) {
    isManualCheck = false;
    dialog.showMessageBox(mainWindow || null, {
      type: 'info',
      title: 'AiroDrop Update Check',
      message: 'Update checks are only active in compiled production builds.\n(Running in Developer Mode)'
    });
    if (mainWindow) {
      mainWindow.webContents.send('update-status', 'not-available');
    }
    return;
  }

  autoUpdater.checkForUpdates().catch((err) => {
    if (isManualCheck) {
      isManualCheck = false;
      dialog.showErrorBox('Update Check Failed', `Failed to check for updates: ${err.message}`);
      if (mainWindow) {
        mainWindow.webContents.send('update-status', 'error', err.message);
      }
    }
  });
}

ipcMain.on('manual-check-update', () => {
  checkUpdatesManually();
});

function setupAutoUpdater() {
  autoUpdater.logger = console;
  autoUpdater.autoDownload = false; // Disable auto-downloading updates

  autoUpdater.on('checking-for-updates', () => {
    server.writeLog("Checking for updates...");
    if (mainWindow) mainWindow.webContents.send('update-status', 'checking');
  });

  autoUpdater.on('update-available', (info) => {
    server.writeLog(`New update available: v${info.version}`);
    if (mainWindow) mainWindow.webContents.send('update-status', 'available', info);
    
    // Prompt the user for consent before downloading the update
    dialog.showMessageBox(mainWindow || null, {
      type: 'question',
      title: 'Update Available',
      message: `A new version (v${info.version}) of AiroDrop is available. Would you like to download it now?`,
      buttons: ['Download', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
        server.writeLog(`Downloading update v${info.version}...`);
        if (mainWindow) mainWindow.webContents.send('update-status', 'downloading');
      } else {
        isManualCheck = false;
      }
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    server.writeLog("You are up to date.");
    if (mainWindow) mainWindow.webContents.send('update-status', 'not-available', info);
    if (isManualCheck) {
      isManualCheck = false;
      dialog.showMessageBox(mainWindow || null, {
        type: 'info',
        title: 'AiroDrop Update',
        message: 'You are up to date!'
      });
    }
  });

  autoUpdater.on('error', (err) => {
    server.writeLog(`Update check failed: ${err.message}`);
    if (mainWindow) mainWindow.webContents.send('update-status', 'error', err.message);
    if (isManualCheck) {
      isManualCheck = false;
      dialog.showMessageBox(mainWindow || null, {
        type: 'warning',
        title: 'Update Check',
        message: 'Update check failed.'
      });
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    if (mainWindow) mainWindow.webContents.send('update-download-progress', progressObj);
  });

  autoUpdater.on('update-downloaded', (info) => {
    server.writeLog("Update downloaded successfully.");
    if (mainWindow) mainWindow.webContents.send('update-status', 'downloaded', info);
    dialog.showMessageBox(mainWindow || null, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} is ready to install. Restart the app to apply the update?`,
      buttons: ['Restart Now', 'Later']
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  // Only perform auto update check if enabled in settings
  if (server.getAutoUpdate()) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[AutoUpdater] Auto check failed:', err.message);
    });
  }
}

// ─── Window Management ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 720,
    resizable: true,
    title: 'AiroDrop',
    icon: path.join(__dirname, 'public', process.platform === 'win32' ? 'logo.ico' : 'logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Send initial state when window finishes loading
  mainWindow.webContents.on('did-finish-load', () => {
    // Always send current server status to newly loaded renderer
    mainWindow.webContents.send('server-status', {
      running: serverRunning,
      port: serverPort,
      ip: server.getLocalIP(),
      error: null
    });
    mainWindow.webContents.send('login-item-settings', app.getLoginItemSettings().openAtLogin);
    // Also push current directory
    mainWindow.webContents.send('dir-updated', server.getSaveDir());
  });
}

// ─── Tray Management ──────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'public', process.platform === 'win32' ? 'logo.ico' : 'logo.png');
  tray = new Tray(iconPath);
  tray.setToolTip('AiroDrop');
  updateTrayMenu(true);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

function updateTrayMenu(isRunning) {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open AiroDrop', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { 
      label: isRunning ? 'Stop Server' : 'Start Server', 
      click: () => {
        if (isRunning) {
          server.stopServer();
          serverRunning = false;
          serverPort = null;
          updateTrayMenu(false);
          if (mainWindow) mainWindow.webContents.send('server-status', { running: false });
        } else {
          server.startServer((port, err) => {
            serverRunning = !err;
            serverPort = port || server.getPort();
            updateTrayMenu(serverRunning);
            if (mainWindow) mainWindow.webContents.send('server-status', { running: serverRunning, port: serverPort, ip: server.getLocalIP(), error: err?.message });
          });
        }
      } 
    },
    { type: 'separator' },
    { label: 'Check for Updates...', click: () => { checkUpdatesManually(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

// ─── App Lifecycle ────────────────────────────────────────────
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  server.stopServer();
});

// Ignore self-signed certificate errors for local HTTPS loopback requests
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.startsWith('https://localhost:') || url.startsWith('https://127.0.0.1:')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// ─── IPC Communication with GUI ───────────────────────────────
ipcMain.on('start-server', (event) => {
  server.startServer((port, err) => {
    serverRunning = !err;
    serverPort = port || server.getPort();
    updateTrayMenu(serverRunning);
    const status = { running: serverRunning, port: serverPort, ip: server.getLocalIP(), error: err?.message };
    if (mainWindow) mainWindow.webContents.send('server-status', status);
  });
});

ipcMain.on('stop-server', (event) => {
  server.stopServer();
  serverRunning = false;
  serverPort = null;
  updateTrayMenu(false);
  if (mainWindow) mainWindow.webContents.send('server-status', { running: false });
});

ipcMain.on('get-status', (event) => {
  event.reply('server-status', { running: serverRunning, port: serverPort || server.getPort(), ip: server.getLocalIP() });
});

ipcMain.on('open-dashboard', () => {
  const port = server.getPort();
  if (port) {
    shell.openExternal(`http://${server.getLocalIP()}:${port}`);
  }
});

ipcMain.on('open-link', (event, url) => {
  shell.openExternal(url);
});

ipcMain.on('toggle-auto-launch', (event, enable) => {
  app.setLoginItemSettings({
    openAtLogin: enable,
    path: process.execPath
  });
  event.reply('login-item-settings', app.getLoginItemSettings().openAtLogin);
});

ipcMain.on('get-dir', (event) => {
  event.reply('dir-updated', server.getSaveDir());
});

ipcMain.on('change-dir', async (event) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: server.getSaveDir()
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const newDir = result.filePaths[0];
    server.setSaveDir(newDir);
    event.reply('dir-updated', newDir);
  }
});

ipcMain.on('force-kill-all', () => {
  server.stopServer();
  app.exit(0);
});

ipcMain.on('get-port-sync', (event) => {
  event.returnValue = server.getPort() || 3478;
});

ipcMain.on('get-protocol-sync', (event) => {
  event.returnValue = server.getHttpsEnabled() ? 'https' : 'http';
});

ipcMain.on('open-file-folder', (event, filename) => {
  const filePath = path.join(server.getSaveDir(), filename);
  shell.showItemInFolder(filePath);
});

ipcMain.on('restore-window', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ─── Screencast source ID IPC handler ──────────────────────────────
ipcMain.handle('get-screen-source', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources && sources.length > 0) {
      return sources[0].id;
    }
  } catch (err) {
    console.error('[SCREENCAST] Failed to get screen source ID:', err);
  }
  return null;
});

// ─── WebRTC Screencast & Microphone Signaling Loop ─────────────────
let activePhoneWs = null;

server.serverEvents.on('phone_connected', (ws) => {
  activePhoneWs = ws;
  console.log('[MAIN] Active phone WS reference registered.');
});

server.serverEvents.on('phone_disconnected', (ws) => {
  if (activePhoneWs === ws) {
    activePhoneWs = null;
    console.log('[MAIN] Active phone WS reference cleared.');
  }
});

server.serverEvents.on('screencast_start', (ws) => {
  activePhoneWs = ws;
  if (mainWindow) {
    mainWindow.webContents.send('screencast-start');
  }
});

server.serverEvents.on('screencast_stop', (ws) => {
  if (mainWindow) {
    mainWindow.webContents.send('screencast-stop');
  }
});

server.serverEvents.on('webrtc_answer', (ws, answer) => {
  if (mainWindow) {
    mainWindow.webContents.send('webrtc-answer', answer);
  }
});

server.serverEvents.on('webrtc_ice_candidate', (ws, candidate) => {
  if (mainWindow) {
    mainWindow.webContents.send('webrtc-ice-candidate', candidate);
  }
});

ipcMain.on('send-webrtc-offer', (event, offer) => {
  if (activePhoneWs && activePhoneWs.readyState === 1) {
    activePhoneWs.send(JSON.stringify({
      type: 'webrtc_offer',
      offer: offer
    }));
  }
});

ipcMain.on('send-webrtc-candidate', (event, candidate) => {
  if (activePhoneWs && activePhoneWs.readyState === 1) {
    activePhoneWs.send(JSON.stringify({
      type: 'webrtc_ice_candidate',
      candidate: candidate
    }));
  }
});

// Microphone Signaling Event Listeners (Phone -> PC)
server.serverEvents.on('mic_offer', (ws, offer) => {
  if (mainWindow) {
    mainWindow.webContents.send('mic-offer', offer);
  }
});

server.serverEvents.on('mic_ice_candidate', (ws, candidate) => {
  if (mainWindow) {
    mainWindow.webContents.send('mic-ice-candidate', candidate);
  }
});

server.serverEvents.on('mic_stop', (ws) => {
  if (mainWindow) {
    mainWindow.webContents.send('mic-stop');
  }
});

// Outbound Microphone Signaling IPC Triggers (PC -> Phone)
ipcMain.on('send-mic-answer', (event, answer) => {
  if (activePhoneWs && activePhoneWs.readyState === 1) {
    activePhoneWs.send(JSON.stringify({
      type: 'mic_answer',
      answer: answer
    }));
  }
});

ipcMain.on('send-mic-candidate', (event, candidate) => {
  if (activePhoneWs && activePhoneWs.readyState === 1) {
    activePhoneWs.send(JSON.stringify({
      type: 'mic_ice_candidate',
      candidate: candidate
    }));
  }
});

ipcMain.on('send-mic-stop', () => {
  if (activePhoneWs && activePhoneWs.readyState === 1) {
    activePhoneWs.send(JSON.stringify({
      type: 'mic_stop'
    }));
  }
});
