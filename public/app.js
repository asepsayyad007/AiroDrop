/**
 * app.js — AiroDrop client-side controller
 * Premium Dark Theme default, settings updates (Port, Rate Limit, Notifications, Temp Hours), and instant QR generator.
 */

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────
  let serverInfo = null;
  let allItems = [];
  let currentFilter = 'all';
  let sseSource = null;
  let isConnected = false;

  // ─── DOM Helper ────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ─── Init ──────────────────────────────────────────────────
  async function init() {
    setupThemeSystem();
    setupTabs();
    setupFilters();
    setupEventListeners();
    setupSettings();
    setupInstantQrGenerator();
    
    await fetchServerInfo();
    connectSSE();
    await fetchHistory();
    await updateStats();
    
    // Periodic stats & storage updates
    setInterval(updateStats, 10000);
  }

  // ─── Theme System ──────────────────────────────────────────
  function setupThemeSystem() {
    const themeBtn = $('#themeBtn');
    const themeDropdown = $('#themeDropdown');
    const savedTheme = localStorage.getItem('airodrop_theme') || 'dark';

    setTheme(savedTheme);

    if (themeBtn && themeDropdown) {
      themeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        themeDropdown.classList.toggle('open');
      });

      document.addEventListener('click', () => {
        themeDropdown.classList.remove('open');
      });

      $$('.theme-option').forEach(option => {
        option.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const theme = option.getAttribute('data-theme');
          setTheme(theme);
          themeDropdown.classList.remove('open');
        });
      });
    }
  }

  function setTheme(themeName) {
    document.documentElement.setAttribute('data-theme', themeName);
    localStorage.setItem('airodrop_theme', themeName);
    
    // Update label in dropdown button
    const themeLabels = {
      'liquid-glass': 'Liquid Glass',
      'dark': 'Dark Mode',
      'light': 'Light Mode',
      'midnight': 'Midnight Blue',
      'aurora': 'Aurora Green'
    };
    
    const label = themeLabels[themeName] || 'Dark Mode';
    if ($('#themeBtnLabel')) {
      $('#themeBtnLabel').textContent = label;
    }

    // Toggle active state in list
    $$('.theme-option').forEach(opt => {
      if (opt.getAttribute('data-theme') === themeName) {
        opt.classList.add('active');
      } else {
        opt.classList.remove('active');
      }
    });
  }

  // ─── Server Info ───────────────────────────────────────────
  async function fetchServerInfo() {
    try {
      const res = await fetch('/api/info');
      if (!res.ok) return;
      serverInfo = await res.json();
      updateServerInfoUI(serverInfo);
    } catch (err) {
      console.error('Failed to fetch server info:', err);
    }
  }

  function updateServerInfoUI(info) {
    const baseUrl = info.url;
    $('#serverUrlText').textContent = baseUrl.replace(/^https?:\/\//, '');

    // Setup cards info
    if ($('#infoIP2')) $('#infoIP2').textContent = info.ip;
    if ($('#mobileUrl')) {
      $('#mobileUrl').textContent = `${baseUrl}/m`;
      $('#mobileUrl').href = `${baseUrl}/m`;
    }
    if ($('#unifiedEndpoint')) $('#unifiedEndpoint').textContent = `${baseUrl}/api/send`;
    if ($('#infoDeviceName')) $('#infoDeviceName').textContent = info.deviceName || 'PC Server';

    updateUptimeUI(info.uptime);

    // Setup QR code for mobile
    const qrContainer = $('#mobileQrContainer');
    if (qrContainer) {
      qrContainer.innerHTML = `<img src="/api/qr.png?t=${Date.now()}" alt="Setup QR Code" width="200" height="200">`;
    }
  }

  function updateUptimeUI(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    
    const uptimeStr = parts.join(' ');
    if ($('#infoUptime')) $('#infoUptime').textContent = uptimeStr;
    if ($('#statUptime')) $('#statUptime').textContent = uptimeStr;
  }

  // ─── Stats & Storage updates ───────────────────────────────
  async function updateStats() {
    try {
      const statsRes = await fetch('/api/stats');
      if (statsRes.ok) {
        const stats = await statsRes.json();
        if ($('#statTransfers')) $('#statTransfers').textContent = stats.transfers;
        if ($('#statData')) $('#statData').textContent = formatSize(stats.bytes);
        updateUptimeUI(stats.uptime);
        if ($('#statFiles')) $('#statFiles').textContent = stats.files;
      }

      const storageRes = await fetch('/api/storage');
      if (storageRes.ok) {
        const storage = await storageRes.json();
        const fillPercent = storage.limit > 0 ? Math.min(100, (storage.size / storage.limit) * 100) : 0;
        
        if ($('#storageProgressFill')) $('#storageProgressFill').style.width = `${fillPercent}%`;
        if ($('#storageUsed')) $('#storageUsed').textContent = `${storage.count} file${storage.count === 1 ? '' : 's'}`;
        if ($('#storageSize')) $('#storageSize').textContent = `${formatSize(storage.size)} / ${formatSize(storage.limit)}`;
      }
    } catch (err) {
      console.error('Failed to update stats:', err);
    }
  }

  // ─── SSE Real-Time Stream ──────────────────────────────────
  function connectSSE() {
    if (sseSource) sseSource.close();

    const protocol = window.location.protocol;
    const sseUrl = `${protocol}//${window.location.host}/api/events`;
    sseSource = new EventSource(sseUrl);

    sseSource.onopen = () => {
      setConnectionStatus(true);
    };

    sseSource.addEventListener('connected', () => {
      setConnectionStatus(true);
    });

    sseSource.addEventListener('new-item', (e) => {
      try {
        const item = JSON.parse(e.data);
        addItemToState(item);
        renderFeed();
        showToast('New item received from iPhone!', 'info');
        updateStats();
      } catch (err) {
        console.error(err);
      }
    });

    sseSource.addEventListener('clear', () => {
      allItems = [];
      renderFeed();
      updateStats();
      showToast('Dashboard feed cleared.', 'info');
    });

    sseSource.addEventListener('history-update', (e) => {
      try {
        allItems = JSON.parse(e.data) || [];
        renderFeed();
        updateStats();
      } catch (err) {
        console.error(err);
      }
    });

    sseSource.addEventListener('phone-queued', () => {
      showToast('Item queued for iPhone.', 'success');
      fetchPending();
    });

    sseSource.addEventListener('phone-ack', () => {
      showToast('iPhone picked up queued item.', 'success');
      fetchPending();
    });

    sseSource.onerror = () => {
      setConnectionStatus(false);
      sseSource.close();
      setTimeout(connectSSE, 3000);
    };
  }

  function setConnectionStatus(connected) {
    isConnected = connected;
    const dot = $('#connectionStatus .status-dot');
    const text = $('#connectionStatus .status-text');
    if (dot && text) {
      if (connected) {
        dot.className = 'status-dot connected';
        text.textContent = 'Connected';
      } else {
        dot.className = 'status-dot disconnected';
        text.textContent = 'Reconnecting...';
      }
    }
  }

  // ─── Received History ──────────────────────────────────────
  async function fetchHistory() {
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const data = await res.json();
        allItems = data.items || [];
        renderFeed();
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }

  function addItemToState(item) {
    const exists = allItems.some(i => i.id === item.id);
    if (!exists) {
      allItems.unshift(item);
      if (allItems.length > 100) allItems.pop();
    }
  }

  // ─── Render Feed ───────────────────────────────────────────
  function renderFeed() {
    const feedEl = $('#feed');
    const emptyStateEl = $('#emptyState');
    const feedCountEl = $('#feedCount');
    if (!feedEl) return;

    const filtered = allItems.filter(item => {
      if (currentFilter === 'all') return true;
      return item.type === currentFilter;
    });

    if (feedCountEl) feedCountEl.textContent = filtered.length;

    if (filtered.length === 0) {
      feedEl.innerHTML = '';
      if (emptyStateEl) emptyStateEl.style.display = 'block';
      return;
    }

    if (emptyStateEl) emptyStateEl.style.display = 'none';

    feedEl.innerHTML = filtered.map(item => {
      const timeStr = formatTime(item.timestamp);
      
      if (item.type === 'text') {
        return `
          <div class="feed-item type-text" id="item-${item.id}">
            <div class="item-header" style="width: 100%;">
              <span class="item-type-badge text">Text</span>
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="item-time">${timeStr}</span>
                <button class="delete-btn" data-id="${item.id}" title="Delete">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
            </div>
            <div class="item-body" style="width: 100%; margin: 8px 0;">
              <pre class="item-text-content">${escapeHtml(item.content)}</pre>
            </div>
            <div class="item-actions">
              <button class="btn btn-secondary btn-icon copy-btn" data-text="${escapeAttr(item.content)}" title="Copy to PC clipboard">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              </button>
            </div>
          </div>`;
      }
      
      if (item.type === 'image') {
        return `
          <div class="feed-item type-image" id="item-${item.id}">
            <div class="item-header">
              <span class="item-type-badge image">Image</span>
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="item-time">${timeStr}</span>
                <button class="delete-btn" data-id="${item.id}" title="Delete">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
            </div>
            <div class="item-image-preview lightbox-trigger" data-src="/received/${item.filename}">
              <img src="/received/${item.filename}" alt="Image transfer">
            </div>
            <div class="item-actions">
              <span class="item-meta">${formatSize(item.size || 0)}</span>
              <a href="/received/${item.filename}" download="${item.filename}" class="btn btn-secondary btn-icon" title="Save Image">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </a>
              <button class="btn btn-secondary btn-icon copy-fn-btn" data-fn="${escapeAttr(item.filename)}" title="Copy File Name">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              </button>
            </div>
          </div>`;
      }
      
      if (item.type === 'file') {
        const isAudio = item.mimeType && item.mimeType.startsWith('audio');
        const isPdf = item.mimeType && item.mimeType.includes('pdf');
        
        let fileIcon = `
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>`;
        
        if (isAudio) {
          fileIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>`;
        } else if (isPdf) {
          fileIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
            </svg>`;
        }

        return `
          <div class="feed-item type-file" id="item-${item.id}">
            <div class="item-header" style="width: 100%;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="item-type-badge file">File</span>
                <span class="item-time">${timeStr}</span>
              </div>
              <button class="delete-btn" data-id="${item.id}" title="Delete">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </button>
            </div>
            <div class="item-body" style="display:flex;align-items:center;gap:12px;margin: 10px 0; width:100%;">
              <div style="background:var(--accent-bg);color:var(--accent);padding:10px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                ${fileIcon}
              </div>
              <div style="min-width:0;flex:1;">
                <h4 style="font-size:0.9rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary);" title="${escapeAttr(item.originalName)}">
                  ${escapeHtml(item.originalName)}
                </h4>
                <p style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">
                  ${formatSize(item.size || 0)} &bull; ${item.mimeType || 'Unknown Type'}
                </p>
              </div>
            </div>
            <div class="item-actions">
              <a href="/received/${item.filename}" download="${escapeAttr(item.originalName)}" class="btn btn-secondary btn-icon" title="Download File">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </a>
              <button class="btn btn-secondary btn-icon copy-fn-btn" data-fn="${escapeAttr(item.filename)}" title="Copy File Name">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012 2h9a2 2 0 012 2v1"/></svg>
              </button>
            </div>
          </div>`;
      }
      return '';
    }).join('');

    // Bind dynamic copy events
    $$('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(btn.getAttribute('data-text'), btn);
      });
    });

    $$('.copy-fn-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(btn.getAttribute('data-fn'), btn);
      });
    });

    $$('.lightbox-trigger').forEach(trigger => {
      trigger.addEventListener('click', () => {
        openLightbox(trigger.getAttribute('data-src'));
      });
    });
  }

  // ─── Tab Controls ──────────────────────────────────────────
  function setupTabs() {
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        $$('.tab-content').forEach(c => c.classList.remove('active'));

        tab.classList.add('active');
        const contentId = `tab-${tab.getAttribute('data-tab')}`;
        const content = $(`#${contentId}`);
        if (content) content.classList.add('active');

        if (tab.getAttribute('data-tab') === 'send') {
          fetchPending();
        }
      });
    });
  }

  // ─── Filter group setup ────────────────────────────────────
  function setupFilters() {
    $$('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.getAttribute('data-filter');
        renderFeed();
      });
    });
  }

  // ─── Instant QR Code Generator ─────────────────────────────
  function setupInstantQrGenerator() {
    let qrTimeout = null;
    const qrInput = $('#qrTextInput');
    const qrContainer = $('#instantQrContainer');

    if (qrInput && qrContainer) {
      qrInput.addEventListener('input', () => {
        clearTimeout(qrTimeout);
        const text = qrInput.value.trim();
        if (!text) {
          qrContainer.innerHTML = '<div class="qr-placeholder">Start typing to generate QR code...</div>';
          return;
        }
        qrTimeout = setTimeout(() => {
          qrContainer.innerHTML = `<img src="/api/qr-gen.png?text=${encodeURIComponent(text)}" alt="Generated QR Code" width="200" height="200" style="border: 4px solid white; border-radius: var(--radius-md); box-shadow: var(--shadow-lg);">`;
        }, 300);
      });
    }
  }

  // ─── Event listeners binder ────────────────────────────────
  function setupEventListeners() {
    const clearBtn = $('#clearFeed');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete all transfer history and local files?')) return;
        try {
          const res = await fetch('/api/history', { method: 'DELETE' });
          const data = await res.json();
          if (res.ok && data.success) {
            allItems = [];
            renderFeed();
            updateStats();
            showToast('All items and files cleared.', 'success');
          } else {
            showToast(data.error || 'Failed to clear history', 'error');
          }
        } catch {
          showToast('Failed to connect to server', 'error');
        }
      });
    }

    // Export history
    const exportBtn = $('#exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/history/export');
          if (res.ok) {
            const blob = await res.blob();
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'airodrop_history.json';
            link.click();
            showToast('History exported successfully', 'success');
          } else {
            showToast('Failed to export history', 'error');
          }
        } catch {
          showToast('Failed to export history', 'error');
        }
      });
    }

    // Single item delete (using delegation)
    const feedEl = $('#feed');
    if (feedEl) {
      feedEl.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.delete-btn');
        if (!deleteBtn) return;
        
        const id = deleteBtn.getAttribute('data-id');
        const card = $(`#item-${id}`);
        
        if (card) {
          card.style.opacity = '0';
          card.style.transform = 'scale(0.95)';
          card.style.transition = 'all 0.35s ease';
        }
        
        try {
          const res = await fetch(`/api/history/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (res.ok && data.success) {
            setTimeout(() => {
              allItems = allItems.filter(item => item.id !== id);
              renderFeed();
              updateStats();
            }, 350);
          } else {
            if (card) {
              card.style.opacity = '1';
              card.style.transform = 'scale(1)';
            }
            showToast(data.error || 'Failed to delete item', 'error');
          }
        } catch {
          if (card) {
            card.style.opacity = '1';
            card.style.transform = 'scale(1)';
          }
          showToast('Network error', 'error');
        }
      });
    }

    // Copy server URL
    const serverUrlEl = $('#serverUrl');
    if (serverUrlEl) {
      serverUrlEl.addEventListener('click', () => {
        if (serverInfo && serverInfo.url) {
          copyToClipboard(serverInfo.url, serverUrlEl);
        }
      });
    }

    // Lightbox actions
    const lightboxOverlayEl = $('#lightboxOverlay');
    const lightboxCloseEl = $('#lightboxClose');
    const lightboxEl = $('#lightbox');
    if (lightboxOverlayEl) lightboxOverlayEl.addEventListener('click', closeLightbox);
    if (lightboxCloseEl) lightboxCloseEl.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightboxEl && lightboxEl.classList.contains('active')) {
        closeLightbox();
      }
    });

    // Send Text to Phone
    const sendTextBtn = $('#sendTextBtn');
    if (sendTextBtn) {
      sendTextBtn.addEventListener('click', sendTextToPhone);
    }
    const textInput = $('#sendTextInput');
    if (textInput) {
      textInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          sendTextToPhone();
        }
      });
    }

    // Send File/Image to Phone drag drop & selection
    const fileDrop = $('#fileDrop');
    const fileInput = $('#sendFileInput');
    const sendFileBtn = $('#sendFileBtn');

    if (fileDrop && fileInput) {
      fileDrop.addEventListener('click', () => fileInput.click());
      
      fileDrop.addEventListener('dragover', (e) => {
        e.preventDefault();
        fileDrop.classList.add('drag-over');
      });
      
      fileDrop.addEventListener('dragleave', () => {
        fileDrop.classList.remove('drag-over');
      });
      
      fileDrop.addEventListener('drop', (e) => {
        e.preventDefault();
        fileDrop.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) {
          handleFileSelection(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
          handleFileSelection(fileInput.files[0]);
        }
      });
    }

    if (sendFileBtn) {
      sendFileBtn.addEventListener('click', sendFileToPhone);
    }

    // Cancel pending queue (delegation)
    const pendingList = $('#pendingList');
    if (pendingList) {
      pendingList.addEventListener('click', async (e) => {
        const cancelBtn = e.target.closest('.cancel-pending-btn');
        if (!cancelBtn) return;
        const id = cancelBtn.getAttribute('data-id');
        try {
          const res = await fetch(`/api/pending/${id}`, { method: 'DELETE' });
          if (res.ok) {
            showToast('Pending item canceled', 'info');
            fetchPending();
          }
        } catch {
          showToast('Failed to cancel item', 'error');
        }
      });
    }
  }

  // ─── PC to Phone Sending Logic ─────────────────────────────
  async function sendTextToPhone() {
    const input = $('#sendTextInput');
    const text = input.value.trim();
    if (!text) return showToast('Enter some text first', 'error');

    try {
      const res = await fetch('/api/send-to-phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'text', text })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        input.value = '';
        showToast('Text queued for iPhone', 'success');
        fetchPending();
      } else {
        showToast(data.error || 'Failed to queue text', 'error');
      }
    } catch {
      showToast('Failed to send text', 'error');
    }
  }

  let selectedFileObj = null;

  function handleFileSelection(file) {
    selectedFileObj = file;
    const isImage = file.type.startsWith('image/');
    const preview = $('#sendFilePreview');
    const previewImg = $('#sendPreviewImg');
    const nameSpan = $('#sendFileName');
    const fileDrop = $('#fileDrop');
    const sendBtn = $('#sendFileBtn');

    if (isImage) {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (previewImg) {
          previewImg.src = e.target.result;
          previewImg.style.display = 'block';
        }
      };
      reader.readAsDataURL(file);
    } else {
      if (previewImg) previewImg.style.display = 'none';
    }

    if (nameSpan) nameSpan.textContent = `${file.name} (${formatSize(file.size)})`;
    if (preview) preview.style.display = 'flex';
    if (fileDrop) fileDrop.style.display = 'none';
    if (sendBtn) sendBtn.style.display = 'block';
  }

  async function sendFileToPhone() {
    if (!selectedFileObj) return;
    
    const sendBtn = $('#sendFileBtn');
    if (!sendBtn) return;
    
    sendBtn.disabled = true;
    sendBtn.textContent = 'Uploading...';

    const formData = new FormData();
    formData.append('file', selectedFileObj);

    try {
      const res = await fetch('/api/send-to-phone', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        showToast('File queued for iPhone', 'success');
        selectedFileObj = null;
        if ($('#sendFilePreview')) $('#sendFilePreview').style.display = 'none';
        if ($('#fileDrop')) $('#fileDrop').style.display = 'flex';
        if ($('#sendFileInput')) $('#sendFileInput').value = '';
        sendBtn.style.display = 'none';
        fetchPending();
      } else {
        showToast(data.error || 'Failed to upload file', 'error');
      }
    } catch {
      showToast('Failed to send file to phone', 'error');
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send File';
    }
  }

  async function fetchPending() {
    try {
      const res = await fetch('/api/pending');
      if (res.ok) {
        const data = await res.json();
        renderPending(data.items || []);
      }
    } catch (err) {
      console.error(err);
    }
  }

  function renderPending(items) {
    const list = $('#pendingList');
    if (!list) return;

    if (items.length === 0) {
      list.innerHTML = '<div class="empty-mini">No pending items</div>';
      return;
    }

    list.innerHTML = items.map(item => {
      const timeStr = formatTime(item.timestamp);
      let previewText = '';
      
      if (item.type === 'text') {
        previewText = item.content;
      } else if (item.type === 'image') {
        previewText = 'Image file';
      } else if (item.type === 'file') {
        previewText = item.originalName;
      }

      return `
        <div class="pending-item">
          <span class="pending-text" title="${escapeAttr(previewText)}">[${item.type.toUpperCase()}] ${escapeHtml(previewText)}</span>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="pending-time">${timeStr}</span>
            <button class="delete-btn cancel-pending-btn" data-id="${item.id}" title="Cancel transfer" style="width:24px;height:24px;">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>`;
    }).join('');
  }

  // ─── Settings Controller ────────────────────────────────────
  function setupSettings() {
    const saveDirInput = $('#saveDirInput');
    const saveDirBtn = $('#saveDirBtn');
    const settingsStatus = $('#settingsStatus');
    const tempModeInput = $('#tempModeInput');
    const deviceNameInput = $('#deviceNameInput');
    const portInput = $('#portInput');
    const notificationsInput = $('#notificationsInput');
    const rateLimitInput = $('#rateLimitInput');
    const tempModeHoursInput = $('#tempModeHoursInput');

    loadSettingsData();

    async function loadSettingsData() {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const data = await res.json();
          if (saveDirInput && data.saveDir) saveDirInput.value = data.saveDir;
          if (tempModeInput) tempModeInput.checked = !!data.temporaryMode;
          if (deviceNameInput && data.deviceName) deviceNameInput.value = data.deviceName;
          if (portInput && data.port) portInput.value = data.port;
          if (notificationsInput) notificationsInput.checked = !!data.notificationsEnabled;
          if (rateLimitInput) rateLimitInput.checked = !!data.rateLimitEnabled;
          if (tempModeHoursInput && data.temporaryModeHours) {
            tempModeHoursInput.value = data.temporaryModeHours;
          }
        }
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    }

    if (saveDirBtn) {
      saveDirBtn.addEventListener('click', async () => {
        const saveDir = saveDirInput.value.trim();
        const temporaryMode = tempModeInput ? tempModeInput.checked : false;
        const deviceName = deviceNameInput ? deviceNameInput.value.trim() : '';
        const port = portInput ? portInput.value : 3478;
        const notificationsEnabled = notificationsInput ? notificationsInput.checked : true;
        const rateLimitEnabled = rateLimitInput ? rateLimitInput.checked : true;
        const temporaryModeHours = tempModeHoursInput ? tempModeHoursInput.value : 2;

        saveDirBtn.disabled = true;
        saveDirBtn.textContent = 'Saving...';
        showSettingsStatus(false);

        try {
          const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              saveDir, 
              temporaryMode, 
              deviceName, 
              port, 
              notificationsEnabled, 
              rateLimitEnabled, 
              temporaryModeHours 
            })
          });
          const data = await res.json();
          
          if (res.ok && data.success) {
            showSettingsStatus('Configuration saved successfully!', 'success');
            if (saveDirInput) saveDirInput.value = data.saveDir;
            if (deviceNameInput) deviceNameInput.value = data.deviceName;
            if (tempModeInput) tempModeInput.checked = !!data.temporaryMode;
            if (portInput) portInput.value = data.port;
            if (notificationsInput) notificationsInput.checked = !!data.notificationsEnabled;
            if (rateLimitInput) rateLimitInput.checked = !!data.rateLimitEnabled;
            if (tempModeHoursInput) tempModeHoursInput.value = data.temporaryModeHours;
            
            fetchServerInfo();
            showToast('Settings saved', 'success');
          } else {
            throw new Error(data.error || 'Failed to update settings');
          }
        } catch (err) {
          showSettingsStatus(err.message, 'error');
        } finally {
          saveDirBtn.disabled = false;
          saveDirBtn.textContent = 'Save Configuration';
        }
      });
    }

    const browseDirBtn = $('#browseDirBtn');
    if (browseDirBtn && saveDirBtn) {
      browseDirBtn.addEventListener('click', async () => {
        browseDirBtn.disabled = true;
        showSettingsStatus('Please select a folder on your computer...', 'info');

        try {
          const res = await fetch('/api/settings/browse', { method: 'POST' });
          const data = await res.json();
          if (res.ok && data.success && data.path) {
            saveDirInput.value = data.path;
            showSettingsStatus(false);
            saveDirBtn.click();
          } else {
            showSettingsStatus(false);
          }
        } catch (err) {
          showSettingsStatus(err.message, 'error');
        } finally {
          browseDirBtn.disabled = false;
        }
      });
    }

    function showSettingsStatus(text, type) {
      if (!settingsStatus) return;
      if (!text) {
        settingsStatus.style.display = 'none';
        return;
      }
      settingsStatus.className = `settings-status ${type}`;
      settingsStatus.textContent = text;
      settingsStatus.style.display = 'block';
    }
  }

  // ─── Lightbox Utility ──────────────────────────────────────
  function openLightbox(src) {
    const lightboxEl = $('#lightbox');
    const lightboxImgEl = $('#lightboxImg');
    const lightboxDownloadEl = $('#lightboxDownload');
    if (!lightboxEl || !lightboxImgEl || !lightboxDownloadEl) return;
    lightboxImgEl.src = src;
    lightboxDownloadEl.href = src;
    lightboxEl.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    const lightboxEl = $('#lightbox');
    if (!lightboxEl) return;
    lightboxEl.classList.remove('active');
    document.body.style.overflow = '';
  }

  // ─── Clipboard Utilities ───────────────────────────────────
  function copyToClipboard(text, btnElement) {
    if (!text) return;
    
    function setCopiedState() {
      if (btnElement) {
        btnElement.classList.add('copied');
        const oldHtml = btnElement.innerHTML;
        btnElement.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>`;
        setTimeout(() => {
          btnElement.classList.remove('copied');
          btnElement.innerHTML = oldHtml;
        }, 1500);
      }
      showToast('Copied to clipboard!', 'success');
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(setCopiedState).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }

    function fallbackCopy(str) {
      try {
        const el = document.createElement('textarea');
        el.value = str;
        el.setAttribute('readonly', '');
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        setCopiedState();
      } catch {
        showToast('Failed to copy', 'error');
      }
    }
  }

  // ─── Toast Notifications ───────────────────────────────────
  function showToast(message, type = 'info') {
    const toastContainerEl = $('#toastContainer');
    if (!toastContainerEl) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let icon = '';
    if (type === 'success') {
      icon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
    } else if (type === 'error') {
      icon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    } else {
      icon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    toast.innerHTML = `${icon}<span>${message}</span>`;
    toastContainerEl.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('removing');
      toast.addEventListener('animationend', () => toast.remove());
    }, 2800);
  }

  // ─── Format Utilities ──────────────────────────────────────
  function formatTime(isoStr) {
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;

    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  document.addEventListener('DOMContentLoaded', init);
})();