/**
 * server.js — Main Node.js server for iPhone → PC integration
 *
 * Endpoints:
 *   POST /api/text          — Receive text → copy to clipboard
 *   POST /api/image         — Receive image → save to disk
 *   GET  /api/history       — Fetch received items (recent 100)
 *   GET  /api/info          — Server IP, port, QR code data
 *   POST /api/send-to-phone — Queue text/image to be picked up by iPhone (two-way)
 *   GET  /api/pending       — iPhone polls for pending items (two-way)
 *   GET  /api/events        — SSE stream for real-time dashboard updates
 *   POST /api/send          — UNIFIED: auto-detect text vs image (for simple shortcuts)
 *   GET  /                  — Serve web dashboard
 *   GET  /m                 — Mobile setup & sender page
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const koffi = require('koffi');
const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto');
const serverEvents = new EventEmitter();
const app = express();


// ─── Win32 FFI Initialization for Trackpad ──────────────────
let user32 = null;
let POINT = null;
let GetCursorPos = null;
let SetCursorPos = null;
let mouse_event = null;
let keybd_event = null;
let GetSystemMetrics = null;

if (os.platform() === 'win32') {
  try {
    user32 = koffi.load('user32.dll');
    POINT = koffi.struct('POINT', {
      x: 'long',
      y: 'long'
    });
    GetCursorPos = user32.func('int GetCursorPos(POINT* lpPoint)');
    SetCursorPos = user32.func('int SetCursorPos(int X, int Y)');
    mouse_event = user32.func('void mouse_event(uint dwFlags, int dx, int dy, uint dwData, uintptr_t dwExtraInfo)');
    keybd_event = user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint dwFlags, uintptr_t dwExtraInfo)');
    GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)');
  } catch (err) {
    console.error('[FFI] Failed to load user32.dll:', err.message);
  }
}

function getVKCode(char) {
  const c = char.toUpperCase();
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0);
  if (c >= '0' && c <= '9') return c.charCodeAt(0);
  if (c === ' ') return 0x20;
  
  const map = {
    '\n': 0x0D, '\r': 0x0D, '\t': 0x09,
    ';': 0xBA, '=': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF, '`': 0xC0,
    '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE
  };
  return map[char] || null;
}

function sendKeystroke(charOrCode) {
  if (!keybd_event) return;
  if (typeof charOrCode === 'number') {
    keybd_event(charOrCode, 0, 0, 0);
    keybd_event(charOrCode, 0, 0x0002, 0);
  } else if (typeof charOrCode === 'string') {
    if (charOrCode.length === 1) {
      const code = getVKCode(charOrCode);
      if (code) {
        const needsShift = charOrCode.match(/[A-Z!@#$%^&*()_+{}|:"<>?]/);
        if (needsShift) {
          keybd_event(0x10, 0, 0, 0);
        }
        keybd_event(code, 0, 0, 0);
        keybd_event(code, 0, 0x0002, 0);
        if (needsShift) {
          keybd_event(0x10, 0, 0x0002, 0);
        }
      }
    } else {
      const { exec } = require('child_process');
      const escaped = charOrCode.replace(/'/g, "''").replace(/([{}()+^%~[\]])/g, '{$1}');
      exec(`powershell -NoProfile -Command "[System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`);
    }
  }
}
const QRCode = require('qrcode');
const { copyText, copyImage } = require('./clipboard');
const notifier = require('./notify');
function notifyText(text) {
  if (NOTIFICATIONS_ENABLED) notifier.notifyText(text);
}
function notifyImage(filename) {
  if (NOTIFICATIONS_ENABLED) notifier.notifyImage(filename);
}

let CONFIG_FILE;
let HISTORY_FILE;
let SCRATCHPAD_FILE;
let PORT = 3478;
let SAVE_DIR;
let SHARE_DIR;
let TEMPORARY_MODE = false;
let DEVICE_NAME = os.hostname();
let RATE_LIMIT_ENABLED = true;
let NOTIFICATIONS_ENABLED = true;
let TEMPORARY_MODE_HOURS = 2;
let AUTO_OPEN_LINKS = false;
let LAUNCH_ON_STARTUP = false;
let AUTO_UPDATE = true;

// ─── Security Configuration ──────────────────────────────────────
let privacyPause = false; // PC Screencast pause state

// ─── Initialize Paths ──────────────────────────────────────────
function init(userDataPath) {
  CONFIG_FILE = path.join(userDataPath, 'config.json');
  HISTORY_FILE = path.join(userDataPath, 'history.json');
  SCRATCHPAD_FILE = path.join(userDataPath, 'scratchpad.txt');
  SAVE_DIR = path.join(userDataPath, 'received');
  SHARE_DIR = path.join(userDataPath, 'shared');
  
  loadConfig();
  
  // Apply startup registry setting inside Electron on init
  try {
    const electron = require('electron');
    if (electron && electron.app) {
      electron.app.setLoginItemSettings({
        openAtLogin: LAUNCH_ON_STARTUP,
        path: process.execPath
      });
    }
  } catch (_) {}

  loadHistory();
  loadScratchpad();
  initFileBrowser();
}

// Load settings from config.json
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data.port) PORT = parseInt(data.port, 10) || 3478;
      TEMPORARY_MODE = !!data.temporaryMode;
      if (data.deviceName) DEVICE_NAME = data.deviceName;
      if (data.rateLimitEnabled !== undefined) RATE_LIMIT_ENABLED = !!data.rateLimitEnabled;
      if (data.notificationsEnabled !== undefined) NOTIFICATIONS_ENABLED = !!data.notificationsEnabled;
      if (data.temporaryModeHours !== undefined) TEMPORARY_MODE_HOURS = parseFloat(data.temporaryModeHours) || 2;
      if (data.autoOpenLinks !== undefined) AUTO_OPEN_LINKS = !!data.autoOpenLinks;
      if (data.launchOnStartup !== undefined) LAUNCH_ON_STARTUP = !!data.launchOnStartup;
      if (data.autoUpdate !== undefined) AUTO_UPDATE = !!data.autoUpdate;
      if (data.saveDir) {
        // If relative, resolve against project directory
        SAVE_DIR = path.isAbsolute(data.saveDir) 
          ? data.saveDir 
          : path.resolve(__dirname, data.saveDir);
      }
      if (data.shareDir) {
        SHARE_DIR = path.isAbsolute(data.shareDir) 
          ? data.shareDir 
          : path.resolve(__dirname, data.shareDir);
      } else {
        SHARE_DIR = SAVE_DIR;
      }

    }
  } catch (err) {
    console.error('[CONFIG] Failed to load config.json:', err.message);
  }

  // Ensure directories exist
  try {
    if (!fs.existsSync(SAVE_DIR)) {
      fs.mkdirSync(SAVE_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[CONFIG] Failed to create save directory, falling back to local received folder:', err.message);
    SAVE_DIR = path.join(__dirname, 'received');
    if (!fs.existsSync(SAVE_DIR)) {
      fs.mkdirSync(SAVE_DIR, { recursive: true });
    }
  }

  try {
    if (!fs.existsSync(SHARE_DIR)) {
      fs.mkdirSync(SHARE_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[CONFIG] Failed to create share directory, falling back to SAVE_DIR:', err.message);
    SHARE_DIR = SAVE_DIR;
  }
}

function saveConfig() {
  try {
    let data = {};
    if (fs.existsSync(CONFIG_FILE)) {
      data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    data.port = PORT;
    data.temporaryMode = TEMPORARY_MODE;
    data.deviceName = DEVICE_NAME;
    data.rateLimitEnabled = RATE_LIMIT_ENABLED;
    data.notificationsEnabled = NOTIFICATIONS_ENABLED;
    data.temporaryModeHours = TEMPORARY_MODE_HOURS;
    data.autoOpenLinks = AUTO_OPEN_LINKS;
    data.launchOnStartup = LAUNCH_ON_STARTUP;
    data.autoUpdate = AUTO_UPDATE;
    data.saveDir = SAVE_DIR;
    data.shareDir = SHARE_DIR;
    
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[CONFIG] Failed to save config.json:', err.message);
  }
}

// Initial config load is now deferred to init()

function setSaveDir(newDir) {
  SAVE_DIR = newDir;
  try {
    let data = {};
    if (fs.existsSync(CONFIG_FILE)) {
      data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    data.saveDir = SAVE_DIR;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[CONFIG] Failed to save config.json:', err.message);
  }
}

const MAX_HISTORY = 100;

// ─── In-Memory Stores ──────────────────────────────────────────
const history = [];          // Received items (from iPhone)
let scratchpadText = '';     // Shared scratchpad text
let bookmarks = [];          // Shared links/bookmarks

function loadHistory() {
  if (TEMPORARY_MODE) {
    history.length = 0;
    return;
  }
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      history.length = 0;
      history.push(...(Array.isArray(data) ? data : []));
    }
  } catch (err) {
    console.error('[HISTORY] Failed to load history:', err.message);
  }
}

function loadScratchpad() {
  try {
    if (fs.existsSync(SCRATCHPAD_FILE)) {
      scratchpadText = fs.readFileSync(SCRATCHPAD_FILE, 'utf8');
    }
  } catch (err) {
    console.error('[SCRATCHPAD] Failed to load scratchpad:', err.message);
  }
}

function saveScratchpad() {
  try {
    fs.writeFileSync(SCRATCHPAD_FILE, scratchpadText || "", 'utf8');
  } catch (err) {
    console.error('[SCRATCHPAD] Failed to save scratchpad:', err.message);
  }
}

// ─── HTTP File Browser Init ────────────────────────────────────
function initFileBrowser() {
  console.log('[FILES] HTTP File Browser initialized. Shared dir:', SHARE_DIR);
}

// ─── Helper: safe path inside SHARE_DIR ───────────────────────
function safePath(relPath) {
  const resolved = path.resolve(SHARE_DIR, relPath || '');
  // Security: must stay inside SHARE_DIR
  if (!resolved.startsWith(path.resolve(SHARE_DIR))) {
    return null;
  }
  return resolved;
}

// ─── Express App ───────────────────────────────────────────────

app.get('/files', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'files.html'));
});

// JSON directory listing
app.get('/files/browse', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const rel = req.query.path || '';
  const target = safePath(rel);
  if (!target) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true }).map(e => {
      const fullPath = path.join(target, e.name);
      let size = 0;
      let mtime = null;
      try {
        const stat = fs.statSync(fullPath);
        size = stat.size;
        mtime = stat.mtime.toISOString();
      } catch (_) {}
      return {
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size,
        mtime
      };
    }).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: rel, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download a file
app.get('/files/download', (req, res) => {
  const rel = req.query.path || '';
  const target = safePath(rel);
  if (!target) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot download a folder' });
  
  const isStream = req.query.stream === 'true';
  const range = req.headers.range;

  if (isStream) {
    // Dynamically set Content-Type based on video file extensions for hardware accelerated streams
    const ext = path.extname(target).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.ogg': 'video/ogg',
      '.mov': 'video/quicktime',
      '.m4v': 'video/x-m4v',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo'
    };
    const contentType = mimeTypes[ext] || 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;
      
      const fileStream = fs.createReadStream(target, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Content-Disposition': 'inline'
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Content-Disposition': 'inline'
      });
      fs.createReadStream(target).pipe(res);
    }
  } else {
    // Normal file download
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(target))}"`);
    res.sendFile(target, { acceptRanges: true });
  }
});

// Upload chunk for pause/resume/cancel support
app.post('/files/upload-chunk', (req, res) => {
  const relPath = req.query.path || '';
  const fileName = path.basename(req.query.name || '');
  const chunkIndex = parseInt(req.query.index, 10);
  const totalChunks = parseInt(req.query.total, 10);
  
  if (!fileName) return res.status(400).json({ error: 'Missing file name' });
  
  const targetDir = safePath(relPath);
  if (!targetDir) return res.status(403).json({ error: 'Access denied' });
  
  const finalPath = path.join(targetDir, fileName);
  const chunkPath = finalPath + '.part.' + chunkIndex;
  
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    
    // Write chunk to its own dedicated temp file to prevent locking issues on Windows
    const writeStream = fs.createWriteStream(chunkPath);
    req.pipe(writeStream);
    
    writeStream.on('finish', async () => {
      if (res.headersSent) return;
      try {
        if (chunkIndex === totalChunks - 1) {
          // Last chunk received, let's merge all chunks into the final file
          try {
            if (fs.existsSync(finalPath)) {
              fs.unlinkSync(finalPath);
            }
            
            const mergeWriteStream = fs.createWriteStream(finalPath);
            
            for (let i = 0; i < totalChunks; i++) {
              const cp = finalPath + '.part.' + i;
              if (!fs.existsSync(cp)) {
                throw new Error(`Missing chunk file: ${cp}`);
              }
              await new Promise((resolve, reject) => {
                const readStream = fs.createReadStream(cp);
                readStream.pipe(mergeWriteStream, { end: false });
                readStream.on('end', () => {
                  try { fs.unlinkSync(cp); } catch (_) {}
                  resolve();
                });
                readStream.on('error', reject);
              });
            }
            
            mergeWriteStream.end();
            await new Promise((resolve, reject) => {
              mergeWriteStream.on('finish', resolve);
              mergeWriteStream.on('error', reject);
            });
            
            return res.json({ success: true, completed: true, filename: fileName });
          } catch (mergeErr) {
            console.error('[UPLOAD] Merge error:', mergeErr.message);
            // Clean up all chunk parts
            try {
              const files = fs.readdirSync(targetDir);
              for (const file of files) {
                if (file.startsWith(fileName + '.part')) {
                  try { fs.unlinkSync(path.join(targetDir, file)); } catch (_) {}
                }
              }
            } catch (_) {}
            if (!res.headersSent) {
              return res.status(500).json({ error: 'Merge failed: ' + mergeErr.message });
            }
          }
        } else {
          return res.json({ success: true, completed: false });
        }
      } catch (err) {
        console.error('[UPLOAD] Error finalizing chunk upload:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        }
      }
    });
    
    writeStream.on('error', (err) => {
      console.error('[UPLOAD] Chunk write stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel chunk upload and clean up temporary file
app.post('/files/upload-cancel', express.json(), (req, res) => {
  const relPath = req.body.path || '';
  const fileName = path.basename(req.body.name || '');
  if (!fileName) return res.status(400).json({ error: 'Missing file name' });
  
  const targetDir = safePath(relPath);
  if (targetDir) {
    try {
      const files = fs.readdirSync(targetDir);
      for (const file of files) {
        if (file.startsWith(fileName + '.part')) {
          try { fs.unlinkSync(path.join(targetDir, file)); } catch (_) {}
        }
      }
    } catch (_) {}
  }
  res.json({ success: true });
});


// Upload files to a folder
const uploadToShare = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const rel = req.query.path || '';
      const target = safePath(rel);
      if (!target) return cb(new Error('Access denied'));
      fs.mkdirSync(target, { recursive: true });
      cb(null, target);
    },
    filename: (req, file, cb) => {
      // Decode original filename from UTF-8
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      cb(null, name);
    }
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4 GB max
});

app.post('/files/upload', (req, res) => {
  uploadToShare.array('files')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    const uploaded = (req.files || []).map(f => f.filename);
    res.json({ success: true, uploaded });
  });
});

// Create folder
app.post('/files/mkdir', express.json(), (req, res) => {
  const rel = req.body.path || '';
  const target = safePath(rel);
  if (!target) return res.status(403).json({ error: 'Access denied' });
  try {
    fs.mkdirSync(target, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file or folder
app.delete('/files/delete', express.json(), (req, res) => {
  const rel = req.body.path || '';
  const target = safePath(rel);
  if (!target) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename
app.patch('/files/rename', express.json(), (req, res) => {
  const rel = req.body.path || '';
  const newName = req.body.newName || '';
  const target = safePath(rel);
  if (!target || !newName) return res.status(400).json({ error: 'Invalid request' });
  const dir = path.dirname(target);
  const dest = path.join(dir, newName);
  if (!dest.startsWith(path.resolve(SHARE_DIR))) return res.status(403).json({ error: 'Access denied' });
  try {
    fs.renameSync(target, dest);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debounce timer for async history writes
let _saveHistoryTimer = null;

function saveHistory() {
  if (TEMPORARY_MODE) {
    try {
      if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
    } catch {}
    return;
  }
  // Debounce: coalesce rapid writes into one write 500ms after last call
  if (_saveHistoryTimer) clearTimeout(_saveHistoryTimer);
  _saveHistoryTimer = setTimeout(() => {
    const payload = JSON.stringify(history, null, 2);
    fs.writeFile(HISTORY_FILE, payload, 'utf8', (err) => {
      if (err) console.error('[HISTORY] Failed to save history:', err.message);
    });
  }, 500);
}

// Load initial history is now deferred to init()
const pendingForPhone = [];  // Items queued for iPhone to pick up
const sseClients = new Set(); // SSE connected clients

// ─── Logging System ───────────────────────────────────────────
const logHistory = [];
const MAX_LOGS = 500;

function writeLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const fullLog = `[${timestamp}] ${message}`;
  console.log(fullLog);
  logHistory.push(fullLog);
  if (logHistory.length > MAX_LOGS) {
    logHistory.shift();
  }
  broadcastSSE('log', { timestamp, message });
}

// ─── Pending TTL Cleanup (30 min auto-expire) ──────────────────
const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (let i = pendingForPhone.length - 1; i >= 0; i--) {
    const item = pendingForPhone[i];
    if (now - new Date(item.timestamp).getTime() > PENDING_TTL_MS) {
      const [removed] = pendingForPhone.splice(i, 1);
      broadcastSSE('phone-ack', removed);
      console.log(`[PENDING-TTL] Expired pending item: ${removed.id} (${removed.type})`);
      changed = true;
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// ─── Simple Rate Limiter ───────────────────────────────────────
const rateLimitMap = new Map();
const RATE_WINDOW = 60000;  // 1 minute
const RATE_MAX = 60;        // 60 requests per minute per IP

function rateLimit(req, res, next) {
  if (!RATE_LIMIT_ENABLED) return next();

  const cleanPath = req.path.toLowerCase();
  if (
    cleanPath === '/api/events' ||
    cleanPath === '/' ||
    cleanPath === '/m' ||
    cleanPath === '/style.css' ||
    cleanPath === '/app.js' ||
    cleanPath === '/manifest.json' ||
    cleanPath === '/sw.js' ||
    cleanPath === '/favicon.ico' ||
    cleanPath.startsWith('/vendor/') ||
    cleanPath.startsWith('/received/') ||
    cleanPath.startsWith('/files')
  ) {
    return next();
  }

  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };

  if (now - entry.start > RATE_WINDOW) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;

  if (entry.count > RATE_MAX) {
    return res.status(429).json({ error: 'Too many requests. Slow down.' });
  }

  rateLimitMap.set(ip, entry);
  next();
}

// ─── Multer (file upload) ──────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, SAVE_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
    cb(null, `${timestamp}_${safeName || 'file'}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (req, file, cb) => {
    cb(null, true); // Allow all file types (images, PDF, MP3, etc.)
  }
});

// ─── Express App ───────────────────────────────────────────────
app.use(rateLimit);

// Dynamic Content-Type body parsers (prevents stream consumption conflicts with Multer)
const jsonParser = express.json({ limit: '10mb' });
const urlencodedParser = express.urlencoded({ extended: true, limit: '10mb' });
const rawParser = express.raw({ type: '*/*', limit: '50mb' });

