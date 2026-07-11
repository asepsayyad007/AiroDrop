const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const state = require('../state');
const utils = require('../utils');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, state.SAVE_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    const base = path.basename(file.originalname, ext);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
    cb(null, `${safeBase || 'file'}_${timestamp}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB max
  fileFilter: (req, file, cb) => {
    cb(null, true);
  }
});

// POST /api/text — Receive text from iPhone
router.post('/text', async (req, res) => {
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

    const clipResult = await utils.handleIncomingText(text);

    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: 'text',
      content: text,
      preview: text.length > 200 ? text.substring(0, 200) + '...' : text,
      timestamp: new Date().toISOString(),
      clipboardSuccess: clipResult.success
    };
    utils.addToHistory(item);
    utils.notifyText(text);

    console.log(`[TEXT] ${text.substring(0, 60)}${text.length > 60 ? '...' : ''}`);
    res.json({ success: true, id: item.id, message: 'Text received and copied to clipboard' });
  } catch (err) {
    console.error('[TEXT] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/image & POST /api/file — Receive image or generic file from iPhone
router.post(['/image', '/file'], upload.fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]), async (req, res) => {
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
      const detectedMime = utils.isBufferImage(req.body) || cleanType;
      
      let ext = '.bin';
      if (detectedMime && detectedMime.includes('/')) {
        ext = '.' + detectedMime.split('/')[1].replace('jpeg', 'jpg').replace('mpeg', 'mp3');
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      filename = `${timestamp}_uploaded${ext}`;
      savedPath = path.join(state.SAVE_DIR, filename);
      originalName = filename;
      fileSize = req.body.length;
      mimeType = detectedMime;

      fs.writeFileSync(savedPath, req.body);
    } else {
      return res.status(400).json({ error: 'No file or binary buffer provided.' });
    }

    const extractedUrl = await utils.tryExtractUrlFromHtmlFile(savedPath, mimeType);
    if (extractedUrl) {
      const clipRes = await utils.handleIncomingText(extractedUrl);
      const item = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'text',
        content: extractedUrl,
        preview: extractedUrl,
        timestamp: new Date().toISOString(),
        clipboardSuccess: clipRes.success
      };
      utils.addToHistory(item);
      utils.notifyText(extractedUrl);
      console.log(`[FILE/URL-EXTRACT] Extracted URL from uploaded file: ${extractedUrl}`);
      return res.json({
        success: true,
        id: item.id,
        type: 'text',
        message: 'URL link extracted and copied to clipboard'
      });
    }

    const relativePath = path.relative(path.join(__dirname, '..', '..'), savedPath);
    
    const isImg = utils.isBufferImage(req.body) || (mimeType && mimeType.startsWith('image/'));
    let clipResult = { success: false, error: 'Not an image' };
    if (isImg) {
      const { copyImage } = require('../../clipboard');
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
    utils.addToHistory(item);

    if (isImg) {
      utils.notifyImage(filename);
    } else {
      utils.notifyText(`Received File: ${originalName}`);
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

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function detectMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// GET /api/clipboard — Read unified clipboard (queues first, fallback to PC clipboard)
router.get('/clipboard', async (req, res) => {
  try {
    // 1. Check explicit queue first
    if (state.pendingForPhone && state.pendingForPhone.length > 0) {
      const latestItem = state.pendingForPhone[0]; // first item is the most recent
      if (latestItem.type === 'file' || latestItem.type === 'image') {
        const localIP = utils.getLocalIP();
        const httpPort = parseInt(state.PORT, 10) + 1; // fallback HTTP port
        const downloadUrl = `http://${localIP}:${httpPort}/received/${latestItem.filename}`;
        
        const size = latestItem.size || 0;
        const mime = latestItem.mimeType || latestItem.mimetype || detectMimeType(latestItem.filename);
        
        return res.json({
          success: true,
          id: latestItem.id,
          type: 'file',
          filename: latestItem.originalName || latestItem.filename,
          mimeType: mime,
          size: size,
          sizeFormatted: formatBytes(size),
          url: downloadUrl
        });
      } else if (latestItem.type === 'text') {
        return res.json({
          success: true,
          id: latestItem.id,
          type: 'text',
          mimeType: 'text/plain',
          text: latestItem.content
        });
      }
    }

    // 2. Fallback to reading the system clipboard
    const { readText } = require('../../clipboard');
    const result = await readText();
    if (result.success && result.text && result.text.trim().length > 0) {
      return res.json({
        success: true,
        type: 'text',
        mimeType: 'text/plain',
        text: result.text
      });
    }

    // 3. Both are empty
    res.json({
      success: false,
      message: 'Clipboard is empty'
    });
  } catch (err) {
    console.error('[GET-CLIPBOARD] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/latest-file — Return details for the latest pending file/image (Backward Compatibility)
router.get('/latest-file', (req, res) => {
  try {
    const latestFile = state.pendingForPhone.find(item => item.type === 'file' || item.type === 'image');
    if (latestFile) {
      const localIP = utils.getLocalIP();
      const httpPort = parseInt(state.PORT, 10) + 1;
      const downloadUrl = `http://${localIP}:${httpPort}/received/${latestFile.filename}`;
      res.json({
        success: true,
        filename: latestFile.originalName || latestFile.filename,
        url: downloadUrl
      });
    } else {
      res.status(404).json({ success: false, error: 'No pending files found' });
    }
  } catch (err) {
    console.error('[LATEST-FILE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history — Return received items list
router.get('/history', (req, res) => {
  let changed = false;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const item = state.history[i];
    if (item.type === 'image' || item.type === 'file') {
      const fullPath = item.filename 
        ? path.join(state.SAVE_DIR, item.filename) 
        : (path.isAbsolute(item.path) ? item.path : path.resolve(path.join(__dirname, '..', '..'), item.path));
      if (!fs.existsSync(fullPath)) {
        console.log(`[HISTORY-CLEANUP] File no longer exists on disk, removing from list: ${item.filename || item.id}`);
        state.history.splice(i, 1);
        changed = true;
      }
    }
  }
  if (changed) {
    utils.saveHistory();
  }

  const since = req.query.since;
  let items = state.history;
  if (since) {
    items = state.history.filter(item => item.timestamp > since);
  }
  res.json({ items, total: state.history.length });
});

// DELETE /api/history — Clear all history and files
router.delete('/history', (req, res) => {
  try {
    for (const item of state.history) {
      if (item.filename) {
        const fullPath = item.filename 
          ? path.join(state.SAVE_DIR, item.filename) 
          : (path.isAbsolute(item.path) ? item.path : path.resolve(path.join(__dirname, '..', '..'), item.path));
        try {
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        } catch (e) {
          console.error(`[DELETE-ALL] Failed to delete file: ${item.filename}`, e.message);
        }
      }
    }
    state.history.length = 0;
    utils.saveHistory();
    utils.broadcastSSE('clear', {});
    res.json({ success: true, message: 'All history and files cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/history/:id — Delete a single history item
router.delete('/history/:id', (req, res) => {
  try {
    const id = req.params.id;
    const index = state.history.findIndex(item => item.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const item = state.history[index];
    
    if (item.filename) {
      const fullPath = item.filename 
        ? path.join(state.SAVE_DIR, item.filename) 
        : (path.isAbsolute(item.path) ? item.path : path.resolve(path.join(__dirname, '..', '..'), item.path));
      try {
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          console.log(`[DELETE] Deleted file: ${item.filename}`);
        }
      } catch (e) {
        console.error(`[DELETE] Failed to delete file: ${item.filename}`, e.message);
      }
    }
    
    state.history.splice(index, 1);
    utils.saveHistory();
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/export
router.get('/history/export', (req, res) => {
  res.json(state.history);
});

// GET /api/scratchpad
router.get('/scratchpad', (req, res) => {
  res.json({ text: state.scratchpadText });
});

// POST /api/scratchpad
router.post('/scratchpad', (req, res) => {
  state.scratchpadText = req.body.text || "";
  try {
    fs.writeFileSync(state.SCRATCHPAD_FILE, state.scratchpadText || "", 'utf8');
  } catch (err) {
    console.error('[SCRATCHPAD] Failed to save scratchpad:', err.message);
  }
  utils.broadcastSSE('scratchpad', { text: state.scratchpadText });
  res.json({ success: true, text: state.scratchpadText });
});

// GET /api/bookmarks
router.get('/bookmarks', (req, res) => {
  res.json({ bookmarks: state.bookmarks });
});

// POST /api/bookmarks
router.post('/bookmarks', (req, res) => {
  const { title, url } = req.body;
  if (title && url) {
    const newBookmark = {
      id: Math.random().toString(36).substring(7),
      title: title.trim(),
      url: url.trim()
    };
    state.bookmarks.push(newBookmark);
    utils.broadcastSSE('bookmarks', { bookmarks: state.bookmarks });
    res.json({ success: true, bookmarks: state.bookmarks, bookmark: newBookmark });
  } else {
    res.status(400).json({ error: 'Missing title or url' });
  }
});

// DELETE /api/bookmarks/:id
router.delete('/bookmarks/:id', (req, res) => {
  state.bookmarks = state.bookmarks.filter(b => b.id !== req.params.id);
  utils.broadcastSSE('bookmarks', { bookmarks: state.bookmarks });
  res.json({ success: true, bookmarks: state.bookmarks });
});

// POST /api/control — Media controls and lock screen
router.post('/control', (req, res) => {
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

// GET /api/screenshot
router.get('/screenshot', (req, res) => {
  const { exec } = require('child_process');
  const tempPath = path.join(os.tmpdir(), `airodrop_screenshot_${Date.now()}.png`);
  
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
    
    if (!fs.existsSync(tempPath)) {
      console.error('[SCREENSHOT] File not found after capture');
      return res.status(500).json({ error: 'Screenshot file not found after capture' });
    }

    res.sendFile(tempPath, (sendErr) => {
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

// POST /api/send — UNIFIED: auto-detect text vs image/file
router.post('/send', async (req, res) => {
  try {
    const contentType = req.headers['content-type'] || '';

    // ── Case 1: multipart/form-data (iOS Shortcuts "File" body, or curl -F) ──
    if (contentType.includes('multipart/form-data')) {
      return upload.any()(req, res, async (multerErr) => {
        if (multerErr) {
          return res.status(500).json({ error: 'Multipart upload failed: ' + multerErr.message });
        }

        const files = req.files || [];
        let text = (req.body && (req.body.text || req.body.content)) || '';

        if (files.length > 0) {
          const fileObj = files[0];
          const savedPath = fileObj.path;
          const filename = fileObj.filename;
          const originalName = fileObj.originalname;
          const fileSize = fileObj.size;
          const mimeType = fileObj.mimetype || '';

          const extractedUrl = await utils.tryExtractUrlFromHtmlFile(savedPath, mimeType);
          if (extractedUrl) {
            const clipRes = await utils.handleIncomingText(extractedUrl);
            const item = {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              type: 'text', content: extractedUrl, preview: extractedUrl,
              timestamp: new Date().toISOString(), clipboardSuccess: clipRes.success
            };
            utils.addToHistory(item);
            utils.notifyText(extractedUrl);
            return res.json({ success: true, id: item.id, type: 'text', message: 'URL extracted and copied' });
          }

          const relativePath = path.relative(path.join(__dirname, '..', '..'), savedPath);
          const isImg = mimeType.startsWith('image/');
          let clipResult = { success: false };
          if (isImg) {
            const { copyImage } = require('../../clipboard');
            clipResult = await copyImage(savedPath);
          }

          const item = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            type: isImg ? 'image' : 'file',
            filename, originalName, path: relativePath,
            size: fileSize, mimetype: mimeType,
            timestamp: new Date().toISOString(),
            clipboardSuccess: isImg ? clipResult.success : false
          };
          utils.addToHistory(item);
          isImg ? utils.notifyImage(filename) : utils.notifyText(`Received File: ${originalName}`);
          return res.json({ success: true, id: item.id, type: isImg ? 'image' : 'file', filename });
        }

        if (text) {
          return handleTextSend(text, res);
        }

        return res.status(400).json({ error: 'No file or text provided in multipart body' });
      });
    }

    // ── Case 2: raw binary file (iOS Shortcuts "File" body sends raw bytes with a specific Content-Type) ──
    // Covers: image/*, video/*, audio/*, application/pdf, application/zip, etc.
    const mimeToExt = {
      // Images
      'image/jpeg': '.jpg', 'image/jpg': '.jpg',
      'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp',
      'image/heic': '.heic', 'image/heif': '.heif',
      'image/tiff': '.tiff', 'image/avif': '.avif',
      'image/svg+xml': '.svg',
      // Videos
      'video/mp4': '.mp4', 'video/quicktime': '.mov',
      'video/x-msvideo': '.avi', 'video/webm': '.webm',
      'video/3gpp': '.3gp', 'video/3gpp2': '.3g2',
      'video/mpeg': '.mpeg', 'video/ogg': '.ogv',
      // Audio
      'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
      'audio/ogg': '.ogg', 'audio/wav': '.wav',
      'audio/webm': '.weba', 'audio/aac': '.aac',
      'audio/flac': '.flac', 'audio/x-m4a': '.m4a',
      'audio/x-wav': '.wav',
      // Documents
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.ms-powerpoint': '.ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      // Archives
      'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
      'application/x-rar-compressed': '.rar', 'application/x-7z-compressed': '.7z',
      'application/gzip': '.gz', 'application/x-tar': '.tar',
      // Text & Code
      'text/plain': '.txt', 'text/html': '.html',
      'text/css': '.css', 'application/javascript': '.js',
      'application/json': '.json', 'text/csv': '.csv',
      'text/xml': '.xml', 'application/xml': '.xml',
      // Other
      'application/octet-stream': '.bin',
    };

    const rawMime = contentType.split(';')[0].trim().toLowerCase();
    // Treat as raw binary file if it's NOT a text/form content type
    const isTextContentType = rawMime === 'application/json' ||
                              rawMime === 'application/x-www-form-urlencoded' ||
                              rawMime === 'text/plain' ||
                              rawMime === 'text/html' ||   // Safari Share Sheet sends HTML — extract URL from it
                              rawMime === '' ;
    const isRawBinaryFile = !isTextContentType && rawMime !== '';

    if (isRawBinaryFile) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const buf = Buffer.concat(chunks);
          if (!buf.length) return res.status(400).json({ error: 'Empty file body' });

          // Determine file category and extension
          const isImg   = rawMime.startsWith('image/');
          const isVideo = rawMime.startsWith('video/');
          const isAudio = rawMime.startsWith('audio/');
          const category = isImg ? 'image' : (isVideo ? 'video' : (isAudio ? 'audio' : 'file'));

          const ext = mimeToExt[rawMime] || '.bin';
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const prefix = isImg ? 'photo' : (isVideo ? 'video' : (isAudio ? 'audio' : 'file'));
          const filename = `${timestamp}_${prefix}${ext}`;
          const savedPath = path.join(state.SAVE_DIR, filename);
          fs.writeFileSync(savedPath, buf);

          const relativePath = path.relative(path.join(__dirname, '..', '..'), savedPath);
          let clipResult = { success: false };
          // Only attempt clipboard copy for images on Windows-supported formats
          if (isImg && ['.jpg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) {
            const { copyImage } = require('../../clipboard');
            clipResult = await copyImage(savedPath).catch(() => ({ success: false }));
          }

          const item = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            type: category,
            filename, originalName: filename,
            path: relativePath, size: buf.length, mimetype: rawMime,
            timestamp: new Date().toISOString(), clipboardSuccess: clipResult.success
          };
          utils.addToHistory(item);
          isImg
            ? utils.notifyImage(filename)
            : utils.notifyText(`Received ${category}: ${filename}`);

          return res.json({ success: true, id: item.id, type: category, filename, message: `${category} received` });
        } catch (e) {
          return res.status(500).json({ error: e.message });
        }
      });
      req.on('error', e => res.status(500).json({ error: e.message }));
      return; // response sent inside 'end' handler above
    }

    // ── Case 3: urlencoded / json text (iOS Shortcuts "Form" body with key content or text) ──
    const rawParser = require('express').raw({ type: '*/*', limit: '50mb' });
    const jsonParser = require('express').json({ limit: '10mb' });
    const urlencodedParser = require('express').urlencoded({ extended: true, limit: '10mb' });

    const parseBody = (parserFn) => new Promise((resolve, reject) => {
      parserFn(req, res, (err) => err ? reject(err) : resolve());
    });

    try {
      if (contentType.includes('application/json')) {
        await parseBody(jsonParser);
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        await parseBody(urlencodedParser);
      } else {
        await parseBody(rawParser);
      }
    } catch (parseErr) {
      return res.status(400).json({ error: 'Failed to parse body: ' + parseErr.message });
    }

    let text = '';
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      text = req.body.text || req.body.content || '';
    } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      // Last resort: check magic bytes for raw binary that didn't have image/* content-type
      const detectedMime = utils.isBufferImage(req.body);
      if (detectedMime) {
        const ext = mimeToExt[detectedMime] || '.jpg';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `${timestamp}_photo${ext}`;
        const savedPath = path.join(state.SAVE_DIR, filename);
        fs.writeFileSync(savedPath, req.body);
        const relativePath = path.relative(path.join(__dirname, '..', '..'), savedPath);
        const { copyImage } = require('../../clipboard');
        const clipResult = await copyImage(savedPath);
        const item = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          type: 'image', filename, originalName: filename,
          path: relativePath, size: req.body.length, mimetype: detectedMime,
          timestamp: new Date().toISOString(), clipboardSuccess: clipResult.success
        };
        utils.addToHistory(item);
        utils.notifyImage(filename);
        return res.json({ success: true, id: item.id, type: 'image', message: 'Photo received' });
      }
      text = req.body.toString('utf8');
    }

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'No text or file provided' });
    }

    return handleTextSend(text, res);

  } catch (err) {
    console.error('[UNIFIED-SEND] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function handleTextSend(text, res) {
  // HTML / web-page URL extraction
  if (typeof text === 'string' && (text.trim().startsWith('<') || text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().includes('<html'))) {
    const canonicalMatch = text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
                           text.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
    const ogMatch = text.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) ||
                    text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
    const twitterMatch = text.match(/<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/i);

    let extractedUrl = (canonicalMatch && canonicalMatch[1]) || (ogMatch && ogMatch[1]) || (twitterMatch && twitterMatch[1]);
    if (!extractedUrl) {
      const allUrls = text.match(/https?:\/\/[^\s"'<>()\]]+/gi);
      if (allUrls) {
        const cleanUrl = allUrls.find(u => {
          const low = u.toLowerCase();
          return !low.endsWith('.js') && !low.endsWith('.css') &&
                 !low.endsWith('.png') && !low.endsWith('.jpg') &&
                 !low.endsWith('.jpeg') && !low.endsWith('.gif') &&
                 !low.endsWith('.svg') && !low.endsWith('.woff') &&
                 !low.endsWith('.woff2') &&
                 !low.includes('schema.org') && !low.includes('w3.org');
        });
        if (cleanUrl) extractedUrl = cleanUrl;
      }
    }
    if (extractedUrl) text = extractedUrl;
  }

  const clipResult = await require('../utils').handleIncomingText(text);
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: 'text',
    content: text,
    preview: text.length > 200 ? text.substring(0, 200) + '...' : text,
    timestamp: new Date().toISOString(),
    clipboardSuccess: clipResult.success
  };
  require('../utils').addToHistory(item);
  require('../utils').notifyText(text);
  return res.json({ success: true, id: item.id, type: 'text', message: 'Text synced' });
}

module.exports = router;
