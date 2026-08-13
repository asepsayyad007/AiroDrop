
    const SERVER = window.location.origin;


    function triggerHaptic(arg = 15) {
      if (localStorage.getItem('hapticFeedbackEnabled') === 'false') return;

      // 1. Android/Chrome native Vibration API
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate(arg);
        } catch (e) {}
      }

      // 2. iOS 18+ switch Taptic Engine workaround
      const iosLabel = document.getElementById('iosHapticLabel');
      const iosSwitch = document.getElementById('iosHapticSwitch');
      if (iosLabel) {
        try {
          iosLabel.click();
        } catch (e) {}
      }
      if (iosSwitch) {
        try {
          iosSwitch.checked = !iosSwitch.checked;
        } catch (e) {}
      }
    }

    // Universal touchstart listener for instant haptic feedback on button/tab touch down
    document.addEventListener('touchstart', (e) => {
      const el = e.target.closest('button, .btn, .bottom-nav-item, .btn-control-cmd, .btn-vlc-cmd, .header-refresh-btn, .switch, label, input[type="range"]');
      if (el) {
        triggerHaptic(15);
      }
    }, { passive: true });
    
    async function doFetch(url, options = {}) {
      const token = localStorage.getItem('deviceToken');
      if (token) {
        options.headers = options.headers || {};
        if (options.headers instanceof Headers) {
          options.headers.append('Authorization', `Bearer ${token}`);
        } else {
          options.headers['Authorization'] = `Bearer ${token}`;
        }
      }
      try {
        const res = await fetch(url, options);
        if (res.status === 401) {
          localStorage.removeItem('deviceToken');
          document.cookie = "airodrop_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
          showToast('Session expired or revoked. Re-authenticating...', 'error');
          setTimeout(() => {
            window.location.reload();
          }, 1200);
        }
        return res;
      } catch (err) {
        throw err;
      }
    }
    // (photo vars removed — not used in this page)

    // Auto-poll state
    let _autoPollTimer = null;
    let _lastCheckedTime = null;
    let _isReconnecting = false;
    let _reconnectTimer = null;
    let _reconnectCountdown = 15;

    function getCookie(name) {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) {
        let val = parts.pop().split(';').shift();
        if (val) {
          val = val.trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
        }
        return val;
      }
      return null;
    }

    // ─── Init ─────────────────────────────────────
    async function init() {
      let token = localStorage.getItem('deviceToken');
      if (!token || token === 'public-device') {
        const sessionCookie = getCookie('airodrop_session');
        if (sessionCookie) {
          localStorage.setItem('deviceToken', sessionCookie);
        } else {
          localStorage.setItem('deviceToken', 'public-device');
        }
      }
      initAppComponents();
    }

    function initAppComponents() {
      const storedToken = localStorage.getItem('deviceToken');
      
      // Hide loading fallback and reveal UI
      const fallback = document.getElementById('appLoadingFallback');
      if (fallback) fallback.style.display = 'none';
      const mainApp = document.getElementById('mainAppContainer');
      const bottomNav = document.getElementById('bottomNavContainer');
      if (mainApp) mainApp.style.display = 'block';
      if (bottomNav) bottomNav.style.display = 'flex';
      
      setupPWA();
      setupQuickPCActions();
      checkConnection();

      // Auto-connect PC Services on startup & restore on mid-disconnections
      wsWantsConnected = true;
      connectWS();

      window.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          checkConnection();
          fetchPending(false);
          if (wsWantsConnected && (!trackpadSocket || trackpadSocket.readyState !== WebSocket.OPEN)) {
            connectWS();
          }
        }
      });

      window.addEventListener('online', () => {
        checkConnection();
        fetchPending(false);
        if (wsWantsConnected && (!trackpadSocket || trackpadSocket.readyState !== WebSocket.OPEN)) {
          connectWS();
        }
      });

      window.addEventListener('focus', () => {
        checkConnection();
        if (wsWantsConnected && (!trackpadSocket || trackpadSocket.readyState !== WebSocket.OPEN)) {
          connectWS();
        }
      });
      const checkPendingBtn = document.getElementById('checkPendingBtn');
      if (checkPendingBtn) {
        checkPendingBtn.addEventListener('click', () => {
          fetchPending();
          updateLastChecked();
        });
      }
      
      const btnRefresh = document.getElementById('btnUniversalRefresh');
      if (btnRefresh) {
        btnRefresh.addEventListener('click', async () => {
          btnRefresh.style.transform = 'rotate(360deg)';
          btnRefresh.style.transition = 'transform 0.6s ease';
          setTimeout(() => {
            btnRefresh.style.transform = 'none';
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
      setupVlcControl();
      updateVlcStatus();
      setupMobileScreenshot();
      setupUniversalConnect();
      setupCreatorProfile();
      setupMobileTrackpad();
      setupScreencastOverlay();
      setupFileManager();
      
      // Update File Browser to use token
      const fileIframe = document.getElementById('fileManagerFrame');
      if (fileIframe && storedToken) {
        fileIframe.src = `/files?token=${storedToken}`;
      }


      setupFileBrowserOverlay();
      setupMicStream();
      initMobileSetupModal();

      // Setup Haptic Feedback Toggle Preference
      const hapticToggle = document.getElementById('hapticFeedbackToggle');
      if (hapticToggle) {
        const savedState = localStorage.getItem('hapticFeedbackEnabled');
        if (savedState !== null) {
          hapticToggle.checked = savedState === 'true';
        } else {
          hapticToggle.checked = true;
          localStorage.setItem('hapticFeedbackEnabled', 'true');
        }

        hapticToggle.addEventListener('change', () => {
          localStorage.setItem('hapticFeedbackEnabled', hapticToggle.checked ? 'true' : 'false');
          if (hapticToggle.checked) triggerHaptic(20);
        });
      }

      // ─── Smooth Directional Tab Navigation ─────────────────────
      const tabOrder = ['tabHome', 'tabTools', 'tabMedia', 'tabSettings'];

      function performTabSwitch(targetId, forceDirection = null) {
        if (!targetId) return;
        const targetContent = document.getElementById(targetId);
        if (!targetContent) return;

        const currentBtn = document.querySelector('.bottom-nav-item.active[data-tab]');
        const currentTabId = currentBtn ? currentBtn.getAttribute('data-tab') : null;
        if (currentTabId === targetId) return;

        triggerHaptic(12);

        const currentIndex = tabOrder.indexOf(currentTabId);
        const targetIndex = tabOrder.indexOf(targetId);

        let isNext = targetIndex > currentIndex;
        if (forceDirection === 'next') isNext = true;
        if (forceDirection === 'prev') isNext = false;

        // Reset previous tabs & animation classes
        document.querySelectorAll('.mobile-tab-content').forEach(c => {
          c.classList.remove('active', 'slide-in-right', 'slide-in-left');
          c.style.display = 'none';
        });
        document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));

        // Highlight new target nav button
        const targetBtn = document.querySelector(`.bottom-nav-item[data-tab="${targetId}"]`);
        if (targetBtn) targetBtn.classList.add('active');

        // Apply directional hardware-accelerated slide animation
        targetContent.style.display = 'block';
        targetContent.classList.add(isNext ? 'slide-in-right' : 'slide-in-left');
        targetContent.classList.add('active');

        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      // Setup Bottom Navigation Clicks
      document.querySelectorAll('.bottom-nav-item[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetId = btn.getAttribute('data-tab');
          performTabSwitch(targetId);
        });
      });

      // Horizontal Touch Swipe Gesture Support for Tabs
      (function setupSwipeTabs() {
        let touchStartX = 0;
        let touchStartY = 0;

        document.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1) return;
          if (e.target.closest('input, textarea, select, iframe, #trackpadOverlay, #screencastOverlay, #screenshotLightbox, #creatorLightbox, #mobileAppleSetupOverlay, #mobileAndroidSetupOverlay, #fileManagerOverlay, .bottom-nav')) return;
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
          if (!touchStartX || !touchStartY || e.changedTouches.length !== 1) return;
          if (e.target.closest('input, textarea, select, iframe, #trackpadOverlay, #screencastOverlay, #screenshotLightbox, #creatorLightbox, #mobileAppleSetupOverlay, #mobileAndroidSetupOverlay, #fileManagerOverlay, .bottom-nav')) return;

          const touchEndX = e.changedTouches[0].clientX;
          const touchEndY = e.changedTouches[0].clientY;
          const diffX = touchEndX - touchStartX;
          const diffY = touchEndY - touchStartY;

          touchStartX = 0;
          touchStartY = 0;

          // Must be horizontal swipe > 50px & predominantly horizontal
          if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY) * 1.4) {
            const currentBtn = document.querySelector('.bottom-nav-item.active[data-tab]');
            if (!currentBtn) return;
            const currentTabId = currentBtn.getAttribute('data-tab');
            const currentIndex = tabOrder.indexOf(currentTabId);
            if (currentIndex === -1) return;

            if (diffX < 0 && currentIndex < tabOrder.length - 1) {
              // Swipe Left -> Go Next Tab
              performTabSwitch(tabOrder[currentIndex + 1], 'next');
            } else if (diffX > 0 && currentIndex > 0) {
              // Swipe Right -> Go Previous Tab
              performTabSwitch(tabOrder[currentIndex - 1], 'prev');
            }
          }
        }, { passive: true });
      })();



      // Redirect legacy open file browser button to just open the overlay
      const btnLegacyOpenFileBrowser = document.getElementById('btnOpenFileBrowser');
      if (btnLegacyOpenFileBrowser) {
        btnLegacyOpenFileBrowser.addEventListener('click', () => {
          document.getElementById('fileBrowserOverlay').style.display = 'flex';
        });
      }

      // External link handler for mobile PWA/browser
      document.addEventListener('click', (e) => {
        const anchor = e.target.closest('a');
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:')) return;

        if (href.startsWith('http://') || href.startsWith('https://')) {
          e.preventDefault();
          window.open(href, '_blank', 'noopener,noreferrer');
        }
      });

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
        await updateVlcStatus();
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

        // Set fallback URL and setup modal status info
        document.querySelectorAll('.fallbackUrlText').forEach(el => el.textContent = `${info.url}/api/send`);
        const ipEl = document.getElementById('mobileInfoIp');
        if (ipEl) ipEl.textContent = info.ip || '...';
        const nameEl = document.getElementById('mobileInfoDeviceName');
        if (nameEl) nameEl.textContent = info.deviceName || 'PC';
        document.querySelectorAll('.mobileSetupIpCode').forEach(el => el.textContent = info.ip || '...');

        // Home Tab Connection Card updates
        const homeIpEl = document.getElementById('homeConnIp');
        if (homeIpEl) homeIpEl.textContent = info.ip || 'Local Network';
        const homeNameEl = document.getElementById('homeConnDeviceName');
        if (homeNameEl) homeNameEl.textContent = info.deviceName || 'PC';
        const homeStatusText = document.getElementById('homeConnStatusText');
        if (homeStatusText) {
          homeStatusText.textContent = 'PC Connected';
          homeStatusText.style.color = 'var(--text-primary)';
        }
        const homeBadge = document.getElementById('homeConnBadge');
        if (homeBadge) {
          homeBadge.style.background = 'rgba(255, 106, 0, 0.12)';
          homeBadge.style.borderColor = 'rgba(255, 106, 0, 0.3)';
          homeBadge.style.color = 'var(--accent-light)';
        }
      } catch {
        dot.className = 'dot err';
        const homeStatusText = document.getElementById('homeConnStatusText');
        if (homeStatusText) {
          homeStatusText.textContent = 'PC Offline';
          homeStatusText.style.color = 'var(--text-muted)';
        }
        const homeBadge = document.getElementById('homeConnBadge');
        if (homeBadge) {
          homeBadge.style.background = 'rgba(255, 255, 255, 0.05)';
          homeBadge.style.borderColor = 'var(--border)';
          homeBadge.style.color = 'var(--text-muted)';
        }
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

    function initMobileSetupModal() {
      // Elements for Apple iOS Setup Overlay
      const btnAppleSetup = document.getElementById('btnAppleSetup');
      const modalApple = document.getElementById('mobileAppleSetupOverlay');
      const btnCloseApple = document.getElementById('btnCloseAppleSetup');
      
      const btnAppleRefresh = document.getElementById('btnAppleRefresh');
      const btnAppleCopyUrl = document.getElementById('btnAppleCopyUrl');
      const btnAppleLogout = document.getElementById('btnAppleLogout');

      // Elements for Android Setup Overlay
      const btnAndroidSetup = document.getElementById('btnAndroidSetup');
      const modalAndroid = document.getElementById('mobileAndroidSetupOverlay');
      const btnCloseAndroid = document.getElementById('btnCloseAndroidSetup');

      const btnAndroidRefresh = document.getElementById('btnAndroidRefresh');
      const btnAndroidCopyUrl = document.getElementById('btnAndroidCopyUrl');
      const btnAndroidLogout = document.getElementById('btnAndroidLogout');

      const btnHelpBadge = document.getElementById('btnMobileHelpBadge');

      // Helper function for quick refresh
      const handleRefresh = async (btn) => {
        triggerHaptic(30);
        btn.disabled = true;
        const origContent = btn.innerHTML;
        btn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s infinite linear;"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          <span>Refreshing...</span>
        `;
        await checkConnection();
        await fetchPending();
        btn.disabled = false;
        btn.innerHTML = origContent;
        showToast('Connection refreshed!', 'success');
      };

      // Helper function for copy dashboard url
      const handleCopyUrl = () => {
        triggerHaptic(20);
        navigator.clipboard.writeText(window.location.href).then(() => {
          showToast('Mobile Dashboard URL copied!', 'success');
        }).catch(() => {
          showToast('Unable to copy URL automatically', 'error');
        });
      };

      // Helper function for logout
      const handleLogout = () => {
        triggerHaptic([30, 50, 30]);
        if (confirm('Re-authenticate or log out from PC? This will wipe your session token.')) {
          localStorage.removeItem('deviceToken');
          document.cookie = "airodrop_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
          showToast('Session logged out. Reloading...', 'info');
          setTimeout(() => {
            window.location.reload();
          }, 1000);
        }
      };

      // Apple Setup Modal triggers
      if (btnAppleSetup && modalApple) {
        btnAppleSetup.addEventListener('click', () => {
          triggerHaptic(20);
          modalApple.style.display = 'flex';
          if (btnHelpBadge) btnHelpBadge.style.display = 'none';
          try { localStorage.setItem('airodrop_setup_badge_dismissed', 'true'); } catch (e) {}
        });
      }
      if (btnCloseApple && modalApple) {
        btnCloseApple.addEventListener('click', () => {
          triggerHaptic(15);
          modalApple.style.display = 'none';
        });
      }

      // Android Setup Modal triggers
      if (btnAndroidSetup && modalAndroid) {
        btnAndroidSetup.addEventListener('click', () => {
          triggerHaptic(20);
          modalAndroid.style.display = 'flex';
          if (btnHelpBadge) btnHelpBadge.style.display = 'none';
          try { localStorage.setItem('airodrop_setup_badge_dismissed', 'true'); } catch (e) {}
        });
      }
      if (btnCloseAndroid && modalAndroid) {
        btnCloseAndroid.addEventListener('click', () => {
          triggerHaptic(15);
          modalAndroid.style.display = 'none';
        });
      }

      // Help badge default open (fallback to Apple setup overlay)
      if (btnHelpBadge && modalApple) {
        btnHelpBadge.addEventListener('click', () => {
          triggerHaptic(20);
          modalApple.style.display = 'flex';
          btnHelpBadge.style.display = 'none';
          try { localStorage.setItem('airodrop_setup_badge_dismissed', 'true'); } catch (e) {}
        });
      }

      // Apple modal actions
      if (btnAppleRefresh) btnAppleRefresh.addEventListener('click', () => handleRefresh(btnAppleRefresh));
      if (btnAppleCopyUrl) btnAppleCopyUrl.addEventListener('click', handleCopyUrl);
      if (btnAppleLogout) btnAppleLogout.addEventListener('click', handleLogout);

      // Android modal actions
      if (btnAndroidRefresh) btnAndroidRefresh.addEventListener('click', () => handleRefresh(btnAndroidRefresh));
      if (btnAndroidCopyUrl) btnAndroidCopyUrl.addEventListener('click', handleCopyUrl);
      if (btnAndroidLogout) btnAndroidLogout.addEventListener('click', handleLogout);
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
      const defIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      if (!mimeType) return defIcon;
      const type = mimeType.toLowerCase();
      if (type.startsWith('image/')) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
      }
      if (type.startsWith('video/')) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7a2 2 0 0 0-2.45-1.45L16 7.5V5a2 2 0 0 0-2-2H2a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5l4.55 1.95A2 2 0 0 0 23 17V7z"/></svg>`;
      }
      if (type.startsWith('audio/')) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
      }
      if (type.includes('pdf')) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      }
      if (type.includes('zip') || type.includes('rar') || type.includes('7z') || type.includes('tar') || type.includes('gzip')) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;
      }
      if (type.includes('word') || type.includes('document') || type.includes('officedocument')) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
      }
      if (type.includes('sheet') || type.includes('excel') || type.includes('csv')) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
      }
      if (type.includes('presentation') || type.includes('powerpoint')) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
      }
      if (type.includes('text/')) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
      }
      return defIcon;
    }

    let _lastNewestItemId = null;

    function formatFileSize(bytes) {
      if (!bytes || isNaN(bytes)) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    function timeAgo(timestamp) {
      if (!timestamp) return 'Just now';
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return 'Just now';
      const diffSec = Math.floor((new Date() - date) / 1000);
      if (diffSec < 45) return 'Just now';
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      return `${Math.floor(diffSec / 86400)}d ago`;
    }

    function renderPending(items) {
      const fileList = document.getElementById('fileInboxList');
      if (!fileList) return;

      const validItems = items || [];
      if (validItems.length === 0) {
        fileList.innerHTML = '<div class="empty-receive">No recent transfers</div>';
        return;
      }

      fileList.innerHTML = validItems.map(item => {
        if (item.type === 'text') {
          const isUrl = typeof item.content === 'string' && (item.content.startsWith('http://') || item.content.startsWith('https://'));
          const direction = item.direction || 'Received';
          const typeLabel = isUrl ? 'Link' : 'Text';
          const subtitle = `${direction} · ${typeLabel}`;
          const icon = isUrl 
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

          return `
            <div class="receive-item" style="cursor: default; display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: rgba(255,255,255,0.02); border: 1px solid var(--card-border); border-radius: 14px; margin-bottom: 8px;">
              <span style="font-size: 1.1rem; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: rgba(255,255,255,0.04); border-radius: 8px;">${icon}</span>
              <div style="flex: 1; min-width: 0; display: flex; flex-direction: column;">
                <span class="receive-content" style="font-weight: 600; color: var(--text); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.content)}</span>
                <span style="font-size: 0.72rem; color: var(--text3); margin-top: 2px;">${subtitle}</span>
              </div>
              <span class="receive-time" style="font-size: 0.72rem; color: var(--text3); flex-shrink: 0; margin-right: 8px;">${timeAgo(item.timestamp)}</span>
              <div style="display:flex; align-items:center; gap:8px; flex-shrink: 0;">
                <button onclick="handleReceiveText('${escapeAttr(item.content)}')" style="background:none; border:none; color:var(--accent-light); font-size:0.76rem; font-weight:600; cursor:pointer; padding:2px 6px;">Copy</button>
                <button class="delete-btn" onclick="deletePendingItem('${escapeAttr(item.id)}')" style="background:none; border:none; color:var(--text3); font-size:0.9rem; cursor:pointer; padding:2px; display:inline-flex; align-items:center;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
              </div>
            </div>
          `;
        } else {
          const ext = (item.filename || item.originalName || item.name || '').split('.').pop().toLowerCase();
          const isImg = item.type === 'image' || ['jpg','jpeg','png','gif','webp','svg','heic','bmp'].includes(ext);
          const isVid = item.type === 'video' || ['mp4','mov','m4v','webm','ogv','avi','mkv'].includes(ext);
          const isPdf = ext === 'pdf' || (item.mimeType && item.mimeType.includes('pdf'));
          const downloadUrl = (isImg || isVid || isPdf) 
            ? (item.filename ? `/received/${item.filename}` : item.url)
            : `/received/${item.filename}`;
          const displayName = isImg ? (item.filename || 'Image') : (isVid ? (item.filename || 'Video') : (isPdf ? (item.filename || 'PDF Document') : (item.originalName || item.filename || 'File')));
          const mime = item.mimeType || item.mimetype || (isImg ? 'image/jpeg' : (isVid ? 'video/mp4' : (isPdf ? 'application/pdf' : '')));
          
          let icon = getFileTypeIcon(mime);
          if (isImg && downloadUrl) {
            icon = `<img src="${downloadUrl}" alt="${escapeAttr(displayName)}" style="width: 32px; height: 32px; border-radius: 8px; object-fit: cover; display: block;" />`;
          } else if (isVid) {
            icon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><polygon points="10 8 16 12 10 16 10 8"/></svg>`;
          } else if (isPdf) {
            icon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
          }

          const safeUrl = escapeAttr(downloadUrl);
          const safeTitle = escapeAttr(displayName);
          const direction = item.direction || 'Received';
          const formattedSize = item.size ? formatFileSize(item.size) : 'File';
          const subtitle = `${direction} · ${formattedSize}`;

          let clickHandler = '';
          if (isImg) {
            clickHandler = `onclick="openMobileImageLightbox('${safeUrl}', '${safeTitle}')"`;
          } else if (isVid) {
            clickHandler = `onclick="openMobileVideoPlayer('${safeUrl}?stream=true', '${safeTitle}')"`;
          } else if (isPdf) {
            clickHandler = `onclick="openMobilePdfViewer('${safeUrl}', '${safeTitle}')"`;
          }

          return `
            <div class="receive-item" ${clickHandler} style="display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: rgba(255,255,255,0.02); border: 1px solid var(--card-border); border-radius: 14px; margin-bottom: 8px; ${(isImg || isVid || isPdf) ? 'cursor: pointer;' : 'cursor: default;'}">
              <span style="font-size: 1.1rem; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: rgba(255,255,255,0.04); border-radius: 8px; overflow: hidden;">${icon}</span>
              <div style="flex: 1; min-width: 0; display: flex; flex-direction: column;">
                <span class="receive-content" style="font-weight: 600; color: var(--text); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(displayName)}</span>
                <span style="font-size: 0.72rem; color: var(--text3); margin-top: 2px;">${subtitle}</span>
              </div>
              <span class="receive-time" style="font-size: 0.72rem; color: var(--text3); flex-shrink: 0; margin-right: 8px;">${timeAgo(item.timestamp)}</span>
              <div style="display:flex; align-items:center; gap:8px; flex-shrink: 0;" onclick="event.stopPropagation();">
                <button onclick="downloadPhotoDirectly('${downloadUrl}', '${escapeAttr(displayName)}')" style="background:none; border:none; color:var(--accent-light); font-size:0.76rem; font-weight:600; cursor:pointer; padding:2px 6px;">Download</button>
                <button class="delete-btn" onclick="deletePendingItem('${escapeAttr(item.id)}')" style="background:none; border:none; color:var(--text3); font-size:0.9rem; cursor:pointer; padding:2px; display:inline-flex; align-items:center;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
              </div>
            </div>
          `;
        }
      }).join('');
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
      let t = document.getElementById('toast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'toast';
        t.className = 'toast';
        document.body.appendChild(t);
      }
      t.textContent = msg;
      t.classList.add('show');
      if (t._timer) clearTimeout(t._timer);
      t._timer = setTimeout(() => t.classList.remove('show'), 2500);
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
          sendTextBtn.classList.add('is-loading');
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
            sendTextBtn.classList.remove('is-loading');
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

      let selectedFiles = [];

      if (sendFileTrigger && mobileFileInput) {
        sendFileTrigger.addEventListener('click', () => mobileFileInput.click());
        mobileFileInput.addEventListener('change', () => {
          if (mobileFileInput.files.length > 0) {
            selectedFiles = Array.from(mobileFileInput.files);
            sendFileTrigger.style.display = 'none';
            mobileFilePreview.style.display = 'flex';
            
            if (selectedFiles.length === 1) {
              const file = selectedFiles[0];
              mobilePreviewFileName.textContent = `${file.name} (${formatSize(file.size)})`;
              if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = (e) => {
                  mobilePreviewImg.src = e.target.result;
                  mobilePreviewImg.style.display = 'block';
                  mobilePreviewFileIcon.style.display = 'none';
                };
                reader.readAsDataURL(file);
              } else {
                mobilePreviewImg.style.display = 'none';
                mobilePreviewFileIcon.style.display = 'block';
                mobilePreviewFileIcon.textContent = getFileTypeIcon(file.type);
              }
            } else {
              const totalSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);
              mobilePreviewFileName.textContent = `${selectedFiles.length} files selected (${formatSize(totalSize)})`;
              mobilePreviewImg.style.display = 'none';
              mobilePreviewFileIcon.style.display = 'block';
              mobilePreviewFileIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6m-3-3h6"/></svg>`;
            }
          }
        });
      }

      const cancelFileBtn = document.getElementById('cancelFileBtn');
      if (cancelFileBtn) {
        cancelFileBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          selectedFiles = [];
          if (mobileFileInput) mobileFileInput.value = '';
          if (mobileFilePreview) mobileFilePreview.style.display = 'none';
          if (sendFileTrigger) sendFileTrigger.style.display = 'flex';
          if (mobilePreviewImg) { mobilePreviewImg.src = ''; mobilePreviewImg.style.display = 'none'; }
        });
      }

      if (sendFileBtn) {
        sendFileBtn.addEventListener('click', async () => {
          if (!selectedFiles || selectedFiles.length === 0) {
            showToast('Please select file(s) or photo(s) to send');
            return;
          }
          sendFileBtn.disabled = true;
          sendFileBtn.classList.add('is-loading');

          let successCount = 0;
          let failCount = 0;

          for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            const formData = new FormData();
            formData.append('file', file);
            try {
              const res = await doFetch('/api/file', {
                method: 'POST',
                body: formData
              });
              if (res.ok) {
                successCount++;
              } else {
                failCount++;
              }
            } catch {
              failCount++;
            }
          }

          if (successCount > 0) {
            showToast(selectedFiles.length === 1 ? 'File sent to PC!' : `${successCount} file(s) sent to PC!`);
            selectedFiles = [];
            if (mobileFileInput) mobileFileInput.value = '';
            if (mobileFilePreview) mobileFilePreview.style.display = 'none';
            if (sendFileTrigger) sendFileTrigger.style.display = 'flex';
            if (mobilePreviewImg) { mobilePreviewImg.src = ''; mobilePreviewImg.style.display = 'none'; }
          } else {
            showToast('Failed to send file(s)');
          }

          sendFileBtn.disabled = false;
          sendFileBtn.classList.remove('is-loading');
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

    let _pendingSysConfirmAction = null;

    function showSystemConfirmModal(options) {
      const modal = document.getElementById('systemConfirmModal');
      const titleEl = document.getElementById('sysConfirmTitle');
      const msgEl = document.getElementById('sysConfirmMessage');
      const btnOK = document.getElementById('btnSysConfirmOK');
      const btnCancel = document.getElementById('btnSysConfirmCancel');
      const iconContainer = document.getElementById('sysConfirmIconContainer');
      if (!modal || !titleEl || !msgEl || !btnOK) return;

      titleEl.textContent = options.title || 'Confirm Action';
      msgEl.textContent = options.message || 'Are you sure you want to proceed?';
      btnOK.textContent = options.confirmText || 'Confirm';

      if (options.isDanger) {
        btnOK.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
        btnOK.style.boxShadow = '0 4px 12px rgba(239, 68, 68, 0.3)';
        if (iconContainer) {
          iconContainer.style.background = 'rgba(239, 68, 68, 0.15)';
          iconContainer.style.borderColor = 'rgba(239, 68, 68, 0.3)';
          iconContainer.style.color = '#ef4444';
        }
      } else {
        btnOK.style.background = 'linear-gradient(135deg, #6366f1, #4f46e5)';
        btnOK.style.boxShadow = '0 4px 12px rgba(99, 102, 241, 0.3)';
        if (iconContainer) {
          iconContainer.style.background = 'rgba(99, 102, 241, 0.15)';
          iconContainer.style.borderColor = 'rgba(99, 102, 241, 0.3)';
          iconContainer.style.color = '#818cf8';
        }
      }

      _pendingSysConfirmAction = options.onConfirm;

      const closeModal = () => {
        modal.style.display = 'none';
      };

      if (btnCancel) btnCancel.onclick = closeModal;
      btnOK.onclick = async () => {
        closeModal();
        if (_pendingSysConfirmAction) {
          try {
            await _pendingSysConfirmAction();
          } catch (err) {
            console.error('[Modal] Action execution failed:', err);
          }
          _pendingSysConfirmAction = null;
        }
      };

      modal.style.display = 'flex';
    }

    function setupMobileControl() {
      document.querySelectorAll('.btn-control-cmd').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn._isPending) return;
          const action = btn.getAttribute('data-cmd');
          
          const executeAction = async () => {
            triggerHaptic(15);
            btn._isPending = true;
            try {
              const res = await doFetch('/api/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
              });
              if (!res.ok) {
                showToast('Failed to trigger action');
              }
            } catch {
              showToast('Failed to connect to server');
            } finally {
              btn._isPending = false;
            }
          };

          if (action === 'poweroff') {
            triggerHaptic(25);
            showSystemConfirmModal({
              title: 'Shut Down PC?',
              message: 'Are you sure you want to shut down your computer remotely?',
              confirmText: 'Shut Down',
              isDanger: true,
              onConfirm: executeAction
            });
          } else if (action === 'sleep') {
            triggerHaptic(20);
            showSystemConfirmModal({
              title: 'Put PC to Sleep?',
              message: 'Are you sure you want to put your PC to sleep remotely?',
              confirmText: 'Sleep PC',
              isDanger: false,
              onConfirm: executeAction
            });
          } else {
            executeAction();
          }
        });
      });
    }

    function setupVlcControl() {
      const btnHeaderAction = document.getElementById('btnVlcHeaderAction');

      if (btnHeaderAction) {
        btnHeaderAction.addEventListener('click', () => {
          triggerHaptic(12);
          if (window._vlcIsRunning) {
            showSystemConfirmModal({
              title: 'Close VLC Player?',
              message: 'Are you sure you want to close VLC Media Player on your PC remotely?',
              confirmText: 'Close VLC',
              isDanger: true,
              onConfirm: async () => {
                triggerHaptic(20);
                showToast('Closing VLC media player...');
                try {
                  await doFetch('/api/control', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'vlc_close' })
                  });
                  setTimeout(updateVlcStatus, 600);
                } catch (_) {
                  showToast('Failed to send close signal');
                }
              }
            });
          } else {
            const svgIcon = document.getElementById('svgVlcHeaderIcon');
            if (svgIcon) svgIcon.style.transform = 'rotate(360deg)';
            showToast('Checking VLC status...');
            updateVlcStatus();
            setTimeout(() => {
              if (svgIcon) svgIcon.style.transform = 'none';
            }, 600);
          }
        });
      }

      document.querySelectorAll('.vlc-cmd-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn._isPending) return;
          const action = btn.getAttribute('data-vlc-cmd');
          triggerHaptic(15);
          btn._isPending = true;
          try {
            const res = await doFetch('/api/control', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action })
            });
            if (res.ok) {
              setTimeout(updateVlcStatus, 500);
            } else {
              const data = await res.json().catch(() => ({}));
              showToast(data.error || 'Failed to trigger VLC command');
            }
          } catch {
            showToast('Failed to connect to server');
          } finally {
            btn._isPending = false;
          }
        });
      });

      // Seek Slider Shuttle Control (Hold & Drag aggressive seeking)
      const slider = document.getElementById('vlcSeekSlider');
      const indicator = document.getElementById('vlcSeekIndicator');
      let seekInterval = null;
      let currentSeekAction = null;

      if (slider && indicator) {
        slider.addEventListener('input', () => {
          const val = parseInt(slider.value, 10);
          let action = null;
          let tickIntervalMs = 300;
          let labelText = 'Hold & Drag';
          let labelColor = 'var(--text3)';

          if (val <= 15) {
            // Extreme Rewind (5 min per jump every 300ms = 10 min/sec)
            action = 'vlc_seek_backward_300s';
            tickIntervalMs = 300;
            labelText = 'Rewind << (Fast)';
            labelColor = '#ef4444';
          } else if (val > 15 && val <= 30) {
            action = 'vlc_seek_backward_60s';
            tickIntervalMs = 250;
            labelText = 'Rewind <<';
            labelColor = '#ef4444';
          } else if (val > 30 && val <= 42) {
            action = 'vlc_seek_backward_10s';
            tickIntervalMs = 200;
            labelText = 'Rewind <';
            labelColor = '#ef4444';
          } else if (val >= 43 && val <= 57) {
            action = null; // Neutral Center
            labelText = 'Hold & Drag';
            labelColor = 'var(--text3)';
          } else if (val > 57 && val <= 70) {
            action = 'vlc_seek_forward_10s';
            tickIntervalMs = 200;
            labelText = 'Fast Forward >';
            labelColor = '#10b981';
          } else if (val > 70 && val <= 85) {
            action = 'vlc_seek_forward_60s';
            tickIntervalMs = 250;
            labelText = 'Fast Forward >>';
            labelColor = '#10b981';
          } else {
            // Extreme Forward (5 min per jump every 300ms = 10 min/sec)
            action = 'vlc_seek_forward_300s';
            tickIntervalMs = 300;
            labelText = 'Fast Forward >> (Fast)';
            labelColor = '#10b981';
          }

          indicator.textContent = labelText;
          indicator.style.color = labelColor;

          // If action zone changed
          if (action !== currentSeekAction) {
            if (seekInterval) {
              clearInterval(seekInterval);
              seekInterval = null;
            }
            
            currentSeekAction = action;

            if (action) {
              triggerHaptic(12);
              
              doFetch('/api/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
              }).catch(err => console.error('[VLC] Initial seek failed:', err));

              // Aggressive repeat interval
              seekInterval = setInterval(() => {
                triggerHaptic(8);
                doFetch('/api/control', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action })
                }).catch(err => console.error('[VLC] Hold seek failed:', err));
              }, tickIntervalMs);
            }
          }
        });

        // Touch or click released: stop seeking and snap back
        const handleRelease = () => {
          if (seekInterval) {
            clearInterval(seekInterval);
            seekInterval = null;
          }
          currentSeekAction = null;
          slider.value = 50;
          indicator.textContent = 'Hold & Drag';
          indicator.style.color = 'var(--text3)';
          setTimeout(updateVlcStatus, 500);
        };

        slider.addEventListener('change', handleRelease);
        slider.addEventListener('touchend', handleRelease);
        slider.addEventListener('mouseup', handleRelease);
      }
    }

    async function updateVlcStatus() {
      try {
        const res = await doFetch('/api/control/vlc-status');
        if (res.ok) {
          const data = await res.json();
          const badge = document.getElementById('vlcStatusBadge');
          const text = document.getElementById('vlcNowPlayingText');
          const activeControls = document.getElementById('vlcActiveControls');
          const inactivePlaceholder = document.getElementById('vlcInactivePlaceholder');
          const btnHeader = document.getElementById('btnVlcHeaderAction');

          window._vlcIsRunning = !!data.running;
          
          if (data.running) {
            if (activeControls) activeControls.style.display = 'flex';
            if (inactivePlaceholder) inactivePlaceholder.style.display = 'none';
            if (badge) {
              badge.textContent = 'Active';
              badge.style.background = 'var(--success-bg)';
              badge.style.color = 'var(--success)';
              badge.style.borderColor = 'rgba(34, 197, 94, 0.2)';
            }
            if (text) {
              text.innerHTML = `<strong>Now Playing:</strong> ${escapeHtml(data.title)}`;
              text.style.color = 'var(--text)';
            }
            if (btnHeader) {
              btnHeader.innerHTML = '&times;';
              btnHeader.style.background = 'rgba(239, 68, 68, 0.15)';
              btnHeader.style.borderColor = 'rgba(239, 68, 68, 0.3)';
              btnHeader.style.color = '#ef4444';
              btnHeader.style.fontSize = '1.2rem';
              btnHeader.title = 'Close VLC Player on PC';
            }
          } else {
            if (activeControls) activeControls.style.display = 'none';
            if (inactivePlaceholder) inactivePlaceholder.style.display = 'flex';
            if (badge) {
              badge.textContent = 'Closed';
              badge.style.background = 'rgba(255, 255, 255, 0.05)';
              badge.style.color = 'var(--text3)';
              badge.style.borderColor = 'var(--card-border)';
            }
            if (text) {
              text.textContent = 'VLC media player is not running.';
              text.style.color = 'var(--text3)';
            }
            if (btnHeader) {
              btnHeader.innerHTML = '<svg id="svgVlcHeaderIcon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition: transform 0.5s;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>';
              btnHeader.style.background = 'rgba(255, 255, 255, 0.08)';
              btnHeader.style.borderColor = 'rgba(255, 255, 255, 0.12)';
              btnHeader.style.color = 'var(--text)';
              btnHeader.style.fontSize = '0.9rem';
              btnHeader.title = 'Check VLC Status';
            }
          }
        }
      } catch (err) {
        console.error('[VLC] Failed to fetch VLC status:', err);
      }
    }

    function setupMobileScreenshot() {
      const btnFetch = document.getElementById('btnFetchScreenshot');
      const lightbox = document.getElementById('screenshotLightbox');
      const lightboxImg = document.getElementById('lightboxImg');
      const btnCloseLightbox = document.getElementById('btnCloseLightbox');
      const btnCopy = document.getElementById('btnCopyLightbox');
      const btnDownload = document.getElementById('btnDownloadLightbox');
      const zoomContainer = document.getElementById('zoomContainer');
      const cameraIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

      if (!btnFetch || !lightbox || !lightboxImg || !btnCloseLightbox) return;

      // ── Zoom & Pan Logic State ──
      let scale = 1;
      let minScale = 1;
      let maxScale = 4;
      let translateX = 0;
      let translateY = 0;
      let startX = 0;
      let startY = 0;
      let isDragging = false;
      
      // Pinch touch variables
      let startDist = 0;
      let startScale = 1;
      let lastTouchTime = 0;

      function applyTransform() {
        if (scale <= 1) {
          translateX = 0;
          translateY = 0;
        } else {
          const maxTx = (lightboxImg.clientWidth * scale - zoomContainer.clientWidth) / 2;
          const maxTy = (lightboxImg.clientHeight * scale - zoomContainer.clientHeight) / 2;
          if (maxTx > 0) {
            translateX = Math.max(-maxTx, Math.min(maxTx, translateX));
          } else {
            translateX = 0;
          }
          if (maxTy > 0) {
            translateY = Math.max(-maxTy, Math.min(maxTy, translateY));
          } else {
            translateY = 0;
          }
        }
        lightboxImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      }

      function resetZoom() {
        scale = 1;
        translateX = 0;
        translateY = 0;
        lightboxImg.style.transition = 'transform 0.25s ease-out';
        applyTransform();
        setTimeout(() => {
          if (lightboxImg) lightboxImg.style.transition = 'none';
        }, 250);
      }

      // Touch handlers on zoomContainer
      if (zoomContainer) {
        zoomContainer.addEventListener('touchstart', (e) => {
          if (e.touches.length === 1) {
            // Check double tap
            const now = Date.now();
            if (now - lastTouchTime < 300) {
              if (scale > 1) {
                resetZoom();
              } else {
                scale = 2.5;
                const rect = zoomContainer.getBoundingClientRect();
                const touchX = e.touches[0].clientX - rect.left - rect.width / 2;
                const touchY = e.touches[0].clientY - rect.top - rect.height / 2;
                translateX = -touchX * 1.5;
                translateY = -touchY * 1.5;
                lightboxImg.style.transition = 'transform 0.25s ease-out';
                applyTransform();
                setTimeout(() => {
                  if (lightboxImg) lightboxImg.style.transition = 'none';
                }, 250);
              }
              lastTouchTime = 0;
              e.preventDefault();
              return;
            }
            lastTouchTime = now;

            isDragging = true;
            startX = e.touches[0].clientX - translateX;
            startY = e.touches[0].clientY - translateY;
          } else if (e.touches.length === 2) {
            isDragging = false;
            startScale = scale;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            startDist = Math.hypot(dx, dy);
          }
        }, { passive: false });

        zoomContainer.addEventListener('touchmove', (e) => {
          if (isDragging && e.touches.length === 1 && scale > 1) {
            translateX = e.touches[0].clientX - startX;
            translateY = e.touches[0].clientY - startY;
            applyTransform();
            e.preventDefault();
          } else if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.hypot(dx, dy);
            if (startDist > 0) {
              const targetScale = startScale * (dist / startDist);
              scale = Math.max(minScale, Math.min(maxScale, targetScale));
              applyTransform();
            }
            e.preventDefault();
          }
        }, { passive: false });

        zoomContainer.addEventListener('touchend', (e) => {
          if (e.touches.length < 2) {
            startDist = 0;
          }
          if (e.touches.length === 0) {
            isDragging = false;
          }
        });
      }

      // Capture and Fetch Event
      btnFetch.addEventListener('click', async () => {
        btnFetch.disabled = true;
        btnFetch.innerHTML = cameraIconSvg + ' <span>Capturing...</span>';
        try {
          const screenshotUrl = `/api/screenshot?t=${Date.now()}`;
          
          const response = await fetch(screenshotUrl);
          if (!response.ok) throw new Error('API capture failed');
          const blob = await response.blob();
          const localUrl = URL.createObjectURL(blob);
          
          lightboxImg.src = localUrl;
          lightboxImg.onload = () => {
            resetZoom();
            lightbox.style.display = 'flex';
            btnFetch.disabled = false;
            btnFetch.innerHTML = cameraIconSvg + ' <span>Fetch Instant Screenshot</span>';

            if (btnDownload) {
              btnDownload.href = localUrl;
            }

            if (btnCopy) {
              const newBtnCopy = btnCopy.cloneNode(true);
              btnCopy.parentNode.replaceChild(newBtnCopy, btnCopy);
              newBtnCopy.addEventListener('click', async () => {
                if (typeof window.triggerHaptic === 'function') window.triggerHaptic(20);
                try {
                  await navigator.clipboard.write([
                    new ClipboardItem({
                      'image/png': blob
                    })
                  ]);
                  showToast('Copied screenshot to clipboard!');
                } catch (copyErr) {
                  console.error('[SCREENSHOT] Clipboard copy failed:', copyErr);
                  try {
                    const absUrl = window.location.origin + screenshotUrl;
                    await navigator.clipboard.writeText(absUrl);
                    showToast('Link copied (direct copy unsupported on this browser)');
                  } catch {
                    showToast('Failed to copy to clipboard.');
                  }
                }
              });
            }
          };

          lightboxImg.onerror = () => {
            showToast('Failed to render screenshot');
            btnFetch.disabled = false;
            btnFetch.innerHTML = cameraIconSvg + ' <span>Fetch Instant Screenshot</span>';
          };

        } catch (err) {
          console.error('[SCREENSHOT] Fetch failed:', err);
          showToast('Failed to fetch screenshot');
          btnFetch.disabled = false;
          btnFetch.innerHTML = cameraIconSvg + ' <span>Fetch Instant Screenshot</span>';
        }
      });

      // Close Lightbox
      btnCloseLightbox.addEventListener('click', () => {
        if (typeof window.triggerHaptic === 'function') window.triggerHaptic(15);
        lightbox.style.display = 'none';
        if (lightboxImg.src.startsWith('blob:')) {
          URL.revokeObjectURL(lightboxImg.src);
        }
        lightboxImg.src = '';
      });
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
          btn.innerHTML = 'Connecting to PC...';
          btn.style.background = 'rgba(255,255,255,0.05)';
          btn.style.borderColor = 'var(--card-border)';
          break;
        case 'connected':
          btn.innerHTML = 'Services Connected';
          btn.style.background = 'rgba(16,185,129,0.15)';
          btn.style.borderColor = '#10b981';
          break;
        case 'failed':
          btn.innerHTML = 'Connection Failed — Retry';
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
      
      let ws;
      try {
        ws = new WebSocket(`${proto}//${window.location.host}/trackpad?token=${token}`);
      } catch (err) {
        console.error('[WS] WebSocket constructor failed:', err);
        wsConnecting = false;
        updateUniversalConnectButton('failed');
        return;
      }

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

      let phoneIceQueue = [];
      let micIceQueue = [];

      function createPhonePeerConnection() {
        if (phonePC) {
          try { phonePC.close(); } catch(e) {}
        }
        phoneIceQueue = [];
        phonePC = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        });
        phonePC.onicecandidate = (event) => {
          if (event.candidate) {
            sendWS({
              type: 'webrtc_ice_candidate',
              candidate: event.candidate
            });
          }
        };
        phonePC.onconnectionstatechange = () => {
          console.log('[WebRTC Phone] Peer connection state:', phonePC ? phonePC.connectionState : 'closed');
          if (phonePC && phonePC.connectionState === 'failed') {
            showToast('Screencast WebRTC connection failed. Retrying...', 'warning');
          }
        };
        phonePC.ontrack = (event) => {
          console.log('[WebRTC] Track received:', event.streams);
          const liveFrame = document.getElementById('liveScreenFrame');
          if (liveFrame && event.streams && event.streams[0]) {
            liveFrame.srcObject = event.streams[0];
            liveFrame.autoplay = true;
            liveFrame.playsInline = true;
            if (audioOnlyStreamMode) {
              liveFrame.muted = false;
            }
            liveFrame.play().catch(err => {
              console.warn('[WebRTC] Video element play() failed/deferred:', err);
            });
            syncAudioStates();
          }
        };
      }

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'revoked') {
            localStorage.removeItem('deviceToken');
            document.cookie = "airodrop_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
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
              const frameEl = document.getElementById('liveScreenFrame');
              if (frameEl) {
                frameEl.style.filter = data.pause ? 'blur(15px) brightness(0.5)' : '';
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
            while (phoneIceQueue.length > 0) {
              const cand = phoneIceQueue.shift();
              try {
                await phonePC.addIceCandidate(new RTCIceCandidate(cand));
              } catch (e) {
                console.error('[WebRTC] Failed adding queued ICE candidate on phone:', e);
              }
            }
          } else if (data.type === 'webrtc_ice_candidate') {
            if (phonePC && data.candidate) {
              if (phonePC.remoteDescription) {
                try {
                  await phonePC.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (e) {
                  console.error('[WebRTC] Failed adding ICE candidate on phone:', e);
                }
              } else {
                phoneIceQueue.push(data.candidate);
              }
            }
          } else if (data.type === 'mic_answer') {
            console.log('[MicWebRTC] Received SDP Answer from PC.');
            if (micPC) {
              await micPC.setRemoteDescription(new RTCSessionDescription(data.answer));
              while (micIceQueue.length > 0) {
                const cand = micIceQueue.shift();
                try {
                  await micPC.addIceCandidate(new RTCIceCandidate(cand));
                } catch (e) {
                  console.error('[MicWebRTC] Failed adding queued ICE candidate on mic:', e);
                }
              }
            }
          } else if (data.type === 'mic_ice_candidate') {
            if (micPC && data.candidate) {
              if (micPC.remoteDescription) {
                try {
                  await micPC.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (e) {
                  console.error('[MicWebRTC] Failed adding ICE candidate on mic:', e);
                }
              } else {
                micIceQueue.push(data.candidate);
              }
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

    function setupCreatorProfile() {
      const btnOpen = document.getElementById('btnOpenCreatorProfile');
      const lightbox = document.getElementById('creatorLightbox');
      const card = document.getElementById('creatorCard');
      const btnClose = document.getElementById('btnCloseCreator');

      if (!btnOpen || !lightbox || !card || !btnClose) return;

      btnOpen.addEventListener('click', () => {
        lightbox.style.display = 'flex';
        setTimeout(() => {
          lightbox.style.opacity = '1';
          card.style.transform = 'translateY(0)';
        }, 10);
      });

      const closeCreator = () => {
        lightbox.style.opacity = '0';
        card.style.transform = 'translateY(100%)';
        setTimeout(() => {
          lightbox.style.display = 'none';
        }, 300);
      };

      btnClose.addEventListener('click', closeCreator);
      lightbox.addEventListener('click', (e) => {
        if (e.target === lightbox) {
          closeCreator();
        }
      });
    }

    // ─── File Manager Overlay Setup ───────────────────────────────
    function setupFileManager() {
      const btnOpen = document.getElementById('btnOpenFileManager');
      const overlay = document.getElementById('fileManagerOverlay');
      const frame = document.getElementById('fileManagerFrame');

      if (!btnOpen || !overlay || !frame) return;

      btnOpen.addEventListener('click', () => {
        triggerHaptic(20);
        // Lazy-load src on first open (if not already set by token init)
        if (!frame.src || frame.src === '' || frame.src === 'about:blank') {
          const token = localStorage.getItem('deviceToken') || '';
          frame.src = token ? `/files?token=${token}` : '/files';
        }
        overlay.style.display = 'flex';
      });

      // Listen for close message from files.html iframe
      window.addEventListener('message', (e) => {
        if (e.data === 'closeFileBrowser') {
          triggerHaptic(15);
          overlay.style.display = 'none';
        }
      });
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
      const openTrackpadOverlay = (openKbd = false) => {
        if (!trackpadSocket || trackpadSocket.readyState !== WebSocket.OPEN) {
          wsWantsConnected = true;
          connectWS();
        }
        overlay.style.display = 'flex';
        isTrackpadOpen = true;
        if (openKbd && kbdPanel) kbdPanel.style.display = 'flex';
        setTimeout(() => {
          if (keyboardInput) {
            keyboardInput.value = '';
            keyboardInput.focus();
          }
        }, 300);
      };

      btnOpen.addEventListener('click', () => openTrackpadOverlay(false));

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
          btnToggleKbd.innerHTML = isOpen
            ? '<svg class="icon-svg sm" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><line x1="6" y1="8" x2="6.01" y2="8"/><line x1="10" y1="8" x2="10.01" y2="8"/><line x1="14" y1="8" x2="14.01" y2="8"/><line x1="18" y1="8" x2="18.01" y2="8"/><line x1="8" y1="16" x2="16" y2="16"/></svg> <span>Keyboard ▼</span>'
            : '<svg class="icon-svg sm" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><line x1="6" y1="8" x2="6.01" y2="8"/><line x1="10" y1="8" x2="10.01" y2="8"/><line x1="14" y1="8" x2="14.01" y2="8"/><line x1="18" y1="8" x2="18.01" y2="8"/><line x1="8" y1="16" x2="16" y2="16"/></svg> <span>Keyboard ▲</span>';
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
      let touchpadAccumulatedScrollY = 0;
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
          touchpadAccumulatedScrollY = 0;
          
          const dot = document.getElementById('touchpadCursorDot');
          if (dot) dot.style.display = 'none';
        }
      }, { passive: true });

      touchpadArea.addEventListener('touchmove', (e) => {
        const touches = e.touches;
        if (touches.length === 2) {
          e.preventDefault();
          const cy = (touches[0].clientY + touches[1].clientY) / 2;
          // Auto-initialize if touchstart was missed or flags were reset
          if (!touchpadIsScrolling || !touchpadInitialScrollY) {
            touchpadIsScrolling = true;
            touchpadInitialScrollY = cy;
            touchpadAccumulatedScrollY = 0;
          }
          const dy = cy - touchpadInitialScrollY;
          touchpadAccumulatedScrollY += dy;
          touchpadInitialScrollY = cy;

          // Discrete high-precision scrolling: 3px drag = 30 wheel units (smooth, responsive feel)
          while (touchpadAccumulatedScrollY > 3) {
            touchpadHasMoved = true;
            sendWS({ type: 'scroll', amount: -30 }); // Scroll Down
            touchpadAccumulatedScrollY -= 3;
          }
          while (touchpadAccumulatedScrollY < -3) {
            touchpadHasMoved = true;
            sendWS({ type: 'scroll', amount: 30 });  // Scroll Up
            touchpadAccumulatedScrollY += 3;
          }
        } else if (touches.length === 1 && !touchpadIsScrolling) {
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
            } else {
              sendWS({ type: 'key', code: 39 }); // ArrowRight
            }
            return;
          }

          const now = Date.now();
          if (now - touchpadLastTapTime < 300) {
            if (touchpadTapTimeout) clearTimeout(touchpadTapTimeout);
            sendWS({ type: 'click', button: 'left' });
            setTimeout(() => sendWS({ type: 'click', button: 'left' }), 50);
            touchpadLastTapTime = 0;
          } else {
            touchpadLastTapTime = now;
            touchpadTapTimeout = setTimeout(() => {
              sendWS({ type: 'click', button: 'left' });
              touchpadTapTimeout = null;
            }, 220);
          }
        }
      }, { passive: true });

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

      // ── Pinch to Zoom & Visual Viewport variables ──
      let zoomScale = 1.0;
      let zoomTranslateX = 0;
      let zoomTranslateY = 0;
      let isPinching = false;
      let startTouchDistance = 0;
      let startTouchScale = 1.0;
      let startTouchMidpoint = { x: 0, y: 0 };
      let startTranslateX = 0;
      let startTranslateY = 0;

      const btnResetZoom = document.getElementById('btnResetZoom');

      function applyZoomTransform() {
        if (frame) {
          if (zoomScale < 1.0) zoomScale = 1.0;
          if (zoomScale > 5.0) zoomScale = 5.0;

          const maxTx = (zoomScale - 1) * window.innerWidth / 2;
          const maxTy = (zoomScale - 1) * window.innerHeight / 2;
          zoomTranslateX = Math.max(-maxTx, Math.min(maxTx, zoomTranslateX));
          zoomTranslateY = Math.max(-maxTy, Math.min(maxTy, zoomTranslateY));

          frame.style.transform = `translate(${zoomTranslateX}px, ${zoomTranslateY}px) scale(${zoomScale})`;
          
          if (btnResetZoom) {
            btnResetZoom.style.display = zoomScale > 1.05 ? 'block' : 'none';
          }
        }
      }

      if (btnResetZoom) {
        btnResetZoom.addEventListener('click', (e) => {
          e.stopPropagation();
          zoomScale = 1.0;
          zoomTranslateX = 0;
          zoomTranslateY = 0;
          applyZoomTransform();
        });
      }

      function updateScreencastViewport() {
        if (!overlay || overlay.style.display === 'none') return;
        if (window.visualViewport) {
          const vv = window.visualViewport;
          overlay.style.position = 'absolute';
          overlay.style.top = `${vv.offsetTop}px`;
          overlay.style.left = `${vv.offsetLeft}px`;
          overlay.style.width = `${vv.width}px`;
          overlay.style.height = `${vv.height}px`;

          if (frame) {
            if (keyboardPanel && keyboardPanel.style.display !== 'none') {
              const kbdHeight = keyboardPanel.offsetHeight || 0;
              frame.style.bottom = `${kbdHeight}px`;
              frame.style.height = `calc(100% - ${kbdHeight}px)`;
            } else {
              frame.style.bottom = '0';
              frame.style.height = '100%';
            }
          }
        }
      }

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateScreencastViewport);
        window.visualViewport.addEventListener('scroll', updateScreencastViewport);
      }
      window.addEventListener('resize', updateScreencastViewport);
      window.addEventListener('orientationchange', () => {
        setTimeout(updateScreencastViewport, 200);
      });

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
        
        // Hide main layout tabs and bottom navigation
        const mainApp = document.getElementById('mainAppContainer');
        const bottomNav = document.getElementById('bottomNavContainer');
        if (mainApp) mainApp.style.display = 'none';
        if (bottomNav) bottomNav.style.display = 'none';
        
        // Reset zoom on open
        zoomScale = 1.0;
        zoomTranslateX = 0;
        zoomTranslateY = 0;
        applyZoomTransform();

        // Restore keyboard button visibility (may have been hidden on previous close)
        if (btnKeyboard) btnKeyboard.style.display = interactiveMode ? 'block' : 'none';
        updateWakeLockStatus();
        setTimeout(updateScreencastViewport, 100);

        const isStreamActive = !!(frame && frame.srcObject);
        if (!isStreamActive) {
          audioOnlyStreamMode = false;
          sendWS({ type: 'screencast_start' });
        } else {
          // Stream is already running (e.g. from quick audio streaming)
          // Transition audioOnlyStreamMode to false (since the user is opening the full screenshare UI)
          audioOnlyStreamMode = false;
          syncAudioStates();
          showToast('Screencast active');
        }
      });

      btnClose.addEventListener('click', () => {
        overlay.style.display = 'none';
        
        // Restore main layout tabs and bottom navigation
        const mainApp = document.getElementById('mainAppContainer');
        const bottomNav = document.getElementById('bottomNavContainer');
        if (mainApp) mainApp.style.display = 'block';
        if (bottomNav) bottomNav.style.display = 'flex';

        // Reset overlay visual styling on close
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';

        streamActive = false;
        interactiveMode = true;
        audioOnlyStreamMode = false;
        if (dropdownMenu) dropdownMenu.style.display = 'none';
        if (toolsArrow) toolsArrow.style.transform = '';
        if (keyboardPanel) {
          keyboardPanel.style.display = 'none';
          updateScreencastViewport();
        }
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
          frame.style.bottom = '0';
          frame.style.height = '100%';
        }
        syncAudioStates();
        if (trackpadSocket && trackpadSocket.readyState === WebSocket.OPEN) {
          sendWS({ type: 'screencast_stop' });
        }
        updateWakeLockStatus();
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

        // Close dropdown when tapping anywhere else on screencast screen (but not when clicking controls/buttons)
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay || e.target === frame) {
            dropdownMenu.style.display = 'none';
            if (toolsArrow) {
              toolsArrow.style.transform = '';
            }
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
        if (!interactiveMode && keyboardPanel) {
          keyboardPanel.style.display = 'none';
          updateScreencastViewport();
        }
        
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
          updateScreencastViewport();
          if (!isVisible && scKeyboardInput) {
            setTimeout(() => scKeyboardInput.focus(), 100);
          }
        });
      }

      // ── Close keyboard panel ──
      if (btnScKeyboardClose) {
        btnScKeyboardClose.addEventListener('click', () => {
          if (keyboardPanel) {
            keyboardPanel.style.display = 'none';
            updateScreencastViewport();
          }
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
        
        scKeyboardInput.addEventListener('focus', () => {
          document.getElementById('scKeyboardPanel')?.classList.add('native-focus');
          setTimeout(updateScreencastViewport, 150);
        });
        scKeyboardInput.addEventListener('blur', () => {
          document.getElementById('scKeyboardPanel')?.classList.remove('native-focus');
          setTimeout(updateScreencastViewport, 150);
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
      let scAccumulatedScrollY = 0;
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
        const touches = e.touches;
        if (touches.length === 2) {
          scMaxTouches = 2;
          scIsTwoFinger = true;
          isPinching = false;
          const p1 = touches[0];
          const p2 = touches[1];
          startTouchDistance = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
          startTouchScale = zoomScale;
          
          const mid = getTouchMidpoint(e);
          scLastScrollY = mid.y;
          scAccumulatedScrollY = 0;
          scStartTime = Date.now();
          scHasMoved = false;

          startTouchMidpoint = mid;
          startTranslateX = zoomTranslateX;
          startTranslateY = zoomTranslateY;
        } else if (touches.length === 1) {
          scMaxTouches = 1;
          scIsTwoFinger = false;
          scHasMoved = false;
          scStartTime = Date.now();
          scLastTouchX = touches[0].clientX;
          scLastTouchY = touches[0].clientY;
          
          if (!interactiveMode || zoomScale > 1.05) {
            startTranslateX = zoomTranslateX;
            startTranslateY = zoomTranslateY;
          }
        }
      }, { passive: false });

      frame.addEventListener('touchmove', (e) => {
        const touches = e.touches;
        if (touches.length === 2) {
          e.preventDefault();
          const currentDistance = Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
          const mid = getTouchMidpoint(e);

          if (!isPinching && Math.abs(currentDistance - startTouchDistance) > 20) {
            isPinching = true;
            startTouchDistance = currentDistance;
            startTouchScale = zoomScale;
            startTouchMidpoint = mid;
            startTranslateX = zoomTranslateX;
            startTranslateY = zoomTranslateY;
          }

          if (isPinching) {
            if (startTouchDistance > 0) {
              const scaleFactor = currentDistance / startTouchDistance;
              zoomScale = startTouchScale * scaleFactor;
            }

            zoomTranslateX = startTranslateX + (mid.x - startTouchMidpoint.x);
            zoomTranslateY = startTranslateY + (mid.y - startTouchMidpoint.y);

            applyZoomTransform();
          } else {
            if (interactiveMode) {
              const cy = mid.y;
              if (!scIsTwoFinger || !scLastScrollY) {
                scIsTwoFinger = true;
                scLastScrollY = cy;
                scAccumulatedScrollY = 0;
              }
              const dy = cy - scLastScrollY;
              scAccumulatedScrollY += dy;
              scLastScrollY = cy;

              while (scAccumulatedScrollY > 3) {
                scHasMoved = true;
                sendWS({ type: 'scroll', amount: -30 });
                scAccumulatedScrollY -= 3;
              }
              while (scAccumulatedScrollY < -3) {
                scHasMoved = true;
                sendWS({ type: 'scroll', amount: 30 });
                scAccumulatedScrollY += 3;
              }
            }
          }
        } else if (touches.length === 1 && !scIsTwoFinger) {
          const tx = touches[0].clientX;
          const ty = touches[0].clientY;
          const dx = tx - scLastTouchX;
          const dy = ty - scLastTouchY;
          
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            scHasMoved = true;
          }

          if (interactiveMode && zoomScale <= 1.05) {
            e.preventDefault();
            const rect = frame.getBoundingClientRect();
            const speed = cursorSpeed;
            const aspect = (frame.videoHeight && frame.videoWidth) ? (frame.videoHeight / frame.videoWidth) : (9 / 16);
            const scaleX = rect.width;
            const scaleY = rect.width * aspect;
            virtualX = Math.max(0, Math.min(1, virtualX + (dx / scaleX) * speed));
            virtualY = Math.max(0, Math.min(1, virtualY + (dy / scaleY) * speed));
            
            sendWS({ type: 'move_abs', xRatio: virtualX, yRatio: virtualY });
            
            scLastTouchX = tx;
            scLastTouchY = ty;
          } else if (!interactiveMode || zoomScale > 1.05) {
            e.preventDefault();
            zoomTranslateX += dx;
            zoomTranslateY += dy;
            applyZoomTransform();
            scLastTouchX = tx;
            scLastTouchY = ty;
          }
        }
      }, { passive: false });

      frame.addEventListener('touchend', (e) => {
        isPinching = false;
        if (e.touches.length > 0) return;
        
        if (!interactiveMode || !trackpadSocket) return;

        const duration = Date.now() - scStartTime;
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
            sendWS({ type: 'click_abs', xRatio: clickX, yRatio: clickY, button: 'left' });
            setTimeout(() => {
              sendWS({ type: 'click_abs', xRatio: clickX, yRatio: clickY, button: 'left' });
            }, 50);
            showToast('Double Click', 600);
            scLastTapTime = 0;
          } else {
            scLastTapTime = now;
            scTapTimeout = setTimeout(() => {
              sendWS({ type: 'click_abs', xRatio: clickX, yRatio: clickY, button: 'left' });
              showToast('Left Click', 600);
              scTapTimeout = null;
            }, 200);
          }
        }
      }, { passive: true });
    }



    // ─── File Browser Overlay Setup ─────────────────────────────
    function setupFileBrowserOverlay() {
      const btnOpen = document.getElementById('btnOpenFileBrowser');
      const overlay = document.getElementById('fileBrowserOverlay');
      const iframe = document.getElementById('fileBrowserIframe');

      if (!btnOpen || !overlay || !iframe) return;

      const closeFileBrowser = () => {
        overlay.style.display = 'none';
        iframe.src = 'about:blank';
      };

      btnOpen.addEventListener('click', () => {
        // Show loading state and reset iframe
        const loadingEl = document.getElementById('fileBrowserLoading');
        if (loadingEl) loadingEl.style.display = 'flex';
        iframe.src = '/files';
        overlay.style.display = 'flex';
      });

      const btnClose = document.getElementById('btnCloseFileBrowser');
      if (btnClose) {
        btnClose.addEventListener('click', closeFileBrowser);
      }

      window.addEventListener('message', (e) => {
        if (e.data === 'closeFileBrowser') {
          closeFileBrowser();
        }
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
        micIceQueue = [];

        micPC = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
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

    // ─── Global Viewport & Touch Gesture Stabilizer ───────────────
    // Prevents double-tap zoom & focus scroll jumps during rapid button taps (e.g. Volume + / -)
    (function initTouchStabilizer() {
      let lastTouchEnd = 0;
      document.addEventListener('touchend', function(e) {
        const now = Date.now();
        const isButtonOrControl = e.target.closest('button, .btn, .btn-control-cmd, .btn-vlc-cmd, .vlc-cmd-btn, .nav-item');
        if (isButtonOrControl) {
          if (now - lastTouchEnd <= 300) {
            e.preventDefault();
          }
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
        }
        lastTouchEnd = now;
      }, { passive: false });

      document.addEventListener('touchstart', function(e) {
        if (e.touches.length > 1) {
          e.preventDefault();
        }
      }, { passive: false });
    })();

    // ─── Mobile Image Lightbox Handler ─────────────────────────────
    window.closeMobileLightbox = function() {
      const modal = document.getElementById('mobileImageLightbox');
      if (modal) modal.style.display = 'none';
    };

    // ─── PWA Download Link & QR Modal Handlers ─────────────────────────────
    window.openDownloadLinkModal = function(url, name) {
      if (!url) return;
      const modal = document.getElementById('mobileDownloadLinkModal');
      const titleEl = document.getElementById('downloadModalFileName');
      const inputEl = document.getElementById('downloadModalUrlInput');
      const qrImg = document.getElementById('downloadModalQrImg');
      if (!modal) return;

      const fullUrl = url.startsWith('http') ? url : window.location.origin + url;

      if (titleEl) titleEl.textContent = name || 'Download File';
      if (inputEl) inputEl.value = fullUrl;
      if (qrImg) {
        qrImg.onerror = function() {
          qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(fullUrl)}`;
        };
        qrImg.src = `/api/qr-gen.png?text=${encodeURIComponent(fullUrl)}`;
      }

      modal.style.display = 'flex';
    };

    window.closeDownloadLinkModal = function() {
      const modal = document.getElementById('mobileDownloadLinkModal');
      if (modal) modal.style.display = 'none';
    };

    window.copyDownloadUrlFromModal = async function() {
      const inputEl = document.getElementById('downloadModalUrlInput');
      const btnEl = document.getElementById('btnCopyDownloadUrl');
      if (!inputEl || !inputEl.value) return;
      try {
        await navigator.clipboard.writeText(inputEl.value);
      } catch(e) {
        inputEl.select();
        document.execCommand('copy');
      }
      showToast('Copied to clipboard!');
      if (btnEl) {
        const originalHtml = btnEl.innerHTML;
        btnEl.style.background = 'linear-gradient(135deg, #10b981, #059669)';
        btnEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>Copied!</span>`;
      setTimeout(() => {
          btnEl.style.background = '';
          btnEl.innerHTML = originalHtml;
        }, 2000);
      }
    };

    const btnTriggerPcUpdate = document.getElementById('btnMobileTriggerPcUpdate');
    if (btnTriggerPcUpdate) {
      btnTriggerPcUpdate.addEventListener('click', async () => {
        btnTriggerPcUpdate.disabled = true;
        btnTriggerPcUpdate.textContent = '🔄 Triggering Update on PC...';
        try {
          const res = await doFetch('/api/check-update/trigger', { method: 'POST' });
          showToast('Update check triggered on PC!');
          const desc = document.getElementById('mobileUpdateDesc');
          if (desc) desc.textContent = 'Update command sent to host PC app.';
        } catch (err) {
          showToast('Failed to trigger update on PC', 'error');
        } finally {
          setTimeout(() => {
            btnTriggerPcUpdate.disabled = false;
            btnTriggerPcUpdate.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg><span>Check &amp; Update PC App</span>`;
          }, 1500);
        }
      });
    }

    window.downloadPhotoDirectly = function(url, name) {
      if (!url || url === 'undefined' || url === 'null') return;
      window.openDownloadLinkModal(url, name || 'photo.jpg');
    };

    window.openMobileImageLightbox = function(src, title) {
      if (!src || src === 'undefined' || src === 'null') return;
      const modal = document.getElementById('mobileImageLightbox');
      const img = document.getElementById('mobileLightboxImg');
      const titleEl = document.getElementById('mobileLightboxTitle');
      if (!modal || !img) return;

      if (titleEl) titleEl.textContent = title || 'Photo Preview';
      img.src = src;
      modal.style.display = 'flex';
    };

    // Attach click to mobile file preview image when selecting local photo to send
    const mobilePreviewImg = document.getElementById('mobilePreviewImg');
    if (mobilePreviewImg) {
      mobilePreviewImg.style.cursor = 'pointer';
      mobilePreviewImg.title = 'Tap to enlarge photo';
      mobilePreviewImg.addEventListener('click', () => {
        const nameEl = document.getElementById('mobilePreviewFileName');
        window.openMobileImageLightbox(mobilePreviewImg.src, nameEl ? nameEl.textContent : 'Selected Photo');
      });
    }

    // ─── Mobile Video Stream Player Handlers ─────────────────────────────
    window.openMobileVideoPlayer = function(url, title) {
      if (!url || url === 'undefined' || url === 'null') return;

      // Stop & hide any legacy video overlay
      const oldModal = document.getElementById('videoPlayerOverlay');
      const oldVideo = document.getElementById('videoPlayerEl');
      if (oldVideo) { try { oldVideo.pause(); oldVideo.removeAttribute('src'); oldVideo.load(); } catch(e) {} }
      if (oldModal) oldModal.style.display = 'none';

      const modal = document.getElementById('mobileVideoLightbox');
      const video = document.getElementById('mobileVideoEl');
      const titleEl = document.getElementById('mobileVideoTitle');
      if (!modal || !video) return;

      if (titleEl) titleEl.textContent = title || 'Video Stream';

      // Reset previous stream cleanly
      try { video.pause(); } catch(e) {}

      video.src = url;
      modal.style.display = 'flex';

      // Load and play in foreground modal
      video.load();
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          // Auto-launch native mobile video player mode
          if (video.webkitEnterFullscreen) {
            try { video.webkitEnterFullscreen(); } catch(e) {}
          }
        }).catch(err => {
          console.log('[VIDEO] Autoplay waiting for user tap:', err);
        });
      }
    };

    window.toggleMobileVideoFullscreen = function() {
      const video = document.getElementById('mobileVideoEl');
      if (!video) return;

      if (video.webkitEnterFullscreen) {
        // Native iOS Safari / WebKit PWA Video Fullscreen
        video.webkitEnterFullscreen();
      } else if (video.requestFullscreen) {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          video.requestFullscreen();
        }
      } else if (video.webkitRequestFullscreen) {
        if (document.webkitFullscreenElement) {
          document.webkitExitFullscreen();
        } else {
          video.webkitRequestFullscreen();
        }
      } else if (video.msRequestFullscreen) {
        video.msRequestFullscreen();
      }
    };

    window.resetViewportZoom = function() {
      let meta = document.querySelector('meta[name="viewport"]');
      if (meta) {
        meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover');
      }
      const iframe = document.getElementById('fileBrowserIframe');
      if (iframe) {
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        if (iframe.contentWindow) {
          try {
            let doc = iframe.contentWindow.document;
            if (doc) {
              let docMeta = doc.querySelector('meta[name="viewport"]');
              if (docMeta) {
                docMeta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover');
              }
              doc.documentElement.style.width = '100vw';
              doc.documentElement.style.maxWidth = '100vw';
              doc.body.style.width = '100vw';
              doc.body.style.maxWidth = '100vw';
            }
            iframe.contentWindow.scrollTo(0, 0);
          } catch(e) {}
        }
      }
      window.scrollTo(0, 0);
    };

    const mobileVidEl = document.getElementById('mobileVideoEl');
    if (mobileVidEl) {
      mobileVidEl.addEventListener('webkitendfullscreen', () => {
        window.resetViewportZoom();
      });
    }

    window.addEventListener('orientationchange', () => {
      setTimeout(() => { window.resetViewportZoom(); }, 100);
      setTimeout(() => { window.resetViewportZoom(); }, 400);
    });
    window.addEventListener('resize', window.resetViewportZoom);

    window.closeMobileVideoPlayer = function() {
      const modal = document.getElementById('mobileVideoLightbox');
      const video = document.getElementById('mobileVideoEl');
      if (video) {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch(e) {}
      }
      if (modal) modal.style.display = 'none';

      const oldModal = document.getElementById('videoPlayerOverlay');
      const oldVideo = document.getElementById('videoPlayerEl');
      if (oldVideo) { try { oldVideo.pause(); oldVideo.removeAttribute('src'); oldVideo.load(); } catch(e) {} }
      if (oldModal) oldModal.style.display = 'none';

      window.resetViewportZoom();
    };

    window.downloadVideoDirectly = function(url, name) {
      if (!url || url === 'undefined' || url === 'null') return;
      const cleanUrl = url.replace('&stream=true', '');
      window.openDownloadLinkModal(cleanUrl, name || 'video.mp4');
    };

    // Intercept messages from iframe (e.g. File Manager requesting image/video/audio/no-preview/download-modal)
    window.addEventListener('message', (e) => {
      if (!e.data) return;
      if (e.data.type === 'stream-video' || e.data.type === 'open-video') {
        const url = e.data.url || e.data.src;
        const name = e.data.name || e.data.title || 'Video Stream';
        if (url) window.openMobileVideoPlayer(url, name);
      } else if (e.data.type === 'open-image' || e.data.type === 'preview-image') {
        const url = e.data.url || e.data.src;
        const name = e.data.name || e.data.title || 'Photo Preview';
        if (url) window.openMobileImageLightbox(url, name);
      } else if (e.data.type === 'stream-audio' || e.data.type === 'open-audio') {
        const url = e.data.url || e.data.src;
        const name = e.data.name || e.data.title || 'Music Track';
        if (url) window.openMobileAudioPlayer(url, name);
      } else if (e.data.type === 'no-preview' || e.data.type === 'open-no-preview') {
        const url = e.data.url || e.data.src;
        const name = e.data.name || e.data.title || 'File Preview';
        if (url) window.openMobileNoPreview(url, name);
      } else if (e.data.type === 'open-download-modal') {
        const url = e.data.url || e.data.src;
        const name = e.data.name || e.data.title || 'Download File';
        if (url) window.openDownloadLinkModal(url, name);
      }
    });

    // ─── Mobile Audio Stream Player Handlers ─────────────────────────────
    window.openMobileAudioPlayer = function(url, title) {
      if (!url) return;
      const modal = document.getElementById('mobileAudioLightbox');
      const audio = document.getElementById('mobileAudioEl');
      const titleEl = document.getElementById('mobileAudioTitle');
      if (!modal || !audio) return;

      if (titleEl) titleEl.textContent = title || 'Music Track';
      try { audio.pause(); } catch(e) {}
      audio.src = url;
      modal.style.display = 'flex';
      audio.load();
      audio.play().catch(e => console.log('[AUDIO] Autoplay waiting for tap:', e));
    };

    window.closeMobileAudioPlayer = function() {
      const modal = document.getElementById('mobileAudioLightbox');
      const audio = document.getElementById('mobileAudioEl');
      if (audio) {
        try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch(e) {}
      }
      if (modal) modal.style.display = 'none';
    };

    window.downloadAudioDirectly = function() {
      const audio = document.getElementById('mobileAudioEl');
      const titleEl = document.getElementById('mobileAudioTitle');
      if (audio && audio.src) {
        const cleanUrl = audio.src.replace('&stream=true', '');
        downloadPhotoDirectly(cleanUrl, titleEl ? titleEl.textContent : 'music.mp3');
      }
    };

    // ─── Mobile No-Preview Handler ─────────────────────────────
    let noPreviewDownloadUrl = '';
    let noPreviewDownloadName = '';

    window.openMobileNoPreview = function(url, title) {
      if (!url) return;
      noPreviewDownloadUrl = url;
      noPreviewDownloadName = title || 'file';
      const modal = document.getElementById('mobileNoPreviewLightbox');
      const titleEl = document.getElementById('mobileNoPreviewTitle');
      if (!modal) return;

      if (titleEl) titleEl.textContent = title || 'File Preview';
      modal.style.display = 'flex';
    };

    window.closeMobileNoPreview = function() {
      const modal = document.getElementById('mobileNoPreviewLightbox');
      if (modal) modal.style.display = 'none';
    };

    window.downloadNoPreviewFile = function() {
      if (noPreviewDownloadUrl) {
        downloadPhotoDirectly(noPreviewDownloadUrl, noPreviewDownloadName);
      }
    };

    // Global image click interceptor for PWA touch UI
    document.addEventListener('click', (e) => {
      const img = e.target.closest('img');
      if (img && img.id !== 'mobileLightboxImg' && img.src && !img.src.includes('about:blank')) {
        const isClickable = img.id === 'mobilePreviewImg' || img.id === 'mobileScreenshotImg' || img.closest('.receive-item') || img.closest('.file-card') || img.closest('.file-row');
        if (isClickable || (img.naturalWidth > 60 && img.naturalHeight > 60)) {
          e.stopPropagation();
          const src = img.src;
          const title = img.alt || img.title || 'Photo Preview';
          window.openMobileImageLightbox(src, title);
        }
      }
    });

    // ─── Quick PC Actions & Clipboard Integration ────────────────
    function setupQuickPCActions() {
      const mobileTextInput = document.getElementById('mobileTextInput');
      const btnClearTextTop = document.getElementById('btnClearTextTop');

      const toggleClearBtn = () => {
        if (!btnClearTextTop || !mobileTextInput) return;
        if (mobileTextInput.value && mobileTextInput.value.trim().length > 0) {
          btnClearTextTop.style.display = 'inline-flex';
        } else {
          btnClearTextTop.style.display = 'none';
        }
      };

      if (mobileTextInput) {
        mobileTextInput.addEventListener('input', toggleClearBtn);
        mobileTextInput.addEventListener('keyup', toggleClearBtn);
        mobileTextInput.addEventListener('change', toggleClearBtn);
      }

      const handlePasteText = async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            const clipText = await navigator.clipboard.readText();
            if (clipText && clipText.trim()) {
              if (mobileTextInput) mobileTextInput.value = clipText;
              switchSendTab('text');
              toggleClearBtn();
              showToast('Clipboard text pasted!', 'success');
              return;
            }
          }
        } catch (err) {
          console.warn('Clipboard read error:', err);
        }
        switchSendTab('text');
        if (mobileTextInput) mobileTextInput.focus();
        showToast('Type or paste text to send', 'info');
      };

      document.getElementById('btnPasteTextTop')?.addEventListener('click', handlePasteText);

      btnClearTextTop?.addEventListener('click', () => {
        if (mobileTextInput) {
          mobileTextInput.value = '';
          mobileTextInput.focus();
        }
        toggleClearBtn();
        showToast('Text cleared', 'info');
      });

      document.getElementById('btnQuickCamera')?.addEventListener('click', () => {
        switchSendTab('file');
        const fileInput = document.getElementById('mobileFileInput');
        if (fileInput) fileInput.click();
      });

      document.getElementById('btnQuickFiles')?.addEventListener('click', () => {
        const fileManagerCard = document.getElementById('btnOpenFileManagerCard');
        if (fileManagerCard) {
          fileManagerCard.click();
        } else {
          const overlay = document.getElementById('fileManagerOverlay');
          if (overlay) overlay.style.display = 'flex';
        }
      });

      document.getElementById('btnQuickScreen')?.addEventListener('click', () => {
        document.getElementById('btnOpenScreencast')?.click();
      });

      document.getElementById('btnQuickTrackpad')?.addEventListener('click', () => {
        document.getElementById('btnOpenTrackpad')?.click();
      });
    }

    // ─── Start ────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);
  