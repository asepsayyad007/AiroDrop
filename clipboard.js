/**
 * clipboard.js — Cross-platform clipboard integration
 * Uses clipboardy for Windows/Mac/Linux support
 */

const path = require('path');
const fs = require('fs');

// clipboardy v4 is ESM-only; use dynamic import()
let clipboardyWrite = null;
async function getClipboardy() {
  if (!clipboardyWrite) {
    const mod = await import('clipboardy');
    clipboardyWrite = mod.default ? mod.default.write : mod.write;
  }
  return clipboardyWrite;
}

/**
 * Write text to the system clipboard
 */
async function copyText(text) {
  try {
    const write = await getClipboardy();
    await write(text);
    return { success: true };
  } catch (err) {
    console.error('[Clipboard] Failed to copy text:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Write image file to the clipboard (Windows only — uses PowerShell)
 * Falls back to just saving the file if clipboard write fails
 */
async function copyImage(imagePath) {
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      const absPath = path.resolve(imagePath).replace(/\//g, '\\');
      // Use PowerShell to load image into clipboard
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
      console.log('[Clipboard] Image clipboard copy is only supported on Windows');
      return { success: false, error: 'Image clipboard copy only supported on Windows' };
    }
  } catch (err) {
    console.error('[Clipboard] Failed to copy image:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { copyText, copyImage };