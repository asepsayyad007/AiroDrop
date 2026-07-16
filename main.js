const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, desktopCapturer } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const os = require('os');
const fs = require('fs');
const server = require('./server'); // Our refactored server.js

let mainWindow = null;
let tray = null;
let isQuitting = false;
let serverRunning = false;
const activeWriteStreams = new Map();

let serverPort = null;

// ─── Single Instance Lock ─────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', (event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  processCommandLineArgs(commandLine);
});

// Helper functions for context menu file sending
function queueFileForPhone(filePath) {
  const state = require('./src/state');
  const utils = require('./src/utils');

  try {
    const originalName = path.basename(filePath);
    const ext = path.extname(originalName) || '.bin';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
    const filename = `${timestamp}_${safeName || 'file'}${ext}`;
    const destination = path.join(state.SAVE_DIR, filename);

    if (!fs.existsSync(state.SAVE_DIR)) {
      fs.mkdirSync(state.SAVE_DIR, { recursive: true });
    }

    fs.copyFileSync(filePath, destination);
    const stats = fs.statSync(destination);

    const mimeMap = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
      '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
      '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
      '.txt': 'text/plain', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json'
    };
    const mimeType = mimeMap[ext.toLowerCase()] || 'application/octet-stream';

    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: 'file',
      filename: filename,
      originalName: originalName,
      size: stats.size,
      mimeType: mimeType,
      timestamp: new Date().toISOString()
    };

    state.pendingForPhone.unshift(item);
    if (state.pendingForPhone.length > 50) state.pendingForPhone.pop();
    utils.broadcastSSE('phone-queued', item);
    utils.writeLog(`Queued file via context menu command: ${originalName}`);

    const notifier = require('node-notifier');
    notifier.notify({
      title: 'AiroDrop',
      message: `File queued for iPhone: ${originalName}`,
      icon: path.join(__dirname, 'public', 'logo.png')
    });
  } catch (err) {
    console.error('Failed to queue file for phone:', err);
  }
}

function processCommandLineArgs(argv) {
  if (!argv || argv.length === 0) return;

  for (const arg of argv) {
    if (arg.startsWith('-') || arg.startsWith('--')) continue;
    if (arg === process.execPath) continue;
    if (arg === '.' || arg.endsWith('main.js')) continue;

    let resolvedPath = arg;
    if (!path.isAbsolute(resolvedPath)) {
      resolvedPath = path.resolve(resolvedPath);
    }

    if (fs.existsSync(resolvedPath)) {
      try {
        const stats = fs.statSync(resolvedPath);
        if (stats.isFile()) {
          queueFileForPhone(resolvedPath);
        }
      } catch (e) {
        console.error('Error processing argument path:', e);
      }
    }
  }
}

// ─── Suppress Chromium internal SSL / net log noise ─────────────
// These flags silence the low-level Chromium log lines like
// "handshake failed; returned -1, SSL error code 1, net_error -202"
// that appear because we use a self-signed cert on localhost.
app.commandLine.appendSwitch('log-level', '3');          // Only show fatal Chromium logs
app.commandLine.appendSwitch('disable-logging');          // Disable Chromium file-logging
app.commandLine.appendSwitch('ignore-certificate-errors'); // Belt-and-suspenders cert trust