app.use((req, res, next) => {
  // Skip global body parsing for chunked uploads so route can pipe stream directly
  if (req.path === '/files/upload-chunk') {
    return next();
  }
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    next();
  } else if (contentType.includes('application/json')) {
    jsonParser(req, res, next);
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    urlencodedParser(req, res, next);
  } else {
    rawParser(req, res, next);
  }
});

// CORS — allow all local network access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ─── Authentication Middleware ─────────────────────────────────
app.use((req, res, next) => {
  // Device pairing disabled - allow all devices directly
  req.isLocalhost = true;
  req.deviceToken = 'public-device';
  req.device = { name: 'Mobile Device', ipAddress: req.ip || req.connection.remoteAddress };
  return next();
});

// ─── Screencast Pause Endpoint ──────────────────────────────────
app.post('/api/screencast/pause', express.json(), (req, res) => {
  if (!req.isLocalhost) {
    return res.status(403).json({ error: 'Only localhost can pause screencast' });
  }
  
  privacyPause = req.body.pause;
  if (wss) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'privacy_pause', pause: privacyPause }));
      }
    });
  }
  writeLog(`Privacy Pause: ${privacyPause ? 'ON' : 'OFF'}`);
  res.json({ success: true, pause: privacyPause });
});

// ─── Helper: Get Local IP ──────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  
  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    
    if (lowerName.includes('virtualbox') || 
        lowerName.includes('docker') || 
        lowerName.includes('wsl') || 
        lowerName.includes('vmnet') || 
        lowerName.includes('vpn') || 
        lowerName.includes('host-only') ||
        lowerName.includes('vethernet') ||
        lowerName.includes('loopback')) {
      continue;
    }
    
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        let priority = 0;
        if (lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('wlan')) {
          priority = 3;
        } else if (lowerName.includes('ethernet') || lowerName.includes('eth')) {
          priority = 2;
        } else if (lowerName.startsWith('en') || lowerName.startsWith('wl')) {
          priority = 1;
        }
        candidates.push({ address: iface.address, priority });
      }
    }
  }
  
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates[0].address;
  }
  
  return '127.0.0.1';
}

function getAllIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('loopback')) continue;
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

// ─── Helper: Broadcast to SSE Clients ──────────────────────────
function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ─── Helper: Add to history ────────────────────────────────────
function addToHistory(item) {
  history.unshift(item);
  if (history.length > MAX_HISTORY) {
    const popped = history.pop();
    // If popped item had a saved file, let's delete it to save space (since we reached max history!)
    if (popped && popped.filename) {
      const fullPath = path.isAbsolute(popped.path) ? popped.path : path.resolve(__dirname, popped.path);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch {}
    }
  }
  saveHistory();
  broadcastSSE('new-item', item);
}

// ─── Auto-Delete Temporary Items (older than configured hours) ──────────
setInterval(() => {
  if (!TEMPORARY_MODE) return;
  const now = Date.now();
  const cleanupMs = TEMPORARY_MODE_HOURS * 60 * 60 * 1000;
  
  let changed = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const itemTime = new Date(item.timestamp).getTime();
    if (now - itemTime > cleanupMs) {
      if (item.filename) {
        const fullPath = path.isAbsolute(item.path) ? item.path : path.resolve(__dirname, item.path);
        try {
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            console.log(`[TEMP] Auto-deleted expired file: ${item.filename}`);
          }
        } catch (e) {
          console.error(`[TEMP] Failed to delete expired file: ${item.filename}`, e.message);
        }
      }
      history.splice(i, 1);
      changed = true;
    }
  }
  if (changed) {
    saveHistory();
    broadcastSSE('history-update', history);
  }
}, 60000); // Run check every minute

/**
 * Detect image format from magic bytes/file signature
 * Returns mimetype string (e.g. 'image/png') if matched, otherwise null
 */
function isBufferImage(buf) {
  if (!buf || buf.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 ("GIF")
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return 'image/gif';
  }
  // WEBP: RIFF + WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12) {
    const riffType = buf.toString('ascii', 8, 12);
    if (riffType === 'WEBP') return 'image/webp';
  }
  // BMP: 42 4D ("BM")
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'image/bmp';
  }
  return null;
}

/**
 * Try to extract a clean webpage URL from an uploaded HTML/webpage file
 */
