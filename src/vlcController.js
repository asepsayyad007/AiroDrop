const os = require('os');
const koffi = require('koffi');

let user32 = null;
let EnumWindows = null;
let GetWindowTextW = null;
let PostMessageW = null;

if (os.platform() === 'win32') {
  try {
    user32 = koffi.load('user32.dll');
    const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)');
    EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc* lpEnumFunc, intptr_t lParam)');
    GetWindowTextW = user32.func('int GetWindowTextW(uintptr_t hwnd, char16* lpString, int nMaxCount)');
    PostMessageW = user32.func('bool PostMessageW(uintptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
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
        if (title.endsWith(' - VLC media player')) {
          vlcHwnd = hwnd;
          vlcTitle = title.substring(0, title.length - ' - VLC media player'.length).trim();
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
 * Post keyboard events to VLC window handle
 * @param {string} action - VLC remote action
 * @returns {boolean} Success state
 */
function sendVlcAction(action) {
  const vlc = findVlcWindow();
  if (!vlc) return false;
  
  const hwnd = vlc.hwnd;
  const WM_KEYDOWN = 0x0100;
  const WM_KEYUP = 0x0101;
  const WM_SYSKEYDOWN = 0x0104;
  const WM_SYSKEYUP = 0x0105;
  
  // Virtual Key Codes
  const VK_SPACE = 0x20;
  const VK_LEFT = 0x25;
  const VK_UP = 0x26;
  const VK_RIGHT = 0x27;
  const VK_DOWN = 0x28;
  const VK_B = 0x42; // cycle audio tracks
  const VK_F = 0x46; // fullscreen
  const VK_M = 0x4D; // mute
  const VK_V = 0x56; // cycle subtitle tracks
  
  try {
    switch (action) {
      case 'vlc_play_pause':
        PostMessageW(hwnd, WM_KEYDOWN, VK_SPACE, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_SPACE, 0);
        break;
      case 'vlc_seek_backward_10s':
        // Alt + Left
        // Bit 29 (0x20000000) indicates ALT down
        PostMessageW(hwnd, WM_SYSKEYDOWN, VK_LEFT, 0x20000001);
        PostMessageW(hwnd, WM_SYSKEYUP, VK_LEFT, 0xC0000001);
        break;
      case 'vlc_seek_forward_10s':
        // Alt + Right
        PostMessageW(hwnd, WM_SYSKEYDOWN, VK_RIGHT, 0x20000001);
        PostMessageW(hwnd, WM_SYSKEYUP, VK_RIGHT, 0xC0000001);
        break;
      case 'vlc_seek_backward_60s':
        // Ctrl + Left
        PostMessageW(hwnd, WM_KEYDOWN, VK_LEFT, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_LEFT, 0);
        break;
      case 'vlc_seek_forward_60s':
        // Ctrl + Right
        PostMessageW(hwnd, WM_KEYDOWN, VK_RIGHT, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_RIGHT, 0);
        break;
      case 'vlc_volume_up':
        // Ctrl + Up
        PostMessageW(hwnd, WM_KEYDOWN, VK_UP, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_UP, 0);
        break;
      case 'vlc_volume_down':
        // Ctrl + Down
        PostMessageW(hwnd, WM_KEYDOWN, VK_DOWN, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_DOWN, 0);
        break;
      case 'vlc_mute':
        // m key
        PostMessageW(hwnd, WM_KEYDOWN, VK_M, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_M, 0);
        break;
      case 'vlc_fullscreen':
        // f key
        PostMessageW(hwnd, WM_KEYDOWN, VK_F, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_F, 0);
        break;
      case 'vlc_subtitles':
        // v key
        PostMessageW(hwnd, WM_KEYDOWN, VK_V, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_V, 0);
        break;
      case 'vlc_audio_track':
        // b key
        PostMessageW(hwnd, WM_KEYDOWN, VK_B, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_B, 0);
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
