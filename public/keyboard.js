/**
 * AiroDrop - Dedicated Remote Keyboard & PC Hotkey Controller
 * (public/keyboard.js)
 */

(function () {
  'use strict';

  // ── State Variables ──
  let activeModifiers = {
    ctrl: false,
    alt: false,
    shift: false,
    win: false
  };

  // Virtual Key Codes for Windows
  const VK = {
    SHIFT: 0x10,
    CTRL: 0x11,
    ALT: 0x12,
    PAUSE: 0x13,
    CAPS: 0x14,
    ESC: 0x1B,
    SPACE: 0x20,
    PAGE_UP: 0x21,
    PAGE_DOWN: 0x22,
    END: 0x23,
    HOME: 0x24,
    LEFT: 0x25,
    UP: 0x26,
    RIGHT: 0x27,
    DOWN: 0x28,
    PRTSCN: 0x2C,
    INSERT: 0x2D,
    DELETE: 0x2E,
    WIN: 0x5B,
    BACKSPACE: 0x08,
    TAB: 0x09,
    ENTER: 0x0D,
    F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73,
    F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77,
    F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B
  };

  // Pre-defined PC Hotkeys (Name, Icon/Badge, Keys Array)
  const QUICK_SHORTCUTS = [
    { label: 'Alt + F4', desc: 'Close App', keys: [VK.ALT, VK.F4], color: '#ff4d4f' },
    { label: 'Win + D', desc: 'Show Desktop', keys: [VK.WIN, 0x44], color: '#765cff' },
    { label: 'Alt + Tab', desc: 'Switch Task', keys: [VK.ALT, VK.TAB], color: '#06b6d4' },
    { label: 'Ctrl + C', desc: 'Copy', keys: [VK.CTRL, 0x43], color: '#19d879' },
    { label: 'Ctrl + V', desc: 'Paste', keys: [VK.CTRL, 0x56], color: '#19d879' },
    { label: 'Ctrl + Z', desc: 'Undo', keys: [VK.CTRL, 0x5A], color: '#ffb000' },
    { label: 'Ctrl + A', desc: 'Select All', keys: [VK.CTRL, 0x41], color: '#3b82f6' },
    { label: 'Win + E', desc: 'Explorer', keys: [VK.WIN, 0x45], color: '#a855f7' },
    { label: 'Ctrl+Alt+Del', desc: 'Security', keys: [VK.CTRL, VK.ALT, VK.DELETE], color: '#ef4444' }
  ];

  // Helper: Trigger Haptic Feedback
  function triggerHaptic(duration = 15) {
    if (typeof window.triggerHaptic === 'function') {
      window.triggerHaptic(duration);
    } else if (navigator.vibrate) {
      try { navigator.vibrate(duration); } catch (_) {}
    }
  }

  // Helper: Send WebSocket Message to PC
  function sendWS(data) {
    if (window.trackpadSocket && window.trackpadSocket.readyState === WebSocket.OPEN) {
      window.trackpadSocket.send(JSON.stringify(data));
      return true;
    }
    // Attempt auto-connect if socket not ready
    if (typeof window.connectWS === 'function') {
      window.wsWantsConnected = true;
      window.connectWS();
    }
    return false;
  }

  // ── Core Keyboard Actions ──
  function sendShortcutKeys(keysArray) {
    triggerHaptic(20);
    sendWS({
      type: 'shortcut',
      keys: keysArray
    });
  }

  function sendSingleKey(vkCode) {
    triggerHaptic(12);
    // Combine with active sticky modifiers if selected
    const combo = [];
    if (activeModifiers.ctrl) combo.push(VK.CTRL);
    if (activeModifiers.alt) combo.push(VK.ALT);
    if (activeModifiers.shift) combo.push(VK.SHIFT);
    if (activeModifiers.win) combo.push(VK.WIN);

    if (combo.length > 0) {
      combo.push(vkCode);
      sendShortcutKeys(combo);
      // Auto reset one-shot modifiers
      resetModifiers();
    } else {
      sendWS({
        type: 'key',
        code: vkCode
      });
    }
  }

  function sendTextString(str) {
    if (!str) return;
    triggerHaptic(10);
    sendWS({
      type: 'type',
      text: str
    });
  }

  function resetModifiers() {
    activeModifiers.ctrl = false;
    activeModifiers.alt = false;
    activeModifiers.shift = false;
    activeModifiers.win = false;
    updateModifierUI();
  }

  function toggleModifier(modName) {
    triggerHaptic(15);
    activeModifiers[modName] = !activeModifiers[modName];
    updateModifierUI();
  }

  function updateModifierUI() {
    ['ctrl', 'alt', 'shift', 'win'].forEach(mod => {
      const btn = document.getElementById(`modBtn_${mod}`);
      if (btn) {
        if (activeModifiers[mod]) {
          btn.classList.add('active');
          btn.style.background = 'var(--accent)';
          btn.style.borderColor = 'var(--accent-light)';
          btn.style.color = '#ffffff';
        } else {
          btn.classList.remove('active');
          btn.style.background = 'rgba(255,255,255,0.06)';
          btn.style.borderColor = 'rgba(255,255,255,0.12)';
          btn.style.color = 'var(--text)';
        }
      }
    });
  }

  // ── Overlay Open / Close Methods ──
  function openRemoteKeyboard() {
    triggerHaptic(20);
    if (!window.trackpadSocket || window.trackpadSocket.readyState !== WebSocket.OPEN) {
      window.wsWantsConnected = true;
      if (typeof window.connectWS === 'function') window.connectWS();
    }

    const overlay = document.getElementById('remoteKeyboardOverlay');
    if (overlay) {
      overlay.style.display = 'flex';
      const input = document.getElementById('rkInputText');
      if (input) {
        input.value = '';
        setTimeout(() => input.focus(), 250);
      }
    }
  }

  function closeRemoteKeyboard() {
    triggerHaptic(15);
    const overlay = document.getElementById('remoteKeyboardOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  // ── Initialize Keyboard Module ──
  function initKeyboardModule() {
    // 1. Bind Open Keyboard Button on Tools tab
    const btnOpenKbd = document.getElementById('btnOpenKeyboard');
    if (btnOpenKbd) {
      btnOpenKbd.addEventListener('click', openRemoteKeyboard);
    }

    // 2. Bind Close Button
    const btnCloseKbd = document.getElementById('btnCloseRemoteKeyboard');
    if (btnCloseKbd) {
      btnCloseKbd.addEventListener('click', closeRemoteKeyboard);
    }

    // 3. Render Quick Shortcuts Grid
    const shortcutsGrid = document.getElementById('rkShortcutsGrid');
    if (shortcutsGrid) {
      shortcutsGrid.innerHTML = '';
      QUICK_SHORTCUTS.forEach(sc => {
        const btn = document.createElement('button');
        btn.className = 'rk-sc-btn';
        btn.style.cssText = `
          border-radius: 12px;
          border: 1px solid ${sc.color}40;
          background: ${sc.color}15;
          padding: 10px 6px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: transform 0.15s, background 0.15s;
          outline: none;
        `;
        btn.innerHTML = `
          <span style="font-size: 0.82rem; font-weight: 800; color: #ffffff;">${sc.label}</span>
          <span style="font-size: 0.62rem; color: var(--text3); margin-top: 2px;">${sc.desc}</span>
        `;
        btn.addEventListener('click', () => sendShortcutKeys(sc.keys));
        shortcutsGrid.appendChild(btn);
      });
    }

    // 4. Bind Modifiers
    ['ctrl', 'alt', 'shift', 'win'].forEach(mod => {
      const btn = document.getElementById(`modBtn_${mod}`);
      if (btn) {
        btn.addEventListener('click', () => toggleModifier(mod));
      }
    });

    // 5. Render Function Keys (F1 - F12)
    const fkeysContainer = document.getElementById('rkFKeysRow');
    if (fkeysContainer) {
      fkeysContainer.innerHTML = '';
      for (let i = 1; i <= 12; i++) {
        const vkCode = VK[`F${i}`];
        const btn = document.createElement('button');
        btn.className = 'rk-key-btn';
        btn.style.cssText = `
          flex: 1;
          min-width: 44px;
          height: 38px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.05);
          color: #ffffff;
          font-size: 0.76rem;
          font-weight: 700;
          cursor: pointer;
          outline: none;
        `;
        btn.textContent = `F${i}`;
        btn.addEventListener('click', () => sendSingleKey(vkCode));
        fkeysContainer.appendChild(btn);
      }
    }

    // 6. Bind Special Keys
    const specialKeyMap = {
      'rkKey_Esc': VK.ESC,
      'rkKey_Tab': VK.TAB,
      'rkKey_Backspace': VK.BACKSPACE,
      'rkKey_Delete': VK.DELETE,
      'rkKey_Enter': VK.ENTER,
      'rkKey_Space': VK.SPACE,
      'rkKey_Up': VK.UP,
      'rkKey_Down': VK.DOWN,
      'rkKey_Left': VK.LEFT,
      'rkKey_Right': VK.RIGHT,
      'rkKey_PgUp': VK.PAGE_UP,
      'rkKey_PgDn': VK.PAGE_DOWN,
      'rkKey_Home': VK.HOME,
      'rkKey_End': VK.END
    };

    Object.keys(specialKeyMap).forEach(elemId => {
      const btn = document.getElementById(elemId);
      if (btn) {
        btn.addEventListener('click', () => sendSingleKey(specialKeyMap[elemId]));
      }
    });

    // 7. Bind Live Text Input Diff Sync
    const input = document.getElementById('rkInputText');
    const btnSendText = document.getElementById('btnRkSendText');
    const btnClearText = document.getElementById('btnRkClearText');

    let lastVal = '';

    if (input) {
      input.addEventListener('input', (e) => {
        const val = input.value;
        if (e.inputType === 'deleteContentBackward') {
          sendSingleKey(VK.BACKSPACE);
        } else if (val.length > lastVal.length) {
          const added = val.substring(lastVal.length);
          sendTextString(added);
        }
        lastVal = val;
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          sendSingleKey(VK.ENTER);
          input.value = '';
          lastVal = '';
        }
      });
    }

    if (btnSendText && input) {
      btnSendText.addEventListener('click', () => {
        if (input.value) {
          sendTextString(input.value);
          input.value = '';
          lastVal = '';
        }
      });
    }

    if (btnClearText && input) {
      btnClearText.addEventListener('click', () => {
        triggerHaptic(10);
        input.value = '';
        lastVal = '';
      });
    }
  }

  // ── Auto DOM Ready Init ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initKeyboardModule);
  } else {
    initKeyboardModule();
  }

  // Export methods to global scope
  window.AiroKeyboard = {
    open: openRemoteKeyboard,
    close: closeRemoteKeyboard,
    sendShortcut: sendShortcutKeys,
    sendKey: sendSingleKey
  };

})();
