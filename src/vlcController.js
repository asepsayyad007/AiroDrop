const os = require('os');
const koffi = require('koffi');

let user32 = null;
let EnumWindows = null;
let GetWindowTextW = null;
let PostMessageW = null;
let SetForegroundWindow = null;
let keybd_event = null;

if (os.platform() === 'win32') {
  try {
    user32 = koffi.load('user32.dll');
    const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)');
    EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc* lpEnumFunc, intptr_t lParam)');
    GetWindowTextW = user32.func('int GetWindowTextW(uintptr_t hwnd, char16* lpString, int nMaxCount)');
    PostMessageW = user32.func('bool PostMessageW(uintptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
    SetForegroundWindow = user32.func('bool SetForegroundWindow(uintptr_t hwnd)');
    keybd_event = user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)');
  } catch (err) {
    console.error('[VLC-FFI] Failed to load user32 FFI:', err.message);
  }
}

/**
 * Enumerate open windows to locate VLC media player
 * @returns {{ hwnd: number, title: string } | null}
 */
function findVlcWindow() {
  if (!EnumWindows || !GetWindowTextW) return null;
  
  let vlcHwnd = null;
  let vlcTitle = '';
  
  try {
    EnumWindows((hwnd, lParam) => {
      const buf = Buffer.alloc(1024); // 512 char16 characters
      const len = GetWindowTextW(hwnd, buf, 512);
      if (len > 0) {
        const title = buf.toString('utf16le', 0, len * 2).trim();
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.includes('vlc media player')) {
          vlcHwnd = hwnd;
          if (title.endsWith(' - VLC media player')) {
            vlcTitle = title.substring(0, title.length - ' - VLC media player'.length).trim();
          } else if (lowerTitle === 'vlc media player') {
            vlcTitle = 'VLC media player';
          } else {
            vlcTitle = title;
          }
          return false; // Stop enumeration
        }
      }
      return true; // Continue enumeration
    }, 0);
  } catch (err) {
    console.error('[VLC-FFI] EnumWindows error:', err.message);
  }
  
  if (vlcHwnd) {
    return { hwnd: vlcHwnd, title: vlcTitle };
  }
  return null;
}

/**
 * Send keyboard events to VLC window handle
 * @param {string} action - VLC remote action
 * @returns {boolean} Success state
 */