async function tryExtractUrlFromHtmlFile(savedPath, mimeType) {
  if (!savedPath || !fs.existsSync(savedPath)) return null;
  try {
    const ext = path.extname(savedPath).toLowerCase();
    const isWebarchive = ext === '.webarchive';
    const isHtmlExt = ext === '.html' || ext === '.htm' || (mimeType && mimeType.includes('html'));
    
    // Read file content
    const content = fs.readFileSync(savedPath, 'utf8');
    const trimmed = content.trim();
    const isHtmlContent = trimmed.startsWith('<') || 
                          trimmed.toLowerCase().startsWith('<!doctype') || 
                          trimmed.toLowerCase().includes('<html') ||
                          isWebarchive;

    if (isHtmlContent || isHtmlExt) {
      const canonicalMatch = content.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
                             content.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
      const ogMatch = content.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) ||
                      content.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
      const twitterMatch = content.match(/<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/i);
      
      let extractedUrl = (canonicalMatch && canonicalMatch[1]) || (ogMatch && ogMatch[1]) || (twitterMatch && twitterMatch[1]);
      
      if (!extractedUrl) {
        // Fallback: search for absolute HTTP URL links that are not static assets or namespace schemas
        const allUrls = content.match(/https?:\/\/[^\s"'<>\(\)]+/gi);
        if (allUrls) {
          const cleanUrl = allUrls.find(u => {
            const low = u.toLowerCase();
            return !low.endsWith('.js') && 
                   !low.endsWith('.css') && 
                   !low.endsWith('.png') && 
                   !low.endsWith('.jpg') && 
                   !low.endsWith('.jpeg') && 
                   !low.endsWith('.gif') && 
                   !low.endsWith('.svg') && 
                   !low.endsWith('.woff') && 
                   !low.endsWith('.woff2') &&
                   !low.includes('schema.org') &&
                   !low.includes('w3.org');
          });
          if (cleanUrl) {
            extractedUrl = cleanUrl;
          }
        }
      }

      if (extractedUrl) {
        // Clean up the file
        try { fs.unlinkSync(savedPath); } catch {}
        return extractedUrl;
      }
    }
  } catch (err) {
    console.error('[URL-EXTRACT] Error parsing HTML file:', err.message);
  }
  return null;
}

async function handleIncomingText(text) {
  const clipResult = await copyText(text);
  const trimmed = text.trim();
  
  if (AUTO_OPEN_LINKS && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
    try {
      const { shell } = require('electron');
      shell.openExternal(trimmed);
      console.log(`[CAST] Auto-opened URL in Electron: ${trimmed}`);
    } catch {
      const { exec } = require('child_process');
      exec(`start "" "${trimmed}"`);
      console.log(`[CAST] Auto-opened URL via Win32 shell: ${trimmed}`);
    }
  }
  return clipResult;
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/text — Receive text from iPhone
app.post('/api/text', async (req, res) => {
  try {
    let text = '';
    if (typeof req.body === 'string') {
      const trimmed = req.body.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed);
          text = parsed.text || parsed.content || req.body;
        } catch {
          text = req.body;
        }
      } else {
        text = req.body;
      }
    } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      text = req.body.toString('utf8');
      const trimmed = text.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed);
          text = parsed.text || parsed.content || text;
        } catch {}
      }
    } else if (req.body && typeof req.body === 'object') {
      text = req.body.text || req.body.content || '';
    }

    if (!text || (typeof text === 'string' && text.trim().length === 0)) {
      return res.status(400).json({ error: 'No text provided' });
    }

    // HTML Web Page detection & URL extraction
    if (typeof text === 'string' && (text.trim().startsWith('<') || text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().includes('<html'))) {
      const canonicalMatch = text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
                             text.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
      const ogMatch = text.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) ||
                      text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
      const twitterMatch = text.match(/<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/i);
      
      let extractedUrl = (canonicalMatch && canonicalMatch[1]) || (ogMatch && ogMatch[1]) || (twitterMatch && twitterMatch[1]);
      if (!extractedUrl) {
        // Fallback: search for absolute HTTP URL links that are not static assets or namespace schemas
        const allUrls = text.match(/https?:\/\/[^\s"'<>\(\)]+/gi);
        if (allUrls) {
          const cleanUrl = allUrls.find(u => {
            const low = u.toLowerCase();
            return !low.endsWith('.js') && 
                   !low.endsWith('.css') && 
                   !low.endsWith('.png') && 
                   !low.endsWith('.jpg') && 
                   !low.endsWith('.jpeg') && 
                   !low.endsWith('.gif') && 
                   !low.endsWith('.svg') && 
                   !low.endsWith('.woff') && 
                   !low.endsWith('.woff2') &&
                   !low.includes('schema.org') &&
                   !low.includes('w3.org');
          });
          if (cleanUrl) {
            extractedUrl = cleanUrl;
          }
        }
      }
      if (extractedUrl) {
        text = extractedUrl;
      }
    }

    // Copy to clipboard
    const clipResult = await handleIncomingText(text);

    // Add to history
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: 'text',
      content: text,
      preview: text.length > 200 ? text.substring(0, 200) + '...' : text,
      timestamp: new Date().toISOString(),
      clipboardSuccess: clipResult.success
    };
    addToHistory(item);

    // Show notification
    notifyText(text);

    console.log(`[TEXT] ${text.substring(0, 60)}${text.length > 60 ? '...' : ''}`);
    res.json({ success: true, id: item.id, message: 'Text received and copied to clipboard' });
  } catch (err) {
    console.error('[TEXT] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/image & POST /api/file — Receive image or generic file from iPhone
app.post(['/api/image', '/api/file'], upload.fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]), async (req, res) => {
  try {
    let savedPath;
    let filename;
    let originalName;
    let fileSize;
    let mimeType;

    let fileObj = null;
    if (req.files) {
      fileObj = (req.files['image'] && req.files['image'][0]) || (req.files['file'] && req.files['file'][0]);
    }

    if (fileObj) {
      savedPath = fileObj.path;
      filename = fileObj.filename;
      originalName = fileObj.originalname;
      fileSize = fileObj.size;
      mimeType = fileObj.mimetype;
    } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      const contentType = req.headers['content-type'] || 'application/octet-stream';
      const cleanType = contentType.split(';')[0];
      const detectedMime = isBufferImage(req.body) || cleanType;
      
      let ext = '.bin';
      if (detectedMime && detectedMime.includes('/')) {
        ext = '.' + detectedMime.split('/')[1].replace('jpeg', 'jpg').replace('mpeg', 'mp3');
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      filename = `${timestamp}_uploaded${ext}`;
      savedPath = path.join(SAVE_DIR, filename);
      originalName = filename;
      fileSize = req.body.length;
      mimeType = detectedMime;

      fs.writeFileSync(savedPath, req.body);
    } else {
      return res.status(400).json({ error: 'No file or binary buffer provided.' });
    }

    // Check if the uploaded file is actually a webpage/HTML file to extract its URL
    const extractedUrl = await tryExtractUrlFromHtmlFile(savedPath, mimeType);
    if (extractedUrl) {
      const clipRes = await copyText(extractedUrl);
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'text',
        content: extractedUrl,
        preview: extractedUrl,
        timestamp: new Date().toISOString(),
        clipboardSuccess: clipRes.success
      };
      addToHistory(item);
      notifyText(extractedUrl);
      console.log(`[FILE/URL-EXTRACT] Extracted URL from uploaded file: ${extractedUrl}`);
      return res.json({
        success: true,
        id: item.id,
        type: 'text',
        message: 'URL link extracted and copied to clipboard'
      });
    }

    const relativePath = path.relative(__dirname, savedPath);
    
    // Only copy to clipboard if it is an image
    const isImg = isBufferImage(req.body) || (mimeType && mimeType.startsWith('image/'));
    let clipResult = { success: false, error: 'Not an image' };
    if (isImg) {
      clipResult = await copyImage(savedPath);
    }

    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: isImg ? 'image' : 'file',
      filename: filename,
      originalName: originalName,
      path: relativePath,
      size: fileSize,
      mimetype: mimeType,
      timestamp: new Date().toISOString(),
      clipboardSuccess: isImg ? clipResult.success : false
    };
    addToHistory(item);

    // Show notification
    if (isImg) {
      notifyImage(filename);
    } else {
      notifyText(`Received File: ${originalName}`);
    }

    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    console.log(`[FILE] ${filename} (${sizeMB} MB)`);
    res.json({
      success: true,
      id: item.id,
      filename: filename,
      path: relativePath,
      type: isImg ? 'image' : 'file',
      message: isImg ? 'Image saved successfully' : 'File saved successfully'
    });
  } catch (err) {
    console.error('[FILE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history — Return received items list
app.get('/api/history', (req, res) => {
  let changed = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.type === 'image' || item.type === 'file') {
      const fullPath = item.filename 
        ? path.join(SAVE_DIR, item.filename) 
        : (path.isAbsolute(item.path) ? item.path : path.resolve(__dirname, item.path));
      if (!fs.existsSync(fullPath)) {
        console.log(`[HISTORY-CLEANUP] File no longer exists on disk, removing from list: ${item.filename || item.id}`);
        history.splice(i, 1);
        changed = true;
      }
    }
  }
  if (changed) {
    saveHistory();
  }

  const since = req.query.since;
  let items = history;
  if (since) {
    items = history.filter(item => item.timestamp > since);
  }
  res.json({ items, total: history.length });
});

