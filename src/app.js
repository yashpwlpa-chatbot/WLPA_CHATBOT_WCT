/**
 * Express application factory.
 * Keeping the app construction here (and the listen call in server.js)
 * lets us import `app` in tests without binding a port.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const logger = require('./utils/logger');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');

const telegramRoutes = require('./routes/telegram');
const whatsappRoutes = require('./routes/whatsapp');
const healthRoutes = require('./routes/health');

const buildApp = () => {
  const app = express();

  // Security & infra middleware
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.app.corsOrigin }));
  app.use(compression());

  // JSON + URL-encoded body parsing.
  // The `verify` callback on express.json() is the ONLY reliable, supported way
  // to capture the EXACT raw bytes that Meta used to compute X-Hub-Signature-256.
  // A naive `req.on('data')` would consume the stream and break body-parser's
  // internal `raw-body` read with "stream is not readable".
  app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf, encoding) => {
      if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
      } else {
        req.rawBody = '';
      }
    },
  }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // Rate-limit the Telegram webhook endpoint so we cannot be flooded.
  app.use(
    '/telegram',
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: { code: 'RATE_LIMIT' } },
    })
  );

  // Note: WhatsApp rate limiting lives inside src/routes/whatsapp.js (single source of truth).

  // Routes
  app.use('/telegram', telegramRoutes);
  app.use('/whatsapp', whatsappRoutes);
  app.use('/', healthRoutes);

  // 404
  app.use((req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
  });

  // Error handler — must remain LAST.
  app.use(errorHandler);

  logger.debug('Express app built');

  return app;
};

module.exports = buildApp;
