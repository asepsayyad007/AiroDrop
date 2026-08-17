const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const state = require('../state');
const { sanitizeFilename, validatePath } = require('../sanitize');
const { getLogger } = require('../logger');

const logger = getLogger();

function safePath(relPath) {
  let cleanRel = (typeof relPath === 'string') ? relPath.trim() : '';

  // Strip query string if accidentally attached to path param
  if (cleanRel.includes('?')) {
    cleanRel = cleanRel.split('?')[0];
  }

  // Normalize path separators
  cleanRel = cleanRel.replace(/\\/g, '/');

  // Normalize folder prefixes
  if (cleanRel.startsWith('/shared/')) {
    cleanRel = '__shared__/' + cleanRel.slice(8);
  } else if (cleanRel.startsWith('/received/')) {
    cleanRel = '__received__/' + cleanRel.slice(10);
  }

  // Handle __received__/ or __shared__/ prefix for files
  if (cleanRel.startsWith('__received__/') || cleanRel.startsWith('__shared__/')) {
    const fn = cleanRel.replace(/^__(received|shared)__\//, '');
    
    // 1. Check SHARE_DIR (outgoing files queued for phone)
    if (state.SHARE_DIR) {
      const shareCheck = validatePath(fn, state.SHARE_DIR);
      if (shareCheck.valid && fs.existsSync(shareCheck.resolved)) return shareCheck.resolved;
    }
    // 2. Check SAVE_DIR (received files)
    if (state.SAVE_DIR) {
      const saveCheck = validatePath(fn, state.SAVE_DIR);
      if (saveCheck.valid && fs.existsSync(saveCheck.resolved)) return saveCheck.resolved;
    }
    // 3. Check TEMP_DIR (temporary files)
    if (state.TEMP_DIR) {
      const tempCheck = validatePath(fn, state.TEMP_DIR);
      if (tempCheck.valid && fs.existsSync(tempCheck.resolved)) return tempCheck.resolved;
    }
  }

  const activeDir = state.SHARE_DIR || state.SAVE_DIR;

  // Ensure activeDir exists
  if (activeDir && !fs.existsSync(activeDir)) {
    try { fs.mkdirSync(activeDir, { recursive: true }); } catch (_) {}
  }

  if (activeDir) {
    const shareResult = validatePath(cleanRel, activeDir);
    if (shareResult.valid && fs.existsSync(shareResult.resolved)) {
      return shareResult.resolved;
    }
  }

  // Fallback: check SHARE_DIR, SAVE_DIR and TEMP_DIR for bare filenames or relative paths
  if (cleanRel) {
    if (state.SHARE_DIR) {
      const shareCheck = validatePath(cleanRel, state.SHARE_DIR);
      if (shareCheck.valid && fs.existsSync(shareCheck.resolved)) return shareCheck.resolved;
    }
    if (state.SAVE_DIR) {
      const saveCheck = validatePath(cleanRel, state.SAVE_DIR);
      if (saveCheck.valid && fs.existsSync(saveCheck.resolved)) return saveCheck.resolved;
    }
    if (state.TEMP_DIR) {
      const tempCheck = validatePath(cleanRel, state.TEMP_DIR);
      if (tempCheck.valid && fs.existsSync(tempCheck.resolved)) return tempCheck.resolved;
    }
  }

  return (activeDir && fs.existsSync(activeDir)) ? activeDir : null;
}

// Serve file browser html
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'files.html'));
});

// JSON directory listing
router.get('/browse', (req, res) => {
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

// MIME type dictionary for universal streaming and inline rendering
const FILE_MIME_TYPES = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  // Video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  // Documents & text
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
};

// Download or stream a file (supports instant HTTP 206 Range scrubbing & playback)
router.get('/download', (req, res) => {
  const rel = req.query.path || '';
  const target = safePath(rel);
  if (!target) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot download a folder' });
  
  const ext = path.extname(target).toLowerCase();
  const filename = path.basename(target);
  const contentType = FILE_MIME_TYPES[ext] || 'application/octet-stream';
  const isAttachment = req.query.download === 'true';
  const range = req.headers.range;

  if (range) {
    // 206 Partial Content Range Streaming for Video/Audio Scrubbing
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    
    if (start >= stat.size || end >= stat.size) {
      res.writeHead(416, {
        'Content-Range': `bytes */${stat.size}`
      });
      return res.end();
    }

    const chunksize = (end - start) + 1;
    const fileStream = fs.createReadStream(target, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Content-Disposition': isAttachment ? `attachment; filename="${encodeURIComponent(filename)}"` : 'inline'
    });
    fileStream.pipe(res);
  } else {
    // Full File Streaming / Serving with Accept-Ranges
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': isAttachment ? `attachment; filename="${encodeURIComponent(filename)}"` : 'inline',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(target).pipe(res);
  }
});

