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
const { getLogger, setLogDir } = require('./src/logger');
const { errorHandler } = require('./src/errors');
const { registerProcessHandlers } = require('./src/processHandlers');
const { validateConfig } = require('./src/configValidator');
const C = require('./src/constants');

const filesRouter = require('./src/routes/files');
const clipboardRouter = require('./src/routes/clipboard');
const settingsRouter = require('./src/routes/settings');
const authRouter = require('./src/routes/auth');
const auth = require('./src/auth');

const serverEvents = new EventEmitter();
const app = express();

// Register all global middlewares (Rate Limit, CORS, Parsers, Auth stubs)
registerMiddleware(app);

// Register feature-based routers
app.use('/files', filesRouter);
app.use('/api', clipboardRouter);
app.use('/api', settingsRouter);
app.use('/api/auth', authRouter);

// GET /auth-pin — Mobile/Web PIN Lock Screen
app.get('/auth-pin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'auth-pin.html'));
});

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
    const basename = path.basename(filePath).toLowerCase();
    const cacheable = ['.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2'];
    if (basename === 'sw.js' || basename === 'mobile-app.js') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    } else if (cacheable.includes(ext)) {
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

// GET /api/health — Production health check endpoint
app.get('/api/health', (req, res) => {
  const memUsage = process.memoryUsage();
  const uptime = process.uptime();

  // Check disk space for save directory
  let diskOk = true;
  try {
    const testFile = path.join(state.SAVE_DIR, '.health-check-' + Date.now());
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
  } catch {
    diskOk = false;
  }

  const healthy = diskOk && state.serverInstance !== null;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    version: require('./package.json').version,
    uptime: Math.floor(uptime),
    uptimeHuman: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      unit: 'MB'
    },
    connections: {
      sse: state.sseClients ? state.sseClients.size : 0,
      websocket: state.wss ? state.wss.clients.size : 0
    },
    storage: {
      saveDir: state.SAVE_DIR,
      diskWritable: diskOk
    },
    historyCount: state.history.length,
    pairedDevices: state.pairedDevices ? state.pairedDevices.size : 0
  });
});