function sendVlcAction(action) {
  if (action === 'vlc_close' || action === 'vlc_quit') {
    const vlc = findVlcWindow();
    if (vlc && vlc.hwnd && PostMessageW) {
      try {
        PostMessageW(vlc.hwnd, 0x0010, 0, 0); // WM_CLOSE message
      } catch (_) {}
    }
    try {
      const { exec } = require('child_process');
      exec('taskkill /IM vlc.exe /F', (err) => {
        if (err) console.error('[VLC] taskkill error:', err ? err.message : '');
      });
    } catch (_) {}
    return true;
  }

  const vlc = findVlcWindow();
  if (!vlc) return false;
  
  const hwnd = vlc.hwnd;
  const WM_KEYDOWN = 0x0100;
  const WM_KEYUP = 0x0101;
  const WM_SYSKEYDOWN = 0x0104;
  const WM_SYSKEYUP = 0x0105;
  
  // Virtual Key Codes
  const VK_SHIFT = 0x10;
  const VK_CONTROL = 0x11;
  const VK_MENU = 0x12; // Alt key
  const VK_SPACE = 0x20;
  const VK_LEFT = 0x25;
  const VK_UP = 0x26;
  const VK_RIGHT = 0x27;
  const VK_DOWN = 0x28;
  const VK_B = 0x42; // cycle audio tracks
  const VK_F = 0x46; // fullscreen
  const VK_M = 0x4D; // mute
  const VK_V = 0x56; // cycle subtitle tracks

  const KEYEVENTF_EXTENDEDKEY = 0x0001;
  const KEYEVENTF_KEYUP = 0x0002;

  // Helper: send key combination via keybd_event
  function sendShortcut(vkKey, modifiers = {}) {
    if (SetForegroundWindow && hwnd) {
      try {
        SetForegroundWindow(hwnd);
      } catch (_) {}
    }

    if (keybd_event) {
      if (modifiers.ctrl) keybd_event(VK_CONTROL, 0, 0, 0);
      if (modifiers.alt) keybd_event(VK_MENU, 0, 0, 0);
      if (modifiers.shift) keybd_event(VK_SHIFT, 0, 0, 0);

      const isExtended = (vkKey === VK_LEFT || vkKey === VK_RIGHT || vkKey === VK_UP || vkKey === VK_DOWN);
      const flagsDown = isExtended ? KEYEVENTF_EXTENDEDKEY : 0;
      const flagsUp = isExtended ? (KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP) : KEYEVENTF_KEYUP;

      keybd_event(vkKey, 0, flagsDown, 0);
      keybd_event(vkKey, 0, flagsUp, 0);

      if (modifiers.shift) keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0);
      if (modifiers.alt) keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
      if (modifiers.ctrl) keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
    } else if (PostMessageW) {
      // Fallback PostMessage
      if (modifiers.alt) {
        PostMessageW(hwnd, WM_SYSKEYDOWN, VK_MENU, 0x20000001);
        PostMessageW(hwnd, WM_SYSKEYDOWN, vkKey, 0x20000001);
        PostMessageW(hwnd, WM_SYSKEYUP, vkKey, 0xC0000001);
        PostMessageW(hwnd, WM_SYSKEYUP, VK_MENU, 0xC0000001);
      } else if (modifiers.ctrl) {
        PostMessageW(hwnd, WM_KEYDOWN, VK_CONTROL, 0);
        PostMessageW(hwnd, WM_KEYDOWN, vkKey, 0);
        PostMessageW(hwnd, WM_KEYUP, vkKey, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_CONTROL, 0);
      } else {
        PostMessageW(hwnd, WM_KEYDOWN, vkKey, 0);
        PostMessageW(hwnd, WM_KEYUP, vkKey, 0);
      }
    }
  }
  
  try {
    switch (action) {
      case 'vlc_play_pause':
        sendShortcut(VK_SPACE);
        break;
      case 'vlc_seek_backward_10s':
        // Alt + Left (Short Jump: 10 seconds)
        sendShortcut(VK_LEFT, { alt: true });
        break;
      case 'vlc_seek_forward_10s':
        // Alt + Right (Short Jump: 10 seconds)
        sendShortcut(VK_RIGHT, { alt: true });
        break;
      case 'vlc_seek_backward_60s':
        // Ctrl + Left (Medium Jump: 1 minute)
        sendShortcut(VK_LEFT, { ctrl: true });
        break;
      case 'vlc_seek_forward_60s':
        // Ctrl + Right (Medium Jump: 1 minute)
        sendShortcut(VK_RIGHT, { ctrl: true });
        break;
      case 'vlc_seek_backward_300s':
        // Ctrl + Alt + Left (Long Jump: 5 minutes)
        sendShortcut(VK_LEFT, { ctrl: true, alt: true });
        break;
      case 'vlc_seek_forward_300s':
        // Ctrl + Alt + Right (Long Jump: 5 minutes)
        sendShortcut(VK_RIGHT, { ctrl: true, alt: true });
        break;
      case 'vlc_volume_up':
        // Ctrl + Up
        sendShortcut(VK_UP, { ctrl: true });
        break;
      case 'vlc_volume_down':
        // Ctrl + Down
        sendShortcut(VK_DOWN, { ctrl: true });
        break;
      case 'vlc_mute':
        // m key
        sendShortcut(VK_M);
        break;
      case 'vlc_fullscreen':
        // f key
        sendShortcut(VK_F);
        break;
      case 'vlc_subtitles':
        // v key
        sendShortcut(VK_V);
        break;
      case 'vlc_audio_track':
        // b key
        sendShortcut(VK_B);
        break;
      default:
        return false;
    }
    return true;
  } catch (err) {
    console.error(`[VLC-FFI] Failed to post message for action ${action}:`, err.message);
    return false;
  }
}

module.exports = {
  findVlcWindow,
  sendVlcAction
};
