/**
 * notify.js — Hybrid notifications with native Electron support
 * Falls back to node-notifier when running in CLI mode.
 */

const path = require('path');

let Notification = null;
try {
  // Test if running inside Electron main process
  Notification = require('electron').Notification;
} catch (e) {
  // Not in Electron
}

/**
 * Show a desktop notification when content is received
 * @param {string} title - Notification title
 * @param {string} message - Notification body text
 * @param {object} options - Additional options
 */
function notify(title, message, options = {}) {
  const displayTitle = 'com.asep-ios-integration.airodrop';
  const displayBody = `${title ? title + ': ' : ''}${message || 'New content received'}`;

  if (Notification && Notification.isSupported()) {
    try {
      const notification = new Notification({
        title: displayTitle,
        body: displayBody,
        silent: false
      });

      notification.on('click', () => {
        try {
          const { BrowserWindow } = require('electron');
          const win = BrowserWindow.getAllWindows()[0];
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          }
        } catch (err) {
          console.error('[Notification] Focus window failed:', err);
        }
      });

      notification.show();
      return;
    } catch (err) {
      console.error('[Notification] Native notify failed, falling back:', err);
    }
  }

  // Fallback to node-notifier (CLI / generic mode)
  try {
    const notifier = require('node-notifier');
    notifier.notify({
      title: displayTitle,
      message: displayBody,
      sound: true,
      wait: true,
      appID: 'com.asep-ios-integration.airodrop',
      ...options
    });
  } catch (err) {
    console.log(`[NOTIFY FALLBACK] ${displayTitle}: ${displayBody}`);
  }
}

/**
 * Shorthand for text received notification
 */
function notifyText(text) {
  const preview = text.length > 80 ? text.substring(0, 80) + '...' : text;
  notify('Text Received', preview);
}

/**
 * Shorthand for image received notification
 */
function notifyImage(filename) {
  notify('Image Received', `Saved: ${filename}`);
}

module.exports = { notify, notifyText, notifyImage };