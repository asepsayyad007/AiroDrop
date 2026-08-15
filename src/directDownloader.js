/**
 * directDownloader.js — Direct Node.js Binary Downloader
 * Downloads GitHub Release executables directly with redirect support and progress tracking.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function downloadFile(targetUrl, destinationPath, onProgress) {
  return new Promise((resolve, reject) => {
    let file = null;
    let isFinished = false;

    function cleanup() {
      if (file) {
        try { file.close(); } catch(e) {}
      }
      fs.unlink(destinationPath, () => {});
    }

    function requestUrl(currentUrl, redirectCount = 0) {
      if (redirectCount > 10) {
        if (!isFinished) { isFinished = true; cleanup(); reject(new Error('Too many redirects during download')); }
        return;
      }

      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        if (!isFinished) { isFinished = true; cleanup(); reject(new Error(`Invalid download URL: ${currentUrl}`)); }
        return;
      }

      const client = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'AiroDrop-DirectDownloader/6.4.4 (Mozilla/5.0 Windows NT 10.0; Win64; x64)',
          'Accept': '*/*'
        }
      };

      const req = client.get(options, (res) => {
        // Follow redirects (GitHub Release downloads redirect to AWS S3/objects.githubusercontent.com)
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (res.headers.location) {
            let nextUrl;
            try {
              nextUrl = new URL(res.headers.location, parsed.href).href;
            } catch (e) {
              nextUrl = res.headers.location;
            }
            return requestUrl(nextUrl, redirectCount + 1);
          }
        }

        if (res.statusCode !== 200) {
          if (!isFinished) {
            isFinished = true;
            cleanup();
            reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || 'Download failed'}`));
          }
          return;
        }

        if (!file) {
          file = fs.createWriteStream(destinationPath);
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        let lastTime = Date.now();
        let lastDownloaded = 0;
        let currentSpeedBps = 0;

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          const now = Date.now();
          const timeDiff = (now - lastTime) / 1000;
          if (timeDiff >= 0.2) {
            const bytesDiff = downloadedBytes - lastDownloaded;
            currentSpeedBps = bytesDiff / timeDiff;
            lastTime = now;
            lastDownloaded = downloadedBytes;
          }

          if (typeof onProgress === 'function') {
            const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
            onProgress({
              percent,
              transferred: downloadedBytes,
              total: totalBytes,
              bytesPerSecond: currentSpeedBps
            });
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            if (!isFinished) {
              isFinished = true;
              resolve(destinationPath);
            }
          });
        });

        file.on('error', (err) => {
          if (!isFinished) {
            isFinished = true;
            cleanup();
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        if (!isFinished) {
          isFinished = true;
          cleanup();
          reject(err);
        }
      });

      req.end();
    }

    requestUrl(targetUrl);
  });
}

module.exports = {
  downloadFile
};
