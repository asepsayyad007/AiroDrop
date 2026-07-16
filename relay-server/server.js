/**
 * AiroDrop Relay Server — Zero-Storage P2P File Sharing Tunnel
 *
 * This server acts as a real-time relay between a local PC running AiroDrop
 * and any recipient on the internet. Files are NEVER stored on disk — binary
 * data flows through RAM only, streamed directly from the PC to the downloader.
 *
 * Endpoints:
 *   WebSocket /ws       — PC connects here to register shares and stream files
 *   GET      /d/:token  — Recipients download files via this URL
 *   GET      /d/:token/info — File metadata preview (JSON)
 *   GET      /health    — Health check
 */

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── Configuration ──────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 4000;
const MAX_SHARES_PER_SESSION = 20;
const CLEANUP_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const TOKEN_LENGTH = 12;

// ─── App Setup ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.set('trust proxy', true);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ─── In-Memory Stores ───────────────────────────────────────
// Active share tokens
const shares = new Map();
// sessionKey → WebSocket mapping
const sessions = new Map();
// Pending download responses waiting for stream data
const pendingDownloads = new Map();
// Pending upload requests being piped to active WS sessions
const pendingUploads = new Map();
// Pending upload handshakes waiting for PC acceptance
const pendingHandshakes = new Map();


// ─── Utility Functions ──────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(TOKEN_LENGTH).toString('base64url').slice(0, TOKEN_LENGTH);
}

function log(level, msg, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data
  };
  console.log(JSON.stringify(entry));
}

function getExpiresAt(mode) {
  const now = Date.now();
  switch (mode) {
    case '1h': return now + 3_600_000;
    case '6h': return now + 21_600_000;
    case '24h': return now + 86_400_000;
    case 'download': return null; // expires on first download
    default: return null;
  }
}

function serveStyledPage(res, pageName, statusCode = 404) {
  const pagePath = path.join(__dirname, 'pages', pageName);
  if (fs.existsSync(pagePath)) {
    res.status(statusCode).sendFile(pagePath);
  } else {
    res.status(statusCode).send(pageName === 'expired.html'
      ? 'This link has expired or been revoked.'
      : 'The host is currently offline.');
  }
}

