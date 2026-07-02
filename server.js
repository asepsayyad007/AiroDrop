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
const QRCode = require('qrcode');
const { copyText, copyImage } = require('./clipboard');
const { notifyText, notifyImage } = require('./notify');

// ─── Configuration ──────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
let PORT = 3478;
let SAVE_DIR = path.join(__dirname, 'received');

// Load settings from config.json
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data.port) PORT = parseInt(data.port, 10) || 3478;
      if (data.saveDir) {
        // If relative, resolve against project directory
        SAVE_DIR = path.isAbsolute(data.saveDir) 
          ? data.saveDir 
          : path.resolve(__dirname, data.saveDir);
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
}

// Initial config load
loadConfig();

const MAX_HISTORY = 100;

// ─── In-Memory Stores ──────────────────────────────────────────
const history = [];          // Received items (from iPhone)
const pendingForPhone = [];  // Items queued for iPhone to pick up
const sseClients = new Set(); // SSE connected clients

// ─── Simple Rate Limiter ───────────────────────────────────────
const rateLimitMap = new Map();
const RATE_WINDOW = 60000;  // 1 minute
const RATE_MAX = 60;        // 60 requests per minute per IP

function rateLimit(req, res, next) {
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
const app = express();
app.use(rateLimit);

// Dynamic Content-Type body parsers (prevents stream consumption conflicts with Multer)
const jsonParser = express.json({ limit: '10mb' });
const urlencodedParser = express.urlencoded({ extended: true, limit: '10mb' });
const rawParser = express.raw({ type: '*/*', limit: '50mb' });

app.use((req, res, next) => {
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
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Helper: Get Local IP ──────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
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
  if (history.length > MAX_HISTORY) history.pop();
  broadcastSSE('new-item', item);
}

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
    const clipResult = await copyText(text);

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
  const since = req.query.since;
  let items = history;
  if (since) {
    items = history.filter(item => item.timestamp > since);
  }
  res.json({ items, total: history.length });
});

// GET /api/info — Server information
app.get('/api/info', async (req, res) => {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}`;

  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
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
      uptime: process.uptime()
    });
  } catch {
    res.json({ ip, port: PORT, url, qrDataUrl: null, saveDir: SAVE_DIR, uptime: process.uptime() });
  }
});

// GET /api/settings — Retrieve current settings
app.get('/api/settings', (req, res) => {
  res.json({
    saveDir: SAVE_DIR,
    port: PORT
  });
});

// POST /api/settings — Update settings (specifically saveDir)
app.post('/api/settings', express.json(), async (req, res) => {
  try {
    const { saveDir } = req.body;
    if (!saveDir) {
      return res.status(400).json({ error: 'saveDir is required' });
    }

    // Try to resolve the path and verify we can write to it
    const resolvedPath = path.isAbsolute(saveDir) 
      ? saveDir 
      : path.resolve(__dirname, saveDir);

    // Create the directory if it does not exist
    if (!fs.existsSync(resolvedPath)) {
      fs.mkdirSync(resolvedPath, { recursive: true });
    }

    // Attempt a temporary file write to verify write permissions
    const tempFile = path.join(resolvedPath, '.write-test-' + Math.random().toString(36).substring(7));
    fs.writeFileSync(tempFile, 'test');
    fs.unlinkSync(tempFile);

    // Update global SAVE_DIR
    SAVE_DIR = resolvedPath;

    // Save to config.json
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ saveDir, port: PORT }, null, 2));

    console.log(`[CONFIG] Save folder updated to: ${SAVE_DIR}`);
    res.json({ success: true, saveDir: SAVE_DIR });
  } catch (err) {
    console.error('[CONFIG] Failed to update save folder:', err.message);
    res.status(400).json({ error: `Cannot write to folder: ${err.message}` });
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
app.post('/api/send-to-phone', (req, res) => {
  try {
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

    return res.status(400).json({ error: 'Provide type ("text" or "image") and content' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// GET /api/events — SSE endpoint for real-time updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current history count as initial event
  res.write(`event: connected\ndata: ${JSON.stringify({ count: history.length })}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIFIED ENDPOINT (for simple one-action shortcuts)
// Accepts both text and images in one endpoint
// ═══════════════════════════════════════════════════════════════

// POST /api/send — Unified endpoint that accepts text, image, or generic files
app.post('/api/send', upload.single('content'), async (req, res) => {
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

    // 1. Check if it's parsed by multer as a form-data file
    if (req.file) {
      savedPath = req.file.path;
      filename = req.file.filename;
      originalName = req.file.originalname;
      fileSize = req.file.size;
      mimeType = req.file.mimetype;
      
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
      console.log(`[SEND/IMAGE] ${filename} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
      return res.json({ success: true, id: item.id, type: 'image', message: 'Image saved' });
    }

    if (isFile) {
      // Check if it's actually a webpage/HTML file to extract its URL
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
        console.log(`[SEND/URL-EXTRACT] Extracted URL from uploaded file: ${extractedUrl}`);
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
      console.log(`[SEND/FILE] ${filename} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
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
      const clipResult = await copyText(text);
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
      console.log(`[SEND/TEXT] ${text.substring(0, 60)}${text.length > 60 ? '...' : ''}`);
      return res.json({ success: true, id: item.id, type: 'text', message: 'Text received & copied' });
    }

    return res.status(400).json({ error: 'No content provided. Send text or a file.' });
  } catch (err) {
    console.error('[SEND] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve image and file downloads from the dynamic save directory
app.use('/received', (req, res, next) => {
  express.static(SAVE_DIR)(req, res, next);
});

// Serve static dashboard files
app.use(express.static(path.join(__dirname, 'public')));

// GET /m — Mobile setup page (separate from SPA fallback)
app.get('/m', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

// SPA fallback — serve index.html for any unmatched route (except /m)
app.get('*', (req, res) => {
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

// ─── Start Server ──────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}`;

  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   iPhone → PC : AirDrop Alternative         ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║   Server URL : ${url.padEnd(29)}║`);
  console.log(`  ║   Dashboard  : ${url.padEnd(29)}║`);
  console.log(`  ║   Save Folder: ${SAVE_DIR.padEnd(29)}║`);
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║   Endpoints:                                  ║');
  console.log(`  ║   POST ${('/api/text').padEnd(35)}║`);
  console.log(`  ║   POST ${('/api/image').padEnd(35)}║`);
  console.log(`  ║   GET  ${('/api/history').padEnd(36)}║`);
  console.log(`  ║   GET  ${('/api/info').padEnd(36)}║`);
  console.log(`  ║   POST ${('/api/send-to-phone').padEnd(35)}║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Scan the QR code on the dashboard to set up your iPhone.');
  console.log('  Press Ctrl+C to stop the server.');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});

module.exports = app;