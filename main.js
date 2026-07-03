const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const os = require('os');
const server = require('./server'); // Our refactored server.js

let mainWindow = null;
let tray = null;
let isQuitting = false;

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
  // Initialize server with userData path for persistent data
  const userDataPath = app.getPath('userData');
  server.init(userDataPath);

  createWindow();
  createTray();

  // Start the server by default
  server.startServer((port, err) => {
    if (mainWindow) {
      mainWindow.webContents.send('server-status', { 
        running: !err, 
        port: port || server.getPort(),
        ip: server.getLocalIP(),
        error: err ? err.message : null 
      });
    }
    updateTrayMenu(!err);
  });
});

// ─── Window Management ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 650,
    height: 750,
    resizable: true,
    title: 'AiroDrop',
    icon: path.join(__dirname, 'public', 'logo.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'gui', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Send initial state when window finishes loading
  mainWindow.webContents.on('did-finish-load', () => {
    const isRunning = server.getPort() !== undefined; // rough check, actual status managed via callbacks
    mainWindow.webContents.send('login-item-settings', app.getLoginItemSettings().openAtLogin);
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
    { label: 'Open AiroDrop', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { 
      label: isRunning ? 'Stop Server' : 'Start Server', 
      click: () => {
        if (isRunning) {
          server.stopServer();
          updateTrayMenu(false);
          if (mainWindow) mainWindow.webContents.send('server-status', { running: false });
        } else {
          server.startServer((port, err) => {
            updateTrayMenu(!err);
            if (mainWindow) mainWindow.webContents.send('server-status', { running: !err, port, error: err?.message });
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
    updateTrayMenu(!err);
    event.reply('server-status', { running: !err, port, ip: server.getLocalIP(), error: err?.message });
  });
});

ipcMain.on('stop-server', (event) => {
  server.stopServer();
  updateTrayMenu(false);
  event.reply('server-status', { running: false });
});

ipcMain.on('get-status', (event) => {
  event.reply('server-status', { running: true, port: server.getPort(), ip: server.getLocalIP() });
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