// ─── WebSocket Handling ─────────────────────────────────────
wss.on('connection', (ws, req) => {
  let sessionKey = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (rawData, isBinary) => {
    // Binary frames — file stream data for a pending download
    if (isBinary) {
      if (!sessionKey) return;
      // Route binary data to any pending downloads for this session
      for (const [token, dl] of pendingDownloads.entries()) {
        const share = shares.get(token);
        if (share && share.sessionKey === sessionKey && dl.active) {
          dl.bytesTransferred += rawData.length;
          const writable = dl.res.write(rawData);
          // Send progress back to PC
          const percent = share.size > 0
            ? Math.min(100, Math.round((dl.bytesTransferred / share.size) * 100))
            : 0;
          safeSend(ws, {
            type: 'download-progress',
            token,
            bytesTransferred: dl.bytesTransferred,
            percent
          });

          // If the response's internal buffer is full, pause the websocket
          if (!writable) {
            ws.pause();
            dl.res.once('drain', () => ws.resume());
          }
        }
      }
      return;
    }

    // Text frames — JSON control messages
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'auth': {
        sessionKey = msg.sessionKey;
        if (!sessionKey) {
          sessionKey = uuidv4();
        }
        sessions.set(sessionKey, ws);
        ws.sessionKey = sessionKey;
        log('info', 'PC connected', { sessionKey: sessionKey.slice(0, 8) + '...' });
        safeSend(ws, { type: 'auth-ok', sessionKey });
        break;
      }

      case 'register-share': {
        if (!sessionKey) {
          safeSend(ws, { type: 'error', message: 'Not authenticated' });
          return;
        }

        // Enforce per-session limit
        let count = 0;
        for (const s of shares.values()) {
          if (s.sessionKey === sessionKey && s.status !== 'expired' && s.status !== 'completed') count++;
        }
        if (count >= MAX_SHARES_PER_SESSION) {
          safeSend(ws, { type: 'error', message: `Max ${MAX_SHARES_PER_SESSION} active shares reached` });
          return;
        }

        const token = generateToken();
        const expiryMode = msg.expiryMode || 'download';
        const share = {
          token,
          filename: msg.filename || 'file',
          size: msg.size || 0,
          mimeType: msg.mimeType || 'application/octet-stream',
          expiryMode,
          expiresAt: getExpiresAt(expiryMode),
          deleteAfterDownload: expiryMode === 'download',
          sessionKey,
          status: 'waiting',
          createdAt: Date.now()
        };
        shares.set(token, share);

        log('info', 'Share registered', { token, filename: share.filename, size: share.size, expiryMode });
        safeSend(ws, {
          type: 'share-registered',
          token,
          filename: share.filename,
          size: share.size,
          expiryMode
        });
        break;
      }

      case 'register-receive': {
        if (!sessionKey) {
          safeSend(ws, { type: 'error', message: 'Not authenticated' });
          return;
        }

        // Enforce per-session limit
        let count = 0;
        for (const s of shares.values()) {
          if (s.sessionKey === sessionKey && s.status !== 'expired' && s.status !== 'completed') count++;
        }
        if (count >= MAX_SHARES_PER_SESSION) {
          safeSend(ws, { type: 'error', message: `Max ${MAX_SHARES_PER_SESSION} active shares reached` });
          return;
        }

        const token = generateToken();
        const expiryMode = msg.expiryMode || 'download';
        const share = {
          token,
          direction: 'receive',
          expiryMode,
          expiresAt: getExpiresAt(expiryMode),
          deleteAfterDownload: expiryMode === 'download',
          sessionKey,
          status: 'waiting',
          createdAt: Date.now()
        };
        shares.set(token, share);

        log('info', 'Receive link registered', { token, expiryMode });
        safeSend(ws, {
          type: 'receive-registered',
          token,
          expiryMode
        });
        break;
      }

      case 'accept-upload': {
        const targetId = msg.fileId || msg.token;
        const ph = pendingHandshakes.get(targetId);
        if (ph) {
          log('info', 'P2P Handshake accepted by PC', { token: msg.token, fileId: msg.fileId });
          ph.res.json({ action: 'start' });
          pendingHandshakes.delete(targetId);
        }
        break;
      }

      case 'decline-upload': {
        const targetId = msg.fileId || msg.token;
        const ph = pendingHandshakes.get(targetId);
        if (ph) {
          log('info', 'P2P Handshake declined by PC', { token: msg.token, fileId: msg.fileId });
          ph.res.json({ action: 'decline' });
          pendingHandshakes.delete(targetId);
        }
        break;
      }


      case 'cancel-share': {
        const share = shares.get(msg.token);
        if (share && share.sessionKey === sessionKey) {
          share.status = 'expired';
          // Abort any pending download for this token
          const dl = pendingDownloads.get(msg.token);
          if (dl && dl.active) {
            dl.active = false;
            if (!dl.res.headersSent) {
              serveStyledPage(dl.res, 'expired.html');
            } else {
              dl.res.end();
            }
            pendingDownloads.delete(msg.token);
          }
          shares.delete(msg.token);
          log('info', 'Share cancelled', { token: msg.token });
          safeSend(ws, { type: 'share-cancelled', token: msg.token });
        }
        break;
      }

      case 'cancel-all': {
        for (const [token, share] of shares.entries()) {
          if (share.sessionKey === sessionKey) {
            share.status = 'expired';
            const dl = pendingDownloads.get(token);
            if (dl && dl.active) {
              dl.active = false;
              if (!dl.res.headersSent) {
                serveStyledPage(dl.res, 'expired.html');
              } else {
                dl.res.end();
              }
              pendingDownloads.delete(token);
            }
            shares.delete(token);
          }
        }
        safeSend(ws, { type: 'all-cancelled' });
        break;
      }

      case 'stream-end': {
        const dl = pendingDownloads.get(msg.token);
        if (dl && dl.active) {
          dl.active = false;
          dl.res.end();
          pendingDownloads.delete(msg.token);

          const share = shares.get(msg.token);
          if (share) {
            log('info', 'Download complete', { token: msg.token, bytes: dl.bytesTransferred });
            safeSend(ws, { type: 'download-complete', token: msg.token, bytesTransferred: dl.bytesTransferred });

            if (share.deleteAfterDownload) {
              share.status = 'completed';
              shares.delete(msg.token);
            } else {
              share.status = 'waiting';
            }
          }
        }
        break;
      }

      case 'stream-error': {
        const dl = pendingDownloads.get(msg.token);
        if (dl && dl.active) {
          dl.active = false;
          if (!dl.res.headersSent) {
            serveStyledPage(dl.res, 'offline.html', 503);
          } else {
            dl.res.end();
          }
          pendingDownloads.delete(msg.token);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (sessionKey) {
      log('info', 'PC disconnected', { sessionKey: sessionKey.slice(0, 8) + '...' });
      sessions.delete(sessionKey);

      // Abort any pending downloads for this session
      for (const [token, dl] of pendingDownloads.entries()) {
        const share = shares.get(token);
        if (share && share.sessionKey === sessionKey && dl.active) {
          dl.active = false;
          if (!dl.res.headersSent) {
            serveStyledPage(dl.res, 'offline.html', 503);
          } else {
            dl.res.end();
          }
          pendingDownloads.delete(token);
        }
      }

      // Abort any pending uploads for this session
      for (const [token, ul] of pendingUploads.entries()) {
        const share = shares.get(token);
        if (share && share.sessionKey === sessionKey && ul.active) {
          ul.active = false;
          if (!ul.res.headersSent) {
            ul.res.status(503).send('PC host disconnected.');
          } else {
            ul.res.end();
          }
          pendingUploads.delete(token);
        }
      }


      // Mark all shares from this session as expired
      for (const [token, share] of shares.entries()) {
        if (share.sessionKey === sessionKey) {
          share.status = 'expired';
          shares.delete(token);
        }
      }
    }
  });

  ws.on('error', (err) => {
    log('error', 'WebSocket error', { error: err.message });
  });
});

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── HTTP Routes ────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    activeShares: shares.size,
    uptime: Math.floor(process.uptime())
  });
});



