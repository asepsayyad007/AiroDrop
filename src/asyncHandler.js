/**
 * asyncHandler.js — Wrap async Express route handlers
 * Catches rejected promises and forwards errors to Express error middleware.
 * Eliminates try/catch boilerplate in every route.
 */

/**
 * Wraps an async route handler to catch errors automatically.
 * @param {Function} fn - Async route handler (req, res, next)
 * @returns {Function} Express middleware that catches async errors
 *
 * @example
 * router.get('/items', asyncHandler(async (req, res) => {
 *   const items = await db.getItems();
 *   res.json(items);
 * }));
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
