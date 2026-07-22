/**
 * constants.js — Centralized application constants
 * All magic numbers, default values, limits, and thresholds in one place.
 */

module.exports = {
  // ─── Server Defaults ────────────────────────────────────────
  DEFAULT_PORT: 3478,
  DEFAULT_DEVICE_NAME: require('os').hostname(),
  MAX_PORT_RETRIES: 3,
  PORT_RETRY_INCREMENT: 2,

  // ─── Rate Limiting ──────────────────────────────────────────
  RATE_WINDOW_MS: 60000,
  RATE_LIMITS: {
    default: 60,
    auth: 20,
    upload: 20,
    control: 30
  },
  RATE_CLEANUP_INTERVAL_MS: 5 * 60 * 1000,

  // ─── Request Timeouts ───────────────────────────────────────
  API_TIMEOUT_MS: 30 * 1000,
  UPLOAD_TIMEOUT_MS: 10 * 60 * 1000,

  // ─── Body Size Limits ───────────────────────────────────────
  JSON_BODY_LIMIT: '1mb',
  JSON_BODY_LIMIT_LARGE: '10mb',
  RAW_BODY_LIMIT: '50mb',
  FILE_UPLOAD_MAX_SIZE: 10 * 1024 * 1024 * 1024, // 10 GB

  // ─── Authentication ─────────────────────────────────────────
  PIN_LENGTH_MIN: 4,
  PIN_LENGTH_MAX: 8,
  BRUTE_FORCE_MAX_ATTEMPTS: 5,
  BRUTE_FORCE_HARD_THRESHOLD: 10,
  BRUTE_FORCE_LOCKOUT_MS: 5 * 60 * 1000,
  BRUTE_FORCE_HARD_LOCKOUT_MS: 30 * 60 * 1000,
  BRUTE_FORCE_WINDOW_MS: 5 * 60 * 1000,
  BRUTE_FORCE_CLEANUP_INTERVAL_MS: 10 * 60 * 1000,
  SESSION_COOKIE_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  SESSION_COOKIE_NAME: 'airodrop_session',

  // ─── History & Storage ──────────────────────────────────────
  MAX_HISTORY_ITEMS: 100,
  MAX_PENDING_ITEMS: 50,
  PENDING_TTL_MS: 30 * 60 * 1000,
  PENDING_CLEANUP_INTERVAL_MS: 5 * 60 * 1000,
  HISTORY_SAVE_DEBOUNCE_MS: 500,

  // ─── Logging ────────────────────────────────────────────────
  MAX_LOG_ENTRIES: 500,
  LOG_ROTATION_MAX_SIZE: '10m',
  LOG_ROTATION_MAX_FILES: '7d',
  LOG_ERROR_ROTATION_MAX_FILES: '14d',

  // ─── WebSocket ──────────────────────────────────────────────
  WS_PING_INTERVAL_MS: 15000,
  WS_HEARTBEAT_INTERVAL_MS: 30000,

  // ─── SSE ────────────────────────────────────────────────────
  SSE_HEARTBEAT_INTERVAL_MS: 20000,
  SSE_DEAD_CLIENT_CLEANUP_MS: 30000,

  // ─── File Handling ──────────────────────────────────────────
  MAX_FILENAME_LENGTH: 200,
  MAX_TEXT_LENGTH: 10 * 1024 * 1024, // 10 MB
  MAX_DEVICE_NAME_LENGTH: 64,
  MAX_PATH_DEPTH: 20,
  FILENAME_TRUNCATE_LENGTH: 15,

  // ─── Graceful Shutdown ──────────────────────────────────────
  SHUTDOWN_DRAIN_TIMEOUT_MS: 5000,

  // ─── Security Modes ─────────────────────────────────────────
  SECURITY_MODES: ['open', 'protected', 'secret'],
  DEFAULT_SECURITY_MODE: 'protected',
  DEFAULT_SHORTCUT_SECRET: 'airodrop',

  // ─── Temporary Mode ─────────────────────────────────────────
  DEFAULT_TEMPORARY_MODE_HOURS: 2,
  MIN_TEMPORARY_MODE_HOURS: 0.1,
  MAX_TEMPORARY_MODE_HOURS: 720
};