// File metadata preview
app.get('/d/:token/info', (req, res) => {
  const share = shares.get(req.params.token);
  if (!share || share.status === 'expired' || share.status === 'completed') {
    return res.status(404).json({ error: 'Link expired or not found' });
  }
  if (share.expiresAt && Date.now() > share.expiresAt) {
    share.status = 'expired';
    shares.delete(req.params.token);
    return res.status(404).json({ error: 'Link expired' });
  }
  res.json({
    filename: share.filename,
    size: share.size,
    mimeType: share.mimeType
  });
});

// Serves the beautiful download landing page
app.get('/d/:token', (req, res) => {
  const token = req.params.token;
  const share = shares.get(token);

  // Token not found or already used
  if (!share || share.status === 'expired' || share.status === 'completed') {
    return serveStyledPage(res, 'expired.html');
  }

  // Time-based expiry check
  if (share.expiresAt && Date.now() > share.expiresAt) {
    share.status = 'expired';
    shares.delete(token);
    return serveStyledPage(res, 'expired.html');
  }

  // Check if PC is online
  const pcSocket = sessions.get(share.sessionKey);
  if (!pcSocket || pcSocket.readyState !== WebSocket.OPEN) {
    return serveStyledPage(res, 'offline.html', 503);
  }

  // Serve the beautiful download page
  serveStyledPage(res, 'download.html', 200);
});

