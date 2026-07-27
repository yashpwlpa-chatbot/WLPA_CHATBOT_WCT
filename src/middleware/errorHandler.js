/**
 * Centralized error handler.
 * Converts anything thrown into a friendly JSON response while
 * logging full details server-side.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const payload = {
    success: false,
    error: {
      message: status >= 500 ? 'Internal server error' : err.message,
      code: err.code || 'INTERNAL_ERROR',
    },
  };

  // Use the structured logger if available, otherwise console.
  try {
    const logger = require('../utils/logger');
    logger.error('Request failed', {
      method: req.method,
      url: req.originalUrl,
      status,
      message: err.message,
      stack: err.stack,
    });
  } catch (_) {
    // eslint-disable-next-line no-console
    console.error('Request failed', err);
  }

  res.status(status).json(payload);
}

module.exports = errorHandler;
