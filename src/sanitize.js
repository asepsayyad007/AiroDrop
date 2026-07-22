/**
 * sanitize.js — Input validation and sanitization utilities
 * Provides defense-in-depth against path traversal, injection, and malformed inputs.
 */

const path = require('path');

// ─── Constants ────────────────────────────────────────────────
const MAX_FILENAME_LENGTH = 200;
const MAX_TEXT_LENGTH = 10 * 1024 * 1024; // 10 MB text limit
const MAX_DEVICE_NAME_LENGTH = 64;
const MAX_PATH_DEPTH = 20;

// Characters that are unsafe in filenames across platforms
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]/g;
// Null bytes and control characters
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// ─── Filename Sanitization ────────────────────────────────────

/**
 * Sanitize a filename — strip path separators, null bytes, control chars.
 * Returns a safe filename or a fallback.
 * @param {string} filename - Raw filename input
 * @param {string} [fallback='unnamed'] - Fallback if filename is empty after sanitization
 * @returns {string} Sanitized filename
 */
function sanitizeFilename(filename, fallback = 'unnamed') {
  if (!filename || typeof filename !== 'string') return fallback;

  // Strip any path components — only keep the basename
  let clean = path.basename(filename);

  // Remove null bytes and control characters
  clean = clean.replace(CONTROL_CHARS, '');

  // Replace unsafe filename characters
  clean = clean.replace(UNSAFE_FILENAME_CHARS, '_');

  // Remove leading/trailing dots and spaces (Windows issues)
  clean = clean.replace(/^[.\s]+|[.\s]+$/g, '');

  // Prevent reserved Windows filenames
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..+)?$/i;
  if (reserved.test(clean)) {
    clean = '_' + clean;
  }

  // Enforce max length (preserve extension)
  if (clean.length > MAX_FILENAME_LENGTH) {
    const ext = path.extname(clean);
    const base = path.basename(clean, ext);
    clean = base.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }

  return clean || fallback;
}

// ─── Text Input Sanitization ──────────────────────────────────

/**
 * Sanitize text input — strip null bytes, enforce max length.
 * Does NOT strip HTML (content may legitimately contain markup).
 * @param {string} text - Raw text input
 * @param {number} [maxLength=MAX_TEXT_LENGTH] - Maximum allowed length
 * @returns {{ valid: boolean, text: string, truncated: boolean }}
 */
function sanitizeText(text, maxLength = MAX_TEXT_LENGTH) {
  if (text === null || text === undefined) {
    return { valid: false, text: '', truncated: false };
  }

  let clean = String(text);

  // Remove null bytes (never legitimate in text)
  clean = clean.replace(/\x00/g, '');

  // Check and enforce max length
  const truncated = clean.length > maxLength;
  if (truncated) {
    clean = clean.slice(0, maxLength);
  }

  return { valid: clean.length > 0, text: clean, truncated };
}

// ─── Path Validation ──────────────────────────────────────────

/**
 * Validate and resolve a relative path against a base directory.
 * Prevents directory traversal attacks.
 * @param {string} relPath - Relative path from user input
 * @param {string} baseDir - Absolute base directory to resolve against
 * @returns {{ valid: boolean, resolved: string|null, error: string|null }}
 */
function validatePath(relPath, baseDir) {
  if (!relPath && relPath !== '') {
    return { valid: false, resolved: null, error: 'Path is required' };
  }

  if (typeof relPath !== 'string') {
    return { valid: false, resolved: null, error: 'Path must be a string' };
  }

  // Strip null bytes
  const cleanPath = relPath.replace(/\x00/g, '');

  // Reject obvious traversal attempts
  if (cleanPath.includes('..') || cleanPath.includes('\x00')) {
    return { valid: false, resolved: null, error: 'Path contains illegal characters or traversal patterns' };
  }

  // Check path depth
  const segments = cleanPath.split(/[/\\]/).filter(Boolean);
  if (segments.length > MAX_PATH_DEPTH) {
    return { valid: false, resolved: null, error: 'Path exceeds maximum depth' };
  }

  // Resolve and verify containment
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, cleanPath);

  // Platform-aware containment check
  const isContained = process.platform === 'win32'
    ? resolved.toLowerCase().startsWith(resolvedBase.toLowerCase())
    : resolved.startsWith(resolvedBase);

  if (!isContained) {
    return { valid: false, resolved: null, error: 'Path resolves outside allowed directory' };
  }

  return { valid: true, resolved, error: null };
}

