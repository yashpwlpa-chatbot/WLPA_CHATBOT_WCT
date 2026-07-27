/**
 * WhatsApp Routes
 * ---------------
 * Webhook endpoints for WhatsApp Cloud API.
 * - GET /whatsapp - Webhook verification
 * - POST /whatsapp - Incoming messages
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { verifyWebhook, handleWebhook } = require('../controllers/whatsappController');

// Rate limit: WhatsApp recommends handling bursts, but we'll limit to prevent abuse
const whatsappRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT' } },
});

// Apply rate limiting
router.use(whatsappRateLimit);

// Webhook verification (GET)
router.get('/', verifyWebhook);

// Incoming messages (POST)
// Note: express.json() is already applied in src/app.js (plus we capture rawBody for HMAC)
router.post('/', handleWebhook);

module.exports = router;