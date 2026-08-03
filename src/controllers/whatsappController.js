/**
 * WhatsAppController
 * ------------------
 * Handles incoming WhatsApp messages and manages conversation flows.
 */

const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const WhatsAppService = require('../services/WhatsAppService');
const UserService = require('../services/UserService');
const ChatService = require('../services/ChatService');
const GeminiService = require('../services/GeminiService');
const VoiceService = require('../services/VoiceService');
const LanguageDetectionService = require('../services/LanguageDetectionService');
const WhatsAppInboundMessage = require('../models/WhatsAppInboundMessage');
const WhatsAppPhoneLock = require('../models/WhatsAppPhoneLock');

const { MESSAGE_TYPES } = require('../utils/constants');
const GRAPH_API_VERSION = 'v20.0';

// In-memory session store (in production, use Redis or MongoDB)
const userSessions = new Map(); // phoneNumber -> session object
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

// In-memory dedupe cache — message IDs we've already processed within TTL.
const PROCESSED_MESSAGE_IDS = new Map();
const DEDUPE_TTL_MS = 15 * 60 * 1000;

function _dedupePurge() {
  const now = Date.now();
  for (const [mid, ts] of PROCESSED_MESSAGE_IDS) {
    if (now - ts > DEDUPE_TTL_MS) PROCESSED_MESSAGE_IDS.delete(mid);
  }
}
setInterval(_dedupePurge, 5 * 60 * 1000).unref();

function _isMessageAlreadyProcessed(messageId) {
  if (!messageId) return false;
  return PROCESSED_MESSAGE_IDS.has(messageId);
}
function _markMessageProcessed(messageId) {
  if (!messageId) return;
  PROCESSED_MESSAGE_IDS.set(messageId, Date.now());
}

const QUEUE_WORKER_ID = crypto.randomUUID();
const QUEUE_LOCK_MS = 5 * 60 * 1000;

