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
      const protocol = ipcRenderer.sendSync('get-protocol-sync') || 'https';
      apiBase = `${protocol}://localhost:${port}`;
    } catch (e) {
      console.error('IPC get-port-sync/get-protocol-sync failed:', e);
      apiBase = `https://localhost:3478`;
    }
  }

  function resolveMediaUrl(src) {
    if (!src) return '';
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:') || src.startsWith('data:')) {
      return src;
    }
    if ((isElectron || (typeof window !== 'undefined' && window.location.protocol === 'file:')) && apiBase) {
      return `${apiBase}${src.startsWith('/') ? '' : '/'}${src}`;
    }
    return src;
  }
  window.resolveMediaUrl = resolveMediaUrl;

  // ─── Enhanced Fetch with Retry & Error Handling ─────────────
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 1000;

  async function doFetch(url, options = {}) {
    const targetUrl = isElectron ? `${apiBase}${url}` : url;
    const retries = options._retries !== undefined ? options._retries : MAX_RETRIES;
    const silent = options._silent || false;
    
    // Remove internal options before passing to fetch
    const fetchOpts = { ...options };
    delete fetchOpts._retries;
    delete fetchOpts._silent;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(targetUrl, fetchOpts);

        // Auth failure — don't retry
        if (res.status === 401) {
          if (!silent) showToast('Session expired. Please re-authenticate.', 'error');
          return res;
        }

        // Rate limited — don't retry, inform user
        if (res.status === 429) {
          if (!silent) showToast('Too many requests. Please slow down.', 'error');
          return res;
        }

        // Server error — retry if attempts remain
        if (res.status >= 500 && attempt < retries) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }

        return res;
      } catch (err) {
        // Network error (offline, refused, etc.)
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        // Final failure
        if (!silent) {
          showToast('Network error. Check your connection.', 'error');
        }
        throw err;
      }
    }
  }

  // ─── State ─────────────────────────────────────────────────
  let serverInfo = null;
  let allItems = [];
  let currentFilter = 'all';
  let sseSource = null;
  let isConnected = false;
  let fetchPairedDevicesCount = null;

  // ─── DOM Helper ────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function getShareLinkElements() {
    const isReceiveMode = $('#receiveModeContainer') && $('#receiveModeContainer').style.display !== 'none';
    if (isReceiveMode) {
      return {
        container: $('#receiveShareLinkContainer'),
        urlEl: $('#receiveShareLinkUrl')
      };
    } else {
      return {
        container: $('#sendShareLinkContainer'),
        urlEl: $('#sendShareLinkUrl')
      };
    }
  }

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
    runSetup('GlobalExternalLinks', setupGlobalExternalLinks);
    
    // Request permission for system notifications
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      try {
        Notification.requestPermission();
      } catch (_) {}
    }
    
    runSetup('ShortcutsModal', setupShortcutsModal);
    runSetup('SettingsModal', setupSettingsModal);
    runSetup('LogsModal', setupLogsModal);
    runSetup('TextModal', setupTextModal);
    runSetup('ServiceDropdown', setupServiceDropdown);
    runSetup('ControlCenter', setupControlCenter);
    runSetup('UniversalRefresh', setupUniversalRefresh);
    runSetup('PCWebRTCScreencast', setupPCWebRTCScreencast);
    runSetup('QuickPairQrModal', setupQuickPairQrModal);

    // Immediate initial fallback QR code for right panel pairing card
    const rightPanelQrImg = $('#rightPanelQrImg');
    if (rightPanelQrImg) {
      rightPanelQrImg.src = getThemedQrUrl(window.location.origin + '/m');
    }

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
    const rightPanelQrImg = $('#rightPanelQrImg');
    if (serverInfo) {
      const baseUrl = serverInfo.url;
      const urlWithToken = `${baseUrl}/m`;
      if (qrContainer) {
        qrContainer.innerHTML = `<img src="${getThemedQrUrl(urlWithToken)}" alt="Setup QR Code" width="110" height="110" style="display: block;">`;
      }
      if (homepageQr) {
        homepageQr.innerHTML = `<img src="${getThemedQrUrl(urlWithToken)}" alt="Quick Connect QR Code" width="80" height="80" style="display: block; border-radius: 4px;">`;
      }
      if (rightPanelQrImg) {
        rightPanelQrImg.src = getThemedQrUrl(urlWithToken);
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
      imgShareToPC.src = getThemedQrUrl('https://www.icloud.com/shortcuts/bd3ef813f57d435e8e7d3d1823b13ad8');
    }
    if (imgClipboardToPC && imgClipboardToPC.src) {
      imgClipboardToPC.src = getThemedQrUrl('https://www.icloud.com/shortcuts/3e39fa6cad3147019dc905e96994b1e6');
    }
    if (imgGetPCClipboard && imgGetPCClipboard.src) {
      imgGetPCClipboard.src = getThemedQrUrl('https://www.icloud.com/shortcuts/1698d917c5a3447abea2fa506d7b1dac');
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

  function renderSidebarStorage(drives) {
    const container = $('#sidebarStorageContainer');
    if (!container) return;

    if (!drives || drives.length === 0) {
      container.innerHTML = `
        <div style="font-size: 0.72rem; color: #a0a0b8; padding: 4px 0;">Local Disk (C:): Active</div>
      `;
      return;
    }

    let html = '';
    drives.forEach(drive => {
      const pct = drive.usedPercent || 0;
      const strokeDash = `${pct}, 100`;
      html += `
        <div style="display: flex; align-items: center; gap: 10px; padding: 4px 0;">
          <div style="position: relative; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
            <svg width="36" height="36" viewBox="0 0 36 36">
              <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="3.5" />
              <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#ff5500" stroke-dasharray="${strokeDash}" stroke-width="3.5" stroke-linecap="round" />
            </svg>
            <span style="position: absolute; font-size: 0.64rem; font-weight: 700; color: #ffffff;">${escapeHtml(drive.letter)}:</span>
          </div>
          <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 0.72rem; font-weight: 600; color: #ffffff;">${escapeHtml(drive.label)}</span>
              <span style="font-size: 0.65rem; color: #ff5500; font-weight: 700;">${pct}%</span>
            </div>
            <span style="font-size: 0.66rem; color: #a0a0b8; margin-top: 1px;">${drive.usedGB} GB used / ${drive.totalGB} GB</span>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
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
    if ($('#rightPanelDeviceName')) $('#rightPanelDeviceName').textContent = info.deviceName || 'Asep\'s PC';
    if ($('#rightPanelOsName')) $('#rightPanelOsName').textContent = info.osName || 'Windows 11 Home';
    if ($('#rightPanelIp')) $('#rightPanelIp').textContent = info.ip || '192.168.1.120';
    if ($('#sysSecNetworkIp')) $('#sysSecNetworkIp').textContent = info.ip || '127.0.0.1';
    if ($('#sysSecNetworkPort')) $('#sysSecNetworkPort').textContent = info.port ? (parseInt(info.port, 10) + 1) : '3479';
    if (info.drives) renderSidebarStorage(info.drives);
    const ccPortalLink = $('#ccPortalLink');
    if (ccPortalLink) {
      ccPortalLink.href = `${baseUrl}/m`;
      ccPortalLink.textContent = `${baseUrl}/m`;
    }

    // Setup QR code for mobile
    const qrContainer = $('#mobileQrContainer');
    const homepageQr = $('#homepageQrContainer');
    const rightPanelQrImg = $('#rightPanelQrImg');
    const urlWithToken = `${baseUrl}/m`;
    
    if (qrContainer) {
      qrContainer.innerHTML = `<img src="${getThemedQrUrl(urlWithToken)}" alt="Setup QR Code" width="110" height="110" style="display: block;">`;
    }
    if (homepageQr) {
      homepageQr.innerHTML = `<img src="${getThemedQrUrl(urlWithToken)}" alt="Quick Connect QR Code" width="80" height="80" style="display: block; border-radius: 4px;">`;
    }
    if (rightPanelQrImg) {
      rightPanelQrImg.src = getThemedQrUrl(urlWithToken);
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

    const receivedFeedArea = $('#receivedFeedArea');
    if (receivedFeedArea) {
      if (temporaryMode) {
        receivedFeedArea.classList.add('auto-clean-theme-active');
      } else {
        receivedFeedArea.classList.remove('auto-clean-theme-active');
      }
    }

    renderFeed();
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
  let sseReconnectDelay = 1000;
  const SSE_MAX_RECONNECT_DELAY = 30000;

  function connectSSE() {
    if (sseSource) sseSource.close();

    sseSource = new EventSource(isElectron ? `${apiBase}/api/events` : '/api/events');

    sseSource.onopen = () => {
      setConnectionStatus(true);
      sseReconnectDelay = 1000; // Reset backoff on successful connection
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

        // 🌟 Instant live updates for Recents, Files shelf, Dashboard and Clipboard Vault
        renderFilesTab();
        renderDashboardRecentActivity();
        renderClipboardVaultTab();

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
      renderFilesTab();
      renderDashboardRecentActivity();
      renderClipboardVaultTab();
      showToast('Dashboard feed cleared.', 'info');
    });

    sseSource.addEventListener('clipboard-vault-update', () => {
      renderClipboardVaultTab();
    });

    sseSource.addEventListener('history-update', (e) => {
      try {
        allItems = JSON.parse(e.data) || [];
        renderFeed();
        updateStats();
        renderFilesTab();
        renderDashboardRecentActivity();
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



    sseSource.addEventListener('device-change', () => {
      fetchPairedDevicesCount();
      renderRightPanelConnectedDevices();
      renderPairedDevicesTab();
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
      // Exponential backoff with cap
      setTimeout(connectSSE, sseReconnectDelay);
      sseReconnectDelay = Math.min(sseReconnectDelay * 1.5, SSE_MAX_RECONNECT_DELAY);
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
        const delaySec = Math.round(sseReconnectDelay / 1000);
        text.textContent = delaySec > 2 ? `Reconnecting in ${delaySec}s...` : 'Reconnecting...';
      }
    }
  }

  // ─── Received History ──────────────────────────────────────
  async function fetchHistory() {
    const feedEl = $('#feed');
    const emptyStateEl = $('#emptyState');
    
    // Show loading skeleton if feed is empty
    if (feedEl && allItems.length === 0) {
      feedEl.innerHTML = `<div class="feed-loading" aria-busy="true" aria-label="Loading history">
        <div class="skeleton-item"></div><div class="skeleton-item"></div><div class="skeleton-item"></div>
      </div>`;
      if (emptyStateEl) emptyStateEl.style.display = 'none';
    }

    try {
      const res = await doFetch('/api/history', { _silent: true });
      if (res && res.ok) {
        const data = await res.json();
        allItems = data.items || [];
        renderFeed();
      }
    } catch (err) {
      // Silently fail — SSE will populate if connection recovers
      if (feedEl && allItems.length === 0) {
        feedEl.innerHTML = '';
        if (emptyStateEl) emptyStateEl.style.display = 'block';
      }
    }
  }

  function addItemToState(item) {
    const exists = allItems.some(i => i.id === item.id);
    if (!exists) {
      item.isNew = true;
      const isAutoClearOn = $('#dashboardTempModeInput') ? $('#dashboardTempModeInput').checked : false;
      if (item.isTemporary === undefined) {
        item.isTemporary = isAutoClearOn;
      }
      allItems.unshift(item);
      if (allItems.length > 100) allItems.pop();
      setTimeout(() => {
        const scrollContainer = document.getElementById('receivedFeedScrollContainer');
        if (scrollContainer) scrollContainer.scrollTop = 0;
      }, 50);
    }
  }

  function renderDashboardRecentActivity() {
    const container = $('#dashboardRecentActivityList');
    if (!container) return;

    if ($('#sidebarTotalFilesCount')) {
      $('#sidebarTotalFilesCount').textContent = `${allItems ? allItems.length : 0} files`;
    }

    if (!allItems || allItems.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 24px 0; color: #a0a0b8; font-size: 0.78rem;">
          No transfers yet. Drop files above or send from your mobile device!
        </div>
      `;
      return;
    }

    const recentItems = allItems.slice(0, 5);
    let html = '';

    recentItems.forEach(item => {
      const isText = item.type === 'text' || item.type === 'link';
      const isImg = item.type === 'image' || (item.mimeType && item.mimeType.startsWith('image/'));
      const isVideo = item.mimeType && item.mimeType.startsWith('video/');
      const name = item.originalName || item.filename || (item.content ? item.content.slice(0, 30) : 'Item');
      const sizeStr = item.size ? formatBytes(item.size) : (isText ? `${(item.content || '').length} chars` : '');
      const timeStr = item.timestamp ? formatTimeAgo(new Date(item.timestamp)) : 'Just now';
      const source = item.deviceName || (item.deviceType === 'mobile' ? 'iPhone' : 'Received');

      let iconSvg = `<svg class="icon-svg md" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      if (isImg) {
        iconSvg = `<svg class="icon-svg md" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
      } else if (isText) {
        iconSvg = `<svg class="icon-svg md" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
      } else if (isVideo) {
        iconSvg = `<svg class="icon-svg md" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`;
      }

      html += `
        <div class="activity-item-row">
          <div class="activity-left">
            <div class="activity-file-icon">
              ${iconSvg}
            </div>
            <div class="activity-file-info">
              <div class="activity-file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
              <div class="activity-file-meta">Received from ${escapeHtml(source)}</div>
            </div>
          </div>
          <div class="activity-right">
            <span>${sizeStr}</span>
            <span>${timeStr}</span>
            <svg class="activity-status-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // ─── Render Feed ───────────────────────────────────────────
  function renderFeed() {
    renderDashboardRecentActivity();
    const feedEl = $('#feed');
    const emptyStateEl = $('#emptyState');
    const feedCountEl = $('#feedCount');
    if (!feedEl) return;

    const filtered = allItems.filter(item => {
      if (currentFilter === 'all') return true;
      if (currentFilter === 'image') {
        return item.type === 'image' || item.type === 'video';
      }
      if (currentFilter === 'file') {
        return item.type === 'file' || item.type === 'audio';
      }
      return item.type === currentFilter;
    });

    const countBadgeEl = $('#feedCountBadge');
    if (countBadgeEl) countBadgeEl.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'}`;

    if (filtered.length === 0) {
      feedEl.innerHTML = '';
      if (emptyStateEl) emptyStateEl.style.display = 'block';
      return;
    }

    if (emptyStateEl) emptyStateEl.style.display = 'none';

    const isAutoClearOn = $('#dashboardTempModeInput') ? $('#dashboardTempModeInput').checked : false;

    feedEl.innerHTML = filtered.map(item => {
      const isNewClass = item.isNew ? ' is-new' : '';
      if (item.isNew) {
        setTimeout(() => {
          const el = document.getElementById(`item-${item.id}`);
          if (el) el.classList.remove('is-new');
          item.isNew = false;
        }, 1500);
      }
      
      if (item.type === 'text') {
        const isUrl = /^https?:\/\//i.test((item.content || '').trim());
        const urlHref = isUrl ? escapeAttr(item.content.trim()) : '';
        const domainStr = isUrl ? urlHref.replace(/^https?:\/\//i, '').split('/')[0] : '';
        
        if (isUrl) {
          return `
            <div class="feed-item type-text type-url${isNewClass}" id="item-${item.id}">
              <button class="card-top-close-btn clear-card-btn" data-id="${item.id}" title="Clear card from feed">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div class="item-header">
                <div class="item-badge-wrap">
                  <span class="item-type-badge url">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                    Web Link
                  </span>
                </div>
              </div>
              <div class="item-body">
                <div class="url-card-box">
                  <div class="url-icon-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg></div>
                  <div class="url-text-wrap">
                    <a href="${urlHref}" target="_blank" class="item-url-link" title="${urlHref}">${escapeHtml(item.content.trim())}</a>
                    <span class="url-domain-sub">${escapeHtml(domainStr)}</span>
                  </div>
                </div>
              </div>
              <div class="item-actions">
                <div class="action-btn-group" style="margin-left: auto; display: flex; align-items: center; gap: 6px;">
                  <button class="btn btn-secondary btn-icon copy-btn" data-text="${escapeAttr(item.content)}" title="Copy Link to Clipboard">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 01-2-2h9a2 2 0 012 2v1"/></svg>
                  </button>
                  <a href="${urlHref}" target="_blank" class="btn btn-primary btn-icon open-url-btn" title="Open Link in Browser">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                  <button class="delete-btn" data-id="${item.id}" title="Delete item">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  </button>
                </div>
              </div>
            </div>`;
        }

        return `
          <div class="feed-item type-text${isNewClass}" id="item-${item.id}">
            <button class="card-top-close-btn clear-card-btn" data-id="${item.id}" title="Clear card from feed">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div class="item-header">
              <div class="item-badge-wrap">
                <span class="item-type-badge text">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                  Text Message
                </span>
              </div>
            </div>
            <div class="item-body">
              <div class="text-content-box">
                <pre class="item-text-content">${escapeHtml(item.content)}</pre>
              </div>
            </div>
            <div class="item-actions">
              <div class="action-btn-group" style="margin-left: auto; display: flex; align-items: center; gap: 6px;">
                <button class="btn btn-secondary btn-icon view-text-btn" data-id="${item.id}" title="View / Edit Full Text">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
                <button class="btn btn-secondary btn-icon copy-btn" data-text="${escapeAttr(item.content)}" title="Copy Text to Clipboard">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 01-2-2h9a2 2 0 012 2v1"/></svg>
                </button>
                <button class="delete-btn" data-id="${item.id}" title="Delete item">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
            </div>
          </div>`;
      }
      
      if (item.type === 'image') {
        const imgSrc = `${isElectron ? apiBase : ''}/received/${item.filename}`;
        const isPermanentlySaved = !item.isTemporary || item.userSaved;
        const tempBannerMsg = isAutoClearOn ? 'Temp' : 'Unsaved Temp';
        const tempClass = !isPermanentlySaved ? ' is-temporary-item' : '';

        return `
          <div class="feed-item type-image${isNewClass}${tempClass}" id="item-${item.id}">
            <button class="card-top-close-btn clear-card-btn" data-id="${item.id}" title="Clear card from feed">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div class="item-header">
              <div class="item-badge-wrap">
                <span class="item-type-badge image">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  Photo
                </span>
              </div>
              ${item.fileDeletedOnDisk ? `
                <span class="file-deleted-banner" title="File was deleted from saved location on disk">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  Deleted on Disk
                </span>
              ` : (!isPermanentlySaved ? `
                <span class="item-temp-banner" title="File received in temporary mode. Click Save to keep permanently.">
                  ${tempBannerMsg}
                </span>
              ` : `
                <span class="auto-saved-tag" title="File is saved permanently">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  Saved
                </span>
              `)}
            </div>
            <div class="item-body">
              ${item.fileDeletedOnDisk ? `
                <div class="file-deleted-box">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <span>File deleted in saved location. Send or save it again.</span>
                </div>
              ` : `
                <div class="image-preview-frame lightbox-trigger" data-src="${imgSrc}" data-name="${escapeAttr(item.originalName || item.filename)}">
                  <img src="${imgSrc}" alt="${escapeAttr(item.filename)}" loading="lazy" onerror="window.markFileDeletedOnDisk &amp;&amp; window.markFileDeletedOnDisk('${item.id}')">
                  <div class="image-hover-overlay">
                    <span class="zoom-badge">Click to Expand</span>
                  </div>
                </div>
              `}
              <div class="media-meta-row">
                <span class="media-filename" title="${escapeAttr(item.originalName || item.filename)}">${escapeHtml(item.originalName || item.filename)}</span>
              </div>
            </div>
            <div class="item-actions">
              <div class="action-meta-left" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span class="action-size-badge">${formatSize(item.size || 0)}</span>
              </div>
              <div class="action-btn-group" style="margin-left: auto; display: flex; align-items: center; gap: 6px;">
                <button class="btn btn-secondary btn-icon copy-img-btn" data-src="${imgSrc}" data-text="${escapeAttr(item.originalName || item.filename)}" title="Copy Photo to Clipboard">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 01-2-2h9a2 2 0 012 2v1"/></svg>
                </button>
                ${isPermanentlySaved ? `
                  ${isElectron ? `
                  <button class="btn btn-secondary btn-icon open-folder-btn" data-fn="${escapeAttr(item.filename)}" title="Show in Folder">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                  </button>` : ''}
                ` : `
                  <button type="button" data-id="${item.id}" class="btn btn-primary btn-icon save-dl-btn" title="Save Image Permanently">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </button>
                `}
                <button class="delete-btn" data-id="${item.id}" title="Delete item">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
            </div>
          </div>`;
      }
      
      if (item.type === 'file' || item.type === 'video' || item.type === 'audio') {
        const isAudio = item.type === 'audio' || (item.mimeType && item.mimeType.startsWith('audio'));
        const isVideo = item.type === 'video' || (item.mimeType && item.mimeType.startsWith('video'));
        const isPdf = item.mimeType && item.mimeType.includes('pdf');
        const fileUrl = `${isElectron ? apiBase : ''}/received/${item.filename}`;
        
        let fileIconSvg = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
        let fileIconSvgLarge = `
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
        
        if (isAudio) {
          fileIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
          fileIconSvgLarge = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
        } else if (isVideo) {
          fileIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
          fileIconSvgLarge = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
        } else if (isPdf) {
          fileIconSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
          fileIconSvgLarge = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
        }

        let badgeLabel = 'Document';
        if (isVideo) {
          badgeLabel = 'Video File';
        } else if (isAudio) {
          badgeLabel = 'Audio File';
        }

        const extStr = (item.originalName || item.filename).split('.').pop().toUpperCase();
        const isPermanentlySaved = !item.isTemporary || item.userSaved;
        const tempBannerMsg = isAutoClearOn ? 'Temp' : 'Unsaved Temp';
        const tempClass = !isPermanentlySaved ? ' is-temporary-item' : '';

        return `
          <div class="feed-item type-file${isNewClass}${tempClass}" id="item-${item.id}">
            <button class="card-top-close-btn clear-card-btn" data-id="${item.id}" title="Clear card from feed">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div class="item-header">
              <div class="item-badge-wrap">
                <span class="item-type-badge file">
                  ${fileIconSvg}
                  ${badgeLabel}
                </span>
              </div>
              ${item.fileDeletedOnDisk ? `
                <span class="file-deleted-banner" title="File was deleted from saved location on disk">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  Deleted on Disk
                </span>
              ` : (!isPermanentlySaved ? `
                <span class="item-temp-banner" title="File received in temporary mode. Click Save to keep permanently.">
                  ${tempBannerMsg}
                </span>
              ` : `
                <span class="auto-saved-tag" title="File is saved permanently">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  Saved
                </span>
              `)}
            </div>
            <div class="item-body">
              ${item.fileDeletedOnDisk ? `
                <div class="file-deleted-box">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <span>File deleted in saved location. Send or save it again.</span>
                </div>
              ` : `
                <div class="file-card-box">
                  <div class="file-icon-square">
                    ${fileIconSvgLarge}
                  </div>
                  <div class="file-info-col">
                    <div class="file-title-row" title="${escapeAttr(item.originalName || item.filename)}">
                      ${escapeHtml(item.originalName || item.filename)}
                    </div>
                    <div class="file-sub-row">
                      <span class="file-ext-tag">${escapeHtml(extStr)}</span>
                    </div>
                  </div>
                </div>
              `}
            </div>
            <div class="item-actions">
              <div class="action-meta-left" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span class="action-size-badge">${formatSize(item.size || 0)}</span>
              </div>
              <div class="action-btn-group" style="margin-left: auto; display: flex; align-items: center; gap: 6px;">
                <button class="btn btn-secondary btn-icon copy-btn" data-text="${escapeAttr(item.originalName || item.filename)}" title="Copy Name to Clipboard">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 01-2-2h9a2 2 0 012 2v1"/></svg>
                </button>
                ${isPermanentlySaved ? `
                  ${isElectron ? `
                  <button class="btn btn-secondary btn-icon open-folder-btn" data-fn="${escapeAttr(item.filename)}" title="Show in Folder">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                  </button>` : ''}
                ` : `
                  <button type="button" data-id="${item.id}" class="btn btn-primary btn-icon save-dl-btn" title="Download & Save Permanently">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </button>
                `}
                <button class="delete-btn" data-id="${item.id}" title="Delete item">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
            </div>
          </div>`;
      }
      return '';
    }).join('');

    // Bind view/edit text modal events
    $$('.view-text-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const item = allItems.find(i => i.id == id);
        if (item && window.openTextEditModal) {
          window.openTextEditModal(item);
        }
      });
    });

    // Bind dynamic copy events
    $$('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(btn.getAttribute('data-text'), btn);
      });
    });

    $$('.copy-img-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const imgSrc = btn.getAttribute('data-src');
        copyImageToClipboard(imgSrc, btn);
      });
    });

    $$('.save-dl-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (!id) return;
        try {
          btn.disabled = true;
          const res = await doFetch('/api/save-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            const item = allItems.find(i => i.id == id);
            if (item) {
              item.isTemporary = false;
              item.userSaved = true;
              if (data.item && data.item.path) item.path = data.item.path;
            }
            renderFeed();
            showToast('Saved permanently to download folder!', 'success');
          } else {
            showToast(data.error || 'Failed to save file', 'error');
            btn.disabled = false;
          }
        } catch (_) {
          showToast('Network error: Failed to save file', 'error');
          btn.disabled = false;
        }
      });
    });



    $$('.lightbox-trigger').forEach(trigger => {
      trigger.addEventListener('click', () => {
        const src = trigger.getAttribute('data-src');
        const name = trigger.getAttribute('data-name');
        if (window.openImageLightbox && src) {
          window.openImageLightbox(src, name);
        } else {
          openLightbox(src);
        }
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



  // ─── Quick Pairing Setup Modal Manager ─────────────────────
  function openSetupModal() {
    const shortcutsModal = $('#shortcutsModal');
    if (!shortcutsModal) return;

    const imgShareToPC = $('#imgShareToPC');
    const imgClipboardToPC = $('#imgClipboardToPC');
    const imgGetPCClipboard = $('#imgGetPCClipboard');
    const imgQuickPairHostQr = $('#imgQuickPairHostQr');

    if (imgShareToPC) {
      imgShareToPC.src = getThemedQrUrl('https://www.icloud.com/shortcuts/bd3ef813f57d435e8e7d3d1823b13ad8');
    }
    if (imgClipboardToPC) {
      imgClipboardToPC.src = getThemedQrUrl('https://www.icloud.com/shortcuts/3e39fa6cad3147019dc905e96994b1e6');
    }
    if (imgGetPCClipboard) {
      imgGetPCClipboard.src = getThemedQrUrl('https://www.icloud.com/shortcuts/1698d917c5a3447abea2fa506d7b1dac');
    }

    if (serverInfo) {
      const infoIPSetup = $('#infoIPSetup');
      const proto = serverInfo.protocol || (serverInfo.https !== false ? 'https' : 'http');
      $$('.infoIPSetupText').forEach(el => el.textContent = `${proto}://${serverInfo.ip}:${serverInfo.port || 3478}/m`);
      $$('.infoPortSetupText').forEach(el => el.textContent = parseInt(serverInfo.port || 3478, 10) + 1);
      $$('.infoShortcutUrlText').forEach(el => el.textContent = `http://${serverInfo.ip}:${parseInt(serverInfo.port || 3478, 10) + 1}`);

      const infoHostDeviceName = $('#infoHostDeviceName');
      if (infoHostDeviceName && serverInfo.deviceName) {
        infoHostDeviceName.textContent = serverInfo.deviceName;
      }
      const quickPairPinCode = $('#quickPairPinCode');
      if (quickPairPinCode) {
        quickPairPinCode.textContent = serverInfo.pinCode || '1405';
      }

      if (imgQuickPairHostQr) {
        const pairUrl = `${proto}://${serverInfo.ip}:${serverInfo.port || 3478}/m`;
        imgQuickPairHostQr.src = getThemedQrUrl(pairUrl);
      }
    }

    // Reset Wizard to Step 1 (QR Code, PIN & Platform Chooser)
    const flowStep1 = $('#flowStep1');
    const flowStepAndroidPWA = $('#flowStepAndroidPWA');
    const flowStepIosPWA = $('#flowStepIosPWA');
    const flowStepIosShortcuts = $('#flowStepIosShortcuts');

    if (flowStep1) flowStep1.style.display = 'flex';
    if (flowStepAndroidPWA) flowStepAndroidPWA.style.display = 'none';
    if (flowStepIosPWA) flowStepIosPWA.style.display = 'none';
    if (flowStepIosShortcuts) flowStepIosShortcuts.style.display = 'none';

    shortcutsModal.style.display = 'flex';
  }

  function setupQuickPairQrModal() {
    const trigger = $('#rightPanelQrContainer');
    const modal = $('#quickPairQrModal');
    const card = $('#quickPairQrCard');
    const btnClose = $('#btnCloseQuickPairQr');
    const enlargedQrImg = $('#enlargedQrImg');
    const enlargedPinDisplay = $('#enlargedPinDisplay');
    const enlargedQrUrlText = $('#enlargedQrUrlText');

    if (!trigger || !modal) return;

    async function openModal() {
      const baseUrl = serverInfo ? serverInfo.url : window.location.origin;
      const urlWithToken = `${baseUrl}/m`;
      if (enlargedQrImg) enlargedQrImg.src = getThemedQrUrl(urlWithToken);
      if (enlargedQrUrlText) enlargedQrUrlText.textContent = `${baseUrl}/m`;
      
      const pinCodeEl = $('#pinDisplayCode');
      if (enlargedPinDisplay && pinCodeEl && pinCodeEl.textContent.trim()) {
        enlargedPinDisplay.textContent = pinCodeEl.textContent.trim();
      } else if (enlargedPinDisplay) {
        try {
          const res = await doFetch('/api/auth/status');
          if (res.ok) {
            const data = await res.json();
            if (data.pin) enlargedPinDisplay.textContent = data.pin;
          }
        } catch (_) {}
      }

      modal.style.display = 'flex';
      requestAnimationFrame(() => {
        modal.style.opacity = '1';
        if (card) card.style.transform = 'translateY(0)';
      });
    }

    function closeModal() {
      modal.style.opacity = '0';
      if (card) card.style.transform = 'translateY(20px)';
      setTimeout(() => {
        modal.style.display = 'none';
      }, 300);
    }

    trigger.addEventListener('click', openModal);
    if (btnClose) btnClose.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display === 'flex') closeModal();
    });
  }

  function openSettingsModal() {
    switchDesktopTab('settings');
  }

  function switchDesktopTab(tabName) {
    $$('.sidebar-nav-item').forEach(t => {
      if (t.getAttribute('data-tab') === tabName) {
        t.classList.add('active');
      } else {
        t.classList.remove('active');
      }
    });

    $$('.tab').forEach(t => {
      if (t.getAttribute('data-tab') === tabName) {
        t.classList.add('active');
      } else {
        t.classList.remove('active');
      }
    });

    $$('.tab-content').forEach(c => c.classList.remove('active'));

    const contentId = `tab-${tabName === 'settings' ? 'settings-view' : tabName}`;
    const content = $(`#${contentId}`);
    if (content) content.classList.add('active');

    if (tabName === 'send') {
      fetchPending();
    } else if (tabName === 'share') {
      initRelayWebSocket();
    } else if (tabName === 'dashboard') {
      renderDashboardRecentActivity();
    } else if (tabName === 'files') {
      renderFilesTab();
    } else if (tabName === 'devices') {
      renderPairedDevicesTab();
    } else if (tabName === 'clipboard') {
      renderClipboardVaultTab();
    } else if (tabName === 'remote') {
      renderRemoteStudioTab();
    }
  }

  async function renderPairedDevicesTab() {
    const container = $('#devicesTabContainer');
    const badge = $('#devicesCountBadge');
    if (!container) return;

    try {
      const [pairedRes, activeRes] = await Promise.all([
        doFetch('/api/auth/paired-devices').catch(() => null),
        doFetch('/api/auth/devices').catch(() => null)
      ]);

      let pairedList = [];
      if (pairedRes && pairedRes.ok) {
        const pData = await pairedRes.json();
        if (Array.isArray(pData.devices)) pairedList = pData.devices;
      }

      let activeList = [];
      if (activeRes && activeRes.ok) {
        const aData = await activeRes.json();
        if (Array.isArray(aData.devices)) activeList = aData.devices;
      }

      // Merge active devices with paired devices
      const mergedMap = new Map();

      // 1. Process all paired devices
      pairedList.forEach(dev => {
        let name = dev.deviceName || dev.name || dev.platform || 'iPhone';
        if (name.toLowerCase().includes('authorized') || name.toLowerCase().includes('connected') || name.toLowerCase().includes('device')) {
          name = 'iPhone';
        }
        const ip = dev.ip || 'Wi-Fi Client';
        const key = (ip && ip !== 'Wi-Fi Client') ? ip : (dev.token || name);

        // Check if device is actively online in activeList
        const activeMatch = activeList.find(a => 
          (a.ip && a.ip !== 'Wi-Fi Client' && a.ip === dev.ip) ||
          (a.token && a.token === dev.token) ||
          (a.deviceName && a.deviceName === dev.deviceName)
        );

        const isActive = !!activeMatch;
        const service = activeMatch ? (activeMatch.service || 'WebRTC') : (dev.service || 'PWA');
        const lastSeen = (activeMatch && activeMatch.lastSeen) ? activeMatch.lastSeen : (dev.lastSeen || dev.pairedAt);

        mergedMap.set(key, {
          ...dev,
          deviceName: name,
          ip,
          isActive,
          isPaired: true,
          service,
          pairedAt: dev.pairedAt,
          lastSeen
        });
      });

      // 2. Process all actively connected devices (even if not yet permanently paired)
      activeList.forEach(dev => {
        let name = dev.deviceName || dev.platform || 'iPhone';
        if (name.toLowerCase().includes('authorized') || name.toLowerCase().includes('connected') || name.toLowerCase().includes('device')) {
          name = 'iPhone';
        }
        const ip = dev.ip || 'Wi-Fi Client';
        const key = (ip && ip !== 'Wi-Fi Client') ? ip : (dev.token || name);

        if (mergedMap.has(key)) {
          const existing = mergedMap.get(key);
          existing.isActive = true;
          existing.lastSeen = dev.lastSeen || new Date().toISOString();
          if (dev.service === 'WebRTC' || dev.service === 'WebRTC Direct') existing.service = 'WebRTC';
          if (dev.deviceName && !dev.deviceName.includes('Client')) existing.deviceName = dev.deviceName;
        } else {
          mergedMap.set(key, {
            ...dev,
            deviceName: name,
            ip,
            isActive: true,
            isPaired: false,
            service: (dev.service === 'WebRTC Direct' || dev.service === 'WebRTC') ? 'WebRTC' : 'PWA',
            pairedAt: dev.pairedAt || null,
            lastSeen: dev.lastSeen || new Date().toISOString()
          });
        }
      });

      const allDevices = Array.from(mergedMap.values());
      // Sort: Active devices on top, then newest
      allDevices.sort((a, b) => {
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        return (new Date(b.pairedAt || 0).getTime() - new Date(a.pairedAt || 0).getTime());
      });

      const activeCount = allDevices.filter(d => d.isActive).length;

      if (badge) {
        badge.textContent = activeCount > 0 ? `${activeCount} Active` : `${allDevices.length}`;
        badge.style.display = allDevices.length > 0 ? 'inline-block' : 'none';
      }

      if (allDevices.length === 0) {
        container.innerHTML = `
          <div class="empty-state" style="background: rgba(255,255,255,0.02); border: 1px dashed var(--glass-border); border-radius: 16px; padding: 40px 20px; text-align: center;">
            <div class="empty-icon" style="margin-bottom: 12px; color: #a0a0b8;">
              <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
            </div>
            <h3 style="margin: 0 0 6px 0; font-size: 1.05rem; font-weight: 700; color: #ffffff;">No Active or Authorized Devices</h3>
            <p style="margin: 0 0 16px 0; font-size: 0.8rem; color: #a0a0b8; max-width: 360px; margin-left: auto; margin-right: auto;">Open AiroDrop on your phone to connect and authorize instantly.</p>
            <button id="btnOpenSetupQrFromDevices" class="btn btn-primary" style="padding: 8px 18px; font-size: 0.8rem; font-weight: 700; background: #ff5500; border: none; border-radius: 10px; cursor: pointer;">
              Show Setup QR Code
            </button>
          </div>
        `;

        const btnQr = $('#btnOpenSetupQrFromDevices');
        if (btnQr) btnQr.addEventListener('click', () => openSetupModal());
        return;
      }

      let html = '';
      allDevices.forEach(dev => {
        const name = dev.deviceName || 'iPhone';
        const ip = dev.ip || 'Wi-Fi Client';
        const isWebRTC = dev.service === 'WebRTC' || dev.service === 'WebRTC Direct';
        const isActive = !!dev.isActive;
        const isPaired = !!dev.isPaired;

        let iconBg = isActive 
          ? (isWebRTC ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.06))' : 'linear-gradient(135deg, rgba(0, 170, 255, 0.2), rgba(0, 170, 255, 0.06))')
          : 'rgba(255, 255, 255, 0.04)';
        let iconBorder = isActive
          ? (isWebRTC ? 'rgba(34, 197, 94, 0.4)' : 'rgba(0, 170, 255, 0.4)')
          : 'rgba(255, 255, 255, 0.1)';
        let iconColor = isActive
          ? (isWebRTC ? '#4ade80' : '#38bdf8')
          : '#a0a0b8';

        let badgeLabel = '';
        let badgeStyle = '';
        let dotColor = '';
        let dotGlow = '';

        if (isActive) {
          badgeLabel = isWebRTC ? 'Active • WebRTC' : 'Active • PWA';
          badgeStyle = isWebRTC 
            ? 'background: rgba(34, 197, 94, 0.14); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.35);'
            : 'background: rgba(0, 170, 255, 0.14); color: #38bdf8; border: 1px solid rgba(0, 170, 255, 0.35);';
          dotColor = isWebRTC ? '#4ade80' : '#38bdf8';
          dotGlow = isWebRTC ? 'box-shadow: 0 0 8px rgba(74, 222, 128, 0.7);' : 'box-shadow: 0 0 8px rgba(56, 189, 248, 0.7);';
        } else {
          badgeLabel = 'Saved • Offline';
          badgeStyle = 'background: rgba(255, 255, 255, 0.04); color: #8a8a9e; border: 1px solid rgba(255, 255, 255, 0.1);';
          dotColor = '#71717a';
          dotGlow = 'none';
        }

        let timeAgoStr = '';
        if (isActive) {
          timeAgoStr = '<span style="color: #4ade80; font-weight: 600;">Active now</span>';
        } else {
          const timestamp = dev.lastSeen || dev.pairedAt;
          if (timestamp) {
            timeAgoStr = `Last active ${escapeHtml(formatTimeAgo(timestamp))}`;
          } else {
            timeAgoStr = 'Offline';
          }
        }

        html += `
          <div class="paired-device-card" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-radius: 14px; background: rgba(255,255,255,0.025); border: 1px solid ${isActive ? 'rgba(255, 106, 0, 0.25)' : 'var(--glass-border)'}; box-shadow: 0 4px 16px rgba(0,0,0,0.2); transition: all 0.2s ease; gap: 14px; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1 1 280px;">
              <div style="width: 44px; height: 44px; border-radius: 12px; background: ${iconBg}; border: 1px solid ${iconBorder}; display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: ${iconColor};">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
              </div>
              <div style="display: flex; flex-direction: column; min-width: 0; gap: 4px;">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <span style="font-size: 0.92rem; font-weight: 700; color: #ffffff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: -0.2px;">${escapeHtml(name)}</span>
                  <div style="display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 20px; ${badgeStyle} flex-shrink: 0;">
                    <span style="width: 6px; height: 6px; border-radius: 50%; background: ${dotColor}; ${dotGlow}"></span>
                    <span style="font-size: 0.68rem; font-weight: 700; font-family: var(--font-mono, monospace);">${badgeLabel}</span>
                  </div>
                </div>
                <div style="display: flex; align-items: center; gap: 10px; font-size: 0.73rem; color: #a0a0b8; flex-wrap: wrap;">
                  <span style="font-family: var(--font-mono, monospace); color: #cbd5e1;">IP: ${escapeHtml(ip)}</span>
                  <span>•</span>
                  <span>Protocol: <strong style="color: ${isActive ? '#ffffff' : '#a0a0b8'};">${isActive ? (isWebRTC ? 'WebRTC Direct' : 'PWA Sync') : 'Offline'}</strong></span>
                  <span>•</span>
                  <span>${timeAgoStr}</span>
                </div>
              </div>
            </div>

          </div>
        `;
      });

      container.innerHTML = html;
    } catch (e) {
      console.warn('Error fetching paired devices:', e);
    }
  }

  let currentFilesTabSubPath = '';
  let currentFilesViewMode = (typeof localStorage !== 'undefined' && localStorage.getItem('airodrop_files_view_mode')) || 'list';

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return (i === 0 ? val : val.toFixed(1)) + ' ' + units[i];
  }

  function formatTimeAgo(date) {
    if (!date) return 'just now';
    const now = new Date();
    const d = (date instanceof Date) ? date : new Date(date);
    if (isNaN(d.getTime())) return 'just now';
    const diffSec = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
    if (diffSec < 45) return 'just now';
    if (diffSec < 90) return '1 min ago';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} mins ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return '1 day ago';
    if (diffDays < 7) return `${diffDays} days ago`;
    const diffWeeks = Math.floor(diffDays / 7);
    if (diffWeeks === 1) return '1 week ago';
    if (diffWeeks < 5) return `${diffWeeks} weeks ago`;
    return `${diffDays} days ago`;
  }

  async function renderFilesTab(subPath) {
    if (subPath !== undefined && subPath !== null) {
      currentFilesTabSubPath = subPath;
    }
    const container = $('#filesTabListContainer');
    const breadcrumb = $('#filesTabBreadcrumb');
    const btnUp = $('#btnFilesTabUp');
    const btnList = $('#btnFilesViewList');
    const btnGrid = $('#btnFilesViewGrid');
    if (!container) return;

    // Update view mode toggle active classes
    if (btnList && btnGrid) {
      if (currentFilesViewMode === 'grid') {
        btnGrid.classList.add('active');
        btnList.classList.remove('active');
        btnGrid.style.background = 'rgba(255, 106, 0, 0.25)';
        btnGrid.style.color = '#ff6a00';
        btnList.style.background = 'transparent';
        btnList.style.color = '#a0a0b8';
      } else {
        btnList.classList.add('active');
        btnGrid.classList.remove('active');
        btnList.style.background = 'rgba(255, 106, 0, 0.25)';
        btnList.style.color = '#ff6a00';
        btnGrid.style.background = 'transparent';
        btnGrid.style.color = '#a0a0b8';
      }

      btnList.onclick = () => {
        if (currentFilesViewMode !== 'list') {
          currentFilesViewMode = 'list';
          try { localStorage.setItem('airodrop_files_view_mode', 'list'); } catch (_) {}
          renderFilesTab();
        }
      };

      btnGrid.onclick = () => {
        if (currentFilesViewMode !== 'grid') {
          currentFilesViewMode = 'grid';
          try { localStorage.setItem('airodrop_files_view_mode', 'grid'); } catch (_) {}
          renderFilesTab();
        }
      };
    }

    let rootPath = 'Shared Directory';
    try {
      const sRes = await doFetch('/api/settings');
      if (sRes && sRes.ok) {
        const sData = await sRes.json();
        rootPath = sData.shareDir || sData.saveDir || 'Shared Directory';
      }
    } catch (e) {
      console.warn('Error fetching settings for files tab:', e);
    }

    const currentFullPath = currentFilesTabSubPath
      ? `${rootPath}\\${currentFilesTabSubPath.replace(/\//g, '\\')}`
      : rootPath;

    // Copy Path Button handler
    const btnCopyPath = $('#btnCopySharedPath');
    if (btnCopyPath) {
      btnCopyPath.onclick = () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(currentFullPath).then(() => {
            showToast('Shared folder path copied to clipboard!', 'success');
          }).catch(() => {
            showToast(`Path: ${currentFullPath}`, 'info');
          });
        } else {
          showToast(`Path: ${currentFullPath}`, 'info');
        }
      };
    }

    // Render Redesigned Cyber-Glassmorphic Path Bar with FULL visible path
    if (breadcrumb) {
      const subParts = currentFilesTabSubPath ? currentFilesTabSubPath.split('/').filter(Boolean) : [];
      let bHtml = '';

      if (subParts.length === 0) {
        // At Root: display full root path so user sees the complete location
        bHtml = `<span class="cyber-path-pill active" data-path="" title="${escapeAttr(rootPath)}">${escapeHtml(rootPath)}</span>`;
      } else {
        // In subfolder: full root path pill + subfolder pills
        bHtml = `<span class="cyber-path-pill" data-path="" title="${escapeAttr(rootPath)}">${escapeHtml(rootPath)}</span>`;
        let runningSub = '';
        subParts.forEach((part, idx) => {
          runningSub += (runningSub ? '/' : '') + part;
          const isLast = idx === subParts.length - 1;
          bHtml += `<span class="cyber-path-divider">\\</span>`;
          if (isLast) {
            bHtml += `<span class="cyber-path-pill active" data-path="${escapeAttr(runningSub)}">${escapeHtml(part)}</span>`;
          } else {
            bHtml += `<span class="cyber-path-pill" data-path="${escapeAttr(runningSub)}">${escapeHtml(part)}</span>`;
          }
        });
      }

      breadcrumb.innerHTML = bHtml;

      $$('.cyber-path-pill', breadcrumb).forEach(el => {
        el.addEventListener('click', () => {
          renderFilesTab(el.getAttribute('data-path') || '');
        });
      });
    }

    if (btnUp) {
      if (currentFilesTabSubPath) {
        btnUp.style.display = 'inline-flex';
        const parts = currentFilesTabSubPath.split('/').filter(Boolean);
        parts.pop();
        const parentPath = parts.join('/');
        btnUp.onclick = () => renderFilesTab(parentPath);
      } else {
        btnUp.style.display = 'none';
      }
    }

    try {
      let entries = [];
      const queryParam = currentFilesTabSubPath ? '?path=' + encodeURIComponent(currentFilesTabSubPath) : '';
      let bRes = await doFetch(`/api/files/browse${queryParam}`);
      if (!bRes || !bRes.ok) {
        bRes = await doFetch(`/files/browse${queryParam}`);
      }

      if (bRes && bRes.ok) {
        const bData = await bRes.json();
        if (Array.isArray(bData.entries)) {
          entries = bData.entries;
        } else if (Array.isArray(bData.files)) {
          entries = bData.files;
        }
      } else {
        let errText = 'Unknown error';
        try {
          if (bRes) {
            const errData = await bRes.clone().json().catch(() => null);
            errText = (errData && errData.error) ? errData.error : `HTTP ${bRes.status}`;
          }
        } catch (_) {}
        container.className = 'file-list-view';
        container.innerHTML = `
          <div style="text-align: center; padding: 24px 16px; background: rgba(239,68,68,0.08); border: 1px dashed rgba(239,68,68,0.4); border-radius: 14px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <div style="font-size: 0.88rem; color: #ef4444; font-weight: 700;">Failed to load files</div>
            <div style="font-size: 0.76rem; color: #a0a0b8; margin-top: 6px; font-family: monospace;">${escapeHtml(errText)}</div>
          </div>
        `;
        return;
      }

      if (!currentFilesTabSubPath) {
        try {
          const hRes = await doFetch('/api/history');
          if (hRes && hRes.ok) {
            const hData = await hRes.json();
            const items = hData.items || hData.history || [];
            items.forEach(item => {
              const fn = item.filename || (item.type === 'file' || item.type === 'image' ? item.name : null);
              if (fn && !entries.some(e => e.name === fn)) {
                entries.push({ name: fn, type: 'file', size: item.size || 0, mtime: item.timestamp });
              }
            });
          }
        } catch (_) {}
      }

      // ─── Recent Additions Shelf ──────────────────────────────
      const recentsSection = $('#filesRecentsSection');
      const recentsShelf = $('#filesRecentsShelf');
      const searchInput = $('#fileSearchInput');
      const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

      if (recentsSection && recentsShelf) {
        if (!searchTerm && entries.length > 0) {
          let dismissedRecents = [];
          try {
            dismissedRecents = JSON.parse(localStorage.getItem('airodrop_dismissed_recents') || '[]');
            if (!Array.isArray(dismissedRecents)) dismissedRecents = [];
          } catch (_) {
            dismissedRecents = [];
          }

          const fileOnlyEntries = entries.filter(e => {
            if (e.type !== 'file') return false;
            const rel = currentFilesTabSubPath ? `${currentFilesTabSubPath}/${e.name}` : e.name;
            return !dismissedRecents.includes(rel) && !dismissedRecents.includes(e.name);
          });
          // Sort newest files first
          fileOnlyEntries.sort((a, b) => new Date(b.mtime || 0).getTime() - new Date(a.mtime || 0).getTime());
          const recentTop = fileOnlyEntries.slice(0, 5);

          if (recentTop.length > 0) {
            let rHtml = '';
            recentTop.forEach(rItem => {
              const rName = rItem.name || 'File';
              const rExt = rName.split('.').pop().toLowerCase();
              const rRelPath = currentFilesTabSubPath ? `${currentFilesTabSubPath}/${rName}` : rName;
              const rDownloadUrl = `/api/files/download?path=${encodeURIComponent(rRelPath)}`;
              
              let rIconBg = 'rgba(59, 130, 246, 0.15)';
              let rIconBorder = 'rgba(59, 130, 246, 0.4)';
              let rIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`;
              let rMediaType = 'file';

              if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(rExt)) {
                rIconBg = 'rgba(34, 197, 94, 0.15)';
                rIconBorder = 'rgba(34, 197, 94, 0.4)';
                rIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
                rMediaType = 'image';
              } else if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(rExt)) {
                rIconBg = 'rgba(168, 85, 247, 0.15)';
                rIconBorder = 'rgba(168, 85, 247, 0.4)';
                rIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
                rMediaType = 'video';
              } else if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(rExt)) {
                rIconBg = 'rgba(236, 72, 153, 0.15)';
                rIconBorder = 'rgba(236, 72, 153, 0.4)';
                rIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
                rMediaType = 'audio';
              } else if (['pdf'].includes(rExt)) {
                rIconBg = 'rgba(239, 68, 68, 0.15)';
                rIconBorder = 'rgba(239, 68, 68, 0.4)';
                rIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
                rMediaType = 'pdf';
              }

              const rSize = formatFileSize(rItem.size);
              const rArrivalTag = rItem.mtime ? formatTimeAgo(rItem.mtime) : 'Just now';
              const rFullDateStr = rItem.mtime ? new Date(rItem.mtime).toLocaleString() : '';

              const isPlayable = rMediaType === 'video' || rMediaType === 'audio';
              const rPreviewBtnText = isPlayable ? 'Play' : 'Preview';
              const rPreviewBtnIcon = isPlayable 
                ? `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
                : `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

              let rIconMarkup = '';
              if (rMediaType === 'image') {
                const thumbUrl = resolveMediaUrl(rDownloadUrl);
                rIconMarkup = `
                  <div class="recent-file-icon file-grid-icon-wrap has-thumb" style="width: 100%; height: 74px; border-radius: 10px; overflow: hidden; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.18); box-shadow: 0 4px 14px rgba(0,0,0,0.35); position: relative; margin-bottom: 6px;">
                    <img src="${thumbUrl}" alt="${escapeAttr(rName)}" loading="lazy" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit; display: block;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                    <div style="display: none; width: 100%; height: 100%; align-items: center; justify-content: center; background: ${rIconBg}; border: 1px solid ${rIconBorder};">
                      ${rIconSvg}
                    </div>
                  </div>
                `;
              } else {
                rIconMarkup = `
                  <div class="recent-file-icon file-grid-icon-wrap non-thumb" style="background: ${rIconBg}; border: 1px solid ${rIconBorder}; margin-bottom: 6px;">
                    ${rIconSvg}
                  </div>
                `;
              }

              rHtml += `
                <div class="recent-file-card file-grid-card btn-preview-action" data-relpath="${escapeAttr(rRelPath)}" data-mediatype="${rMediaType}" data-downloadurl="${escapeAttr(rDownloadUrl)}" title="Play / Preview ${escapeAttr(rName)}">
                  <button class="btn-recent-clear-card" data-relpath="${escapeAttr(rRelPath)}" title="Clear card from Recents (file remains on disk)">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                  ${rIconMarkup}
                  <div class="recent-file-name file-grid-name">${escapeHtml(rName)}</div>
                  <div class="recent-file-meta file-grid-meta">
                    <span>${rSize}</span>
                    <span class="recent-meta-divider">•</span>
                    <span class="recent-card-arrival-tag" title="Arrived: ${escapeAttr(rFullDateStr)}">
                      <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      <span>${escapeHtml(rArrivalTag)}</span>
                    </span>
                  </div>
                  <div class="recent-file-actions" style="width: 100%; margin-top: 5px;" onclick="event.stopPropagation()">
                    <button class="btn-file-preview btn-preview-action" data-relpath="${escapeAttr(rRelPath)}" data-mediatype="${rMediaType}" style="width: 100%; justify-content: center; padding: 4px 8px; font-size: 0.72rem;">
                      ${rPreviewBtnIcon} <span>${rPreviewBtnText}</span>
                    </button>
                  </div>
                </div>
              `;
            });
            recentsShelf.innerHTML = rHtml;
            recentsSection.style.display = 'flex';

            // Bind clear dismiss button on recents cards
            $$('.btn-recent-clear-card', recentsShelf).forEach(btn => {
              btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const relPath = btn.getAttribute('data-relpath');
                if (!relPath) return;

                let list = [];
                try {
                  list = JSON.parse(localStorage.getItem('airodrop_dismissed_recents') || '[]');
                  if (!Array.isArray(list)) list = [];
                } catch (_) {
                  list = [];
                }

                if (!list.includes(relPath)) {
                  list.push(relPath);
                  if (list.length > 200) list = list.slice(-200);
                  try {
                    localStorage.setItem('airodrop_dismissed_recents', JSON.stringify(list));
                  } catch (_) {}
                }

                const card = btn.closest('.recent-file-card');
                if (card) {
                  card.style.transform = 'scale(0.85)';
                  card.style.opacity = '0';
                  card.style.pointerEvents = 'none';
                  card.style.transition = 'all 0.2s ease';
                }

                showToast('Cleared card from Recents', 'info');
                setTimeout(() => {
                  renderFilesTab();
                }, 220);
              });
            });

            // Collapsible dropdown toggle handler for Recents
            const btnToggleRecents = $('#btnToggleRecents');
            if (btnToggleRecents && !btnToggleRecents._bound) {
              btnToggleRecents._bound = true;
              try {
                if (localStorage.getItem('airodrop_recents_collapsed') === '1') {
                  recentsSection.classList.add('collapsed');
                }
              } catch (_) {}
              btnToggleRecents.addEventListener('click', (e) => {
                e.preventDefault();
                recentsSection.classList.toggle('collapsed');
                const isCollapsed = recentsSection.classList.contains('collapsed');
                try {
                  localStorage.setItem('airodrop_recents_collapsed', isCollapsed ? '1' : '0');
                } catch (_) {}
              });
            }

            // Bind click on recents cards
            $$('.recent-file-card', recentsShelf).forEach(card => {
              card.addEventListener('click', (e) => {
                if (e.target.closest('.btn-recent-clear-card')) return;
                const relPath = card.getAttribute('data-relpath');
                const mediatype = card.getAttribute('data-mediatype') || 'file';
                const downloadUrl = card.getAttribute('data-downloadurl') || `/api/files/download?path=${encodeURIComponent(relPath)}`;
                const fileName = relPath ? relPath.split('/').pop() : 'File';

                if (mediatype === 'image' || mediatype === 'video' || mediatype === 'audio' || mediatype === 'pdf') {
                  if (typeof window.openMediaPreview === 'function') {
                    window.openMediaPreview(downloadUrl, fileName, mediatype);
                    return;
                  }
                }
                if (isElectron && ipcRenderer) {
                  ipcRenderer.send('open-file', relPath);
                } else {
                  window.open(downloadUrl, '_blank');
                }
              });
            });
          } else {
            recentsSection.style.display = 'none';
          }
        } else {
          recentsSection.style.display = 'none';
        }
      }

      // Filter search
      if (searchTerm) {
        entries = entries.filter(item => (item.name || '').toLowerCase().includes(searchTerm));
      }

      // ─── Sort Entries: Folders First, then Newest Files Top ───
      entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        if (a.type === 'dir' && b.type === 'dir') return (a.name || '').localeCompare(b.name || '');
        // For files: sort newest modified first
        return new Date(b.mtime || 0).getTime() - new Date(a.mtime || 0).getTime();
      });

      const subParts = currentFilesTabSubPath ? currentFilesTabSubPath.split('/').filter(Boolean) : [];
      const parentSubParts = [...subParts];
      parentSubParts.pop();
      const parentPath = parentSubParts.join('/');

      if (entries.length === 0) {
        container.className = 'file-list-view';
        let emptyHtml = '';
        if (currentFilesTabSubPath && !searchTerm) {
          emptyHtml += `
            <div class="file-list-card dir-item btn-back-parent" data-relpath="${escapeAttr(parentPath)}" title="Go back to parent directory (..) ">
              <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
                <div style="width: 40px; height: 40px; border-radius: 10px; background: rgba(255, 106, 0, 0.12); border: 1px solid rgba(255, 106, 0, 0.35); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6a00" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
                </div>
                <div style="display: flex; flex-direction: column; min-width: 0;">
                  <span style="font-size: 0.88rem; font-weight: 700; color: #ff8533;">← Back to Parent Folder</span>
                  <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px; font-size: 0.72rem; color: #a0a0b8; font-family: monospace;">
                    <span>.. (Up Directory)</span>
                  </div>
                </div>
              </div>
              <div style="display: flex; gap: 8px;" onclick="event.stopPropagation()">
                <button class="btn btn-secondary btn-open-dir" data-relpath="${escapeAttr(parentPath)}" style="padding: 6px 14px; font-size: 0.76rem; font-weight: 700; cursor: pointer; color: #ff8533;">← Go Back</button>
              </div>
            </div>
          `;
        }
        emptyHtml += `
          <div style="text-align: center; padding: 36px 16px; background: rgba(12,13,18,0.4); border: 1px dashed var(--glass-border); border-radius: 14px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#a0a0b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <div style="font-size: 0.88rem; color: #ffffff; font-weight: 700;">Folder is Empty</div>
            <div style="font-size: 0.76rem; color: #a0a0b8; margin-top: 4px;">No files or subdirectories found in this folder</div>
          </div>
        `;
        container.innerHTML = emptyHtml;
        $$('.dir-item', container).forEach(item => {
          item.addEventListener('click', () => {
            const relPath = item.getAttribute('data-relpath');
            renderFilesTab(relPath || '');
          });
        });
        $$('.btn-open-dir', container).forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const relPath = btn.getAttribute('data-relpath');
            renderFilesTab(relPath || '');
          });
        });
        return;
      }

      const isGrid = currentFilesViewMode === 'grid';
      container.className = isGrid ? 'file-grid-view' : 'file-list-view';

      let html = '';

      // Dedicated Easy-Access Back Card at Index 0 inside File Explorer
      if (currentFilesTabSubPath && !searchTerm) {
        if (isGrid) {
          html += `
            <div class="file-grid-card dir-item btn-back-parent" data-relpath="${escapeAttr(parentPath)}" title="Go back to parent directory (..) ">
              <div class="file-grid-icon-wrap" style="background: rgba(255, 106, 0, 0.12); border: 1px solid rgba(255, 106, 0, 0.35);">
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ff6a00" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
              </div>
              <div class="file-grid-name" style="color: #ff8533;">← Back to Parent</div>
              <div class="file-grid-meta"><span>.. (Up Directory)</span></div>
              <div class="file-grid-actions" onclick="event.stopPropagation()">
                <button class="btn btn-secondary btn-open-dir" data-relpath="${escapeAttr(parentPath)}" style="padding: 5px 12px; font-size: 0.74rem; font-weight: 700; width: 100%; color: #ff8533;">← Go Back</button>
              </div>
            </div>
          `;
        } else {
          html += `
            <div class="file-list-card dir-item btn-back-parent" data-relpath="${escapeAttr(parentPath)}" title="Go back to parent directory (..) ">
              <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
                <div style="width: 40px; height: 40px; border-radius: 10px; background: rgba(255, 106, 0, 0.12); border: 1px solid rgba(255, 106, 0, 0.35); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6a00" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
                </div>
                <div style="display: flex; flex-direction: column; min-width: 0;">
                  <span style="font-size: 0.88rem; font-weight: 700; color: #ff8533;">← Back to Parent Folder</span>
                  <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px; font-size: 0.72rem; color: #a0a0b8; font-family: monospace;">
                    <span>.. (Up Directory)</span>
                  </div>
                </div>
              </div>
              <div style="display: flex; gap: 8px;" onclick="event.stopPropagation()">
                <button class="btn btn-secondary btn-open-dir" data-relpath="${escapeAttr(parentPath)}" style="padding: 6px 14px; font-size: 0.76rem; font-weight: 700; cursor: pointer; color: #ff8533;">← Go Back</button>
              </div>
            </div>
          `;
        }
      }
      entries.forEach(entry => {
        const isDir = entry.type === 'dir';
        const name = entry.name || 'File';
        const sizeFormatted = isDir ? 'Folder' : (entry.size ? formatFileSize(entry.size) : '0 B');
        const mtimeFormatted = entry.mtime ? new Date(entry.mtime).toLocaleDateString() : '';
        const itemRelPath = currentFilesTabSubPath ? `${currentFilesTabSubPath}/${name}` : name;
        const downloadUrl = `/api/files/download?path=${encodeURIComponent(itemRelPath)}`;

        let iconSvg = isDir 
          ? `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ff6a00" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
          : `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`;
        let iconBg = isDir ? 'rgba(255, 106, 0, 0.12)' : 'rgba(59, 130, 246, 0.12)';
        let iconBorder = isDir ? 'rgba(255, 106, 0, 0.3)' : 'rgba(59, 130, 246, 0.3)';
        let mediaTypeHint = 'file';

        if (!isDir) {
          const ext = name.split('.').pop().toLowerCase();
          if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(ext)) {
            iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
            iconBg = 'rgba(34, 197, 94, 0.12)';
            iconBorder = 'rgba(34, 197, 94, 0.3)';
            mediaTypeHint = 'image';
          } else if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext)) {
            iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
            iconBg = 'rgba(168, 85, 247, 0.12)';
            iconBorder = 'rgba(168, 85, 247, 0.3)';
            mediaTypeHint = 'video';
          } else if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) {
            iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
            iconBg = 'rgba(236, 72, 153, 0.12)';
            iconBorder = 'rgba(236, 72, 153, 0.3)';
            mediaTypeHint = 'audio';
          } else if (['pdf'].includes(ext)) {
            iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
            iconBg = 'rgba(239, 68, 68, 0.12)';
            iconBorder = 'rgba(239, 68, 68, 0.3)';
            mediaTypeHint = 'pdf';
          } else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
            iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;
            iconBg = 'rgba(234, 179, 8, 0.12)';
            iconBorder = 'rgba(234, 179, 8, 0.3)';
          }
        }

        const isPlayable = mediaTypeHint === 'video' || mediaTypeHint === 'audio';
        const previewBtnText = isPlayable ? 'Play' : 'Preview';
        const previewBtnIcon = isPlayable 
          ? `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
          : `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

        if (isGrid) {
          html += `
            <div class="file-grid-card ${isDir ? 'dir-item' : 'file-item'}" data-relpath="${escapeAttr(itemRelPath)}" data-isdir="${isDir}" data-mediatype="${mediaTypeHint}" data-downloadurl="${escapeAttr(downloadUrl)}" title="${escapeAttr(name)} (Click to view)">
              <div class="file-grid-icon-wrap" style="background: ${iconBg}; border: 1px solid ${iconBorder};">
                ${iconSvg}
              </div>
              <div class="file-grid-name">${escapeHtml(name)}</div>
              <div class="file-grid-meta">
                <span>${sizeFormatted}</span>${mtimeFormatted ? ` • <span>${mtimeFormatted}</span>` : ''}
              </div>
              <div class="file-grid-actions" onclick="event.stopPropagation()">
                ${isDir 
                  ? `<button class="btn btn-secondary btn-open-dir" data-relpath="${escapeAttr(itemRelPath)}" style="padding: 5px 12px; font-size: 0.74rem; font-weight: 600; width: 100%;">Open Folder</button>` 
                  : `<div style="display: flex; gap: 6px; width: 100%;">
                       <button class="btn-file-preview btn-preview-action" data-relpath="${escapeAttr(itemRelPath)}" data-mediatype="${mediaTypeHint}" style="flex: 1; justify-content: center; padding: 5px 8px; font-size: 0.72rem;">${previewBtnIcon} <span>${previewBtnText}</span></button>
                       <button class="btn btn-secondary open-folder-btn" data-relpath="${escapeAttr(itemRelPath)}" style="flex: 1; justify-content: center; padding: 5px 8px; font-size: 0.72rem;">Location</button>
                     </div>`
                }
              </div>
            </div>
          `;
        } else {
          html += `
            <div class="file-list-card ${isDir ? 'dir-item' : 'file-item'}" data-relpath="${escapeAttr(itemRelPath)}" data-isdir="${isDir}" data-mediatype="${mediaTypeHint}" data-downloadurl="${escapeAttr(downloadUrl)}" title="${escapeAttr(name)} (Click to view)">
              <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
                <div style="width: 40px; height: 40px; border-radius: 10px; background: ${iconBg}; border: 1px solid ${iconBorder}; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                  ${iconSvg}
                </div>
                <div style="display: flex; flex-direction: column; min-width: 0;">
                  <span style="font-size: 0.88rem; font-weight: 700; color: #ffffff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(name)}</span>
                  <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px; font-size: 0.74rem; color: #a0a0b8; font-family: monospace;">
                    <span>${sizeFormatted}</span>
                    ${mtimeFormatted ? `<span>•</span><span>${mtimeFormatted}</span>` : ''}
                  </div>
                </div>
              </div>
              <div style="display: flex; gap: 8px;" onclick="event.stopPropagation()">
                ${isDir 
                  ? `<button class="btn btn-secondary btn-open-dir" data-relpath="${escapeAttr(itemRelPath)}" style="padding: 6px 12px; font-size: 0.76rem; font-weight: 600; cursor: pointer;">Open Folder</button>` 
                  : `<button class="btn-file-preview btn-preview-action" data-relpath="${escapeAttr(itemRelPath)}" data-mediatype="${mediaTypeHint}" style="cursor: pointer;">${previewBtnIcon} <span>${previewBtnText}</span></button>
                     <button class="btn btn-secondary open-folder-btn" data-relpath="${escapeAttr(itemRelPath)}" style="padding: 6px 12px; font-size: 0.76rem; font-weight: 600; cursor: pointer;">Show Location</button>`
                }
              </div>
            </div>
          `;
        }
      });
      container.innerHTML = html;

      // Click on Directory item -> navigate into directory
      $$('.dir-item', container).forEach(item => {
        item.addEventListener('click', () => {
          const relPath = item.getAttribute('data-relpath');
          if (relPath !== null && relPath !== undefined) renderFilesTab(relPath);
        });
      });

      // Click on File item -> Click to view file (supports all file types)
      const triggerFileView = (relPath, mediatype) => {
        const downloadUrl = resolveMediaUrl(`/api/files/download?path=${encodeURIComponent(relPath)}`);
        const fileName = relPath ? relPath.split('/').pop() : 'File';

        if (mediatype === 'image' || mediatype === 'video' || mediatype === 'audio' || mediatype === 'pdf') {
          if (typeof window.openMediaPreview === 'function') {
            window.openMediaPreview(downloadUrl, fileName, mediatype);
            return;
          }
        }

        if (isElectron && ipcRenderer) {
          ipcRenderer.send('open-file', relPath);
        } else {
          window.open(downloadUrl, '_blank');
        }
      };

      $$('.file-item', container).forEach(item => {
        item.addEventListener('click', () => {
          const relPath = item.getAttribute('data-relpath');
          const mediatype = item.getAttribute('data-mediatype') || 'file';
          triggerFileView(relPath, mediatype);
        });
      });

      // Button: Play / Preview Action
      $$('.btn-preview-action', container).forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const relPath = btn.getAttribute('data-relpath');
          const mediatype = btn.getAttribute('data-mediatype') || 'file';
          triggerFileView(relPath, mediatype);
        });
      });

      // Button: Open Folder
      $$('.btn-open-dir', container).forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const relPath = btn.getAttribute('data-relpath');
          if (relPath !== null && relPath !== undefined) renderFilesTab(relPath);
        });
      });

      // Button: Show Location in File Explorer (selects the file in Windows Explorer)
      $$('.open-folder-btn', container).forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const relPath = btn.getAttribute('data-relpath') || btn.getAttribute('data-fn');
          if (isElectron && ipcRenderer) {
            ipcRenderer.send('open-file-folder', relPath);
          } else {
            showToast(`Location in shared directory: ${relPath}`, 'info');
          }
        });
      });

    } catch (e) {
      console.warn('Error rendering files tab:', e);
    }
  }

  let clipboardCurrentPage = 1;
  const CLIPBOARD_PAGE_SIZE = 10;
  let activeEditingClipboardId = null;
  let currentClipboardViewMode = 'list';
  try {
    const savedClipMode = localStorage.getItem('airodrop_clipboard_view_mode');
    if (savedClipMode === 'grid' || savedClipMode === 'list') {
      currentClipboardViewMode = savedClipMode;
    }
  } catch (_) {}

  function closeClipboardEditModal() {
    const modal = $('#clipboardEditModal');
    if (modal) modal.style.display = 'none';
    activeEditingClipboardId = null;
  }

  function openClipboardEditModal(item) {
    activeEditingClipboardId = item.id;
    const modal = $('#clipboardEditModal');
    const textarea = $('#clipboardModalTextarea');
    const meta = $('#clipboardModalMeta');
    const stats = $('#clipboardModalStats');

    if (!modal || !textarea) return;

    const contentText = item.content || item.text || '';
    textarea.value = contentText;

    const updateStats = () => {
      const v = textarea.value;
      const cCount = v.length;
      const wCount = v.trim() ? v.trim().split(/\s+/).length : 0;
      if (stats) stats.textContent = `${cCount.toLocaleString()} characters • ${wCount.toLocaleString()} words`;
    };
    updateStats();
    textarea.oninput = updateStats;

    if (meta) {
      const dateStr = item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Recent';
      const isUrl = item.type === 'url' || /^https?:\/\//i.test(contentText.trim());
      meta.textContent = `${isUrl ? 'Web Link' : 'Text Snippet'} • Synced ${dateStr}`;
    }

    modal.style.display = 'flex';
    setTimeout(() => textarea.focus(), 60);
  }

  async function renderClipboardVaultTab() {
    const container = $('#clipboardVaultContainer');
    if (!container) return;

    // Update view mode toggle active classes
    const btnClipList = $('#btnClipboardViewList');
    const btnClipGrid = $('#btnClipboardViewGrid');
    if (btnClipList && btnClipGrid) {
      if (currentClipboardViewMode === 'grid') {
        btnClipGrid.classList.add('active');
        btnClipList.classList.remove('active');
        btnClipGrid.style.background = 'rgba(255, 106, 0, 0.25)';
        btnClipGrid.style.color = '#ff6a00';
        btnClipList.style.background = 'transparent';
        btnClipList.style.color = '#a0a0b8';
      } else {
        btnClipList.classList.add('active');
        btnClipGrid.classList.remove('active');
        btnClipList.style.background = 'rgba(255, 106, 0, 0.25)';
        btnClipList.style.color = '#ff6a00';
        btnClipGrid.style.background = 'transparent';
        btnClipGrid.style.color = '#a0a0b8';
      }

      btnClipList.onclick = () => {
        if (currentClipboardViewMode !== 'list') {
          currentClipboardViewMode = 'list';
          try { localStorage.setItem('airodrop_clipboard_view_mode', 'list'); } catch (_) {}
          renderClipboardVaultTab();
        }
      };

      btnClipGrid.onclick = () => {
        if (currentClipboardViewMode !== 'grid') {
          currentClipboardViewMode = 'grid';
          try { localStorage.setItem('airodrop_clipboard_view_mode', 'grid'); } catch (_) {}
          renderClipboardVaultTab();
        }
      };
    }

    container.className = currentClipboardViewMode === 'grid' ? 'vault-items-container grid-mode' : 'vault-items-container list-mode';

    try {
      let items = [];
      try {
        const res = await doFetch('/api/clipboard/vault');
        if (res && res.ok) {
          const data = await res.json();
          items = data.items || [];
        }
      } catch (_) {}

      // Fallback if vault was empty or legacy endpoint
      if (items.length === 0) {
        try {
          const hRes = await doFetch('/api/history');
          if (hRes && hRes.ok) {
            const hData = await hRes.json();
            const raw = hData.items || hData.history || [];
            items = raw.filter(item => item.type === 'text' || item.type === 'url' || item.content || item.text);
          }
        } catch (_) {}
      }

      // Sort newest first
      items.sort((a, b) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timeB - timeA;
      });

      // Update count badge
      const countBadge = $('#clipboardVaultCountBadge');
      if (countBadge) {
        countBadge.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
      }

      const searchInput = $('#clipboardSearchInput');
      const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
      if (searchTerm) {
        items = items.filter(i => (i.content || i.text || '').toLowerCase().includes(searchTerm));
      }

      const paginationContainer = $('#clipboardPaginationContainer');
      const prevBtn = $('#btnClipboardPrevPage');
      const nextBtn = $('#btnClipboardNextPage');
      const pageIndicator = $('#clipboardPageIndicator');

      if (items.length === 0) {
        container.innerHTML = `
          <div style="text-align: center; padding: 40px 16px; background: rgba(12,13,18,0.4); border: 1px solid var(--glass-border); border-radius: 14px;">
            <div style="width: 48px; height: 48px; border-radius: 12px; background: rgba(255, 106, 0, 0.12); border: 1px solid rgba(255, 106, 0, 0.3); display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; color: #ff6a00;">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
            </div>
            <div style="font-size: 0.9rem; color: #ffffff; font-weight: 700;">${searchTerm ? 'No matching clipboard snippets' : 'Clipboard vault is empty'}</div>
            <div style="font-size: 0.76rem; color: #a0a0b8; margin-top: 4px;">${searchTerm ? 'Try searching for different keywords' : 'Synced text snippets and links from your devices will appear here'}</div>
          </div>
        `;
        if (paginationContainer) paginationContainer.style.display = 'none';
        return;
      }

      // Pagination Calculation (Max 20 items per page)
      const totalPages = Math.max(1, Math.ceil(items.length / CLIPBOARD_PAGE_SIZE));
      if (clipboardCurrentPage > totalPages) clipboardCurrentPage = totalPages;
      if (clipboardCurrentPage < 1) clipboardCurrentPage = 1;

      const startIndex = (clipboardCurrentPage - 1) * CLIPBOARD_PAGE_SIZE;
      const pageItems = items.slice(startIndex, startIndex + CLIPBOARD_PAGE_SIZE);

      let html = '';
      pageItems.forEach(item => {
        const contentText = item.content || item.text || '';
        const isUrl = item.type === 'url' || /^https?:\/\//i.test(contentText.trim());
        const dateObj = item.timestamp ? new Date(item.timestamp) : null;
        const fullDateStr = dateObj ? dateObj.toLocaleString() : 'Recent';
        const timeAgoStr = dateObj ? formatTimeAgo(dateObj) : 'Recent';
        const charCount = contentText.length;
        const wordCount = contentText.trim() ? contentText.trim().split(/\s+/).length : 0;

        html += `
          <div class="vault-card" data-id="${escapeAttr(item.id)}">
            <div class="vault-card-header">
              <div class="vault-card-meta">
                <span class="vault-type-badge ${isUrl ? 'url' : 'text'}">${isUrl ? 'URL' : 'TEXT'}</span>
                <span class="vault-card-time" title="Synced: ${escapeAttr(fullDateStr)}">
                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  ${escapeHtml(timeAgoStr)}
                </span>
              </div>
              <div class="vault-card-stats">
                ${charCount.toLocaleString()} chars • ${wordCount.toLocaleString()} words
              </div>
            </div>

            <div class="vault-card-body btn-open-edit-modal" data-id="${escapeAttr(item.id)}" title="Click to view and edit snippet">${escapeHtml(contentText)}</div>

            <div class="vault-card-actions">
              ${isUrl ? `
                <a href="${escapeHtml(contentText)}" target="_blank" rel="noopener noreferrer" class="btn-vault-action" title="Open link in browser">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  Open Link
                </a>
              ` : ''}
              <button class="btn-vault-action primary btn-open-edit-modal" data-id="${escapeAttr(item.id)}" title="View and edit snippet">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                View / Edit
              </button>
              <button class="btn-vault-action btn-vault-copy" data-content="${escapeAttr(contentText)}" title="Copy text to clipboard">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Copy
              </button>
              <button class="btn-vault-action danger btn-vault-delete" data-id="${escapeAttr(item.id)}" title="Delete snippet from vault">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                Delete
              </button>
            </div>
          </div>
        `;
      });
      container.innerHTML = html;

      // Update Pagination UI
      if (paginationContainer) {
        if (items.length > CLIPBOARD_PAGE_SIZE) {
          paginationContainer.style.display = 'flex';
          if (pageIndicator) pageIndicator.textContent = `Page ${clipboardCurrentPage} of ${totalPages} (${items.length} total)`;
          if (prevBtn) prevBtn.disabled = (clipboardCurrentPage <= 1);
          if (nextBtn) nextBtn.disabled = (clipboardCurrentPage >= totalPages);
        } else {
          paginationContainer.style.display = 'none';
        }
      }

      // Bind Card Actions
      $$('.btn-vault-copy', container).forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const txt = btn.getAttribute('data-content');
          if (txt) {
            try {
              await navigator.clipboard.writeText(txt);
              showToast('Copied snippet to clipboard!', 'success');
            } catch {
              showToast('Failed to copy', 'error');
            }
          }
        });
      });

      $$('.btn-vault-delete', container).forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          if (!id) return;
          try {
            const delRes = await doFetch(`/api/clipboard/vault/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (delRes && delRes.ok) {
              showToast('Snippet deleted from vault', 'info');
              renderClipboardVaultTab();
            }
          } catch {
            showToast('Failed to delete snippet', 'error');
          }
        });
      });

      $$('.btn-open-edit-modal', container).forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = el.getAttribute('data-id');
          const item = items.find(i => String(i.id) === String(id));
          if (item) {
            openClipboardEditModal(item);
          }
        });
      });

      // Wire Pagination Buttons once
      if (prevBtn && !prevBtn._wired) {
        prevBtn._wired = true;
        prevBtn.addEventListener('click', () => {
          if (clipboardCurrentPage > 1) {
            clipboardCurrentPage--;
            renderClipboardVaultTab();
          }
        });
      }

      if (nextBtn && !nextBtn._wired) {
        nextBtn._wired = true;
        nextBtn.addEventListener('click', () => {
          clipboardCurrentPage++;
          renderClipboardVaultTab();
        });
      }

      // Wire Modal Controls once
      const btnModalClose = $('#btnCloseClipboardModal');
      const btnModalCancel = $('#btnModalCancelClipboard');
      const btnModalCopy = $('#btnModalCopyClipboard');
      const btnModalSave = $('#btnModalSaveClipboard');
      const editModal = $('#clipboardEditModal');

      if (btnModalClose && !btnModalClose._wired) {
        btnModalClose._wired = true;
        btnModalClose.addEventListener('click', closeClipboardEditModal);
      }

      if (btnModalCancel && !btnModalCancel._wired) {
        btnModalCancel._wired = true;
        btnModalCancel.addEventListener('click', closeClipboardEditModal);
      }

      if (editModal && !editModal._wired) {
        editModal._wired = true;
        editModal.addEventListener('click', (e) => {
          if (e.target === editModal) closeClipboardEditModal();
        });
      }

      if (btnModalCopy && !btnModalCopy._wired) {
        btnModalCopy._wired = true;
        btnModalCopy.addEventListener('click', async () => {
          const textarea = $('#clipboardModalTextarea');
          if (textarea && textarea.value) {
            try {
              await navigator.clipboard.writeText(textarea.value);
              showToast('Copied to clipboard!', 'success');
            } catch {
              showToast('Failed to copy text', 'error');
            }
          }
        });
      }

      if (btnModalSave && !btnModalSave._wired) {
        btnModalSave._wired = true;
        btnModalSave.addEventListener('click', async () => {
          if (!activeEditingClipboardId) return;
          const textarea = $('#clipboardModalTextarea');
          const newContent = textarea ? textarea.value : '';
          btnModalSave.disabled = true;
          try {
            const saveRes = await doFetch(`/api/clipboard/vault/${encodeURIComponent(activeEditingClipboardId)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: newContent })
            });
            if (saveRes && saveRes.ok) {
              showToast('Clipboard snippet saved!', 'success');
              closeClipboardEditModal();
              renderClipboardVaultTab();
            } else {
              showToast('Failed to save changes', 'error');
            }
          } catch {
            showToast('Network error saving snippet', 'error');
          } finally {
            btnModalSave.disabled = false;
          }
        });
      }

      // Wire Clear Vault button once
      const btnClearVault = $('#btnClearClipboardVault');
      if (btnClearVault && !btnClearVault._wired) {
        btnClearVault._wired = true;
        btnClearVault.addEventListener('click', async () => {
          if (!confirm('Are you sure you want to clear all clipboard snippets from the vault?')) {
            return;
          }
          try {
            const clearRes = await doFetch('/api/clipboard/vault', { method: 'DELETE' });
            if (clearRes && clearRes.ok) {
              showToast('All clipboard vault history cleared', 'success');
              clipboardCurrentPage = 1;
              renderClipboardVaultTab();
            } else {
              showToast('Failed to clear vault', 'error');
            }
          } catch {
            showToast('Error clearing clipboard vault', 'error');
          }
        });
      }

    } catch (e) {
      console.warn('Error rendering clipboard vault:', e);
    }
  }

  function renderRemoteStudioTab() {
    const lockBtn = $('#btnRemoteLockPC');
    const sleepBtn = $('#btnRemoteSleepPC');

    if (lockBtn && !lockBtn._wired) {
      lockBtn._wired = true;
      lockBtn.addEventListener('click', async () => {
        try {
          await doFetch('/api/system/lock', { method: 'POST' });
          showToast('Locking PC...', 'info');
        } catch {
          showToast('Failed to lock PC', 'error');
        }
      });
    }

    if (sleepBtn && !sleepBtn._wired) {
      sleepBtn._wired = true;
      sleepBtn.addEventListener('click', async () => {
        try {
          await doFetch('/api/system/sleep', { method: 'POST' });
          showToast('Putting PC to sleep...', 'info');
        } catch {
          showToast('Failed to put PC to sleep', 'error');
        }
      });
    }
  }

  async function renderRightPanelConnectedDevices() {
    const listContainer = $('#rightPanelDeviceList');
    if (!listContainer) return;

    try {
      const res = await doFetch('/api/auth/devices');
      if (res && res.ok) {
        const data = await res.json();
        const devices = data.devices || [];

        if (devices.length === 0) {
          listContainer.innerHTML = `
            <div style="text-align: center; padding: 18px 0; font-size: 0.76rem; color: #8a8a9e;">
              No devices connected
            </div>
          `;
          return;
        }

        let html = '';
        devices.forEach(dev => {
          let name = dev.deviceName || dev.platform || 'iPhone';
          if (name.toLowerCase().includes('authorized') || name.toLowerCase().includes('connected') || name.toLowerCase().includes('device')) {
            name = 'iPhone';
          }
          const ip = dev.ip || 'Wi-Fi Client';
          const isWebRTC = dev.service === 'WebRTC' || dev.service === 'WebRTC Direct';
          const badgeLabel = isWebRTC ? 'WebRTC' : 'PWA';
          const badgeStyle = isWebRTC 
            ? 'background: rgba(34, 197, 94, 0.14); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.35);'
            : 'background: rgba(0, 170, 255, 0.14); color: #38bdf8; border: 1px solid rgba(0, 170, 255, 0.35);';
          
          const dotColor = isWebRTC ? '#4ade80' : '#38bdf8';
          const dotGlow = isWebRTC ? 'box-shadow: 0 0 8px rgba(74, 222, 128, 0.6);' : 'box-shadow: 0 0 8px rgba(56, 189, 248, 0.6);';

          html += `
            <div style="display: flex; flex-direction: column; padding: 12px 14px; border-radius: 12px; background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 136, 0, 0.2); transition: all 0.2s ease; gap: 8px;">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1;">
                  <div style="width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, rgba(255, 85, 0, 0.2), rgba(255, 170, 0, 0.08)); border: 1px solid rgba(255, 136, 0, 0.35); display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: #ff6a00;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
                  </div>
                  <span style="font-size: 0.85rem; font-weight: 700; color: #ffffff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: -0.2px;">${escapeHtml(name)}</span>
                </div>
                
                <div style="display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 20px; ${badgeStyle} flex-shrink: 0;">
                  <span style="width: 6px; height: 6px; border-radius: 50%; background: ${dotColor}; ${dotGlow}"></span>
                  <span style="font-size: 0.68rem; font-weight: 700; font-family: var(--font-mono, monospace); white-space: nowrap;">${badgeLabel}</span>
                </div>
              </div>

              <div style="display: flex; align-items: center; justify-content: space-between; padding: 5px 10px; border-radius: 8px; background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.06);">
                <span style="font-size: 0.68rem; font-weight: 600; color: #8a8a9e; letter-spacing: 0.3px; text-transform: uppercase;">IP Address</span>
                <span style="font-family: var(--font-mono, monospace); font-size: 0.74rem; font-weight: 600; color: rgba(255, 255, 255, 0.75); letter-spacing: 0.4px;">${escapeHtml(ip)}</span>
              </div>
            </div>
          `;
        });
        listContainer.innerHTML = html;
        return;
      }
    } catch (e) {
      console.warn('Could not fetch connected devices:', e);
    }

    listContainer.innerHTML = `
      <div style="text-align: center; padding: 18px 0; font-size: 0.76rem; color: #8a8a9e;">
        No devices connected
      </div>
    `;
  }

  function setupCreatorProfileModal() {
    const btnOpen = $('#btnOpenCreatorProfileModal');
    const lightbox = $('#creatorLightbox');
    const card = $('#creatorCard');
    const btnClose = $('#btnCloseCreator');

    if (!btnOpen || !lightbox || !card || !btnClose) return;

    btnOpen.addEventListener('click', (e) => {
      e.preventDefault();
      lightbox.style.display = 'flex';
      setTimeout(() => {
        lightbox.style.opacity = '1';
        card.style.transform = 'translateY(0)';
      }, 10);
    });

    const closeCreator = () => {
      lightbox.style.opacity = '0';
      card.style.transform = 'translateY(20px)';
      setTimeout(() => {
        lightbox.style.display = 'none';
      }, 300);
    };

    btnClose.addEventListener('click', closeCreator);
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeCreator();
    });
  }

  function setupTabs() {
    // Transmit Box Segmented Switcher (Text vs Files & Media)
    const btnTxText = $('#tabTransmitTextBtn');
    const btnTxFile = $('#tabTransmitFileBtn');
    const secTxText = $('#sectionSendText');
    const secTxFile = $('#sectionSendFile');

    if (btnTxText && btnTxFile && secTxText && secTxFile) {
      btnTxText.addEventListener('click', () => {
        btnTxText.style.color = '#ff5500';
        btnTxText.style.background = 'rgba(255, 85, 0, 0.16)';
        btnTxText.style.borderColor = 'rgba(255, 85, 0, 0.32)';

        btnTxFile.style.color = '#a0a0b8';
        btnTxFile.style.background = 'transparent';
        btnTxFile.style.borderColor = 'transparent';

        secTxText.style.display = 'block';
        secTxFile.style.display = 'none';
      });

      btnTxFile.addEventListener('click', () => {
        btnTxFile.style.color = '#ff5500';
        btnTxFile.style.background = 'rgba(255, 85, 0, 0.16)';
        btnTxFile.style.borderColor = 'rgba(255, 85, 0, 0.32)';

        btnTxText.style.color = '#a0a0b8';
        btnTxText.style.background = 'transparent';
        btnTxText.style.borderColor = 'transparent';

        secTxText.style.display = 'none';
        secTxFile.style.display = 'block';
      });
    }
    $$('.sidebar-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (tab) switchDesktopTab(tab);
      });
    });

    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tName = tab.getAttribute('data-tab');
        if (tName) switchDesktopTab(tName);
      });
    });

    // Quick Action button bindings
    const quickSend = $('#quickActionSendPhone');
    if (quickSend) quickSend.addEventListener('click', () => switchDesktopTab('send'));

    const quickShare = $('#quickActionShareFriend');
    if (quickShare) quickShare.addEventListener('click', () => switchDesktopTab('share'));

    const quickDev = $('#quickActionDevices');
    if (quickDev) quickDev.addEventListener('click', () => switchDesktopTab('devices'));

    const viewAllFeed = $('#linkViewAllFeed');
    if (viewAllFeed) viewAllFeed.addEventListener('click', () => switchDesktopTab('feed'));



    // Refresh devices list buttons
    const btnRefDev = $('#btnRefreshDevices');
    if (btnRefDev) {
      btnRefDev.addEventListener('click', async (e) => {
        e.preventDefault();
        btnRefDev.classList.add('spinning-icon');
        try {
          await renderRightPanelConnectedDevices();
          showToast('Connected devices refreshed', 'info');
        } finally {
          setTimeout(() => btnRefDev.classList.remove('spinning-icon'), 600);
        }
      });
    }

    const btnRefDevTab = $('#btnRefreshDevicesTab');
    if (btnRefDevTab) {
      btnRefDevTab.addEventListener('click', async (e) => {
        e.preventDefault();
        btnRefDevTab.classList.add('spinning-icon');
        try {
          await renderPairedDevicesTab();
          await renderRightPanelConnectedDevices();
          showToast('Devices list refreshed', 'info');
        } finally {
          setTimeout(() => btnRefDevTab.classList.remove('spinning-icon'), 600);
        }
      });
    }

    $$('.btn-unpair-all, #btnUnpairAllDevices, #btnUnpairAllDevicesTab').forEach(btnUnpairAll => {
      btnUnpairAll.addEventListener('click', async () => {
        if (confirm("Are you sure you want to unpair all authorized devices? All active mobile connections will be revoked.")) {
          try {
            const res = await doFetch('/api/auth/unpair-all', { method: 'POST' });
            if (res && (res.ok || res.success)) {
              showToast('All devices unpaired', 'success');
              if (typeof renderPairedDevicesTab === 'function') renderPairedDevicesTab();
              if (typeof renderRightPanelConnectedDevices === 'function') renderRightPanelConnectedDevices();
              if (typeof fetchPairedDevicesCount === 'function') fetchPairedDevicesCount();
            } else {
              showToast('Failed to unpair all devices', 'error');
            }
          } catch {
            showToast('Network error while unpairing all devices', 'error');
          }
        }
      });
    });

    const btnFilesBrowse = $('#btnFilesTabBrowse');
    if (btnFilesBrowse) {
      btnFilesBrowse.addEventListener('click', async () => {
        btnFilesBrowse.disabled = true;
        try {
          const res = await doFetch('/api/settings/browse', { method: 'POST' });
          if (res && res.ok) {
            const data = await res.json();
            if (data.path) {
              await doFetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shareDir: data.path, saveDir: data.path })
              });
              showToast('Shared directory updated!', 'success');
              renderFilesTab('');
            }
          }
        } catch {
          showToast('Failed to pick folder', 'error');
        } finally {
          btnFilesBrowse.disabled = false;
        }
      });
    }

    const btnRefFilesTab = $('#btnRefreshFilesTab');
    if (btnRefFilesTab) {
      btnRefFilesTab.addEventListener('click', async (e) => {
        e.preventDefault();
        btnRefFilesTab.classList.add('spinning-icon');
        try {
          await renderFilesTab();
          showToast('Files list refreshed', 'info');
        } finally {
          setTimeout(() => btnRefFilesTab.classList.remove('spinning-icon'), 600);
        }
      });
    }

    const btnOpenExpFiles = $('#btnOpenExplorerFiles');
    if (btnOpenExpFiles) {
      btnOpenExpFiles.addEventListener('click', async (e) => {
        e.preventDefault();
        const sub = currentFilesTabSubPath || '';
        if (isElectron && ipcRenderer) {
          ipcRenderer.send('open-file-folder', sub);
        } else {
          try {
            const res = await doFetch('/api/open-directory', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: sub })
            });
            if (res && res.ok) {
              showToast('Opened shared directory in File Explorer', 'info');
            } else {
              showToast('Could not open directory', 'error');
            }
          } catch (_) {
            showToast('Failed to open directory', 'error');
          }
        }
      });
    }

    const fileSearchInp = $('#fileSearchInput');
    if (fileSearchInp) {
      fileSearchInp.addEventListener('input', () => {
        renderFilesTab();
      });
    }

    const clipboardSearchInp = $('#clipboardSearchInput');
    if (clipboardSearchInp) {
      clipboardSearchInp.addEventListener('input', () => {
        renderClipboardVaultTab();
      });
    }

    // Setup Guide button
    const btnDashSetup = $('#btnDashSetupGuide');
    if (btnDashSetup) btnDashSetup.addEventListener('click', () => openSetupModal());

    const btnOpenSettingsDrawer = $('#btnOpenSettingsDrawer');
    if (btnOpenSettingsDrawer) btnOpenSettingsDrawer.addEventListener('click', () => openSettingsModal());

    // Refresh Received Feed Button
    const btnRefreshFeed = $('#btnRefreshFeed');
    if (btnRefreshFeed) {
      btnRefreshFeed.addEventListener('click', async (e) => {
        e.preventDefault();
        const icon = $('#refreshFeedIcon') || btnRefreshFeed;
        btnRefreshFeed.classList.add('spinning-icon');
        if (icon) icon.classList.add('spinning-icon');
        try {
          await loadHistory();
          showToast('Received Feed refreshed', 'info');
        } finally {
          setTimeout(() => {
            btnRefreshFeed.classList.remove('spinning-icon');
            if (icon) icon.classList.remove('spinning-icon');
          }, 600);
        }
      });
    }

    // Open Download Directory Button
    const btnOpenSaveDir = $('#btnOpenSaveDir');
    if (btnOpenSaveDir) {
      btnOpenSaveDir.addEventListener('click', async (e) => {
        e.preventDefault();
        if (isElectron && ipcRenderer) {
          ipcRenderer.send('open-save-directory');
          showToast('Opening download directory...', 'info');
        } else {
          try {
            const res = await doFetch('/api/open-directory', { method: 'POST' });
            if (res.ok) {
              showToast('Opening download directory...', 'info');
            } else {
              showToast('Failed to open directory', 'error');
            }
          } catch (_) {
            showToast('Failed to open directory', 'error');
          }
        }
      });
    }

    // Setup Creator Profile Modal & Connected Devices Telemetry
    setupCreatorProfileModal();
    renderRightPanelConnectedDevices();
    setInterval(() => {
      renderRightPanelConnectedDevices();
      const devTab = $('#tab-devices');
      if (devTab && devTab.classList.contains('active')) {
        renderPairedDevicesTab();
      }
    }, 4000);

    // Dashboard Central Dropzone
    const dashDrop = $('#dashDropzone');
    const sendFileInput = $('#sendFileInput');
    if (dashDrop) {
      dashDrop.addEventListener('click', () => {
        switchDesktopTab('send');
        if (sendFileInput) sendFileInput.click();
      });
      dashDrop.addEventListener('dragover', (e) => {
        e.preventDefault();
        dashDrop.classList.add('drag-over');
      });
      dashDrop.addEventListener('dragleave', () => dashDrop.classList.remove('drag-over'));
      dashDrop.addEventListener('drop', (e) => {
        e.preventDefault();
        dashDrop.classList.remove('drag-over');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          switchDesktopTab('send');
          if (sendFileInput) {
            sendFileInput.files = e.dataTransfer.files;
            sendFileInput.dispatchEvent(new Event('change'));
          }
        }
      });
    }
  }

  function setupGlobalExternalLinks() {
    document.addEventListener('click', (e) => {
      const anchor = e.target.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript:')) return;

      if (href.startsWith('http://') || href.startsWith('https://')) {
        if (window.electronAPI && window.electronAPI.send) {
          e.preventDefault();
          window.electronAPI.send('open-link', anchor.href || href);
        }
      }
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

  // ─── Filter group & View mode switcher setup ─────────────
  function setupFilters() {
    $$('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.getAttribute('data-filter');
        renderFeed();
      });
    });

    const btnViewList = $('#btnViewList');
    const btnViewGrid = $('#btnViewGrid');
    const feedContainer = $('#feed');

    let currentViewMode = localStorage.getItem('airodrop_feed_view_mode') || 'grid';

    function applyViewMode(mode) {
      currentViewMode = mode;
      localStorage.setItem('airodrop_feed_view_mode', mode);
      
      if (mode === 'grid') {
        if (feedContainer) feedContainer.classList.add('grid-view');
        if (btnViewGrid) {
          btnViewGrid.classList.add('active');
          btnViewGrid.style.background = 'rgba(255, 255, 255, 0.08)';
          btnViewGrid.style.borderColor = 'rgba(255, 255, 255, 0.15)';
          btnViewGrid.style.color = '#ffffff';
        }
        if (btnViewList) {
          btnViewList.classList.remove('active');
          btnViewList.style.background = 'transparent';
          btnViewList.style.borderColor = 'transparent';
          btnViewList.style.color = '#a0a0b8';
        }
      } else {
        if (feedContainer) feedContainer.classList.remove('grid-view');
        if (btnViewList) {
          btnViewList.classList.add('active');
          btnViewList.style.background = 'rgba(255, 255, 255, 0.08)';
          btnViewList.style.borderColor = 'rgba(255, 255, 255, 0.15)';
          btnViewList.style.color = '#ffffff';
        }
        if (btnViewGrid) {
          btnViewGrid.classList.remove('active');
          btnViewGrid.style.background = 'transparent';
          btnViewGrid.style.borderColor = 'transparent';
          btnViewGrid.style.color = '#a0a0b8';
        }
      }
    }

    if (btnViewList && btnViewGrid) {
      btnViewList.addEventListener('click', () => applyViewMode('list'));
      btnViewGrid.addEventListener('click', () => applyViewMode('grid'));
      applyViewMode(currentViewMode);
    }
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
    // Smooth single card removal helper (No full feed re-render = No flickering!)
    function removeCardSmoothly(id, isKeepFile = true, successMessage = null) {
      const card = document.getElementById(`item-${id}`);
      if (!card) {
        allItems = allItems.filter(item => item.id !== id);
        renderFeed();
        updateStats();
        if (successMessage) showToast(successMessage, 'info');
        return;
      }

      // Lock exact height for smooth CSS collapse transition
      const height = card.offsetHeight;
      card.style.height = height + 'px';
      card.style.opacity = '1';
      card.style.transform = 'scale(1)';
      card.style.transition = 'all 0.28s cubic-bezier(0.16, 1, 0.3, 1)';
      card.style.overflow = 'hidden';

      // Force layout reflow
      void card.offsetHeight;

      // Trigger smooth fade & collapse
      requestAnimationFrame(() => {
        card.style.opacity = '0';
        card.style.transform = 'scale(0.92) translateY(-6px)';
        card.style.height = '0px';
        card.style.paddingTop = '0px';
        card.style.paddingBottom = '0px';
        card.style.marginTop = '0px';
        card.style.marginBottom = '0px';
        card.style.borderWidth = '0px';
      });

      setTimeout(() => {
        if (card.parentNode) {
          card.parentNode.removeChild(card);
        }
        allItems = allItems.filter(item => item.id !== id);
        updateStats();
        renderDashboardRecentActivity();
        if (successMessage) showToast(successMessage, 'info');

        // If feed becomes empty, re-render empty state
        if (!allItems || allItems.length === 0) {
          renderFeed();
        }
      }, 280);
    }

    const feedEl = $('#feed');
    if (feedEl) {
      // Clear card from UI feed only (does NOT delete physical file from disk)
      feedEl.addEventListener('click', async (e) => {
        const clearBtn = e.target.closest('.clear-card-btn');
        if (!clearBtn) return;
        
        e.stopPropagation();
        e.preventDefault();
        const id = clearBtn.getAttribute('data-id');
        if (!id) return;

        try {
          const res = await doFetch(`/api/history/${id}?keepFile=true`, { method: 'DELETE' });
          const data = await res.json();
          if (res.ok && data.success) {
            removeCardSmoothly(id, true, 'Card cleared from feed');
          } else {
            showToast(data.error || 'Failed to clear card', 'error');
          }
        } catch {
          showToast('Network error', 'error');
        }
      });

      // Single item delete from disk history
      feedEl.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.delete-btn');
        if (!deleteBtn || e.target.closest('.clear-card-btn')) return;
        
        e.stopPropagation();
        e.preventDefault();
        const id = deleteBtn.getAttribute('data-id');
        if (!id) return;

        try {
          const res = await doFetch(`/api/history/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (res.ok && data.success) {
            removeCardSmoothly(id, false, 'Item deleted');
          } else {
            showToast(data.error || 'Failed to delete item', 'error');
          }
        } catch {
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

    // Send Text to Phone & Paste Clipboard
    const sendTextBtn = $('#sendTextBtn');
    if (sendTextBtn) {
      sendTextBtn.addEventListener('click', sendTextToPhone);
    }
    const btnPasteText = $('#btnPasteText');
    const textInput = $('#sendTextInput');
    
    if (btnPasteText && textInput) {
      btnPasteText.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            textInput.value = text;
            textInput.dispatchEvent(new Event('input'));
            showToast('Pasted from clipboard', 'info');
          } else {
            showToast('Clipboard is empty', 'warning');
          }
        } catch {
          showToast('Unable to read clipboard', 'error');
        }
      });
    }

    if (textInput) {
      textInput.addEventListener('input', () => {
        textInput.style.height = 'auto';
        textInput.style.height = Math.min(textInput.scrollHeight, 84) + 'px';
      });
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

    // Unified Single Send Button Handler
    const unifiedSendBtn = $('#unifiedSendBtn');
    if (unifiedSendBtn) {
      unifiedSendBtn.addEventListener('click', async () => {
        const textInput = $('#sendTextInput');
        const hasText = textInput && textInput.value.trim().length > 0;
        const hasFile = selectedFileObj !== null;

        if (!hasText && !hasFile) {
          return showToast('Type a message or drop a file to send', 'error');
        }

        unifiedSendBtn.disabled = true;
        unifiedSendBtn.innerHTML = `<span>Sending...</span>`;

        try {
          if (hasText) {
            await sendTextToPhone();
          }
          if (hasFile) {
            await sendFileToPhone();
            selectedFileObj = null;
            const preview = $('#sendFilePreview');
            const fileDrop = $('#fileDrop');
            const fileInput = $('#sendFileInput');
            if (preview) preview.style.display = 'none';
            if (fileDrop) fileDrop.style.display = 'flex';
            if (fileInput) fileInput.value = '';
          }
        } finally {
          unifiedSendBtn.disabled = false;
          unifiedSendBtn.innerHTML = `<span>Send to Phone</span><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
        }
      });
    }

    // Remove Selected File Handler
    const btnRemoveFile = $('#btnRemoveSelectedFile');
    if (btnRemoveFile) {
      btnRemoveFile.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedFileObj = null;
        const preview = $('#sendFilePreview');
        const fileDrop = $('#fileDrop');
        const fileInput = $('#sendFileInput');
        const sendBtn = $('#sendFileBtn');
        if (preview) preview.style.display = 'none';
        if (fileDrop) fileDrop.style.display = 'flex';
        if (fileInput) fileInput.value = '';
        if (sendBtn) sendBtn.disabled = true;
      });
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

  function getFileTypeSvg(mimeType) {
    if (!mimeType) return '<svg class="icon-svg md" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    const type = mimeType.toLowerCase();
    if (type.startsWith('image/')) return '<svg class="icon-svg md" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    if (type.startsWith('video/')) return '<svg class="icon-svg md" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>';
    if (type.startsWith('audio/')) return '<svg class="icon-svg md" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    if (type.includes('pdf')) return '<svg class="icon-svg md" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
    if (type.includes('zip') || type.includes('rar') || type.includes('7z') || type.includes('tar') || type.includes('gzip')) return '<svg class="icon-svg md" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
    return '<svg class="icon-svg md" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  }

  function handleFileSelection(file) {
    selectedFileObj = file;
    const isImage = file.type && file.type.startsWith('image/');
    const preview = $('#sendFilePreview');
    const previewImg = $('#sendPreviewImg');
    const previewIcon = $('#sendFilePreviewIcon');
    const nameSpan = $('#sendFileName');
    const sizeSpan = $('#sendFileSize');
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
        previewIcon.innerHTML = getFileTypeSvg(file.type);
        previewIcon.style.display = 'flex';
      }
    }

    if (nameSpan) nameSpan.textContent = file.name;
    if (sizeSpan) sizeSpan.textContent = formatSize(file.size);
    if (preview) preview.style.display = 'flex';
    if (fileDrop) fileDrop.style.display = 'none';
    if (sendBtn) sendBtn.disabled = false;
  }

  async function sendFileToPhone() {
    if (!selectedFileObj) return;
    
    const sendBtn = $('#sendFileBtn');
    if (!sendBtn) return;
    
    sendBtn.disabled = true;
    sendBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="15"/><polyline points="17 8 12 3 7 8"/></svg>`;

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
      sendBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
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
            showToast(`Auto-Clear Temp turned ${checked ? 'On' : 'Off'}`, 'info');
            const tempModeInput = $('#tempModeInput');
            if (tempModeInput) tempModeInput.checked = checked;
            updateTemporaryModeBadge(checked);
          }
        } catch (err) {
          showToast('Failed to toggle Auto-Clear Temp', 'error');
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

    const securityModeInput = $('#securityModeInput');
    const pinDisplayCode = $('#pinDisplayCode');
    const shortcutSecretInput = $('#shortcutSecretInput');
    const pairedDevicesStatusText = $('#pairedDevicesStatusText');
    const btnRegeneratePin = $('#btnRegeneratePin');
    const btnRevokeAllPaired = $('#btnRevokeAllPaired');

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
          if (securityModeInput && data.securityMode) securityModeInput.value = data.securityMode;
          if (pinDisplayCode && data.pinCode) pinDisplayCode.textContent = data.pinCode;
          if (shortcutSecretInput && data.shortcutSecret) shortcutSecretInput.value = data.shortcutSecret;
          if (isElectron && data.platform === 'win32' && contextMenuSettingRow) {
            contextMenuSettingRow.style.display = 'flex';
          }
          if (data.version) {
            const versionEl = document.getElementById('appVersionTag');
            if (versionEl) versionEl.textContent = `v${data.version}`;
          }
          updateTemporaryModeBadge(data.temporaryMode);
          fetchPairedDevicesCount();

        }
      } catch (err) {
        console.error('Failed to load settings:', err);
      }

      // Toggle card views based on isElectron
      const electronSettingsCard = $('#electronSettingsCard');
      const webSettingsCard = $('#webSettingsCard');
      const desktopAppPreferencesCard = $('#desktopAppPreferencesCard');
      if (desktopAppPreferencesCard) desktopAppPreferencesCard.style.display = 'flex';
      if (isElectron) {
        if (electronSettingsCard) electronSettingsCard.style.display = 'flex';
        if (webSettingsCard) webSettingsCard.style.display = 'none';
      } else {
        if (electronSettingsCard) electronSettingsCard.style.display = 'none';
        if (webSettingsCard) webSettingsCard.style.display = 'flex';
        setupWebUpdater();
      }
    }

    fetchPairedDevicesCount = async function() {
      try {
        const res = await doFetch('/api/auth/status');
        if (res.ok) {
          const data = await res.json();
          const rightPanelPinDisplay = $('#rightPanelPinDisplay');
          if (pinDisplayCode && data.pin) pinDisplayCode.textContent = data.pin;
          if (rightPanelPinDisplay && data.pin) rightPanelPinDisplay.textContent = `PIN: ${data.pin}`;
          if (pairedDevicesStatusText) {
            pairedDevicesStatusText.textContent = `${data.pairedCount || 0} device(s) currently paired`;
          }
        }

        const resList = await doFetch('/api/auth/paired-devices');
        const listContainer = document.getElementById('pairedDevicesListContainer');
        if (resList.ok && listContainer) {
          const listData = await resList.json();
          listContainer.innerHTML = '';
          if (listData.devices && listData.devices.length > 0) {
            listData.devices.forEach(dev => {
              const devEl = document.createElement('div');
              devEl.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; font-size: 0.78rem;';
              
              const infoEl = document.createElement('div');
              infoEl.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
              
              const nameEl = document.createElement('span');
              nameEl.style.cssText = 'font-weight: 600; color: var(--text-primary);';
              nameEl.textContent = dev.deviceName;
              
              const ipEl = document.createElement('span');
              ipEl.style.cssText = 'font-size: 0.68rem; color: var(--text-secondary);';
              ipEl.textContent = `${dev.ip} • Paired: ${new Date(dev.pairedAt).toLocaleDateString()}`;
              
              infoEl.appendChild(nameEl);
              infoEl.appendChild(ipEl);
              
              const revokeBtn = document.createElement('button');
              revokeBtn.className = 'settings-browse-btn';
              revokeBtn.style.cssText = 'padding: 4px 8px; font-size: 0.7rem; border-color: rgba(255,75,75,0.3); color: #ff6b6b; cursor: pointer;';
              revokeBtn.textContent = 'Revoke';
              revokeBtn.addEventListener('click', async () => {
                if (!confirm(`Revoke access for ${dev.deviceName}?`)) return;
                try {
                  const revokeRes = await doFetch('/api/auth/unpair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: dev.token })
                  });
                  if (revokeRes.ok) {
                    fetchPairedDevicesCount();
                    showToast('Device revoked successfully', 'info');
                  }
                } catch (e) {
                  showToast('Failed to revoke device', 'error');
                }
              });
              
              devEl.appendChild(infoEl);
              devEl.appendChild(revokeBtn);
              listContainer.appendChild(devEl);
            });
          } else {
            listContainer.innerHTML = '<div style="font-size: 0.74rem; color: var(--text-secondary); text-align: center; padding: 10px 0; font-style: italic;">No paired devices found</div>';
          }
        }
      } catch (err) {}
    }

    if (btnRegeneratePin) {
      btnRegeneratePin.addEventListener('click', async () => {
        try {
          btnRegeneratePin.textContent = '...';
          btnRegeneratePin.disabled = true;
          const res = await doFetch('/api/auth/regenerate-pin', { method: 'POST' });
          const data = await res.json();
          if (data.success && data.pin) {
            if (pinDisplayCode) pinDisplayCode.textContent = data.pin;
            showToast('New PIN code generated!', 'success');
          }
        } catch (e) {
          showToast('Failed to regenerate PIN', 'error');
        } finally {
          btnRegeneratePin.textContent = 'Regenerate';
          btnRegeneratePin.disabled = false;
        }
      });
    }

    if (btnRevokeAllPaired) {
      btnRevokeAllPaired.addEventListener('click', async () => {
        if (!confirm('Revoke all paired devices? They will need to re-enter the PIN to reconnect.')) return;
        try {
          const res = await doFetch('/api/auth/unpair-all', { method: 'POST' });
          if (res.ok) {
            fetchPairedDevicesCount();
            showToast('All paired devices revoked', 'info');
          }
        } catch (e) {
          showToast('Failed to revoke devices', 'error');
        }
      });
    }

    function setupWebUpdater() {
      const btnWebCheckUpdates = $('#btnWebCheckUpdates');
      const webUpdateStatusMessage = $('#webUpdateStatusMessage');

      if (btnWebCheckUpdates) {
        btnWebCheckUpdates.addEventListener('click', async () => {
          btnWebCheckUpdates.disabled = true;
          btnWebCheckUpdates.textContent = 'Checking...';
          
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
            btnWebCheckUpdates.textContent = 'Check for Updates';
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
        const winSidebarDeviceName = document.getElementById('winSidebarDeviceName');
        if (winSidebarDeviceName && deviceName) winSidebarDeviceName.textContent = deviceName;
        const port = portInput ? portInput.value : 3478;
        const notificationsEnabled = notificationsInput ? notificationsInput.checked : true;
        const rateLimitEnabled = rateLimitInput ? rateLimitInput.checked : true;
        const temporaryModeHours = tempModeHoursInput ? tempModeHoursInput.value : 2;
        const autoOpenLinks = autoOpenLinksInput ? autoOpenLinksInput.checked : false;
        const launchOnStartup = desktopAutoStartInput ? desktopAutoStartInput.checked : false;
        const autoUpdate = autoUpdaterInput ? autoUpdaterInput.checked : true;
        const httpsEnabled = httpsEnabledInput ? httpsEnabledInput.checked : false;
        const contextMenuEnabled = contextMenuInput ? contextMenuInput.checked : false;
        const securityMode = securityModeInput ? securityModeInput.value : 'protected';
        const shortcutSecret = shortcutSecretInput ? shortcutSecretInput.value.trim() : '';

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
              contextMenuEnabled,
              securityMode,
              shortcutSecret
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
            if (securityModeInput && data.securityMode) securityModeInput.value = data.securityMode;
            if (shortcutSecretInput && data.shortcutSecret) shortcutSecretInput.value = data.shortcutSecret;
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

    async function autoSaveSecuritySettings() {
      const securityMode = securityModeInput ? securityModeInput.value : 'protected';
      const shortcutSecret = shortcutSecretInput ? shortcutSecretInput.value.trim() : '';
      
      try {
        const res = await doFetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ securityMode, shortcutSecret })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          console.log('[AUTO-SAVE] Security settings saved:', data);
          showToast('Security settings updated', 'success');
        }
      } catch (err) {
        console.error('[AUTO-SAVE] Failed to save security settings:', err);
      }
    }

    if (securityModeInput) {
      securityModeInput.addEventListener('change', autoSaveSecuritySettings);
    }
    if (shortcutSecretInput) {
      shortcutSecretInput.addEventListener('change', autoSaveSecuritySettings);
    }

    const btnSaveShortcutSecret = $('#btnSaveShortcutSecret');
    if (btnSaveShortcutSecret) {
      btnSaveShortcutSecret.addEventListener('click', async () => {
        btnSaveShortcutSecret.disabled = true;
        btnSaveShortcutSecret.textContent = 'Saving...';
        await autoSaveSecuritySettings();
        btnSaveShortcutSecret.disabled = false;
        btnSaveShortcutSecret.textContent = 'Save Secret';
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
      let icon = '';
      if (type === 'success') icon = '✓ ';
      else if (type === 'error') icon = '✕ ';
      else if (type === 'info') icon = 'ℹ ';

      settingsStatus.className = `settings-status ${type}`;
      settingsStatus.innerHTML = `<span style="font-weight: 800; font-size: 0.85rem;">${icon}</span><span>${text}</span>`;
      settingsStatus.style.display = 'inline-flex';

      if (window._settingsToastTimer) clearTimeout(window._settingsToastTimer);
      if (type === 'success' || type === 'info') {
        window._settingsToastTimer = setTimeout(() => {
          if (settingsStatus) settingsStatus.style.display = 'none';
        }, 3500);
      }
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
        const textLabel = btnElement.innerText ? btnElement.innerText.trim() : '';

        if (textLabel && textLabel.length > 0) {
          btnElement.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span style="color: #4ade80; font-weight: 700;">Copied!</span>`;
        } else {
          btnElement.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>`;
        }

        setTimeout(() => {
          btnElement.classList.remove('copied');
          btnElement.innerHTML = oldHtml;
        }, 1800);
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

  async function copyImageToClipboard(imgSrc, btnElement) {
    if (!imgSrc) return;
    
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
      showToast('Photo copied to clipboard!', 'success');
    }

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = imgSrc;
      
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load image for clipboard copy'));
      });

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Canvas blob generation failed');

      if (navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        setCopiedState();
      } else {
        throw new Error('Async Clipboard API write image not supported');
      }
    } catch (err) {
      console.warn('[Clipboard] Web API image copy failed, using fallback:', err);
      if (btnElement) {
        const textFallback = btnElement.getAttribute('data-text') || imgSrc;
        copyToClipboard(textFallback, btnElement);
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

  // ─── Quick Device Pairing & Setup Modal ──────────────────
  function setupShortcutsModal() {
    const btnHeaderSetup = $('#btnHeaderSetup');
    const shortcutsModal = $('#shortcutsModal');
    const closeModal = $('#closeModal');

    if (btnHeaderSetup && shortcutsModal) {
      btnHeaderSetup.addEventListener('click', () => {
        openSetupModal();
      });
    }

    const flowStep1 = $('#flowStep1');
    const flowStepAndroidPWA = $('#flowStepAndroidPWA');
    const flowStepIosPWA = $('#flowStepIosPWA');
    const flowStepIosShortcuts = $('#flowStepIosShortcuts');

    const btnFlowSelectIOS = $('#btnFlowSelectIOS');
    const btnFlowSelectAndroid = $('#btnFlowSelectAndroid');
    const btnGoToIosShortcuts = $('#btnGoToIosShortcuts');
    const btnBackToIosPWA = $('#btnBackToIosPWA');
    const backBtns = $$('.btnBackToStep1');

    // Step 1 -> iPhone Flow (Step 1: Safari PWA)
    if (btnFlowSelectIOS) {
      btnFlowSelectIOS.addEventListener('click', () => {
        if (flowStep1) flowStep1.style.display = 'none';
        if (flowStepIosPWA) flowStepIosPWA.style.display = 'flex';
        if (flowStepAndroidPWA) flowStepAndroidPWA.style.display = 'none';
        if (flowStepIosShortcuts) flowStepIosShortcuts.style.display = 'none';
      });
    }

    // Step 1 -> Android Flow (PWA)
    if (btnFlowSelectAndroid) {
      btnFlowSelectAndroid.addEventListener('click', () => {
        if (flowStep1) flowStep1.style.display = 'none';
        if (flowStepAndroidPWA) flowStepAndroidPWA.style.display = 'flex';
        if (flowStepIosPWA) flowStepIosPWA.style.display = 'none';
        if (flowStepIosShortcuts) flowStepIosShortcuts.style.display = 'none';
      });
    }

    // iPhone PWA -> iPhone Shortcuts
    if (btnGoToIosShortcuts) {
      btnGoToIosShortcuts.addEventListener('click', () => {
        if (flowStepIosPWA) flowStepIosPWA.style.display = 'none';
        if (flowStepIosShortcuts) flowStepIosShortcuts.style.display = 'flex';
      });
    }

    // iPhone Shortcuts -> iPhone PWA
    if (btnBackToIosPWA) {
      btnBackToIosPWA.addEventListener('click', () => {
        if (flowStepIosShortcuts) flowStepIosShortcuts.style.display = 'none';
        if (flowStepIosPWA) flowStepIosPWA.style.display = 'flex';
      });
    }

    // Back to Step 1
    backBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        if (flowStep1) flowStep1.style.display = 'flex';
        if (flowStepAndroidPWA) flowStepAndroidPWA.style.display = 'none';
        if (flowStepIosPWA) flowStepIosPWA.style.display = 'none';
        if (flowStepIosShortcuts) flowStepIosShortcuts.style.display = 'none';
      });
    });

    // Change PIN button -> redirect to Settings -> Device Security
    const btnOpenPinInSettings = $('#btnOpenPinInSettings');
    if (btnOpenPinInSettings) {
      btnOpenPinInSettings.addEventListener('click', (e) => {
        e.preventDefault();
        shortcutsModal.style.display = 'none';
        switchDesktopTab('settings');
        const secNav = document.querySelector('.win-nav-item[data-target="win-sec-device-security"]');
        if (secNav) secNav.click();
      });
    }

    // Copy Address / Port / Link Buttons
    const btnCopyPairAddress = $('#btnCopyPairAddress');
    if (btnCopyPairAddress) {
      btnCopyPairAddress.addEventListener('click', () => {
        const text = $('.infoIPSetupText')?.textContent || '';
        if (text) {
          navigator.clipboard.writeText(text);
          if (typeof showToast === 'function') showToast('Pairing address copied!');
        }
      });
    }

    const btnCopyFallbackPort = $('#btnCopyFallbackPort');
    if (btnCopyFallbackPort) {
      btnCopyFallbackPort.addEventListener('click', () => {
        const text = $('.infoPortSetupText')?.textContent || '3479';
        if (text) {
          navigator.clipboard.writeText(text);
          if (typeof showToast === 'function') showToast('Fallback port copied!');
        }
      });
    }

    const btnCopyFallbackUrl = $('#btnCopyFallbackUrl');
    if (btnCopyFallbackUrl) {
      btnCopyFallbackUrl.addEventListener('click', () => {
        const text = $('.infoIPSetupText')?.textContent || '';
        if (text) {
          navigator.clipboard.writeText(text);
          if (typeof showToast === 'function') showToast('Fallback URL copied!');
        }
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
        // Focus first focusable element in modal
        const firstFocusable = settingsModal.querySelector('button, input, select, [tabindex]');
        if (firstFocusable) setTimeout(() => firstFocusable.focus(), 50);
      });
    }

    if (btnCloseSettings && settingsModal) {
      btnCloseSettings.addEventListener('click', () => {
        settingsModal.style.display = 'none';
        if (btnHeaderSettings) {
          btnHeaderSettings.classList.remove('glow');
          btnHeaderSettings.focus();
        }
      });
    }

    window.addEventListener('click', (e) => {
      if (e.target === settingsModal) {
        settingsModal.style.display = 'none';
        if (btnHeaderSettings) btnHeaderSettings.classList.remove('glow');
      }
    });
  }

  // ─── Interactive Text Edit & Full View Modal Manager ─────────
  function setupTextModal() {
    const textEditModal = $('#textEditModal');
    const textModalArea = $('#textModalArea');
    const textModalCharCount = $('#textModalCharCount');
    const btnCloseTextModal = $('#btnCloseTextModal');
    const btnCopyTextModal = $('#btnCopyTextModal');
    const btnSaveTextModal = $('#btnSaveTextModal');

    if (!textEditModal || !textModalArea) return;

    let currentItem = null;

    function openTextEditModal(item) {
      if (!item) return;
      currentItem = item;
      textModalArea.value = item.content || '';
      if (textModalCharCount) {
        textModalCharCount.textContent = `${(item.content || '').length} characters`;
      }
      textEditModal.style.display = 'flex';
      setTimeout(() => {
        textModalArea.focus();
        textModalArea.setSelectionRange(textModalArea.value.length, textModalArea.value.length);
      }, 50);
    }

    function closeTextEditModal() {
      textEditModal.style.display = 'none';
      currentItem = null;
    }

    textModalArea.addEventListener('input', () => {
      if (textModalCharCount) {
        textModalCharCount.textContent = `${textModalArea.value.length} characters`;
      }
    });

    if (btnCloseTextModal) {
      btnCloseTextModal.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTextEditModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && textEditModal.style.display === 'flex') {
        closeTextEditModal();
      }
    });

    if (btnCopyTextModal) {
      btnCopyTextModal.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = textModalArea.value;
        if (!text) return;
        copyToClipboard(text, btnCopyTextModal);
      });
    }

    if (btnSaveTextModal) {
      btnSaveTextModal.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const newText = textModalArea.value;
        if (currentItem) {
          currentItem.content = newText;
          copyToClipboard(newText);
          renderFeed();
          showToast('Text content updated!', 'success');
        }
        closeTextEditModal();
      });
    }

    window.openTextEditModal = openTextEditModal;
    window.closeTextEditModal = closeTextEditModal;
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





  // ─── Control Center Controller (Universal Special Pipeline) ──────────────────────────────
  function setupControlCenter() {
    const ccActionsGroup = $('#ccActionsGroup');
    const ccIndicator = $('#ccIndicator');
    const ccText = $('#ccText');
    const ccIPPort = $('#ccIPPort');
    const ccDirPath = $('#ccDirPath');
    const btnCcChangeDir = $('#btnCcChangeDir');
    const btnCcToggle = $('#btnCcToggle');
    const btnCcRestart = $('#btnCcRestart');
    const btnCcKillAll = $('#btnCcKillAll');
    let isCcServerRunning = true;
    let isCcServerRestarting = false;

    // Show control center action bar
    if (ccActionsGroup) ccActionsGroup.style.display = 'flex';

    // 1. IPC Status Listeners (when running inside Electron Desktop App)
    if (isElectron && ipcRenderer) {
      ipcRenderer.on('server-status', (event, status) => {
        isCcServerRunning = !!status.running;
        if (isCcServerRestarting && status.running) {
          isCcServerRestarting = false;
          if (btnCcRestart) {
            btnCcRestart.disabled = false;
            btnCcRestart.style.opacity = '1';
            btnCcRestart.classList.remove('spinning-icon');
          }
          if (btnCcToggle) {
            btnCcToggle.disabled = false;
            btnCcToggle.style.opacity = '1';
          }
        }
        updateControlCenterStatus(status);
        
        // Update desktop settings modal UI elements if open
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
        const saveDirInput = $('#saveDirInput');
        if (saveDirInput) saveDirInput.value = dir;
      });

      ipcRenderer.on('receive-file-completed', (event, { token, filename }) => {
        for (const [t, r] of activeShares.entries()) {
          if (r.files && r.files[token]) {
            r.files[token].savedFilename = filename;
            updateOverallShareStatus(t);
            break;
          }
        }
      });

      ipcRenderer.send('get-dir');
    }

    // Change Directory button
    if (btnCcChangeDir) {
      btnCcChangeDir.addEventListener('click', () => {
        if (isElectron && ipcRenderer) {
          ipcRenderer.send('change-dir');
        } else {
          showToast('Directory selection is managed via Settings in Web mode', 'info');
        }
      });
    }

    // Dynamic Start/Stop Toggle Button
    if (btnCcToggle) {
      btnCcToggle.addEventListener('click', async () => {
        btnCcToggle.disabled = true;
        btnCcToggle.style.opacity = '0.4';
        
        const nextAction = isCcServerRunning ? 'stop' : 'start';
        if (ccText) ccText.textContent = isCcServerRunning ? 'Stopping...' : 'Starting...';

        if (isElectron && ipcRenderer) {
          ipcRenderer.send(isCcServerRunning ? 'stop-server' : 'start-server');
        } else {
          try {
            await doFetch('/api/settings/server-control', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: nextAction })
            });
            showToast(`Server ${nextAction} command sent`, 'info');
            if (nextAction === 'stop') {
              isCcServerRunning = false;
              updateControlCenterStatus({ running: false });
            } else {
              isCcServerRunning = true;
              updateControlCenterStatus({ running: true, port: window.location.port || 5000, ip: window.location.hostname });
            }
          } catch (err) {
            showToast('Control command failed: ' + err.message, 'error');
            btnCcToggle.disabled = false;
            btnCcToggle.style.opacity = '1';
          }
        }
      });
    }

    // Restart Server Button — UNIVERSAL SPECIAL PIPELINE
    if (btnCcRestart) {
      btnCcRestart.addEventListener('click', async () => {
        isCcServerRestarting = true;
        btnCcRestart.disabled = true;
        btnCcRestart.style.opacity = '0.8';
        btnCcRestart.classList.add('spinning-icon');
        if (btnCcToggle) {
          btnCcToggle.disabled = true;
          btnCcToggle.style.opacity = '0.4';
        }
        if (ccText) ccText.textContent = 'Restarting...';

        if (isElectron && ipcRenderer) {
          ipcRenderer.send('restart-server');
        } else {
          try {
            await doFetch('/api/settings/server-control', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'restart' })
            });
            showToast('Server restart initiated', 'info');
          } catch (e) {
            showToast('Restart failed: ' + e.message, 'error');
          }
        }

        // Dedicated Liveness Polling Pipeline during Restart
        let attempts = 0;
        const maxAttempts = 15;
        const pollInterval = setInterval(async () => {
          attempts++;
          try {
            const res = await fetch('/api/settings/server-status', { cache: 'no-store' });
            if (res.ok) {
              const data = await res.json();
              if (data.running) {
                clearInterval(pollInterval);
                isCcServerRestarting = false;
                btnCcRestart.classList.remove('spinning-icon');
                btnCcRestart.disabled = false;
                btnCcRestart.style.opacity = '1';
                if (btnCcToggle) {
                  btnCcToggle.disabled = false;
                  btnCcToggle.style.opacity = '1';
                }
                updateControlCenterStatus({ running: true, port: data.port, ip: data.ip });
                showToast('Server restarted successfully', 'success');
              }
            }
          } catch (_) {
            // Server offline while restarting; keep polling until back online!
          }

          if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
            isCcServerRestarting = false;
            btnCcRestart.classList.remove('spinning-icon');
            btnCcRestart.disabled = false;
            btnCcRestart.style.opacity = '1';
            if (btnCcToggle) btnCcToggle.disabled = false;
          }
        }, 1000);
      });
    }

    // Force Kill All Processes Button
    if (btnCcKillAll) {
      btnCcKillAll.addEventListener('click', async () => {
        if (confirm("Are you sure you want to force close AiroDrop and all background processes?")) {
          if (isElectron && ipcRenderer) {
            ipcRenderer.send('force-kill-all');
          } else {
            try {
              await doFetch('/api/settings/server-control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'kill' })
              });
              showToast('Server processes terminated', 'warning');
            } catch (err) {
              showToast('Kill process failed', 'error');
            }
          }
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
        btnCheckUpdates.textContent = 'Checking...';
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
            btnCheckUpdates.textContent = 'Check for Updates';
          }
        }
      }
    };

    // ─── Windows Settings GUI Dedicated Page Navigation & Modal Controls ─────────
    const btnHeaderSettings = document.getElementById('btnHeaderSettings');
    const btnCancelSettings = document.getElementById('btnCancelSettings');
    const btnCloseSettings = document.getElementById('btnCloseSettings');
    const settingsModal = document.getElementById('settingsModal');

    const closeSettingsModal = () => {
      if (settingsModal) settingsModal.style.display = 'none';
      if (btnHeaderSettings) {
        btnHeaderSettings.blur();
        btnHeaderSettings.classList.remove('glow');
      }
    };

    if (btnHeaderSettings) {
      btnHeaderSettings.addEventListener('click', () => {
        switchDesktopTab('settings');
      });
    }

    // Dedicated Page Tab Navigation Handler
    const winNavItems = document.querySelectorAll('.win-nav-item');
    const winSections = document.querySelectorAll('.win-section-group');

    if (winNavItems.length > 0) {
      winNavItems.forEach(item => {
        item.addEventListener('click', () => {
          winNavItems.forEach(nav => nav.classList.remove('active'));
          item.classList.add('active');
          const targetId = item.getAttribute('data-target');

          winSections.forEach(sec => {
            if (sec.id === targetId) {
              sec.style.display = 'flex';
            } else {
              sec.style.display = 'none';
            }
          });
        });
      });
    }

    if (btnStartUpdateDownload) {
      btnStartUpdateDownload.addEventListener('click', () => {
        if (isElectron && ipcRenderer) {
          ipcRenderer.send('start-download-update');
        } else {
          window.open('https://github.com/asepsayyad007/AiroDrop/releases/latest', '_blank');
        }
      });
    }

    if (btnQuitAndInstallUpdate) {
      btnQuitAndInstallUpdate.addEventListener('click', () => {
        if (isElectron && ipcRenderer) {
          ipcRenderer.send('quit-and-install-update');
        }
      });
    }

    if (btnCheckUpdates) {
      btnCheckUpdates.addEventListener('click', triggerManualCheck);
    }
    if (checkUpdatesManualBtn) {
      checkUpdatesManualBtn.addEventListener('click', triggerManualCheck);
    }

    if (isElectron && ipcRenderer) {
      ipcRenderer.on('update-status', (event, status, info) => {
        const updateBtnText = status === 'checking' ? 'Checking...' : 
                             status === 'downloading' ? 'Downloading...' :
                             status === 'available' ? 'Update Available' : 'Check for Updates';
        const manualBtnText = status === 'checking' ? 'Checking...' :
                             status === 'downloading' ? 'Downloading...' :
                             status === 'available' ? 'Update Available' : 'Check for Updates Now';
        const isBtnDisabled = status === 'checking' || status === 'available' || status === 'downloading';

        if (btnCheckUpdates) {
          btnCheckUpdates.disabled = isBtnDisabled;
          btnCheckUpdates.textContent = updateBtnText;
        }
        if (checkUpdatesManualBtn) {
          checkUpdatesManualBtn.disabled = isBtnDisabled;
          checkUpdatesManualBtn.textContent = manualBtnText;
        }

        const updateProgressDetails = $('#updateProgressDetails');

        switch (status) {
          case 'checking':
            if (updateStatusText) updateStatusText.textContent = 'Checking for updates...';
            if (updateProgressContainer) updateProgressContainer.style.display = 'none';
            if (updateActionContainer) updateActionContainer.style.display = 'none';
            break;
          case 'available':
            if (updateStatusText) {
              const ver = info && info.version ? info.version : '';
              updateStatusText.innerHTML = `<span style="color:var(--accent-light);font-weight:600;">v${ver} available</span>`;
            }
            if (updateActionContainer) {
              updateActionContainer.style.display = 'block';
              if (updateNotesBox) {
                const notes = info && info.releaseNotes ? (typeof info.releaseNotes === 'string' ? info.releaseNotes : JSON.stringify(info.releaseNotes)) : 'New version available for 1-click download.';
                updateNotesBox.textContent = `AiroDrop v${info.version || ''} Ready:\n${notes.slice(0, 300)}`;
              }
              if (btnStartUpdateDownload) {
                btnStartUpdateDownload.style.display = 'inline-flex';
                btnStartUpdateDownload.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Download &amp; Update Directly</span>`;
              }
              if (btnQuitAndInstallUpdate) btnQuitAndInstallUpdate.style.display = 'none';
            }
            break;
          case 'available-portable':
            if (updateStatusText) {
              const ver = info && info.version ? info.version : '';
              updateStatusText.innerHTML = `<span style="color:var(--accent-light);font-weight:600;">v${ver} (Portable)</span>`;
            }
            if (updateActionContainer) {
              updateActionContainer.style.display = 'block';
              if (updateNotesBox) {
                updateNotesBox.textContent = `Portable AiroDrop v${info.version || ''} is available on GitHub. Click below to download directly.`;
              }
              if (btnStartUpdateDownload) {
                btnStartUpdateDownload.style.display = 'inline-flex';
                btnStartUpdateDownload.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg><span>Download Portable Exe from GitHub</span>`;
              }
              if (btnQuitAndInstallUpdate) btnQuitAndInstallUpdate.style.display = 'none';
            }
            break;
          case 'downloading':
            showToast('Downloading update...', 'info');
            if (updateActionContainer) updateActionContainer.style.display = 'none';
            if (updateProgressContainer) updateProgressContainer.style.display = 'block';
            if (updateProgressBarFill) updateProgressBarFill.style.width = '0%';
            if (updateProgressPercent) updateProgressPercent.textContent = '0%';
            if (updateProgressLabel) updateProgressLabel.textContent = 'Downloading update...';
            if (updateProgressDetails) updateProgressDetails.textContent = 'Starting download...';
            if (updateStatusText) updateStatusText.textContent = 'Downloading...';
            break;
          case 'not-available':
            showToast('You are already running the latest version!', 'success');
            if (updateProgressContainer) updateProgressContainer.style.display = 'none';
            if (updateActionContainer) updateActionContainer.style.display = 'none';
            if (updateStatusText) updateStatusText.textContent = 'Up to date';
            if (checkUpdatesManualBtn) { checkUpdatesManualBtn.disabled = false; checkUpdatesManualBtn.textContent = 'Check for Updates Now'; }
            break;
          case 'error':
            showToast('Update check failed. Try again later.', 'error');
            if (updateProgressContainer) updateProgressContainer.style.display = 'none';
            if (updateActionContainer) updateActionContainer.style.display = 'none';
            if (updateStatusText) updateStatusText.textContent = 'Check failed — try again';
            if (checkUpdatesManualBtn) { checkUpdatesManualBtn.disabled = false; checkUpdatesManualBtn.textContent = 'Check for Updates Now'; }
            break;
          case 'downloaded':
            showToast('Update downloaded! Ready to install.', 'success');
            if (updateProgressContainer) updateProgressContainer.style.display = 'block';
            if (updateProgressBarFill) updateProgressBarFill.style.width = '100%';
            if (updateProgressPercent) updateProgressPercent.textContent = '100%';
            if (updateProgressLabel) updateProgressLabel.textContent = 'Download complete!';
            if (updateProgressDetails) updateProgressDetails.textContent = 'Click below to restart and install.';
            if (updateStatusText) updateStatusText.innerHTML = '<span style="color:#00d26a;font-weight:600;">Ready to install</span>';
            if (updateActionContainer) {
              updateActionContainer.style.display = 'block';
              if (updateNotesBox) updateNotesBox.textContent = `AiroDrop v${info.version || ''} downloaded cleanly. Click below to restart and update instantly.`;
              if (btnStartUpdateDownload) btnStartUpdateDownload.style.display = 'none';
              if (btnQuitAndInstallUpdate) {
                btnQuitAndInstallUpdate.style.display = 'inline-flex';
                btnQuitAndInstallUpdate.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg><span>Restart Now to Install</span>`;
              }
            }
            if (checkUpdatesManualBtn) { checkUpdatesManualBtn.disabled = false; checkUpdatesManualBtn.textContent = 'Check for Updates Now'; }
            break;
        }
      });

      ipcRenderer.on('update-download-progress', (event, progressObj) => {
        const pct = Math.round(progressObj.percent || 0);
        const transferredMB = ((progressObj.transferred || 0) / (1024 * 1024)).toFixed(1);
        const totalMB = ((progressObj.total || 0) / (1024 * 1024)).toFixed(1);
        const speedBytes = progressObj.bytesPerSecond || 0;
        const speedText = speedBytes >= 1024 * 1024 
          ? `${(speedBytes / (1024 * 1024)).toFixed(1)} MB/s` 
          : `${(speedBytes / 1024).toFixed(0)} KB/s`;

        if (updateProgressContainer) updateProgressContainer.style.display = 'block';
        if (updateProgressPercent) updateProgressPercent.textContent = `${pct}%`;
        if (updateProgressBarFill) updateProgressBarFill.style.width = `${pct}%`;
        if (updateProgressLabel) updateProgressLabel.textContent = `Downloading (${speedText})`;
        const updateProgressDetails = $('#updateProgressDetails');
        if (updateProgressDetails) {
          updateProgressDetails.textContent = progressObj.total > 0 
            ? `${transferredMB} MB of ${totalMB} MB downloaded` 
            : `${transferredMB} MB downloaded`;
        }
      });

      ipcRenderer.on('navigate-tab', (event, tabName) => {
        if (tabName === 'settings') {
          const tabBtn = document.querySelector('[data-tab="settings"]');
          if (tabBtn) tabBtn.click();
        }
      });
    }


    function updateControlCenterStatus(status) {
      const servicePulseRing = $('#servicePulseRing');
      const serviceStatusIcon = $('#serviceStatusIcon');
      const serviceStatusTitle = $('#serviceStatusTitle');
      const serviceStatusSubtitle = $('#serviceStatusSubtitle');

      if (status.running) {
        isCcServerRestarting = false;
        if (ccIndicator) {
          ccIndicator.style.backgroundColor = '#4ade80';
          ccIndicator.style.boxShadow = '0 0 8px rgba(74, 222, 128, 0.6)';
        }
        if (ccText) {
          ccText.textContent = 'Service Active';
          ccText.style.color = 'rgba(255, 255, 255, 0.78)';
          ccText.style.opacity = '1';
        }
        if (ccIPPort) {
          ccIPPort.textContent = `${status.ip}:${status.port}`;
          ccIPPort.style.color = '#a0a0b8';
        }
        const btnCcToggle = $('#btnCcToggle');
        if (btnCcToggle) {
          btnCcToggle.disabled = false;
          btnCcToggle.style.opacity = '1';
          btnCcToggle.style.pointerEvents = 'auto';
          btnCcToggle.title = 'Stop Server';
          btnCcToggle.classList.add('btn-running');
          btnCcToggle.classList.remove('btn-stopped');
          btnCcToggle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
        }
        if (btnCcRestart) {
          btnCcRestart.disabled = false;
          btnCcRestart.style.opacity = '1';
          btnCcRestart.style.pointerEvents = 'auto';
          btnCcRestart.classList.remove('spinning-icon');
        }

        if (servicePulseRing) servicePulseRing.style.display = 'block';
        if (serviceStatusIcon) {
          serviceStatusIcon.style.background = 'rgba(255, 255, 255, 0.08)';
          serviceStatusIcon.style.border = '1px solid rgba(255, 255, 255, 0.15)';
          serviceStatusIcon.style.boxShadow = '0 0 10px rgba(255, 255, 255, 0.2)';
          serviceStatusIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 8px; height: 8px;"><polyline points="20 6 9 17 4 12"/></svg>`;
        }
        if (serviceStatusTitle) serviceStatusTitle.textContent = 'AiroDrop Service Active';
        if (serviceStatusSubtitle) serviceStatusSubtitle.textContent = '';

        setConnectionStatus(true);
      } else {
        if (isCcServerRestarting) {
          if (ccIndicator) {
            ccIndicator.style.backgroundColor = '#facc15';
            ccIndicator.style.boxShadow = '0 0 8px rgba(250, 204, 21, 0.6)';
          }
          if (ccText) {
            ccText.textContent = 'Restarting...';
            ccText.style.color = 'rgba(250, 204, 21, 0.85)';
            ccText.style.opacity = '1';
          }
          if (btnCcRestart) {
            btnCcRestart.disabled = true;
            btnCcRestart.style.opacity = '0.8';
            btnCcRestart.style.pointerEvents = 'none';
            btnCcRestart.classList.add('spinning-icon');
          }
        } else {
          if (ccIndicator) {
            ccIndicator.style.backgroundColor = '#f87171';
            ccIndicator.style.boxShadow = '0 0 8px rgba(248, 113, 113, 0.5)';
          }
          if (ccText) {
            ccText.textContent = 'Service Inactive';
            ccText.style.color = 'rgba(255, 255, 255, 0.6)';
            ccText.style.opacity = '1';
          }
          if (ccIPPort) {
            ccIPPort.textContent = 'Offline';
            ccIPPort.style.color = '#8a8a9e';
          }
          const btnCcToggle = $('#btnCcToggle');
          if (btnCcToggle) {
            btnCcToggle.disabled = false;
            btnCcToggle.style.opacity = '1';
            btnCcToggle.style.pointerEvents = 'auto';
            btnCcToggle.title = 'Start Server';
            btnCcToggle.classList.add('btn-stopped');
            btnCcToggle.classList.remove('btn-running');
            btnCcToggle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
          }
          if (btnCcRestart) {
            btnCcRestart.disabled = true;
            btnCcRestart.style.opacity = '0.35';
            btnCcRestart.style.pointerEvents = 'none';
            btnCcRestart.classList.remove('spinning-icon');
          }

          if (servicePulseRing) servicePulseRing.style.display = 'none';
          if (serviceStatusIcon) {
            serviceStatusIcon.style.background = 'linear-gradient(135deg, #ff3b30, #c0241b)';
            serviceStatusIcon.style.boxShadow = '0 0 10px rgba(255,59,48,0.35)';
            serviceStatusIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" style="width: 8px; height: 8px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
          }
          if (serviceStatusTitle) serviceStatusTitle.textContent = 'AiroDrop Service Inactive';
          if (serviceStatusSubtitle) serviceStatusSubtitle.textContent = '';

          setConnectionStatus(false);
        }
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
    let pcIceQueue = [];

    const defaultIceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];

    ipcRenderer.on('screencast-start', async () => {
      console.log('[WebRTC] Screencast start request received. Capturing desktop...');
      
      // Cleanup previous capture session if active
      if (localStream) {
        try { localStream.getTracks().forEach(track => track.stop()); } catch (e) {}
        localStream = null;
      }
      if (pc) {
        try { pc.close(); } catch (e) {}
        pc = null;
      }
      pcIceQueue = [];

      try {
        // Try getDisplayMedia first (handled by setDisplayMediaRequestHandler in main.js)
        try {
          if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
            localStream = await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: true
            });
          }
        } catch (gdmErr) {
          console.warn('[WebRTC] getDisplayMedia failed, falling back to getUserMedia desktop source:', gdmErr);
        }

        if (!localStream) {
          // 1. Get desktop source ID from main process
          const sourceId = await ipcRenderer.invoke('get-screen-source');
          if (!sourceId) {
            console.error('[WebRTC] No desktop source ID found.');
            return;
          }

          // 2. Capture desktop media stream via getUserMedia
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
            try {
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
            } catch (videoErr) {
              console.warn('[WebRTC] Failed to capture video with constraints, falling back to video-only with NO constraints:', videoErr);
              localStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                  }
                }
              });
            }
          }
        }

        if (!localStream) {
          console.error('[WebRTC] Failed to acquire any desktop stream.');
          return;
        }

        // 3. Create peer connection
        pc = new RTCPeerConnection({
          iceServers: defaultIceServers
        });

        // Add tracks
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

        // ICE candidate exchange
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            ipcRenderer.send('send-webrtc-candidate', event.candidate);
          }
        };

        pc.onconnectionstatechange = () => {
          console.log('[WebRTC] Connection state changed:', pc ? pc.connectionState : 'closed');
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
          while (pcIceQueue.length > 0) {
            const candidate = pcIceQueue.shift();
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
              console.error('[WebRTC] Failed to add queued ICE candidate:', e);
            }
          }
        } catch (err) {
          console.error('[WebRTC] Failed to set remote description (Answer):', err);
        }
      }
    });

    ipcRenderer.on('webrtc-ice-candidate', async (event, candidate) => {
      if (pc) {
        if (pc.remoteDescription) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.error('[WebRTC] Failed to add ICE candidate:', err);
          }
        } else {
          pcIceQueue.push(candidate);
        }
      }
    });

    ipcRenderer.on('screencast-stop', () => {
      console.log('[WebRTC] Stopping local screen capture and peer connection...');
      if (localStream) {
        try { localStream.getTracks().forEach(track => track.stop()); } catch(e) {}
        localStream = null;
      }
      if (pc) {
        try { pc.close(); } catch(e) {}
        pc = null;
      }
      pcIceQueue = [];
    });

    // ─── WebRTC Microphone Streaming Receiver ──────────────────────
    let micPC = null;
    let micIceQueue = [];
    const mobileMicActiveBadge = $('#mobileMicActiveBadge');

    ipcRenderer.on('mic-offer', async (event, offer) => {
      console.log('[MicWebRTC] Received offer from mobile phone.');
      if (micPC) {
        try { micPC.close(); } catch (e) {}
      }
      micIceQueue = [];

      micPC = new RTCPeerConnection({
        iceServers: defaultIceServers
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
        while (micIceQueue.length > 0) {
          const cand = micIceQueue.shift();
          try {
            await micPC.addIceCandidate(new RTCIceCandidate(cand));
          } catch (e) {
            console.error('[MicWebRTC] Failed to add queued ICE candidate:', e);
          }
        }
      } catch (err) {
        console.error('[MicWebRTC] Failed to handle mobile mic offer:', err);
      }
    });

    ipcRenderer.on('mic-ice-candidate', async (event, candidate) => {
      if (micPC && candidate) {
        if (micPC.remoteDescription) {
          try {
            await micPC.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.error('[MicWebRTC] Failed to add ICE candidate:', err);
          }
        } else {
          micIceQueue.push(candidate);
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
  const RELAY_BASE_URL = 'https://airodrop.site';
  const RELAY_WS_URL  = 'wss://airodrop.site/ws';
  let selectedShareFiles = [];
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
      relayWs.binaryType = 'arraybuffer';
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

    relayWs.onmessage = (event) => {
      // Handle incoming binary chunks for active receive links
      if (event.data instanceof ArrayBuffer) {
        const buffer = event.data;
        try {
          const view = new DataView(buffer);
          const tokenLen = view.getUint8(0);
          const decoder = new TextDecoder('ascii');
          const fileId = decoder.decode(new Uint8Array(buffer, 1, tokenLen));
          const chunk = new Uint8Array(buffer, 1 + tokenLen).slice();
          
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
            
            if (typeof share.onRegistered === 'function') {
              share.onRegistered(msg.token, downloadUrl);
            } else {
              // Show generated link UI (single link fallback)
              const els = getShareLinkElements();
              const createBtn = $('#createShareBtn');

              if (els.urlEl) els.urlEl.textContent = downloadUrl;
              if (els.container) els.container.style.display = 'block';
              if (createBtn) {
                createBtn.disabled = false;
                createBtn.innerHTML = `
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                  Create Share Link
                `;
              }

              // Copy to clipboard automatically
              navigator.clipboard.writeText(downloadUrl)
                .then(() => showToast('Link created & copied!', 'success'))
                .catch(() => showToast('Link created!', 'success'));

              // Render Active Shares
              renderActiveShares();
              resetShareFileSelection(true);
            }
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
            const els = getShareLinkElements();
            const createBtn = $('#createReceiveBtn');

            if (els.urlEl) els.urlEl.textContent = uploadUrl;
            if (els.container) els.container.style.display = 'block';
            if (createBtn) {
              createBtn.disabled = false;
              createBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                Generate Receive Link
              `;
            }

            // Copy to clipboard automatically
            navigator.clipboard.writeText(uploadUrl)
              .then(() => showToast('Upload link created & copied!', 'success'))
              .catch(() => showToast('Upload link created!', 'success'));

            // Render Active Shares
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

            // Trigger system Desktop notification (debounced/aggregated)
            triggerAggregatedNotification(msg.filename, msg.size);
          }
          break;
        }

        case 'upload-cancelled': {
          const token = msg.token;
          const fileId = msg.fileId;
          const receive = activeShares.get(token);
          if (receive && receive.files && receive.files[fileId]) {
            delete receive.files[fileId];
            updateOverallShareStatus(token);
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
              const sendEls = { container: $('#sendShareLinkContainer'), urlEl: $('#sendShareLinkUrl') };
              const receiveEls = { container: $('#receiveShareLinkContainer'), urlEl: $('#receiveShareLinkUrl') };
              
              if (sendEls.urlEl && sendEls.urlEl.textContent === receive.url) {
                if (sendEls.container) sendEls.container.style.display = 'none';
              }
              if (receiveEls.urlEl && receiveEls.urlEl.textContent === receive.url) {
                if (receiveEls.container) receiveEls.container.style.display = 'none';
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

          // Stream the file in chunks asynchronously
          (async () => {
            try {
              await streamFileToRelay(token, share.file);
            } catch (err) {
              console.error('[RelayWS] Error streaming file:', err);
              sendRelayMessage({ type: 'stream-error', token, message: err.message });
              share.status = 'waiting';
              renderActiveShares();
            }
          })();
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
              const sendEls = { container: $('#sendShareLinkContainer'), urlEl: $('#sendShareLinkUrl') };
              const receiveEls = { container: $('#receiveShareLinkContainer'), urlEl: $('#receiveShareLinkUrl') };
              
              if (sendEls.urlEl && sendEls.urlEl.textContent === share.url) {
                if (sendEls.container) sendEls.container.style.display = 'none';
              }
              if (receiveEls.urlEl && receiveEls.urlEl.textContent === share.url) {
                if (receiveEls.container) receiveEls.container.style.display = 'none';
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
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
              Create Share Link
            `;
          }
          const createReceiveBtn = $('#createReceiveBtn');
          if (createReceiveBtn) {
            createReceiveBtn.disabled = false;
            createReceiveBtn.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
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

  let pendingNotificationTimeout = null;
  let pendingNotificationFiles = [];

  function triggerAggregatedNotification(filename, size) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      return;
    }

    pendingNotificationFiles.push({ filename, size });

    if (pendingNotificationTimeout) {
      clearTimeout(pendingNotificationTimeout);
    }

    pendingNotificationTimeout = setTimeout(() => {
      const count = pendingNotificationFiles.length;
      let title = "Incoming File Request";
      let body = "";

      if (count === 1) {
        const file = pendingNotificationFiles[0];
        body = `Your friend wants to send: ${file.filename} (${formatSize(file.size)})`;
      } else {
        title = "Incoming File Requests";
        const totalSize = pendingNotificationFiles.reduce((sum, f) => sum + f.size, 0);
        body = `Your friend wants to send ${count} files (Total: ${formatSize(totalSize)})`;
      }

      new Notification(title, {
        body: body,
        icon: 'logo.png'
      });

      pendingNotificationFiles = [];
      pendingNotificationTimeout = null;
    }, 1000);
  }

  function updateRelayStatus(status) {
    const indicator = $('#relayStatusIndicator');
    const label = $('#relayStatusText');
    if (!indicator || !label) return;

    const cards = [
      $('#sendSelectFileCard'),
      $('#sendExpiryCard'),
      $('#receiveSettingsCard')
    ];

    if (status === 'connected') {
      indicator.style.backgroundColor = '#00d26a';
      label.textContent = 'Relay Server: Connected';
      cards.forEach(card => {
        if (card) card.classList.remove('relay-offline-disabled');
      });
    } else if (status === 'connecting') {
      indicator.style.backgroundColor = '#ffaa00';
      label.textContent = 'Relay Server: Connecting...';
      cards.forEach(card => {
        if (card) card.classList.remove('relay-offline-disabled');
      });
    } else {
      indicator.style.backgroundColor = '#ff3b30';
      label.textContent = 'Relay Server: Disconnected';
      cards.forEach(card => {
        if (card) card.classList.add('relay-offline-disabled');
      });
    }
  }

  async function streamFileToRelay(token, file) {
    const CHUNK_SIZE = 512 * 1024; // 512 KB per chunk (8x increase for high throughput)
    const MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024; // 2 MB backpressure threshold
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

      // Backpressure control: pause reading if WebSocket outbound buffer exceeds threshold
      while (relayWs && relayWs.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await readSliceAsArrayBuffer(slice);

      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(buffer);
      } else {
        throw new Error('WebSocket closed during streaming');
      }

      offset += CHUNK_SIZE;
      // Zero artificial delay when buffer is clear — streams at full hardware/ISP speed!
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
          handleShareFileSelection(e.dataTransfer.files);
        }
      });

      fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
          handleShareFileSelection(fileInput.files);
        }
      });
    }

    if (createBtn) {
      createBtn.addEventListener('click', async () => {
        if (!selectedShareFiles || selectedShareFiles.length === 0) return;
        if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
          showToast('Not connected to relay server. Reconnecting...', 'error');
          initRelayWebSocket();
          return;
        }

        createBtn.disabled = true;

        let fileToShare;
        if (selectedShareFiles.length === 1) {
          fileToShare = selectedShareFiles[0];
          createBtn.innerHTML = `
            <svg class="spinner" viewBox="0 0 50 50" style="width:16px;height:16px;margin-right:8px;animation:rotate 2s linear infinite;display:inline-block;vertical-align:middle;"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5" stroke="var(--text-primary)" style="stroke-linecap:round;animation:dash 1.5s ease-in-out infinite;"></circle></svg>
            Generating Link...
          `;
        } else {
          createBtn.innerHTML = `
            <svg class="spinner" viewBox="0 0 50 50" style="width:16px;height:16px;margin-right:8px;animation:rotate 2s linear infinite;display:inline-block;vertical-align:middle;"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5" stroke="var(--text-primary)" style="stroke-linecap:round;animation:dash 1.5s ease-in-out infinite;"></circle></svg>
            Zipping ${selectedShareFiles.length} files...
          `;

          if (typeof JSZip !== 'undefined') {
            try {
              const zip = new JSZip();
              selectedShareFiles.forEach(f => zip.file(f.name, f));
              const blob = await zip.generateAsync({ type: 'blob' });
              const dateStr = new Date().toISOString().slice(0, 10);
              fileToShare = new File([blob], `airodrop-archive-${dateStr}.zip`, { type: 'application/zip' });
            } catch (err) {
              console.error('[Share] JSZip error:', err);
              fileToShare = selectedShareFiles[0]; // fallback
            }
          } else {
            fileToShare = selectedShareFiles[0];
          }

          createBtn.innerHTML = `
            <svg class="spinner" viewBox="0 0 50 50" style="width:16px;height:16px;margin-right:8px;animation:rotate 2s linear infinite;display:inline-block;vertical-align:middle;"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5" stroke="var(--text-primary)" style="stroke-linecap:round;animation:dash 1.5s ease-in-out infinite;"></circle></svg>
            Generating Link...
          `;
        }

        const expiryMode = document.querySelector('input[name="shareExpiry"]:checked').value;

        const newShare = {
          file: fileToShare,
          status: 'registering',
          bytesTransferred: 0,
          percent: 0,
          expiryMode
        };
        activeShares.set('_registering', newShare);

        sendRelayMessage({
          type: 'register-share',
          filename: fileToShare.name,
          size: fileToShare.size,
          mimeType: fileToShare.type || 'application/octet-stream',
          expiryMode
        });
      });
    }

    // Segmented expiry control selection listener
    document.addEventListener('click', (e) => {
      const segmentBtn = e.target.closest('.expiry-segment-btn');
      if (segmentBtn) {
        const parent = segmentBtn.parentElement;
        if (parent) {
          parent.querySelectorAll('.expiry-segment-btn').forEach(btn => btn.classList.remove('active'));
          segmentBtn.classList.add('active');
        }
      }
    });

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

        const activeSegment = document.querySelector('.expiry-segment-btn.active');
        const expiryMode = activeSegment ? activeSegment.getAttribute('data-value') : 'download';

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

    const openReceiveSaveDirBtn = $('#openReceiveSaveDirBtn');
    if (openReceiveSaveDirBtn) {
      openReceiveSaveDirBtn.addEventListener('click', () => {
        if (isElectron) {
          ipcRenderer.send('open-save-directory');
        } else {
          showToast('Opening folder is only supported on the desktop app.', 'info');
        }
      });
    }

    const clearShareFileBtn = $('#clearShareFileBtn');

    if (clearShareFileBtn) {
      clearShareFileBtn.addEventListener('click', () => resetShareFileSelection(false));
    }

    // Helper to handle copying link to clipboard
    const handleCopyClick = (urlElId) => {
      const linkUrl = $(urlElId).textContent;
      if (linkUrl) {
        navigator.clipboard.writeText(linkUrl);
        showToast('Copied to clipboard!', 'success');
      }
    };

    // Helper to handle revoking a link
    const handleRevokeClick = (urlElId, containerId) => {
      const linkUrl = $(urlElId).textContent;
      if (!linkUrl) return;
      
      const parts = linkUrl.split('/');
      const token = parts[parts.length - 1];
      
      if (token) {
        sendRelayMessage({ type: 'cancel-share', token });
        activeShares.delete(token);
        renderActiveShares();
        showToast('Share link revoked.', 'info');
        
        const linkContainer = $(containerId);
        if (linkContainer) linkContainer.style.display = 'none';
      }
    };

    const copySendBtn = $('#copySendShareLinkBtn');
    if (copySendBtn) {
      copySendBtn.addEventListener('click', () => handleCopyClick('#sendShareLinkUrl'));
    }

    const copyReceiveBtn = $('#copyReceiveShareLinkBtn');
    if (copyReceiveBtn) {
      copyReceiveBtn.addEventListener('click', () => handleCopyClick('#receiveShareLinkUrl'));
    }

    const revokeSendBtn = $('#revokeSendShareLinkBtn');
    if (revokeSendBtn) {
      revokeSendBtn.addEventListener('click', () => handleRevokeClick('#sendShareLinkUrl', '#sendShareLinkContainer'));
    }

    const revokeReceiveBtn = $('#revokeReceiveShareLinkBtn');
    if (revokeReceiveBtn) {
      revokeReceiveBtn.addEventListener('click', () => handleRevokeClick('#receiveShareLinkUrl', '#receiveShareLinkContainer'));
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

            const sendUrlEl = $('#sendShareLinkUrl');
            const receiveUrlEl = $('#receiveShareLinkUrl');
            if (sendUrlEl && sendUrlEl.textContent.endsWith('/' + token)) {
              const sendContainer = $('#sendShareLinkContainer');
              if (sendContainer) sendContainer.style.display = 'none';
            }
            if (receiveUrlEl && receiveUrlEl.textContent.endsWith('/' + token)) {
              const receiveContainer = $('#receiveShareLinkContainer');
              if (receiveContainer) receiveContainer.style.display = 'none';
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

        // Download All
        const downloadAllBtn = e.target.closest('.download-all-btn');
        if (downloadAllBtn) {
          const token = downloadAllBtn.getAttribute('data-token');
          const share = activeShares.get(token);
          if (share && share.files) {
            const pendingFiles = Object.values(share.files).filter(f => f.status === 'pending_accept');
            pendingFiles.forEach(file => {
              acceptUpload(token, file.id);
            });
          }
          return;
        }

        // Download Checked
        const downloadCheckedBtn = e.target.closest('.download-checked-btn');
        if (downloadCheckedBtn) {
          const token = downloadCheckedBtn.getAttribute('data-token');
          const chks = document.querySelectorAll(`.file-select-chk[data-token="${token}"]:checked`);
          if (chks.length === 0) {
            showToast('No files checked!', 'warning');
          } else {
            chks.forEach(chk => {
              const fileId = chk.getAttribute('data-file-id');
              acceptUpload(token, fileId);
            });
          }
          return;
        }

        // Cancel Checked
        const cancelCheckedBtn = e.target.closest('.cancel-checked-btn');
        if (cancelCheckedBtn) {
          const token = cancelCheckedBtn.getAttribute('data-token');
          const chks = document.querySelectorAll(`.file-select-chk[data-token="${token}"]:checked`);
          if (chks.length === 0) {
            showToast('No files checked!', 'warning');
          } else {
            chks.forEach(chk => {
              const fileId = chk.getAttribute('data-file-id');
              declineUpload(token, fileId);
            });
          }
          return;
        }

        // Clear Finished
        const clearFinishedBtn = e.target.closest('.clear-finished-btn');
        if (clearFinishedBtn) {
          const token = clearFinishedBtn.getAttribute('data-token');
          const share = activeShares.get(token);
          if (share && share.files) {
            Object.keys(share.files).forEach(fileId => {
              const file = share.files[fileId];
              if (['completed', 'declined', 'failed'].includes(file.status)) {
                delete share.files[fileId];
              }
            });
            updateOverallShareStatus(token);
            showToast('Cleared finished files from queue', 'success');
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

  function handleShareFileSelection(input) {
    let files = [];
    if (input instanceof FileList || Array.isArray(input)) {
      files = Array.from(input);
    } else if (input instanceof File) {
      files = [input];
    }
    if (files.length === 0) return;

    selectedShareFiles = files;

    const fileDrop = $('#shareFileDrop');
    const preview = $('#shareFilePreview');
    const previewImg = $('#sharePreviewImg');
    const previewIcon = $('#shareFilePreviewIcon');
    const fileName = $('#shareFileName');
    const multiList = $('#shareMultiFileList');
    const clearBtn = $('#clearShareFileBtn');
    const createBtn = $('#createShareBtn');

    if (!fileDrop || !preview || !previewImg || !previewIcon || !fileName || !createBtn) return;

    fileDrop.style.display = 'none';
    preview.style.display = 'flex';
    createBtn.disabled = false;

    if (files.length === 1) {
      const file = files[0];
      if (multiList) multiList.style.display = 'none';
      fileName.style.display = 'block';
      fileName.textContent = `${file.name} (${formatSize(file.size)})`;
      if (clearBtn) clearBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        Remove File
      `;

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
        previewIcon.innerHTML = getFileTypeSvg(file.type);
      }
    } else {
      // Multiple files mode
      previewImg.style.display = 'none';
      previewIcon.style.display = 'block';
      previewIcon.innerHTML = '<svg class="icon-svg lg" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      fileName.style.display = 'block';
      fileName.textContent = `${files.length} Files Selected (Total: ${formatSize(totalSize)})`;

      if (clearBtn) clearBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        Remove All (${files.length} files)
      `;

      if (multiList) {
        multiList.style.display = 'flex';
        multiList.innerHTML = '';
        files.forEach((f, idx) => {
          const item = document.createElement('div');
          item.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:4px 8px; background:rgba(255,255,255,0.03); border-radius:6px; font-size:0.75rem; width:100%; box-sizing:border-box;';

          const ext = f.name.split('.').pop().toLowerCase();
          let icon = getFileTypeSvg(f.type || ext);

          item.innerHTML = `
            <span style="display:flex; align-items:center; gap:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:85%;">
              <span>${icon}</span>
              <span style="overflow:hidden; text-overflow:ellipsis; color:var(--text-primary);">${f.name}</span>
              <span style="color:var(--text-secondary); font-size:0.68rem;">(${formatSize(f.size)})</span>
            </span>
          `;

          const removeSingleBtn = document.createElement('button');
          removeSingleBtn.style.cssText = 'background:none; border:none; color:#ff6b6b; cursor:pointer; padding:2px 4px; font-size:0.8rem; line-height:1; border-radius:4px;';
          removeSingleBtn.textContent = '×';
          removeSingleBtn.title = 'Remove file';
          removeSingleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedShareFiles.splice(idx, 1);
            if (selectedShareFiles.length === 0) {
              resetShareFileSelection(false);
            } else {
              handleShareFileSelection(selectedShareFiles);
            }
          });

          item.appendChild(removeSingleBtn);
          multiList.appendChild(item);
        });
      }
    }
  }

  function resetShareFileSelection(keepLinkContainer = false) {
    selectedShareFiles = [];
    const fileInput = $('#shareFileInput');
    if (fileInput) fileInput.value = '';

    const fileDrop = $('#shareFileDrop');
    const preview = $('#shareFilePreview');
    const multiList = $('#shareMultiFileList');
    const createBtn = $('#createShareBtn');
    const linkContainer = $('#sendShareLinkContainer');

    if (fileDrop) fileDrop.style.display = 'flex';
    if (preview) preview.style.display = 'none';
    if (multiList) {
      multiList.style.display = 'none';
      multiList.innerHTML = '';
    }
    if (createBtn) {
      createBtn.disabled = true;
      createBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
        Create Share Link
      `;
    }
    if (!keepLinkContainer) {
      if (linkContainer) linkContainer.style.display = 'none';
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
      let icon = '<svg class="icon-svg md" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

      if (share.direction === 'receive') {
        const fileList = Object.values(share.files || {});
        let hasPending = false;
        
        if (fileList.length > 0) {
          hasPending = fileList.some(f => f.status === 'pending_accept');
          
          filesHtml = `<div class="receive-files-stack" style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">`;
          filesHtml += fileList.map(file => {
            let rowStatusText = file.status;
            let badgeClass = file.status;
            let fileActions = '';
            let checkboxHtml = '';
            
            if (file.status === 'pending_accept') {
              rowStatusText = 'Pending Accept';
              badgeClass = 'waiting';
              checkboxHtml = `<input type="checkbox" class="file-select-chk" data-token="${token}" data-file-id="${file.id}" checked style="margin-right: 10px; cursor: pointer; transform: scale(1.2); accent-color: var(--accent); flex-shrink: 0;">`;
              fileActions = `
                <button class="active-share-accept-btn" data-token="${token}" data-file-id="${file.id}" title="Download" style="background: rgba(0, 210, 106, 0.15) !important; color: #00d26a !important; border: 1px solid rgba(0, 210, 106, 0.25) !important; border-radius: 4px; padding: 4px 8px; font-size: 0.68rem; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 2px;">
                  Download
                </button>
              `;
            } else if (file.status === 'receiving') {
              rowStatusText = `Receiving ${file.percent || 0}%`;
              badgeClass = 'downloading';
            } else if (file.status === 'completed') {
              rowStatusText = 'Received';
              badgeClass = 'completed';
              const safeFolderFilename = escapeAttr(file.savedFilename || file.name);
              fileActions = `
                <button class="active-share-folder-btn" data-filename="${safeFolderFilename}" title="Reveal in Folder" style="background: rgba(0, 136, 204, 0.15) !important; color: #33a3ff !important; border: 1px solid rgba(0, 136, 204, 0.25) !important; border-radius: 4px; padding: 4px 8px; font-size: 0.68rem; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 2px;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                  Reveal
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
          let icon = getFileTypeSvg(file.mimeType || file.type || ext);
          if (file.preview) {
            const safeSrc = escapeAttr(file.preview);
            icon = `<img src="${safeSrc}" style="width: 32px; height: 32px; border-radius: 6px; object-fit: cover; border: 1px solid rgba(255,255,255,0.05); display: block;">`;
          }

          const safeFileName = escapeHtml(file.name);
          const safeFileNameAttr = escapeAttr(file.name);

          return `
            <div class="receive-file-row ${file.status === 'receiving' ? 'active' : ''}" id="file-item-${file.id}" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.03);">
              <div class="receive-file-left" style="display: flex; align-items: center; gap: 8px;">
                ${checkboxHtml}
                <span class="active-share-icon" style="font-size:0.9rem; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px;">${icon}</span>
                <div class="receive-file-info" style="display: flex; flex-direction: column;">
                  <span class="receive-file-name" title="${safeFileNameAttr}" style="font-size: 0.8rem; font-weight: 500; color: var(--text-primary); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${safeFileName}</span>
                  <span class="receive-file-size" style="font-size: 0.7rem; color: var(--text-secondary);">${formatSize(file.size)}</span>
                </div>
              </div>
              <div class="receive-file-actions" style="display: flex; align-items: center; gap: 8px;">
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
      const pendingFiles = fileList.filter(f => f.status === 'pending_accept');
      const hasFinished = fileList.some(f => ['completed', 'declined', 'failed'].includes(f.status));

      if (pendingFiles.length > 0 || hasFinished) {
        bulkActionsHtml = `<div class="receive-bulk-actions" style="display: flex; gap: 8px; margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px; flex-wrap: wrap; align-items: center; width: 100%;">`;
        if (pendingFiles.length > 0) {
          bulkActionsHtml += `<button class="btn-bulk-action download-all-btn" data-token="${token}" style="background: var(--accent) !important; color: #fff !important; padding: 6px 14px; font-size: 0.76rem; border-radius: 6px; cursor: pointer; border: none; font-weight: 600;">Download All</button>`;
          if (pendingFiles.length > 1) {
            bulkActionsHtml += `
              <button class="btn-bulk-action download-checked-btn" data-token="${token}" style="background: rgba(0, 210, 106, 0.12) !important; color: #00d26a !important; border: 1px solid rgba(0, 210, 106, 0.25) !important; padding: 6px 14px; font-size: 0.76rem; border-radius: 6px; cursor: pointer; font-weight: 600;">Download Checked</button>
              <button class="btn-bulk-action cancel-checked-btn" data-token="${token}" style="background: rgba(255, 59, 48, 0.12) !important; color: #ff3b30 !important; border: 1px solid rgba(255, 59, 48, 0.25) !important; padding: 6px 14px; font-size: 0.76rem; border-radius: 6px; cursor: pointer; font-weight: 600;">Cancel Checked</button>
            `;
          }
        }
        if (hasFinished) {
          bulkActionsHtml += `<button class="btn-bulk-action clear-finished-btn" data-token="${token}" style="background: rgba(255, 255, 255, 0.08) !important; color: var(--text-primary) !important; border: 1px solid rgba(255, 255, 255, 0.15) !important; padding: 6px 14px; font-size: 0.76rem; border-radius: 6px; cursor: pointer; font-weight: 600; margin-left: auto;">Clear Finished</button>`;
        }
        bulkActionsHtml += `</div>`;
      }

      name = `Receive Link (${fileList.length} files)`;
      meta = `Receive Link • Expiry: ${getFriendlyExpiry(share.expiryMode, true)}`;
      icon = '<svg class="icon-svg md" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

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
      
      name = escapeHtml(share.file.name);
      meta = `${formatSize(share.file.size)} • Send Link • Expiry: ${getFriendlyExpiry(share.expiryMode, false)}`;
      
      icon = getFileTypeSvg(share.file.type);
    }

      const safeItemName = escapeHtml(name);
      const safeItemNameAttr = escapeAttr(name);

      html += `
        <div class="active-share-item" id="share-item-${token}" style="flex-direction: column; align-items: stretch; gap: 8px;">
          <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
            <div class="active-share-info">
              <span class="active-share-icon">${icon}</span>
              <div class="active-share-details">
                <span class="active-share-name" title="${safeItemNameAttr}">${safeItemName}</span>
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

  function updateOverallShareStatus(token) {
    const share = activeShares.get(token);
    if (!share) return;

    if (share.direction === 'receive') {
      const fileList = Object.values(share.files || {});
      if (fileList.length === 0) {
        share.status = 'waiting';
      } else {
        const hasReceiving = fileList.some(f => f.status === 'receiving');
        const hasPending = fileList.some(f => f.status === 'pending_accept');
        
        if (hasReceiving) {
          share.status = 'receiving';
        } else if (hasPending) {
          share.status = 'pending_accept';
        } else {
          share.status = 'completed';
          
          // Auto-cleanup 1-time receive links when all files in the batch are complete/failed/declined
          if (share.expiryMode === 'download') {
            setTimeout(() => {
              const currentShare = activeShares.get(token);
              if (currentShare && currentShare.status === 'completed') {
                sendRelayMessage({ type: 'cancel-share', token });
                activeShares.delete(token);
                renderActiveShares();
                showToast('1-time receive link completed and expired.', 'info');
                
                const receiveUrlEl = $('#receiveShareLinkUrl');
                if (receiveUrlEl && receiveUrlEl.textContent.endsWith('/' + token)) {
                  const receiveContainer = $('#receiveShareLinkContainer');
                  if (receiveContainer) receiveContainer.style.display = 'none';
                }
              }
            }, 1500);
          }
        }
      }
    }
    renderActiveShares();
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
    updateOverallShareStatus(token);
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
    updateOverallShareStatus(token);
    showToast(`Declined: ${share.files[fileId].name}`, 'info');
  }

  function processSequentialQueue(token) {
    const share = activeShares.get(token);
    if (!share) return;

    if (share.downloadMode === 'sequential') {
      const nextFile = Object.values(share.files).find(f => f.status === 'pending_accept');
      if (nextFile) {
        acceptUpload(token, nextFile.id);
        return;
      }
    }
    updateOverallShareStatus(token);
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

  // ─── Accessibility: Modal Focus Trap & Keyboard Handling ────
  function setupModalAccessibility(modalEl, openTriggerEl) {
    if (!modalEl) return;

    // Close on Escape key
    modalEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        modalEl.style.display = 'none';
        if (openTriggerEl) {
          openTriggerEl.classList.remove('glow');
          openTriggerEl.focus();
        }
      }
    });

    // Set role and aria attributes
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
  }

  // Apply modal accessibility to known modals after DOM ready
  function applyAccessibility() {
    // Modals
    setupModalAccessibility($('#settingsModal'), $('#btnHeaderSettings'));
    setupModalAccessibility($('#logsModal'), $('#btnHeaderLogs'));
    setupModalAccessibility($('#shortcutsModal'), $('#btnHeaderShortcuts'));

    // Add aria-labels to icon-only buttons
    $$('.delete-btn').forEach(btn => {
      if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', 'Delete item');
    });

    // Add role=main to main content area
    const mainContent = $('#mainContent') || $('main') || $('.dashboard-container');
    if (mainContent && !mainContent.getAttribute('role')) {
      mainContent.setAttribute('role', 'main');
    }
  }

  // ─── Universal Media Lightbox Handler (Image Pan/Zoom, Video, Audio & PDF) ───
  let lightboxScale = 1;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;

  function updateLightboxZoom() {
    const img = document.getElementById('lightboxImage');
    const zoomText = document.getElementById('lightboxZoomLevel');
    if (img) {
      if (lightboxScale <= 1) {
        panX = 0;
        panY = 0;
        img.style.cursor = 'grab';
      } else {
        img.style.cursor = isDragging ? 'grabbing' : 'grab';
      }
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${lightboxScale})`;
      img.style.transition = isDragging ? 'none' : 'transform 0.15s cubic-bezier(0.16, 1, 0.3, 1)';
    }
    if (zoomText) {
      zoomText.textContent = `${Math.round(lightboxScale * 100)}%`;
    }
  }

  function resetMediaLightbox() {
    const img = document.getElementById('lightboxImage');
    const video = document.getElementById('lightboxVideo');
    const audio = document.getElementById('lightboxAudio');
    const audioBox = document.getElementById('lightboxAudioBox');
    const pdfFrame = document.getElementById('lightboxPdfFrame');

    lightboxScale = 1;
    panX = 0;
    panY = 0;
    isDragging = false;

    if (img) {
      img.style.display = 'none';
      img.src = '';
      img.style.transform = 'none';
    }
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.style.display = 'none';
    }
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (audioBox) audioBox.style.display = 'none';
    if (pdfFrame) {
      pdfFrame.src = '';
      pdfFrame.style.display = 'none';
    }
  }

  window.markFileDeletedOnDisk = function(itemId) {
    const item = allItems.find(i => i.id == itemId);
    if (item && !item.fileDeletedOnDisk) {
      item.fileDeletedOnDisk = true;
      renderFeed();
      showToast('This file was deleted from your saved folder on disk. Save it again or send a new copy.', 'warning');
    }
  };

  async function checkFileOnDisk(filename) {
    if (!filename) return true;
    try {
      const res = await fetch(`/api/check-file?filename=${encodeURIComponent(filename)}`);
      if (res.ok) {
        const data = await res.json();
        return !!data.exists;
      }
    } catch (_) {}
    return true;
  }

  window.openMediaPreview = function(src, name, fileTypeHint) {
    const modal = document.getElementById('globalImageLightbox');
    const title = document.getElementById('lightboxTitle');
    const zoomControls = document.getElementById('lightboxZoomControls');
    const downloadBtn = document.getElementById('btnLightboxDownload');
    const downloadText = document.getElementById('btnLightboxDownloadText');
    if (!modal || !src) return;

    const resolvedSrc = resolveMediaUrl(src);
    const cleanPath = (src.includes('?path=') ? decodeURIComponent(src.split('?path=')[1]) : src).split('?')[0];
    const fn = cleanPath.split('/').pop();
    const item = allItems.find(i => i.filename === fn || (i.originalName && i.originalName === fn));

    if (item && item.fileDeletedOnDisk) {
      showToast('This file was deleted from your saved folder on disk. Please save it again or send a new copy.', 'warning');
      return;
    }

    if (item && !src.includes('/files/download') && fn) {
      checkFileOnDisk(fn).then(exists => {
        if (!exists) {
          item.fileDeletedOnDisk = true;
          renderFeed();
          showToast('This file was deleted from your saved folder on disk. Please save it again or send a new copy.', 'warning');
          modal.style.display = 'none';
          resetMediaLightbox();
        }
      });
    }

    resetMediaLightbox();

    const urlPath = cleanPath.toLowerCase();
    const isImage = /\.(jpg|jpeg|png|gif|webp|svg|heic|bmp)$/i.test(urlPath) || fileTypeHint === 'image';
    const isVideo = /\.(mp4|mov|m4v|webm|ogv|avi|mkv)$/i.test(urlPath) || fileTypeHint === 'video';
    const isAudio = /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(urlPath) || fileTypeHint === 'audio';
    const isPdf = /\.pdf$/i.test(urlPath) || fileTypeHint === 'pdf';

    title.textContent = name || 'Media Preview';
    const isPermanentlySaved = item ? (!item.isTemporary || item.userSaved) : false;

    if (downloadBtn) {
      downloadBtn.removeAttribute('href');
      downloadBtn.removeAttribute('download');
      downloadBtn.style.display = isPermanentlySaved ? 'none' : 'inline-flex';
      downloadBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (item && item.id) {
          try {
            const res = await doFetch('/api/save-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id })
            });
            const data = await res.json();
            if (res.ok && data.success) {
              item.isTemporary = false;
              item.userSaved = true;
              renderFeed();
              showToast('Saved permanently to download folder!', 'success');
              downloadBtn.style.display = 'none';
            } else {
              showToast(data.error || 'Failed to save file', 'error');
            }
          } catch (_) {
            showToast('Failed to save file', 'error');
          }
        }
      };
    }

    if (isImage) {
      const img = document.getElementById('lightboxImage');
      if (img) {
        img.src = resolvedSrc;
        img.alt = name || 'Photo';
        img.style.display = 'block';
      }
      if (zoomControls) zoomControls.style.display = 'flex';
      if (downloadText) downloadText.textContent = 'Download Photo';
      updateLightboxZoom();
    } else if (isVideo) {
      const video = document.getElementById('lightboxVideo');
      if (video) {
        video.src = resolvedSrc;
        video.style.display = 'block';
        video.play().catch(() => {});
      }
      if (zoomControls) zoomControls.style.display = 'none';
      if (downloadText) downloadText.textContent = 'Download Video';
    } else if (isAudio) {
      const audio = document.getElementById('lightboxAudio');
      const audioBox = document.getElementById('lightboxAudioBox');
      const trackName = document.getElementById('lightboxAudioTrackName');
      if (audio && audioBox) {
        audio.src = resolvedSrc;
        if (trackName) trackName.textContent = name || 'Audio Track';
        audioBox.style.display = 'flex';
        audio.play().catch(() => {});
      }
      if (zoomControls) zoomControls.style.display = 'none';
      if (downloadText) downloadText.textContent = 'Download Music';
    } else if (isPdf) {
      const pdfFrame = document.getElementById('lightboxPdfFrame');
      if (pdfFrame) {
        pdfFrame.src = resolvedSrc;
        pdfFrame.style.display = 'block';
      }
      if (zoomControls) zoomControls.style.display = 'none';
      if (downloadText) downloadText.textContent = 'Download PDF';
    } else {
      // Fallback to Image
      const img = document.getElementById('lightboxImage');
      if (img) {
        img.src = resolvedSrc;
        img.style.display = 'block';
      }
      if (zoomControls) zoomControls.style.display = 'flex';
      if (downloadText) downloadText.textContent = 'Download File';
      updateLightboxZoom();
    }

    modal.style.display = 'flex';
  };

  window.openImageLightbox = function(src, name) {
    window.openMediaPreview(src, name, 'image');
  };

  // Mouse Drag Panning for Photo Zoom
  const imgEl = document.getElementById('lightboxImage');
  if (imgEl) {
    imgEl.addEventListener('mousedown', (e) => {
      if (lightboxScale > 1) {
        e.preventDefault();
        isDragging = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        imgEl.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (isDragging && lightboxScale > 1) {
        e.preventDefault();
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateLightboxZoom();
      }
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        if (imgEl) imgEl.style.cursor = 'grab';
      }
    });
  }

  const btnZoomIn = document.getElementById('btnLightboxZoomIn');
  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', (e) => {
      e.stopPropagation();
      lightboxScale = Math.min(4, parseFloat((lightboxScale + 0.25).toFixed(2)));
      updateLightboxZoom();
    });
  }

  const btnZoomOut = document.getElementById('btnLightboxZoomOut');
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', (e) => {
      e.stopPropagation();
      lightboxScale = Math.max(0.5, parseFloat((lightboxScale - 0.25).toFixed(2)));
      if (lightboxScale <= 1) { panX = 0; panY = 0; }
      updateLightboxZoom();
    });
  }

  const btnResetZoom = document.getElementById('btnLightboxResetZoom');
  if (btnResetZoom) {
    btnResetZoom.addEventListener('click', (e) => {
      e.stopPropagation();
      lightboxScale = 1;
      panX = 0;
      panY = 0;
      updateLightboxZoom();
    });
  }

  const lightboxMediaContainer = document.getElementById('lightboxMediaContainer');
  if (lightboxMediaContainer) {
    lightboxMediaContainer.addEventListener('wheel', (e) => {
      const img = document.getElementById('lightboxImage');
      if (img && img.style.display !== 'none') {
        e.preventDefault();
        if (e.deltaY < 0) {
          lightboxScale = Math.min(4, parseFloat((lightboxScale + 0.15).toFixed(2)));
        } else {
          lightboxScale = Math.max(0.5, parseFloat((lightboxScale - 0.15).toFixed(2)));
          if (lightboxScale <= 1) { panX = 0; panY = 0; }
        }
        updateLightboxZoom();
      }
    }, { passive: false });
  }

  const btnLightboxDownloadEl = document.getElementById('btnLightboxDownload');
  if (btnLightboxDownloadEl) {
    btnLightboxDownloadEl.addEventListener('click', () => {
      const src = btnLightboxDownloadEl.getAttribute('href');
      if (src) {
        const fn = src.split('/').pop();
        const item = allItems.find(i => i.filename === fn || (i.originalName && i.originalName === fn));
        if (item) {
          item.userSaved = true;
          renderFeed();
          btnLightboxDownloadEl.style.display = 'none';
          showToast('File saved permanently!', 'success');
        }
      }
    });
  }

  // Universal Click Trigger for Media Items (Photos, Videos, Music, PDFs) & Text Items
  document.addEventListener('click', (e) => {
    // 1. Text Card Click / Text Item Body Click
    const textCard = e.target.closest('.feed-item.type-text');
    if (textCard && !e.target.closest('.btn, .delete-btn, .copy-btn, .clear-card-btn, a')) {
      const id = textCard.getAttribute('id') ? textCard.getAttribute('id').replace('item-', '') : null;
      const item = allItems.find(i => i.id == id);
      if (item && window.openTextEditModal) {
        e.stopPropagation();
        window.openTextEditModal(item);
        return;
      }
    }

    // 2. Media Preview Click
    const cardEl = e.target.closest('.feed-item');
    const target = e.target.closest('img, .lightbox-trigger, .file-card-box, [data-preview-img]');
    if (target && target.id !== 'lightboxImage' && cardEl) {
      const id = cardEl.getAttribute('id') ? cardEl.getAttribute('id').replace('item-', '') : null;
      const item = allItems.find(i => i.id == id);
      if (item && item.type !== 'text') {
        const fileUrl = `${isElectron ? apiBase : ''}/received/${item.filename}`;
        const name = item.originalName || item.filename;
        if (!e.target.closest('.btn, .delete-btn, .copy-btn, .copy-img-btn, .save-dl-btn, .open-folder-btn, a')) {
          e.stopPropagation();
          window.openMediaPreview(fileUrl, name, item.type, item.mimeType);
        }
      }
    }
  });

  function closeLightboxModal() {
    const modal = document.getElementById('globalImageLightbox');
    if (modal) {
      modal.style.display = 'none';
      resetMediaLightbox();
    }
  }

  const btnCloseLight = document.getElementById('btnCloseLightbox');
  if (btnCloseLight) {
    btnCloseLight.addEventListener('click', closeLightboxModal);
  }

  const btnLightboxBackClose = document.getElementById('btnLightboxBackClose');
  if (btnLightboxBackClose) {
    btnLightboxBackClose.addEventListener('click', closeLightboxModal);
  }

  const modalLight = document.getElementById('globalImageLightbox');
  if (modalLight) {
    modalLight.addEventListener('click', (e) => {
      if (e.target === modalLight) closeLightboxModal();
    });
  }

  document.addEventListener('DOMContentLoaded', () => { init(); applyAccessibility(); });
})();