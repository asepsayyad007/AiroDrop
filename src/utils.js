const path = require('path');
const fs = require('fs');
const os = require('os');
const { copyText, copyImage } = require('../clipboard');
const notifier = require('../notify');
const state = require('./state');

let _saveHistoryTimer = null;

function saveHistory() {
  if (state.TEMPORARY_MODE) {
    try {
      if (fs.existsSync(state.HISTORY_FILE)) fs.unlinkSync(state.HISTORY_FILE);
    } catch {}
    return;
  }
  // Debounce: coalesce rapid writes into one write 500ms after last call
  if (_saveHistoryTimer) clearTimeout(_saveHistoryTimer);
  _saveHistoryTimer = setTimeout(() => {
    const payload = JSON.stringify(state.history, null, 2);
    fs.writeFile(state.HISTORY_FILE, payload, 'utf8', (err) => {
      if (err) console.error('[HISTORY] Failed to save history:', err.message);
    });
  }, 500);
}

function notifyText(text) {
  if (state.NOTIFICATIONS_ENABLED) notifier.notifyText(text);
}

function notifyImage(filename) {
  if (state.NOTIFICATIONS_ENABLED) notifier.notifyImage(filename);
}

function writeLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const fullLog = `[${timestamp}] ${message}`;
  console.log(fullLog);
  state.logHistory.push(fullLog);
  const MAX_LOGS = 500;
  if (state.logHistory.length > MAX_LOGS) {
    state.logHistory.shift();
  }
  broadcastSSE('log', { timestamp, message });
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of state.sseClients) {
    try {
      client.write(payload);
    } catch {
      state.sseClients.delete(client);
    }
  }
}

function addToHistory(item) {
  const MAX_HISTORY = 100;
  state.history.unshift(item);
  if (state.history.length > MAX_HISTORY) {
    const popped = state.history.pop();
    if (popped && popped.filename) {
      const fullPath = path.isAbsolute(popped.path) ? popped.path : path.resolve(__dirname, '..', popped.path);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch {}
    }
  }
  saveHistory();
  broadcastSSE('new-item', item);
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  
  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    // Exclude virtual/loopback interfaces
    if (lowerName.includes('virtual') || 
        lowerName.includes('wsl') || 
        lowerName.includes('hyper-v') || 
        lowerName.includes('loopback') ||
        lowerName.includes('vmware') ||
        lowerName.includes('virtualbox')) {
      continue;
    }
    
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        let priority = 1;
        if (lowerName.includes('wi-fi') || lowerName.includes('wlan')) {
          priority = 10;
        } else if (lowerName.includes('ethernet') || lowerName.includes('lan') || lowerName.includes('local area')) {
          priority = 5;
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

async function tryExtractUrlFromHtmlFile(savedPath, mimeType) {
  if (!savedPath || !fs.existsSync(savedPath)) return null;
  try {
    const ext = path.extname(savedPath).toLowerCase();
    const isWebarchive = ext === '.webarchive';
    const isHtmlExt = ext === '.html' || ext === '.htm' || (mimeType && mimeType.includes('html'));
    
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
  
  if (state.AUTO_OPEN_LINKS && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
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

// Auto-delete temporary items check
setInterval(() => {
  if (!state.TEMPORARY_MODE) return;
  const now = Date.now();
  const cleanupMs = state.TEMPORARY_MODE_HOURS * 60 * 60 * 1000;
  
  let changed = false;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const item = state.history[i];
    const itemTime = new Date(item.timestamp).getTime();
    if (now - itemTime > cleanupMs) {
      if (item.filename) {
        const fullPath = path.isAbsolute(item.path) ? item.path : path.resolve(__dirname, '..', item.path);
        try {
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            console.log(`[TEMP] Auto-deleted expired file: ${item.filename}`);
          }
        } catch (e) {
          console.error(`[TEMP] Failed to delete expired file: ${item.filename}`, e.message);
        }
      }
      state.history.splice(i, 1);
      changed = true;
    }
  }
  if (changed) {
    saveHistory();
    broadcastSSE('history-update', state.history);
  }
}, 60000);

module.exports = {
  saveHistory,
  notifyText,
  notifyImage,
  writeLog,
  broadcastSSE,
  addToHistory,
  getLocalIP,
  getAllIPs,
  isBufferImage,
  tryExtractUrlFromHtmlFile,
  handleIncomingText
};
