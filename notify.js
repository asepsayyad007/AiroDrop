/**
 * notify.js — Windows toast notifications
 * Uses node-notifier for cross-platform desktop notifications
 */

const notifier = require('node-notifier');

/**
 * Show a desktop notification when content is received
 * @param {string} title - Notification title
 * @param {string} message - Notification body text
 * @param {object} options - Additional options (icon path, etc.)
 */
function notify(title, message, options = {}) {
  notifier.notify({
    title: title || 'AirDrop to PC',
    message: message || 'New content received',
    icon: options.icon || undefined,
    sound: true,
    wait: false,
    appID: 'com.ios-win-integration.airdrop',
    ...options
  });
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