// ─── Main Initialization ──────────────────────────────────────
app.whenReady().then(() => {
  app.setAppUserModelId('com.asep-ios-integration.airodrop');
  
  // Initialize server with userData path for persistent data
  const userDataPath = app.getPath('userData');

  // Migrate configuration from old folder (ios-win-integration) if it exists and new folder is fresh
  try {
    const oldUserDataPath = path.join(path.dirname(userDataPath), 'ios-win-integration');
    if (fs.existsSync(oldUserDataPath) && !fs.existsSync(path.join(userDataPath, 'config.json'))) {
      const filesToMigrate = ['config.json', 'history.json', 'scratchpad.txt', 'key.pem', 'cert.pem'];
      filesToMigrate.forEach(file => {
        const oldFile = path.join(oldUserDataPath, file);
        const newFile = path.join(userDataPath, file);
        if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
          fs.copyFileSync(oldFile, newFile);
        }
      });
      console.log('[MIGRATION] Configuration successfully migrated from ios-win-integration');
    }
  } catch (migErr) {
    console.error('[MIGRATION] Failed to migrate configuration:', migErr.message);
  }

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
    processCommandLineArgs(process.argv);
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

function getReleaseNotesText(releaseNotes) {
  if (!releaseNotes) return 'No release notes provided.';
  if (typeof releaseNotes === 'string') {
    return releaseNotes.replace(/<[^>]*>/g, '').trim();
  }
  if (Array.isArray(releaseNotes)) {
    return releaseNotes.map(note => {
      if (typeof note === 'string') return note;
      if (note && typeof note.note === 'string') return note.note;
      return JSON.stringify(note);
    }).join('\n').replace(/<[^>]*>/g, '').trim();
  }
  return typeof releaseNotes === 'object' ? JSON.stringify(releaseNotes) : String(releaseNotes);
}

function setupAutoUpdater() {
  autoUpdater.logger = console;
  autoUpdater.autoDownload = false; // Disable auto-downloading updates

  autoUpdater.on('checking-for-updates', () => {
    server.writeLog("Checking for updates...");
    if (mainWindow) mainWindow.webContents.send('update-status', 'checking');
  });

  autoUpdater.on('update-available', (info) => {
    server.writeLog(`New update available: v${info.version}`);

    // Check if user has skipped this version (only skip on automatic checks)
    let skippedVersion = '';
    const state = require('./src/state');
    try {
      if (fs.existsSync(state.CONFIG_FILE)) {
        const configData = JSON.parse(fs.readFileSync(state.CONFIG_FILE, 'utf8'));
        skippedVersion = configData.skippedVersion || '';
      }
    } catch (e) {
      console.error('[AutoUpdater] Failed to read skippedVersion from config:', e.message);
    }

    if (info.version === skippedVersion && !isManualCheck) {
      server.writeLog(`Skipping update v${info.version} (user previously skipped this version)`);
      if (mainWindow) mainWindow.webContents.send('update-status', 'not-available');
      return;
    }

    if (mainWindow) mainWindow.webContents.send('update-status', 'available', info);

    const notes = getReleaseNotesText(info.releaseNotes);
    const changelogDisplay = notes.length > 500 ? notes.slice(0, 497) + '...' : notes;

    dialog.showMessageBox(mainWindow || null, {
      type: 'question',
      title: 'Update Available',
      message: `A new version (v${info.version}) of AiroDrop is available!\n\nChangelog / What's New:\n${changelogDisplay}\n\nWould you like to download and install this update now?`,
      buttons: ['Download Now', 'Skip This Update', 'Later'],
      defaultId: 0,
      cancelId: 2
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
        server.writeLog(`Downloading update v${info.version}...`);
        if (mainWindow) mainWindow.webContents.send('update-status', 'downloading');
      } else if (result.response === 1) {
        // Skip this update - save to config.json
        try {
          let configData = {};
          if (fs.existsSync(state.CONFIG_FILE)) {
            configData = JSON.parse(fs.readFileSync(state.CONFIG_FILE, 'utf8'));
          }
          configData.skippedVersion = info.version;
          fs.writeFileSync(state.CONFIG_FILE, JSON.stringify(configData, null, 2));
          server.writeLog(`User chose to skip update v${info.version}`);
        } catch (err) {
          console.error('[AutoUpdater] Failed to save skippedVersion:', err.message);
        }
        isManualCheck = false;
        if (mainWindow) mainWindow.webContents.send('update-status', 'not-available');
      } else {
        isManualCheck = false;
        if (mainWindow) mainWindow.webContents.send('update-status', 'not-available');
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

// Ignore self-signed certificate errors for local HTTPS loopback
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
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

ipcMain.on('restart-server', (event) => {
  server.stopServer();
  serverRunning = false;
  serverPort = null;
  updateTrayMenu(false);
  if (mainWindow) mainWindow.webContents.send('server-status', { running: false });

  setTimeout(() => {
    server.startServer((port, err) => {
      serverRunning = !err;
      serverPort = port || server.getPort();
      updateTrayMenu(serverRunning);
      const status = { running: serverRunning, port: serverPort, ip: server.getLocalIP(), error: err?.message };
      if (mainWindow) mainWindow.webContents.send('server-status', status);
    });
  }, 1000);
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

ipcMain.on('open-save-directory', () => {
  shell.openPath(server.getSaveDir());
});


// ─── Direct Streaming Upload IPC Handlers ──────────────────────

let pendingCompletedFiles = [];
let completedNotificationTimeout = null;

function triggerCompletedNotification(filename) {
  pendingCompletedFiles.push(filename);
  if (completedNotificationTimeout) {
    clearTimeout(completedNotificationTimeout);
  }
  completedNotificationTimeout = setTimeout(() => {
    const count = pendingCompletedFiles.length;
    const notifier = require('node-notifier');
    let message = '';
    if (count === 1) {
      message = `Received File: ${pendingCompletedFiles[0]}`;
    } else {
      const listText = pendingCompletedFiles.join(', ');
      const truncated = listText.length > 60 ? listText.slice(0, 57) + '...' : listText;
      message = `Received ${count} Files: ${truncated}`;
    }
    notifier.notify({
      title: 'AiroDrop',
      message: message,
      icon: path.join(__dirname, 'public', 'logo.png')
    });
    pendingCompletedFiles = [];
    completedNotificationTimeout = null;
  }, 1000);
}

ipcMain.on('receive-file-start', (event, { token, filename, size, mimeType }) => {
  const state = require('./src/state');
  
  try {
    const originalName = filename;
    const baseNameOnly = path.basename(originalName);
    const rawExt = path.extname(baseNameOnly) || '.bin';
    const ext = rawExt.replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = baseNameOnly.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
    const finalFilename = `${timestamp}_${safeName || 'file'}${ext}`;
    
    const saveDir = state.SAVE_DIR || path.join(app.getPath('userData'), 'received');
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    const tempPath = path.join(saveDir, `${finalFilename}.tmp`);
    const finalPath = path.join(saveDir, finalFilename);
    const writeStream = fs.createWriteStream(tempPath);

    activeWriteStreams.set(token, {
      writeStream,
      tempPath,
      finalPath,
      filename: finalFilename,
      originalName,
      size,
      mimeType: mimeType || 'application/octet-stream'
    });

    console.log(`[IPC] File streaming start initialized for token ${token}: ${tempPath}`);
  } catch (err) {
    console.error('[IPC] Failed to start receive write stream:', err);
  }
});

ipcMain.on('receive-file-chunk', (event, { token, chunk }) => {
  const session = activeWriteStreams.get(token);
  if (session && session.writeStream && chunk) {
    let buffer;
    if (Buffer.isBuffer(chunk)) {
      buffer = chunk;
    } else if (chunk.buffer) {
      const offset = typeof chunk.byteOffset === 'number' ? chunk.byteOffset : 0;
      const length = typeof chunk.byteLength === 'number' ? chunk.byteLength : chunk.length;
      buffer = Buffer.from(chunk.buffer, offset, length);
    } else {
      buffer = Buffer.from(chunk);
    }
    session.writeStream.write(buffer);
  }
});

ipcMain.on('receive-file-end', (event, { token }) => {
  const session = activeWriteStreams.get(token);
  if (session) {
    session.writeStream.end(() => {
      try {
        if (fs.existsSync(session.tempPath)) {
          fs.renameSync(session.tempPath, session.finalPath);
          console.log(`[IPC] Received file successfully saved to: ${session.finalPath}`);
          
          // Notify renderer of the final unique filename on disk
          event.reply('receive-file-completed', { token, filename: session.filename });

          // Register in system history & notify UI via SSE
          const utils = require('./src/utils');
          const isImg = session.mimeType.startsWith('image/');
          
          let clipboardSuccess = false;
          if (isImg) {
            try {
              const { copyImage } = require('./clipboard');
              const clipResult = copyImage(session.finalPath);
              clipboardSuccess = clipResult.success;
            } catch (clipErr) {
              console.error('[IPC] Failed to copy image to clipboard:', clipErr);
            }
          }

          const relativePath = path.relative(path.join(__dirname), session.finalPath);

          const item = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            type: isImg ? 'image' : 'file',
            filename: session.filename,
            originalName: session.originalName,
            path: relativePath,
            size: session.size,
            mimetype: session.mimeType,
            timestamp: new Date().toISOString(),
            clipboardSuccess
          };

          utils.addToHistory(item);

          // Trigger OS notification
          triggerCompletedNotification(session.originalName);
        }
      } catch (err) {
        console.error('[IPC] Failed to save/rename file stream:', err);
      } finally {
        activeWriteStreams.delete(token);
      }
    });
  }
});

ipcMain.on('receive-file-error', (event, { token }) => {
  const session = activeWriteStreams.get(token);
  if (session) {
    try {
      session.writeStream.destroy();
      if (fs.existsSync(session.tempPath)) {
        fs.unlinkSync(session.tempPath);
      }
      console.log(`[IPC] Cleaned up aborted stream session: ${token}`);
    } catch (err) {
      console.error('[IPC] Error cleaning up aborted session:', err);
    } finally {
      activeWriteStreams.delete(token);
    }
  }
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

// Host Device Pairing Approval Event (Device -> PC Host Modal)
server.serverEvents.on('request-host-approval', ({ deviceName, ip, respond }) => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
  dialog.showMessageBox(mainWindow || null, {
    type: 'question',
    title: 'AiroDrop Device Pairing Request',
    message: `A device is requesting access to your AiroDrop PC host:\n\n📱 Device Name: ${deviceName}\n🌐 IP Address: ${ip}\n\nDo you want to allow this device to connect and control AiroDrop?`,
    buttons: ['Approve & Pair Device', 'Deny Connection'],
    defaultId: 0,
    cancelId: 1
  }).then(result => {
    respond(result.response === 0);
  }).catch(() => {
    respond(false);
  });
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
