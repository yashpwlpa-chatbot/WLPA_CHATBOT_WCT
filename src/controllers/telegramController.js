/**
 * Telegram webhook controller.
 * Used only when USE_WEBHOOK=true. Telegram POSTs updates here and we
 * hand them off to the bot instance.
 */
const bot = require('../bot/telegramBot');
const logger = require('../utils/logger');

exports.handleWebhook = (req, res) => {
  // node-telegram-bot-api accepts the raw update object via processUpdate.
  bot.processUpdate(req.body);
  res.sendStatus(200);
};

exports.setupWebhook = async () => {
  const config = require('../config');
  try {
    // Ensure bot is constructed before we try to use its setWebHook.
    await bot.init();
    // Returns true on success.
    await bot.getInstance().setWebHook(config.telegram.webhookUrl);
    logger.info('Telegram webhook set', { url: config.telegram.webhookUrl });
  } catch (err) {
    logger.error('Failed to set Telegram webhook', { error: err.message });
    throw err;
  }
};
