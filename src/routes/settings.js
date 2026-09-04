const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const multer = require('multer');
const state = require('../state');
const utils = require('../utils');
const auth = require('../auth');
const { sanitizeFilename, sanitizeDeviceName, validatePort, validatePin, validateSecurityMode, sanitizeSecret, toBoolean, validatePositiveFloat } = require('../sanitize');
const { getLogger } = require('../logger');
const asyncHandler = require('../asyncHandler');

const logger = getLogger();

let appVersion = '6.4.70';
try {
  const pkg = require('../../package.json');
  appVersion = pkg.version || '6.4.70';
} catch (e) {
  try {
    const pkg = require('../package.json');
    appVersion = pkg.version || '6.4.70';
  } catch {}
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, state.SAVE_DIR);
  },
  filename: (req, file, cb) => {
    const sanitized = sanitizeFilename(file.originalname, 'file');
    const ext = path.extname(sanitized) || '.bin';
    const base = path.basename(sanitized, ext);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const cleanBase = base.slice(0, 15).trim() || 'file';
    cb(null, `${cleanBase}_${timestamp}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB max
  fileFilter: (req, file, cb) => {
    cb(null, true);
  }
});

const outgoingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, state.SHARE_DIR);
  },
  filename: (req, file, cb) => {
    const sanitized = sanitizeFilename(file.originalname, 'file');
    const ext = path.extname(sanitized) || '.bin';
    const base = path.basename(sanitized, ext);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const cleanBase = base.slice(0, 15).trim() || 'file';
    cb(null, `outgoing_${cleanBase}_${timestamp}${ext}`);
  }
});

const uploadOutgoing = multer({
  storage: outgoingStorage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, true);
  }
});

function cleanupOutgoingFile(removed) {
  if (removed && removed.isOutgoing && removed.filename) {
    try {
      const fullPath = path.join(state.SHARE_DIR, removed.filename);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } catch (_) {}
  }
}

// GET /api/check-update — Query GitHub Releases API for updates
router.get('/check-update', (req, res) => {
  const https = require('https');
  const currentVersion = require('../../package.json').version;

  const options = {
    hostname: 'api.github.com',
    path: '/repos/asepsayyad007/AiroDrop/releases/latest',
    headers: { 'User-Agent': 'AiroDrop-Server/' + currentVersion },
    timeout: 15000 // 15s request timeout
  };

  const request = https.get(options, (apiRes) => {
    let data = '';
    apiRes.on('data', (chunk) => { data += chunk; });
    apiRes.on('end', () => {
      try {
        if (apiRes.statusCode === 403 || apiRes.statusCode === 429) {
          return res.status(429).json({ error: 'GitHub API rate limited. Try again later.' });
        }
        if (apiRes.statusCode !== 200) {
          return res.status(502).json({ error: 'GitHub API returned status ' + apiRes.statusCode });
        }
        const release = JSON.parse(data);
        if (!release || !release.tag_name) {
          return res.status(502).json({ error: 'Invalid response from GitHub (no tag_name)' });
        }
        const latestVersion = release.tag_name.replace(/^v/, '');

        // Proper semver comparison: only flag update if remote is strictly newer
        const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

        res.json({
          current: currentVersion,
          latest: latestVersion,
          updateAvailable,
          url: release.html_url,
          publishedAt: release.published_at || null
        });
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse GitHub response: ' + e.message });
      }
    });
  });

  request.on('error', (err) => {
    res.status(500).json({ error: 'Network error: ' + (err.message || 'connection failed') });
  });

  request.on('timeout', () => {
    request.destroy();
    res.status(504).json({ error: 'GitHub API request timed out' });
  });
});

// POST /api/check-update/trigger — Remote update trigger from mobile/web
router.post('/check-update/trigger', (req, res) => {
  try {
    const { ipcMain } = require('electron');
    if (ipcMain) {
      ipcMain.emit('manual-check-update');
    }
  } catch(e) {}
  res.json({ success: true, message: 'Update check triggered on PC' });
});

// POST /api/settings/server-control — Special control pipeline for server start/stop/restart/kill
router.post('/server-control', asyncHandler(async (req, res) => {
  const { action } = req.body || {};
  let serverModule = null;
  try { serverModule = require('../../server'); } catch (_) {}
  
  if (action === 'stop') {
    res.json({ success: true, message: 'Server stopping...' });
    setTimeout(() => {
      if (serverModule && typeof serverModule.stopServer === 'function') {
        serverModule.stopServer();
      }
    }, 100);
    return;
  }
  
  if (action === 'start') {
    res.json({ success: true, message: 'Server starting...' });
    setTimeout(() => {
      if (serverModule && typeof serverModule.startServer === 'function') {
        serverModule.startServer();
      }
    }, 100);
    return;
  }
  
  if (action === 'restart') {
    res.json({ success: true, message: 'Server restarting...' });
    setTimeout(() => {
      if (serverModule && typeof serverModule.stopServer === 'function') {
        serverModule.stopServer(() => {
          setTimeout(() => {
            if (typeof serverModule.startServer === 'function') {
              serverModule.startServer();
            }
          }, 400);
        });
      } else if (serverModule && typeof serverModule.startServer === 'function') {
        serverModule.startServer();
      }
    }, 100);
    return;
  }
  
  if (action === 'kill') {
    res.json({ success: true, message: 'Server terminating...' });
    setTimeout(() => {
      process.exit(0);
    }, 200);
    return;
  }
  
  res.status(400).json({ error: 'Invalid action parameter' });
}));

// GET /api/settings/server-status — Universal status API endpoint
router.get('/server-status', (req, res) => {
  let serverModule = null;
  try { serverModule = require('../../server'); } catch (_) {}
  
  res.json({
    running: true,
    port: (serverModule && serverModule.getPort) ? serverModule.getPort() : state.PORT,
    ip: (serverModule && serverModule.getLocalIP) ? serverModule.getLocalIP() : utils.getLocalIP(),
    https: (serverModule && serverModule.getHttpsEnabled) ? serverModule.getHttpsEnabled() : state.HTTPS_ENABLED
  });
});

/**
 * Compare two semver strings (major.minor.patch).
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a, b) {
  const cleanA = String(a || '').replace(/^v/, '').split('-')[0];
  const cleanB = String(b || '').replace(/^v/, '').split('-')[0];
  const pa = cleanA.split('.').map(n => parseInt(n, 10) || 0);
  const pb = cleanB.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

let cachedOsCaption = null;
function getRealOsCaption() {
  if (cachedOsCaption) return cachedOsCaption;
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const raw = execSync('wmic os get Caption /value', { encoding: 'utf8', timeout: 3000 });
      const match = raw.match(/Caption=(.+)/i);
      if (match && match[1]) {
        cachedOsCaption = match[1].trim();
        return cachedOsCaption;
      }
    } catch (e) {}
    cachedOsCaption = `Windows ${require('os').release().startsWith('10.0.2') ? '11' : '10'}`;
    return cachedOsCaption;
  }
  return `${require('os').type()} ${require('os').release()}`;
}

function getSystemDrives() {
  const drives = [];
  const letters = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
  letters.forEach(letter => {
    const drivePath = `${letter}:\\`;
    if (fs.existsSync(drivePath)) {
      try {
        const stats = fs.statfsSync(drivePath);
        const totalBytes = stats.blocks * stats.bsize;
        const freeBytes = stats.bfree * stats.bsize;
        const usedBytes = totalBytes - freeBytes;
        if (totalBytes > 0) {
          const totalGB = parseFloat((totalBytes / (1024 * 1024 * 1024)).toFixed(1));
          const freeGB = parseFloat((freeBytes / (1024 * 1024 * 1024)).toFixed(1));
          const usedGB = parseFloat((usedBytes / (1024 * 1024 * 1024)).toFixed(1));
          const usedPercent = Math.round((usedBytes / totalBytes) * 100);
          drives.push({
            letter,
            label: `Local Disk (${letter}:)`,
            totalGB,
            usedGB,
            freeGB,
            usedPercent
          });
        }
      } catch (e) {
        // Ignore unreadable drives
      }
    }
  });
  return drives;
}

// GET /api/info
router.get('/info', async (req, res) => {
  const ip = utils.getLocalIP();
  const protocol = state.HTTPS_ENABLED ? 'https' : 'http';
  const url = `${protocol}://${ip}:${state.PORT}`;
  const mobileUrl = `${url}/m`;
  const allIps = utils.getAllIPs();
  const osName = getRealOsCaption();
  const drives = getSystemDrives();
  const netMode = utils.detectNetworkMode(ip);
  const directHotspotUrl = `${protocol}://${ip}:${state.PORT}/m`;

  let qrDataUrl = null;
  let directQrDataUrl = null;

  try {
    qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    directQrDataUrl = qrDataUrl;
  } catch {}

  res.json({
    ip,
    port: state.PORT,
    url,
    https: state.HTTPS_ENABLED !== false,
    protocol,
    qrDataUrl,
    directQrDataUrl,
    directHotspotUrl,
    networkMode: netMode,
    isHotspot: netMode.isHotspot,
    saveDir: state.SAVE_DIR,
    uptime: process.uptime(),
    deviceName: state.DEVICE_NAME,
    osName,
    drives,
    allIps,
    temporaryMode: state.TEMPORARY_MODE,
    pairingToken: '',
    ipChangePending: state.PENDING_IP_CHANGE || null
  });
});