// File download — the core streaming endpoint
app.get('/d/:token/download', (req, res) => {
  const token = req.params.token;
  const share = shares.get(token);

  // Token not found or already used
  if (!share || share.status === 'expired' || share.status === 'completed') {
    return serveStyledPage(res, 'expired.html');
  }

  // Time-based expiry check
  if (share.expiresAt && Date.now() > share.expiresAt) {
    share.status = 'expired';
    shares.delete(token);
    return serveStyledPage(res, 'expired.html');
  }

  // Check if PC is online
  const pcSocket = sessions.get(share.sessionKey);
  if (!pcSocket || pcSocket.readyState !== WebSocket.OPEN) {
    return serveStyledPage(res, 'offline.html', 503);
  }

  // Check if another download is already in progress for this token
  if (pendingDownloads.has(token)) {
    return res.status(429).send('Download already in progress for this file.');
  }

  // Set response headers for file download
  const safeFilename = share.filename.replace(/[^\w.\-_ ]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Content-Type', share.mimeType);
  if (share.size > 0) {
    res.setHeader('Content-Length', share.size);
  }

  // Register this pending download
  const download = {
    res,
    active: true,
    bytesTransferred: 0,
    startedAt: Date.now()
  };
  pendingDownloads.set(token, download);

  // Update share status
  share.status = 'downloading';

  log('info', 'Download started', { token, filename: share.filename, ip: req.ip });

  // Tell the PC to start streaming
  safeSend(pcSocket, {
    type: 'request-stream',
    token,
    filename: share.filename
  });

  // Handle client disconnect (recipient closes browser)
  req.on('close', () => {
    const dl = pendingDownloads.get(token);
    if (dl && dl.active) {
      dl.active = false;
      pendingDownloads.delete(token);
      log('info', 'Download aborted by recipient', { token, bytes: dl.bytesTransferred });

      // Notify PC to stop streaming
      const pc = sessions.get(share.sessionKey);
      if (pc && pc.readyState === WebSocket.OPEN) {
        safeSend(pc, { type: 'download-aborted', token });
      }

      // Don't delete the share if it's time-based (allow re-download)
      if (share.deleteAfterDownload) {
        share.status = 'waiting'; // Reset for retry
      } else {
        share.status = 'waiting';
      }
    }
  });

  // Set a generous timeout (1 hour for large files)
  res.setTimeout(3_600_000, () => {
    const dl = pendingDownloads.get(token);
    if (dl && dl.active) {
      dl.active = false;
      dl.res.end();
      pendingDownloads.delete(token);
    }
  });
});

// ─── Upload Routes (Receive from Friend) ────────────────────

// Metadata preview for upload link
app.get('/u/:token/info', (req, res) => {
  const share = shares.get(req.params.token);
  if (!share || share.direction !== 'receive' || share.status === 'expired' || share.status === 'completed') {
    return res.status(404).json({ error: 'Upload link expired or not found' });
  }
  if (share.expiresAt && Date.now() > share.expiresAt) {
    share.status = 'expired';
    shares.delete(req.params.token);
    return res.status(404).json({ error: 'Upload link expired' });
  }
  
  const pcSocket = sessions.get(share.sessionKey);
  const pcOnline = pcSocket && pcSocket.readyState === WebSocket.OPEN;

  res.json({
    expiryMode: share.expiryMode,
    pcOnline,
    status: share.status
  });
});

// Serves the beautiful upload page
app.get('/u/:token', (req, res) => {
  const token = req.params.token;
  const share = shares.get(token);

  if (!share || share.direction !== 'receive' || share.status === 'expired' || share.status === 'completed') {
    return serveStyledPage(res, 'expired.html');
  }

  if (share.expiresAt && Date.now() > share.expiresAt) {
    share.status = 'expired';
    shares.delete(token);
    return serveStyledPage(res, 'expired.html');
  }

  const pcSocket = sessions.get(share.sessionKey);
  if (!pcSocket || pcSocket.readyState !== WebSocket.OPEN) {
    return serveStyledPage(res, 'offline.html', 503);
  }

  serveStyledPage(res, 'upload.html', 200);
});

// Register upload intent (handshake) — uploader registers details and waits for PC approval
app.post('/u/:token/ready', (req, res) => {
  const token = req.params.token;
  const share = shares.get(token);

  if (!share || share.direction !== 'receive' || share.status === 'expired' || share.status === 'completed') {
    return res.status(404).json({ error: 'Upload link expired or not found' });
  }

  if (share.expiresAt && Date.now() > share.expiresAt) {
    share.status = 'expired';
    shares.delete(token);
    return res.status(404).json({ error: 'Upload link expired' });
  }

  const pcSocket = sessions.get(share.sessionKey);
  if (!pcSocket || pcSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'PC host is currently offline' });
  }

  const fileId = req.headers['x-file-id'] || token;
  const preview = req.headers['x-file-preview'] || ''; // optional base64 image thumbnail

  // Clear any existing pending handshake for this fileId to avoid conflicts
  const existing = pendingHandshakes.get(fileId);
  if (existing) {
    try {
      existing.res.status(409).json({ error: 'Superseded by a new upload request' });
    } catch (e) {}
    pendingHandshakes.delete(fileId);
  }

  // Extract file metadata from custom headers
  const filename = decodeURIComponent(req.headers['x-file-name'] || 'uploaded_file');
  const size = parseInt(req.headers['x-file-size'], 10) || 0;
  const mimeType = req.headers['x-file-type'] || 'application/octet-stream';

  pendingHandshakes.set(fileId, {
    res,
    token,
    filename,
    size,
    mimeType
  });

  log('info', 'Incoming upload handshake registered', { token, fileId, filename, size });

  // Notify PC client of the incoming upload
  safeSend(pcSocket, {
    type: 'incoming-upload',
    token,
    fileId,
    filename,
    size,
    mimeType,
    preview
  });

  // Handle client disconnect/abort
  req.on('close', () => {
    const ph = pendingHandshakes.get(fileId);
    if (ph && ph.res === res) {
      pendingHandshakes.delete(fileId);
      log('info', 'Uploader cancelled handshake', { token, fileId });
      safeSend(pcSocket, {
        type: 'upload-cancelled',
        token,
        fileId
      });
    }
  });
});

