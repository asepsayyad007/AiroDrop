/**
 * errors.js — Centralized error handling
 * Provides AppError class, error classification, and Express error middleware.
 */

const { getLogger } = require('./logger');

// ─── Error Classification ────────────────────────────────────

/**
 * Application-level error with status code and classification.
 */
class AppError extends Error {
  /**
   * @param {string} message - Human-readable error message
   * @param {number} statusCode - HTTP status code (default: 500)
   * @param {object} options - Additional options
   * @param {string} options.code - Machine-readable error code
   * @param {boolean} options.isOperational - Whether this is an expected operational error
   * @param {object} options.details - Additional error context
   */
  constructor(message, statusCode = 500, options = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = options.code || 'INTERNAL_ERROR';
    this.isOperational = options.isOperational !== undefined ? options.isOperational : true;
    this.details = options.details || null;

    Error.captureStackTrace(this, this.constructor);
  }
}

// ─── Common Error Factories ──────────────────────────────────

const Errors = {
  badRequest(message = 'Bad request', details = null) {
    return new AppError(message, 400, { code: 'BAD_REQUEST', details });
  },

  unauthorized(message = 'Authentication required') {
    return new AppError(message, 401, { code: 'UNAUTHORIZED' });
  },

  forbidden(message = 'Access denied') {
    return new AppError(message, 403, { code: 'FORBIDDEN' });
  },

  notFound(message = 'Resource not found') {
    return new AppError(message, 404, { code: 'NOT_FOUND' });
  },

  conflict(message = 'Resource conflict') {
    return new AppError(message, 409, { code: 'CONFLICT' });
  },

  tooLarge(message = 'Payload too large') {
    return new AppError(message, 413, { code: 'PAYLOAD_TOO_LARGE' });
  },

  tooMany(message = 'Too many requests', retryAfter = 60) {
    const err = new AppError(message, 429, { code: 'RATE_LIMITED', details: { retryAfter } });
    return err;
  },

  internal(message = 'Internal server error', details = null) {
    return new AppError(message, 500, { code: 'INTERNAL_ERROR', isOperational: false, details });
  },

  serviceUnavailable(message = 'Service temporarily unavailable') {
    return new AppError(message, 503, { code: 'SERVICE_UNAVAILABLE' });
  }
};

// ─── Express Error Middleware ─────────────────────────────────

/**
 * Centralized error handler middleware. Mount as the LAST middleware.
 * Logs the error and sends a consistent JSON response.
 */
function errorHandler(err, req, res, next) {
  const logger = getLogger();

  // Default values
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let code = err.code || 'INTERNAL_ERROR';
  let isOperational = err.isOperational !== undefined ? err.isOperational : false;

  // Handle Multer errors
  if (err.name === 'MulterError') {
    statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : err.message;
    code = 'UPLOAD_ERROR';
    isOperational = true;
  }

  // Handle JSON parse errors
  if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    message = 'Invalid JSON in request body';
    code = 'PARSE_ERROR';
    isOperational = true;
  }

  // Handle payload too large
  if (err.type === 'entity.too.large') {
    statusCode = 413;
    message = 'Request body too large';
    code = 'PAYLOAD_TOO_LARGE';
    isOperational = true;
  }

  // Log based on severity
  const logMeta = {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    statusCode,
    code,
    ip: req.ip
  };

  if (isOperational) {
    logger.warn(`${message}`, logMeta);
  } else {
    logger.error(`${message}`, { ...logMeta, stack: err.stack });
  }

  // Don't leak internal details in production for non-operational errors
  const responseMessage = isOperational ? message : 'Internal server error';

  // Send response (don't send if headers already sent)
  if (res.headersSent) {
    return next(err);
  }

  res.status(statusCode).json({
    error: responseMessage,
    code,
    ...(req.requestId ? { requestId: req.requestId } : {})
  });
}

/**
 * 404 handler — mount before the error handler for unmatched routes
 */
function notFoundHandler(req, res, next) {
  // Don't trigger for SPA fallback routes (index.html serves those)
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return next();
  }
  const err = Errors.notFound(`Route not found: ${req.method} ${req.path}`);
  next(err);
}

// ─── Export ──────────────────────────────────────────────────
module.exports = {
  AppError,
  Errors,
  errorHandler,
  notFoundHandler
};
