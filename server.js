/**
 * server.js — Main Node.js server for iPhone → PC integration (Refactored & Modular)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const EventEmitter = require('events');

const state = require('./src/state');
const utils = require('./src/utils');
const { registerMiddleware } = require('./src/middleware');
const { setupWebSocket } = require('./src/trackpad');

const filesRouter = require('./src/routes/files');
const clipboardRouter = require('./src/routes/clipboard');
const settingsRouter = require('./src/routes/settings');

const serverEvents = new EventEmitter();
const app = express();

// Register all global middlewares (Rate Limit, CORS, Parsers, Auth stubs)
registerMiddleware(app);

// Register feature-based routers
app.use('/files', filesRouter);
app.use('/api', clipboardRouter);
app.use('/api', settingsRouter);

// Serve local client-side qrcode library
app.get('/vendor/qrcode.min.js', (req, res) => {
  const qrLibPath = path.join(__dirname, 'node_modules', 'qrcode', 'build', 'qrcode.min.js');
  if (fs.existsSync(qrLibPath)) {
    res.sendFile(qrLibPath);
  } else {
    res.status(404).send('QRCode library not found');
  }
});

// Serve image and file downloads from the dynamic save directory
app.use('/received', (req, res, next) => {
  express.static(state.SAVE_DIR)(req, res, next);
});

// Serve static dashboard files with 1-hour cache for JS/CSS/images
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const cacheable = ['.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2'];
    if (cacheable.includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// GET /m — Mobile setup page (separate from SPA fallback)
app.get('/m', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

// SPA fallback — serve index.html for any unmatched route (except /m and /files)
app.get('*', (req, res, next) => {
  if (req.path === '/files' || req.path.startsWith('/files/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Multer error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 50 MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(500).json({ error: err.message });
  }
  next();
});

// Initialize server configurations
function init(userDataPath) {
  state.CONFIG_FILE = path.join(userDataPath, 'config.json');
  state.HISTORY_FILE = path.join(userDataPath, 'history.json');
  state.SCRATCHPAD_FILE = path.join(userDataPath, 'scratchpad.txt');
  state.SAVE_DIR = path.join(userDataPath, 'received');
  state.SHARE_DIR = path.join(userDataPath, 'shared');

  // Load Settings from config.json
  try {
    if (fs.existsSync(state.CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(state.CONFIG_FILE, 'utf8'));
      if (data.port) state.PORT = parseInt(data.port, 10) || 3478;
      state.TEMPORARY_MODE = !!data.temporaryMode;
      if (data.deviceName) state.DEVICE_NAME = data.deviceName;
      if (data.rateLimitEnabled !== undefined) state.RATE_LIMIT_ENABLED = !!data.rateLimitEnabled;
      if (data.notificationsEnabled !== undefined) state.NOTIFICATIONS_ENABLED = !!data.notificationsEnabled;
      if (data.temporaryModeHours !== undefined) state.TEMPORARY_MODE_HOURS = parseFloat(data.temporaryModeHours) || 2;
      if (data.autoOpenLinks !== undefined) state.AUTO_OPEN_LINKS = !!data.autoOpenLinks;
      if (data.launchOnStartup !== undefined) state.LAUNCH_ON_STARTUP = !!data.launchOnStartup;
      if (data.autoUpdate !== undefined) state.AUTO_UPDATE = !!data.autoUpdate;
      if (data.saveDir) {
        state.SAVE_DIR = path.isAbsolute(data.saveDir) ? data.saveDir : path.resolve(__dirname, data.saveDir);
      }
      if (data.shareDir) {
        state.SHARE_DIR = path.isAbsolute(data.shareDir) ? data.shareDir : path.resolve(__dirname, data.shareDir);
      } else {
        state.SHARE_DIR = state.SAVE_DIR;
      }
    }
  } catch (err) {
    console.error('[CONFIG] Failed to load config.json:', err.message);
  }

  // Ensure Save and Share directories exist
  try {
    if (!fs.existsSync(state.SAVE_DIR)) {
      fs.mkdirSync(state.SAVE_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[CONFIG] Failed to create save directory:', err.message);
    state.SAVE_DIR = path.join(__dirname, 'received');
    if (!fs.existsSync(state.SAVE_DIR)) {
      fs.mkdirSync(state.SAVE_DIR, { recursive: true });
    }
  }

  try {
    if (!fs.existsSync(state.SHARE_DIR)) {
      fs.mkdirSync(state.SHARE_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[CONFIG] Failed to create share directory:', err.message);
    state.SHARE_DIR = state.SAVE_DIR;
  }

  // Apply Login Items auto-launch in Electron
  try {
    const electron = require('electron');
    if (electron && electron.app) {
      electron.app.setLoginItemSettings({
        openAtLogin: state.LAUNCH_ON_STARTUP,
        path: process.execPath
      });
    }
  } catch (_) {}

  // Load history if not in temporary mode
  if (!state.TEMPORARY_MODE) {
    try {
      if (fs.existsSync(state.HISTORY_FILE)) {
        const data = JSON.parse(fs.readFileSync(state.HISTORY_FILE, 'utf8'));
        state.history.length = 0;
        state.history.push(...(Array.isArray(data) ? data : []));
      }
    } catch (err) {
      console.error('[HISTORY] Failed to load history:', err.message);
    }
  }

  // Load scratchpad
  try {
    if (fs.existsSync(state.SCRATCHPAD_FILE)) {
      state.scratchpadText = fs.readFileSync(state.SCRATCHPAD_FILE, 'utf8');
    }
  } catch (err) {
    console.error('[SCRATCHPAD] Failed to load scratchpad:', err.message);
  }
}

// Start HTTP and WS servers
function startServer(portCallback) {
  if (state.serverInstance) return;

  state.serverInstance = app.listen(state.PORT, '0.0.0.0', () => {
    const ip = utils.getLocalIP();
    const url = `http://${ip}:${state.PORT}`;
    utils.writeLog(`AiroDrop Server active at ${url}`);

    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║   iPhone → PC : AirDrop Alternative         ║');
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log(`  ║   Server URL : ${url.padEnd(29)}║`);
    console.log(`  ║   Dashboard  : ${url.padEnd(29)}║`);
    console.log(`  ║   Save Folder: ${state.SAVE_DIR.padEnd(29)}║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');

    if (portCallback) portCallback(state.PORT);
  });

  setupWebSocket(state.serverInstance, serverEvents);

  state.serverInstance.on('error', (err) => {
    console.error('Server error:', err);
    if (portCallback) portCallback(null, err);
  });
}

// Stop servers
function stopServer() {
  if (state.serverInstance) {
    utils.writeLog("AiroDrop Server stopped.");
    if (state.wss) {
      state.wss.close();
      state.wss = null;
    }
    state.serverInstance.close();
    state.serverInstance = null;
    console.log('Server stopped.');
  }
}

// Graceful shutdown hooks
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  stopServer();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});

module.exports = {
  app,
  init,
  startServer,
  stopServer,
  getPort: () => state.PORT,
  getSaveDir: () => state.SAVE_DIR,
  getShareDir: () => state.SHARE_DIR,
  setSaveDir: (newDir) => {
    state.SAVE_DIR = newDir;
    try {
      let data = {};
      if (fs.existsSync(state.CONFIG_FILE)) {
        data = JSON.parse(fs.readFileSync(state.CONFIG_FILE, 'utf8'));
      }
      data.saveDir = state.SAVE_DIR;
      fs.writeFileSync(state.CONFIG_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[CONFIG] Failed to save config.json:', err.message);
    }
  },
  getLocalIP: utils.getLocalIP,
  serverEvents,
  writeLog: utils.writeLog,
  getAutoUpdate: () => state.AUTO_UPDATE,
  getLaunchOnStartup: () => state.LAUNCH_ON_STARTUP
};