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
const PORT = process.env.PORT || 3478;
const MAX_HISTORY = 100;
const RECEIVE_DIR = path.join(os.homedir(), 'Desktop', 'AirDrop-Received');
const UPLOAD_DIR = path.join(__dirname, 'received');

// Use ~/Desktop/AirDrop-Received/ if accessible, fallback to ./received/
let IMAGE_SAVE_DIR = RECEIVE_DIR;
try {
  if (!fs.existsSync(IMAGE_SAVE_DIR)) {
    fs.mkdirSync(IMAGE_SAVE_DIR, { recursive: true });
  }
} catch {
  IMAGE_SAVE_DIR = UPLOAD_DIR;
  if (!fs.existsSync(IMAGE_SAVE_DIR)) {
    fs.mkdirSync(IMAGE_SAVE_DIR, { recursive: true });
  }
}

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
    cb(null, IMAGE_SAVE_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
    cb(null, `${timestamp}_${safeName || 'image'}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|heic|heif|bmp|svg/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype.split('/')[1]?.toLowerCase() || '');
    if (ext || mime) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported image type. Allowed: jpg, png, gif, webp, heic, bmp, svg'));
    }
  }
});

// ─── Express App ───────────────────────────────────────────────
const app = express();
app.use(rateLimit);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/text — Receive text from iPhone
app.post('/api/text', async (req, res) => {
  try {
    let text = req.body.text || req.body.content || '';

    // Also accept raw body as text
    if (!text && typeof req.body === 'string') {
      text = req.body;
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'No text provided' });
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

// POST /api/image — Receive image from iPhone
app.post('/api/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided. Use multipart form with "image" field.' });
    }

    const savedPath = req.file.path;
    const filename = req.file.filename;
    const relativePath = path.relative(__dirname, savedPath);

    // Try to copy image to clipboard
    const clipResult = await copyImage(savedPath);

    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: 'image',
      filename: filename,
      originalName: req.file.originalname,
      path: relativePath,
      size: req.file.size,
      mimetype: req.file.mimetype,
      timestamp: new Date().toISOString(),
      clipboardSuccess: clipResult.success
    };
    addToHistory(item);

    // Show notification
    notifyImage(filename);

    const sizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
    console.log(`[IMAGE] ${filename} (${sizeMB} MB)`);
    res.json({
      success: true,
      id: item.id,
      filename: filename,
      path: relativePath,
      message: 'Image saved successfully'
    });
  } catch (err) {
    console.error('[IMAGE] Error:', err.message);
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
      saveDir: IMAGE_SAVE_DIR,
      uptime: process.uptime()
    });
  } catch {
    res.json({ ip, port: PORT, url, qrDataUrl: null, saveDir: IMAGE_SAVE_DIR, uptime: process.uptime() });
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

// POST /api/send — Unified endpoint that accepts text OR image
app.post('/api/send', upload.single('content'), async (req, res) => {
  try {
    // If a file was uploaded, treat as image
    if (req.file) {
      const savedPath = req.file.path;
      const filename = req.file.filename;
      const relativePath = path.relative(__dirname, savedPath);
      const clipResult = await copyImage(savedPath);

      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'image',
        filename,
        originalName: req.file.originalname,
        path: relativePath,
        size: req.file.size,
        mimetype: req.file.mimetype,
        timestamp: new Date().toISOString(),
        clipboardSuccess: clipResult.success
      };
      addToHistory(item);
      notifyImage(filename);
      console.log(`[SEND/IMAGE] ${filename} (${(req.file.size / (1024 * 1024)).toFixed(2)} MB)`);
      return res.json({ success: true, id: item.id, type: 'image', message: 'Image saved' });
    }

    // Check for text in body (form or JSON)
    let text = req.body.content || req.body.text || '';
    // Also check for raw body
    if (!text && req.body && typeof req.body === 'object' && Object.keys(req.body).length === 1) {
      text = Object.values(req.body)[0];
    }
    if (typeof text !== 'string') text = String(text);

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

    return res.status(400).json({ error: 'No content provided. Send text or an image file.' });
  } catch (err) {
    console.error('[SEND] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// SHORTCUT FILE SERVING
// ═══════════════════════════════════════════════════════════════

// Generate shortcuts on first request
let shortcutsGenerated = false;

function ensureShortcutsGenerated() {
  if (shortcutsGenerated) return;
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}`;
  try {
    const { execSync } = require('child_process');
    execSync(`node "${path.join(__dirname, 'generate-shortcuts.js')}" "${url}"`, {
      cwd: __dirname,
      timeout: 10000,
      windowsHide: true,
      stdio: 'pipe'
    });
    shortcutsGenerated = true;
    console.log('[SHORTCUTS] Generated .shortcut files for current server URL');
  } catch (err) {
    console.error('[SHORTCUTS] Failed to generate:', err.message);
  }
}

// Serve shortcut files for download
app.get('/api/shortcuts/:name', (req, res) => {
  ensureShortcutsGenerated();
  const name = req.params.name.replace(/\.shortcut$/, '') + '.shortcut';
  const filePath = path.join(__dirname, 'public', 'shortcuts', name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Shortcut not found' });
  }

  const displayName = name.replace('.shortcut', '').replace(/-/g, ' ');
  res.setHeader('Content-Type', 'application/x-shortcut');
  res.setHeader('Content-Disposition', `attachment; filename="${displayName}.shortcut"`);
 res.sendFile(filePath);
});

// Serve image files from the received directory
app.use('/received', express.static(IMAGE_SAVE_DIR));

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
  console.log(`  ║   Save Folder: ${IMAGE_SAVE_DIR.padEnd(29)}║`);
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