// ─── Settings Validation ──────────────────────────────────────

/**
 * Validate a port number
 * @param {*} port - Raw port input
 * @returns {{ valid: boolean, value: number|null, error: string|null }}
 */
function validatePort(port) {
  const parsed = parseInt(port, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    return { valid: false, value: null, error: 'Port must be between 1 and 65535' };
  }
  // Warn about privileged ports
  if (parsed < 1024) {
    return { valid: true, value: parsed, error: 'Warning: ports below 1024 may require elevated privileges' };
  }
  return { valid: true, value: parsed, error: null };
}

/**
 * Sanitize a device name
 * @param {string} name - Raw device name
 * @returns {string} Sanitized device name
 */
function sanitizeDeviceName(name) {
  if (!name || typeof name !== 'string') return '';

  let clean = name.trim();
  // Remove control characters and null bytes
  clean = clean.replace(CONTROL_CHARS, '');
  // Remove characters that could cause issues in network contexts
  clean = clean.replace(/[<>'";&|`$]/g, '');
  // Enforce length limit
  if (clean.length > MAX_DEVICE_NAME_LENGTH) {
    clean = clean.slice(0, MAX_DEVICE_NAME_LENGTH);
  }
  return clean;
}

/**
 * Validate a PIN code (4-digit numeric string)
 * @param {*} pin - Raw PIN input
 * @returns {{ valid: boolean, value: string|null, error: string|null }}
 */
function validatePin(pin) {
  const pinStr = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(pinStr)) {
    return { valid: false, value: null, error: 'PIN must be 4–8 digits' };
  }
  return { valid: true, value: pinStr, error: null };
}

/**
 * Validate a security mode setting
 * @param {string} mode - Security mode value
 * @returns {{ valid: boolean, value: string|null, error: string|null }}
 */
function validateSecurityMode(mode) {
  const allowed = ['open', 'protected', 'secret'];
  if (!allowed.includes(mode)) {
    return { valid: false, value: null, error: `Security mode must be one of: ${allowed.join(', ')}` };
  }
  return { valid: true, value: mode, error: null };
}

/**
 * Sanitize a shortcut secret token
 * @param {string} secret - Raw secret string
 * @returns {string} Sanitized secret
 */
function sanitizeSecret(secret) {
  if (!secret || typeof secret !== 'string') return '';
  // Remove control chars and whitespace, allow alphanumeric + common token chars
  return secret.trim().replace(CONTROL_CHARS, '').slice(0, 128);
}

/**
 * Validate a boolean-like setting value
 * @param {*} value - Raw value
 * @returns {boolean}
 */
function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return !!value;
}

/**
 * Validate a positive float (for hours, etc.)
 * @param {*} value - Raw value
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @param {number} fallback - Default if invalid
 * @returns {number}
 */
function validatePositiveFloat(value, min = 0.1, max = 720, fallback = 2) {
  const parsed = parseFloat(value);
  if (isNaN(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

module.exports = {
  sanitizeFilename,
  sanitizeText,
  validatePath,
  validatePort,
  sanitizeDeviceName,
  validatePin,
  validateSecurityMode,
  sanitizeSecret,
  toBoolean,
  validatePositiveFloat,
  // Constants (exported for testing)
  MAX_FILENAME_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_DEVICE_NAME_LENGTH,
  MAX_PATH_DEPTH
};