// File upload — accepts raw binary stream and forwards it via WebSocket to PC
app.post('/u/:token/upload', (req, res) => {
  const token = req.params.token;
  const share = shares.get(token);

  if (!share || share.direction !== 'receive' || share.status === 'expired' || share.status === 'completed') {
    return res.status(404).send('Upload link expired or not found.');
  }

  if (share.expiresAt && Date.now() > share.expiresAt) {
    share.status = 'expired';
    shares.delete(token);
    return res.status(404).send('Upload link expired.');
  }

  const pcSocket = sessions.get(share.sessionKey);
  if (!pcSocket || pcSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).send('PC host is currently offline.');
  }

  const fileId = req.headers['x-file-id'] || token;

  if (pendingUploads.has(fileId)) {
    return res.status(429).send('An upload is already in progress for this file.');
  }

  // Extract file metadata from custom headers
  const filename = decodeURIComponent(req.headers['x-file-name'] || 'uploaded_file');
  const size = parseInt(req.headers['x-file-size'], 10) || 0;
  const mimeType = req.headers['x-file-type'] || 'application/octet-stream';

  const upload = {
    res,
    active: true,
    bytesTransferred: 0,
    startedAt: Date.now()
  };
  pendingUploads.set(fileId, upload);
  share.status = 'receiving';

  log('info', 'Upload started', { token, fileId, filename, size, ip: req.ip });

  // Notify the PC that a streaming upload is starting
  safeSend(pcSocket, {
    type: 'upload-started',
    token,
    fileId,
    filename,
    size,
    mimeType
  });

  // Handle incoming stream data chunks
  req.on('data', (chunk) => {
    if (!upload.active) return;

    // Send binary packet with header prefix over WebSocket to PC:
    // [1 byte fileId length (N)] + [N bytes fileId string] + [raw chunk data]
    const fileIdBuffer = Buffer.from(fileId, 'ascii');
    const headerBuffer = Buffer.alloc(1);
    headerBuffer.writeUInt8(fileIdBuffer.length, 0);

    const binaryPacket = Buffer.concat([headerBuffer, fileIdBuffer, chunk]);
    
    if (pcSocket.readyState === WebSocket.OPEN) {
      pcSocket.send(binaryPacket, { binary: true });
      upload.bytesTransferred += chunk.length;

      // Backpressure handling: pause if WebSocket outbound buffer exceeds 1MB
      if (pcSocket.bufferedAmount > 1024 * 1024) {
        req.pause();
        const checkInterval = setInterval(() => {
          if (pcSocket.readyState !== WebSocket.OPEN) {
            clearInterval(checkInterval);
            return;
          }
          if (pcSocket.bufferedAmount < 512 * 1024) {
            clearInterval(checkInterval);
            req.resume();
          }
        }, 30);
      }
    } else {
      handleUploadError(new Error('PC WebSocket disconnected during upload'));
    }
  });

  req.on('end', () => {
    if (!upload.active) return;
    
    upload.active = false;
    pendingUploads.delete(fileId);
    
    log('info', 'Upload complete', { token, fileId, bytes: upload.bytesTransferred });
    
    // Notify the PC that the upload has finished streaming
    safeSend(pcSocket, {
      type: 'upload-complete',
      token,
      fileId,
      bytesTransferred: upload.bytesTransferred
    });

    // For receive links (uploads), do not delete the token on a single file completion.
    // The PC client will send 'cancel-share' to clean it up when the entire batch is done.
    share.status = 'waiting';

    res.json({ success: true, bytesTransferred: upload.bytesTransferred });
  });

  req.on('close', () => {
    if (upload.active) {
      handleUploadError(new Error('Connection closed by uploader'));
    }
  });

  function handleUploadError(err) {
    if (!upload.active) return;
    upload.active = false;
    pendingUploads.delete(token);
    share.status = 'waiting';

    log('error', 'Upload failed', { token, error: err.message });

    safeSend(pcSocket, {
      type: 'upload-error',
      token,
      message: err.message
    });

    if (!res.headersSent) {
      res.status(500).send(err.message);
    } else {
      res.end();
    }
  }
});


