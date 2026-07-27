/**
 * Winston logger configured for structured JSON logs in production
 * and a pretty console format in development.
 *
 * Log events emitted throughout the app:
 *   - incoming_message   (raw Telegram update)
 *   - ai_response        (Gemini output)
 *   - voice_transcription (Whisper output)
 *   - error              (anything that throws)
 *   - service_health     (startup, shutdown, DB, etc.)
 */
const winston = require('winston');
const config = require('../config');

const { combine, timestamp, json, errors, splat, printf, colorize } = winston.format;

const devFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `[${ts}] ${level}: ${message}${metaStr}`;
});

const logger = winston.createLogger({
  level: config.env === 'production' ? 'info' : 'debug',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    splat(),
    config.env === 'production' ? json() : combine(colorize(), devFormat)
  ),
  transports: [
    new winston.transports.Console({
      handleExceptions: true,
    }),
  ],
  exitOnError: false,
});

module.exports = logger;
