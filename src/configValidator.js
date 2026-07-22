/**
 * configValidator.js — Config validation and normalization
 * Validates config.json values on load, applies defaults, and coerces types.
 */

const path = require('path');
const os = require('os');
const C = require('./constants');
const { getLogger } = require('./logger');

/**
 * Validate and normalize a raw config object from config.json.
 * Returns a clean config with all values coerced to correct types and defaults applied.
 * Logs warnings for invalid values that fall back to defaults.
 *
 * @param {object} raw - Raw parsed JSON from config.json
 * @param {string} baseDir - Base directory for resolving relative paths
 * @returns {object} Validated and normalized config object
 */
function validateConfig(raw, baseDir) {
  const logger = getLogger();
  const config = {};

  // ─── Port ───────────────────────────────────────────────────
  if (raw.port !== undefined) {
    const port = parseInt(raw.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      logger.warn('Invalid port in config, using default', { value: raw.port, default: C.DEFAULT_PORT });
      config.port = C.DEFAULT_PORT;
    } else {
      config.port = port;
    }
  } else {
    config.port = C.DEFAULT_PORT;
  }

  // ─── Device Name ────────────────────────────────────────────
  if (raw.deviceName !== undefined) {
    const name = String(raw.deviceName).trim().replace(/[\x00-\x1f<>'";&|`$]/g, '');
    config.deviceName = name.slice(0, C.MAX_DEVICE_NAME_LENGTH) || C.DEFAULT_DEVICE_NAME;
  } else {
    config.deviceName = C.DEFAULT_DEVICE_NAME;
  }

  // ─── Directories ────────────────────────────────────────────
  config.saveDir = resolveDir(raw.saveDir, baseDir, 'received', logger);
  config.shareDir = raw.shareDir
    ? resolveDir(raw.shareDir, baseDir, 'shared', logger)
    : config.saveDir; // Default shareDir to saveDir

  // ─── Boolean Settings ───────────────────────────────────────
  config.temporaryMode = toBool(raw.temporaryMode, false);
  config.rateLimitEnabled = toBool(raw.rateLimitEnabled, true);
  config.notificationsEnabled = toBool(raw.notificationsEnabled, true);
  config.autoOpenLinks = toBool(raw.autoOpenLinks, false);
  config.launchOnStartup = toBool(raw.launchOnStartup, false);
  config.autoUpdate = toBool(raw.autoUpdate, true);
  config.httpsEnabled = toBool(raw.httpsEnabled, false);
  config.contextMenuEnabled = toBool(raw.contextMenuEnabled, false);

  // ─── Numeric Settings ───────────────────────────────────────
  config.temporaryModeHours = clampFloat(
    raw.temporaryModeHours,
    C.MIN_TEMPORARY_MODE_HOURS,
    C.MAX_TEMPORARY_MODE_HOURS,
    C.DEFAULT_TEMPORARY_MODE_HOURS
  );

  // ─── Security ──────────────────────────────────────────────
  if (raw.securityMode && C.SECURITY_MODES.includes(raw.securityMode)) {
    config.securityMode = raw.securityMode;
  } else {
    if (raw.securityMode !== undefined) {
      logger.warn('Invalid securityMode in config, using default', { value: raw.securityMode });
    }
    config.securityMode = C.DEFAULT_SECURITY_MODE;
  }

  // PIN: must be 4-8 digits
  if (raw.pinCode !== undefined) {
    const pin = String(raw.pinCode).trim();
    if (/^\d{4,8}$/.test(pin)) {
      config.pinCode = pin;
    } else {
      logger.warn('Invalid pinCode in config, will auto-generate');
      config.pinCode = '';
    }
  } else {
    config.pinCode = '';
  }

  // Shortcut secret
  config.shortcutSecret = raw.shortcutSecret !== undefined
    ? String(raw.shortcutSecret).trim().replace(/[\x00-\x1f]/g, '').slice(0, 128)
    : C.DEFAULT_SHORTCUT_SECRET;

  return config;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Resolve a directory path from config (absolute or relative to baseDir).
 * @param {string|undefined} value - Raw directory value
 * @param {string} baseDir - Base directory for relative resolution
 * @param {string} fallbackName - Fallback subdirectory name
 * @param {object} logger - Logger instance
 * @returns {string} Resolved absolute path
 */
function resolveDir(value, baseDir, fallbackName, logger) {
  if (!value) return path.join(baseDir, fallbackName);
  
  try {
    const resolved = path.isAbsolute(value) ? value : path.resolve(baseDir, value);
    return resolved;
  } catch (err) {
    logger.warn('Invalid directory path in config', { value, error: err.message });
    return path.join(baseDir, fallbackName);
  }
}

/**
 * Coerce a value to boolean with a default.
 * @param {*} value - Raw value
 * @param {boolean} defaultVal - Default if undefined
 * @returns {boolean}
 */
function toBool(value, defaultVal) {
  if (value === undefined || value === null) return defaultVal;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
  return !!value;
}

/**
 * Clamp a float value within a range, with default fallback.
 * @param {*} value - Raw value
 * @param {number} min - Minimum
 * @param {number} max - Maximum
 * @param {number} defaultVal - Default if invalid
 * @returns {number}
 */
function clampFloat(value, min, max, defaultVal) {
  if (value === undefined || value === null) return defaultVal;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) return defaultVal;
  return Math.max(min, Math.min(max, parsed));
}

module.exports = { validateConfig };
