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
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
    cb(null, `${timestamp}_${safeName || 'file'}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
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
router.post('/send', upload.any(), async (req, res) => {
  try {
    let text = req.body.text || '';
    let files = req.files || [];

    if (req.body.text === undefined && req.body.content === undefined && files.length === 0) {
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        const detectedMime = utils.isBufferImage(req.body);
        if (detectedMime) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const filename = `${timestamp}_raw_image.jpg`;
          const savedPath = path.join(state.SAVE_DIR, filename);
          fs.writeFileSync(savedPath, req.body);
          
          const clipRes = await copyImage(savedPath);
          const relativePath = path.relative(path.join(__dirname, '..', '..'), savedPath);

          const item = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            type: 'image',
            filename: filename,
            originalName: filename,
            path: relativePath,
            size: req.body.length,
            mimetype: 'image/jpeg',
            timestamp: new Date().toISOString(),
            clipboardSuccess: clipRes.success
          };
          utils.addToHistory(item);
          utils.notifyImage(filename);

          return res.json({ success: true, id: item.id, type: 'image', message: 'Image received and saved' });
        } else {
          text = req.body.toString('utf8');
        }
      }
    }

    if (files.length > 0) {
      const fileObj = files[0];
      const savedPath = fileObj.path;
      const filename = fileObj.filename;
      const originalName = fileObj.originalname;
      const fileSize = fileObj.size;
      const mimeType = fileObj.mimetype;

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
        return res.json({ success: true, id: item.id, type: 'text', message: 'URL extracted and copied' });
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

      return res.json({ success: true, id: item.id, type: isImg ? 'image' : 'file', filename });
    }

    if (text) {
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
            if (cleanUrl) extractedUrl = cleanUrl;
          }
        }
        if (extractedUrl) text = extractedUrl;
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

      return res.json({ success: true, id: item.id, type: 'text', message: 'Text synced' });
    }

    res.status(400).json({ error: 'No text or file provided' });
  } catch (err) {
    console.error('[UNIFIED-SEND] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
