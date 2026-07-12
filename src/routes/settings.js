const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const multer = require('multer');
const state = require('../state');
const utils = require('../utils');

let appVersion = '5.1.0';
try {
  const pkg = require('../../package.json');
  appVersion = pkg.version || '5.1.0';
} catch (e) {
  try {
    const pkg = require('../package.json');
    appVersion = pkg.version || '5.1.0';
  } catch {}
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, state.SAVE_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    const base = path.basename(file.originalname, ext);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let cleanBase = base.replace(/[\\/:*?"<>|]/g, '_');
    if (cleanBase.length > 15) {
      cleanBase = cleanBase.slice(0, 15);
    }
    cleanBase = cleanBase.trim();
    cb(null, `${cleanBase || 'file'}_${timestamp}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB max
  fileFilter: (req, file, cb) => {
    cb(null, true);
  }
});

// GET /api/check-update — Query GitHub Releases API for updates
router.get('/check-update', (req, res) => {
  const https = require('https');
  const options = {
    hostname: 'api.github.com',
    path: '/repos/asepsayyad007/AiroDrop/releases/latest',
    headers: { 'User-Agent': 'AiroDrop-Server' }
  };

  https.get(options, (apiRes) => {
    let data = '';
    apiRes.on('data', (chunk) => { data += chunk; });
    apiRes.on('end', () => {
      try {
        if (apiRes.statusCode !== 200) {
          return res.status(apiRes.statusCode).json({ error: 'GitHub API returned status ' + apiRes.statusCode });
        }
        const release = JSON.parse(data);
        const latestVersion = release.tag_name.replace(/^v/, '');
        const currentVersion = require('../../package.json').version;

        res.json({
          current: currentVersion,
          latest: latestVersion,
          updateAvailable: latestVersion !== currentVersion,
          url: release.html_url
        });
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse GitHub response' });
      }
    });
  }).on('error', (err) => {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/info
router.get('/info', async (req, res) => {
  const ip = utils.getLocalIP();
  const protocol = state.HTTPS_ENABLED ? 'https' : 'http';
  const url = `${protocol}://${ip}:${state.PORT}`;
  const mobileUrl = `${url}/m`;
  const allIps = utils.getAllIPs();

  try {
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    res.json({
      ip,
      port: state.PORT,
      url,
      qrDataUrl,
      saveDir: state.SAVE_DIR,
      uptime: process.uptime(),
      deviceName: state.DEVICE_NAME,
      allIps,
      temporaryMode: state.TEMPORARY_MODE,
      pairingToken: ''
    });
  } catch {
    res.json({
      ip,
      port: state.PORT,
      url,
      qrDataUrl: null,
      saveDir: state.SAVE_DIR,
      uptime: process.uptime(),
      deviceName: state.DEVICE_NAME,
      allIps,
      temporaryMode: state.TEMPORARY_MODE,
      pairingToken: ''
    });
  }
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
    console.error('[QR] Failed to generate QR image stream:', err.message);
    res.status(500).send('Failed to generate QR code');
  }
});

// GET /api/qr-gen.png
router.get('/qr-gen.png', async (req, res) => {
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
    console.error('[QR-GEN] Failed to generate custom QR stream:', err.message);
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
    }

    if (deviceName !== undefined) {
      state.DEVICE_NAME = deviceName.trim() || os.hostname();
    }

    if (port !== undefined) {
      const parsedPort = parseInt(port, 10);
      if (parsedPort > 0 && parsedPort < 65536) {
        state.PORT = parsedPort;
      }
    }

    if (rateLimitEnabled !== undefined) {
      state.RATE_LIMIT_ENABLED = !!rateLimitEnabled;
    }

    if (autoOpenLinks !== undefined) {
      state.AUTO_OPEN_LINKS = !!autoOpenLinks;
    }

    if (notificationsEnabled !== undefined) {
      state.NOTIFICATIONS_ENABLED = !!notificationsEnabled;
    }

    if (temporaryModeHours !== undefined) {
      state.TEMPORARY_MODE_HOURS = parseFloat(temporaryModeHours) || 2;
    }

    if (launchOnStartup !== undefined) {
      state.LAUNCH_ON_STARTUP = !!launchOnStartup;
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
      state.AUTO_UPDATE = !!autoUpdate;
    }

    if (httpsEnabled !== undefined) {
      state.HTTPS_ENABLED = !!httpsEnabled;
    }

    if (contextMenuEnabled !== undefined) {
      const oldVal = state.CONTEXT_MENU_ENABLED;
      state.CONTEXT_MENU_ENABLED = !!contextMenuEnabled;
      if (state.CONTEXT_MENU_ENABLED !== oldVal) {
        utils.updateWindowsContextMenu(state.CONTEXT_MENU_ENABLED);
      }
    }

    const oldTempMode = state.TEMPORARY_MODE;
    if (temporaryMode !== undefined) {
      state.TEMPORARY_MODE = !!temporaryMode;
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
      contextMenuEnabled: state.CONTEXT_MENU_ENABLED
    }, null, 2));

    utils.writeLog(`Configurations updated: SaveFolder="${state.SAVE_DIR}", Port=${state.PORT}, DeviceName="${state.DEVICE_NAME}"`);
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
      contextMenuEnabled: state.CONTEXT_MENU_ENABLED
    });
  } catch (err) {
    console.error('[CONFIG] Failed to update settings:', err.message);
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
        console.log('[BROWSE] Picker closed or canceled:', error.message || stderr);
        return res.json({ success: false, message: 'Canceled' });
      }
      const selectedPath = stdout.trim();
      if (!selectedPath) {
        return res.json({ success: false, message: 'Canceled' });
      }
      res.json({ success: true, path: selectedPath });
    });
  } catch (err) {
    console.error('[BROWSE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send-to-phone
router.post('/send-to-phone', upload.single('file'), async (req, res) => {
  try {
    if (req.file) {
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'file',
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
        timestamp: new Date().toISOString()
      };
      state.pendingForPhone.unshift(item);
      if (state.pendingForPhone.length > 50) state.pendingForPhone.pop();
      utils.broadcastSSE('phone-queued', item);
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
      if (state.pendingForPhone.length > 50) state.pendingForPhone.pop();
      utils.broadcastSSE('phone-queued', item);
      
      // Auto-copy to PC system clipboard
      try {
        const { copyText } = require('../../clipboard');
        await copyText(text);
      } catch (err) {
        console.error('Failed to copy sent text to PC clipboard:', err.message);
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
      if (state.pendingForPhone.length > 50) state.pendingForPhone.pop();
      utils.broadcastSSE('phone-queued', item);
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
      const { exec } = require('child_process');
      exec(`start "" "${trimmed.replace(/"/g, '')}"`);
    }
    utils.writeLog(`Opened URL in browser: ${trimmed}`);
    res.json({ success: true });
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
      utils.broadcastSSE('phone-ack', removed);
      console.log(`[PENDING-TTL] Expired pending item: ${removed.id} (${removed.type})`);
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