// POST /api/settings/acknowledge-ip-change — Dismiss pending IP change alert
router.post('/settings/acknowledge-ip-change', (req, res) => {
  state.PENDING_IP_CHANGE = null;
  res.json({ success: true });
});

// GET /api/qr.png
router.get('/qr.png', async (req, res) => {
  try {
    const ip = utils.getLocalIP();
    const protocol = state.HTTPS_ENABLED ? 'https' : 'http';
    const mobileUrl = `${protocol}://${ip}:${state.PORT}/m`;
    res.setHeader('Content-Type', 'image/png');
    await QRCode.toFileStream(res, mobileUrl, {
      width: 240,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
  } catch (err) {
    logger.error('QR image stream generation failed', { error: err.message });
    res.status(500).send('Failed to generate QR code');
  }
});

// GET /api/qr-gen.png or /api/qr
router.get(['/qr-gen.png', '/qr'], async (req, res) => {
  try {
    const { text, dark, light } = req.query;
    if (!text) {
      return res.status(400).send('No text provided');
    }
    const hexRegex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
    let darkColor = '#000000';
    let lightColor = '#ffffff';
    if (dark && hexRegex.test(dark)) {
      darkColor = dark.startsWith('#') ? dark : '#' + dark;
    }
    if (light && hexRegex.test(light)) {
      lightColor = light.startsWith('#') ? light : '#' + light;
    }

    res.setHeader('Content-Type', 'image/png');
    await QRCode.toFileStream(res, text, {
      width: 240,
      margin: 2,
      color: { dark: darkColor, light: lightColor }
    });
  } catch (err) {
    logger.error('Custom QR generation failed', { error: err.message });
    res.status(500).send('Failed to generate QR code');
  }
});

// GET /api/settings
router.get('/settings', (req, res) => {
  res.json({
    saveDir: state.SAVE_DIR,
    shareDir: state.SHARE_DIR,
    port: state.PORT,
    temporaryMode: state.TEMPORARY_MODE,
    deviceName: state.DEVICE_NAME,
    rateLimitEnabled: state.RATE_LIMIT_ENABLED,
    notificationsEnabled: state.NOTIFICATIONS_ENABLED,
    temporaryModeHours: state.TEMPORARY_MODE_HOURS,
    autoOpenLinks: state.AUTO_OPEN_LINKS,
    launchOnStartup: state.LAUNCH_ON_STARTUP,
    autoUpdate: state.AUTO_UPDATE,
    httpsEnabled: state.HTTPS_ENABLED,
    contextMenuEnabled: state.CONTEXT_MENU_ENABLED,
    securityMode: state.SECURITY_MODE,
    pinCode: state.PIN_CODE,
    shortcutSecret: state.SHORTCUT_SECRET,
    platform: process.platform,
    version: appVersion
  });
});

// POST /api/settings
router.post('/settings', async (req, res) => {
  try {
    const { saveDir, shareDir, temporaryMode, deviceName, port, rateLimitEnabled, notificationsEnabled, temporaryModeHours, autoOpenLinks, launchOnStartup, autoUpdate, httpsEnabled, contextMenuEnabled } = req.body;
    
    let resolvedPath = state.SAVE_DIR;
    if (saveDir) {
      resolvedPath = path.isAbsolute(saveDir) 
        ? saveDir 
        : path.resolve(path.join(__dirname, '..', '..'), saveDir);

      if (!fs.existsSync(resolvedPath)) {
        fs.mkdirSync(resolvedPath, { recursive: true });
      }

      const tempFile = path.join(resolvedPath, '.write-test-' + Math.random().toString(36).substring(7));
      fs.writeFileSync(tempFile, 'test');
      fs.unlinkSync(tempFile);
      
      state.SAVE_DIR = resolvedPath;
      if (!shareDir) {
        state.SHARE_DIR = resolvedPath;
      }
    }

    let resolvedSharePath = state.SHARE_DIR;
    if (shareDir) {
      resolvedSharePath = path.isAbsolute(shareDir) 
        ? shareDir 
        : path.resolve(path.join(__dirname, '..', '..'), shareDir);

      if (!fs.existsSync(resolvedSharePath)) {
        fs.mkdirSync(resolvedSharePath, { recursive: true });
      }

      const tempFile = path.join(resolvedSharePath, '.write-test-' + Math.random().toString(36).substring(7));
      fs.writeFileSync(tempFile, 'test');
      fs.unlinkSync(tempFile);
      
      state.SHARE_DIR = resolvedSharePath;
      if (!saveDir) {
        state.SAVE_DIR = resolvedSharePath;
      }
    }

    if (deviceName !== undefined) {
      state.DEVICE_NAME = sanitizeDeviceName(deviceName) || os.hostname();
    }

    if (port !== undefined) {
      const portResult = validatePort(port);
      if (portResult.valid) {
        state.PORT = portResult.value;
      }
    }

    if (rateLimitEnabled !== undefined) {
      state.RATE_LIMIT_ENABLED = toBoolean(rateLimitEnabled);
    }

    if (autoOpenLinks !== undefined) {
      state.AUTO_OPEN_LINKS = toBoolean(autoOpenLinks);
    }

    if (notificationsEnabled !== undefined) {
      state.NOTIFICATIONS_ENABLED = toBoolean(notificationsEnabled);
    }

    if (temporaryModeHours !== undefined) {
      state.TEMPORARY_MODE_HOURS = validatePositiveFloat(temporaryModeHours, 0.1, 720, 2);
    }

    if (launchOnStartup !== undefined) {
      state.LAUNCH_ON_STARTUP = toBoolean(launchOnStartup);
      try {
        const electron = require('electron');
        if (electron && electron.app) {
          electron.app.setLoginItemSettings({
            openAtLogin: state.LAUNCH_ON_STARTUP,
            path: process.execPath
          });
        }
      } catch (_) {}
    }

    if (autoUpdate !== undefined) {
      state.AUTO_UPDATE = toBoolean(autoUpdate);
    }

    if (httpsEnabled !== undefined) {
      state.HTTPS_ENABLED = toBoolean(httpsEnabled);
    }

    if (contextMenuEnabled !== undefined) {
      const oldVal = state.CONTEXT_MENU_ENABLED;
      state.CONTEXT_MENU_ENABLED = toBoolean(contextMenuEnabled);
      if (state.CONTEXT_MENU_ENABLED !== oldVal) {
        utils.updateWindowsContextMenu(state.CONTEXT_MENU_ENABLED);
      }
    }

    const { securityMode, pinCode, shortcutSecret } = req.body;
    if (securityMode !== undefined) {
      const modeResult = validateSecurityMode(securityMode);
      if (modeResult.valid) {
        state.SECURITY_MODE = modeResult.value;
      }
    }
    if (pinCode !== undefined) {
      const pinResult = validatePin(pinCode);
      if (pinResult.valid) {
        state.PIN_CODE = pinResult.value;
      }
    }
    if (shortcutSecret !== undefined) {
      state.SHORTCUT_SECRET = sanitizeSecret(shortcutSecret);
    }

    const oldTempMode = state.TEMPORARY_MODE;
    if (temporaryMode !== undefined) {
      state.TEMPORARY_MODE = toBoolean(temporaryMode);
      if (state.TEMPORARY_MODE !== oldTempMode) {
        if (state.TEMPORARY_MODE) {
          try { if (fs.existsSync(state.HISTORY_FILE)) fs.unlinkSync(state.HISTORY_FILE); } catch {}
        } else {
          utils.saveHistory();
        }
      }
    }

    fs.writeFileSync(state.CONFIG_FILE, JSON.stringify({
      saveDir: state.SAVE_DIR,
      shareDir: state.SHARE_DIR,
      port: state.PORT,
      temporaryMode: state.TEMPORARY_MODE,
      deviceName: state.DEVICE_NAME,
      rateLimitEnabled: state.RATE_LIMIT_ENABLED,
      notificationsEnabled: state.NOTIFICATIONS_ENABLED,
      temporaryModeHours: state.TEMPORARY_MODE_HOURS,
      autoOpenLinks: state.AUTO_OPEN_LINKS,
      launchOnStartup: state.LAUNCH_ON_STARTUP,
      autoUpdate: state.AUTO_UPDATE,
      httpsEnabled: state.HTTPS_ENABLED,
      contextMenuEnabled: state.CONTEXT_MENU_ENABLED,
      securityMode: state.SECURITY_MODE,
      pinCode: state.PIN_CODE,
      shortcutSecret: state.SHORTCUT_SECRET
    }, null, 2));

    const logStr = `Configurations updated: SaveFolder="${state.SAVE_DIR}", Port=${state.PORT}, DeviceName="${state.DEVICE_NAME}"`;
    const now = Date.now();
    if (global._lastConfigLog !== logStr || (now - (global._lastConfigLogTime || 0)) > 3000) {
      global._lastConfigLog = logStr;
      global._lastConfigLogTime = now;
      utils.writeLog(logStr);
    }
    res.json({
      success: true,
      saveDir: state.SAVE_DIR,
      shareDir: state.SHARE_DIR,
      temporaryMode: state.TEMPORARY_MODE,
      deviceName: state.DEVICE_NAME,
      port: state.PORT,
      rateLimitEnabled: state.RATE_LIMIT_ENABLED,
      notificationsEnabled: state.NOTIFICATIONS_ENABLED,
      temporaryModeHours: state.TEMPORARY_MODE_HOURS,
      autoOpenLinks: state.AUTO_OPEN_LINKS,
      launchOnStartup: state.LAUNCH_ON_STARTUP,
      autoUpdate: state.AUTO_UPDATE,
      httpsEnabled: state.HTTPS_ENABLED,
      contextMenuEnabled: state.CONTEXT_MENU_ENABLED,
      securityMode: state.SECURITY_MODE,
      pinCode: state.PIN_CODE,
      shortcutSecret: state.SHORTCUT_SECRET
    });
  } catch (err) {
    logger.error('Settings update failed', { error: err.message });
    res.status(400).json({ error: `Failed to save settings: ${err.message}` });
  }
});

// POST /api/settings/browse
router.post('/settings/browse', async (req, res) => {
  try {
    const platform = os.platform();
    let cmd = '';

    if (platform === 'win32') {
      cmd = 'powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = \'Select AiroDrop Save Folder\'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq \'OK\') { Write-Host $f.SelectedPath }"';
    } else if (platform === 'linux') {
      cmd = 'zenity --file-selection --directory --title="Select AiroDrop Save Folder" 2>/dev/null || kdialog --getexistingdirectory . 2>/dev/null';
    } else if (platform === 'darwin') {
      cmd = `osascript -e 'tell application "System Events" to activate' -e 'POSIX path of (choose folder with prompt "Select AiroDrop Save Folder")'`;
    } else {
      return res.status(400).json({ error: `Folder selection is not supported on platform: ${platform}` });
    }

    const { exec } = require('child_process');
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        logger.debug('Folder picker closed or canceled', { error: error.message });
        return res.json({ success: false, message: 'Canceled' });
      }
      const selectedPath = stdout.trim();
      if (!selectedPath) {
        return res.json({ success: false, message: 'Canceled' });
      }
      res.json({ success: true, path: selectedPath });
    });
  } catch (err) {
    logger.error('Browse folder picker error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send-to-phone
router.post('/send-to-phone', uploadOutgoing.single('file'), async (req, res) => {
  try {
    if (req.file) {
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'file',
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
        timestamp: new Date().toISOString(),
        isOutgoing: true
      };
      state.pendingForPhone.unshift(item);
      if (state.pendingForPhone.length > 50) {
        const popped = state.pendingForPhone.pop();
        cleanupOutgoingFile(popped);
      }
      utils.broadcastSSE('phone-queued', item);
      if (state.wss) {
        for (const client of state.wss.clients) {
          try { client.send(JSON.stringify({ type: 'phone_queued', item })); } catch (_) {}
        }
      }
      return res.json({ success: true, id: item.id, message: 'File queued for iPhone' });
    }

    const { type, text, imageUrl } = req.body;

    if (type === 'text' && text) {
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'text',
        content: text,
        timestamp: new Date().toISOString()
      };
      state.pendingForPhone.unshift(item);
      if (state.pendingForPhone.length > 50) {
        const popped = state.pendingForPhone.pop();
        cleanupOutgoingFile(popped);
      }
      utils.broadcastSSE('phone-queued', item);
      if (state.wss) {
        for (const client of state.wss.clients) {
          try { client.send(JSON.stringify({ type: 'phone_queued', item })); } catch (_) {}
        }
      }
      
      // Auto-copy to PC system clipboard
      try {
        const { copyText } = require('../../clipboard');
        await copyText(text);
      } catch (err) {
        logger.warn('Failed to copy sent text to PC clipboard', { error: err.message });
      }

      return res.json({ success: true, id: item.id, message: 'Text queued for iPhone' });
    }

    if (type === 'image' && imageUrl) {
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'image',
        url: imageUrl,
        timestamp: new Date().toISOString()
      };
      state.pendingForPhone.unshift(item);
      if (state.pendingForPhone.length > 50) {
        const popped = state.pendingForPhone.pop();
        cleanupOutgoingFile(popped);
      }
      utils.broadcastSSE('phone-queued', item);
      if (state.wss) {
        for (const client of state.wss.clients) {
          try { client.send(JSON.stringify({ type: 'phone_queued', item })); } catch (_) {}
        }
      }
      return res.json({ success: true, id: item.id, message: 'Image queued for iPhone' });
    }

    return res.status(400).json({ error: 'Provide type ("text", "image" or upload a file) and content' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/pending/:id
router.delete('/pending/:id', (req, res) => {
  const idx = state.pendingForPhone.findIndex(item => item.id === req.params.id);
  if (idx !== -1) {
    const [removed] = state.pendingForPhone.splice(idx, 1);
    cleanupOutgoingFile(removed);
    utils.broadcastSSE('phone-ack', removed);
    res.json({ success: true, message: 'Pending item canceled' });
  } else {
    res.status(404).json({ error: 'Pending item not found' });
  }
});

// GET /api/stats
router.get('/stats', (req, res) => {
  try {
    let totalTransfers = state.history.length;
    let totalBytes = 0;
    let filesCount = 0;
    
    for (const item of state.history) {
      if (item.size) {
        totalBytes += item.size;
      }
      if (item.type === 'file' || item.type === 'image') {
        filesCount++;
      }
    }
    
    res.json({
      transfers: totalTransfers,
      bytes: totalBytes,
      uptime: process.uptime(),
      files: filesCount,
      connections: state.sseClients.size
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/storage
router.get('/storage', (req, res) => {
  try {
    if (!fs.existsSync(state.SAVE_DIR)) {
      return res.json({ count: 0, size: 0, limit: 50 * 1024 * 1024 * 1024 });
    }
    const files = fs.readdirSync(state.SAVE_DIR);
    let totalSize = 0;
    let count = 0;
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const filePath = path.join(state.SAVE_DIR, file);
      try {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            totalSize += stat.size;
            count++;
          }
        }
      } catch {}
    }
    res.json({ count, size: totalSize, limit: 50 * 1024 * 1024 * 1024 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pending
router.get('/pending', (req, res) => {
  const after = req.query.after;
  let items = state.pendingForPhone;
  if (after) {
    items = state.pendingForPhone.filter(item => item.timestamp > after);
  }
  res.json({ items });
});

// POST /api/pending/:id/ack
router.post('/pending/:id/ack', (req, res) => {
  const idx = state.pendingForPhone.findIndex(item => item.id === req.params.id);
  if (idx !== -1) {
    const [removed] = state.pendingForPhone.splice(idx, 1);
    cleanupOutgoingFile(removed);
    utils.broadcastSSE('phone-ack', removed);
    res.json({ success: true, message: 'Item acknowledged' });
  } else {
    res.json({ success: true, message: 'Item already removed' });
  }
});

// GET /api/events (SSE)
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ count: state.history.length })}\n\n`);
  res.write(`event: logs-init\ndata: ${JSON.stringify(state.logHistory)}\n\n`);

  // ─── SSE Heartbeat: send a comment every 20s to keep the connection alive on mobile ───
  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat\n\n`); } catch { clearInterval(heartbeat); }
  }, 20000);

  res.deviceToken = auth.extractToken(req) || 'localhost';
  state.sseClients.add(res);
  utils.writeLog("Dashboard client connected.");

  req.on('close', () => {
    clearInterval(heartbeat);
    state.sseClients.delete(res);
  });
});

// POST /api/screencast/pause
router.post('/screencast/pause', express.json(), (req, res) => {
  if (!req.isLocalhost) {
    return res.status(403).json({ error: 'Only localhost can pause screencast' });
  }
  state.privacyPause = !state.privacyPause;
  utils.writeLog(`Screencast privacy pause ${state.privacyPause ? 'enabled' : 'disabled'}`);
  
  if (state.wss) {
    for (const wsClient of state.wss.clients) {
      if (wsClient.readyState === 1) { // WebSocket.OPEN
        wsClient.send(JSON.stringify({
          type: 'privacy_pause',
          paused: state.privacyPause
        }));
      }
    }
  }
  res.json({ success: true, paused: state.privacyPause });
});

// POST /api/open-url — Open a URL in the PC's default browser
router.post('/open-url', express.json(), async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url field required' });
  }
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return res.status(400).json({ error: 'Only http/https URLs are allowed' });
  }
  try {
    try {
      const { shell } = require('electron');
      await shell.openExternal(trimmed);
    } catch {
      const { execFile } = require('child_process');
      execFile('cmd.exe', ['/c', 'start', '', trimmed]);
    }
    utils.writeLog(`Opened URL in browser: ${trimmed}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/open-directory — Open the AiroDrop download/shared directory in File Explorer / OS File Manager
router.post('/open-directory', express.json(), (req, res) => {
  try {
    const activeBase = state.SHARE_DIR || state.SAVE_DIR;
    let dirPath = (req.body && typeof req.body.path === 'string' && req.body.path.trim())
      ? path.join(activeBase, req.body.path.trim())
      : activeBase;

    if (!fs.existsSync(dirPath)) {
      dirPath = activeBase;
    }

    try {
      const { shell } = require('electron');
      if (shell && shell.openPath) {
        shell.openPath(dirPath);
      } else {
        throw new Error('No electron shell');
      }
    } catch (_) {
      const { execFile } = require('child_process');
      if (process.platform === 'win32') {
        execFile('explorer.exe', [dirPath]);
      } else if (process.platform === 'darwin') {
        execFile('open', [dirPath]);
      } else {
        execFile('xdg-open', [dirPath]);
      }
    }
    utils.writeLog(`Opened shared directory: ${dirPath}`);
    res.json({ success: true, path: dirPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pending TTL expire check interval
const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (let i = state.pendingForPhone.length - 1; i >= 0; i--) {
    const item = state.pendingForPhone[i];
    const itemTime = new Date(item.timestamp).getTime();
    if (now - itemTime > PENDING_TTL_MS) {
      const [removed] = state.pendingForPhone.splice(i, 1);
      cleanupOutgoingFile(removed);
      utils.broadcastSSE('phone-ack', removed);
      logger.debug('Expired pending item', { id: removed.id, type: removed.type });
      changed = true;
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// SSE heartbeats
setInterval(() => {
  const deadClients = [];
  for (const client of state.sseClients) {
    try {
      client.write(': heartbeat\n\n');
    } catch {
      deadClients.push(client);
    }
  }
  deadClients.forEach(c => state.sseClients.delete(c));
}, 30000);

module.exports = router;