// SPA fallback — serve index.html for any unmatched route (except /m and /files)
app.get('*', (req, res, next) => {
  if (req.path === '/files' || req.path.startsWith('/files/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized error handler (handles Multer errors, parse errors, AppErrors, and generic errors)
app.use(errorHandler);

// Initialize server configurations
function init(userDataPath) {
  // Load .env file if present (environment variables override config.json)
  try {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
  } catch (_) {}

  // Initialize structured logging
  setLogDir(userDataPath);
  const logger = getLogger();

  // Register process-level error handlers
  registerProcessHandlers();

  state.CONFIG_FILE = path.join(userDataPath, 'config.json');
  state.HISTORY_FILE = path.join(userDataPath, 'history.json');
  state.SCRATCHPAD_FILE = path.join(userDataPath, 'scratchpad.txt');
  state.SAVE_DIR = path.join(userDataPath, 'received');
  state.SHARE_DIR = path.join(userDataPath, 'shared');
  state.KEY_FILE = path.join(userDataPath, 'key.pem');
  state.CERT_FILE = path.join(userDataPath, 'cert.pem');

  // Load and validate config.json
  let rawConfig = {};
  try {
    if (fs.existsSync(state.CONFIG_FILE)) {
      rawConfig = JSON.parse(fs.readFileSync(state.CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    logger.error('Failed to parse config.json', { error: err.message });
  }

  const config = validateConfig(rawConfig, userDataPath);

  // Apply validated config to state
  state.PORT = config.port;
  state.DEVICE_NAME = config.deviceName;
  state.SAVE_DIR = config.saveDir;
  state.SHARE_DIR = config.shareDir;
  state.TEMPORARY_MODE = config.temporaryMode;
  state.RATE_LIMIT_ENABLED = config.rateLimitEnabled;
  state.NOTIFICATIONS_ENABLED = config.notificationsEnabled;
  state.TEMPORARY_MODE_HOURS = config.temporaryModeHours;
  state.AUTO_OPEN_LINKS = config.autoOpenLinks;
  state.LAUNCH_ON_STARTUP = config.launchOnStartup;
  state.AUTO_UPDATE = config.autoUpdate;
  state.HTTPS_ENABLED = config.httpsEnabled;
  state.CONTEXT_MENU_ENABLED = config.contextMenuEnabled;
  state.SECURITY_MODE = config.securityMode;
  state.PIN_CODE = config.pinCode;
  state.SHORTCUT_SECRET = config.shortcutSecret;

  // Environment variable overrides (highest priority)
  if (process.env.PORT) state.PORT = parseInt(process.env.PORT, 10) || state.PORT;
  if (process.env.DEVICE_NAME) state.DEVICE_NAME = process.env.DEVICE_NAME;
  if (process.env.SAVE_DIR) state.SAVE_DIR = process.env.SAVE_DIR;
  if (process.env.SHARE_DIR) state.SHARE_DIR = process.env.SHARE_DIR;
  if (process.env.SECURITY_MODE) state.SECURITY_MODE = process.env.SECURITY_MODE;
  if (process.env.PIN_CODE) state.PIN_CODE = process.env.PIN_CODE;
  if (process.env.SHORTCUT_SECRET) state.SHORTCUT_SECRET = process.env.SHORTCUT_SECRET;
  if (process.env.HTTPS_ENABLED) state.HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';
  if (process.env.RATE_LIMIT_ENABLED) state.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== 'false';
  if (process.env.NOTIFICATIONS_ENABLED) state.NOTIFICATIONS_ENABLED = process.env.NOTIFICATIONS_ENABLED !== 'false';
  if (process.env.TEMPORARY_MODE) state.TEMPORARY_MODE = process.env.TEMPORARY_MODE === 'true';
  if (process.env.TEMPORARY_MODE_HOURS) state.TEMPORARY_MODE_HOURS = parseFloat(process.env.TEMPORARY_MODE_HOURS) || state.TEMPORARY_MODE_HOURS;

  state.PAIRED_DEVICES_FILE = path.join(userDataPath, 'paired_devices.json');
  auth.initAuth();

  // Ensure Save and Share directories exist
  try {
    if (!fs.existsSync(state.SAVE_DIR)) {
      fs.mkdirSync(state.SAVE_DIR, { recursive: true });
    }
  } catch (err) {
    logger.error('Failed to create save directory', { error: err.message });
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
    logger.error('Failed to create share directory', { error: err.message });
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
      logger.error('Failed to load history', { error: err.message });
    }
  }

  // Load scratchpad
  try {
    if (fs.existsSync(state.SCRATCHPAD_FILE)) {
      state.scratchpadText = fs.readFileSync(state.SCRATCHPAD_FILE, 'utf8');
    }
  } catch (err) {
    logger.error('Failed to load scratchpad', { error: err.message });
  }
}

// Start HTTP or HTTPS and WS servers
function startServer(portCallback) {
  if (state.serverInstance) return;

  const logger = getLogger();
  const ip = utils.getLocalIP();

  const listenAndSetup = () => {
    state.serverInstance.listen(state.PORT, '0.0.0.0', () => {
      const activeUrl = `${state.HTTPS_ENABLED ? 'https' : 'http'}://${ip}:${state.PORT}`;
      utils.writeLog(`AiroDrop Server active at ${activeUrl}`);

      console.log('');
      console.log('  ╔══════════════════════════════════════════════╗');
      console.log('  ║   iPhone → PC : AirDrop Alternative         ║');
      console.log('  ╠══════════════════════════════════════════════╣');
      console.log(`  ║   Server URL : ${activeUrl.padEnd(29)}║`);
      console.log(`  ║   Dashboard  : ${activeUrl.padEnd(29)}║`);
      const fallbackUrl = `http://${ip}:${state.PORT + 1}`;
      console.log(`  ║   Shortcuts  : ${fallbackUrl.padEnd(29)}║`);
      console.log(`  ║   Save Folder: ${state.SAVE_DIR.padEnd(29)}║`);
      console.log('  ╚══════════════════════════════════════════════╝');
      console.log('');

      if (portCallback) portCallback(state.PORT);
    });

    setupWebSocket(state.serverInstance, serverEvents);

    state.serverInstance.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const nextPort = state.PORT + 2; // +1 is reserved for HTTP fallback
        logger.warn(`Port ${state.PORT} in use, trying ${nextPort}`, { port: state.PORT, nextPort });
        state.serverInstance = null;
        state.PORT = nextPort;
        // Retry with new port (limit to 3 attempts)
        if (!state._portRetries) state._portRetries = 0;
        state._portRetries++;
        if (state._portRetries <= 3) {
          if (state.HTTPS_ENABLED) {
            startHttps();
          } else {
            startHttp();
          }
        } else {
          logger.error('Failed to find available port after 3 attempts');
          if (portCallback) portCallback(null, err);
        }
        return;
      }
      logger.error('Server error', { error: err.message });
      if (portCallback) portCallback(null, err);
    });

    // Start HTTP fallback server for iOS Shortcuts unconditionally
    try {
      const http = require('http');
      const fallbackPort = state.PORT + 1;
      state.httpFallbackInstance = http.createServer(app);
      state.httpFallbackInstance.listen(fallbackPort, '0.0.0.0', () => {
        utils.writeLog(`AiroDrop HTTP Fallback active at http://${ip}:${fallbackPort}`);
      });
      setupWebSocket(state.httpFallbackInstance, serverEvents);
    } catch (fallbackErr) {
      logger.error('Failed to start HTTP fallback server', { error: fallbackErr.message });
    }
  };

  const startHttps = () => {
    try {
      const https = require('https');
      const options = {
        key: fs.readFileSync(state.KEY_FILE),
        cert: fs.readFileSync(state.CERT_FILE)
      };
      state.serverInstance = https.createServer(options, app);
      listenAndSetup();
    } catch (err) {
      logger.error('HTTPS server start failed, falling back to HTTP', { error: err.message });
      state.HTTPS_ENABLED = false;
      startHttp();
    }
  };

  const startHttp = () => {
    const http = require('http');
    state.serverInstance = http.createServer(app);
    listenAndSetup();
  };

  if (state.HTTPS_ENABLED) {
    if (!fs.existsSync(state.KEY_FILE) || !fs.existsSync(state.CERT_FILE)) {
      console.log('[HTTPS] Generating self-signed TLS certificates...');
      try {
        const selfsigned = require('selfsigned');
        const attrs = [{ name: 'commonName', value: 'airodrop.local' }];
        selfsigned.generate(attrs, { days: 365 })
          .then((pems) => {
            fs.writeFileSync(state.KEY_FILE, pems.private, 'utf8');
            fs.writeFileSync(state.CERT_FILE, pems.cert, 'utf8');
            logger.info('HTTPS certificates generated successfully');
            startHttps();
          })
          .catch((certErr) => {
            logger.error('Failed to generate self-signed certificates', { error: certErr.message });
            state.HTTPS_ENABLED = false;
            startHttp();
          });
      } catch (requireErr) {
        logger.error('selfsigned module failed to load', { error: requireErr.message });
        state.HTTPS_ENABLED = false;
        startHttp();
      }
    } else {
      startHttps();
    }
  } else {
    startHttp();
  }
}

// Stop servers — graceful shutdown with connection draining
function stopServer(callback) {
  const logger = getLogger();
  
  if (!state.serverInstance && !state.httpFallbackInstance) {
    if (callback) callback();
    return;
  }

  logger.info('Graceful shutdown initiated...');

  // 1. Close WebSocket connections gracefully
  if (state.wss) {
    for (const client of state.wss.clients) {
      try {
        client.send(JSON.stringify({ type: 'server-shutdown' }));
        client.close(1001, 'Server shutting down');
      } catch (_) {}
    }
    state.wss.close();
    state.wss = null;
  }

  // 2. Close SSE connections
  if (state.sseClients) {
    for (const client of state.sseClients) {
      try {
        client.write(`event: shutdown\ndata: ${JSON.stringify({ message: 'Server shutting down' })}\n\n`);
        client.end();
      } catch (_) {}
    }
    state.sseClients.clear();
  }

  // 3. Save persistent state
  try {
    if (state.HISTORY_FILE && !state.TEMPORARY_MODE && state.history.length > 0) {
      fs.writeFileSync(state.HISTORY_FILE, JSON.stringify(state.history, null, 2), 'utf8');
    }
    if (state.SCRATCHPAD_FILE && state.scratchpadText) {
      fs.writeFileSync(state.SCRATCHPAD_FILE, state.scratchpadText, 'utf8');
    }
  } catch (err) {
    logger.error('Failed to save state during shutdown', { error: err.message });
  }

  // 4. Close HTTP servers with connection draining timeout
  let closed = 0;
  const totalServers = (state.serverInstance ? 1 : 0) + (state.httpFallbackInstance ? 1 : 0);
  
  const onClosed = () => {
    closed++;
    if (closed >= totalServers) {
      logger.info('All servers stopped');
      utils.writeLog('AiroDrop Server stopped.');
      if (callback) callback();
    }
  };

  // Force-close after 5 seconds if connections won't drain
  const forceTimer = setTimeout(() => {
    logger.warn('Force-closing servers after timeout');
    if (state.serverInstance) { try { state.serverInstance.close(); } catch(_) {} state.serverInstance = null; }
    if (state.httpFallbackInstance) { try { state.httpFallbackInstance.close(); } catch(_) {} state.httpFallbackInstance = null; }
    if (callback) callback();
  }, 5000);

  if (state.serverInstance) {
    state.serverInstance.close(() => {
      state.serverInstance = null;
      onClosed();
    });
  }

  if (state.httpFallbackInstance) {
    state.httpFallbackInstance.close(() => {
      state.httpFallbackInstance = null;
      onClosed();
    });
  }

  if (totalServers === 0) {
    clearTimeout(forceTimer);
    if (callback) callback();
  }
}

// Graceful shutdown hooks
process.on('SIGINT', () => {
  stopServer(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  const logger = getLogger();
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
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
  getLaunchOnStartup: () => state.LAUNCH_ON_STARTUP,
  getHttpsEnabled: () => state.HTTPS_ENABLED
};