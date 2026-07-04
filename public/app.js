/**
 * app.js — AiroDrop client-side controller
 * Premium Dark Theme default, settings updates (Port, Rate Limit, Notifications, Temp Hours), and instant QR generator.
 */

(function () {
  'use strict';

  // ─── Electron Detection & API Base ─────────────────────────
  const ipcRenderer = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;
  const isElectron = !!ipcRenderer;
  let apiBase = '';
  if (isElectron && ipcRenderer) {
    try {
      const port = ipcRenderer.sendSync('get-port-sync') || 3478;
      apiBase = `http://localhost:${port}`;
    } catch (e) {
      console.error('IPC get-port-sync failed:', e);
    }
  }

  function doFetch(url, options = {}) {
    const targetUrl = isElectron ? `${apiBase}${url}` : url;
    return fetch(targetUrl, options);
  }

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
    setupScratchpad();
    setupControlCommands();
    
    // Request permission for system notifications
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
    
    // Initializing new popup modals & multi-tools system
    setupShortcutsModal();
    setupSettingsModal();
    setupControlCenter();
    setupUniversalRefresh();
    // Server may still be starting – retry fetchServerInfo up to 5 times with 800ms delay
    let infoLoaded = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await doFetch('/api/info');
        if (res.ok) {
          serverInfo = await res.json();
          updateServerInfoUI(serverInfo);
          infoLoaded = true;
          break;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 800));
    }
    
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
          triggerThemeTransition(e, theme);
          themeDropdown.classList.remove('open');
        });
      });
    }
  }

  function triggerThemeTransition(event, themeName) {
    const rect = $('#themeBtn').getBoundingClientRect();
    const x = event ? event.clientX : (rect.left + rect.width / 2);
    const y = event ? event.clientY : (rect.top + rect.height / 2);
    
    const ripple = document.createElement('div');
    ripple.className = 'theme-transition-ripple';
    
    // Smooth expanding backdrop
    Object.assign(ripple.style, {
      position: 'fixed',
      left: `${x}px`,
      top: `${y}px`,
      width: '12px',
      height: '12px',
      borderRadius: '50%',
      background: 'var(--accent)',
      transform: 'translate(-50%, -50%) scale(0)',
      zIndex: '9999',
      pointerEvents: 'none',
      transition: 'transform 0.55s cubic-bezier(0.1, 0.8, 0.35, 1), opacity 0.55s ease',
      opacity: '0.8'
    });
    
    document.body.appendChild(ripple);
    
    // Force reflow
    ripple.offsetWidth;
    
    const maxRadius = Math.max(window.innerWidth, window.innerHeight) * 2.5;
    ripple.style.transform = `translate(-50%, -50%) scale(${maxRadius / 6})`;
    
    setTimeout(() => {
      setTheme(themeName);
    }, 220);
    
    setTimeout(() => {
      ripple.style.opacity = '0';
      ripple.addEventListener('transitionend', () => {
        ripple.remove();
      });
    }, 450);
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
      const res = await doFetch('/api/info');
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
    if ($('#mobilePortalUrl')) {
      $('#mobilePortalUrl').textContent = `${baseUrl}/m`;
      $('#mobilePortalUrl').href = `${baseUrl}/m`;
    }
    if ($('#unifiedEndpoint')) $('#unifiedEndpoint').textContent = `${baseUrl}/api/send`;
    if ($('#infoDeviceName')) $('#infoDeviceName').textContent = info.deviceName || 'PC Server';

    // Setup QR code for mobile (resized to fit the 110x110 box perfectly)
    const qrContainer = $('#mobileQrContainer');
    if (qrContainer) {
      qrContainer.innerHTML = `<img src="${isElectron ? apiBase : ''}/api/qr.png?t=${Date.now()}" alt="Setup QR Code" width="110" height="110" style="display: block;">`;
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
      const statsRes = await doFetch('/api/stats');
      if (statsRes.ok) {
        const stats = await statsRes.json();
        if ($('#statTransfers')) $('#statTransfers').textContent = stats.transfers;
        if ($('#statData')) $('#statData').textContent = formatSize(stats.bytes);
        updateUptimeUI(stats.uptime);
        if ($('#statFiles')) $('#statFiles').textContent = stats.files;
      }

      const storageRes = await doFetch('/api/storage');
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

    sseSource = new EventSource(isElectron ? `${apiBase}/api/events` : '/api/events');

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

        // Browser HTML5 notification for system-wide alerts
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const title = 'com.asep-ios-integration.airodrop';
          const eventLabel = item.type === 'text' ? 'Clipboard' : 'File';
          const bodyContent = `${eventLabel}: ` + (item.type === 'text' 
            ? (item.content.length > 50 ? item.content.substring(0, 50) + '...' : item.content)
            : item.filename);
          const notification = new Notification(title, {
            body: bodyContent,
            icon: 'logo.png'
          });
          notification.onclick = () => {
            if (isElectron && ipcRenderer) {
              ipcRenderer.send('restore-window');
            } else {
              window.focus();
            }
          };
        }
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

    sseSource.addEventListener('scratchpad', (e) => {
      try {
        const data = JSON.parse(e.data);
        const scratchpadTextarea = $('#dashboardScratchpad');
        const status = $('#scratchpadStatus');
        if (scratchpadTextarea && document.activeElement !== scratchpadTextarea) {
          scratchpadTextarea.value = data.text;
        }
        if (status) {
          status.textContent = 'Synced';
          status.style.color = 'var(--success)';
        }
      } catch (err) {
        console.error(err);
      }
    });

    sseSource.addEventListener('trackpad_status', (e) => {
      try {
        const data = JSON.parse(e.data);
        const badge = $('#connectedDeviceBadge');
        if (badge) {
          if (data.connected && data.deviceName) {
            badge.textContent = `${data.deviceName} connected`;
            badge.style.display = 'inline-block';
          } else {
            badge.style.display = 'none';
          }
        }
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
      const res = await doFetch('/api/history');
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
      item.isNew = true;
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
      const isNewClass = item.isNew ? ' is-new' : '';
      if (item.isNew) {
        setTimeout(() => {
          const el = document.getElementById(`item-${item.id}`);
          if (el) el.classList.remove('is-new');
          item.isNew = false;
        }, 1000);
      }
      
      if (item.type === 'text') {
        return `
          <div class="feed-item type-text${isNewClass}" id="item-${item.id}">
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
          <div class="feed-item type-image${isNewClass}" id="item-${item.id}">
            <div class="item-header">
              <span class="item-type-badge image">Image</span>
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="item-time">${timeStr}</span>
                <button class="delete-btn" data-id="${item.id}" title="Delete">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
            </div>
            <div class="item-image-preview lightbox-trigger" data-src="${isElectron ? apiBase : ''}/received/${item.filename}">
              <img src="${isElectron ? apiBase : ''}/received/${item.filename}" alt="Image transfer">
            </div>
            <div class="item-actions">
              <span class="item-meta">${formatSize(item.size || 0)}</span>
              <a href="${isElectron ? apiBase : ''}/received/${item.filename}" download="${item.filename}" class="btn btn-secondary btn-icon" title="Save Image">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </a>
              <button class="btn btn-secondary btn-icon copy-fn-btn" data-fn="${escapeAttr(item.filename)}" title="Copy File Name">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              </button>
              ${isElectron ? `
              <button class="btn btn-secondary btn-icon open-folder-btn" data-fn="${escapeAttr(item.filename)}" title="Open Folder">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
              </button>
              ` : ''}
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
          <div class="feed-item type-file${isNewClass}" id="item-${item.id}">
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
              <a href="${isElectron ? apiBase : ''}/received/${item.filename}" download="${escapeAttr(item.originalName)}" class="btn btn-secondary btn-icon" title="Download File">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </a>
              <button class="btn btn-secondary btn-icon copy-fn-btn" data-fn="${escapeAttr(item.filename)}" title="Copy File Name">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012 2h9a2 2 0 012 2v1"/></svg>
              </button>
              ${isElectron ? `
              <button class="btn btn-secondary btn-icon open-folder-btn" data-fn="${escapeAttr(item.filename)}" title="Open Folder">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
              </button>
              ` : ''}
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

    $$('.open-folder-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fn = btn.getAttribute('data-fn');
        if (isElectron && ipcRenderer && fn) {
          ipcRenderer.send('open-file-folder', fn);
        }
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

  // ─── Instant QR Code Generator ──────────────────────────────
  function setupInstantQrGenerator() {
    let qrTimeout = null;
    const qrInput = $('#qrTextInput');
    const qrContainer = $('#instantQrContainer');

    if (!qrInput || !qrContainer) return;

    function renderQR(text) {
      if (!text) {
        qrContainer.innerHTML = '<div class="qr-placeholder" style="color:#666;font-size:0.76rem;">Start typing to generate QR code...</div>';
        return;
      }
      const encodedText = encodeURIComponent(text);
      const imgSrc = `${isElectron ? apiBase : ''}/api/qr-gen.png?text=${encodedText}`;

      qrContainer.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
          <img
            src="${imgSrc}"
            alt="QR Code"
            width="180" height="180"
            style="border:4px solid white;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.4);display:block;"
            onerror="this.parentElement.innerHTML='<div style=&quot;color:#ef4444;font-size:0.76rem;padding:12px;text-align:center;&quot;>Failed to generate QR code. Server may be starting.</div>'"
          >
          <div style="display:flex;gap:8px;">
            <a
              href="${imgSrc}"
              download="airodrop-qr.png"
              style="font-size:0.75rem;padding:6px 12px;background:rgba(99,102,241,0.15);color:var(--accent-light);border:1px solid rgba(99,102,241,0.25);border-radius:8px;text-decoration:none;font-weight:600;"
            >&#x2193; Download</a>
            <button
              onclick="navigator.clipboard.writeText('${text.replace(/'/g, "&quot;\\' &quot;")}') .then(()=>window._qrCopyToast&&window._qrCopyToast())"
              style="font-size:0.75rem;padding:6px 12px;background:rgba(255,255,255,0.06);color:var(--text-secondary);border:1px solid var(--glass-border);border-radius:8px;cursor:pointer;font-family:inherit;"
            >Copy Text</button>
          </div>
        </div>`;

      // Simple toast hook for copy button
      window._qrCopyToast = () => showToast('Text copied!', 'success');
    }

    qrInput.addEventListener('input', () => {
      clearTimeout(qrTimeout);
      const text = qrInput.value.trim();
      if (!text) {
        renderQR('');
        return;
      }
      // Show loading state immediately
      qrContainer.innerHTML = '<div style="color:#666;font-size:0.76rem;padding:12px;">Generating...</div>';
      qrTimeout = setTimeout(() => renderQR(text), 350);
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



  // ─── Event listeners binder ────────────────────────────────
  function setupEventListeners() {
    const clearBtn = $('#clearFeed');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete all transfer history and local files?')) return;
        try {
          const res = await doFetch('/api/history', { method: 'DELETE' });
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
          const res = await doFetch('/api/history/export');
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
          const res = await doFetch(`/api/history/${id}`, { method: 'DELETE' });
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
          const res = await doFetch(`/api/pending/${id}`, { method: 'DELETE' });
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
      const res = await doFetch('/api/send-to-phone', {
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

  function getFileTypeEmoji(mimeType) {
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

  function handleFileSelection(file) {
    selectedFileObj = file;
    const isImage = file.type.startsWith('image/');
    const preview = $('#sendFilePreview');
    const previewImg = $('#sendPreviewImg');
    const previewIcon = $('#sendFilePreviewIcon');
    const nameSpan = $('#sendFileName');
    const fileDrop = $('#fileDrop');
    const sendBtn = $('#sendFileBtn');

    if (isImage) {
      if (previewIcon) previewIcon.style.display = 'none';
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
      if (previewIcon) {
        previewIcon.textContent = getFileTypeEmoji(file.type);
        previewIcon.style.display = 'block';
      }
    }

    if (nameSpan) nameSpan.textContent = `${file.name} (${formatSize(file.size)})`;
    if (preview) preview.style.display = 'flex';
    if (fileDrop) fileDrop.style.display = 'none';
    if (sendBtn) sendBtn.disabled = false;
  }

  async function sendFileToPhone() {
    if (!selectedFileObj) return;
    
    const sendBtn = $('#sendFileBtn');
    if (!sendBtn) return;
    
    sendBtn.disabled = true;
    sendBtn.textContent = 'Uploading...';

    const formData = new FormData();
    formData.append('file', selectedFileObj);

    let success = false;
    try {
      const res = await doFetch('/api/send-to-phone', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        showToast('File queued for iPhone', 'success');
        selectedFileObj = null;
        if ($('#sendFilePreview')) $('#sendFilePreview').style.display = 'none';
        if ($('#sendFilePreviewIcon')) $('#sendFilePreviewIcon').style.display = 'none';
        if ($('#fileDrop')) $('#fileDrop').style.display = 'flex';
        if ($('#sendFileInput')) $('#sendFileInput').value = '';
        success = true;
        fetchPending();
      } else {
        showToast(data.error || 'Failed to upload file', 'error');
      }
    } catch {
      showToast('Failed to send file to phone', 'error');
    } finally {
      sendBtn.disabled = success;
      sendBtn.textContent = 'Send File';
    }
  }

  async function fetchPending() {
    try {
      const res = await doFetch('/api/pending');
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
    const autoOpenLinksInput = $('#autoOpenLinksInput');

    loadSettingsData();

    async function loadSettingsData() {
      try {
        const res = await doFetch('/api/settings');
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
          if (autoOpenLinksInput) autoOpenLinksInput.checked = !!data.autoOpenLinks;
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
        const autoOpenLinks = autoOpenLinksInput ? autoOpenLinksInput.checked : false;

        saveDirBtn.disabled = true;
        saveDirBtn.textContent = 'Saving...';
        showSettingsStatus(false);

        try {
          const res = await doFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              saveDir, 
              temporaryMode, 
              deviceName, 
              port, 
              notificationsEnabled, 
              rateLimitEnabled, 
              temporaryModeHours,
              autoOpenLinks 
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
            if (autoOpenLinksInput) autoOpenLinksInput.checked = !!data.autoOpenLinks;
            
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
          const res = await doFetch('/api/settings/browse', { method: 'POST' });
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

  // ─── iOS Shortcuts Modal Setup ─────────────────────────────
  function setupShortcutsModal() {
    const btnHeaderSetup = $('#btnHeaderSetup');
    const shortcutsModal = $('#shortcutsModal');
    const closeModal = $('#closeModal');
    const imgShareToPC = $('#imgShareToPC');
    const imgClipboardToPC = $('#imgClipboardToPC');

    if (btnHeaderSetup && shortcutsModal) {
      btnHeaderSetup.addEventListener('click', () => {
        if (imgShareToPC) {
          imgShareToPC.src = `${isElectron ? apiBase : ''}/api/qr-gen.png?text=${encodeURIComponent('https://www.icloud.com/shortcuts/efd4af984d884e0eb8e8ba3ba319ce4d')}`;
        }
        if (imgClipboardToPC) {
          imgClipboardToPC.src = `${isElectron ? apiBase : ''}/api/qr-gen.png?text=${encodeURIComponent('https://www.icloud.com/shortcuts/1f341cd7a57041958a87ce92f8acaa8b')}`;
        }
        if (serverInfo) {
          const infoIPSetup = $('#infoIPSetup');
          if (infoIPSetup) infoIPSetup.textContent = serverInfo.ip;
          $$('.infoIPSetupText').forEach(el => el.textContent = serverInfo.ip);

          // WebDAV mount setup
          const webdavUrl = `http://${serverInfo.ip}:${serverInfo.port}/webdav`;
          const imgWebdavQR = $('#imgWebdavQR');
          const webdavUrlText = $('#webdavUrlText');
          if (imgWebdavQR) {
            imgWebdavQR.src = `${isElectron ? apiBase : ''}/api/qr-gen.png?text=${encodeURIComponent(webdavUrl)}`;
          }
          if (webdavUrlText) {
            webdavUrlText.textContent = webdavUrl;
            webdavUrlText.title = webdavUrl;
          }
        }
        shortcutsModal.style.display = 'flex';
      });
    }

    if (closeModal && shortcutsModal) {
      closeModal.addEventListener('click', () => {
        shortcutsModal.style.display = 'none';
      });
    }

    window.addEventListener('click', (e) => {
      if (e.target === shortcutsModal) {
        shortcutsModal.style.display = 'none';
      }
    });
  }

  // ─── Settings Modal Setup ──────────────────────────────────
  function setupSettingsModal() {
    const btnHeaderSettings = $('#btnHeaderSettings');
    const settingsModal = $('#settingsModal');
    const btnCloseSettings = $('#btnCloseSettings');

    if (btnHeaderSettings && settingsModal) {
      btnHeaderSettings.addEventListener('click', () => {
        btnHeaderSettings.classList.add('glow');
        settingsModal.style.display = 'flex';
      });
    }

    if (btnCloseSettings && settingsModal) {
      btnCloseSettings.addEventListener('click', () => {
        settingsModal.style.display = 'none';
        if (btnHeaderSettings) btnHeaderSettings.classList.remove('glow');
      });
    }

    window.addEventListener('click', (e) => {
      if (e.target === settingsModal) {
        settingsModal.style.display = 'none';
        if (btnHeaderSettings) btnHeaderSettings.classList.remove('glow');
      }
    });
  }

  // ─── Universal Refresh Button ──────────────────────────────
  function setupUniversalRefresh() {
    const btnUniversalRefresh = $('#btnUniversalRefresh');
    if (btnUniversalRefresh) {
      btnUniversalRefresh.addEventListener('click', async () => {
        btnUniversalRefresh.style.transform = 'rotate(360deg)';
        btnUniversalRefresh.style.transition = 'transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
        setTimeout(() => {
          btnUniversalRefresh.style.transform = 'none';
          btnUniversalRefresh.style.transition = 'none';
        }, 600);

        await fetchHistory();
        await updateStats();
        showToast('All data refreshed', 'success');
      });
    }
  }





  // ─── Control Center Controller ──────────────────────────────
  function setupControlCenter() {
    if (!isElectron || !ipcRenderer) return;

    const ccActionsGroup = $('#ccActionsGroup');
    const ccIndicator = $('#ccIndicator');
    const ccText = $('#ccText');
    const ccIPPort = $('#ccIPPort');
    const ccDirPath = $('#ccDirPath');
    const btnCcChangeDir = $('#btnCcChangeDir');
    const btnCcStart = $('#btnCcStart');
    const btnCcStop = $('#btnCcStop');
    const btnCcKillAll = $('#btnCcKillAll');

    // Show control center on home page inside Electron
    if (ccActionsGroup) ccActionsGroup.style.display = 'flex';

    // IPC Status Listeners
    ipcRenderer.on('server-status', (event, status) => {
      updateControlCenterStatus(status);
      
      // Also update desktop settings modal UI elements if open
      const destStatusIndicator = $('#desktopStatusIndicator');
      const destStatusText = $('#desktopStatusText');
      const destBtnStart = $('#btnDesktopStart');
      const destBtnStop = $('#btnDesktopStop');
      
      if (status.running) {
        if (destStatusIndicator) destStatusIndicator.style.backgroundColor = '#00d26a';
        if (destStatusText) destStatusText.textContent = 'Server Running';
        if (destBtnStart) destBtnStart.disabled = true;
        if (destBtnStop) destBtnStop.disabled = false;
      } else {
        if (destStatusIndicator) destStatusIndicator.style.backgroundColor = '#ff3b30';
        if (destStatusText) destStatusText.textContent = status.error ? `Error: ${status.error}` : 'Server Stopped';
        if (destBtnStart) destBtnStart.disabled = false;
        if (destBtnStop) destBtnStop.disabled = true;
      }
    });

    ipcRenderer.on('dir-updated', (event, dir) => {
      if (ccDirPath) {
        ccDirPath.textContent = dir;
        ccDirPath.title = dir;
      }
      // Also update settings form saveDirInput
      const saveDirInput = $('#saveDirInput');
      if (saveDirInput) {
        saveDirInput.value = dir;
      }
    });

    // Request directory path (status is pushed by main process on did-finish-load)
    ipcRenderer.send('get-dir');

    // Change Directory button
    if (btnCcChangeDir) {
      btnCcChangeDir.addEventListener('click', () => {
        ipcRenderer.send('change-dir');
      });
    }

    // Start Server button
    if (btnCcStart) {
      btnCcStart.addEventListener('click', () => {
        btnCcStart.disabled = true;
        btnCcStart.style.opacity = '0.35';
        if (ccText) ccText.textContent = 'Starting...';
        ipcRenderer.send('start-server');
      });
    }

    // Stop Server button
    if (btnCcStop) {
      btnCcStop.addEventListener('click', () => {
        btnCcStop.disabled = true;
        btnCcStop.style.opacity = '0.35';
        if (ccText) ccText.textContent = 'Stopping...';
        ipcRenderer.send('stop-server');
      });
    }

    // Kill all processes button
    if (btnCcKillAll) {
      btnCcKillAll.addEventListener('click', () => {
        if (confirm("Are you sure you want to force close AiroDrop and all background processes?")) {
          ipcRenderer.send('force-kill-all');
        }
      });
    }

    function updateControlCenterStatus(status) {
      if (status.running) {
        if (ccIndicator) ccIndicator.style.backgroundColor = '#00d26a';
        if (ccText) {
          ccText.textContent = 'Service Running';
          ccText.style.color = '#00d26a';
        }
        if (ccIPPort) {
          ccIPPort.textContent = `${status.ip}:${status.port}`;
        }
        if (btnCcStart) {
          btnCcStart.disabled = true;
          btnCcStart.style.opacity = '0.35';
          btnCcStart.style.pointerEvents = 'none';
        }
        if (btnCcStop) {
          btnCcStop.disabled = false;
          btnCcStop.style.opacity = '1';
          btnCcStop.style.pointerEvents = 'auto';
        }
        setConnectionStatus(true);
      } else {
        if (ccIndicator) ccIndicator.style.backgroundColor = '#ff3b30';
        if (ccText) {
          ccText.textContent = status.error ? 'Service Error' : 'Service Stopped';
          ccText.style.color = '#ff3b30';
        }
        if (ccIPPort) {
          ccIPPort.textContent = status.error ? 'Error' : 'Stopped';
        }
        if (btnCcStart) {
          btnCcStart.disabled = false;
          btnCcStart.style.opacity = '1';
          btnCcStart.style.pointerEvents = 'auto';
        }
        if (btnCcStop) {
          btnCcStop.disabled = true;
          btnCcStop.style.opacity = '0.35';
          btnCcStop.style.pointerEvents = 'none';
        }
        setConnectionStatus(false);
      }
    }
  }

  // ─── Shared Scratchpad ──────────────────────────────────────
  function setupScratchpad() {
    const scratchpad = $('#dashboardScratchpad');
    const status = $('#scratchpadStatus');
    if (!scratchpad) return;

    // Load initial scratchpad text
    doFetch('/api/scratchpad')
      .then(res => res.json())
      .then(data => {
        scratchpad.value = data.text || '';
      })
      .catch(err => console.error('Failed to load scratchpad:', err));

    let debounceTimer = null;
    scratchpad.addEventListener('input', () => {
      if (status) {
        status.textContent = 'Saving...';
        status.style.color = 'var(--text-secondary)';
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          const res = await doFetch('/api/scratchpad', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: scratchpad.value })
          });
          if (res.ok) {
            if (status) {
              status.textContent = 'Synced';
              status.style.color = 'var(--success)';
            }
          } else {
            if (status) {
              status.textContent = 'Error';
              status.style.color = 'var(--danger)';
            }
          }
        } catch {
          if (status) {
            status.textContent = 'Offline';
            status.style.color = 'var(--danger)';
          }
        }
      }, 500);
    });
  }

  // ─── PC Control Commands ────────────────────────────────────
  function setupControlCommands() {
    $$('.btn-control-cmd').forEach(btn => {
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
            showToast(`Triggered: ${action}`, 'success');
          } else {
            showToast('Failed to trigger command', 'error');
          }
        } catch {
          showToast('Offline', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();