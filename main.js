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

  autoUpdater.on('checking-for-updates', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', 'checking');
  });

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', 'available', info);
    if (isManualCheck) {
      isManualCheck = false;
      dialog.showMessageBox(mainWindow || null, {
        type: 'info',
        title: 'Update Available',
        message: `Version ${info.version} is available and is downloading in the background.`
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', 'not-available', info);
    if (isManualCheck) {
      isManualCheck = false;
      dialog.showMessageBox(mainWindow || null, {
        type: 'info',
        title: 'No Updates',
        message: `You are up to date! Version ${app.getVersion()} is the latest version.`
      });
    }
  });

  autoUpdater.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('update-status', 'error', err.message);
    if (isManualCheck) {
      isManualCheck = false;
      
      let friendlyMessage = `Error checking for updates: ${err.message}`;
      if (err.message.includes('latest.yml') || err.message.includes('404')) {
        friendlyMessage = `No auto-update configuration (latest.yml) found on GitHub for this release.\n\nThis is normal since your current published release (v4.7.0) does not have auto-updates enabled yet. Once you publish version v4.8.0 with latest.yml, auto-updates will work automatically!`;
        dialog.showMessageBox(mainWindow || null, {
          type: 'warning',
          title: 'Update Check',
          message: friendlyMessage
        });
      } else {
        dialog.showErrorBox('Update Error', friendlyMessage);
      }
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    if (mainWindow) mainWindow.webContents.send('update-download-progress', progressObj);
  });

  autoUpdater.on('update-downloaded', (info) => {
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

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[AutoUpdater] Check for updates failed:', err.message);
  });
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
      nodeIntegration: true,
      contextIsolation: false
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

// ─── Screencast Stream Handling ──────────────────────────────
const screencastTimers = new Map();

server.serverEvents.on('screencast_start', (ws) => {
  if (screencastTimers.has(ws)) return; // Already active

  console.log('[SCREENCAST] Starting desktop stream to mobile');
  
  const timerId = setInterval(() => {
    if (ws.readyState !== 1) { // not OPEN
      clearInterval(timerId);
      screencastTimers.delete(ws);
      return;
    }

    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } })
      .then(sources => {
        if (sources && sources.length > 0) {
          const imageBuffer = sources[0].thumbnail.toJPEG(75); // 75% quality JPEG
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'screencast_frame',
              image: 'data:image/jpeg;base64,' + imageBuffer.toString('base64')
            }));
          }
        }
      })
      .catch(err => {
        console.error('[SCREENCAST] Capture failed:', err.message);
      });
  }, 65); // ~15 fps for smooth real-time streaming

  screencastTimers.set(ws, timerId);
});

server.serverEvents.on('screencast_stop', (ws) => {
  if (screencastTimers.has(ws)) {
    console.log('[SCREENCAST] Stopping desktop stream');
    clearInterval(screencastTimers.get(ws));
    screencastTimers.delete(ws);
  }
});