async function _claimInboundMessage(message) {
  try {
    await WhatsAppInboundMessage.create({ messageId: message.id, phoneNumber: message.from, message });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function _acquirePhoneLock(phoneNumber) {
  const now = new Date();
  try {
    const lock = await WhatsAppPhoneLock.findOneAndUpdate(
      { phoneNumber, $or: [{ lockedUntil: { $lte: now } }, { ownerId: QUEUE_WORKER_ID }] },
      { $set: { ownerId: QUEUE_WORKER_ID, lockedUntil: new Date(Date.now() + QUEUE_LOCK_MS) } },
      { new: true, upsert: true }
    ).lean();
    return lock?.ownerId === QUEUE_WORKER_ID;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

function getSession(phoneNumber) {
  if (!userSessions.has(phoneNumber)) {
    userSessions.set(phoneNumber, {
      language: 'en',
      updatedAt: Date.now(),
    });
  }
  const session = userSessions.get(phoneNumber);
  session.updatedAt = Date.now();
  return session;
}

function updateSession(phoneNumber, updates) {
  const session = getSession(phoneNumber);
  Object.assign(session, updates);
  session.updatedAt = Date.now();
  return session;
}

function clearSession(phoneNumber) {
  userSessions.delete(phoneNumber);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [phone, session] of userSessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL) {
      userSessions.delete(phone);
    }
  }
}
setInterval(cleanupSessions, 5 * 60 * 1000);

async function resolveLanguage(phoneNumber, text) {
  const session = getSession(phoneNumber);
  const cmdLang = LanguageDetectionService._resolveCommand ? LanguageDetectionService._resolveCommand(text) : null;
  if (cmdLang) {
    session.language = cmdLang;
    return cmdLang;
  }
  if (session.language && session.language !== 'en') {
     // Trust existing unless re-detected later
  }
  const detected = await LanguageDetectionService.detect(text);
  session.language = detected;
  return detected;
}

async function processQuestion(phoneNumber, question, language, options = {}) {
  const pipelineStartedAt = Date.now();

  logger.debug('[Calling Chatbot]', {
    language,
    questionLength: question.length,
  });

  // Smart "Searching..." message: Wait 1 second, if Gemini hasn't returned, send it.
  let searchingTimeout = setTimeout(async () => {
    try { 
        await WhatsAppService.sendTextMessage(phoneNumber, '🔍 Searching...'); 
    } catch (_e) { /* no-op */ }
  }, 1000);

  try {
    const memoryStartedAt = Date.now();
    // Fetch or create user BEFORE calling Gemini to pass userId for memory context
    const user = await UserService.upsertFromWhatsApp(phoneNumber, language);

    // Bind and hydrate this phone-number session before logging or prompting.
    // The shared memory service clears any mismatched RAM owner automatically.
    await ChatService.ensureConversationMemory(phoneNumber);

    // Explicit task 3: Before every Gemini call, log the conversation history being sent.
    const conversationHistory = ChatService.getConversationMemory(phoneNumber, 10);
    logger.debug('WhatsApp pipeline: Context being sent to Gemini', {
      historyLength: conversationHistory.length,
    });

    const geminiStartedAt = Date.now();
    const { answer, model, source, confidence } = await GeminiService.generateAnswer(
      question,
      language,
      {
        telegramId: null, // Not used for WhatsApp
        sessionId: phoneNumber, // Unique session for WhatsApp user
        userId: user._id, // Pass userId to retrieve durable memory
      }
    );
    clearTimeout(searchingTimeout);

    logger.info('WhatsApp pipeline: Gemini completed', {
      phoneNumber,
      elapsedMs: Date.now() - geminiStartedAt,
      totalElapsedMs: Date.now() - pipelineStartedAt,
      source,
      confidence,
    });

    logger.debug('WhatsApp reply generated', { source, model });

    // Save to chat history using correct WhatsApp user mapping
    await ChatService.save({
      userId: user._id,
      telegramId: null, // Ensure this maps to the updated schema
      sessionId: phoneNumber, // Connect this save to the RAM conversation context
      messageType: MESSAGE_TYPES.TEXT,
      question,
      answer,
      language,
      aiModel: model,
      metadata: { source, confidence, platform: 'whatsapp' },
    });

    logger.info('WhatsApp pipeline: conversation saved', {
      phoneNumber,
      elapsedMs: Date.now() - memoryStartedAt,
      totalElapsedMs: Date.now() - pipelineStartedAt,
    });

    // Send answer in plain text (split if needed via WhatsAppService)
    const replyStartedAt = Date.now();
    await WhatsAppService.sendTextMessage(phoneNumber, answer);

    logger.info('WhatsApp pipeline: reply sent', {
      phoneNumber,
      elapsedMs: Date.now() - replyStartedAt,
      totalElapsedMs: Date.now() - pipelineStartedAt,
    });

  } catch (err) {
    clearTimeout(searchingTimeout);
    logger.error('WhatsApp question processing failed', {
      error: err.message,
      stack: err.stack,
      phoneNumber,
      totalElapsedMs: Date.now() - pipelineStartedAt,
    });
    try {
      await WhatsAppService.sendTextMessage(
        phoneNumber,
        '⚠️ Sorry, I encountered an error. Please try again.'
      );
    } catch(e) {}
  }
}

async function handleTextMessage(phoneNumber, text) {
  const language = await resolveLanguage(phoneNumber, text);
  
  if (text.startsWith('/')) {
    const cmd = text.toLowerCase().trim();
    if (cmd === '/start' || cmd === '/help') {
       const helpTexts = {
          en: `👋 *WLPA Assistant*\n\nI am your Wildlife (Protection) Act Assistant.\nHow can I help you today? Just ask me a question!`,
          hi: `👋 *WLPA सहायक*\n\nमैं आपका वन्यजीव (संरक्षण) अधिनियम सहायक हूँ।\nआज मैं आपकी कैसे मदद कर सकता हूँ? बस मुझसे एक प्रश्न पूछें!`,
          mr: `👋 *WLPA सहाय्यक*\n\nमी तुमचा वन्यजीव (संरक्षण) कायदा सहाय्यक आहे.\nआज मी तुमची कशी मदत करू शकतो? फक्त मला एक प्रश्न विचारा!`
       };
       await WhatsAppService.sendTextMessage(phoneNumber, helpTexts[language] || helpTexts.en);
       return;
    }
  }

  await processQuestion(phoneNumber, text, language);
}

async function _dispatchQueuedMessage(message) {
  const phoneNumber = message.from;
  if (message.id) await WhatsAppService.markAsRead(message.id).catch(() => null);
  if (message.type === 'text') return handleTextMessage(phoneNumber, message.text?.body || '');
  if (message.type === 'audio' || message.type === 'voice') {
    if (!VoiceService.isAvailable()) return WhatsAppService.sendTextMessage(phoneNumber, 'Voice messages are not configured on this server.');
    const mediaUrl = await WhatsAppService.getMediaUrl(message.audio?.id || message.voice?.id);
    const buffer = await WhatsAppService.downloadMedia(mediaUrl);
    const transcription = await VoiceService.transcribe(buffer);
    return transcription
      ? handleTextMessage(phoneNumber, transcription)
      : WhatsAppService.sendTextMessage(phoneNumber, 'Sorry, I could not transcribe the voice message.');
  }
  return WhatsAppService.sendTextMessage(phoneNumber, 'I can only process text and voice messages. Please type or speak your question.');
}

async function _drainPhoneQueue(phoneNumber) {
  if (!await _acquirePhoneLock(phoneNumber)) {
    // A message can arrive while another replica is finishing; retry after its lease is released.
    setTimeout(() => _drainPhoneQueue(phoneNumber).catch(() => null), 500).unref();
    return;
  }
  try {
    // Recover a job left mid-processing by a crashed or restarted worker.
    await WhatsAppInboundMessage.updateMany(
      { phoneNumber, status: 'processing', processingStartedAt: { $lte: new Date(Date.now() - QUEUE_LOCK_MS) } },
      { $set: { status: 'pending', processingStartedAt: null } }
    );
    while (true) {
      const job = await WhatsAppInboundMessage.findOneAndUpdate(
        { phoneNumber, status: 'pending' },
        { $set: { status: 'processing', processingStartedAt: new Date() }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, new: true }
      ).lean();
      if (!job) break;
      try {
        await _dispatchQueuedMessage(job.message);
        await WhatsAppInboundMessage.updateOne({ _id: job._id }, { $set: { status: 'completed', processedAt: new Date() } });
      } catch (err) {
        logger.error('WhatsApp queued message failed', { phoneNumber, messageId: job.messageId, error: err.message });
        await WhatsAppInboundMessage.updateOne({ _id: job._id }, { $set: { status: 'failed', error: err.message } });
      }
    }
  } finally {
    // Release only this worker's lease; a competing replica cannot delete it.
    await WhatsAppPhoneLock.deleteOne({ phoneNumber, ownerId: QUEUE_WORKER_ID });
  }
}

/**
 * Main webhook handler — Meta Cloud API delivery.
 */
async function handleWebhook(req, res) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const signature = req.headers?.['x-hub-signature-256'];
    const rawBody = (typeof req.rawBody === 'string' ? req.rawBody : '') || '';

    logger.debug('WhatsApp webhook request received', {
      requestId,
      timestamp: new Date().toISOString(),
      method: req.method,
      url: req.originalUrl,
      contentType: req.headers?.['content-type'],
      userAgent: req.headers?.['user-agent'],
      signaturePresent: !!signature,
      rawBodyLength: rawBody.length,
      parsedEntryCount: Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
    });

    if (!WhatsAppService.verifySignature(signature, rawBody)) {
      logger.warn('WhatsApp: Invalid signature', { requestId, elapsedMs: Date.now() - startedAt });
      return res.status(403).send('Invalid signature');
    }

    res.sendStatus(200);
    logger.info('WhatsApp webhook acknowledged', { requestId, elapsedMs: Date.now() - startedAt });

    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const changes = entries.flatMap((item) => item?.changes || []);
    const values = changes.map((change) => change?.value || {});
    const entry = entries[0];
    const messages = values.flatMap((value) => value.messages || []);
    const statuses = values.flatMap((value) => value.statuses || []);
    const contacts = values.flatMap((value) => value.contacts || []);
    
    if (!messages || messages.length === 0) {
      if (statuses && statuses.length > 0) {
        const codes = statuses.map((s) => s.status).join(',');
        logger.debug('[Webhook Received] status update (ignored)', { statuses: codes });
      } else {
        logger.debug('[Webhook Received] no messages field (ignored)');
      }
      return;
    }

    logger.debug('[Webhook Received]', {
      messages: messages.length,
    });

    for (const message of messages) {
      try {
        const messageId = message.id;
        const from = message.from;
        const ts = message.timestamp;
        const type = message.type;

        if (_isMessageAlreadyProcessed(messageId)) {
          logger.info('[Duplicate Message] skipping', { messageId, from });
          continue;
        }

        // The unique MongoDB message ID is the cross-instance deduplication claim.
        if (!await _claimInboundMessage(message)) {
          logger.info('[Duplicate Message] already claimed globally', { messageId, from });
          _markMessageProcessed(messageId);
          continue;
        }
        _markMessageProcessed(messageId);

        logger.debug('[Message Parsed]', {
          requestId,
          timestamp: ts,
          type,
        });

        if (type === 'text') {
          const text = message?.text?.body ?? '';
          logger.debug('[Message Parsed] text', { length: text.length });
        }

        // Queue asynchronously after Meta receives its 200 acknowledgement.
        _drainPhoneQueue(from).catch((queueErr) => {
          logger.error('WhatsApp phone queue failed', { phoneNumber: from, error: queueErr.message });
        });
      } catch (msgErr) {
        logger.error('WhatsApp per-message processing failed', {
          error: msgErr.message,
          stack: msgErr.stack,
          from: message?.from,
          messageId: message?.id,
        });
        try {
          if (message?.from) {
            await WhatsAppService.sendTextMessage(message.from,
              '⚠️ I encountered an error. Please try again in a moment.');
          }
        } catch (_) { /* ignore */ }
      }
    }
  } catch (err) {
    logger.error('WhatsApp webhook top-level error', { error: err.message, stack: err.stack });
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
}

/**
 * Webhook verification (GET)
 */
function verifyWebhook(req, res) {
  const challenge = WhatsAppService.verifyWebhook(req.query);
  if (challenge) {
    return res.send(challenge);
  }
  res.status(403).send('Verification failed');
}

/**
 * Setup WhatsApp webhook with Meta
 */
async function setupWebhook() {
  if (!config.whatsapp.webhookUrl) {
    logger.warn('WhatsApp webhook URL not configured, skipping webhook setup');
    return;
  }

  if (!config.whatsapp.businessAccountId || /^(your_|test_)/i.test(config.whatsapp.businessAccountId)) {
    logger.error('WhatsApp webhook subscription skipped: WHATSAPP_BUSINESS_ACCOUNT_ID is required');
    return;
  }

  try {
    const webhookUrl = `${config.whatsapp.webhookUrl.replace(/\/+$/, '')}/whatsapp`;

    const response = await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.whatsapp.businessAccountId}/subscribed_apps`,
      {},
      {
        headers: {
          Authorization: `Bearer ${config.whatsapp.accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    logger.info('WhatsApp WABA webhook subscription completed', {
      callbackUrl: webhookUrl,
      businessAccountId: config.whatsapp.businessAccountId,
      response: response.data,
    });
  } catch (err) {
    if (err.response?.data?.error?.code === 100 && err.response?.data?.error?.error_subcode === 2209014) {
      logger.info('WhatsApp WABA is already subscribed to this app');
    } else {
      logger.error('WhatsApp WABA webhook subscription failed', {
        error: err.message,
        status: err.response?.status,
        metaError: err.response?.data?.error,
        stack: err.stack,
      });
    }
  }
}

module.exports = {
  handleWebhook,
  verifyWebhook,
  handleTextMessage,
  processQuestion,
  getSession,
  updateSession,
  clearSession,
  userSessions,
  setupWebhook,
};
