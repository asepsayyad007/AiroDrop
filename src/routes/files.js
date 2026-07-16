const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const state = require('../state');

function safePath(relPath) {
  const baseDir = path.resolve(state.SHARE_DIR);
  const resolved = path.resolve(baseDir, relPath || '');
  if (process.platform === 'win32') {
    if (!resolved.toLowerCase().startsWith(baseDir.toLowerCase())) {
      return null;
    }
  } else {
    if (!resolved.startsWith(baseDir)) {
      return null;
    }
  }
  return resolved;
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

// Download a file
router.get('/download', (req, res) => {
  const rel = req.query.path || '';
  const target = safePath(rel);
  if (!target) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot download a folder' });
  
  const isStream = req.query.stream === 'true';
  const range = req.headers.range;

  if (isStream) {
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
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(target))}"`);
    res.sendFile(target, { acceptRanges: true });
  }
});

// Upload chunk for pause/resume/cancel support
router.post('/upload-chunk', (req, res) => {
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
            console.error('[UPLOAD] Merge error:', mergeErr.message);
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

// Cancel chunk upload
router.post('/upload-cancel', (req, res) => {
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
  const newName = req.body.newName || '';
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

module.exports = router;
