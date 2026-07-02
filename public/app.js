/**
 * app.js — Dashboard client-side logic
 * SSE for real-time updates, QR display, two-way send to phone
 */

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────
  let serverInfo = null;
  let allItems = [];
  let currentFilter = 'all';
  let sseSource = null;
  let isConnected = false;
  let lastTimestamp = '';

  // ─── DOM Elements ──────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const feedEl = $('#feed');
  const emptyStateEl = $('#emptyState');
  const feedCountEl = $('#feedCount');
  const connectionStatusEl = $('#connectionStatus');
  const serverUrlEl = $('#serverUrl');
  const serverUrlTextEl = $('#serverUrlText');
  const lightboxEl = $('#lightbox');
  const lightboxImgEl = $('#lightboxImg');
  const lightboxOverlayEl = $('#lightboxOverlay');
  const lightboxCloseEl = $('#lightboxClose');
  const lightboxDownloadEl = $('#lightboxDownload');
  const toastContainerEl = $('#toastContainer');

  // ─── Init ──────────────────────────────────────────────────
  async function init() {
    setupTabs();
    setupFilters();
    setupEventListeners();
    await fetchServerInfo();
    connectSSE();
    await fetchHistory();
  }

  // ─── Server Info ───────────────────────────────────────────
  async function fetchServerInfo() {
    try {
      const res = await fetch('/api/info');
      serverInfo = await res.json();
      updateServerInfoUI(serverInfo);
    } catch (err) {
      console.error('Failed to fetch server info:', err);
    }
  }

  function updateServerInfoUI(info) {
    serverUrlTextEl.textContent = info.url;
    const baseUrl = info.url;

    // iPhone Setup tab info
    const ipEl = $('#infoIP2');
    if (ipEl) ipEl.textContent = info.ip;
    const mobileUrlEl = $('#mobileUrl');
    if (mobileUrlEl) mobileUrlEl.textContent = `${baseUrl}/m`;
    const unifiedEl = $('#unifiedEndpoint');
    if (unifiedEl) unifiedEl.textContent = `${baseUrl}/api/send`;

    updateUptime(info.uptime);

    // Generate QR code for /m mobile page
    if (baseUrl) {
      const mobileUrl = `${baseUrl}/m`;
      if (typeof QRCode !== 'undefined') {
        QRCode.toDataURL(mobileUrl, { width: 240, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
          .then(dataUrl => {
            const container = $('#mobileQrContainer');
            if (container) container.innerHTML = `<img src="${dataUrl}" alt="Scan to setup iPhone" width="200" height="200">`;
          })
          .catch(() => {});
      } else {
        // Fetch QR from server
        fetch(`/api/info`).then(r => r.json()).then(d => {
          // Use server-generated QR as fallback, or generate via API
          const container = $('#mobileQrContainer');
          if (container && d.qrDataUrl) {
            // The server QR points to dashboard, we need one for /m
            // Use a simple approach: load the QRCode library from CDN
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js';
            script.onload = () => {
              QRCode.toDataURL(mobileUrl, { width: 240, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
                .then(dataUrl => { if (container) container.innerHTML = `<img src="${dataUrl}" alt="Scan to setup iPhone" width="200" height="200">`; })
                .catch(() => { if (container) container.innerHTML = `<a href="${mobileUrl}" target="_blank" style="color:var(--accent-light);font-size:0.85rem;">Open ${mobileUrl}</a>`; });
            };
            document.head.appendChild(script);
          }
        });
      }
    }
  }

  function updateUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    $('#infoUptime').textContent = parts.join(' ');
  }

  // ─── SSE Connection ────────────────────────────────────────
  function connectSSE() {
    if (sseSource) sseSource.close();

    sseSource = new EventSource('/api/events');

    sseSource.addEventListener('connected', (e) => {
      setConnectionStatus(true);
    });

    sseSource.addEventListener('new-item', (e) => {
      const item = JSON.parse(e.data);
      addItemToState(item);
      renderFeed();
      showToast(`${item.type === 'text' ? 'Text' : 'Image'} received`, 'success');
    });

    sseSource.addEventListener('phone-queued', (e) => {
      const item = JSON.parse(e.data);
      showToast('Item queued for iPhone', 'info');
      fetchPending();
    });

    sseSource.addEventListener('phone-ack', (e) => {
      showToast('iPhone picked up the item', 'success');
      fetchPending();
    });

    sseSource.onerror = () => {
      setConnectionStatus(false);
      // Reconnect after 3 seconds
      setTimeout(() => {
        if (!isConnected) connectSSE();
      }, 3000);
    };
  }

  function setConnectionStatus(connected) {
    isConnected = connected;
    const dot = connectionStatusEl.querySelector('.status-dot');
    const text = connectionStatusEl.querySelector('.status-text');
    if (connected) {
      dot.className = 'status-dot connected';
      text.textContent = 'Connected';
    } else {
      dot.className = 'status-dot disconnected';
      text.textContent = 'Disconnected — reconnecting...';
    }
  }

  // ─── History ───────────────────────────────────────────────
  async function fetchHistory() {
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      allItems = data.items;
      lastTimestamp = allItems.length > 0 ? allItems[0].timestamp : '';
      renderFeed();
    } catch (err) {
      console.error('Failed to fetch history:', err);
    }
  }

  function addItemToState(item) {
    // Avoid duplicates
    if (allItems.length > 0 && allItems[0].id === item.id) return;
    allItems.unshift(item);
    if (allItems.length > 100) allItems.pop();
    lastTimestamp = item.timestamp;
  }

  // ─── Render Feed ───────────────────────────────────────────
  function renderFeed() {
    const filtered = currentFilter === 'all'
      ? allItems
      : allItems.filter(i => i.type === currentFilter);

    feedCountEl.textContent = allItems.length;

    if (filtered.length === 0) {
      feedEl.innerHTML = '';
      feedEl.appendChild(emptyStateEl);
      emptyStateEl.style.display = '';
      return;
    }

    emptyStateEl.style.display = 'none';
    const fragment = document.createDocumentFragment();

    filtered.forEach((item) => {
      const el = document.createElement('div');
      el.className = `feed-item type-${item.type}`;
      el.dataset.id = item.id;

      if (item.type === 'text') {
        el.innerHTML = `
          <div class="item-header">
            <span class="item-type-badge text">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              Text
            </span>
            <span class="item-time">${formatTime(item.timestamp)}</span>
          </div>
          <div class="item-body">
            <div class="item-text-content">${escapeHtml(item.preview || item.content)}</div>
          </div>
          <div class="item-actions">
            <button class="btn-icon copy-btn" data-copy="${escapeAttr(item.content)}" title="Copy to clipboard">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        `;
      } else if (item.type === 'image') {
        const imgUrl = `/received/${encodeURIComponent(item.filename)}`;
        const sizeStr = item.size ? formatSize(item.size) : '';
        el.innerHTML = `
          <div class="item-header">
            <span class="item-type-badge image">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              Image
            </span>
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="item-meta">${sizeStr}</span>
              <span class="item-time">${formatTime(item.timestamp)}</span>
            </div>
          </div>
          <div class="item-image-preview" data-src="${imgUrl}">
            <img src="${imgUrl}" alt="${escapeAttr(item.originalName || item.filename)}" loading="lazy">
          </div>
          <div class="item-actions">
            <a class="btn btn-secondary" href="${imgUrl}" download="${escapeAttr(item.filename)}" title="Download">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download
            </a>
            <button class="btn-icon copy-filename-btn" data-copy="${escapeAttr(item.filename)}" title="Copy filename">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        `;
      }

      fragment.appendChild(el);
    });

    // Keep empty state in DOM but hidden
    feedEl.innerHTML = '';
    feedEl.appendChild(fragment);
    feedEl.appendChild(emptyStateEl);

    // Bind copy buttons
    feedEl.querySelectorAll('.copy-btn, .copy-filename-btn').forEach(btn => {
      btn.addEventListener('click', () => copyToClipboard(btn.dataset.copy, btn));
    });

    // Bind image previews for lightbox
    feedEl.querySelectorAll('.item-image-preview').forEach(preview => {
      preview.addEventListener('click', () => openLightbox(preview.dataset.src, preview.querySelector('img').alt));
    });
  }

  // ─── Tabs ──────────────────────────────────────────────────
  function setupTabs() {
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        $$('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        $(`#tab-${tab.dataset.tab}`).classList.add('active');

        // Refresh pending list when switching to send tab
        if (tab.dataset.tab === 'send') fetchPending();
      });
    });
  }

  // ─── Filters ───────────────────────────────────────────────
  function setupFilters() {
    $$('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderFeed();
      });
    });
  }

  // ─── Event Listeners ───────────────────────────────────────
  function setupEventListeners() {
    // Clear feed
    $('#clearFeed').addEventListener('click', () => {
      allItems = [];
      lastTimestamp = '';
      renderFeed();
      showToast('Feed cleared', 'info');
    });

    // Copy server URL
    serverUrlEl.addEventListener('click', () => {
      if (serverInfo) {
        copyToClipboard(serverInfo.url, serverUrlEl);
      }
    });

    // Lightbox
    lightboxOverlayEl.addEventListener('click', closeLightbox);
    lightboxCloseEl.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });

    // Send text to phone
    $('#sendTextBtn').addEventListener('click', sendTextToPhone);
    $('#sendTextInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendTextToPhone();
    });

    // Send image to phone
    const fileDrop = $('#fileDrop');
    const fileInput = $('#sendImageInput');
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
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        showSendImagePreview(file);
      }
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (file) showSendImagePreview(file);
    });
    $('#sendImageBtn').addEventListener('click', sendImageToPhone);
  }

  // ─── Send to Phone ─────────────────────────────────────────
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
      if (data.success) {
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

  let pendingImageBase64 = null;

  function showSendImagePreview(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingImageBase64 = e.target.result;
      $('#sendImagePreviewImg').src = pendingImageBase64;
      $('#sendImagePreview').style.display = 'flex';
      $('#fileDrop').style.display = 'none';
    };
    reader.readAsDataURL(file);
  }

  async function sendImageToPhone() {
    if (!pendingImageBase64) return;

    try {
      const res = await fetch('/api/send-to-phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'image', imageUrl: pendingImageBase64 })
      });
      const data = await res.json();
      if (data.success) {
        pendingImageBase64 = null;
        $('#sendImagePreview').style.display = 'none';
        $('#fileDrop').style.display = '';
        $('#sendImageInput').value = '';
        showToast('Image queued for iPhone', 'success');
        fetchPending();
      } else {
        showToast(data.error || 'Failed to queue image', 'error');
      }
    } catch {
      showToast('Failed to send image', 'error');
    }
  }

  async function fetchPending() {
    try {
      const res = await fetch('/api/pending');
      const data = await res.json();
      renderPending(data.items);
    } catch {
      // silently ignore
    }
  }

  function renderPending(items) {
    const list = $('#pendingList');
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-mini">No pending items</div>';
      return;
    }

    list.innerHTML = items.map(item => `
      <div class="pending-item">
        <span class="item-type-badge ${item.type}" style="flex-shrink:0;">
          ${item.type === 'text' ? 'T' : 'IMG'}
        </span>
        <span class="pending-text">${item.type === 'text' ? escapeHtml(item.content) : 'Image'}</span>
        <span class="pending-time">${formatTime(item.timestamp)}</span>
      </div>
    `).join('');
  }

  // ─── Lightbox ──────────────────────────────────────────────
  function openLightbox(src, alt) {
    lightboxImgEl.src = src;
    lightboxImgEl.alt = alt || '';
    lightboxDownloadEl.href = src;
    lightboxDownloadEl.download = alt || 'image';
    lightboxEl.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightboxEl.classList.remove('active');
    document.body.style.overflow = '';
  }

  // ─── Clipboard ─────────────────────────────────────────────
  async function copyToClipboard(text, btnEl) {
    try {
      await navigator.clipboard.writeText(text);
      if (btnEl) {
        btnEl.classList.add('copied');
        setTimeout(() => btnEl.classList.remove('copied'), 1500);
      }
      showToast('Copied to clipboard', 'success');
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Copied to clipboard', 'success');
    }
  }

  // ─── Toast Notifications ───────────────────────────────────
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        ${type === 'success' ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>' :
          type === 'error' ? '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' :
          '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'}
      </svg>
      ${escapeHtml(message)}
    `;
    toastContainerEl.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('removing');
      toast.addEventListener('animationend', () => toast.remove());
    }, 2500);
  }

  // ─── Utilities ─────────────────────────────────────────────
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

  // ─── Start ─────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();