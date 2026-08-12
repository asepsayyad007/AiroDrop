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
    const file = fs.createWriteStream(destinationPath);
    let isFinished = false;

    function requestUrl(currentUrl) {
      const parsed = new URL(currentUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'AiroDrop-DirectDownloader/6.3.2',
          'Accept': '*/*'
        }
      };

      const req = client.get(options, (res) => {
        // Follow redirects (GitHub Release downloads redirect to AWS S3/objects.githubusercontent.com)
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (res.headers.location) {
            return requestUrl(res.headers.location);
          }
        }

        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destinationPath, () => {});
          return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0 && typeof onProgress === 'function') {
            const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
            onProgress({
              percent,
              transferred: downloadedBytes,
              total: totalBytes,
              bytesPerSecond: 0
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
      });

      req.on('error', (err) => {
        file.close();
        fs.unlink(destinationPath, () => {});
        if (!isFinished) {
          isFinished = true;
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
