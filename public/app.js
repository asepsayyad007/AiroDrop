/**
 * app.js — AiroDrop client-side controller
 * Premium Dark Theme default, settings updates (Port, Rate Limit, Notifications, Temp Hours), and instant QR generator.
 */

(function () {
  'use strict';

  // ─── Electron Detection & API Base ─────────────────────────
  const ipcRenderer = typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null;
  const isElectron = !!ipcRenderer;
  let apiBase = '';
  if (isElectron && ipcRenderer) {
    try {
      const port = ipcRenderer.sendSync('get-port-sync') || 3478;
      const protocol = ipcRenderer.sendSync('get-protocol-sync') || 'http';
      apiBase = `${protocol}://localhost:${port}`;
    } catch (e) {
      console.error('IPC get-port-sync/get-protocol-sync failed:', e);
      apiBase = `http://localhost:3478`;
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
    const runSetup = (name, fn) => {
      try {
        fn();
      } catch (err) {
        console.error(`Error in setup function [${name}]:`, err);
      }
    };

    runSetup('ThemeSystem', setupThemeSystem);
    runSetup('Tabs', setupTabs);
    runSetup('Filters', setupFilters);
    runSetup('EventListeners', setupEventListeners);
    runSetup('Settings', setupSettings);
    runSetup('InstantQrGenerator', setupInstantQrGenerator);
    runSetup('Scratchpad', setupScratchpad);
    runSetup('ControlCommands', setupControlCommands);
    runSetup('ShareToFriend', setupShareToFriend);
    
    // Request permission for system notifications
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      try {
        Notification.requestPermission();
      } catch (_) {}
    }
    
    runSetup('ShortcutsModal', setupShortcutsModal);
    runSetup('SettingsModal', setupSettingsModal);
    runSetup('LogsModal', setupLogsModal);
    runSetup('ServiceDropdown', setupServiceDropdown);
    runSetup('ControlCenter', setupControlCenter);
    runSetup('UniversalRefresh', setupUniversalRefresh);
    runSetup('PCWebRTCScreencast', setupPCWebRTCScreencast);

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
    const savedTheme = localStorage.getItem('airodrop_theme') || 'dark';
    setTheme(savedTheme);

    const themeSelectInput = $('#themeSelectInput');
    if (themeSelectInput) {
      themeSelectInput.value = savedTheme;
      themeSelectInput.addEventListener('change', (e) => {
        const theme = e.target.value;
        triggerThemeTransition(e, theme);
      });
    }
  }

  function triggerThemeTransition(event, themeName) {
    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;

    const targetEl = event && event.target ? event.target : $('#themeSelectInput');
    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      x = event && event.clientX ? event.clientX : (rect.left + rect.width / 2);
      y = event && event.clientY ? event.clientY : (rect.top + rect.height / 2);
    }
    
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

  function getThemedQrUrl(text) {
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    let darkParam = 'ffffff';
    let lightParam = '0a0a10';
    
    if (theme === 'light' || theme === 'liquid-glass') {
      darkParam = '0a0a10';
      lightParam = 'ffffff';
    }
    
    return `${isElectron ? apiBase : ''}/api/qr-gen.png?text=${encodeURIComponent(text)}&dark=${darkParam}&light=${lightParam}`;
  }

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
        osc.frequency.setValueAtTime(660, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(110, audioCtx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
      }
    } catch (err) {
      console.warn('AudioContext error:', err);
    }
  }

  document.addEventListener('click', () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }, { once: true });

  function refreshAllQrs() {
    // 1. Mobile setup portal QR
    const qrContainer = $('#mobileQrContainer');
    const homepageQr = $('#homepageQrContainer');
    if (serverInfo) {
      const baseUrl = serverInfo.url;
      const urlWithToken = `${baseUrl}/m`;
      if (qrContainer) {
        qrContainer.innerHTML = `<img src="${getThemedQrUrl(urlWithToken)}" alt="Setup QR Code" width="110" height="110" style="display: block;">`;
      }
      if (homepageQr) {
        homepageQr.innerHTML = `<img src="${getThemedQrUrl(urlWithToken)}" alt="Quick Connect QR Code" width="80" height="80" style="display: block; border-radius: 4px;">`;
      }
    }

    // 2. Instant QR generator
    const qrInput = $('#qrTextInput');
    if (qrInput && qrInput.value.trim()) {
      const renderQR = window._renderQR;
      if (renderQR) renderQR(qrInput.value.trim());
    }

    // 3. Shortcuts modal QRs
    const imgShareToPC = $('#imgShareToPC');
    const imgClipboardToPC = $('#imgClipboardToPC');
    const imgGetPCClipboard = $('#imgGetPCClipboard');

    if (imgShareToPC && imgShareToPC.src) {
      imgShareToPC.src = getThemedQrUrl('https://www.icloud.com/shortcuts/efd4af984d884e0eb8e8ba3ba319ce4d');
    }
    if (imgClipboardToPC && imgClipboardToPC.src) {
      imgClipboardToPC.src = getThemedQrUrl('https://www.icloud.com/shortcuts/1f341cd7a57041958a87ce92f8acaa8b');
    }
    if (imgGetPCClipboard && imgGetPCClipboard.src) {
      imgGetPCClipboard.src = getThemedQrUrl('https://www.icloud.com/shortcuts/c35825d9722d48158b88e192ee0ced2d');
    }
    // Update File Browser and SMB URL displays
    const fileBrowserUrlEl = document.getElementById('fileBrowserUrlText');
    if (fileBrowserUrlEl && serverInfo) {
      fileBrowserUrlEl.textContent = `http://${serverInfo.ip}:${serverInfo.port}/files`;
    }
    const smbUrlEl = document.getElementById('smbUrlText');
    if (smbUrlEl && serverInfo) {
      smbUrlEl.textContent = `smb://${serverInfo.ip}`;
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
      'aurora': 'Aurora Green',
      'cyberpunk': 'Cyberpunk'
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

    const themeSelectInput = $('#themeSelectInput');
    if (themeSelectInput) {
      themeSelectInput.value = themeName;
    }

    // Refresh all generated QR codes to align with the new theme colors
    refreshAllQrs();
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
    if ($('#serverUrlText')) $('#serverUrlText').textContent = baseUrl.replace(/^https?:\/\//, '');

    // Setup cards info
    if ($('#infoIP2')) $('#infoIP2').textContent = info.ip;
    if ($('#mobilePortalUrl')) {
      $('#mobilePortalUrl').textContent = `${baseUrl}/m`;
      $('#mobilePortalUrl').href = `${baseUrl}/m`;
    }
    if ($('#unifiedEndpoint')) $('#unifiedEndpoint').textContent = `${baseUrl}/api/send`;
    if ($('#infoDeviceName')) $('#infoDeviceName').textContent = info.deviceName || 'PC Server';
    if ($('#ccIPPort')) $('#ccIPPort').textContent = info.ip;
    const ccPortalLink = $('#ccPortalLink');
    if (ccPortalLink) {
      ccPortalLink.href = `${baseUrl}/m`;
      ccPortalLink.textContent = `${baseUrl}/m`;
    }

    // Setup QR code for mobile
    const qrContainer = $('#mobileQrContainer');
    const homepageQr = $('#homepageQrContainer');
    const urlWithToken = `${baseUrl}/m`;
    
    if (qrContainer) {
      qrContainer.innerHTML = `<img src="${getThemedQrUrl(urlWithToken)}" alt="Setup QR Code" width="110" height="110" style="display: block;">`;
    }
    if (homepageQr) {
      homepageQr.innerHTML = `<img src="${getThemedQrUrl(urlWithToken)}" alt="Quick Connect QR Code" width="80" height="80" style="display: block; border-radius: 4px;">`;
    }

    // Update temporary mode badge on dashboard
    updateTemporaryModeBadge(info.temporaryMode);
  }

  function updateTemporaryModeBadge(temporaryMode) {
    const dashboardTempModeInput = $('#dashboardTempModeInput');
    if (dashboardTempModeInput) {
      dashboardTempModeInput.checked = !!temporaryMode;
    }
    const tempModeInput = $('#tempModeInput');
    if (tempModeInput) {
      tempModeInput.checked = !!temporaryMode;
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
    if ($('#serviceUptimeText')) $('#serviceUptimeText').textContent = uptimeStr;
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
        showToast(`New ${item.type === 'text' ? 'text' : 'file'} received!`, 'success');
        updateStats();

        // Browser HTML5 notification for system-wide alerts
        if (!isElectron && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
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



    sseSource.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data);
        const logsTerminal = $('#logsTerminal');
        if (logsTerminal) {
          const isAtBottom = logsTerminal.scrollHeight - logsTerminal.clientHeight <= logsTerminal.scrollTop + 25;
          logsTerminal.textContent += `[${data.timestamp}] ${data.message}\n`;
          if (isAtBottom) {
            logsTerminal.scrollTop = logsTerminal.scrollHeight;
          }
        }
      } catch (err) {
        console.error(err);
      }
    });

    sseSource.addEventListener('logs-init', (e) => {
      try {
        const logs = JSON.parse(e.data);
        const logsTerminal = $('#logsTerminal');
        if (logsTerminal) {
          logsTerminal.textContent = logs.join('\n') + (logs.length ? '\n' : '');
          logsTerminal.scrollTop = logsTerminal.scrollHeight;
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



    sseSource.addEventListener('ping-pc', (e) => {
      try {
        const data = JSON.parse(e.data);
        playPingSound();
        showToast(`Ping from ${data.name || 'Mobile Device'} (${data.ip || 'unknown IP'})`, 'info');
      } catch (err) {
        console.error('Error handling ping-pc event:', err);
      }
    });

    sseSource.onerror = () => {
      setConnectionStatus(false);
      sseSource.close();
      setTimeout(connectSSE, 1000);
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
      if (currentFilter === 'file') {
        return item.type === 'file' || item.type === 'video' || item.type === 'audio';
      }
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
        const isUrl = /^https?:\/\//i.test((item.content || '').trim());
        const urlHref = isUrl ? escapeAttr(item.content.trim()) : '';
        return `
          <div class="feed-item type-text${isNewClass}${isUrl ? ' type-url' : ''}" id="item-${item.id}">
            <div class="item-header" style="width: 100%;">
              <span class="item-type-badge ${isUrl ? 'url' : 'text'}">${isUrl ? '🔗 Link' : 'Text'}</span>
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="item-time">${timeStr}</span>
                <button class="delete-btn" data-id="${item.id}" title="Delete">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
            </div>
            <div class="item-body" style="width: 100%; margin: 8px 0;">
              ${isUrl
                ? `<a href="${urlHref}" target="_blank" class="item-url-preview" style="color:var(--accent);word-break:break-all;font-size:0.85rem;text-decoration:none;" title="${urlHref}">${escapeHtml(item.content.trim())}</a>`
                : `<pre class="item-text-content">${escapeHtml(item.content)}</pre>`
              }
            </div>
            <div class="item-actions">
              <button class="btn btn-secondary btn-icon copy-btn" data-text="${escapeAttr(item.content)}" title="Copy to PC clipboard">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              </button>
              ${isUrl ? `
              <button class="btn btn-primary open-url-btn" data-url="${urlHref}" title="Open in Browser" style="display:flex;align-items:center;gap:6px;padding:6px 14px;font-size:0.75rem;border-radius:8px;">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;flex-shrink:0;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                Open in Browser
              </button>` : ''}
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
      
      if (item.type === 'file' || item.type === 'video' || item.type === 'audio') {
        const isAudio = item.type === 'audio' || (item.mimeType && item.mimeType.startsWith('audio'));
        const isVideo = item.type === 'video' || (item.mimeType && item.mimeType.startsWith('video'));
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
        } else if (isVideo) {
          fileIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M23 7l-7 5 7 5V7z"/>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
            </svg>`;
        } else if (isPdf) {
          fileIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
            </svg>`;
        }

        let badgeLabel = 'File';
        if (isVideo) badgeLabel = 'Video';
        else if (isAudio) badgeLabel = 'Audio';

        return `
          <div class="feed-item type-file${isNewClass}" id="item-${item.id}">
            <div class="item-header" style="width: 100%;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="item-type-badge file">${badgeLabel}</span>
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

    $$('.open-url-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const url = btn.getAttribute('data-url');
        if (!url) return;
        try {
          // Try server-side open (Electron / Windows start command)
          const r = await doFetch('/api/open-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
          });
          if (r.ok) {
            showToast('Opening URL in browser…', 'success');
          } else {
            // Fallback: open in same tab via window.open
            window.open(url, '_blank', 'noopener');
          }
        } catch {
          window.open(url, '_blank', 'noopener');
        }
      });
    });
  }



  // ─── PWA Config ─────────────────────────────────────────────
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
        } else if (tab.getAttribute('data-tab') === 'share') {
          initRelayWebSocket();
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
        qrContainer.innerHTML = '<div class="qr-placeholder" style="color:var(--text-muted);font-size:0.76rem;">Start typing to generate QR code...</div>';
        return;
      }
      const imgSrc = getThemedQrUrl(text);

      qrContainer.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
          <img
            src="${imgSrc}"
            alt="QR Code"
            width="180" height="180"
            style="border:1px solid var(--glass-border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.4);display:block;"
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

    window._renderQR = renderQR;

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
        if (!confirm('Clear queue? (Files will not be deleted)')) return;
        try {
          const res = await doFetch('/api/history?files=false', { method: 'DELETE' });
          const data = await res.json();
          if (res.ok && data.success) {
            allItems = [];
            renderFeed();
            updateStats();
            showToast('Dashboard queues cleared.', 'success');
          } else {
            showToast(data.error || 'Failed to clear history', 'error');
          }
        } catch {
          showToast('Failed to connect to server', 'error');
        }
      });
    }

    const deleteAllBtn = $('#deleteAllFiles');
    if (deleteAllBtn) {
      deleteAllBtn.addEventListener('click', async () => {
        if (!confirm('Permanently delete all received files?')) return;
        try {
          const res = await doFetch('/api/history?files=true', { method: 'DELETE' });
          const data = await res.json();
          if (res.ok && data.success) {
            allItems = [];
            renderFeed();
            updateStats();
            showToast('All received files and history deleted.', 'success');
          } else {
            showToast(data.error || 'Failed to delete files', 'error');
          }
        } catch {
          showToast('Failed to connect to server', 'error');
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
      } else {
        previewText = item.originalName || 'File';
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
    const shareDirInput = $('#shareDirInput');
    const saveDirBtn = $('#saveDirBtn');
    const settingsStatus = $('#settingsStatus');
    const tempModeInput = $('#tempModeInput');
    const deviceNameInput = $('#deviceNameInput');
    const portInput = $('#portInput');
    const privacyPauseInput = $('#privacyPauseInput');
    if (privacyPauseInput) {
      privacyPauseInput.addEventListener('change', async (e) => {
        try {
          await doFetch('/api/screencast/pause', {
            method: 'POST',
            body: JSON.stringify({ pause: e.target.checked })
          });
        } catch (err) {
          console.error('Failed to set privacy pause', err);
        }
      });
    }

    const dashboardTempModeInput = $('#dashboardTempModeInput');
    if (dashboardTempModeInput) {
      dashboardTempModeInput.addEventListener('change', async (e) => {
        const checked = e.target.checked;
        try {
          const res = await doFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ temporaryMode: checked })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast(`Temporary Mode turned ${checked ? 'On' : 'Off'}`, 'info');
            const tempModeInput = $('#tempModeInput');
            if (tempModeInput) tempModeInput.checked = checked;
            updateTemporaryModeBadge(checked);
          }
        } catch (err) {
          showToast('Failed to toggle Temporary Mode', 'error');
          e.target.checked = !checked; // revert
        }
      });
    }

    const notificationsInput = $('#notificationsInput');
    const rateLimitInput = $('#rateLimitInput');
    const tempModeHoursInput = $('#tempModeHoursInput');
    const autoOpenLinksInput = $('#autoOpenLinksInput');
    const desktopAutoStartInput = $('#desktopAutoStart');
    const autoUpdaterInput = $('#autoUpdaterInput');
    const httpsEnabledInput = $('#httpsEnabledInput');
    const contextMenuInput = $('#contextMenuInput');
    const contextMenuSettingRow = $('#contextMenuSettingRow');

    loadSettingsData();

    async function loadSettingsData() {
      try {
        const res = await doFetch('/api/settings');
        if (res.ok) {
          const data = await res.json();
          if (saveDirInput && data.saveDir) saveDirInput.value = data.saveDir;
          const receiveSaveDirLabel = document.getElementById('receiveSaveDirLabel');
          if (receiveSaveDirLabel && data.saveDir) receiveSaveDirLabel.textContent = data.saveDir;
          if (shareDirInput && data.shareDir) shareDirInput.value = data.shareDir;
          if (tempModeInput) tempModeInput.checked = !!data.temporaryMode;
          if (dashboardTempModeInput) dashboardTempModeInput.checked = !!data.temporaryMode;
          if (deviceNameInput && data.deviceName) deviceNameInput.value = data.deviceName;
          if (portInput && data.port) portInput.value = data.port;
          if (notificationsInput) notificationsInput.checked = !!data.notificationsEnabled;
          if (rateLimitInput) rateLimitInput.checked = !!data.rateLimitEnabled;
          if (tempModeHoursInput && data.temporaryModeHours) {
            tempModeHoursInput.value = data.temporaryModeHours;
          }
          if (autoOpenLinksInput) autoOpenLinksInput.checked = !!data.autoOpenLinks;
          if (desktopAutoStartInput) desktopAutoStartInput.checked = !!data.launchOnStartup;
          if (autoUpdaterInput) autoUpdaterInput.checked = !!data.autoUpdate;
          if (httpsEnabledInput) httpsEnabledInput.checked = !!data.httpsEnabled;
          if (contextMenuInput) contextMenuInput.checked = !!data.contextMenuEnabled;
           if (isElectron && data.platform === 'win32' && contextMenuSettingRow) {
            contextMenuSettingRow.style.display = 'flex';
          }
          if (data.version) {
            const versionEl = document.getElementById('appVersionTag');
            if (versionEl) versionEl.textContent = `v${data.version}`;
          }
          updateTemporaryModeBadge(data.temporaryMode);

        }
      } catch (err) {
        console.error('Failed to load settings:', err);
      }

      // Toggle card views based on isElectron
      const electronSettingsCard = $('#electronSettingsCard');
      const webSettingsCard = $('#webSettingsCard');
      const desktopAppPreferencesCard = $('#desktopAppPreferencesCard');
      if (isElectron) {
        if (electronSettingsCard) electronSettingsCard.style.display = 'flex';
        if (desktopAppPreferencesCard) desktopAppPreferencesCard.style.display = 'block';
        if (webSettingsCard) webSettingsCard.style.display = 'none';
      } else {
        if (electronSettingsCard) electronSettingsCard.style.display = 'none';
        if (desktopAppPreferencesCard) desktopAppPreferencesCard.style.display = 'none';
        if (webSettingsCard) webSettingsCard.style.display = 'flex';
        setupWebUpdater();
      }
    }

    function setupWebUpdater() {
      const btnWebCheckUpdates = $('#btnWebCheckUpdates');
      const webUpdateStatusMessage = $('#webUpdateStatusMessage');

      if (btnWebCheckUpdates) {
        btnWebCheckUpdates.addEventListener('click', async () => {
          btnWebCheckUpdates.disabled = true;
          btnWebCheckUpdates.textContent = '🔄 Checking...';
          
          if (webUpdateStatusMessage) {
            webUpdateStatusMessage.style.display = 'none';
          }

          try {
            const res = await doFetch('/api/check-update');
            if (res.ok) {
              const data = await res.json();
              if (webUpdateStatusMessage) {
                webUpdateStatusMessage.style.display = 'block';
                if (data.updateAvailable) {
                  webUpdateStatusMessage.style.backgroundColor = 'rgba(255,149,0,0.15)';
                  webUpdateStatusMessage.style.borderColor = 'rgba(255,149,0,0.3)';
                  webUpdateStatusMessage.style.color = '#ff9500';
                  webUpdateStatusMessage.innerHTML = `Update available: <strong>v${data.latest}</strong><br><a href="${data.url}" target="_blank" style="color: #6366f1; text-decoration: underline; display: inline-block; margin-top: 4px;">Click here to view on GitHub</a>`;
                  showToast(`Update v${data.latest} is available!`, 'info');
                } else {
                  webUpdateStatusMessage.style.backgroundColor = 'rgba(0,210,106,0.15)';
                  webUpdateStatusMessage.style.borderColor = 'rgba(0,210,106,0.3)';
                  webUpdateStatusMessage.style.color = '#00d26a';
                  webUpdateStatusMessage.textContent = 'You are already running the latest version of AiroDrop.';
                  showToast('You are up to date!', 'success');
                }
              }
            } else {
              throw new Error('Server returned ' + res.status);
            }
          } catch (err) {
            console.error('Web updater failed:', err);
            if (webUpdateStatusMessage) {
              webUpdateStatusMessage.style.display = 'block';
              webUpdateStatusMessage.style.backgroundColor = 'rgba(255,59,48,0.15)';
              webUpdateStatusMessage.style.borderColor = 'rgba(255,59,48,0.3)';
              webUpdateStatusMessage.style.color = '#ff3b30';
              webUpdateStatusMessage.textContent = `Check failed: ${err.message}`;
            }
            showToast('Update check failed', 'error');
          } finally {
            btnWebCheckUpdates.disabled = false;
            btnWebCheckUpdates.textContent = '🔄 Check for Updates';
          }
        });
      }
    }

    if (saveDirBtn) {
      saveDirBtn.addEventListener('click', async () => {
        const saveDir = saveDirInput.value.trim();
        const shareDir = shareDirInput ? shareDirInput.value.trim() : '';
        const temporaryMode = tempModeInput ? tempModeInput.checked : false;
        const deviceName = deviceNameInput ? deviceNameInput.value.trim() : '';
        const port = portInput ? portInput.value : 3478;
        const notificationsEnabled = notificationsInput ? notificationsInput.checked : true;
        const rateLimitEnabled = rateLimitInput ? rateLimitInput.checked : true;
        const temporaryModeHours = tempModeHoursInput ? tempModeHoursInput.value : 2;
        const autoOpenLinks = autoOpenLinksInput ? autoOpenLinksInput.checked : false;
        const launchOnStartup = desktopAutoStartInput ? desktopAutoStartInput.checked : false;
        const autoUpdate = autoUpdaterInput ? autoUpdaterInput.checked : true;
        const httpsEnabled = httpsEnabledInput ? httpsEnabledInput.checked : false;
        const contextMenuEnabled = contextMenuInput ? contextMenuInput.checked : false;

        saveDirBtn.disabled = true;
        saveDirBtn.textContent = 'Saving...';
        showSettingsStatus(false);

        try {
          const res = await doFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              saveDir, 
              shareDir,
              temporaryMode, 
              deviceName, 
              port, 
              notificationsEnabled, 
              rateLimitEnabled, 
              temporaryModeHours,
              autoOpenLinks,
              launchOnStartup,
              autoUpdate,
              httpsEnabled,
              contextMenuEnabled
            })
          });
          const data = await res.json();
          
          if (res.ok && data.success) {
            showSettingsStatus('Configuration saved successfully!', 'success');
            if (saveDirInput) saveDirInput.value = data.saveDir;
            const receiveSaveDirLabel2 = document.getElementById('receiveSaveDirLabel');
            if (receiveSaveDirLabel2 && data.saveDir) receiveSaveDirLabel2.textContent = data.saveDir;
            if (shareDirInput) shareDirInput.value = data.shareDir;
            if (deviceNameInput) deviceNameInput.value = data.deviceName;
            if (tempModeInput) tempModeInput.checked = !!data.temporaryMode;
            const dashboardTempModeInput = $('#dashboardTempModeInput');
            if (dashboardTempModeInput) dashboardTempModeInput.checked = !!data.temporaryMode;
            if (portInput) portInput.value = data.port;
            if (notificationsInput) notificationsInput.checked = !!data.notificationsEnabled;
            if (rateLimitInput) rateLimitInput.checked = !!data.rateLimitEnabled;
            if (tempModeHoursInput) tempModeHoursInput.value = data.temporaryModeHours;
            if (autoOpenLinksInput) autoOpenLinksInput.checked = !!data.autoOpenLinks;
            if (desktopAutoStartInput) desktopAutoStartInput.checked = !!data.launchOnStartup;
            if (autoUpdaterInput) autoUpdaterInput.checked = !!data.autoUpdate;
            if (httpsEnabledInput) httpsEnabledInput.checked = !!data.httpsEnabled;
            if (contextMenuInput) contextMenuInput.checked = !!data.contextMenuEnabled;
            updateTemporaryModeBadge(data.temporaryMode);
            
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

    const browseShareDirBtn = $('#browseShareDirBtn');
    if (browseShareDirBtn && saveDirBtn) {
      browseShareDirBtn.addEventListener('click', async () => {
        browseShareDirBtn.disabled = true;
        showSettingsStatus('Please select a folder on your computer...', 'info');

        try {
          const res = await doFetch('/api/settings/browse', { method: 'POST' });
          const data = await res.json();
          if (res.ok && data.success && data.path) {
            shareDirInput.value = data.path;
            showSettingsStatus(false);
            saveDirBtn.click();
          } else {
            showSettingsStatus(false);
          }
        } catch (err) {
          showSettingsStatus(err.message, 'error');
        } finally {
          browseShareDirBtn.disabled = false;
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
    const imgGetPCClipboard = $('#imgGetPCClipboard');
    const tabBtns = $$('.setup-tab-btn');
    const tabContents = $$('.setup-tab-content');

    if (btnHeaderSetup && shortcutsModal) {
      btnHeaderSetup.addEventListener('click', () => {
        if (imgShareToPC) {
          imgShareToPC.src = getThemedQrUrl('https://www.icloud.com/shortcuts/efd4af984d884e0eb8e8ba3ba319ce4d');
        }
        if (imgClipboardToPC) {
          imgClipboardToPC.src = getThemedQrUrl('https://www.icloud.com/shortcuts/1f341cd7a57041958a87ce92f8acaa8b');
        }
        if (imgGetPCClipboard) {
          imgGetPCClipboard.src = getThemedQrUrl('https://www.icloud.com/shortcuts/c35825d9722d48158b88e192ee0ced2d');
        }
        if (serverInfo) {
          const infoIPSetup = $('#infoIPSetup');
          if (infoIPSetup) infoIPSetup.textContent = serverInfo.ip;
          $$('.infoIPSetupText').forEach(el => el.textContent = serverInfo.ip);
          $$('.infoPortSetupText').forEach(el => el.textContent = parseInt(serverInfo.port, 10) + 1);

          // File Browser URL setup
          const fileBrowserUrlEl = document.getElementById('fileBrowserUrlText');
          if (fileBrowserUrlEl) {
            const fileBrowserUrl = `http://${serverInfo.ip}:${serverInfo.port}/files`;
            fileBrowserUrlEl.textContent = fileBrowserUrl;
            fileBrowserUrlEl.title = fileBrowserUrl;
          }

          // SMB URL setup
          const smbUrlEl = document.getElementById('smbUrlText');
          if (smbUrlEl) {
            const smbUrl = `smb://${serverInfo.ip}`;
            smbUrlEl.textContent = smbUrl;
            smbUrlEl.title = smbUrl;
          }
        }
        
        // Reset tabs to default (Manage Devices) on modal open
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.style.display = 'none');
        const defaultBtn = $('.setup-tab-btn[data-target="setup-devices"]');
        if (defaultBtn) defaultBtn.classList.add('active');
        const defaultContent = $('#setup-devices');
        if (defaultContent) defaultContent.style.display = 'flex';


        shortcutsModal.style.display = 'flex';
      });
    }

    // Modal tabs logic
    tabBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.style.display = 'none');
        
        btn.classList.add('active');
        const targetId = btn.getAttribute('data-target');
        const targetContent = $(`#${targetId}`);
        if (targetContent) {
          targetContent.style.display = 'flex';
        }
      });
    });

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

  // ─── System Activity Logs ─────────────────────────────────────
  function setupLogsModal() {
    const btnHeaderLogs = $('#btnHeaderLogs');
    const logsModal = $('#logsModal');
    const btnCloseLogs = $('#btnCloseLogs');
    const btnClearLogs = $('#btnClearLogs');
    const logsTerminal = $('#logsTerminal');

    if (btnHeaderLogs && logsModal) {
      btnHeaderLogs.addEventListener('click', () => {
        logsModal.style.display = 'flex';
        if (logsTerminal) logsTerminal.scrollTop = logsTerminal.scrollHeight;
      });
    }

    if (btnCloseLogs && logsModal) {
      btnCloseLogs.addEventListener('click', () => {
        logsModal.style.display = 'none';
      });
    }

    if (btnClearLogs && logsTerminal) {
      btnClearLogs.addEventListener('click', () => {
        logsTerminal.textContent = '[system] Terminal logs cleared.\n';
      });
    }

    window.addEventListener('click', (e) => {
      if (e.target === logsModal) {
        logsModal.style.display = 'none';
      }
    });
  }

  // ─── Service Status Dropdown ──────────────────────────────────
  function setupServiceDropdown() {
    const btn = $('#serviceStatusDropdownBtn');
    const dropdown = $('#serviceStatusDropdown');
    const container = dropdown ? dropdown.parentElement : null;

    if (btn && dropdown) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropdown.classList.toggle('open');
      });

      // Use mousedown instead of click to close the dropdown immediately
      // This prevents click-through issues where clicks on dropdown coordinates hit underlying items
      document.addEventListener('mousedown', (e) => {
        if (container && !container.contains(e.target)) {
          dropdown.classList.remove('open');
        }
      });
    }
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
    const btnCcRestart = $('#btnCcRestart');
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

    // Restart Server button
    if (btnCcRestart) {
      btnCcRestart.addEventListener('click', () => {
        btnCcRestart.disabled = true;
        btnCcRestart.style.opacity = '0.35';
        if (btnCcStart) {
          btnCcStart.disabled = true;
          btnCcStart.style.opacity = '0.35';
        }
        if (btnCcStop) {
          btnCcStop.disabled = true;
          btnCcStop.style.opacity = '0.35';
        }
        if (ccText) ccText.textContent = 'Restarting...';
        ipcRenderer.send('restart-server');
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

    // ─── Auto-Updater Controls ───
    const btnCheckUpdates = $('#btnCheckUpdates');
    const checkUpdatesManualBtn = $('#checkUpdatesManualBtn');
    const updateStatusText = $('#updateStatusText');
    const updateProgressContainer = $('#updateProgressContainer');
    const updateProgressLabel = $('#updateProgressLabel');
    const updateProgressPercent = $('#updateProgressPercent');
    const updateProgressBarFill = $('#updateProgressBarFill');
    const appVersionText = $('#appVersionText');

    const triggerManualCheck = async () => {
      if (checkUpdatesManualBtn) {
        checkUpdatesManualBtn.disabled = true;
        checkUpdatesManualBtn.textContent = 'Checking...';
      }
      if (btnCheckUpdates) {
        btnCheckUpdates.disabled = true;
        btnCheckUpdates.textContent = '🔄 Checking...';
      }
      if (updateStatusText) updateStatusText.textContent = 'Connecting to server...';

      if (isElectron && ipcRenderer) {
        ipcRenderer.send('manual-check-update');
      } else {
        try {
          const res = await doFetch('/api/check-update');
          const data = await res.json();
          if (data.updateAvailable) {
            if (updateStatusText) {
              updateStatusText.innerHTML = `Update available: <a href="${data.url}" target="_blank" style="color: var(--accent); font-weight: 700; text-decoration: underline;">v${data.latest}</a>`;
            }
            showToast(`New update v${data.latest} is available!`, 'info');
          } else {
            if (updateStatusText) updateStatusText.textContent = `Up to date (v${data.current})`;
            showToast('You are running the latest version.', 'success');
          }
        } catch (err) {
          console.error('Update check failed:', err);
          if (updateStatusText) updateStatusText.textContent = 'Check failed';
          showToast('Failed to check for updates.', 'error');
        } finally {
          if (checkUpdatesManualBtn) {
            checkUpdatesManualBtn.disabled = false;
            checkUpdatesManualBtn.textContent = 'Check for Updates Now';
          }
          if (btnCheckUpdates) {
            btnCheckUpdates.disabled = false;
            btnCheckUpdates.textContent = '🔄 Check for Updates';
          }
        }
      }
    };

    if (btnCheckUpdates) {
      btnCheckUpdates.addEventListener('click', triggerManualCheck);
    }
    if (checkUpdatesManualBtn) {
      checkUpdatesManualBtn.addEventListener('click', triggerManualCheck);
    }

    if (isElectron && ipcRenderer) {
      ipcRenderer.on('update-status', (event, status, info) => {
        const updateBtnText = status === 'checking' ? '🔄 Checking...' : 
                             status === 'available' ? '📥 Update Available' : '🔄 Check for Updates';
        const manualBtnText = status === 'checking' ? 'Checking...' :
                             status === 'available' ? 'Downloading...' : 'Check for Updates Now';
        const isBtnDisabled = status === 'checking' || status === 'available';

        if (btnCheckUpdates) {
          btnCheckUpdates.disabled = isBtnDisabled;
          btnCheckUpdates.textContent = updateBtnText;
        }
        if (checkUpdatesManualBtn) {
          checkUpdatesManualBtn.disabled = isBtnDisabled;
          checkUpdatesManualBtn.textContent = manualBtnText;
        }

        switch (status) {
          case 'checking':
            if (updateStatusText) updateStatusText.textContent = 'Checking for updates...';
            break;
          case 'available':
            showToast(`Update v${info.version} available! Downloading...`, 'info');
            if (updateProgressContainer) updateProgressContainer.style.display = 'flex';
            if (updateStatusText) updateStatusText.textContent = `New update v${info.version} downloading...`;
            break;
          case 'not-available':
            showToast('You are already running the latest version!', 'success');
            if (updateProgressContainer) updateProgressContainer.style.display = 'none';
            if (updateStatusText) updateStatusText.textContent = 'Up to date';
            break;
          case 'error':
            showToast('Update check failed. Try again later.', 'error');
            if (updateProgressContainer) updateProgressContainer.style.display = 'none';
            if (updateStatusText) updateStatusText.textContent = 'Check failed';
            break;
          case 'downloaded':
            showToast('Update downloaded successfully! Restart to apply.', 'success');
            if (updateProgressContainer) updateProgressContainer.style.display = 'none';
            if (updateStatusText) updateStatusText.textContent = 'Update downloaded. Restart to apply.';
            break;
        }
      });

      ipcRenderer.on('update-download-progress', (event, progressObj) => {
        if (updateProgressPercent) updateProgressPercent.textContent = `${Math.round(progressObj.percent)}%`;
        if (updateProgressBarFill) updateProgressBarFill.style.width = `${progressObj.percent}%`;
        if (updateProgressLabel) {
          const speed = (progressObj.bytesPerSecond / 1024 / 1024).toFixed(1);
          updateProgressLabel.textContent = `Downloading (${speed} MB/s)`;
        }
      });
    }


    function updateControlCenterStatus(status) {
      const servicePulseRing = $('#servicePulseRing');
      const serviceStatusIcon = $('#serviceStatusIcon');
      const serviceStatusTitle = $('#serviceStatusTitle');
      const serviceStatusSubtitle = $('#serviceStatusSubtitle');

      if (status.running) {
        if (ccIndicator) ccIndicator.style.backgroundColor = '#00d26a';
        if (ccText) {
          ccText.textContent = 'Service: Active';
          ccText.style.color = '#00d26a';
        }
        if (ccIPPort) {
          ccIPPort.textContent = `(${status.ip}:${status.port})`;
        }
        if (btnCcStart) {
          btnCcStart.disabled = true;
          btnCcStart.style.opacity = '0.35';
          btnCcStart.style.pointerEvents = 'none';
        }
        if (btnCcRestart) {
          btnCcRestart.disabled = false;
          btnCcRestart.style.opacity = '1';
          btnCcRestart.style.pointerEvents = 'auto';
        }
        if (btnCcStop) {
          btnCcStop.disabled = false;
          btnCcStop.style.opacity = '1';
          btnCcStop.style.pointerEvents = 'auto';
        }

        if (servicePulseRing) servicePulseRing.style.display = 'block';
        if (serviceStatusIcon) {
          serviceStatusIcon.style.background = 'linear-gradient(135deg, #00d26a, #008a47)';
          serviceStatusIcon.style.boxShadow = '0 0 10px rgba(0,210,106,0.35)';
          serviceStatusIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" style="width: 8px; height: 8px;"><polyline points="20 6 9 17 4 12"/></svg>`;
        }
        if (serviceStatusTitle) serviceStatusTitle.textContent = 'AiroDrop Service Active';
        if (serviceStatusSubtitle) serviceStatusSubtitle.textContent = 'Synchronization engine running smoothly.';

        setConnectionStatus(true);
      } else {
        if (ccIndicator) ccIndicator.style.backgroundColor = '#ff3b30';
        if (ccText) {
          ccText.textContent = 'Service: Inactive';
          ccText.style.color = '#ff3b30';
        }
        if (ccIPPort) {
          ccIPPort.textContent = '';
        }
        if (btnCcStart) {
          btnCcStart.disabled = false;
          btnCcStart.style.opacity = '1';
          btnCcStart.style.pointerEvents = 'auto';
        }
        if (btnCcRestart) {
          btnCcRestart.disabled = true;
          btnCcRestart.style.opacity = '0.35';
          btnCcRestart.style.pointerEvents = 'none';
        }
        if (btnCcStop) {
          btnCcStop.disabled = true;
          btnCcStop.style.opacity = '0.35';
          btnCcStop.style.pointerEvents = 'none';
        }

        if (servicePulseRing) servicePulseRing.style.display = 'none';
        if (serviceStatusIcon) {
          serviceStatusIcon.style.background = 'linear-gradient(135deg, #ff3b30, #c0241b)';
          serviceStatusIcon.style.boxShadow = '0 0 10px rgba(255,59,48,0.35)';
          serviceStatusIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" style="width: 8px; height: 8px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        }
        if (serviceStatusTitle) serviceStatusTitle.textContent = 'AiroDrop Service Inactive';
        if (serviceStatusSubtitle) serviceStatusSubtitle.textContent = 'Synchronization engine is stopped.';

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

  // ─── PC WebRTC Screencast Setup ─────────────────────────────
  function setupPCWebRTCScreencast() {
    if (!isElectron || !ipcRenderer) return;

    let pc = null;
    let localStream = null;

    ipcRenderer.on('screencast-start', async () => {
      console.log('[WebRTC] Screencast start request received. Capturing desktop...');
      try {
        // 1. Get desktop source ID from main process
        const sourceId = await ipcRenderer.invoke('get-screen-source');
        if (!sourceId) {
          console.error('[WebRTC] No desktop source ID found.');
          return;
        }

        // 2. Capture desktop media stream
        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId
              }
            },
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId,
                minWidth: 1280,
                maxWidth: 1920,
                minHeight: 720,
                maxHeight: 1080,
                minFrameRate: 30,
                maxFrameRate: 60
              }
            }
          });
        } catch (audioErr) {
          console.warn('[WebRTC] Failed to capture audio, falling back to video-only capture:', audioErr);
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId,
                minWidth: 1280,
                maxWidth: 1920,
                minHeight: 720,
                maxHeight: 1080,
                minFrameRate: 30,
                maxFrameRate: 60
              }
            }
          });
        }

        // 3. Create peer connection
        pc = new RTCPeerConnection({
          iceServers: []
        });

        // Add tracks
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

        // ICE candidate exchange
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            ipcRenderer.send('send-webrtc-candidate', event.candidate);
          }
        };

        // Create and send SDP Offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ipcRenderer.send('send-webrtc-offer', offer);
        console.log('[WebRTC] SDP Offer sent successfully.');

      } catch (err) {
        console.error('[WebRTC] Failed to initialize local screen capture:', err);
      }
    });

    ipcRenderer.on('webrtc-answer', async (event, answer) => {
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          console.log('[WebRTC] Remote description (Answer) set successfully.');
        } catch (err) {
          console.error('[WebRTC] Failed to set remote description (Answer):', err);
        }
      }
    });

    ipcRenderer.on('webrtc-ice-candidate', async (event, candidate) => {
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('[WebRTC] Failed to add ICE candidate:', err);
        }
      }
    });

    ipcRenderer.on('screencast-stop', () => {
      console.log('[WebRTC] Stopping local screen capture and peer connection...');
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
      }
      if (pc) {
        pc.close();
        pc = null;
      }
    });

    // ─── WebRTC Microphone Streaming Receiver ──────────────────────
    let micPC = null;
    const mobileMicActiveBadge = $('#mobileMicActiveBadge');

    ipcRenderer.on('mic-offer', async (event, offer) => {
      console.log('[MicWebRTC] Received offer from mobile phone.');
      if (micPC) {
        try { micPC.close(); } catch (e) {}
      }

      micPC = new RTCPeerConnection({
        iceServers: []
      });

      micPC.onicecandidate = (e) => {
        if (e.candidate) {
          ipcRenderer.send('send-mic-candidate', e.candidate);
        }
      };

      micPC.ontrack = (e) => {
        console.log('[MicWebRTC] Track received:', e.streams);
        if (e.streams && e.streams[0]) {
          let audioEl = document.getElementById('pcMicStreamAudio');
          if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = 'pcMicStreamAudio';
            audioEl.autoplay = true;
            audioEl.style.display = 'none';
            document.body.appendChild(audioEl);
          }
          audioEl.srcObject = e.streams[0];
          audioEl.play().catch(err => {
            console.warn('[MicWebRTC] Playback blocked by browser autoplay policy.', err);
            showToast('Mic streaming active. Click the app to enable audio.', 'info');
          });
          if (mobileMicActiveBadge) mobileMicActiveBadge.style.display = 'inline-flex';
          showToast('Mobile Microphone Connected!', 'success');
        }
      };

      try {
        await micPC.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await micPC.createAnswer();
        await micPC.setLocalDescription(answer);
        ipcRenderer.send('send-mic-answer', answer);
      } catch (err) {
        console.error('[MicWebRTC] Failed to handle mobile mic offer:', err);
      }
    });

    ipcRenderer.on('mic-ice-candidate', async (event, candidate) => {
      if (micPC && candidate) {
        try {
          await micPC.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('[MicWebRTC] Failed to add ICE candidate:', err);
        }
      }
    });

    ipcRenderer.on('mic-stop', () => {
      console.log('[MicWebRTC] Received mic stop event.');
      stopPCMicStream();
    });

    function stopPCMicStream() {
      if (micPC) {
        try { micPC.close(); } catch(e) {}
        micPC = null;
      }
      const audioEl = document.getElementById('pcMicStreamAudio');
      if (audioEl) {
        audioEl.srcObject = null;
        try { audioEl.remove(); } catch(e) {}
      }
      if (mobileMicActiveBadge) mobileMicActiveBadge.style.display = 'none';
      showToast('Mobile Microphone Disconnected.', 'info');
    }
  }

  // ─── Send to Friend (P2P Share Module) ────────────────────
  // Relay server base URL — update this if you self-host the relay server
  const RELAY_BASE_URL = 'https://airodrop.bootstrapx007.online';
  const RELAY_WS_URL  = 'wss://airodrop.bootstrapx007.online/ws';
  let selectedShareFile = null;
  const activeShares = new Map();
  let relayWs = null;
  let relayReconnectTimeout = null;
  let relayReconnectDelay = 1000;
  let isConnectingRelay = false;
  let heartbeatInterval = null;

  window.switchShareMode = (mode) => {
    const sendBtn = $('#modeSendBtn');
    const receiveBtn = $('#modeReceiveBtn');
    const sendContainer = $('#sendModeContainer');
    const receiveContainer = $('#receiveModeContainer');
    
    if (mode === 'send') {
      if (sendBtn) {
        sendBtn.classList.add('active');
        sendBtn.style.color = 'var(--text-primary)';
      }
      if (receiveBtn) {
        receiveBtn.classList.remove('active');
        receiveBtn.style.color = 'var(--text-secondary)';
      }
      if (sendContainer) sendContainer.style.display = 'block';
      if (receiveContainer) receiveContainer.style.display = 'none';
    } else {
      if (receiveBtn) {
        receiveBtn.classList.add('active');
        receiveBtn.style.color = 'var(--text-primary)';
      }
      if (sendBtn) {
        sendBtn.classList.remove('active');
        sendBtn.style.color = 'var(--text-secondary)';
      }
      if (sendContainer) sendContainer.style.display = 'none';
      if (receiveContainer) receiveContainer.style.display = 'block';
    }
  };


  let sessionKey = sessionStorage.getItem('airodrop_share_session');
  if (!sessionKey) {
    sessionKey = 'pc_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('airodrop_share_session', sessionKey);
  }

  function initRelayWebSocket() {
    if (relayWs && (relayWs.readyState === WebSocket.OPEN || relayWs.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (isConnectingRelay) return;
    isConnectingRelay = true;

    updateRelayStatus('connecting');

    try {
      relayWs = new WebSocket(RELAY_WS_URL);
    } catch (err) {
      console.error('[RelayWS] Connection error:', err);
      scheduleRelayReconnect();
      return;
    }

    relayWs.onopen = () => {
      isConnectingRelay = false;
      relayReconnectDelay = 1000;
      updateRelayStatus('connected');
      console.log('[RelayWS] Connected to cloud relay server.');

      // Authenticate connection with session key
      sendRelayMessage({
        type: 'auth',
        sessionKey: sessionKey
      });

      // Start ping heartbeat
      startRelayHeartbeat();
    };

    relayWs.onmessage = async (event) => {
      // Handle incoming binary chunks for active receive links
      if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
        let buffer = event.data;
        if (event.data instanceof Blob) {
          buffer = await event.data.arrayBuffer();
        }
        
        try {
          const view = new DataView(buffer);
          const tokenLen = view.getUint8(0);
          const decoder = new TextDecoder('ascii');
          const fileId = decoder.decode(new Uint8Array(buffer, 1, tokenLen));
          const chunk = new Uint8Array(buffer, 1 + tokenLen);
          
          let receive = null;
          let fileItem = null;
          for (const r of activeShares.values()) {
            if (r.files && r.files[fileId]) {
              receive = r;
              fileItem = r.files[fileId];
              break;
            }
          }
          
          if (receive && fileItem && fileItem.status === 'receiving') {
            fileItem.bytesTransferred += chunk.length;
            const fileSize = fileItem.size || 0;
            fileItem.percent = fileSize > 0
              ? Math.min(100, Math.round((fileItem.bytesTransferred / fileSize) * 100))
              : 0;
            
            updateActiveShareProgressUI(fileId, fileItem.percent, fileItem.bytesTransferred);
            
            // Forward chunk to Electron main process to write to disk
            ipcRenderer.send('receive-file-chunk', { token: fileId, chunk });
          }
        } catch (binErr) {
          console.error('[RelayWS] Error processing binary packet:', binErr);
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {

        case 'auth-ok': {
          console.log('[RelayWS] Authenticated with relay server.');
          break;
        }

        case 'share-registered': {
          const share = activeShares.get('_registering');
          if (share) {
            activeShares.delete('_registering');
            share.status = 'waiting';
            share.token = msg.token;
            const downloadUrl = `${RELAY_BASE_URL}/d/${msg.token}`;
            share.url = downloadUrl;
            activeShares.set(msg.token, share);
            
            // Show generated link UI
            const linkContainer = $('#shareLinkContainer');
            const linkUrlEl = $('#shareLinkUrl');
            const createBtn = $('#createShareBtn');

            if (linkUrlEl) linkUrlEl.textContent = downloadUrl;
            if (linkContainer) linkContainer.style.display = 'block';
            if (createBtn) {
              createBtn.disabled = false;
              createBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                Create Share Link
              `;
            }

            // Copy to clipboard automatically
            try {
              await navigator.clipboard.writeText(downloadUrl);
              showToast('Link created & copied!', 'success');
            } catch {
              showToast('Link created!', 'success');
            }

            // Render QR Code
            renderShareQr(downloadUrl);
            renderActiveShares();
            resetShareFileSelection(true);
          }
          break;
        }

        case 'receive-registered': {
          const receive = activeShares.get('_registering_receive');
          if (receive) {
            activeShares.delete('_registering_receive');
            receive.status = 'waiting';
            receive.token = msg.token;
            const uploadUrl = `${RELAY_BASE_URL}/u/${msg.token}`;
            receive.url = uploadUrl;
            activeShares.set(msg.token, receive);
            
            // Show generated link UI
            const linkContainer = $('#shareLinkContainer');
            const linkUrlEl = $('#shareLinkUrl');
            const createBtn = $('#createReceiveBtn');

            if (linkUrlEl) linkUrlEl.textContent = uploadUrl;
            if (linkContainer) linkContainer.style.display = 'block';
            if (createBtn) {
              createBtn.disabled = false;
              createBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0 7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                Generate Receive Link
              `;
            }

            // Copy to clipboard automatically
            try {
              await navigator.clipboard.writeText(uploadUrl);
              showToast('Upload link created & copied!', 'success');
            } catch (e) {
              showToast('Upload link created!', 'success');
            }

            // Render QR Code
            renderShareQr(uploadUrl);
            renderActiveShares();
          }
          break;
        }

        case 'incoming-upload': {
          const token = msg.token;
          const fileId = msg.fileId;
          const receive = activeShares.get(token);
          if (receive) {
            if (!receive.files) receive.files = {};
            receive.files[fileId] = {
              id: fileId,
              name: msg.filename,
              size: msg.size,
              mimeType: msg.mimeType,
              preview: msg.preview, // base64 preview thumbnail
              status: 'pending_accept',
              bytesTransferred: 0,
              percent: 0
            };
            
            receive.status = 'pending_accept';
            renderActiveShares();
            showToast(`Incoming file request: ${msg.filename}`, 'info');

            // Trigger system Desktop notification
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              new Notification("Incoming File Request", {
                body: `Your friend wants to send: ${msg.filename} (${formatSize(msg.size)})`,
                icon: 'logo.png'
              });
            }
          }
          break;
        }

        case 'upload-cancelled': {
          const token = msg.token;
          const fileId = msg.fileId;
          const receive = activeShares.get(token);
          if (receive && receive.files && receive.files[fileId]) {
            delete receive.files[fileId];
            
            const remainingCount = Object.keys(receive.files).length;
            if (remainingCount === 0) {
              receive.status = 'waiting';
            }
            renderActiveShares();
            showToast('Uploader cancelled the request.', 'info');
          }
          break;
        }

        case 'upload-started': {
          const token = msg.token;
          const fileId = msg.fileId;
          const receive = activeShares.get(token);
          if (receive) {
            if (!receive.files) receive.files = {};
            if (!receive.files[fileId]) {
              receive.files[fileId] = { id: fileId, name: msg.filename, size: msg.size, status: 'receiving', bytesTransferred: 0, percent: 0 };
            }
            const fileItem = receive.files[fileId];
            fileItem.status = 'receiving';
            fileItem.bytesTransferred = 0;
            fileItem.percent = 0;
            
            receive.status = 'receiving';
            renderActiveShares();
            console.log(`[RelayWS] Upload started: ${msg.filename}`);

            // Tell Electron main process to open file stream using fileId as token
            ipcRenderer.send('receive-file-start', {
              token: fileId,
              filename: msg.filename,
              size: msg.size,
              mimeType: msg.mimeType
            });
          }
          break;
        }

        case 'upload-complete': {
          const token = msg.token;
          const fileId = msg.fileId;
          const receive = activeShares.get(token);
          if (receive && receive.files && receive.files[fileId]) {
            const fileItem = receive.files[fileId];
            fileItem.status = 'completed';
            fileItem.percent = 100;
            fileItem.bytesTransferred = msg.bytesTransferred;
            renderActiveShares();
            showToast(`Received: "${fileItem.name}"`, 'success');

            // Tell Electron main process to finalize and save the file
            ipcRenderer.send('receive-file-end', { token: fileId });

            if (receive.expiryMode === 'download') {
              const linkUrlEl = $('#shareLinkUrl');
              if (linkUrlEl && linkUrlEl.textContent === receive.url) {
                const linkContainer = $('#shareLinkContainer');
                if (linkContainer) linkContainer.style.display = 'none';
              }
            }
            
            // Process next queued file in sequential mode
            processSequentialQueue(token);
          }
          break;
        }

        case 'upload-error': {
          const token = msg.token;
          const fileId = msg.fileId;
          const receive = activeShares.get(token);
          if (receive && receive.files && receive.files[fileId]) {
            const fileItem = receive.files[fileId];
            fileItem.status = 'failed';
            renderActiveShares();
            showToast(`Upload failed for: ${fileItem.name}`, 'error');

            // Tell Electron main process to delete the partial temp file
            ipcRenderer.send('receive-file-error', { token: fileId });

            // Process next queued file in sequential mode
            processSequentialQueue(token);
          }
          break;
        }

        case 'request-stream': {
          // A recipient has requested the download — stream the file!
          const token = msg.token;
          const share = activeShares.get(token);
          if (!share) {
            sendRelayMessage({ type: 'stream-error', token, message: 'Share not found locally' });
            return;
          }

          share.status = 'downloading';
          share.bytesTransferred = 0;
          renderActiveShares();
          console.log(`[RelayWS] Stream request received for file: ${share.file.name}`);

          // Stream the file in chunks
          try {
            await streamFileToRelay(token, share.file);
          } catch (err) {
            console.error('[RelayWS] Error streaming file:', err);
            sendRelayMessage({ type: 'stream-error', token, message: err.message });
            share.status = 'waiting';
            renderActiveShares();
          }
          break;
        }

        case 'download-progress': {
          const share = activeShares.get(msg.token);
          if (share) {
            share.bytesTransferred = msg.bytesTransferred;
            share.percent = msg.percent;
            updateActiveShareProgressUI(msg.token, msg.percent, msg.bytesTransferred);
          }
          break;
        }

        case 'download-complete': {
          const share = activeShares.get(msg.token);
          if (share) {
            share.status = 'completed';
            share.bytesTransferred = msg.bytesTransferred;
            share.percent = 100;
            renderActiveShares();
            showToast(`Download of "${share.file.name}" completed!`, 'success');

            if (share.expiryMode === 'download') {
              activeShares.delete(msg.token);
              // Hide generated link if it was this one
              const linkUrlEl = $('#shareLinkUrl');
              if (linkUrlEl && linkUrlEl.textContent === share.url) {
                const linkContainer = $('#shareLinkContainer');
                if (linkContainer) linkContainer.style.display = 'none';
              }
              setTimeout(renderActiveShares, 2000);
            }
          }
          break;
        }

        case 'download-aborted': {
          const share = activeShares.get(msg.token);
          if (share) {
            share.status = 'waiting';
            share.bytesTransferred = 0;
            share.percent = 0;
            renderActiveShares();
            showToast(`Download of "${share.file.name}" was interrupted.`, 'warning');
          }
          break;
        }

        case 'share-cancelled': {
          activeShares.delete(msg.token);
          renderActiveShares();
          break;
        }

        case 'error': {
          showToast(msg.message, 'error');
          // Reset button text on error
          const createBtn = $('#createShareBtn');
          if (createBtn) {
            createBtn.disabled = false;
            createBtn.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Create Share Link
            `;
          }
          const createReceiveBtn = $('#createReceiveBtn');
          if (createReceiveBtn) {
            createReceiveBtn.disabled = false;
            createReceiveBtn.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Generate Receive Link
            `;
          }
          break;
        }
      }
    };

    relayWs.onclose = () => {
      isConnectingRelay = false;
      stopRelayHeartbeat();
      updateRelayStatus('disconnected');
      console.log('[RelayWS] Connection to cloud relay closed.');
      scheduleRelayReconnect();
    };

    relayWs.onerror = () => {
      isConnectingRelay = false;
    };
  }

  function startRelayHeartbeat() {
    stopRelayHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  }

  function stopRelayHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  function scheduleRelayReconnect() {
    if (relayReconnectTimeout) clearTimeout(relayReconnectTimeout);
    relayReconnectTimeout = setTimeout(() => {
      console.log(`[RelayWS] Reconnecting to relay server (delay: ${relayReconnectDelay}ms)...`);
      initRelayWebSocket();
      relayReconnectDelay = Math.min(relayReconnectDelay * 2, 30000);
    }, relayReconnectDelay);
  }

  function sendRelayMessage(msg) {
    if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      relayWs.send(JSON.stringify(msg));
    }
  }

  function updateRelayStatus(status) {
    const indicator = $('#relayStatusIndicator');
    const label = $('#relayStatusText');
    if (!indicator || !label) return;

    if (status === 'connected') {
      indicator.style.backgroundColor = '#00d26a';
      label.textContent = 'Relay Server: Connected';
    } else if (status === 'connecting') {
      indicator.style.backgroundColor = '#ffaa00';
      label.textContent = 'Relay Server: Connecting...';
    } else {
      indicator.style.backgroundColor = '#ff3b30';
      label.textContent = 'Relay Server: Disconnected';
    }
  }

  async function streamFileToRelay(token, file) {
    const CHUNK_SIZE = 64 * 1024;
    const totalSize = file.size;
    let offset = 0;

    const isCancelled = () => {
      const share = activeShares.get(token);
      return !share || share.status !== 'downloading';
    };

    while (offset < totalSize) {
      if (isCancelled()) {
        console.log(`[RelayWS] Streaming for token ${token} was cancelled.`);
        return;
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await readSliceAsArrayBuffer(slice);

      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(buffer);
      } else {
        throw new Error('WebSocket closed during streaming');
      }

      offset += CHUNK_SIZE;
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    sendRelayMessage({
      type: 'stream-end',
      token
    });
  }

  function readSliceAsArrayBuffer(slice) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(slice);
    });
  }

  function setupShareToFriend() {
    const fileDrop = $('#shareFileDrop');
    const fileInput = $('#shareFileInput');
    const createBtn = $('#createShareBtn');

    // Register mode toggle button click handlers programmatically
    const modeSendBtn = $('#modeSendBtn');
    const modeReceiveBtn = $('#modeReceiveBtn');
    
    if (modeSendBtn) {
      modeSendBtn.addEventListener('click', () => window.switchShareMode('send'));
    }
    if (modeReceiveBtn) {
      modeReceiveBtn.addEventListener('click', () => window.switchShareMode('receive'));
    }

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
          handleShareFileSelection(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
          handleShareFileSelection(fileInput.files[0]);
        }
      });
    }

    if (createBtn) {
      createBtn.addEventListener('click', () => {
        if (!selectedShareFile) return;
        if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
          showToast('Not connected to relay server. Reconnecting...', 'error');
          initRelayWebSocket();
          return;
        }

        createBtn.disabled = true;
        createBtn.innerHTML = `
          <svg class="spinner" viewBox="0 0 50 50" style="width:16px;height:16px;margin-right:8px;animation:rotate 2s linear infinite;display:inline-block;vertical-align:middle;"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5" stroke="var(--text-primary)" style="stroke-linecap:round;animation:dash 1.5s ease-in-out infinite;"></circle></svg>
          Generating Link...
        `;

        const expiryMode = document.querySelector('input[name="shareExpiry"]:checked').value;

        const newShare = {
          file: selectedShareFile,
          status: 'registering',
          bytesTransferred: 0,
          percent: 0,
          expiryMode
        };
        activeShares.set('_registering', newShare);

        sendRelayMessage({
          type: 'register-share',
          filename: selectedShareFile.name,
          size: selectedShareFile.size,
          mimeType: selectedShareFile.type || 'application/octet-stream',
          expiryMode
        });
      });
    }

    const createReceiveBtn = $('#createReceiveBtn');
    if (createReceiveBtn) {
      createReceiveBtn.addEventListener('click', () => {
        if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
          showToast('Not connected to relay server. Reconnecting...', 'error');
          initRelayWebSocket();
          return;
        }

        createReceiveBtn.disabled = true;
        createReceiveBtn.innerHTML = `
          <svg class="spinner" viewBox="0 0 50 50" style="width:16px;height:16px;margin-right:8px;animation:rotate 2s linear infinite;display:inline-block;vertical-align:middle;"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5" stroke="var(--text-primary)" style="stroke-linecap:round;animation:dash 1.5s ease-in-out infinite;"></circle></svg>
          Generating Link...
        `;

        const expiryMode = document.querySelector('input[name="receiveExpiry"]:checked').value;

        const newReceive = {
          direction: 'receive',
          status: 'registering',
          bytesTransferred: 0,
          percent: 0,
          expiryMode
        };
        activeShares.set('_registering_receive', newReceive);

        sendRelayMessage({
          type: 'register-receive',
          expiryMode
        });
      });
    }

    const clearShareFileBtn = $('#clearShareFileBtn');

    if (clearShareFileBtn) {
      clearShareFileBtn.addEventListener('click', () => resetShareFileSelection(false));
    }

    const copyBtn = $('#copyShareLinkBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const linkUrl = $('#shareLinkUrl').textContent;
        if (linkUrl) {
          navigator.clipboard.writeText(linkUrl);
          showToast('Copied to clipboard!', 'success');
        }
      });
    }

    const qrBtn = $('#qrShareLinkBtn');
    if (qrBtn) {
      qrBtn.addEventListener('click', () => {
        const qrContainer = $('#shareQrContainer');
        if (qrContainer) {
          qrContainer.style.display = qrContainer.style.display === 'none' ? 'flex' : 'none';
        }
      });
    }

    const revokeBtn = $('#revokeShareLinkBtn');
    if (revokeBtn) {
      revokeBtn.addEventListener('click', () => {
        const linkUrl = $('#shareLinkUrl').textContent;
        if (!linkUrl) return;
        
        const parts = linkUrl.split('/');
        const token = parts[parts.length - 1];
        
        if (token) {
          sendRelayMessage({ type: 'cancel-share', token });
          activeShares.delete(token);
          renderActiveShares();
          showToast('Share link revoked.', 'info');
          
          const linkContainer = $('#shareLinkContainer');
          if (linkContainer) linkContainer.style.display = 'none';
          
          const qrContainer = $('#shareQrContainer');
          if (qrContainer) qrContainer.style.display = 'none';
        }
      });
    }

    const activeList = $('#activeSharesList');
    if (activeList) {
      activeList.addEventListener('click', (e) => {
        // Revoke Link
        const revokeItemBtn = e.target.closest('.active-share-revoke-btn');
        if (revokeItemBtn) {
          const token = revokeItemBtn.getAttribute('data-token');
          if (token) {
            sendRelayMessage({ type: 'cancel-share', token });
            activeShares.delete(token);
            renderActiveShares();
            showToast('Share link revoked.', 'info');

            const linkUrlEl = $('#shareLinkUrl');
            if (linkUrlEl && linkUrlEl.textContent.endsWith('/' + token)) {
              const linkContainer = $('#shareLinkContainer');
              if (linkContainer) linkContainer.style.display = 'none';
              const qrContainer = $('#shareQrContainer');
              if (qrContainer) qrContainer.style.display = 'none';
            }
          }
          return;
        }

        // Accept (Download)
        const acceptBtn = e.target.closest('.active-share-accept-btn');
        if (acceptBtn) {
          const token = acceptBtn.getAttribute('data-token');
          const fileId = acceptBtn.getAttribute('data-file-id');
          if (token && fileId) {
            acceptUpload(token, fileId);
          }
          return;
        }

        // Decline
        const declineBtn = e.target.closest('.active-share-decline-btn');
        if (declineBtn) {
          const token = declineBtn.getAttribute('data-token');
          const fileId = declineBtn.getAttribute('data-file-id');
          if (token && fileId) {
            declineUpload(token, fileId);
          }
          return;
        }

        // Bulk Accept (All Parallel or All Sequential)
        const acceptAllBtn = e.target.closest('.accept-all-btn');
        if (acceptAllBtn) {
          const token = acceptAllBtn.getAttribute('data-token');
          const mode = acceptAllBtn.getAttribute('data-mode') || 'parallel';
          const share = activeShares.get(token);
          if (share && share.files) {
            share.downloadMode = mode;
            const pendingFiles = Object.values(share.files).filter(f => f.status === 'pending_accept');
            if (pendingFiles.length > 0) {
              if (mode === 'parallel') {
                pendingFiles.forEach(file => {
                  acceptUpload(token, file.id);
                });
              } else {
                // Sequential: accept the first one, processSequentialQueue takes care of the rest
                acceptUpload(token, pendingFiles[0].id);
              }
            }
          }
          return;
        }

        // Bulk Decline All
        const declineAllBtn = e.target.closest('.decline-all-btn');
        if (declineAllBtn) {
          const token = declineAllBtn.getAttribute('data-token');
          const share = activeShares.get(token);
          if (share && share.files) {
            Object.keys(share.files).forEach(fileId => {
              if (share.files[fileId].status === 'pending_accept') {
                declineUpload(token, fileId);
              }
            });
          }
          return;
        }

        // Reveal in Folder
        const folderBtn = e.target.closest('.active-share-folder-btn');
        if (folderBtn) {
          const filename = folderBtn.getAttribute('data-filename');
          if (filename) {
            if (isElectron) {
              ipcRenderer.send('open-file-folder', filename);
            } else {
              showToast('Reveal only supported on desktop app.', 'info');
            }
          }
          return;
        }
      });
    }
  }

  function handleShareFileSelection(file) {
    selectedShareFile = file;
    const fileDrop = $('#shareFileDrop');
    const preview = $('#shareFilePreview');
    const previewImg = $('#sharePreviewImg');
    const previewIcon = $('#shareFilePreviewIcon');
    const fileName = $('#shareFileName');
    const createBtn = $('#createShareBtn');

    if (!fileDrop || !preview || !previewImg || !previewIcon || !fileName || !createBtn) return;

    fileDrop.style.display = 'none';
    preview.style.display = 'flex';
    fileName.textContent = `${file.name} (${formatSize(file.size)})`;
    createBtn.disabled = false;

    if (file.type.startsWith('image/')) {
      previewImg.style.display = 'block';
      previewIcon.style.display = 'none';
      const reader = new FileReader();
      reader.onload = (e) => {
        previewImg.src = e.target.result;
      };
      reader.readAsDataURL(file);
    } else {
      previewImg.style.display = 'none';
      previewIcon.style.display = 'block';
      const ext = file.name.split('.').pop().toLowerCase();
      if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
        previewIcon.textContent = '🎵';
      } else if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
        previewIcon.textContent = '🎬';
      } else if (['pdf'].includes(ext)) {
        previewIcon.textContent = '📕';
      } else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
        previewIcon.textContent = '📦';
      } else {
        previewIcon.textContent = '📄';
      }
    }
  }

  function resetShareFileSelection(keepLinkContainer = false) {
    selectedShareFile = null;
    const fileInput = $('#shareFileInput');
    if (fileInput) fileInput.value = '';

    const fileDrop = $('#shareFileDrop');
    const preview = $('#shareFilePreview');
    const createBtn = $('#createShareBtn');
    const linkContainer = $('#shareLinkContainer');
    const qrContainer = $('#shareQrContainer');

    if (fileDrop) fileDrop.style.display = 'flex';
    if (preview) preview.style.display = 'none';
    if (createBtn) {
      createBtn.disabled = true;
      createBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        Create Share Link
      `;
    }
    if (!keepLinkContainer) {
      if (linkContainer) linkContainer.style.display = 'none';
      if (qrContainer) qrContainer.style.display = 'none';
    }
  }

  function renderActiveShares() {
    const list = $('#activeSharesList');
    if (!list) return;

    if (activeShares.size === 0 || 
        (activeShares.size === 1 && (activeShares.has('_registering') || activeShares.has('_registering_receive'))) ||
        (activeShares.size === 2 && activeShares.has('_registering') && activeShares.has('_registering_receive'))) {
      list.innerHTML = '<div class="empty-shares-text" style="text-align: center; color: var(--text-secondary); font-size: 0.8rem; padding: 20px 0;">No active share or receive links. Select a file or generate a receive link above.</div>';
      return;
    }

    let html = '';
    for (const [token, share] of activeShares.entries()) {
      if (token === '_registering' || token === '_registering_receive') continue;

      let statusText = 'Waiting';
      let statusClass = 'waiting';
      let actionButtonsHtml = '';
      let filesHtml = '';
      
      let name = '';
      let meta = '';
      let icon = '📄';

      if (share.direction === 'receive') {
        const fileList = Object.values(share.files || {});
        let hasPending = false;
        
        if (fileList.length > 0) {
          hasPending = fileList.some(f => f.status === 'pending_accept');
          
          filesHtml = `<div class="receive-files-stack">`;
          filesHtml += fileList.map(file => {
            let rowStatusText = file.status;
            let badgeClass = file.status;
            let fileActions = '';
            
            if (file.status === 'pending_accept') {
              rowStatusText = 'Pending Accept';
              badgeClass = 'waiting';
              fileActions = `
                <button class="active-share-accept-btn" data-token="${token}" data-file-id="${file.id}" title="Accept & Download" style="background: rgba(0, 210, 106, 0.15) !important; color: #00d26a !important; border: 1px solid rgba(0, 210, 106, 0.25) !important; border-radius: 4px; padding: 2px 6px; font-size: 0.68rem; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 2px;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </button>
                <button class="active-share-decline-btn" data-token="${token}" data-file-id="${file.id}" title="Decline" style="background: rgba(255, 59, 48, 0.15) !important; color: #ff3b30 !important; border: 1px solid rgba(255, 59, 48, 0.25) !important; border-radius: 4px; padding: 2px 6px; font-size: 0.68rem; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 2px;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              `;
            } else if (file.status === 'receiving') {
              rowStatusText = `Receiving ${file.percent || 0}%`;
              badgeClass = 'downloading';
            } else if (file.status === 'completed') {
              rowStatusText = 'Sent';
              badgeClass = 'completed';
              fileActions = `
                <button class="active-share-folder-btn" data-filename="${file.name}" title="Reveal in Folder" style="background: rgba(0, 136, 204, 0.15) !important; color: #33a3ff !important; border: 1px solid rgba(0, 136, 204, 0.25) !important; border-radius: 4px; padding: 2px 6px; font-size: 0.68rem; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 2px;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                </button>
              `;
            } else if (file.status === 'declined') {
              rowStatusText = 'Declined';
              badgeClass = 'declined';
            } else if (file.status === 'failed') {
              rowStatusText = 'Failed';
              badgeClass = 'failed';
            }

            const ext = file.name.split('.').pop().toLowerCase();
            let icon = '📄';
            if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) icon = '🎵';
            else if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) icon = '🎬';
            else if (['pdf'].includes(ext)) icon = '📕';
            else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) icon = '📦';
            else if (file.preview) {
              icon = `<img src="${file.preview}" style="width: 24px; height: 24px; border-radius: 4px; object-fit: cover; border: 1px solid rgba(255,255,255,0.05);">`;
            } else if (file.mimeType && file.mimeType.startsWith('image/')) {
              icon = '🖼️';
            }

            return `
              <div class="receive-file-row ${file.status === 'receiving' ? 'active' : ''}" id="file-item-${file.id}">
                <div class="receive-file-left">
                  <span class="active-share-icon" style="font-size:0.9rem;">${icon}</span>
                  <div class="receive-file-info">
                    <span class="receive-file-name" title="${file.name}">${file.name}</span>
                    <span class="receive-file-size">${formatSize(file.size)}</span>
                  </div>
                </div>
                <div class="receive-file-actions">
                  <span class="share-status-tag ${badgeClass}" style="padding: 2px 6px; font-size: 0.65rem;">
                    <span class="status-text">${rowStatusText}</span>
                  </span>
                  ${fileActions}
                </div>
              </div>
            `;
          }).join('');
          filesHtml += `</div>`;
        }

        let bulkActionsHtml = '';
        if (hasPending) {
          bulkActionsHtml = `
            <div class="receive-bulk-actions">
              <button class="btn-bulk-action accept-all-btn" data-token="${token}" data-mode="parallel">Download All (At Once)</button>
              <button class="btn-bulk-action accept-all-btn" data-token="${token}" data-mode="sequential" style="background: rgba(0, 136, 204, 0.12) !important; color: #33a3ff !important; border-color: rgba(0, 136, 204, 0.25) !important;">Download All (Seq)</button>
              <button class="btn-bulk-action decline-all-btn" data-token="${token}" style="background: rgba(255, 59, 48, 0.1) !important; color: #ff3b30 !important; border-color: rgba(255, 59, 48, 0.2) !important;">Decline All</button>
            </div>
          `;
        }

        name = `Receive Link (${fileList.length} files)`;
        meta = `Receive Link • Expiry: ${getFriendlyExpiry(share.expiryMode, true)}`;
        icon = '📥';

        actionButtonsHtml = bulkActionsHtml;
        statusText = share.status === 'pending_accept' ? 'Action Required' : (share.status === 'receiving' ? 'Receiving...' : 'Waiting');
        statusClass = share.status === 'pending_accept' ? 'downloading' : (share.status === 'receiving' ? 'downloading' : 'waiting');
      } else {
        if (share.status === 'downloading') {
          statusText = `Downloading (${share.percent || 0}%)`;
          statusClass = 'downloading';
        } else if (share.status === 'completed') {
          statusText = 'Completed';
          statusClass = 'completed';
        }
        
        name = share.file.name;
        meta = `${formatSize(share.file.size)} • Send Link • Expiry: ${getFriendlyExpiry(share.expiryMode, false)}`;
        
        const ext = share.file.name.split('.').pop().toLowerCase();
        if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) icon = '🎵';
        else if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) icon = '🎬';
        else if (['pdf'].includes(ext)) icon = '📕';
        else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) icon = '📦';
        else if (share.file.type && share.file.type.startsWith('image/')) icon = '🖼️';
      }

      html += `
        <div class="active-share-item" id="share-item-${token}" style="flex-direction: column; align-items: stretch; gap: 8px;">
          <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
            <div class="active-share-info">
              <span class="active-share-icon">${icon}</span>
              <div class="active-share-details">
                <span class="active-share-name" title="${name}">${name}</span>
                <span class="active-share-meta">${meta}</span>
              </div>
            </div>
            <div class="active-share-status-area" style="display: flex; align-items: center; flex-shrink: 0;">
              <span class="share-status-tag ${statusClass}">
                <span class="status-dot"></span>
                <span class="status-text">${statusText}</span>
              </span>
              <button class="active-share-revoke-btn" data-token="${token}" title="Revoke Link" style="margin-left: 8px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
          ${filesHtml}
          ${actionButtonsHtml}
        </div>
      `;
    }

    list.innerHTML = html;
  }

  function acceptUpload(token, fileId) {
    const share = activeShares.get(token);
    if (!share || !share.files || !share.files[fileId]) return;

    sendRelayMessage({
      type: 'accept-upload',
      token,
      fileId
    });

    share.files[fileId].status = 'receiving';
    share.files[fileId].percent = 0;
    share.status = 'receiving';
    renderActiveShares();
    showToast(`Download started for: ${share.files[fileId].name}`, 'success');
  }

  function declineUpload(token, fileId) {
    const share = activeShares.get(token);
    if (!share || !share.files || !share.files[fileId]) return;

    sendRelayMessage({
      type: 'decline-upload',
      token,
      fileId
    });

    share.files[fileId].status = 'declined';
    renderActiveShares();
    showToast(`Declined: ${share.files[fileId].name}`, 'info');
  }

  function processSequentialQueue(token) {
    const share = activeShares.get(token);
    if (!share || share.downloadMode !== 'sequential') return;

    const nextFile = Object.values(share.files).find(f => f.status === 'pending_accept');
    if (nextFile) {
      acceptUpload(token, nextFile.id);
    } else {
      share.status = 'waiting';
      renderActiveShares();
    }
  }

  function getFriendlyExpiry(mode, isReceive = false) {
    switch (mode) {
      case 'download': return isReceive ? '1-time upload' : '1-time download';
      case '1h': return '1 hour';
      case '6h': return '6 hours';
      case '24h': return '24 hours';
      default: return mode;
    }
  }

  function updateActiveShareProgressUI(fileId, percent, bytesTransferred) {
    const item = $(`#file-item-${fileId} .status-text`);
    if (item) {
      item.textContent = `Receiving (${percent}%)`;
    }
  }

  function renderShareQr(url) {
    const graphicEl = $('#shareQrGraphic');
    if (!graphicEl) return;
    graphicEl.innerHTML = '';
    
    if (typeof QRCode !== 'undefined') {
      new QRCode(graphicEl, {
        text: url,
        width: 160,
        height: 160,
        colorDark: "#ffffff",
        colorLight: "#000000",
        correctLevel: QRCode.CorrectLevel.H
      });
      setTimeout(() => {
        const qrImg = graphicEl.querySelector('img');
        const qrCanvas = graphicEl.querySelector('canvas');
        if (qrImg) {
          qrImg.style.borderRadius = '8px';
          qrImg.style.border = '4px solid white';
          qrImg.style.display = 'block';
          qrImg.style.margin = '0 auto';
        }
        if (qrCanvas) {
          qrCanvas.style.borderRadius = '8px';
          qrCanvas.style.border = '4px solid white';
          qrCanvas.style.display = 'block';
          qrCanvas.style.margin = '0 auto';
        }
      }, 50);
    }
  }

  document.addEventListener('DOMContentLoaded', () => { init(); });
})();