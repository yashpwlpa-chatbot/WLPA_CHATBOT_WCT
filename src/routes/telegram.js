const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/telegramController');

// Webhook entry point. Telegram POSTs updates here when USE_WEBHOOK=true.
router.post('/webhook', ctrl.handleWebhook);

module.exports = router;
