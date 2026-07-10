/**
 * clipboard.js — Cross-platform clipboard integration
 * Uses Electron's native clipboard when running inside Electron,
 * and falls back to clipboardy/PowerShell when running in terminal mode.
 */

const path = require('path');
const fs = require('fs');

// Check if running inside Electron
const isElectron = !!(process.versions && process.versions.electron);

let electronClipboard = null;
let electronNativeImage = null;

if (isElectron) {
  try {
    const electron = require('electron');
    electronClipboard = electron.clipboard;
    electronNativeImage = electron.nativeImage;
  } catch (e) {
    console.error('[Clipboard] Failed to load Electron clipboard modules:', e.message);
  }
}

// clipboardy v4 is ESM-only; use dynamic import() as a fallback
let clipboardyWrite = null;
async function getClipboardy() {
  if (!clipboardyWrite) {
    const mod = await import('clipboardy');
    clipboardyWrite = mod.default ? mod.default.write : mod.write;
  }
  return clipboardyWrite;
}

let clipboardyRead = null;
async function getClipboardyRead() {
  if (!clipboardyRead) {
    const mod = await import('clipboardy');
    clipboardyRead = mod.default ? mod.default.read : mod.read;
  }
  return clipboardyRead;
}

/**
 * Read text from the system clipboard
 */
async function readText() {
  try {
    if (electronClipboard) {
      return { success: true, text: electronClipboard.readText() || '' };
    }
    const read = await getClipboardyRead();
    const text = await read();
    return { success: true, text: text || '' };
  } catch (err) {
    console.error('[Clipboard] Failed to read text:', err.message);
    return { success: false, error: err.message, text: '' };
  }
}

/**
 * Write text to the system clipboard
 */
async function copyText(text) {
  try {
    if (electronClipboard) {
      electronClipboard.writeText(text);
      return { success: true };
    }
    // Fallback for terminal-only node execution
    const write = await getClipboardy();
    await write(text);
    return { success: true };
  } catch (err) {
    console.error('[Clipboard] Failed to copy text:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Write image file to the clipboard
 */
async function copyImage(imagePath) {
  try {
    if (electronClipboard && electronNativeImage) {
      const absPath = path.resolve(imagePath);
      if (fs.existsSync(absPath)) {
        const nativeImg = electronNativeImage.createFromPath(absPath);
        electronClipboard.writeImage(nativeImg);
        return { success: true };
      } else {
        throw new Error('Image file does not exist: ' + absPath);
      }
    }

    // Fallback for terminal-only node execution (Windows only)
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      const absPath = path.resolve(imagePath).replace(/\//g, '\\');
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
$img = [System.Drawing.Image]::FromFile('${absPath}');
[System.Windows.Forms.Clipboard]::SetImage($img);
$img.Dispose();
`;
      execSync(`powershell -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
        timeout: 10000,
        windowsHide: true
      });
      return { success: true };
    } else {
      console.log('[Clipboard] Image clipboard copy is only supported on Windows in terminal mode');
      return { success: false, error: 'Image clipboard copy only supported on Windows' };
    }
  } catch (err) {
    console.error('[Clipboard] Failed to copy image:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { copyText, copyImage, readText };