// DELETE /api/history — Delete all history items and unlink associated files
app.delete('/api/history', (req, res) => {
  try {
    for (const item of history) {
      if (item.filename) {
        const fullPath = item.filename 
          ? path.join(SAVE_DIR, item.filename) 
          : (path.isAbsolute(item.path) ? item.path : path.resolve(__dirname, item.path));
        try {
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        } catch (e) {
          console.error(`[DELETE-ALL] Failed to delete file: ${item.filename}`, e.message);
        }
      }
    }
    history.length = 0;
    saveHistory();
    broadcastSSE('clear', {});
    res.json({ success: true, message: 'All history and files cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scratchpad — Fetch current scratchpad text
app.get('/api/scratchpad', (req, res) => {
  res.json({ text: scratchpadText });
});

// POST /api/scratchpad — Save current scratchpad text and broadcast
app.post('/api/scratchpad', (req, res) => {
  scratchpadText = req.body.text || "";
  saveScratchpad();
  broadcastSSE('scratchpad', { text: scratchpadText });
  res.json({ success: true, text: scratchpadText });
});

// POST /api/control — Simulates media keys or locks workstation
app.post('/api/control', (req, res) => {
  const { action } = req.body;
  const { exec } = require('child_process');
  
  let cmd = '';
  switch (action) {
    case 'lock':
      cmd = 'rundll32.exe user32.dll,LockWorkStation';
      break;
    case 'sleep':
      cmd = 'powershell -Command "Add-Type -Assembly System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState(\'Suspend\', $false, $false)"';
      break;
    case 'poweroff':
      cmd = 'shutdown /s /f /t 0';
      break;
    case 'volume_up':
      cmd = 'powershell -Command "$wsh = New-Object -ComObject Wscript.Shell; $wsh.SendKeys([char]175)"';
      break;
    case 'volume_down':
      cmd = 'powershell -Command "$wsh = New-Object -ComObject Wscript.Shell; $wsh.SendKeys([char]174)"';
      break;
    case 'play_pause':
      cmd = 'powershell -Command "$wsh = New-Object -ComObject Wscript.Shell; $wsh.SendKeys([char]179)"';
      break;
    case 'next':
      cmd = 'powershell -Command "$wsh = New-Object -ComObject Wscript.Shell; $wsh.SendKeys([char]176)"';
      break;
    case 'prev':
      cmd = 'powershell -Command "$wsh = New-Object -ComObject Wscript.Shell; $wsh.SendKeys([char]177)"';
      break;
    default:
      return res.status(400).json({ error: 'Invalid action' });
  }

  exec(cmd, (err) => {
    if (err) {
      console.error(`[CONTROL] Action "${action}" failed:`, err.message);
      return res.status(500).json({ error: `Action failed: ${err.message}` });
    }
    console.log(`[CONTROL] Triggered action: ${action}`);
    res.json({ success: true, action });
  });
});

// GET /api/bookmarks — Fetch bookmarks
app.get('/api/bookmarks', (req, res) => {
  res.json({ bookmarks });
});

// POST /api/bookmarks — Add bookmark and broadcast
app.post('/api/bookmarks', (req, res) => {
  const { title, url } = req.body;
  if (title && url) {
    const newBookmark = {
      id: Math.random().toString(36).substring(7),
      title: title.trim(),
      url: url.trim()
    };
    bookmarks.push(newBookmark);
    broadcastSSE('bookmarks', { bookmarks });
    res.json({ success: true, bookmarks, bookmark: newBookmark });
  } else {
    res.status(400).json({ error: 'Missing title or url' });
  }
});

// DELETE /api/bookmarks/:id — Remove a bookmark and broadcast
app.delete('/api/bookmarks/:id', (req, res) => {
  bookmarks = bookmarks.filter(b => b.id !== req.params.id);
  broadcastSSE('bookmarks', { bookmarks });
  res.json({ success: true, bookmarks });
});

// DELETE /api/history/:id — Delete a single history item by ID and delete its file
app.delete('/api/history/:id', (req, res) => {
  try {
    const id = req.params.id;
    const index = history.findIndex(item => item.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const item = history[index];
    
    if (item.filename) {
      const fullPath = item.filename 
        ? path.join(SAVE_DIR, item.filename) 
        : (path.isAbsolute(item.path) ? item.path : path.resolve(__dirname, item.path));
      try {
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          console.log(`[DELETE] Deleted file: ${item.filename}`);
        }
      } catch (e) {
        console.error(`[DELETE] Failed to delete file: ${item.filename}`, e.message);
      }
    }
    
    history.splice(index, 1);
    saveHistory();
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/screenshot — Takes a screenshot and returns the image
app.get('/api/screenshot', (req, res) => {
  const { exec } = require('child_process');
  const tempPath = path.join(os.tmpdir(), `airodrop_screenshot_${Date.now()}.png`);
  
  // Windows PowerShell to capture primary screen and save as PNG (DPI aware)
  const psScript = `
    $Sig = '[DllImport(\\"user32.dll\\")] public static extern bool SetProcessDPIAware(); [DllImport(\\"user32.dll\\")] public static extern int GetSystemMetrics(int nIndex);';
    $Type = Add-Type -MemberDefinition $Sig -Name 'DpiAware' -PassThru;
    [void]$Type::SetProcessDPIAware();
    $w = $Type::GetSystemMetrics(0);
    $h = $Type::GetSystemMetrics(1);
    Add-Type -AssemblyName System.Drawing;
    $bmp = New-Object System.Drawing.Bitmap $w, $h;
    $graphics = [System.Drawing.Graphics]::FromImage($bmp);
    $graphics.CopyFromScreen(0, 0, 0, 0, $bmp.Size);
    $bmp.Save('${tempPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);
    $graphics.Dispose();
    $bmp.Dispose();
  `.replace(/\n/g, ' ').trim();

  const cmd = `powershell -NoProfile -Command "${psScript}"`;

  exec(cmd, (err) => {
    if (err) {
      console.error('[SCREENSHOT] Capture failed:', err.message);
      return res.status(500).json({ error: 'Screenshot capture failed: ' + err.message });
    }
    
    // Check if the screenshot file actually exists
    if (!fs.existsSync(tempPath)) {
      console.error('[SCREENSHOT] File not found after capture');
      return res.status(500).json({ error: 'Screenshot file not found after capture' });
    }

    res.sendFile(tempPath, (sendErr) => {
      // Delete the temp file after sending (or if it fails)
      try {
        fs.unlinkSync(tempPath);
      } catch (unlinkErr) {
        console.error('[SCREENSHOT] Failed to cleanup temp file:', unlinkErr.message);
      }
      if (sendErr) {
        console.error('[SCREENSHOT] Error sending file:', sendErr.message);
      }
    });
  });
});

// GET /api/check-update — Query GitHub Releases API for updates
app.get('/api/check-update', (req, res) => {
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
        const currentVersion = require('./package.json').version;

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

// GET /api/info — Server information
app.get('/api/info', async (req, res) => {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}`;
  const mobileUrl = `${url}/m`;
  const allIps = getAllIPs();

  try {
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    res.json({
      ip,
      port: PORT,
      url,
      qrDataUrl,
      saveDir: SAVE_DIR,
      uptime: process.uptime(),
      deviceName: DEVICE_NAME,
      allIps,
      temporaryMode: TEMPORARY_MODE,
      pairingToken: ''
    });
  } catch {
    res.json({
      ip,
      port: PORT,
      url,
      qrDataUrl: null,
      saveDir: SAVE_DIR,
      uptime: process.uptime(),
      deviceName: DEVICE_NAME,
      allIps,
      temporaryMode: TEMPORARY_MODE,
      pairingToken: ''
    });
  }
});

// GET /api/qr.png — Generate setup QR code PNG image directly
app.get('/api/qr.png', async (req, res) => {
  try {
    const ip = getLocalIP();
    const mobileUrl = `http://${ip}:${PORT}/m`;
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

// GET /api/qr-gen.png — Generate a QR code from custom text query directly
app.get('/api/qr-gen.png', async (req, res) => {
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

// GET /api/settings — Retrieve current settings
app.get('/api/settings', (req, res) => {
  res.json({
    saveDir: SAVE_DIR,
    shareDir: SHARE_DIR,
    port: PORT,
    temporaryMode: TEMPORARY_MODE,
    deviceName: DEVICE_NAME,
    rateLimitEnabled: RATE_LIMIT_ENABLED,
    notificationsEnabled: NOTIFICATIONS_ENABLED,
    temporaryModeHours: TEMPORARY_MODE_HOURS,
    autoOpenLinks: AUTO_OPEN_LINKS,
    launchOnStartup: LAUNCH_ON_STARTUP,
    autoUpdate: AUTO_UPDATE
  });
});

// POST /api/settings — Update settings
app.post('/api/settings', async (req, res) => {
  try {
    const { saveDir, shareDir, temporaryMode, deviceName, port, rateLimitEnabled, notificationsEnabled, temporaryModeHours, autoOpenLinks, launchOnStartup, autoUpdate } = req.body;
    
    let resolvedPath = SAVE_DIR;
    if (saveDir) {
      resolvedPath = path.isAbsolute(saveDir) 
        ? saveDir 
        : path.resolve(__dirname, saveDir);

      if (!fs.existsSync(resolvedPath)) {
        fs.mkdirSync(resolvedPath, { recursive: true });
      }

      const tempFile = path.join(resolvedPath, '.write-test-' + Math.random().toString(36).substring(7));
      fs.writeFileSync(tempFile, 'test');
      fs.unlinkSync(tempFile);
      
      SAVE_DIR = resolvedPath;
    }

    let resolvedSharePath = SHARE_DIR;
    if (shareDir) {
      resolvedSharePath = path.isAbsolute(shareDir) 
        ? shareDir 
        : path.resolve(__dirname, shareDir);

      if (!fs.existsSync(resolvedSharePath)) {
        fs.mkdirSync(resolvedSharePath, { recursive: true });
      }

      const tempFile = path.join(resolvedSharePath, '.write-test-' + Math.random().toString(36).substring(7));
      fs.writeFileSync(tempFile, 'test');
      fs.unlinkSync(tempFile);
      
      SHARE_DIR = resolvedSharePath;
    }

    if (deviceName !== undefined) {
      DEVICE_NAME = deviceName.trim() || os.hostname();
    }

    if (port !== undefined) {
      const parsedPort = parseInt(port, 10);
      if (parsedPort > 0 && parsedPort < 65536) {
        PORT = parsedPort;
      }
    }

    if (rateLimitEnabled !== undefined) {
      RATE_LIMIT_ENABLED = !!rateLimitEnabled;
    }

    if (autoOpenLinks !== undefined) {
      AUTO_OPEN_LINKS = !!autoOpenLinks;
    }

    if (notificationsEnabled !== undefined) {
      NOTIFICATIONS_ENABLED = !!notificationsEnabled;
    }

    if (temporaryModeHours !== undefined) {
      TEMPORARY_MODE_HOURS = parseFloat(temporaryModeHours) || 2;
    }

    if (launchOnStartup !== undefined) {
      LAUNCH_ON_STARTUP = !!launchOnStartup;
      try {
        const electron = require('electron');
        if (electron && electron.app) {
          electron.app.setLoginItemSettings({
            openAtLogin: LAUNCH_ON_STARTUP,
            path: process.execPath
          });
        }
      } catch (_) {}
    }

    if (autoUpdate !== undefined) {
      AUTO_UPDATE = !!autoUpdate;
    }

    const oldTempMode = TEMPORARY_MODE;
    if (temporaryMode !== undefined) {
      TEMPORARY_MODE = !!temporaryMode;
      if (TEMPORARY_MODE !== oldTempMode) {
        if (TEMPORARY_MODE) {
          try { if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE); } catch {}
        } else {
          saveHistory();
        }
      }
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      saveDir: SAVE_DIR,
      shareDir: SHARE_DIR,
      port: PORT,
      temporaryMode: TEMPORARY_MODE,
      deviceName: DEVICE_NAME,
      rateLimitEnabled: RATE_LIMIT_ENABLED,
      notificationsEnabled: NOTIFICATIONS_ENABLED,
      temporaryModeHours: TEMPORARY_MODE_HOURS,
      autoOpenLinks: AUTO_OPEN_LINKS,
      launchOnStartup: LAUNCH_ON_STARTUP,
      autoUpdate: AUTO_UPDATE
    }, null, 2));

    writeLog(`Configurations updated: SaveFolder="${SAVE_DIR}", Port=${PORT}, DeviceName="${DEVICE_NAME}"`);
    res.json({
      success: true,
      saveDir: SAVE_DIR,
      shareDir: SHARE_DIR,
      temporaryMode: TEMPORARY_MODE,
      deviceName: DEVICE_NAME,
      port: PORT,
      rateLimitEnabled: RATE_LIMIT_ENABLED,
      notificationsEnabled: NOTIFICATIONS_ENABLED,
      temporaryModeHours: TEMPORARY_MODE_HOURS,
      autoOpenLinks: AUTO_OPEN_LINKS,
      launchOnStartup: LAUNCH_ON_STARTUP,
      autoUpdate: AUTO_UPDATE
    });
  } catch (err) {
    console.error('[CONFIG] Failed to update settings:', err.message);
    res.status(400).json({ error: `Failed to save settings: ${err.message}` });
  }
});

// POST /api/settings/browse — Open native folder browser dialog (Windows, Linux, macOS)
app.post('/api/settings/browse', async (req, res) => {
  try {
    const platform = os.platform();
    let cmd = '';

    if (platform === 'win32') {
      // Windows PowerShell Folder Browser Dialog (no escaped dollars)
      cmd = 'powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = \'Select AiroDrop Save Folder\'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq \'OK\') { Write-Host $f.SelectedPath }"';
    } else if (platform === 'linux') {
      // Linux: Try zenity first, fallback to kdialog
      cmd = 'zenity --file-selection --directory --title="Select AiroDrop Save Folder" 2>/dev/null || kdialog --getexistingdirectory . 2>/dev/null';
    } else if (platform === 'darwin') {
      // macOS: AppleScript Folder Picker
      cmd = `osascript -e 'tell application "System Events" to activate' -e 'POSIX path of (choose folder with prompt "Select AiroDrop Save Folder")'`;
    } else {
      return res.status(400).json({ error: `Folder selection is not supported on platform: ${platform}` });
    }

    const { exec } = require('child_process');
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        // Log error but don't crash, user might have clicked cancel (which returns exit code 1 in zenity)
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

// POST /api/send-to-phone — Queue content for iPhone to pick up (two-way)
app.post('/api/send-to-phone', upload.single('file'), (req, res) => {
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
      pendingForPhone.unshift(item);
      if (pendingForPhone.length > 50) pendingForPhone.pop();
      broadcastSSE('phone-queued', item);
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
      pendingForPhone.unshift(item);
      if (pendingForPhone.length > 50) pendingForPhone.pop();
      broadcastSSE('phone-queued', item);
      return res.json({ success: true, id: item.id, message: 'Text queued for iPhone' });
    }

    if (type === 'image' && imageUrl) {
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'image',
        url: imageUrl,
        timestamp: new Date().toISOString()
      };
      pendingForPhone.unshift(item);
      if (pendingForPhone.length > 50) pendingForPhone.pop();
      broadcastSSE('phone-queued', item);
      return res.json({ success: true, id: item.id, message: 'Image queued for iPhone' });
    }

    return res.status(400).json({ error: 'Provide type ("text", "image" or upload a file) and content' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/pending/:id — PC cancels a queued pending item
app.delete('/api/pending/:id', (req, res) => {
  const idx = pendingForPhone.findIndex(item => item.id === req.params.id);
  if (idx !== -1) {
    const [removed] = pendingForPhone.splice(idx, 1);
    broadcastSSE('phone-ack', removed);
    res.json({ success: true, message: 'Pending item canceled' });
  } else {
    res.status(404).json({ error: 'Pending item not found' });
  }
});



// GET /api/stats — Get dashboard statistics
app.get('/api/stats', (req, res) => {
  try {
    let totalTransfers = history.length;
    let totalBytes = 0;
    let filesCount = 0;
    
    for (const item of history) {
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
      connections: sseClients.size
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/storage — Scan storage directory usage
app.get('/api/storage', (req, res) => {
  try {
    if (!fs.existsSync(SAVE_DIR)) {
      return res.json({ count: 0, size: 0, limit: 5 * 1024 * 1024 * 1024 });
    }
    const files = fs.readdirSync(SAVE_DIR);
    let totalSize = 0;
    let count = 0;
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const filePath = path.join(SAVE_DIR, file);
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
    res.json({ count, size: totalSize, limit: 5 * 1024 * 1024 * 1024 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/export — Export transfer history as JSON file
app.get('/api/history/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename=airodrop_history.json');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(history, null, 2));
});

// GET /api/pending — iPhone polls for pending items
app.get('/api/pending', (req, res) => {
  const after = req.query.after;
  let items = pendingForPhone;
  if (after) {
    items = pendingForPhone.filter(item => item.timestamp > after);
  }
  res.json({ items });
});

// POST /api/pending/:id/ack — iPhone acknowledges receiving an item
app.post('/api/pending/:id/ack', (req, res) => {
  const idx = pendingForPhone.findIndex(item => item.id === req.params.id);
  if (idx !== -1) {
    const [removed] = pendingForPhone.splice(idx, 1);
    broadcastSSE('phone-ack', removed);
    res.json({ success: true, message: 'Item acknowledged' });
  } else {
    res.json({ success: true, message: 'Item already removed' });
  }
});

// ─── SSE Heartbeat (keeps connections alive, prunes dead clients) ──
setInterval(() => {
  const deadClients = [];
  for (const client of sseClients) {
    try {
      client.write(': heartbeat\n\n');
    } catch {
      deadClients.push(client);
    }
  }
  deadClients.forEach(c => sseClients.delete(c));
}, 30000); // Every 30 seconds

// GET /api/events — SSE endpoint for real-time updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current history count as initial event
  res.write(`event: connected\ndata: ${JSON.stringify({ count: history.length })}\n\n`);
  res.write(`event: logs-init\ndata: ${JSON.stringify(logHistory)}\n\n`);

  sseClients.add(res);
  writeLog("Dashboard client connected.");

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIFIED ENDPOINT (for simple one-action shortcuts)
// Accepts both text and images in one endpoint
// ═══════════════════════════════════════════════════════════════

// POST /api/send — Unified endpoint that accepts text, image, or generic files
app.post('/api/send', upload.any(), async (req, res) => {
  try {
    let savedPath;
    let filename;
    let originalName;
    let fileSize;
    let mimeType;
    let isImage = false;
    let isFile = false;

    const contentType = req.headers['content-type'] || '';
    const isFileHeader = contentType.startsWith('application/') || 
                         contentType.startsWith('audio/') || 
                         contentType.startsWith('video/') ||
                         contentType.includes('octet-stream');

    const reqFile = req.file || (req.files && req.files[0]);

    // 1. Check if it's parsed by multer as a form-data file
    if (reqFile) {
      savedPath = reqFile.path;
      filename = reqFile.filename;
      originalName = reqFile.originalname;
      fileSize = reqFile.size;
      mimeType = reqFile.mimetype;
      
      if (mimeType.startsWith('image/')) {
        isImage = true;
      } else {
        isFile = true;
      }
    } 
    // 2. Check if we received a raw Buffer in the body
    else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      const detectedMime = isBufferImage(req.body);
      if (detectedMime) {
        const ext = '.' + detectedMime.split('/')[1].replace('jpeg', 'jpg');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        filename = `${timestamp}_uploaded${ext}`;
        savedPath = path.join(SAVE_DIR, filename);
        originalName = filename;
        fileSize = req.body.length;
        mimeType = detectedMime;
        isImage = true;

        fs.writeFileSync(savedPath, req.body);
      } else if (isFileHeader) {
        const cleanType = contentType.split(';')[0];
        let ext = '.bin';
        if (cleanType.includes('/')) {
          ext = '.' + cleanType.split('/')[1].replace('jpeg', 'jpg').replace('mpeg', 'mp3');
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        filename = `${timestamp}_uploaded${ext}`;
        savedPath = path.join(SAVE_DIR, filename);
        originalName = filename;
        fileSize = req.body.length;
        mimeType = cleanType;
        isFile = true;

        fs.writeFileSync(savedPath, req.body);
      }
    }

    if (isImage) {
      const relativePath = path.relative(__dirname, savedPath);
      const clipResult = await copyImage(savedPath);

      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'image',
        filename,
        originalName,
        path: relativePath,
        size: fileSize,
        mimetype: mimeType,
        timestamp: new Date().toISOString(),
        clipboardSuccess: clipResult.success
      };
      addToHistory(item);
      notifyImage(filename);
      writeLog(`Received Image: ${originalName} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
      return res.json({ success: true, id: item.id, type: 'image', message: 'Image saved' });
    }

    if (isFile) {
      // Check if it's actually a webpage/HTML file to extract its URL
      const extractedUrl = await tryExtractUrlFromHtmlFile(savedPath, mimeType);
      if (extractedUrl) {
        const clipRes = await handleIncomingText(extractedUrl);
        const item = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          type: 'text',
          content: extractedUrl,
          preview: extractedUrl,
          timestamp: new Date().toISOString(),
          clipboardSuccess: clipRes.success
        };
        addToHistory(item);
        notifyText(extractedUrl);
        writeLog(`Extracted URL from uploaded file: ${extractedUrl}`);
        return res.json({ success: true, id: item.id, type: 'text', message: 'URL link extracted and copied' });
      }

      const relativePath = path.relative(__dirname, savedPath);
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'file',
        filename,
        originalName,
        path: relativePath,
        size: fileSize,
        mimetype: mimeType,
        timestamp: new Date().toISOString()
      };
      addToHistory(item);
      notifyText(`Received File: ${originalName}`);
      writeLog(`Received File: ${originalName} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
      return res.json({ success: true, id: item.id, type: 'file', message: 'File saved' });
    }

    // 3. Otherwise, process as text
    let text = '';
    if (typeof req.body === 'string') {
      const trimmed = req.body.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed);
          text = parsed.content || parsed.text || req.body;
        } catch {
          text = req.body;
        }
      } else {
        text = req.body;
      }
    } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      text = req.body.toString('utf8');
      const trimmed = text.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed);
          text = parsed.content || parsed.text || text;
        } catch {}
      }
    } else if (req.body && typeof req.body === 'object') {
      text = req.body.content || req.body.text || '';
      if (!text && Object.keys(req.body).length === 1) {
        text = Object.values(req.body)[0];
      }
    }
    if (typeof text !== 'string') text = String(text);

    // HTML Web Page detection & URL extraction
    if (typeof text === 'string' && (text.trim().startsWith('<') || text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().includes('<html'))) {
      const canonicalMatch = text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
                             text.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
      const ogMatch = text.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) ||
                      text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
      const twitterMatch = text.match(/<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/i);
      
      let extractedUrl = (canonicalMatch && canonicalMatch[1]) || (ogMatch && ogMatch[1]) || (twitterMatch && twitterMatch[1]);
      if (!extractedUrl) {
        // Fallback: search for absolute HTTP URL links that are not static assets or namespace schemas
        const allUrls = text.match(/https?:\/\/[^\s"'<>\(\)]+/gi);
        if (allUrls) {
          const cleanUrl = allUrls.find(u => {
            const low = u.toLowerCase();
            return !low.endsWith('.js') && 
                   !low.endsWith('.css') && 
                   !low.endsWith('.png') && 
                   !low.endsWith('.jpg') && 
                   !low.endsWith('.jpeg') && 
                   !low.endsWith('.gif') && 
                   !low.endsWith('.svg') && 
                   !low.endsWith('.woff') && 
                   !low.endsWith('.woff2') &&
                   !low.includes('schema.org') &&
                   !low.includes('w3.org');
          });
          if (cleanUrl) {
            extractedUrl = cleanUrl;
          }
        }
      }
      if (extractedUrl) {
        text = extractedUrl;
      }
    }

    if (text.trim()) {
      const clipResult = await handleIncomingText(text);
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'text',
        content: text,
        preview: text.length > 200 ? text.substring(0, 200) + '...' : text,
        timestamp: new Date().toISOString(),
        clipboardSuccess: clipResult.success
      };
      addToHistory(item);
      notifyText(text);
      writeLog(`Received Text: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
      return res.json({ success: true, id: item.id, type: 'text', message: 'Text received & copied' });
    }

    return res.status(400).json({ error: 'No content provided. Send text or a file.' });
  } catch (err) {
    console.error('[SEND] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  express.static(SAVE_DIR)(req, res, next);
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
    return next(); // Let /files routes handle it
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Multer error handler ──────────────────────────────────────
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

// ─── Server Lifecycle ──────────────────────────────────────────
let serverInstance = null;
let wss = null;

function startServer(portCallback) {
  if (serverInstance) return;
  
  serverInstance = app.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    const url = `http://${ip}:${PORT}`;
    writeLog(`AiroDrop Server active at ${url}`);

    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║   iPhone → PC : AirDrop Alternative         ║');
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log(`  ║   Server URL : ${url.padEnd(29)}║`);
    console.log(`  ║   Dashboard  : ${url.padEnd(29)}║`);
    console.log(`  ║   Save Folder: ${SAVE_DIR.padEnd(29)}║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    
    if (portCallback) portCallback(PORT);
  });

  // Create WebSocket server mapping to /trackpad route only
  wss = new WebSocket.Server({ noServer: true });
  
  serverInstance.on('upgrade', (request, socket, head) => {
    try {
      const pathname = request.url.split('?')[0];
      if (pathname === '/trackpad') {
        const urlParams = new URLSearchParams(request.url.split('?')[1] || '');
        const token = urlParams.get('token');
        const ip = socket.remoteAddress;
        
        let isAuthorized = true;

        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.deviceToken = token || 'localhost';
          wss.emit('connection', ws, request);
        });
      }
    } catch (err) {
      console.error('[WS-UPGRADE] Upgrade failed:', err.message);
    }
  });

  wss.on('connection', (ws) => {
    console.log('[TRACKPAD] Phone connected via WebSocket');
    let accumX = 0;
    let accumY = 0;
    
    ws.on('message', (message) => {
      try {
        let messageStr;
        if (typeof message === 'string') {
          messageStr = message;
        } else {
          messageStr = Buffer.from(message).toString('utf8');
        }
        const data = JSON.parse(messageStr);
        
        switch (data.type) {
          case 'move':
            try {
              accumX += data.dx;
              accumY += data.dy;
              const moveX = Math.trunc(accumX);
              const moveY = Math.trunc(accumY);
              if (moveX !== 0 || moveY !== 0) {
                accumX -= moveX;
                accumY -= moveY;
                if (mouse_event) {
                  mouse_event(0x0001, moveX, moveY, 0, 0);
                }
              }
            } catch (moveErr) {
              const moveX = Math.round(data.dx);
              const moveY = Math.round(data.dy);
              if (mouse_event) {
                mouse_event(0x0001, moveX, moveY, 0, 0);
              }
            }
            break;
          case 'click':
            if (mouse_event) {
              const button = data.button || 'left';
              const downFlag = button === 'left' ? 0x0002 : 0x0008; // LEFTDOWN : RIGHTDOWN
              const upFlag = button === 'left' ? 0x0004 : 0x0010;   // LEFTUP : RIGHTUP
              mouse_event(downFlag, 0, 0, 0, 0);
              mouse_event(upFlag, 0, 0, 0, 0);
            }
            break;
          case 'scroll':
            if (mouse_event) {
              // dwFlags: 0x0800 (MOUSEEVENTF_WHEEL), dwData: scroll delta (positive/negative)
              // 120 is one click of wheel
              const delta = Math.round(data.dy * 120);
              mouse_event(0x0800, 0, 0, delta, 0);
            }
            break;
          case 'identify':
            if (data.deviceName) {
              console.log(`[TRACKPAD] Device identified: ${data.deviceName}`);
              broadcastSSE('trackpad_status', { connected: true, deviceName: data.deviceName });
            }
            break;
          case 'type':
            sendKeystroke(data.text);
            break;
          case 'key':
            // Key codes (like Backspace=8, Enter=13)
            sendKeystroke(data.code);
            break;
          case 'move_abs':
            if (SetCursorPos && GetSystemMetrics) {
              const screenW = GetSystemMetrics(0); // SM_CXSCREEN
              const screenH = GetSystemMetrics(1); // SM_CYSCREEN
              const absX = Math.round((data.xRatio || 0) * screenW);
              const absY = Math.round((data.yRatio || 0) * screenH);
              SetCursorPos(absX, absY);
            }
            break;
          case 'click_abs':
            // Move cursor to absolute position based on ratio of screen size
            if (SetCursorPos && mouse_event && GetSystemMetrics) {
              const screenW = GetSystemMetrics(0); // SM_CXSCREEN
              const screenH = GetSystemMetrics(1); // SM_CYSCREEN
              const absX = Math.round((data.xRatio || 0) * screenW);
              const absY = Math.round((data.yRatio || 0) * screenH);
              SetCursorPos(absX, absY);
              if (data.button === 'right') {
                mouse_event(0x0008, 0, 0, 0, 0); // MOUSEEVENTF_RIGHTDOWN
                mouse_event(0x0010, 0, 0, 0, 0); // MOUSEEVENTF_RIGHTUP
              } else {
                mouse_event(0x0002, 0, 0, 0, 0); // MOUSEEVENTF_LEFTDOWN
                mouse_event(0x0004, 0, 0, 0, 0); // MOUSEEVENTF_LEFTUP
              }
            }
            break;
          case 'screencast_start':
            serverEvents.emit('screencast_start', ws);
            break;
          case 'screencast_stop':
            serverEvents.emit('screencast_stop', ws);
            break;
          case 'webrtc_answer':
            serverEvents.emit('webrtc_answer', ws, data.answer);
            break;
          case 'webrtc_ice_candidate':
            serverEvents.emit('webrtc_ice_candidate', ws, data.candidate);
            break;
          case 'ping_pc':
            broadcastSSE('ping-pc', { device: ws.deviceToken || 'mobile' });
            serverEvents.emit('ping_pc', ws);
            break;
        }
      } catch (err) {
        console.error('[TRACKPAD] WS Message parsing failed:', err.message);
      }
    });
    
    ws.on('close', () => {
      console.log('[TRACKPAD] Phone disconnected');
      serverEvents.emit('screencast_stop', ws);
      broadcastSSE('trackpad_status', { connected: false });
    });
  });

  
  serverInstance.on('error', (err) => {
    console.error('Server error:', err);
    if (portCallback) portCallback(null, err);
  });
}

function stopServer() {
  if (serverInstance) {
    writeLog("AiroDrop Server stopped.");
    if (wss) {
      wss.close();
      wss = null;
    }
    serverInstance.close();
    serverInstance = null;
    console.log('Server stopped.');
  }
}

// Graceful shutdown
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
  getPort: () => PORT,
  getSaveDir: () => SAVE_DIR,
  getShareDir: () => SHARE_DIR,
  setSaveDir,
  getLocalIP,
  serverEvents,
  writeLog,
  getAutoUpdate: () => AUTO_UPDATE,
  getLaunchOnStartup: () => LAUNCH_ON_STARTUP
};