// Upload chunk for pause/resume/cancel support
router.post('/upload-chunk', (req, res) => {
  const relPath = req.query.path || '';
  const fileName = sanitizeFilename(req.query.name || '', 'upload');
  const chunkIndex = parseInt(req.query.index, 10);
  const totalChunks = parseInt(req.query.total, 10);
  
  if (!fileName || fileName === 'upload') return res.status(400).json({ error: 'Missing file name' });
  
  const targetDir = safePath(relPath);
  if (!targetDir) return res.status(403).json({ error: 'Access denied' });
  
  const finalPath = path.join(targetDir, fileName);
  const chunkPath = finalPath + '.part.' + chunkIndex;
  
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const writeStream = fs.createWriteStream(chunkPath);
    req.pipe(writeStream);
    
    writeStream.on('finish', async () => {
      if (res.headersSent) return;
      try {
        if (chunkIndex === totalChunks - 1) {
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
            logger.error('File chunk merge failed', { filename: fileName, error: mergeErr.message });
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
        logger.error('Chunk upload finalization error', { error: err.message });
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        }
      }
    });
    
    writeStream.on('error', (err) => {
      logger.error('Chunk write stream error', { filename: fileName, error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel chunk upload
router.post('/upload-cancel', (req, res) => {
  const relPath = req.body.path || '';
  const fileName = sanitizeFilename(req.body.name || '', '');
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

// Upload files to a folder via Multer
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
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      cb(null, name);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10 GB max
});

router.post('/upload', (req, res) => {
  uploadToShare.array('files')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    const uploaded = (req.files || []).map(f => f.filename);
    res.json({ success: true, uploaded });
  });
});

// Create folder
router.post('/mkdir', (req, res) => {
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

// Delete folder/file
router.delete('/delete', (req, res) => {
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
router.patch('/rename', (req, res) => {
  const rel = req.body.path || '';
  const newName = sanitizeFilename(req.body.newName || '', '');
  const target = safePath(rel);
  if (!target || !newName) return res.status(400).json({ error: 'Invalid request' });
  const dir = path.dirname(target);
  const dest = path.join(dir, newName);
  if (!dest.startsWith(path.resolve(state.SHARE_DIR))) return res.status(403).json({ error: 'Access denied' });
  try {
    fs.renameSync(target, dest);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /files/download-page?files=BASE64_JSON — Standalone multi-file download page
router.get('/download-page', (req, res) => {
  let filePaths = [];
  try {
    const raw = req.query.files || '';
    filePaths = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!Array.isArray(filePaths)) filePaths = [];
  } catch (e) {
    return res.status(400).send('Invalid file list.');
  }

  const origin = `${req.protocol}://${req.headers.host}`;
  const pageUrl = `${origin}${req.originalUrl}`;

  // Extract the device token so we can embed it in download links on the page
  // This allows Safari to authenticate when opening the link without re-logging in
  const { extractToken } = require('../auth');
  const deviceToken = extractToken(req) || '';
  const tokenSuffix = deviceToken ? `&token=${encodeURIComponent(deviceToken)}` : '';

  const fileInfos = filePaths.map(rel => {
    const target = safePath(rel);
    if (!target || !fs.existsSync(target)) return { rel, name: path.basename(rel), size: 0, valid: false };
    try {
      const stat = fs.statSync(target);
      return { rel, name: path.basename(rel), size: stat.size, valid: !stat.isDirectory() };
    } catch (e) {
      return { rel, name: path.basename(rel), size: 0, valid: false };
    }
  }).filter(f => f.valid);

  function fmtSize(b) {
    if (!b) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  function fileIconSvg(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['jpg','jpeg','png','gif','webp','svg','heic','bmp'].includes(ext))
      return `<svg viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    if (['mp4','mov','avi','mkv','webm','m4v'].includes(ext))
      return `<svg viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`;
    if (['mp3','wav','m4a','flac','aac','ogg'].includes(ext))
      return `<svg viewBox="0 0 24 24" fill="none" stroke="#f472b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    if (['zip','rar','7z','tar','gz'].includes(ext))
      return `<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;
    if (['pdf','doc','docx','xls','xlsx','ppt','pptx'].includes(ext))
      return `<svg viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }

  const fileCards = fileInfos.map((f, i) => {
    const dlUrl = `${origin}/files/download?path=${encodeURIComponent(f.rel)}${tokenSuffix}`;
    const icon = fileIconSvg(f.name);
    const ext = (f.name.split('.').pop() || 'file').toUpperCase().slice(0, 6);
    const safeName = f.name.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `
    <div class="file-row" style="animation-delay:${i * 60}ms">
      <div class="file-icon-wrap">${icon}</div>
      <div class="file-details">
        <div class="file-name" title="${safeName}">${safeName}</div>
        <div class="file-meta">
          <span class="ext-badge">${ext}</span>
          <span class="file-sz">${fmtSize(f.size)}</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="copy-link-btn" data-url="${dlUrl}" title="Copy link">
          <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </button>
        <a href="${dlUrl}" download class="dl-btn" title="Download ${safeName}">
          <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Download</span>
        </a>
      </div>
    </div>`;
  }).join('\n');

  const totalSize = fileInfos.reduce((s, f) => s + (f.size || 0), 0);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>AiroDrop Downloads Center</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700;0,14..32,800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  :root{
    --bg:#07070e;--bg2:#0e0e1a;--bg3:#13131f;
    --card:rgba(255,255,255,0.035);--card2:rgba(255,255,255,0.06);
    --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.12);
    --accent:#ff5500;--accent2:#ff7a00;--glow:rgba(255,85,0,0.2);
    --text:#eeeef5;--text2:#8a8aa8;--text3:#40405a;
    --r:16px;--r2:12px;
  }
  html{scroll-behavior:smooth}
  body{
    font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:var(--bg);color:var(--text);min-height:100dvh;
    -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
  }
  /* Ambient background */
  body::before{
    content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
    background:
      radial-gradient(ellipse 80vw 50vh at 15% -10%,rgba(255,85,0,0.08),transparent 60%),
      radial-gradient(ellipse 60vw 60vh at 90% 110%,rgba(100,60,255,0.07),transparent 60%),
      radial-gradient(ellipse 40vw 40vh at 50% 50%,rgba(255,120,0,0.03),transparent);
  }

  /* Layout */
  .page{position:relative;z-index:1;max-width:680px;margin:0 auto;padding:env(safe-area-inset-top,0px) 16px env(safe-area-inset-bottom,80px);min-height:100dvh}

  /* ─── Top Nav ─── */
  .nav{
    display:flex;align-items:center;justify-content:space-between;
    padding:20px 0 0;gap:12px;
  }
  .brand{display:flex;align-items:center;gap:11px}
  .brand-logo{
    width:40px;height:40px;border-radius:12px;flex-shrink:0;
    box-shadow:0 4px 20px var(--glow);
    display:block;object-fit:contain;
  }
  .brand-name{font-size:1.1rem;font-weight:700;letter-spacing:-0.03em;color:var(--text)}
  .brand-sub{font-size:0.72rem;color:var(--text2);margin-top:1px;font-weight:400}

  /* ─── Stat bar ─── */
  .stat-bar{
    display:grid;grid-template-columns:repeat(3,1fr);gap:1px;
    margin:20px 0;border-radius:var(--r);overflow:hidden;
    border:1px solid var(--border);background:var(--border);
  }
  .stat{
    background:var(--bg2);padding:14px 16px;
    display:flex;flex-direction:column;gap:4px;
  }
  .stat-val{font-size:1.18rem;font-weight:700;letter-spacing:-0.02em;color:var(--text)}
  .stat-lbl{font-size:0.68rem;font-weight:500;color:var(--text2);text-transform:uppercase;letter-spacing:0.07em}

  /* ─── Section heading ─── */
  .section-head{
    display:flex;align-items:center;justify-content:space-between;
    margin-bottom:10px;padding:0 2px;
  }
  .section-head h2{font-size:0.75rem;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.08em}

  /* ─── File list ─── */
  .files-list{display:flex;flex-direction:column;gap:6px;margin-bottom:32px}

  .file-row{
    display:flex;align-items:center;gap:14px;
    background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);
    padding:13px 14px;
    transition:border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    animation:fadeUp 0.35s ease both;
  }
  @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  .file-row:hover{border-color:var(--border2);background:var(--card2);box-shadow:0 4px 20px rgba(0,0,0,0.25)}

  .file-icon-wrap{
    width:44px;height:44px;border-radius:12px;flex-shrink:0;
    background:rgba(255,255,255,0.04);border:1px solid var(--border);
    display:flex;align-items:center;justify-content:center;
  }
  .file-icon-wrap svg{width:22px;height:22px}

  .file-details{flex:1;min-width:0}
  .file-name{
    font-size:0.9rem;font-weight:600;color:var(--text);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    letter-spacing:-0.01em;
  }
  .file-meta{display:flex;align-items:center;gap:8px;margin-top:4px}
  .ext-badge{
    font-size:0.62rem;font-weight:700;letter-spacing:0.06em;
    padding:2px 7px;border-radius:5px;
    background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);
    color:var(--text2);text-transform:uppercase;flex-shrink:0;
  }
  .file-sz{font-size:0.75rem;color:var(--text2);font-weight:400}

  .file-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}

  .copy-link-btn{
    width:36px;height:36px;border-radius:10px;
    background:rgba(255,255,255,0.05);border:1px solid var(--border);
    color:var(--text2);cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    transition:all 0.15s ease;flex-shrink:0;
  }
  .copy-link-btn:hover{background:rgba(255,255,255,0.1);color:var(--text);border-color:var(--border2)}
  .copy-link-btn:active{transform:scale(0.93)}
  .copy-link-btn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .copy-link-btn.copied{background:rgba(0,200,100,0.12);border-color:rgba(0,200,100,0.3);color:#4ade80}

  .dl-btn{
    display:inline-flex;align-items:center;gap:7px;
    padding:9px 18px;border-radius:100px;
    background:linear-gradient(135deg,var(--accent),var(--accent2));
    color:#fff;font-size:0.82rem;font-weight:700;
    text-decoration:none;white-space:nowrap;
    box-shadow:0 4px 18px var(--glow);
    transition:opacity 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
    font-family:inherit;
  }
  .dl-btn:hover{opacity:0.92;transform:translateY(-1px);box-shadow:0 6px 24px var(--glow)}
  .dl-btn:active{transform:scale(0.96);opacity:0.88}
  .dl-btn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}

  /* ─── Empty state ─── */
  .empty-state{
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:14px;padding:80px 24px;text-align:center;
  }
  .empty-state svg{width:44px;height:44px;stroke:var(--text3);fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
  .empty-state h2{font-size:1rem;font-weight:600;color:var(--text2)}
  .empty-state p{font-size:0.82rem;color:var(--text3)}

  /* ─── Toast ─── */
  .toast{
    position:fixed;bottom:env(safe-area-inset-bottom,24px);left:50%;
    transform:translateX(-50%) translateY(20px);
    padding:10px 22px;background:rgba(20,20,35,0.96);
    border:1px solid var(--border2);
    color:var(--text);border-radius:100px;font-size:0.82rem;font-weight:600;
    opacity:0;transition:all 0.28s cubic-bezier(0.34,1.56,0.64,1);
    z-index:300;white-space:nowrap;pointer-events:none;backdrop-filter:blur(16px);
    box-shadow:0 8px 32px rgba(0,0,0,0.4);
  }
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

  @media(max-width:480px){
    .stat-val{font-size:1rem}
    .dl-btn span{display:none}
    .dl-btn{padding:9px 14px}
    .file-name{font-size:0.84rem}
  }
</style>
</head>
<body>
<div class="page">

  <nav class="nav">
    <div class="brand">
      <img src="/logo.png" alt="AiroDrop Logo" class="brand-logo" />
      <div>
        <div class="brand-name">AiroDrop</div>
        <div class="brand-sub">Downloads Center</div>
      </div>
    </div>
  </nav>

  <div class="stat-bar">
    <div class="stat">
      <div class="stat-val">${fileInfos.length}</div>
      <div class="stat-lbl">File${fileInfos.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="stat">
      <div class="stat-val">${fmtSize(totalSize)}</div>
      <div class="stat-lbl">Total Size</div>
    </div>
    <div class="stat">
      <div class="stat-val">Local</div>
      <div class="stat-lbl">Network</div>
    </div>
  </div>

  ${fileInfos.length === 0 ? `
  <div class="empty-state">
    <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
    <h2>No files found</h2>
    <p>The selected files could not be located. Please go back and try again.</p>
  </div>` : `
  <div class="section-head">
    <h2>${fileInfos.length} Selected File${fileInfos.length !== 1 ? 's' : ''}</h2>
  </div>
  <div class="files-list">
${fileCards}
  </div>`}

</div>
<div class="toast" id="toast"></div>
<script>
  const pageUrl = ${JSON.stringify(pageUrl)};

  // Copy page link
  document.getElementById('btnCopyPage').addEventListener('click', async function() {
    await copyText(pageUrl);
    showToast('Page link copied to clipboard');
  });

  // Copy individual file links
  document.querySelectorAll('.copy-link-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      const url = this.dataset.url;
      await copyText(url);
      this.classList.add('copied');
      this.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
      showToast('Link copied — paste in Safari to download');
      setTimeout(() => {
        this.classList.remove('copied');
        this.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
      }, 2200);
    });
  });

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return; } catch(e) {}
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch(e) {}
    document.body.removeChild(ta);
  }

  let _toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast show';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.className = 'toast', 2800);
  }
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;

