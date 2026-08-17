const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const state = require('../state');
const utils = require('../utils');
const { sanitizeFilename, sanitizeText } = require('../sanitize');
const { getLogger } = require('../logger');
const asyncHandler = require('../asyncHandler');
const vlcController = require('../vlcController');

const logger = getLogger();

function getRawBinaryFilename(req, rawMime, fallbackPrefix) {
  let originalNameHeader = req.headers['x-filename'] || '';
  if (!originalNameHeader && req.headers['content-disposition']) {
    const match = req.headers['content-disposition'].match(/filename\*?=["']?([^"';]+)/i);
    if (match && match[1]) {
      try {
        originalNameHeader = decodeURIComponent(match[1].trim());
      } catch {
        originalNameHeader = match[1].trim();
      }
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  
  if (originalNameHeader) {
    // Use sanitize module for safe filename handling
    const sanitized = sanitizeFilename(originalNameHeader, fallbackPrefix);
    const ext = path.extname(sanitized) || '.bin';
    const base = path.basename(sanitized, ext);
    let cleanBase = base.slice(0, 15).trim();
    return {
      filename: `${cleanBase || fallbackPrefix}_${timestamp}${ext}`,
      originalName: originalNameHeader
    };
  } else {
    const mimeToExt = {
      'image/jpeg': '.jpg', 'image/jpg': '.jpg',
      'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp',
      'image/heic': '.heic', 'image/heif': '.heif',
      'image/tiff': '.tiff', 'image/avif': '.avif',
      'image/svg+xml': '.svg',
      'video/mp4': '.mp4', 'video/quicktime': '.mov',
      'video/x-msvideo': '.avi', 'video/webm': '.webm',
      'video/3gpp': '.3gp', 'video/3gpp2': '.3g2',
      'video/mpeg': '.mpeg', 'video/ogg': '.ogv',
      'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
      'audio/ogg': '.ogg', 'audio/wav': '.wav',
      'audio/webm': '.weba', 'audio/aac': '.aac',
      'audio/flac': '.flac', 'audio/x-m4a': '.m4a',
      'audio/x-wav': '.wav',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.ms-powerpoint': '.ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
      'application/x-rar-compressed': '.rar', 'application/x-7z-compressed': '.7z',
      'application/gzip': '.gz', 'application/x-tar': '.tar',
      'text/plain': '.txt', 'text/html': '.html',
      'text/css': '.css', 'application/javascript': '.js',
      'application/json': '.json', 'text/csv': '.csv',
      'text/xml': '.xml', 'application/xml': '.xml',
      'application/octet-stream': '.bin',
    };
    const ext = mimeToExt[rawMime] || '.bin';
    const filename = `${fallbackPrefix}_${timestamp}${ext}`;
    return {
      filename,
      originalName: filename
    };
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isTemp = state.TEMPORARY_MODE || req.headers['x-temp-mode'] === 'true' || req.query.temp === 'true';
    const targetDir = (isTemp && state.TEMP_DIR) ? state.TEMP_DIR : state.SAVE_DIR;
    if (!fs.existsSync(targetDir)) {
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch (_) {}
    }
    cb(null, targetDir);
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

    // Sanitize text input (strip null bytes, enforce max length)
    const sanitized = sanitizeText(text);
    if (!sanitized.valid) {
      return res.status(400).json({ error: 'Invalid text content' });
    }
    text = sanitized.text;

    // HTML Web Page detection & URL extraction
    if (typeof text === 'string' && (text.trim().startsWith('<') || text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().includes('<html'))) {
      const extractedUrl = utils.extractUrlFromHtml(text);
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

    logger.info('Text received', { preview: text.substring(0, 60) });
    res.json({ success: true, id: item.id, message: 'Text received and copied to clipboard' });
  } catch (err) {
    logger.error('Text receive failed', { error: err.message, requestId: req.requestId });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/image, /api/file & /api/clipboard/file — Receive image or generic file from iPhone/iOS Shortcuts
router.post(['/image', '/file', '/clipboard/file'], upload.any(), async (req, res) => {
  try {
    let savedPath;
    let filename;
    let originalName;
    let fileSize;
    let mimeType;

    let fileObj = null;
    if (req.files) {
      if (Array.isArray(req.files) && req.files.length > 0) {
        fileObj = req.files[0];
      } else if (typeof req.files === 'object') {
        const keys = Object.keys(req.files);
        if (keys.length > 0 && req.files[keys[0]].length > 0) {
          fileObj = req.files[keys[0]][0];
        }
      }
    }

    const isTemp = state.TEMPORARY_MODE || req.headers['x-temp-mode'] === 'true' || req.query.temp === 'true';

    if (fileObj) {
      savedPath = fileObj.path;
      filename = fileObj.filename;
      originalName = fileObj.originalname;
      fileSize = fileObj.size;
      mimeType = fileObj.mimetype;
    } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      const contentType = req.headers['content-type'] || 'application/octet-stream';
      const cleanType = contentType.split(';')[0].trim().toLowerCase();
      const detectedMime = utils.isBufferImage(req.body) || cleanType;
      
      const fileInfo = getRawBinaryFilename(req, detectedMime, 'uploaded');
      filename = fileInfo.filename;
      originalName = fileInfo.originalName;
      const targetDir = isTemp ? state.TEMP_DIR : state.SAVE_DIR;
      savedPath = path.join(targetDir, filename);
      fileSize = req.body.length;
      mimeType = detectedMime;

      fs.writeFileSync(savedPath, req.body);
    } else {
      return res.status(400).json({ error: 'No file or binary buffer provided.' });
    }

    if (isTemp && savedPath && fs.existsSync(savedPath)) {
      const targetTempPath = path.join(state.TEMP_DIR, filename);
      if (path.resolve(savedPath) !== path.resolve(targetTempPath)) {
        try {
          fs.renameSync(savedPath, targetTempPath);
          savedPath = targetTempPath;
        } catch (_) {
          try {
            fs.copyFileSync(savedPath, targetTempPath);
            fs.unlinkSync(savedPath);
            savedPath = targetTempPath;
          } catch (_) {}
        }
      }
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
      logger.info('URL extracted from uploaded file', { url: extractedUrl });
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
      path: savedPath,
      size: fileSize,
      mimetype: mimeType,
      timestamp: new Date().toISOString(),
      clipboardSuccess: isImg ? clipResult.success : false,
      isTemporary: isTemp,
      userSaved: !isTemp
    };
    utils.addToHistory(item);

    if (isImg) {
      utils.notifyImage(filename);
    } else {
      utils.notifyText(`Received File: ${originalName}`);
    }

    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    logger.info('File received', { filename, size: `${sizeMB}MB` });
    res.json({
      success: true,
      id: item.id,
      filename: filename,
      path: relativePath,
      type: isImg ? 'image' : 'file',
      message: isImg ? 'Image saved successfully' : 'File saved successfully'
    });
  } catch (err) {
    logger.error('File receive failed', { error: err.message, requestId: req.requestId });
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

let isLastClipboardInitialized = false;

// GET /api/clipboard — Read unified clipboard (queues first, fallback to PC clipboard)
router.get('/clipboard', async (req, res) => {
  try {
    const { readText } = require('../../clipboard');
    const result = await readText();
    const currentClipboardText = (result.success && result.text) ? result.text : '';

    // Initialize lastPcClipboardText on first request so it doesn't trigger false copy event
    if (!isLastClipboardInitialized) {
      state.lastPcClipboardText = currentClipboardText;
      isLastClipboardInitialized = true;
    }

    // 1. Detect if a NEW text was copied to the PC system clipboard
    if (currentClipboardText && currentClipboardText.trim().length > 0 && currentClipboardText !== state.lastPcClipboardText) {
      state.lastPcClipboardText = currentClipboardText;
      
      // If a new text was copied, replace any pending photo/file metadata with this text metadata
      state.pendingForPhone = [];
      
      return res.json({
        success: true,
        type: 'text',
        mimeType: 'text/plain',
        text: currentClipboardText
      });
    }

    // 2. Check explicit queue if clipboard hasn't changed
    if (state.pendingForPhone && state.pendingForPhone.length > 0) {
      const latestItem = state.pendingForPhone[0]; // first item is the most recent
      if (latestItem.type === 'file' || latestItem.type === 'image') {
        const localIP = utils.getLocalIP();
        const httpPort = parseInt(state.PORT, 10) + 1; // fallback HTTP port
        const folder = latestItem.isOutgoing ? 'shared' : 'received';
        const downloadUrl = `http://${localIP}:${httpPort}/${folder}/${latestItem.filename}`;
        
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

    // 3. Fallback to reading the system clipboard (if queue is empty and text hasn't changed, but still present)
    if (currentClipboardText && currentClipboardText.trim().length > 0) {
      return res.json({
        success: true,
        type: 'text',
        mimeType: 'text/plain',
        text: currentClipboardText
      });
    }

    // 4. Both are empty
    res.json({
      success: false,
      message: 'Clipboard is empty'
    });
  } catch (err) {
    logger.error('Clipboard read failed', { error: err.message });
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
      const folder = latestFile.isOutgoing ? 'shared' : 'received';
      const downloadUrl = `http://${localIP}:${httpPort}/${folder}/${latestFile.filename}`;
      res.json({
        success: true,
        filename: latestFile.originalName || latestFile.filename,
        url: downloadUrl
      });
    } else {
      res.status(404).json({ success: false, error: 'No pending files found' });
    }
  } catch (err) {
    logger.error('Latest file fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/save-file — Save a temporary received file permanently to state.SAVE_DIR
router.post('/save-file', express.json(), (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'File ID is required' });

    const item = state.history.find(i => i.id == id);
    if (!item) return res.status(404).json({ error: 'Item not found in history' });

    if (item.userSaved && !item.isTemporary) {
      return res.json({ success: true, message: 'File is already permanently saved', item });
    }

    const filename = item.filename || (item.path ? path.basename(item.path) : null);
    if (!filename) return res.status(400).json({ error: 'Item missing filename' });

    // Locate source file on disk
    let sourcePath = null;
    const candidates = [
      item.path,
      state.TEMP_DIR ? path.join(state.TEMP_DIR, filename) : null,
      path.join(__dirname, '..', '..', item.path || ''),
      path.join(state.SAVE_DIR, filename)
    ].filter(Boolean);

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        sourcePath = cand;
        break;
      }
    }

    if (!sourcePath) {
      logger.error('Save file failed: temporary file missing from disk', { filename, itemPath: item.path, tempDir: state.TEMP_DIR });
      return res.status(404).json({ error: `File "${filename}" missing from temporary storage. Save failed.` });
    }

    // Ensure permanent SAVE_DIR exists
    if (!fs.existsSync(state.SAVE_DIR)) {
      fs.mkdirSync(state.SAVE_DIR, { recursive: true });
    }

    const savePath = path.join(state.SAVE_DIR, filename);

    // Copy or move file to SAVE_DIR
    if (path.resolve(sourcePath) !== path.resolve(savePath)) {
      try {
        fs.copyFileSync(sourcePath, savePath);
        if (state.TEMP_DIR && sourcePath.startsWith(state.TEMP_DIR)) {
          try { fs.unlinkSync(sourcePath); } catch (_) {}
        }
      } catch (copyErr) {
        logger.error('Failed to copy file to permanent SAVE_DIR', { sourcePath, savePath, error: copyErr.message });
        return res.status(500).json({ error: `Failed to move file to download folder: ${copyErr.message}` });
      }
    }

    // VERIFY file exists in SAVE_DIR before updating state!
    if (!fs.existsSync(savePath)) {
      logger.error('Save verification failed: file missing after copy', { savePath });
      return res.status(500).json({ error: 'File save failed: file was not found in download folder after copy.' });
    }

    item.isTemporary = false;
    item.userSaved = true;
    item.path = savePath;
    item.fileDeletedOnDisk = false;

    utils.saveHistory();
    utils.broadcastSSE('history-update', state.history);

    logger.info('File saved permanently to download folder', { filename, savePath, id });
    res.json({ success: true, message: 'File saved permanently to download folder', item });
  } catch (err) {
    logger.error('Failed to save file permanently', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history — Return received items list
router.get('/history', (req, res) => {
  utils.purgeExpiredHistory();
  let changed = false;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const item = state.history[i];
    if (item.type === 'image' || item.type === 'file') {
      const isTemp = item.isTemporary && !item.userSaved;
      const fullPath = item.filename 
        ? (isTemp ? path.join(state.TEMP_DIR, item.filename) : path.join(state.SAVE_DIR, item.filename))
        : (path.isAbsolute(item.path) ? item.path : path.resolve(path.join(__dirname, '..', '..'), item.path));
      if (!fs.existsSync(fullPath)) {
        logger.debug('History cleanup: file missing from disk', { filename: item.filename || item.id });
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

// DELETE /api/history — Clear history (and optionally files)
router.delete('/history', (req, res) => {
  try {
    const deleteFiles = req.query.files === 'true';
    if (deleteFiles) {
      for (const item of state.history) {
        if (item.filename) {
          const fullPath = path.join(state.SAVE_DIR, item.filename);
          try {
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
          } catch (e) {
            logger.warn('Failed to delete file during history clear', { filename: item.filename, error: e.message });
          }
        }
      }
    }
    state.history.length = 0;
    utils.saveHistory();
    utils.broadcastSSE('clear', {});
    res.json({ success: true, message: deleteFiles ? 'All history and files cleared' : 'All history cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/history/:id — Delete or dismiss a single history item
router.delete('/history/:id', (req, res) => {
  try {
    const id = req.params.id;
    const keepFile = req.query.keepFile === 'true';
    const index = state.history.findIndex(item => item.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const item = state.history[index];
    
    // Only delete file from disk if keepFile is NOT set
    if (!keepFile && item.filename) {
      const isTemp = item.isTemporary && !item.userSaved;
      const fullPath = item.filename 
        ? (isTemp ? path.join(state.TEMP_DIR, item.filename) : path.join(state.SAVE_DIR, item.filename)) 
        : (path.isAbsolute(item.path) ? item.path : path.resolve(path.join(__dirname, '..', '..'), item.path));
      try {
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          logger.debug('Deleted file from disk', { filename: item.filename });
        }
      } catch (e) {
        logger.warn('Failed to delete file from disk', { filename: item.filename, error: e.message });
      }
    }
    
    state.history.splice(index, 1);
    utils.saveHistory();
    utils.broadcastSSE('history-update', state.history);
    res.json({ success: true, message: keepFile ? 'Card cleared from feed' : 'Item deleted' });
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
  const raw = req.body.text || "";
  const sanitized = sanitizeText(raw, 1 * 1024 * 1024); // 1 MB max for scratchpad
  state.scratchpadText = sanitized.text;
  try {
    fs.writeFileSync(state.SCRATCHPAD_FILE, state.scratchpadText || "", 'utf8');
  } catch (err) {
    logger.warn('Scratchpad save failed', { error: err.message });
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

// GET /api/control/vlc-status — Retrieve active VLC media player playback info
router.get('/control/vlc-status', (req, res) => {
  const vlc = vlcController.findVlcWindow();
  if (vlc) {
    res.json({ running: true, title: vlc.title });
  } else {
    res.json({ running: false, title: '' });
  }
});

// POST /api/control — Media controls and lock screen
router.post('/control', (req, res) => {
  const { action } = req.body;
  const { exec } = require('child_process');
  
  if (action && action.startsWith('vlc_')) {
    const success = vlcController.sendVlcAction(action);
    if (success) {
      logger.info('VLC action triggered', { action });
      return res.json({ success: true, action });
    } else {
      return res.status(400).json({ error: 'VLC player is not running or action failed' });
    }
  }
  
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
      logger.error('Control action failed', { action, error: err.message });
      return res.status(500).json({ error: `Action failed: ${err.message}` });
    }
    logger.info('Control action triggered', { action });
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
      logger.error('Screenshot capture failed', { error: err.message });
      return res.status(500).json({ error: 'Screenshot capture failed: ' + err.message });
    }
    
    if (!fs.existsSync(tempPath)) {
      logger.error('Screenshot file not found after capture');
      return res.status(500).json({ error: 'Screenshot file not found after capture' });
    }

    res.sendFile(tempPath, (sendErr) => {
      try {
        fs.unlinkSync(tempPath);
      } catch (unlinkErr) {
        logger.warn('Screenshot temp file cleanup failed', { error: unlinkErr.message });
      }
      if (sendErr) {
        logger.error('Screenshot send failed', { error: sendErr.message });
      }
    });
  });
});

// POST /api/send, /api/clipboard — UNIFIED: auto-detect text vs image/file from iOS Shortcuts
router.post(['/send', '/clipboard', '/clipboard/send'], async (req, res) => {
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

          const isTemp = state.TEMPORARY_MODE || req.headers['x-temp-mode'] === 'true' || req.query.temp === 'true';
          const item = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            type: isImg ? 'image' : 'file',
            filename, originalName, path: savedPath,
            size: fileSize, mimetype: mimeType,
            timestamp: new Date().toISOString(),
            clipboardSuccess: isImg ? clipResult.success : false,
            isTemporary: isTemp,
            userSaved: !isTemp
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
          const prefix = isImg ? 'photo' : (isVideo ? 'video' : (isAudio ? 'audio' : 'file'));
          const fileInfo = getRawBinaryFilename(req, rawMime, prefix);
          const filename = fileInfo.filename;
          const originalName = fileInfo.originalName;
          const isTemp = state.TEMPORARY_MODE || req.headers['x-temp-mode'] === 'true' || req.query.temp === 'true';
          const targetDir = (isTemp && state.TEMP_DIR) ? state.TEMP_DIR : state.SAVE_DIR;
          const savedPath = path.join(targetDir, filename);
          fs.writeFileSync(savedPath, buf);

          let clipResult = { success: false };
          // Only attempt clipboard copy for images on Windows-supported formats
          const ext = path.extname(filename).toLowerCase();
          if (isImg && ['.jpg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) {
            const { copyImage } = require('../../clipboard');
            clipResult = await copyImage(savedPath).catch(() => ({ success: false }));
          }

          const item = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            type: category,
            filename, originalName,
            path: savedPath, size: buf.length, mimetype: rawMime,
            timestamp: new Date().toISOString(), clipboardSuccess: clipResult.success,
            isTemporary: isTemp,
            userSaved: !isTemp
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
        const fileInfo = getRawBinaryFilename(req, detectedMime, 'photo');
        const filename = fileInfo.filename;
        const originalName = fileInfo.originalName;
        const isTemp = state.TEMPORARY_MODE || req.headers['x-temp-mode'] === 'true' || req.query.temp === 'true';
        const targetDir = (isTemp && state.TEMP_DIR) ? state.TEMP_DIR : state.SAVE_DIR;
        const savedPath = path.join(targetDir, filename);
        fs.writeFileSync(savedPath, req.body);
        const { copyImage } = require('../../clipboard');
        const clipResult = await copyImage(savedPath);
        const item = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          type: 'image', filename, originalName,
          path: savedPath, size: req.body.length, mimetype: detectedMime,
          timestamp: new Date().toISOString(), clipboardSuccess: clipResult.success,
          isTemporary: isTemp,
          userSaved: !isTemp
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
    logger.error('Unified send failed', { error: err.message, requestId: req.requestId });
    res.status(500).json({ error: err.message });
  }
});

async function handleTextSend(text, res) {
  // HTML / web-page URL extraction
  if (typeof text === 'string' && (text.trim().startsWith('<') || text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().includes('<html'))) {
    const extractedUrl = utils.extractUrlFromHtml(text);
    if (extractedUrl) {
      text = extractedUrl;
    }
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

// PUT /api/history/:id — Update text item content
router.put('/history/:id', express.json(), (req, res) => {
  const { id } = req.params;
  const { content } = req.body || {};
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'Content string required' });
  }

  const item = state.history.find(i => String(i.id) === String(id));
  if (item) {
    item.content = content;
    item.text = content;
    item.preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
    item.lastModified = new Date().toISOString();
    utils.saveHistory();
    utils.broadcastSSE('history-update', state.history);
  }

  // Also update in Clipboard Vault if present
  const vaultItem = state.clipboardVault.find(i => String(i.id) === String(id));
  if (vaultItem) {
    vaultItem.content = content;
    vaultItem.text = content;
    vaultItem.lastModified = new Date().toISOString();
    utils.saveClipboardVault();
    utils.broadcastSSE('clipboard-vault-update', { count: state.clipboardVault.length });
  }

  if (!item && !vaultItem) {
    return res.status(404).json({ error: 'Item not found' });
  }

  return res.json({ success: true, item: item || vaultItem });
});

// ─── Dedicated Clipboard Vault Endpoints ──────────────────

// GET /api/clipboard/vault — Return list of vault items
router.get('/clipboard/vault', (req, res) => {
  // If vault is empty but history has text items, seed vault from history
  if (state.clipboardVault.length === 0 && state.history.length > 0) {
    const textItems = state.history.filter(i => i.type === 'text' || i.type === 'url' || i.content || i.text);
    if (textItems.length > 0) {
      state.clipboardVault.push(...textItems);
      utils.saveClipboardVault();
    }
  }

  const since = req.query.since;
  let items = state.clipboardVault;
  if (since) {
    items = state.clipboardVault.filter(item => item.timestamp > since);
  }
  res.json({ success: true, items, total: state.clipboardVault.length });
});

// POST /api/clipboard/vault — Add new snippet directly to vault
router.post('/clipboard/vault', express.json(), (req, res) => {
  const { text, content } = req.body || {};
  const rawText = content || text || '';
  if (!rawText || typeof rawText !== 'string') {
    return res.status(400).json({ error: 'Text content is required' });
  }

  const isUrl = /^https?:\/\//i.test(rawText.trim());
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: isUrl ? 'url' : 'text',
    content: rawText,
    text: rawText,
    timestamp: new Date().toISOString(),
    deviceName: 'PC Host',
    ip: '127.0.0.1'
  };

  utils.addToClipboardVault(item);
  res.json({ success: true, item });
});

// PUT /api/clipboard/vault/:id — Update a vault snippet
router.put('/clipboard/vault/:id', express.json(), (req, res) => {
  const { id } = req.params;
  const { content, text } = req.body || {};
  const rawText = content !== undefined ? content : text;
  if (typeof rawText !== 'string') {
    return res.status(400).json({ error: 'Content string required' });
  }

  const vaultItem = state.clipboardVault.find(i => String(i.id) === String(id));
  if (!vaultItem) {
    return res.status(404).json({ error: 'Vault item not found' });
  }

  const isUrl = /^https?:\/\//i.test(rawText.trim());
  vaultItem.content = rawText;
  vaultItem.text = rawText;
  vaultItem.type = isUrl ? 'url' : 'text';
  vaultItem.lastModified = new Date().toISOString();
  utils.saveClipboardVault();

  // Also update in history if present
  const historyItem = state.history.find(i => String(i.id) === String(id));
  if (historyItem) {
    historyItem.content = rawText;
    historyItem.text = rawText;
    historyItem.type = isUrl ? 'url' : 'text';
    historyItem.preview = rawText.length > 200 ? rawText.substring(0, 200) + '...' : rawText;
    utils.saveHistory();
    utils.broadcastSSE('history-update', state.history);
  }

  utils.broadcastSSE('clipboard-vault-update', { count: state.clipboardVault.length });
  return res.json({ success: true, item: vaultItem });
});

// DELETE /api/clipboard/vault/:id — Delete a snippet from vault (and from history if present)
router.delete('/clipboard/vault/:id', (req, res) => {
  const { id } = req.params;
  const vaultIndex = state.clipboardVault.findIndex(i => String(i.id) === String(id));
  if (vaultIndex !== -1) {
    state.clipboardVault.splice(vaultIndex, 1);
    utils.saveClipboardVault();
  }

  // Also delete from history if present
  const historyIndex = state.history.findIndex(i => String(i.id) === String(id));
  if (historyIndex !== -1) {
    state.history.splice(historyIndex, 1);
    utils.saveHistory();
    utils.broadcastSSE('history-update', state.history);
  }

  utils.broadcastSSE('clipboard-vault-update', { count: state.clipboardVault.length });
  return res.json({ success: true, message: 'Snippet deleted' });
});

// DELETE /api/clipboard/vault — Clear entire vault
router.delete('/clipboard/vault', (req, res) => {
  state.clipboardVault.length = 0;
  utils.saveClipboardVault();
  utils.broadcastSSE('clipboard-vault-update', { count: 0 });
  return res.json({ success: true, message: 'Clipboard vault cleared' });
});

module.exports = router;
