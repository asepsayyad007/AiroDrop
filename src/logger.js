/**
 * logger.js — Structured logging with Winston
 * Provides leveled, timestamped, JSON-formatted logs with file rotation.
 * Also maintains an in-memory log buffer for the dashboard SSE feed.
 */

const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const state = require('./state');

// ─── Log Level Configuration ─────────────────────────────────
// Levels: error, warn, info, http, debug
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4
};

const LOG_COLORS = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'cyan',
  debug: 'gray'
};

winston.addColors(LOG_COLORS);

// ─── Determine log directory ─────────────────────────────────
let logDir = '';

function getLogDir() {
  if (logDir) return logDir;
  // Use Electron userData if available, otherwise fallback to project root
  try {
    const electron = require('electron');
    if (electron && electron.app) {
      logDir = path.join(electron.app.getPath('userData'), 'logs');
      return logDir;
    }
  } catch {}
  // Fallback — logs alongside the app
  logDir = path.join(__dirname, '..', 'logs');
  return logDir;
}

// ─── Custom Formats ──────────────────────────────────────────

// Console format: colorized, human-readable
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, requestId, ...meta }) => {
    const reqIdStr = requestId ? ` [${requestId}]` : '';
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}${reqIdStr}: ${message}${metaStr}`;
  })
);

// File format: structured JSON for machine parsing
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// ─── In-Memory Transport (for dashboard SSE feed) ────────────
class MemoryTransport extends winston.Transport {
  constructor(opts = {}) {
    super(opts);
    this.maxEntries = opts.maxEntries || 500;
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));

    const entry = `[${info.timestamp || new Date().toLocaleTimeString()}] ${info.message}`;
    state.logHistory.push(entry);
    if (state.logHistory.length > this.maxEntries) {
      state.logHistory.shift();
    }

    callback();
  }
}

// ─── Create Logger Instance ──────────────────────────────────
let logger = null;

function createLogger() {
  if (logger) return logger;

  const dir = getLogDir();

  const transports = [
    // Console output
    new winston.transports.Console({
      level: process.env.LOG_LEVEL || 'info',
      format: consoleFormat
    }),

    // In-memory buffer for SSE
    new MemoryTransport({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.simple()
      )
    })
  ];

  // File transports — only add if we can resolve a directory
  // (they'll create the directory lazily)
  if (dir) {
    transports.push(
      // Combined log (all levels)
      new winston.transports.DailyRotateFile({
        level: 'info',
        dirname: dir,
        filename: 'airodrop-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '10m',
        maxFiles: '7d',
        format: fileFormat
      }),

      // Error log (errors only)
      new winston.transports.DailyRotateFile({
        level: 'error',
        dirname: dir,
        filename: 'airodrop-errors-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '5m',
        maxFiles: '14d',
        format: fileFormat
      })
    );
  }

  logger = winston.createLogger({
    levels: LOG_LEVELS,
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { service: 'airodrop' },
    transports,
    // Don't exit on uncaught exceptions — we handle that ourselves
    exitOnError: false
  });

  return logger;
}

// ─── Convenience Methods ─────────────────────────────────────

/**
 * Set the log directory (call from server init with userData path)
 */
function setLogDir(dir) {
  logDir = path.join(dir, 'logs');
}

/**
 * Get the logger instance (creates if not exists)
 */
function getLogger() {
  return createLogger();
}

/**
 * Child logger with request context
 */
function createRequestLogger(requestId) {
  return getLogger().child({ requestId });
}

// ─── Export ──────────────────────────────────────────────────
module.exports = {
  getLogger,
  setLogDir,
  createRequestLogger,
  LOG_LEVELS
};