// ─── WebSocket Upgrade ──────────────────────────────────────
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const p = url.pathname;
  log('info', 'Upgrade request headers received', { headers: request.headers, url: request.url });
  
  // Sanitize headers to prevent Nginx duplication issues (e.g. "websocket, websocket")
  if (request.headers.upgrade) {
    request.headers.upgrade = request.headers.upgrade.split(',')[0].trim();
  }
  if (request.headers.connection) {
    request.headers.connection = request.headers.connection.split(',')[0].trim();
  }

  if (p === '/ws' || p === '/ws/' || p === '/') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ─── Heartbeat — detect dead connections ────────────────────
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      log('info', 'Terminating dead connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

// ─── Cleanup — sweep expired tokens ────────────────────────
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [token, share] of shares.entries()) {
    if (share.expiresAt && now > share.expiresAt) {
      share.status = 'expired';
      // Abort any pending download
      const dl = pendingDownloads.get(token);
      if (dl && dl.active) {
        dl.active = false;
        if (!dl.res.headersSent) {
          serveStyledPage(dl.res, 'expired.html');
        } else {
          dl.res.end();
        }
        pendingDownloads.delete(token);
      }
      
      // Abort any pending upload
      const ul = pendingUploads.get(token);
      if (ul && ul.active) {
        ul.active = false;
        if (!ul.res.headersSent) {
          ul.res.status(410).send('Upload link expired.');
        } else {
          ul.res.end();
        }
        pendingUploads.delete(token);
      }

      shares.delete(token);
      log('info', 'Expired share cleaned up', { token });
    }
  }
}, CLEANUP_INTERVAL_MS);

// ─── Graceful Shutdown ──────────────────────────────────────
function shutdown(signal) {
  log('info', `Received ${signal}, shutting down...`);
  clearInterval(heartbeatInterval);
  clearInterval(cleanupInterval);

  // Close all pending downloads
  for (const [token, dl] of pendingDownloads.entries()) {
    if (dl.active) {
      dl.active = false;
      dl.res.end();
    }
    pendingDownloads.delete(token);
  }

  // Close all pending uploads
  for (const [token, ul] of pendingUploads.entries()) {
    if (ul.active) {
      ul.active = false;
      ul.res.end();
    }
    pendingUploads.delete(token);
  }


  // Close all WebSocket connections
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));

  server.close(() => {
    log('info', 'Server closed');
    process.exit(0);
  });

  // Force kill after 10 seconds
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start Server ───────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  log('info', `AiroDrop Relay Server running on port ${PORT}`);
});
