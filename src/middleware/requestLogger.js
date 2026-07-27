/**
 * Morgan-based HTTP request logger. Streams into our Winston logger so
 * everything ends up in one place.
 */
const morgan = require('morgan');
const logger = require('../utils/logger');

const stream = {
  write: (message) => logger.info(message.trim()),
};

const skip = (req) => req.url === '/health' && process.env.NODE_ENV === 'production';

module.exports = morgan('combined', { stream, skip });
