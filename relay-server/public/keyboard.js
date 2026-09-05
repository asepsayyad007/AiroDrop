/**
 * AiroDrop - Full-Fledged Remote PC Keyboard & Trackpad Controller
 * (public/keyboard.js) - v7.0
 */

(function () {
  'use strict';

  // State
  var isShiftActive = false;
  var isCapsActive  = false;
  var activeModifiers = { ctrl: false, alt: false, win: false };

  // Virtual Key Codes (Windows)
  var VK = {
    SHIFT: 0x10, CTRL: 0x11, ALT: 0x12, CAPS: 0x14,
    ESC: 0x1B, SPACE: 0x20, PAGE_UP: 0x21, PAGE_DOWN: 0x22,
    END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
    INSERT: 0x2D, DELETE: 0x2E, WIN: 0x5B,
    BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0D,
    F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73,
    F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77,
    F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B
  };

  // Quick Shortcuts - Copy, Paste & more
  var QUICK_SHORTCUTS = [
    { label: 'Copy',       desc: 'Ctrl+C',         keys: [0x11, 0x43], color: '#19d879' },
    { label: 'Paste',      desc: 'Ctrl+V',         keys: [0x11, 0x56], color: '#19d879' },
    { label: 'Cut',        desc: 'Ctrl+X',         keys: [0x11, 0x58], color: '#f97316' },
    { label: 'Undo',       desc: 'Ctrl+Z',         keys: [0x11, 0x5A], color: '#ffb000' },
    { label: 'Redo',       desc: 'Ctrl+Y',         keys: [0x11, 0x59], color: '#ffb000' },
    { label: 'Select All', desc: 'Ctrl+A',         keys: [0x11, 0x41], color: '#3b82f6' },
    { label: 'Save',       desc: 'Ctrl+S',         keys: [0x11, 0x53], color: '#06b6d4' },
    { label: 'Find',       desc: 'Ctrl+F',         keys: [0x11, 0x46], color: '#06b6d4' },
    { label: 'Switch App', desc: 'Alt+Tab',        keys: [0x12, 0x09], color: '#8b5cf6' },
    { label: 'Close App',  desc: 'Alt+F4',         keys: [0x12, 0x73], color: '#ef4444' },
    { label: 'Desktop',    desc: 'Win+D',          keys: [0x5B, 0x44], color: '#765cff' },
    { label: 'Explorer',   desc: 'Win+E',          keys: [0x5B, 0x45], color: '#a855f7' },
    { label: 'Search',     desc: 'Win+S',          keys: [0x5B, 0x53], color: '#8b5cf6' },
    { label: 'Task Mgr',   desc: 'Ctrl+Shift+Esc', keys: [0x11, 0x10, 0x1B], color: '#14b8a6' },
    { label: 'Lock PC',    desc: 'Win+L',          keys: [0x5B, 0x4C], color: '#ec4899' },
    { label: 'Screenshot', desc: 'PrtSc',          keys: [0x2C],       color: '#06b6d4' }
  ];

  // Haptic feedback
  function haptic(ms) {
    ms = ms || 14;
    if (typeof window.triggerHaptic === 'function') {
      window.triggerHaptic(ms);
    } else if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (e) {}
    }
  }

  // WebSocket send - robust multi-fallback
  function ws_send(data) {
    if (typeof window.sendWS === 'function') {
      window.sendWS(data);
      return true;
    }
    var sock = window.trackpadSocket;
    if (sock && sock.readyState === 1) {
      sock.send(JSON.stringify(data));
      return true;
    }
    if (typeof window.connectWS === 'function') {
      window.wsWantsConnected = true;
      window.connectWS();
    }
    return false;
  }

  function sendShortcut(keys) {

    haptic(20);
    ws_send({ type: 'shortcut', keys: keys });
  }

  function sendKey(code) {
    haptic(12);
    ws_send({ type: 'key', code: code });
  }

  function sendText(str) {
    if (!str) return;
    haptic(10);
    ws_send({ type: 'type', text: str });
  }

  function resetModifiers() {
    activeModifiers.ctrl = false;
    activeModifiers.alt  = false;
    activeModifiers.win  = false;
    document.querySelectorAll('.btn-rk-mod').forEach(function(b) {
      b.classList.remove('active-toggle');
    });
  }

  function updateLabels() {
    var upper = isShiftActive || isCapsActive;
    document.querySelectorAll('.btn-rk-kbd[data-char]').forEach(function(btn) {
      var norm  = btn.getAttribute('data-char');
      var shift = btn.getAttribute('data-shift');
      if (isShiftActive && shift) {
        btn.textContent = shift;
      } else if (upper && norm && norm.length === 1 && norm >= 'a' && norm <= 'z') {
        btn.textContent = norm.toUpperCase();
      } else if (norm) {
        btn.textContent = norm;
      }
    });
  }

  function openOverlay() {
    haptic(20);
    if (!window.trackpadSocket || window.trackpadSocket.readyState !== 1) {
      window.wsWantsConnected = true;
      if (typeof window.connectWS === 'function') window.connectWS();
    }
    var ov = document.getElementById('remoteKeyboardOverlay');
    if (ov) {
      ov.style.display = 'flex';
      updateLabels();
    }
  }

  function closeOverlay() {
    haptic(15);
    var ov = document.getElementById('remoteKeyboardOverlay');
    if (ov) ov.style.display = 'none';
    var drawer = document.getElementById('rkMobileInputDrawer');
    if (drawer) drawer.style.display = 'none';
    var pillBtn = document.getElementById('btnRkToggleMobileInput');
    if (pillBtn) pillBtn.classList.remove('active');
    var input = document.getElementById('rkInputText');
    if (input) input.blur();
    isShiftActive = false;
    document.querySelectorAll('.btn-rk-shift').forEach(function(s) {
      s.classList.remove('active-toggle');
    });
    resetModifiers();
    updateLabels();
  }

  function handleKeyPress(btn, e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    haptic(15);

    var code     = parseInt(btn.getAttribute('data-code'), 10);
    var normChar = btn.getAttribute('data-char');
    var shiftCh  = btn.getAttribute('data-shift');

    if (code === 20) {
      isCapsActive = !isCapsActive;
      btn.classList.toggle('active-toggle', isCapsActive);
      updateLabels();
      sendKey(20);
      return;
    }
    if (code === 16) {
      isShiftActive = !isShiftActive;
      document.querySelectorAll('.btn-rk-shift').forEach(function(s) {
        s.classList.toggle('active-toggle', isShiftActive);
      });
      updateLabels();
      return;
    }
    if (code === 17 || code === 18 || code === 91) {
      var mod = code === 17 ? 'ctrl' : (code === 18 ? 'alt' : 'win');
      activeModifiers[mod] = !activeModifiers[mod];
      btn.classList.toggle('active-toggle', activeModifiers[mod]);
      return;
    }

    var combo = [];
    if (activeModifiers.ctrl) combo.push(0x11);
    if (activeModifiers.alt)  combo.push(0x12);
    if (activeModifiers.win)  combo.push(0x5B);

    if (normChar) {
      var ch = normChar;
      if (isShiftActive && shiftCh) {
        ch = shiftCh;
      } else if ((isShiftActive || isCapsActive) && normChar.length === 1 && normChar >= 'a' && normChar <= 'z') {
        ch = normChar.toUpperCase();
      }
      if (combo.length > 0) {
        combo.push(ch.toUpperCase().charCodeAt(0));
        sendShortcut(combo);
        resetModifiers();
      } else {
        sendText(ch);
      }
      if (isShiftActive) {
        isShiftActive = false;
        document.querySelectorAll('.btn-rk-shift').forEach(function(s) {
          s.classList.remove('active-toggle');
        });
        updateLabels();
      }
    } else if (code) {
      if (combo.length > 0) {
        combo.push(code);
        sendShortcut(combo);
        resetModifiers();
      } else {
        sendKey(code);
      }
    }

    btn.classList.add('active-press');
    setTimeout(function() { btn.classList.remove('active-press'); }, 120);
  }

  function initTrackpad() {
    var surface = document.getElementById('rkTrackpadSurface');
    var dot     = document.getElementById('rkTrackpadCursorDot');
    if (!surface) return;

    var startX = 0, startY = 0, lastX = 0, lastY = 0;
    var startTime = 0, maxDist = 0, maxTouches = 0;
    var isScrolling = false, scrollY0 = 0, scrollAcc = 0;

    function showDot(cx, cy) {
      if (!dot) return;
      var r = surface.getBoundingClientRect();
      dot.style.display = 'block';
      dot.style.left = (cx - r.left) + 'px';
      dot.style.top  = (cy - r.top)  + 'px';
    }
    function hideDot() { if (dot) dot.style.display = 'none'; }

    surface.addEventListener('touchstart', function(e) {
      e.preventDefault(); e.stopPropagation();
      var t = e.touches;
      maxTouches  = t.length;
      startTime   = Date.now();
      maxDist     = 0;
      isScrolling = false;
      if (t.length === 1) {
        startX = lastX = t[0].clientX;
        startY = lastY = t[0].clientY;
        showDot(t[0].clientX, t[0].clientY);
      } else if (t.length === 2) {
        isScrolling = true;
        scrollY0    = (t[0].clientY + t[1].clientY) / 2;
        scrollAcc   = 0;
        hideDot();
      }
    }, { passive: false });

    surface.addEventListener('touchmove', function(e) {
      e.preventDefault(); e.stopPropagation();
      var t = e.touches;
      if (t.length === 2) {
        var cy  = (t[0].clientY + t[1].clientY) / 2;
        var dy  = cy - scrollY0;
        scrollAcc  += dy;
        scrollY0    = cy;
        isScrolling = true;
        while (scrollAcc > 3)  { ws_send({ type: 'scroll', amount: -120 }); scrollAcc -= 3; }
        while (scrollAcc < -3) { ws_send({ type: 'scroll', amount:  120 }); scrollAcc += 3; }
      } else if (t.length === 1 && !isScrolling) {
        var cx  = t[0].clientX;
        var cy2 = t[0].clientY;
        var d   = Math.hypot(cx - startX, cy2 - startY);
        if (d > maxDist) maxDist = d;
        ws_send({ type: 'move', dx: (cx - lastX) * 2.0, dy: (cy2 - lastY) * 2.0 });
        lastX = cx; lastY = cy2;
        showDot(cx, cy2);
      }
    }, { passive: false });

    surface.addEventListener('touchend', function(e) {
      e.preventDefault(); e.stopPropagation();
      hideDot();
      if (e.touches.length > 0) return;
      var dur = Date.now() - startTime;
      if (maxTouches === 2) {
        if (!isScrolling && dur < 350) {
          haptic(18);
          ws_send({ type: 'click', button: 'right' });
        }
        isScrolling = false;
        return;
      }
      if (maxTouches === 1 && maxDist < 12 && dur < 350) {
        haptic(14);
        ws_send({ type: 'click', button: 'left' });
      }
    }, { passive: false });

    // Mouse fallback
    var mDown = false, mStartX = 0, mStartY = 0, mLastX = 0, mLastY = 0, mTime = 0;

    surface.addEventListener('mousedown', function(e) {
      e.preventDefault();
      mDown   = true;
      mStartX = mLastX = e.clientX;
      mStartY = mLastY = e.clientY;
      mTime   = Date.now();
      showDot(e.clientX, e.clientY);
    });

    window.addEventListener('mousemove', function(e) {
      if (!mDown) return;
      ws_send({ type: 'move', dx: (e.clientX - mLastX) * 2.0, dy: (e.clientY - mLastY) * 2.0 });
      mLastX = e.clientX; mLastY = e.clientY;
      showDot(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', function(e) {
      if (!mDown) return;
      mDown = false;
      hideDot();
      var dist = Math.hypot(e.clientX - mStartX, e.clientY - mStartY);
      if (dist < 10 && (Date.now() - mTime) < 300) {
        ws_send({ type: 'click', button: e.button === 2 ? 'right' : 'left' });
      }
    });

    surface.addEventListener('contextmenu', function(e) { e.preventDefault(); });
  }

  function init() {
    var btnOpen = document.getElementById('btnOpenKeyboard');
    if (btnOpen) btnOpen.addEventListener('click', openOverlay);

    var btnClose = document.getElementById('btnCloseRemoteKeyboard');
    if (btnClose) btnClose.addEventListener('click', closeOverlay);

    // Mobile input drawer
    var btnToggleMI = document.getElementById('btnRkToggleMobileInput');
    var miDrawer    = document.getElementById('rkMobileInputDrawer');
    var rkInput     = document.getElementById('rkInputText');
    var btnClear    = document.getElementById('btnRkClearText');

    if (btnToggleMI && miDrawer) {
      btnToggleMI.addEventListener('click', function() {
        haptic(15);
        var open = miDrawer.style.display === 'flex';
        miDrawer.style.display = open ? 'none' : 'flex';
        btnToggleMI.classList.toggle('active', !open);
        if (!open && rkInput) {
          rkInput.value = '';
          setTimeout(function() { rkInput.focus(); }, 150);
        } else if (rkInput) {
          rkInput.blur();
        }
      });
    }

    // Live text sync
    var lastVal = '';
    if (rkInput) {
      rkInput.addEventListener('input', function() {
        var v = rkInput.value;
        if (v.length < lastVal.length) {
          for (var i = 0; i < lastVal.length - v.length; i++) {
            ws_send({ type: 'key', code: 0x08 });
          }
        } else {
          var added = v.substring(lastVal.length);
          for (var ci = 0; ci < added.length; ci++) {
            var ch = added[ci];
            if (ch === ' ')                    ws_send({ type: 'key', code: 0x20 });
            else if (ch === '\n' || ch === '\r') ws_send({ type: 'key', code: 0x0D });
            else                               ws_send({ type: 'type', text: ch });
          }
        }
        lastVal = v;
      });
      rkInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); ws_send({ type: 'key', code: 0x0D }); }
      });
    }

    if (btnClear && rkInput) {
      btnClear.addEventListener('click', function() {
        haptic(10); rkInput.value = ''; lastVal = ''; rkInput.focus();
      });
    }

    // Shortcuts dropdown
    var btnToggleSC = document.getElementById('btnToggleRkShortcuts');
    var scGrid      = document.getElementById('rkShortcutsGrid');
    var scArrow     = document.getElementById('rkShortcutsToggleArrow');

    if (btnToggleSC && scGrid) {
      btnToggleSC.addEventListener('click', function() {
        haptic(12);
        var hidden = scGrid.style.display === 'none' || scGrid.style.display === '';
        scGrid.style.display = hidden ? 'grid' : 'none';
        if (scArrow) scArrow.style.transform = hidden ? 'rotate(180deg)' : 'rotate(0deg)';
        btnToggleSC.classList.toggle('active', hidden);
      });
    }

    if (scGrid) {
      scGrid.innerHTML = '';
      QUICK_SHORTCUTS.forEach(function(sc) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rk-sc-btn';
        btn.style.cssText =
          'border-radius:11px;' +
          'border:1px solid ' + sc.color + '44;' +
          'background:linear-gradient(135deg,' + sc.color + '22 0%,' + sc.color + '08 100%);' +
          'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
          'box-shadow:0 4px 14px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.1);' +
          'padding:8px 5px;display:flex;flex-direction:column;align-items:center;' +
          'justify-content:center;cursor:pointer;transition:transform .12s;outline:none;width:100%;';
        btn.innerHTML =
          '<span style="font-size:.79rem;font-weight:800;color:#fff;letter-spacing:.2px;">' + sc.label + '</span>' +
          '<span style="font-size:.57rem;color:rgba(255,255,255,.65);margin-top:2px;">' + sc.desc + '</span>';
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          haptic(18);
          btn.style.transform = 'scale(0.92)';
          setTimeout(function() { btn.style.transform = ''; }, 140);
          sendShortcut(sc.keys);
        });
        scGrid.appendChild(btn);
      });
    }

    // PC Keyboard keys
    document.querySelectorAll('.btn-rk-kbd').forEach(function(btn) {
      btn.addEventListener('touchstart', function(e) {
        handleKeyPress(btn, e);
      }, { passive: false });
      btn.addEventListener('click', function(e) {
        if (e.detail === 0) return;
        handleKeyPress(btn, e);
      });
    });

    // Trackpad
    initTrackpad();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.AiroKeyboard = {
    open:         openOverlay,
    close:        closeOverlay,
    sendShortcut: sendShortcut,
    sendKey:      sendKey,
    sendText:     sendText
  };

})();
