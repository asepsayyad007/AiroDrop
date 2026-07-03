const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog } = require('electron');
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
});

// ─── Window Management ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 720,
    resizable: true,
    title: 'AiroDrop',
    icon: path.join(__dirname, 'public', 'logo.png'),
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
  const iconPath = path.join(__dirname, 'public', 'logo.png');
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
