/**
 * Entry point.
 * Boots the Express app, connects to MongoDB, initializes the Telegram
 * bot (async for ESM compatibility with v1.x), WhatsApp services,
 * optionally sets the webhooks, and starts the HTTP server with graceful shutdown.
 */

const config = require('./src/config');
const logger = require('./src/utils/logger');
const connectDB = require('./src/config/db');
const buildApp = require('./src/app');
const telegramBot = require('./src/bot/telegramBot');
const telegramController = require('./src/controllers/telegramController');
const whatsappController = require('./src/controllers/whatsappController');
const SearchService = require('./src/services/SearchService');
const ScenarioUnderstandingService = require('./src/services/ScenarioUnderstandingService');
const AmendmentService = require('./src/services/AmendmentService');
const IncidentService = require('./src/services/IncidentService');
const VoiceService = require('./src/services/VoiceService');

// Startup diagnostics expose configuration state without leaking credentials.
const maskValue = (value, visible = 4) => {
  const text = String(value || '');
  if (!text) return '(not set)';
  if (text.length <= visible) return '*'.repeat(text.length);
  return `${text.slice(0, visible)}…${'*'.repeat(Math.min(8, text.length - visible))}`;
};

const start = async () => {
  try {
    // 1. Database first so failures here abort cleanly before opening ports.
    await connectDB();

    // 2. Express app
    const app = buildApp();

    // 3. Warm transcription before Telegram polling or HTTP webhooks begin.
    await VoiceService.warmup();

    // 4. Initialize Telegram bot (loads ESM/CJS dynamically)
    await telegramBot.init();

    // 5. Initialize WhatsApp services
    await SearchService.initialize();
    await ScenarioUnderstandingService.initialize();
    await AmendmentService.initialize();
    await IncidentService.initialize();

    // 6. Webhook registration (only if configured)
    if (config.telegram.useWebhook) {
      if (!config.telegram.webhookUrl) {
        throw new Error('USE_WEBHOOK=true requires WEBHOOK_URL to be set');
      }
      await telegramController.setupWebhook();
    }

    // 7. WhatsApp webhook registration (if configured)
    if (config.whatsapp.useWebhook && config.whatsapp.webhookUrl) {
      await whatsappController.setupWebhook();
    }

    // 8. HTTP listen
    const server = app.listen(config.port, () => {
      logger.info('HTTP server listening', {
        port: config.port,
        env: config.env,
        telegramWebhook: config.telegram.useWebhook,
        whatsappWebhook: config.whatsapp.useWebhook,
      });
      // Detailed credential and route diagnostics are available only when debugging.
      logger.debug('WhatsApp startup audit', {
        nodeVersion: process.version,
        routes: ['GET /whatsapp', 'POST /whatsapp'],
        webhookBaseUrl: config.whatsapp.webhookUrl || '(not set)',
        expectedWebhookUrl: config.whatsapp.webhookUrl
          ? `${config.whatsapp.webhookUrl.replace(/\/+$/, '')}/whatsapp`
          : '(not set)',
        phoneNumberId: maskValue(config.whatsapp.phoneNumberId),
        businessAccountId: maskValue(config.whatsapp.businessAccountId),
        verifyToken: maskValue(config.whatsapp.webhookVerifyToken),
        appSecretSet: !!config.whatsapp.appSecret && !/^(your_|test_)/i.test(config.whatsapp.appSecret),
        accessToken: maskValue(config.whatsapp.accessToken),
        geminiApiKeySet: !!config.gemini.apiKey,
        mongoReadyState: require('mongoose').connection.readyState,
      });
    });

    // 9. Graceful shutdown
    const shutdown = (signal) => {
      logger.info(`Received ${signal}, shutting down`);
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
      // Force exit after 10s if shutdown stalls.
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', { reason: reason?.message || String(reason) });
    });
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    process.exit(1);
  }
};

start();
