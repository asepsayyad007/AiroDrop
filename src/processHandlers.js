/**
 * processHandlers.js — Uncaught exception and unhandled rejection handlers
 * Ensures graceful crash logging and state persistence before exit.
 */

const { getLogger } = require('./logger');

let initialized = false;

/**
 * Register global process error handlers.
 * Call once during server initialization.
 */
function registerProcessHandlers() {
  if (initialized) return;
  initialized = true;

  const logger = getLogger();

  // ─── Uncaught Exception ────────────────────────────────────
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception — process will continue', {
      error: err.message,
      stack: err.stack,
      type: 'uncaughtException'
    });

    // Attempt to save critical state
    trySaveState();

    // In Electron, we don't want to crash the app — just log
    // For standalone server mode, this would be fatal
    if (!isElectron()) {
      logger.error('Fatal: uncaughtException in standalone mode. Exiting in 1s.');
      setTimeout(() => process.exit(1), 1000);
    }
  });

  // ─── Unhandled Promise Rejection ───────────────────────────
  process.on('unhandledRejection', (reason, promise) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;

    logger.error('Unhandled Promise Rejection', {
      error: message,
      stack,
      type: 'unhandledRejection'
    });
  });

  // ─── SIGTERM / SIGINT Graceful Shutdown ────────────────────
  const shutdown = (signal) => {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);
    trySaveState();

    // Give ongoing requests 3 seconds to finish
    setTimeout(() => {
      logger.info('Shutdown complete.');
      process.exit(0);
    }, 3000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.debug('Process error handlers registered');
}

/**
 * Attempt to save application state (history, scratchpad) before crash/exit.
 */
function trySaveState() {
  try {
    const fs = require('fs');
    const state = require('./state');

    // Save history
    if (state.HISTORY_FILE && !state.TEMPORARY_MODE && state.history.length > 0) {
      fs.writeFileSync(state.HISTORY_FILE, JSON.stringify(state.history, null, 2), 'utf8');
    }

    // Save scratchpad
    if (state.SCRATCHPAD_FILE && state.scratchpadText) {
      fs.writeFileSync(state.SCRATCHPAD_FILE, state.scratchpadText, 'utf8');
    }
  } catch (err) {
    // Best effort — don't throw during crash handling
    console.error('[CRASH-SAVE] Failed to persist state:', err.message);
  }
}

/**
 * Check if running inside Electron
 */
function isElectron() {
  return !!(process.versions && process.versions.electron);
}

module.exports = { registerProcessHandlers };
