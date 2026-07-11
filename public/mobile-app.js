
    const SERVER = window.location.origin;

    function triggerHaptic(arg) {
      const hapticToggle = document.getElementById('hapticFeedbackToggle');
      if (hapticToggle && !hapticToggle.checked) return;

      // 1. Android/Chrome native Vibration API
      if (navigator.vibrate) {
        try {
          navigator.vibrate(arg);
        } catch (e) {
          console.warn('Vibration API error:', e);
        }
        return;
      }

      // 2. iOS 18+ switch haptic workaround
      const iosLabel = document.getElementById('iosHapticLabel');
      if (iosLabel) {
        if (Array.isArray(arg)) {
          let delay = 0;
          arg.forEach((val, idx) => {
            if (idx % 2 === 0) { // vibrate duration
              setTimeout(() => {
                iosLabel.click();
              }, delay);
            }
            delay += val;
          });
        } else {
          iosLabel.click();
        }
      }
    }
    
    function doFetch(url, options = {}) {
      const token = localStorage.getItem('deviceToken');
      if (token) {
        options.headers = options.headers || {};
        if (options.headers instanceof Headers) {
          options.headers.append('Authorization', `Bearer ${token}`);
        } else {
          options.headers['Authorization'] = `Bearer ${token}`;
        }
      }
      return fetch(url, options);
    }
    // (photo vars removed — not used in this page)

    // Auto-poll state
    let _autoPollTimer = null;
    let _lastCheckedTime = null;
    let _isReconnecting = false;
    let _reconnectTimer = null;
    let _reconnectCountdown = 15;

    // ─── Init ─────────────────────────────────────
    async function init() {
      localStorage.setItem('deviceToken', 'public-device');
      initAppComponents();
    }

    function initAppComponents() {
      const storedToken = localStorage.getItem('deviceToken');
      
      // Reveal UI
      const mainApp = document.getElementById('mainAppContainer');
      const bottomNav = document.getElementById('bottomNavContainer');
      if (mainApp) mainApp.style.display = 'block';
      if (bottomNav) bottomNav.style.display = 'flex';
      
      setupPWA();
      checkConnection();
      document.getElementById('checkPendingBtn').addEventListener('click', () => {
        fetchPending();
        updateLastChecked();
      });
      
      const btnRefresh = document.getElementById('btnUniversalRefresh');
      if (btnRefresh) {
        btnRefresh.addEventListener('click', async () => {
          btnRefresh.style.transform = 'translateY(-50%) rotate(360deg)';
          btnRefresh.style.transition = 'transform 0.6s ease';
          setTimeout(() => {
            btnRefresh.style.transform = 'translateY(-50%)';
            btnRefresh.style.transition = 'none';
          }, 600);

          showToast('Refreshing page data...');
          await checkConnection();
          await fetchPending(false);
          const scratchpad = document.getElementById('mobileScratchpad');
          if (scratchpad) {
            doFetch('/api/scratchpad')
              .then(res => res.json())
              .then(data => {
                scratchpad.value = data.text || '';
              });
          }
        });
      }

      fetchPending();
      startAutoPoll();
      setupSendControls();
      setupScratchpad();
      connectMobileSSE();
      setupMobileControl();
      setupMobileScreenshot();
      setupUniversalConnect();
      setupMobileTrackpad();
      setupScreencastOverlay();
      
      // Update File Browser to use token
      const fileIframe = document.getElementById('fileBrowserIframe');
      if (fileIframe && storedToken) {
        fileIframe.src = `/files?token=${storedToken}`;
      }


      setupFileBrowserOverlay();
      setupMicStream();

      // Setup Bottom Navigation
      document.querySelectorAll('.bottom-nav-item[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
          // Reset tabs
          document.querySelectorAll('.mobile-tab-content').forEach(c => c.classList.remove('active'));
          document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
          
          // Set active tab
          btn.classList.add('active');
          document.getElementById(btn.getAttribute('data-tab')).classList.add('active');
        });
      });

      // File manager button triggers overlay directly
      const btnBottomNavFiles = document.getElementById('btnBottomNavFiles');
      if (btnBottomNavFiles) {
        btnBottomNavFiles.addEventListener('click', () => {
          document.getElementById('fileBrowserOverlay').style.display = 'flex';
        });
      }

      // Redirect legacy open file browser button to just open the overlay
      const btnLegacyOpenFileBrowser = document.getElementById('btnOpenFileBrowser');
      if (btnLegacyOpenFileBrowser) {
        btnLegacyOpenFileBrowser.addEventListener('click', () => {
          document.getElementById('fileBrowserOverlay').style.display = 'flex';
        });
      }

      // Auto-hide/show trackpad card and overlay when rotating
      window.addEventListener('resize', () => {
        const isLandscape = window.innerWidth > window.innerHeight;
        const trackpadCard = document.getElementById('btnOpenTrackpad')?.closest('.sender-card');
        const trackpadOverlay = document.getElementById('trackpadOverlay');

        if (isLandscape) {
          if (trackpadCard) {
            trackpadCard.style.display = 'none';
          }
          // Also hide section title if exists
          const titles = document.querySelectorAll('.section-title');
          titles.forEach(t => {
            if (t.textContent.includes('Trackpad & Keyboard')) {
              t.style.setProperty('display', 'none', 'important');
            }
          });

          if (isTrackpadOpen && trackpadOverlay) {
            trackpadOverlay.style.display = 'none';
            isTrackpadOpen = false;
            showToast('Landscape: Trackpad closed');
          }
        } else {
          if (trackpadCard) {
            trackpadCard.style.display = 'block';
          }
          const titles = document.querySelectorAll('.section-title');
          titles.forEach(t => {
            if (t.textContent.includes('Trackpad & Keyboard')) {
              t.style.setProperty('display', 'block', 'important');
            }
          });
        }
      });
      // Run once on load to ensure initial orientation state is correct
      window.dispatchEvent(new Event('resize'));
    }

    // ─── Auto-poll every 10 seconds ───────────────────────
    function startAutoPoll() {
      if (_autoPollTimer) clearInterval(_autoPollTimer);
      _autoPollTimer = setInterval(async () => {
        await fetchPending(true);
        updateLastChecked();
      }, 10000);
    }

    function updateLastChecked() {
      _lastCheckedTime = Date.now();
      const el = document.getElementById('lastCheckedText');
      if (el) el.textContent = 'Just checked';
    }

    // Update "last checked Xs ago" every second
    setInterval(() => {
      if (!_lastCheckedTime) return;
      const sec = Math.round((Date.now() - _lastCheckedTime) / 1000);
      const el = document.getElementById('lastCheckedText');
      if (el) {
        el.textContent = sec < 5 ? 'Just checked' : `Checked ${sec}s ago`;
      }
    }, 1000);

    // ─── Connection Check + Reconnect Loop ─────────────────
    async function checkConnection() {
      const dot = document.getElementById('connDot');
      const text = document.getElementById('connText');
      try {
        const res = await doFetch('/api/info', { signal: AbortSignal.timeout(5000) });
        const info = await res.json();
        dot.className = 'dot ok';
        text.textContent = `Connected to ${info.ip}`;
        _isReconnecting = false;
        if (_reconnectTimer) { clearInterval(_reconnectTimer); _reconnectTimer = null; }

        // Set fallback URL
        document.querySelectorAll('.fallbackUrlText').forEach(el => el.textContent = `${info.url}/api/send`);
      } catch {
        dot.className = 'dot err';
        if (!_isReconnecting) {
          _isReconnecting = true;
          _reconnectCountdown = 15;
          _reconnectTimer = setInterval(() => {
            _reconnectCountdown--;
            if (text) text.textContent = `No connection — retrying in ${_reconnectCountdown}s`;
            if (_reconnectCountdown <= 0) {
              _reconnectCountdown = 15;
              checkConnection();
            }
          }, 1000);
        }
      }
    }

    // ─── Receive from PC ──────────────────────────────────────
    async function fetchPending(isBackground = false) {
      if (!isBackground) {
        showSkeleton('textInboxList');
        showSkeleton('fileInboxList');
      }
      try {
        const res = await doFetch('/api/pending');
        const data = await res.json();
        renderPending(data.items);
      } catch {
        if (!isBackground) {
          hideSkeleton('textInboxList', 'No texts received yet');
          hideSkeleton('fileInboxList', 'No files received yet');
        }
      }
    }

    function showSkeleton(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = `
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>`;
    }

    function hideSkeleton(id, msg) {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = `<div class="empty-receive">${msg}</div>`;
    }

    function getFileTypeIcon(mimeType) {
      if (!mimeType) return '📄';
      const type = mimeType.toLowerCase();
      if (type.startsWith('image/')) return '🖼️';
      if (type.startsWith('video/')) return '🎥';
      if (type.startsWith('audio/')) return '🎵';
      if (type.includes('pdf')) return '📄';
      if (type.includes('zip') || type.includes('rar') || type.includes('7z') || type.includes('tar') || type.includes('gzip')) return '🗃️';
      if (type.includes('word') || type.includes('document') || type.includes('officedocument')) return '📝';
      if (type.includes('sheet') || type.includes('excel') || type.includes('csv')) return '📊';
      if (type.includes('presentation') || type.includes('powerpoint')) return '📊';
      if (type.includes('text/')) return '📋';
      return '📄';
    }

    function renderPending(items) {
      const textList = document.getElementById('textInboxList');
      const fileList = document.getElementById('fileInboxList');
      if (!textList || !fileList) return;

      const textItems = (items || []).filter(item => item.type === 'text');
      const fileItems = (items || []).filter(item => item.type !== 'text');

      if (textItems.length === 0) {
        textList.innerHTML = '<div class="empty-receive">No texts received yet</div>';
      } else {
        textList.innerHTML = textItems.map(item => {
          // Dynamic data url to download text content as a file
          const downloadUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(item.content)}`;
          const downloadName = `text_${item.id}.txt`;
          return `
            <div class="receive-item" style="cursor: default;">
              <span style="font-size: 1.15rem; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;">📋</span>
              <span class="receive-content">${escapeHtml(item.content)}</span>
              <span class="receive-time" style="margin-right: 12px; flex-shrink: 0;">${timeAgo(item.timestamp)}</span>
              <div style="display:flex; align-items:center; gap:12px; margin-left:auto; flex-shrink: 0;">
                <button onclick="handleReceiveText('${escapeAttr(item.content)}')" style="background:none; border:none; color:var(--accent-light); font-size:0.78rem; font-weight:600; cursor:pointer; padding:0; white-space:nowrap;">Copy</button>
                <a href="${downloadUrl}" download="${escapeAttr(downloadName)}" target="_blank" style="color:var(--accent-light);font-size:0.78rem;font-weight:600;text-decoration:none;white-space:nowrap;">Download</a>
                <button class="delete-btn" onclick="deletePendingItem('${escapeAttr(item.id)}')" style="background:none; border:none; color:var(--text3); font-size:1.05rem; cursor:pointer; padding:4px; display:inline-flex; align-items:center;">🗑️</button>
              </div>
            </div>
          `;
        }).join('');
      }

      if (fileItems.length === 0) {
        fileList.innerHTML = '<div class="empty-receive">No files received yet</div>';
      } else {
        fileList.innerHTML = fileItems.map(item => {
          const isImg = item.type === 'image';
          const downloadUrl = isImg 
            ? (item.filename ? `/received/${item.filename}` : item.url)
            : `/received/${item.filename}`;
          const displayName = isImg ? (item.filename || 'Image') : (item.originalName || item.filename || 'File');
          const mime = item.mimeType || item.mimetype || (isImg ? 'image/jpeg' : '');
          const icon = getFileTypeIcon(mime);
          return `
            <div class="receive-item" style="cursor: default;">
              <span style="font-size: 1.15rem; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;">${icon}</span>
              <span class="receive-content">${escapeHtml(displayName)}</span>
              <span class="receive-time" style="margin-right: 12px; flex-shrink: 0;">${timeAgo(item.timestamp)}</span>
              <div style="display:flex; align-items:center; gap:12px; margin-left:auto; flex-shrink: 0;">
                <button onclick="copyFileLink('${downloadUrl}')" style="background:none; border:none; color:var(--accent-light); font-size:0.78rem; font-weight:600; cursor:pointer; padding:0; white-space:nowrap;">Copy Link</button>
                <a href="${downloadUrl}" download="${escapeAttr(displayName)}" target="_blank" style="color:var(--accent-light);font-size:0.78rem;font-weight:600;text-decoration:none;white-space:nowrap;">Download</a>
                <button class="delete-btn" onclick="deletePendingItem('${escapeAttr(item.id)}')" style="background:none; border:none; color:var(--text3); font-size:1.05rem; cursor:pointer; padding:4px; display:inline-flex; align-items:center;">🗑️</button>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    async function deletePendingItem(itemId) {
      if (!itemId) return;
      try {
        const res = await doFetch(`/api/pending/${itemId}/ack`, { method: 'POST' });
        if (res.ok) {
          showToast('Item deleted');
          fetchPending();
        } else {
          showToast('Failed to delete item');
        }
      } catch (err) {
        console.error('Delete item error:', err);
        showToast('Failed to delete item');
      }
    }

    async function handleReceiveText(text) {
      try {
        await navigator.clipboard.writeText(text);
        showToast('Copied to clipboard');
      } catch {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Copied to clipboard');
      }
    }

    async function copyFileLink(url) {
      const fullUrl = window.location.origin + url;
      try {
        await navigator.clipboard.writeText(fullUrl);
        showToast('Link copied to clipboard');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = fullUrl;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Link copied to clipboard');
      }
    }

    // ─── PWA Install Banner ───────────────────────────────────
    function setupPWA() {
      let deferredPrompt = null;

      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        // Show banner after a delay
        setTimeout(() => {
          document.getElementById('pwaBanner').classList.add('show');
        }, 2000);
      });

      document.getElementById('pwaAdd').addEventListener('click', async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          const result = await deferredPrompt.userChoice;
          if (result.outcome === 'accepted') {
            showToast('Added to Home Screen!');
          }
          deferredPrompt = null;
        }
        document.getElementById('pwaBanner').classList.remove('show');
      });

      document.getElementById('pwaClose').addEventListener('click', () => {
        document.getElementById('pwaBanner').classList.remove('show');
      });

      // Register service worker
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      }
    }

    // ─── Utilities ────────────────────────────────────────────
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }

    function escapeHtml(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function escapeAttr(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function timeAgo(iso) {
      const diff = Date.now() - new Date(iso).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1) return 'now';
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h';
      return Math.floor(h / 24) + 'd';
    }

    function setupSendControls() {
      const sendTextBtn = document.getElementById('sendTextBtn');
      const mobileTextInput = document.getElementById('mobileTextInput');
      if (sendTextBtn && mobileTextInput) {
        sendTextBtn.addEventListener('click', async () => {
          const text = mobileTextInput.value.trim();
          if (!text) return showToast('Please enter some text');
          sendTextBtn.disabled = true;
          try {
            const res = await doFetch('/api/text', {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain' },
              body: text
            });
            if (res.ok) {
              mobileTextInput.value = '';
              showToast('Sent successfully!');
            } else {
              showToast('Failed to send text');
            }
          } catch {
            showToast('Failed to connect to server');
          } finally {
            sendTextBtn.disabled = false;
          }
        });
      }

      const sendFileTrigger = document.getElementById('sendFileTrigger');
      const mobileFileInput = document.getElementById('mobileFileInput');
      const mobileFilePreview = document.getElementById('mobileFilePreview');
      const mobilePreviewImg = document.getElementById('mobilePreviewImg');
      const mobilePreviewFileIcon = document.getElementById('mobilePreviewFileIcon');
      const mobilePreviewFileName = document.getElementById('mobilePreviewFileName');
      const sendFileBtn = document.getElementById('sendFileBtn');

      let selectedFile = null;

      if (sendFileTrigger && mobileFileInput) {
        sendFileTrigger.addEventListener('click', () => mobileFileInput.click());
        mobileFileInput.addEventListener('change', () => {
          if (mobileFileInput.files.length > 0) {
            selectedFile = mobileFileInput.files[0];
            sendFileTrigger.style.display = 'none';
            mobileFilePreview.style.display = 'flex';
            mobilePreviewFileName.textContent = `${selectedFile.name} (${formatSize(selectedFile.size)})`;

            if (selectedFile.type.startsWith('image/')) {
              const reader = new FileReader();
              reader.onload = (e) => {
                mobilePreviewImg.src = e.target.result;
                mobilePreviewImg.style.display = 'block';
                mobilePreviewFileIcon.style.display = 'none';
              };
              reader.readAsDataURL(selectedFile);
            } else {
              mobilePreviewImg.style.display = 'none';
              mobilePreviewFileIcon.style.display = 'block';
              mobilePreviewFileIcon.textContent = getFileTypeIcon(selectedFile.type);
            }
          }
        });
      }

      if (sendFileBtn) {
        sendFileBtn.addEventListener('click', async () => {
          if (!selectedFile) return;
          sendFileBtn.disabled = true;
          const formData = new FormData();
          formData.append('file', selectedFile);

          try {
            const res = await doFetch('/api/file', {
              method: 'POST',
              body: formData
            });
            if (res.ok) {
              showToast('File sent to PC!');
              selectedFile = null;
              mobileFileInput.value = '';
              mobileFilePreview.style.display = 'none';
              sendFileTrigger.style.display = 'flex';
            } else {
              showToast('Failed to send file');
            }
          } catch {
            showToast('Failed to send file');
          } finally {
            sendFileBtn.disabled = false;
          }
        });
      }
    }

    function setupScratchpad() {
      const scratchpad = document.getElementById('mobileScratchpad');
      const scratchpadStatus = document.getElementById('scratchpadStatus');
      if (scratchpad) {
        doFetch('/api/scratchpad')
          .then(res => res.json())
          .then(data => {
            scratchpad.value = data.text || '';
          });

        let scratchpadTimer = null;
        scratchpad.addEventListener('input', () => {
          if (scratchpadStatus) {
            scratchpadStatus.textContent = 'Saving...';
            scratchpadStatus.style.color = 'var(--text2)';
          }
          clearTimeout(scratchpadTimer);
          scratchpadTimer = setTimeout(async () => {
            try {
              const res = await doFetch('/api/scratchpad', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: scratchpad.value })
              });
              if (res.ok && scratchpadStatus) {
                scratchpadStatus.textContent = 'Synced';
                scratchpadStatus.style.color = 'var(--success)';
              } else if (scratchpadStatus) {
                scratchpadStatus.textContent = 'Error';
                scratchpadStatus.style.color = 'red';
              }
            } catch {
              if (scratchpadStatus) {
                scratchpadStatus.textContent = 'Offline';
                scratchpadStatus.style.color = 'red';
              }
            }
          }, 500);
        });
      }
    }

    let _mobileSSE = null;
    function connectMobileSSE() {
      // Close any existing SSE connection before opening a new one
      if (_mobileSSE) { try { _mobileSSE.close(); } catch {} _mobileSSE = null; }
      const token = localStorage.getItem('deviceToken');
      const sseUrl = `/api/events?token=${token}`;
      const sse = new EventSource(sseUrl);
      _mobileSSE = sse;
      sse.addEventListener('scratchpad', (e) => {
        const data = JSON.parse(e.data);
        const scratchpad = document.getElementById('mobileScratchpad');
        const scratchpadStatus = document.getElementById('scratchpadStatus');
        if (scratchpad && document.activeElement !== scratchpad) {
          scratchpad.value = data.text;
        }
        if (scratchpadStatus) {
          scratchpadStatus.textContent = 'Synced';
          scratchpadStatus.style.color = 'var(--success)';
        }
      });
      sse.onerror = () => {
        sse.close();
        _mobileSSE = null;
        setTimeout(connectMobileSSE, 1000);
      };
    }

    function setupMobileControl() {
      document.querySelectorAll('.btn-control-cmd').forEach(btn => {
        btn.addEventListener('click', async () => {
          const action = btn.getAttribute('data-cmd');
          btn.disabled = true;
          try {
            const res = await doFetch('/api/control', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action })
            });
            if (res.ok) {
              showToast(`Triggered: ${action}`);
            } else {
              showToast('Failed to trigger action');
            }
          } catch {
            showToast('Failed to connect to server');
          } finally {
            btn.disabled = false;
          }
        });
      });
    }

    function setupMobileScreenshot() {
      const btnFetch = document.getElementById('btnFetchScreenshot');
      const container = document.getElementById('screenshotPreviewContainer');
      const img = document.getElementById('mobileScreenshotImg');
      const btnClose = document.getElementById('btnCloseScreenshot');

      if (btnFetch && container && img && btnClose) {
        btnFetch.addEventListener('click', async () => {
          btnFetch.disabled = true;
          btnFetch.textContent = 'Capturing...';
          try {
            const screenshotUrl = `/api/screenshot?t=${Date.now()}`;
            img.src = screenshotUrl;
            img.onload = () => {
              container.style.display = 'flex';
              btnFetch.style.display = 'none';
              btnFetch.disabled = false;
              btnFetch.textContent = '📸 View PC Screen';

              const btnDownload = document.getElementById('btnDownloadScreenshot');
              if (btnDownload) {
                btnDownload.href = screenshotUrl;
              }
            };
            img.onerror = () => {
              showToast('Failed to load screenshot');
              btnFetch.disabled = false;
              btnFetch.textContent = '📸 View PC Screen';
            };
          } catch {
            showToast('Failed to fetch screenshot');
            btnFetch.disabled = false;
            btnFetch.textContent = '📸 View PC Screen';
          }
        });

        const btnFullscreen = document.getElementById('btnFullscreenScreenshot');
        const lightbox = document.getElementById('screenshotLightbox');
        const lightboxImg = document.getElementById('lightboxImg');
        const btnCloseLightbox = document.getElementById('btnCloseLightbox');

        if (btnFullscreen && lightbox && lightboxImg && btnCloseLightbox) {
          btnFullscreen.addEventListener('click', () => {
            if (img.src) {
              lightboxImg.src = img.src;
              lightbox.style.display = 'flex';
            }
          });

          btnCloseLightbox.addEventListener('click', () => {
            lightbox.style.display = 'none';
            lightboxImg.src = '';
          });
        }

        btnClose.addEventListener('click', () => {
          container.style.display = 'none';
          btnFetch.style.display = 'flex';
          img.onload = null;
          img.onerror = null;
          img.src = '';
          const t = document.getElementById('toast');
          if (t) t.classList.remove('show');
        });
      }
    }

    let trackpadSocket = null;
    let phonePC = null;
    let micPC = null;
    let micStream = null;
    let isMicStreaming = false;
    let isTrackpadOpen = false;
    let audioOnlyStreamMode = false;
    let syncAudioStates = function() {};
    let wakeLock = null;

    async function requestWakeLock() {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await navigator.wakeLock.request('screen');
          console.log('[WakeLock] Screen Wake Lock active');
        }
      } catch (err) {
        console.warn('[WakeLock] Failed to request screen wake lock:', err);
      }
    }

    function releaseWakeLock() {
      if (wakeLock) {
        wakeLock.release().then(() => {
          wakeLock = null;
          console.log('[WakeLock] Screen Wake Lock released');
        });
      }
    }

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') {
        // Re-acquire wake lock
        if (wakeLock !== null) {
          await requestWakeLock();
        }
        // ─── Instant reconnect on screen unlock ───
        // When the phone was locked, iOS/Android kill idle TCP sockets.
        // Instead of waiting for a timeout, reconnect immediately.
        if (wsWantsConnected && (!trackpadSocket || trackpadSocket.readyState !== WebSocket.OPEN)) {
          wsReconnectDelay = 200;
          if (trackpadSocket) { try { trackpadSocket.close(); } catch {} trackpadSocket = null; }
          wsConnecting = false;
          connectWS();
        }
        // Reconnect SSE if it was dropped
        connectMobileSSE();
      }
    });
    let wsWantsConnected = false;
    let wsConnecting = false;
    let wsReconnectDelay = 200; // Start fast, back off on repeated failures
    let audioCtx = null;
    function playPingSound() {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          if (!audioCtx) {
            audioCtx = new AudioContext();
          }
          if (audioCtx.state === 'suspended') {
            audioCtx.resume();
          }
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(880, audioCtx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(110, audioCtx.currentTime + 0.3);
          gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.3);
        }
        triggerHaptic([100, 50, 100]);
      } catch (err) {
        console.warn('AudioContext error:', err);
      }
    }

    document.addEventListener('click', () => {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    }, { once: true });

    function updateUniversalConnectButton(state) {
      const btn = document.getElementById('btnUniversalConnect');
      if (!btn) return;
      switch (state) {
        case 'disconnected':
          btn.innerHTML = '🔌 Connect PC Services';
          btn.style.background = 'rgba(255,255,255,0.08)';
          btn.style.borderColor = 'var(--card-border)';
          break;
        case 'connecting':
          btn.innerHTML = '⏳ Connecting to PC...';
          btn.style.background = 'rgba(255,255,255,0.05)';
          btn.style.borderColor = 'var(--card-border)';
          break;
        case 'connected':
          btn.innerHTML = '🟢 Services Connected';
          btn.style.background = 'rgba(16,185,129,0.15)';
          btn.style.borderColor = '#10b981';
          break;
        case 'failed':
          btn.innerHTML = '🔴 Connection Failed — Retry';
          btn.style.background = 'rgba(239,68,68,0.15)';
          btn.style.borderColor = '#ef4444';
          break;
      }
    }

    function connectWS() {
      if (wsConnecting) return;
      wsConnecting = true;
      updateUniversalConnectButton('connecting');

      const token = localStorage.getItem('deviceToken') || '';
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/trackpad?token=${token}`);

      ws.onopen = () => {
        wsConnecting = false;
        wsReconnectDelay = 200; // Reset backoff on successful connection
        trackpadSocket = ws;
        updateUniversalConnectButton('connected');
        showToast('Connected to PC Services');
        let mobileName = 'Mobile Device';
        if (/iPad|iPhone|iPod/.test(navigator.userAgent)) mobileName = 'iPhone';
        else if (/Android/.test(navigator.userAgent)) mobileName = 'Android Device';
        sendWS({ type: 'identify', deviceName: mobileName });

        if (streamActive) {
          console.log('[WebRTC] Re-requesting active background stream after reconnect...');
          sendWS({ type: 'screencast_start', audioOnly: audioOnlyStreamMode });
        } else if (window._pendingScreencastStart) {
          window._pendingScreencastStart = false;
          if (window._pendingScreencastMode === 'audio') {
            const btnQuick = document.getElementById('btnQuickAudioStream');
            if (btnQuick) btnQuick.click();
          } else {
            const btn = document.getElementById('btnOpenScreencast');
            if (btn) btn.click();
          }
        }
      };

      function createPhonePeerConnection() {
        if (phonePC) {
          try { phonePC.close(); } catch(e) {}
        }
        phonePC = new RTCPeerConnection({
          iceServers: []
        });
        phonePC.onicecandidate = (event) => {
          if (event.candidate) {
            sendWS({
              type: 'webrtc_ice_candidate',
              candidate: event.candidate
            });
          }
        };
        phonePC.ontrack = (event) => {
          console.log('[WebRTC] Track received:', event.streams);
          const liveFrame = document.getElementById('liveScreenFrame');
          if (liveFrame && event.streams && event.streams[0]) {
            liveFrame.srcObject = event.streams[0];
            if (audioOnlyStreamMode) {
              liveFrame.muted = false;
            }
            syncAudioStates();
          }
        };
      }

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'revoked') {
            localStorage.removeItem('deviceToken');
            showToast('Device revoked by PC!', 'error');
            setTimeout(() => {
              window.location.reload();
            }, 1200);
            return;
          }
          if (data.type === 'ping') {
            playPingSound();
            showToast('Device Pinged by PC!');
            return;
          }
          if (data.type === 'privacy_pause') {
            if (window._isScreencasting) {
              const previewImg = document.getElementById('scPreviewImg');
              if (previewImg) {
                previewImg.style.filter = data.pause ? 'blur(15px) brightness(0.5)' : '';
              }
              if (data.pause) {
                showToast('PC Paused Screencast for Privacy');
              } else {
                showToast('PC Resumed Screencast');
              }
            }
            return;
          }
          if (data.type === 'webrtc_offer') {
            console.log('[WebRTC] SDP Offer received from PC.');
            createPhonePeerConnection();
            await phonePC.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await phonePC.createAnswer();
            await phonePC.setLocalDescription(answer);
            sendWS({
              type: 'webrtc_answer',
              answer: answer
            });
          } else if (data.type === 'webrtc_ice_candidate') {
            if (phonePC && data.candidate) {
              await phonePC.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
          } else if (data.type === 'mic_answer') {
            console.log('[MicWebRTC] Received SDP Answer from PC.');
            if (micPC) {
              await micPC.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
          } else if (data.type === 'mic_ice_candidate') {
            if (micPC && data.candidate) {
              await micPC.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
          } else if (data.type === 'mic_stop') {
            console.log('[MicWebRTC] Received mic stop trigger from PC.');
            stopMicStreaming();
          }
        } catch (err) {
          console.error('[WebRTC] Signaling message handling failed:', err);
        }
      };

      ws.onerror = () => {
        wsConnecting = false;
        updateUniversalConnectButton('failed');
      };

      ws.onclose = () => {
        wsConnecting = false;
        if (trackpadSocket === ws) trackpadSocket = null;
        updateUniversalConnectButton('disconnected');
        if (isMicStreaming) {
          stopMicStreaming();
        }
        const btnCloseScreencast = document.getElementById('btnCloseScreencast');
        if (btnCloseScreencast) {
          btnCloseScreencast.click();
        }
        if (wsWantsConnected) {
          const delay = wsReconnectDelay;
          wsReconnectDelay = Math.min(wsReconnectDelay * 2, 5000); // Exponential backoff, max 5s
          setTimeout(() => {
            if (wsWantsConnected && !wsConnecting) {
              connectWS();
            }
          }, delay);
        }
      };
    }

    function disconnectWS() {
      wsWantsConnected = false;
      wsConnecting = false;
      if (trackpadSocket) {
        const ws = trackpadSocket;
        trackpadSocket = null;
        ws.close();
      }
      updateUniversalConnectButton('disconnected');
    }

    function sendWS(msg) {
      if (trackpadSocket && trackpadSocket.readyState === WebSocket.OPEN) {
        trackpadSocket.send(JSON.stringify(msg));
      }
    }

    function setupUniversalConnect() {
      const btn = document.getElementById('btnUniversalConnect');
      if (!btn) return;
      btn.addEventListener('click', () => {
        if (trackpadSocket && trackpadSocket.readyState === WebSocket.OPEN) {
          disconnectWS();
        } else {
          wsWantsConnected = true;
          connectWS();
        }
      });
      // Auto-connect on page load
      wsWantsConnected = true;
      connectWS();
    }

    function setupMobileTrackpad() {
      const btnOpen = document.getElementById('btnOpenTrackpad');
      const overlay = document.getElementById('trackpadOverlay');
      const btnClose = document.getElementById('btnCloseTrackpad');
      const touchpadArea = document.getElementById('touchpadArea');
      const keyboardInput = document.getElementById('trackpadKeyboardInput');
      const btnLeft = document.getElementById('btnTrackpadLeftClick');
      const btnRight = document.getElementById('btnTrackpadRightClick');
      const btnToggleKbd = document.getElementById('btnToggleKeyboard');
      const kbdPanel = document.getElementById('keyboardPanel');

      if (!btnOpen || !overlay || !btnClose || !touchpadArea) return;

      // ── Overlay Open / Close ──
      btnOpen.addEventListener('click', () => {
        if (!trackpadSocket || trackpadSocket.readyState !== WebSocket.OPEN) {
          wsWantsConnected = true;
          connectWS();
        }
        overlay.style.display = 'flex';
        isTrackpadOpen = true;
        setTimeout(() => {
          if (keyboardInput) {
            keyboardInput.value = '';
            keyboardInput.focus();
          }
        }, 300);
      });

      btnClose.addEventListener('click', () => {
        overlay.style.display = 'none';
        isTrackpadOpen = false;
      });

      // ── Screencast button removed from trackpad overlay (now separate overlay)
      // ── Keyboard Panel Toggle ──
      if (btnToggleKbd && kbdPanel) {
        btnToggleKbd.addEventListener('click', () => {
          const isOpen = kbdPanel.style.display !== 'none';
          kbdPanel.style.display = isOpen ? 'none' : 'block';
          btnToggleKbd.textContent = isOpen ? '⌨️ Keyboard ▼' : '⌨️ Keyboard ▲';
        });
      }

      // ── Touch Trackpad Logic ──
      let touchpadMaxTouches = 0;
      let touchpadStartTime = 0;
      let touchpadHasMoved = false;
      let touchpadLastX = 0;
      let touchpadLastY = 0;
      let touchpadStartX = 0;
      let touchpadStartY = 0;
      let touchpadIsScrolling = false;
      let touchpadInitialScrollY = 0;
      let touchpadTapTimeout = null;
      let touchpadLastTapTime = 0;

      touchpadArea.addEventListener('touchstart', (e) => {
        const touches = e.touches;
        if (touches.length === 1) {
          touchpadMaxTouches = 1;
          touchpadHasMoved = false;
          touchpadIsScrolling = false;
          touchpadStartX = touchpadLastX = touches[0].clientX;
          touchpadStartY = touchpadLastY = touches[0].clientY;
          touchpadStartTime = Date.now();
          
          // Visual Cursor Dot
          const rect = touchpadArea.getBoundingClientRect();
          const dot = document.getElementById('touchpadCursorDot');
          if (dot) {
            dot.style.display = 'block';
            dot.style.left = (touches[0].clientX - rect.left) + 'px';
            dot.style.top = (touches[0].clientY - rect.top) + 'px';
          }
        } else if (touches.length === 2) {
          touchpadMaxTouches = 2;
          touchpadIsScrolling = true;
          touchpadInitialScrollY = (touches[0].clientY + touches[1].clientY) / 2;
          
          const dot = document.getElementById('touchpadCursorDot');
          if (dot) dot.style.display = 'none';
        }
      }, { passive: true });

      touchpadArea.addEventListener('touchmove', (e) => {
        const touches = e.touches;
        if (touches.length === 1 && !touchpadIsScrolling) {
          // If in presentation mode, don't move cursor, wait for touchend tap
          const presMode = document.getElementById('presentationModeToggle');
          if (presMode && presMode.checked) return;

          const cx = touches[0].clientX, cy = touches[0].clientY;
          if (Math.abs(cx - touchpadStartX) > 6 || Math.abs(cy - touchpadStartY) > 6) {
            touchpadHasMoved = true;
          }
          sendWS({ type: 'move', dx: (cx - touchpadLastX) * 1.8, dy: (cy - touchpadLastY) * 1.8 });
          touchpadLastX = cx; touchpadLastY = cy;
          
          // Visual Cursor Dot
          const rect = touchpadArea.getBoundingClientRect();
          const dot = document.getElementById('touchpadCursorDot');
          if (dot) {
            dot.style.left = (cx - rect.left) + 'px';
            dot.style.top = (cy - rect.top) + 'px';
          }
        } else if (touches.length === 2 && touchpadIsScrolling) {
          e.preventDefault();
          const cy = (touches[0].clientY + touches[1].clientY) / 2;
          if (Math.abs(cy - touchpadInitialScrollY) > 2) {
            touchpadHasMoved = true;
          }
          sendWS({ type: 'scroll', dy: (cy - touchpadInitialScrollY) / 100 });
          touchpadInitialScrollY = cy;
        }
      }, { passive: false });

      touchpadArea.addEventListener('touchend', (e) => {
        const dot = document.getElementById('touchpadCursorDot');
        if (dot) dot.style.display = 'none';
        if (e.touches.length > 0) return; // Wait until all fingers leave

        const duration = Date.now() - touchpadStartTime;

        if (touchpadMaxTouches === 2) {
          if (!touchpadHasMoved && duration < 250) {
            sendWS({ type: 'click', button: 'right' });
            showToast('🖱️ Right Click', 600);
          }
          touchpadIsScrolling = false;
          return;
        }

        if (!touchpadHasMoved && duration < 250) {
          triggerHaptic(10);

          const presMode = document.getElementById('presentationModeToggle');
          if (presMode && presMode.checked) {
            // Presentation mode tap logic
            const screenWidth = window.innerWidth;
            if (touchpadLastX < screenWidth / 2) {
              sendWS({ type: 'key', code: 37 }); // ArrowLeft
              showToast('⏮ Previous Slide', 600);
            } else {
              sendWS({ type: 'key', code: 39 }); // ArrowRight
              showToast('⏭ Next Slide', 600);
            }
            return;
          }

          const now = Date.now();
          if (now - touchpadLastTapTime < 300) {
            if (touchpadTapTimeout) clearTimeout(touchpadTapTimeout);
            sendWS({ type: 'click', button: 'left' });
            setTimeout(() => sendWS({ type: 'click', button: 'left' }), 50);
            showToast('🖱️ Double Click', 600);
            touchpadLastTapTime = 0;
          } else {
            touchpadLastTapTime = now;
            touchpadTapTimeout = setTimeout(() => {
              sendWS({ type: 'click', button: 'left' });
              showToast('🖱️ Left Click', 600);
              touchpadTapTimeout = null;
            }, 220);
          }
        }
      }, { passive: false });

      // ── Click Buttons ──
      const sendClick = (btnType) => {
        triggerHaptic(15);
        sendWS({ type: 'click', button: btnType });
      };

      btnLeft.addEventListener('click', () => sendClick('left'));
      btnRight.addEventListener('click', () => sendClick('right'));

      // ── Keyboard Input (Diff Typing) ──
      let lastInputValue = '';
      if (keyboardInput) {
        keyboardInput.value = '';
        keyboardInput.addEventListener('input', () => {
          const val = keyboardInput.value;
          if (val.length < lastInputValue.length) {
            const diff = lastInputValue.length - val.length;
            for (let i = 0; i < diff; i++) sendWS({ type: 'key', code: 8 });
          } else if (val.length > lastInputValue.length) {
            const added = val.substring(lastInputValue.length);
            for (const ch of added) {
              if (ch === ' ') sendWS({ type: 'key', code: 32 });
              else if (ch === '\n' || ch === '\r') sendWS({ type: 'key', code: 13 });
              else sendWS({ type: 'type', text: ch });
            }
          }
          lastInputValue = val;
        });
        keyboardInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') sendWS({ type: 'key', code: 13 });
        });
      }

      // ── Clear Input ──
      const btnClearInput = document.getElementById('btnTrackpadClearInput');
      if (btnClearInput && keyboardInput) {
        btnClearInput.addEventListener('click', () => {
          keyboardInput.value = '';
          lastInputValue = '';
          keyboardInput.focus();
        });
      }

      document.querySelectorAll('.btn-kbd').forEach(btn => {
        btn.addEventListener('click', () => {
          triggerHaptic(5);
          const code = parseInt(btn.getAttribute('data-code'), 10);
          const char = btn.getAttribute('data-char');
          if (code) {
            sendWS({ type: 'key', code });
          } else if (char) {
            sendWS({ type: 'type', text: char });
          }
          btn.style.background = 'rgba(255,255,255,0.25)';
          setTimeout(() => { btn.style.background = ''; }, 120);
        });
      });
    }

    // ─── Screencast Overlay Setup ───────────────────────────────
    function setupScreencastOverlay() {
      const overlay = document.getElementById('screencastOverlay');
      const frame = document.getElementById('liveScreenFrame');
      const btnClose = document.getElementById('btnCloseScreencast');
      const btnMode = document.getElementById('btnScreencastMode');
      const btnKeyboard = document.getElementById('btnScreencastKeyboard');
      const btnOpen = document.getElementById('btnOpenScreencast');
      const cursorDot = document.getElementById('scCursorDot');
      const keyboardPanel = document.getElementById('scKeyboardPanel');
      const scKeyboardInput = document.getElementById('scKeyboardInput');
      const btnScKeyboardClear = document.getElementById('btnScKeyboardClear');
      const btnScKeyboardClose = document.getElementById('btnScKeyboardClose');
      const viewHint = document.getElementById('scViewHint');
      const btnFit = document.getElementById('btnScreencastFit');
      const btnAudio = document.getElementById('btnScreencastAudio');
      const btnScreencastMic = document.getElementById('btnScreencastMic');
      const btnTools = document.getElementById('btnScreencastTools');
      const btnSpeed = document.getElementById('btnScreencastSpeed');
      const dropdownMenu = document.getElementById('screencastToolsDropdown');
      const toolsArrow = document.getElementById('svgToolsArrow');
      const btnPiP = document.getElementById('btnScreencastPiP');

      const isPiPSupported = (document.pictureInPictureEnabled && frame.requestPictureInPicture) ||
                             (frame.webkitSupportsPresentationMode && frame.webkitSupportsPresentationMode("picture-in-picture"));

      if (btnPiP && isPiPSupported) {
        btnPiP.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            if (window.navigator.standalone) {
              throw new Error('iOS limits PiP in standalone PWA mode. Please open AiroDrop in regular Safari to use Picture-in-Picture.');
            }
            if (document.pictureInPictureElement) {
              await document.exitPictureInPicture();
            } else if (frame.webkitPresentationMode === "picture-in-picture") {
              frame.webkitSetPresentationMode("inline");
            } else if (frame.requestPictureInPicture) {
              await frame.requestPictureInPicture();
            } else if (frame.webkitSetPresentationMode) {
              frame.webkitSetPresentationMode("picture-in-picture");
            }
          } catch (err) {
            showToast(err.message, 'warning', 6000);
          }
          dropdownMenu.style.display = 'none';
        });
      } else if (btnPiP) {
        btnPiP.style.display = 'none'; // hide if not supported
      }

      const btnQuickAudio = document.getElementById('btnQuickAudioStream');
      const quickAudioIcon = document.getElementById('quickAudioStreamIcon');

      syncAudioStates = function() {
        const isMuted = !frame || frame.muted || !frame.srcObject;
        if (btnAudio) {
          btnAudio.innerHTML = isMuted ? 'Audio: Off' : 'Audio: On';
          btnAudio.style.color = !isMuted ? '#00d26a' : 'white';
          btnAudio.style.background = !isMuted ? 'rgba(0,210,106,0.12)' : 'rgba(255,255,255,0.06)';
          btnAudio.style.borderColor = !isMuted ? 'rgba(0,210,106,0.4)' : 'rgba(255,255,255,0.1)';
        }
        
        const quickAudioLabel = document.getElementById('quickAudioStreamLabel');
        if (btnQuickAudio && quickAudioIcon && quickAudioLabel) {
          quickAudioLabel.textContent = isMuted ? 'Stream PC Audio Only: Off' : 'Stream PC Audio Only: On';
          btnQuickAudio.style.background = !isMuted ? 'rgba(0,210,106,0.15)' : 'rgba(255,255,255,0.05)';
          btnQuickAudio.style.borderColor = !isMuted ? 'rgba(0,210,106,0.4)' : 'var(--card-border)';
          btnQuickAudio.style.color = !isMuted ? '#00d26a' : 'var(--text)';
          
          if (isMuted) {
            quickAudioIcon.innerHTML = `<svg id="svgQuickAudio" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
          } else {
            quickAudioIcon.innerHTML = `<svg id="svgQuickAudio" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
          }
        }
        updateWakeLockStatus();
      };

      async function updateWakeLockStatus() {
        const isOverlayVisible = overlay && overlay.style.display === 'flex';
        const isAudioActive = frame && !frame.muted && frame.srcObject;
        if (isOverlayVisible || isAudioActive) {
          await requestWakeLock();
        } else {
          releaseWakeLock();
        }
      }

      if (!overlay || !btnOpen) return;

      let interactiveMode = true;
      let streamActive = false;
      let controlStyle = 'cursor';
      let fitMode = 100; // 100, 90, 80, 70
      let virtualX = 0.5;
      let virtualY = 0.5;
      let cursorSpeed = 1.5;

      // ── Open button ──
      btnOpen.addEventListener('click', () => {
        if (!trackpadSocket || trackpadSocket.readyState !== WebSocket.OPEN) {
          wsWantsConnected = true;
          window._pendingScreencastStart = true;
          window._pendingScreencastMode = 'full';
          connectWS();
          showToast('Connecting to PC Services...');
          return;
        }
        overlay.style.display = 'flex';
        streamActive = true;
        // Restore keyboard button visibility (may have been hidden on previous close)
        if (btnKeyboard) btnKeyboard.style.display = interactiveMode ? 'block' : 'none';
        updateWakeLockStatus();

        const isStreamActive = !!(frame && frame.srcObject);
        if (!isStreamActive) {
          audioOnlyStreamMode = false;
          sendWS({ type: 'screencast_start' });
        } else {
          // Stream is already running (e.g. from quick audio streaming)
          // Transition audioOnlyStreamMode to false (since the user is opening the full screenshare UI)
          audioOnlyStreamMode = false;
          syncAudioStates();
          showToast('🖥️ Screencast active');
        }
      });

      // ── Close button ──
      btnClose.addEventListener('click', () => {
        overlay.style.display = 'none';
        streamActive = false;
        interactiveMode = true;
        audioOnlyStreamMode = false;
        if (dropdownMenu) dropdownMenu.style.display = 'none';
        if (toolsArrow) toolsArrow.style.transform = '';
        if (keyboardPanel) keyboardPanel.style.display = 'none';
        if (btnKeyboard) btnKeyboard.style.display = 'none';
        cursorSpeed = 1.5;
        if (btnSpeed) btnSpeed.textContent = 'Speed: 1.5x';
        if (phonePC) {
          try { phonePC.close(); } catch(e) {}
          phonePC = null;
        }
        if (frame) {
          frame.srcObject = null;
          frame.muted = true;
        }
        syncAudioStates();
        if (trackpadSocket && trackpadSocket.readyState === WebSocket.OPEN) {
          sendWS({ type: 'screencast_stop' });
        }
      });

      // ── Tools Dropdown Toggle ──
      if (btnTools && dropdownMenu) {
        btnTools.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = dropdownMenu.style.display === 'flex';
          dropdownMenu.style.display = isOpen ? 'none' : 'flex';
          if (toolsArrow) {
            toolsArrow.style.transform = isOpen ? '' : 'rotate(180deg)';
          }
        });

        // Close dropdown when tapping anywhere else on screencast screen
        overlay.addEventListener('click', () => {
          dropdownMenu.style.display = 'none';
          if (toolsArrow) {
            toolsArrow.style.transform = '';
          }
        });
      }

      // ── Fit Screen Toggle ──
      if (btnFit) {
        btnFit.addEventListener('click', () => {
          if (fitMode === 100) fitMode = 90;
          else if (fitMode === 90) fitMode = 80;
          else if (fitMode === 80) fitMode = 70;
          else fitMode = 100;

          btnFit.textContent = `Fit: ${fitMode}%`;
          btnFit.style.background = fitMode !== 100 ? 'rgba(255,85,0,0.35)' : 'rgba(255,255,255,0.08)';
          btnFit.style.borderColor = fitMode !== 100 ? 'rgba(255,85,0,0.6)' : 'rgba(255,255,255,0.15)';
          
          if (fitMode === 100) {
            frame.style.width = '100%';
            frame.style.height = '100%';
            frame.style.top = '0';
            frame.style.left = '0';
          } else {
            frame.style.width = `${fitMode}%`;
            frame.style.height = `${fitMode}%`;
            const offset = (100 - fitMode) / 2;
            frame.style.top = `${offset}%`;
            frame.style.left = `${offset}%`;
          }
        });
      }

      // ── Audio Toggle ──
      if (btnAudio) {
        btnAudio.addEventListener('click', () => {
          if (frame) {
            frame.muted = !frame.muted;
            syncAudioStates();
            if (!frame.muted) {
              showToast('🔊 Screencast audio enabled');
            } else {
              showToast('🔇 Screencast audio muted');
            }
          }
        });
      }

      // ── Mic Toggle in Tools ──
      if (btnScreencastMic) {
        btnScreencastMic.addEventListener('click', async () => {
          if (!isMicStreaming) {
            await startMicStreaming();
          } else {
            stopMicStreaming();
          }
        });
      }

      if (btnQuickAudio) {
        btnQuickAudio.addEventListener('click', () => {
          if (!trackpadSocket || trackpadSocket.readyState !== WebSocket.OPEN) {
            wsWantsConnected = true;
            window._pendingScreencastStart = true;
            window._pendingScreencastMode = 'audio';
            connectWS();
            showToast('Connecting to PC Services...');
            return;
          }

          const isStreamActive = !!(frame && frame.srcObject);
          if (!isStreamActive) {
            // Start stream in audio-only mode
            audioOnlyStreamMode = true;
            sendWS({ type: 'screencast_start' });
            showToast('🔊 Streaming system audio in background...');
          } else {
            // Stream is already active
            if (frame.muted) {
              // Unmute it
              frame.muted = false;
              audioOnlyStreamMode = true;
              showToast('🔊 PC system audio unmuted');
              syncAudioStates();
            } else {
              // Mute/stop it
              if (overlay.style.display === 'flex') {
                // Screencast is visible, so we just mute audio but keep screenshare
                frame.muted = true;
                syncAudioStates();
                showToast('🔇 Audio muted');
              } else {
                // Screencast is hidden, so stop the stream completely
                btnClose.click();
              }
            }
          }
        });
      }

      // ── Controls Toggle (On/Off) ──
      btnMode.addEventListener('click', () => {
        interactiveMode = !interactiveMode;
        btnMode.textContent = interactiveMode ? 'Controls: On' : 'Controls: Off';
        btnMode.style.color = interactiveMode ? '#00d26a' : 'white';
        btnMode.style.background = interactiveMode ? 'rgba(0,210,106,0.12)' : 'rgba(255,255,255,0.06)';
        btnMode.style.borderColor = interactiveMode ? 'rgba(0,210,106,0.4)' : 'rgba(255,255,255,0.1)';
        
        frame.style.cursor = interactiveMode ? 'none' : 'default';
        if (btnKeyboard) btnKeyboard.style.display = interactiveMode ? 'block' : 'none';
        if (viewHint) viewHint.style.display = interactiveMode ? 'none' : 'block';
        if (!interactiveMode && keyboardPanel) keyboardPanel.style.display = 'none';
        
        if (interactiveMode) {
          virtualX = 0.5;
          virtualY = 0.5;
        }
        showToast(interactiveMode ? 'Controls enabled' : 'Controls disabled');
      });

      // ── Mouse Speed Toggle ──
      if (btnSpeed) {
        btnSpeed.addEventListener('click', () => {
          if (cursorSpeed === 1.0) cursorSpeed = 1.5;
          else if (cursorSpeed === 1.5) cursorSpeed = 2.0;
          else if (cursorSpeed === 2.0) cursorSpeed = 2.5;
          else if (cursorSpeed === 2.5) cursorSpeed = 3.0;
          else cursorSpeed = 1.0;
          
          btnSpeed.textContent = `Speed: ${cursorSpeed.toFixed(1)}x`;
          showToast(`Cursor speed set to ${cursorSpeed.toFixed(1)}x`);
        });
      }

      // ── Keyboard panel toggle ──
      if (btnKeyboard) {
        btnKeyboard.addEventListener('click', () => {
          if (!keyboardPanel) return;
          const isVisible = keyboardPanel.style.display !== 'none';
          keyboardPanel.style.display = isVisible ? 'none' : 'block';
          if (!isVisible && scKeyboardInput) {
            setTimeout(() => scKeyboardInput.focus(), 100);
          }
        });
      }

      // ── Close keyboard panel ──
      if (btnScKeyboardClose) {
        btnScKeyboardClose.addEventListener('click', () => {
          if (keyboardPanel) keyboardPanel.style.display = 'none';
        });
      }

      // ── Synced Keyboard Input (Diff Typing) ──
      let scLastInputValue = '';
      if (scKeyboardInput) {
        scKeyboardInput.value = '';
        scKeyboardInput.addEventListener('input', () => {
          const val = scKeyboardInput.value;
          if (val.length < scLastInputValue.length) {
            const diff = scLastInputValue.length - val.length;
            for (let i = 0; i < diff; i++) sendWS({ type: 'key', code: 8 });
          } else if (val.length > scLastInputValue.length) {
            const added = val.substring(scLastInputValue.length);
            sendWS({ type: 'type', text: added });
          }
          scLastInputValue = val;
        });
      }

      if (btnScKeyboardClear && scKeyboardInput) {
        btnScKeyboardClear.addEventListener('click', () => {
          scKeyboardInput.value = '';
          scLastInputValue = '';
          scKeyboardInput.focus();
        });
      }

      // ── Virtual Key Grid (Screencast Keyboard) ──
      document.querySelectorAll('.btn-sc-kbd').forEach(btn => {
        btn.addEventListener('click', () => {
          const code = parseInt(btn.getAttribute('data-code'), 10);
          const char = btn.getAttribute('data-char');
          if (code) {
            sendWS({ type: 'key', code });
          } else if (char) {
            sendWS({ type: 'type', text: char });
          }
          btn.style.background = 'rgba(255,255,255,0.25)';
          setTimeout(() => { btn.style.background = ''; }, 120);
        });
      });





      // ── Touch Gesture Processing variables ──
      let scMaxTouches = 0;
      let scStartTime = 0;
      let scHasMoved = false;
      let scLastTouchX = 0;
      let scLastTouchY = 0;
      let scIsTwoFinger = false;
      let scLastScrollY = 0;
      let scTapTimeout = null;
      let scLastTapTime = 0;

      function getTouchMidpoint(e) {
        if (e.touches.length < 2) return { x: 0, y: 0 };
        return {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };
      }



      frame.addEventListener('touchstart', (e) => {
        if (!interactiveMode) return;
        
        const touches = e.touches;
        if (touches.length === 1) {
          scMaxTouches = 1;
          scIsTwoFinger = false;
          scHasMoved = false;
          scStartTime = Date.now();
          scLastTouchX = touches[0].clientX;
          scLastTouchY = touches[0].clientY;
        } else if (touches.length === 2) {
          scMaxTouches = 2;
          scIsTwoFinger = true;
          const mid = getTouchMidpoint(e);
          scLastScrollY = mid.y;
          scStartTime = Date.now();
          scHasMoved = false;
          // Prevent page scroll/zoom on two-finger start so touchmove preventDefault works
          e.preventDefault();
        }
      }, { passive: false });

      frame.addEventListener('touchmove', (e) => {
        if (!interactiveMode) return;

        const touches = e.touches;
        if (touches.length === 2 && scIsTwoFinger) {
          e.preventDefault();
          const mid = getTouchMidpoint(e);
          const dy = (mid.y - scLastScrollY) / 10;
          if (Math.abs(dy) > 0.05) scHasMoved = true;
          sendWS({ type: 'scroll', dy });
          scLastScrollY = mid.y;
        } else if (touches.length === 1 && !scIsTwoFinger) {
          e.preventDefault();
          const tx = touches[0].clientX;
          const ty = touches[0].clientY;
          
          const dx = tx - scLastTouchX;
          const dy = ty - scLastTouchY;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            scHasMoved = true;
          }
          const rect = frame.getBoundingClientRect();
          // Scale movement speed for precise trackpad feel
          const speed = cursorSpeed;
          const aspect = (frame.videoHeight && frame.videoWidth) ? (frame.videoHeight / frame.videoWidth) : (9 / 16);
          const scaleX = rect.width;
          const scaleY = rect.width * aspect;
          virtualX = Math.max(0, Math.min(1, virtualX + (dx / scaleX) * speed));
          virtualY = Math.max(0, Math.min(1, virtualY + (dy / scaleY) * speed));
          
          sendWS({ type: 'move_abs', xRatio: virtualX, yRatio: virtualY });
          
          scLastTouchX = tx;
          scLastTouchY = ty;
        }
      }, { passive: false });

      frame.addEventListener('touchend', (e) => {
        if (!interactiveMode || !trackpadSocket) return;
        e.preventDefault();

        if (e.touches.length > 0) return; // Wait until all fingers are lifted

        const duration = Date.now() - scStartTime;

        // Determine click coordinates ratio
        let clickX = virtualX;
        let clickY = virtualY;

        if (scMaxTouches === 2) {
          if (!scHasMoved && duration < 250) {
            sendWS({ type: 'click_abs', xRatio: clickX, yRatio: clickY, button: 'right' });
            showToast('Right Click', 600);
          }
          scIsTwoFinger = false;
          return;
        }

        if (duration < 250) {
          const now = Date.now();
          if (now - scLastTapTime < 300) {
            if (scTapTimeout) clearTimeout(scTapTimeout);
            // Mouse mode acts as standard double click at accumulated virtual coords
            sendWS({ type: 'click_abs', xRatio: clickX, yRatio: clickY, button: 'left' });
            setTimeout(() => {
              sendWS({ type: 'click_abs', xRatio: clickX, yRatio: clickY, button: 'left' });
            }, 50);
            showToast('Double Click', 600);
            scLastTapTime = 0;
          } else {
            scLastTapTime = now;
            scTapTimeout = setTimeout(() => {
              // Mouse mode click at accumulated virtual coords
              sendWS({ type: 'click_abs', xRatio: clickX, yRatio: clickY, button: 'left' });
              showToast('Left Click', 600);
              scTapTimeout = null;
            }, 200);
          }
        }
      }, { passive: false });
    }



    // ─── File Browser Overlay Setup ─────────────────────────────
    function setupFileBrowserOverlay() {
      const btnOpen = document.getElementById('btnOpenFileBrowser');
      const overlay = document.getElementById('fileBrowserOverlay');
      const iframe = document.getElementById('fileBrowserIframe');
      const btnClose = document.getElementById('btnCloseFileBrowser');

      if (!btnOpen || !overlay || !iframe || !btnClose) return;

      btnOpen.addEventListener('click', () => {
        iframe.src = '/files';
        overlay.style.display = 'flex';
      });

      btnClose.addEventListener('click', () => {
        overlay.style.display = 'none';
        iframe.src = 'about:blank';
      });

      const btnCloseVideo = document.getElementById('btnCloseVideoPlayer');
      if (btnCloseVideo) {
        btnCloseVideo.addEventListener('click', () => {
          const videoOverlay = document.getElementById('videoPlayerOverlay');
          const video = document.getElementById('videoPlayerEl');
          if (videoOverlay && video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
            videoOverlay.style.display = 'none';
          }
        });
      }
    }

    // ─── Stream Video Listener (from File Browser iframe) ───────
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'stream-video') {
        const overlay = document.getElementById('videoPlayerOverlay');
        const video = document.getElementById('videoPlayerEl');
        const title = document.getElementById('videoTitle');
        
        if (overlay && video && title) {
          title.textContent = event.data.name;
          video.src = event.data.url;
          overlay.style.display = 'flex';
          video.play().catch(e => {
            console.log('Autoplay blocked: ', e);
          });
        }
      }
    });

    // ─── WebRTC Microphone Streaming Sender ────────────────────────
    function setupMicStream() {
      const btnToggleMicStream = document.getElementById('btnToggleMicStream');
      const btnMicStreamLabel = document.getElementById('btnMicStreamLabel');

      if (!btnToggleMicStream) return;

      btnToggleMicStream.addEventListener('click', async () => {
        if (!isMicStreaming) {
          await startMicStreaming();
        } else {
          stopMicStreaming();
        }
      });
    }

    async function startMicStreaming() {
      const btnToggleMicStream = document.getElementById('btnToggleMicStream');
      const btnMicStreamLabel = document.getElementById('btnMicStreamLabel');

      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('Microphone access requires a secure HTTPS connection. Please enable HTTPS in PC settings and reload.', 'error', 8000);
        if (btnToggleMicStream) {
          btnToggleMicStream.disabled = false;
          btnToggleMicStream.style.background = '';
        }
        if (btnMicStreamLabel) btnMicStreamLabel.textContent = 'Start Microphone Stream';
        return;
      }

      try {
        if (btnToggleMicStream) btnToggleMicStream.disabled = true;
        if (btnMicStreamLabel) btnMicStreamLabel.textContent = 'Requesting Permission...';

        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

        if (btnMicStreamLabel) btnMicStreamLabel.textContent = 'Connecting...';

        if (micPC) {
          try { micPC.close(); } catch(e) {}
        }

        micPC = new RTCPeerConnection({
          iceServers: []
        });

        micStream.getTracks().forEach(track => micPC.addTrack(track, micStream));

        micPC.onicecandidate = (event) => {
          if (event.candidate) {
            sendWS({
              type: 'mic_ice_candidate',
              candidate: event.candidate
            });
          }
        };

        const offer = await micPC.createOffer();
        await micPC.setLocalDescription(offer);

        sendWS({
          type: 'mic_offer',
          offer: offer
        });

        isMicStreaming = true;
        if (btnToggleMicStream) {
          btnToggleMicStream.disabled = false;
          btnToggleMicStream.style.background = 'linear-gradient(135deg, #ef4444, #b91c1c)';
        }
        if (btnMicStreamLabel) btnMicStreamLabel.textContent = 'Stop Microphone Stream';

        const btnScreencastMic = document.getElementById('btnScreencastMic');
        if (btnScreencastMic) {
          btnScreencastMic.textContent = 'Mic: On';
          btnScreencastMic.style.color = '#00d26a';
          btnScreencastMic.style.background = 'rgba(0,210,106,0.12)';
          btnScreencastMic.style.borderColor = 'rgba(0,210,106,0.4)';
        }

        showToast('Microphone stream active!', 'success');

      } catch (err) {
        console.error('Failed to start microphone stream:', err);
        showToast('Failed to access microphone.', 'error');
        isMicStreaming = false;
        if (btnToggleMicStream) {
          btnToggleMicStream.disabled = false;
          btnToggleMicStream.style.background = '';
        }
        if (btnMicStreamLabel) btnMicStreamLabel.textContent = 'Start Microphone Stream';
      }
    }

    function stopMicStreaming() {
      const btnToggleMicStream = document.getElementById('btnToggleMicStream');
      const btnMicStreamLabel = document.getElementById('btnMicStreamLabel');

      if (micPC) {
        try { micPC.close(); } catch(e) {}
        micPC = null;
      }
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
      }
      sendWS({
        type: 'mic_stop'
      });

      isMicStreaming = false;
      if (btnToggleMicStream) {
        btnToggleMicStream.disabled = false;
        btnToggleMicStream.style.background = '';
      }
      if (btnMicStreamLabel) btnMicStreamLabel.textContent = 'Start Microphone Stream';

      const btnScreencastMic = document.getElementById('btnScreencastMic');
      if (btnScreencastMic) {
        btnScreencastMic.textContent = 'Mic: Off';
        btnScreencastMic.style.color = 'white';
        btnScreencastMic.style.background = 'rgba(255,255,255,0.06)';
        btnScreencastMic.style.borderColor = 'rgba(255,255,255,0.1)';
      }

      showToast('Microphone stream stopped.', 'info');
    }

    // ─── Start ────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);
  