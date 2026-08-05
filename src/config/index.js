/**
 * Centralized configuration loader.
 * All environment variables are read here exactly once and exposed
 * to the rest of the app through this module.
 */
const path = require('path');
const fs = require('fs');
const _envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(_envPath)) {
  require('dotenv').config({ path: _envPath });
} else {
  require('dotenv').config();
}

const required = (key) => {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const optional = (key, fallback) => {
  const value = process.env[key];
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed !== '' ? trimmed : fallback;
};

module.exports = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),

  mongo: {
    uri: required('MONGODB_URI'),
  },

  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    useWebhook: optional('USE_WEBHOOK', 'false').toLowerCase() === 'true',
    webhookUrl: optional('WEBHOOK_URL', ''),
  },

  whatsapp: {
    // WhatsApp Cloud API credentials
    // For testing: only accessToken is required; others use placeholders
    accessToken: optional('WHATSAPP_ACCESS_TOKEN', 'test_access_token'),
    phoneNumberId: optional('WHATSAPP_PHONE_NUMBER_ID', 'test_phone_number_id'),
    webhookVerifyToken: optional('WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'test_verify_token'),
    appSecret: optional('WHATSAPP_APP_SECRET', 'test_app_secret'),
    businessAccountId: optional('WHATSAPP_BUSINESS_ACCOUNT_ID', 'test_business_account_id'),
    // Webhook URL for receiving messages
    webhookUrl: optional('WHATSAPP_WEBHOOK_URL', ''),
    // Use webhook mode (true) or polling (false - not supported by WhatsApp)
    useWebhook: true,
  },

  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    model: optional('GEMINI_MODEL', 'gemini-1.5-flash'),
  },

  whisper: {
    // OpenAI Whisper API (fallback)
    apiKey: optional('WHISPER_API_KEY', null),
  },

  transcription: {
    // Local faster-whisper microservice
    serviceUrl: optional('TRANSCRIPTION_SERVICE_URL', 'http://127.0.0.1:5000'),
    useLocal: optional('USE_LOCAL_TRANSCRIPTION', 'true') === 'true',
    model: optional('WHISPER_MODEL', 'base'),
    defaultLanguage: optional('WHISPER_LANGUAGE', 'en'),
    timeout: parseInt(optional('TRANSCRIPTION_TIMEOUT', '60000'), 10),
    healthTimeout: parseInt(optional('TRANSCRIPTION_HEALTH_TIMEOUT', '3000'), 10),
    retries: parseInt(optional('TRANSCRIPTION_RETRIES', '3'), 10),
    retryDelay: parseInt(optional('TRANSCRIPTION_RETRY_DELAY_MS', '1000'), 10),
    maxFileSize: parseInt(optional('MAX_FILE_SIZE_MB', '25'), 10) * 1024 * 1024,
  },

  pdf: {
    // Path to the official WLPA PDF — used by PDFService.
    path: optional('WLPA_PDF_PATH', 'assets/wlpa.pdf'),
  },

  app: {
    defaultLanguage: optional('DEFAULT_LANGUAGE', 'en'),
    corsOrigin: optional('CORS_ORIGIN', '*'),
  },

  // Defaults to concise operational logs; set LOG_LEVEL=debug only while diagnosing issues.
  logging: {
    level: optional('LOG_LEVEL', 'info'),
  },
};
