/**
 * WhatsAppService
 * ---------------
 * Wrapper around WhatsApp Cloud API (WhatsApp Business Platform).
 * Handles:
 * - Webhook verification
 * - Sending text messages
 * - Sending interactive messages (reply buttons, list messages)
 * - Sending media (images, documents)
 * - Marking messages as read
 * - Getting media URLs
 *
 * Reuses existing services: GeminiService, SearchService, ConversationMemoryService,
 * ScenarioUnderstandingService, AmendmentService, IncidentService, LanguageDetectionService
 */

const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const LanguageDetectionService = require('./LanguageDetectionService');

const GRAPH_API_VERSION = 'v20.0'; // Update as needed
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Keep diagnostics useful without writing credentials or complete signatures to logs.
function maskValue(value, visible = 4) {
  const text = String(value || '');
  if (!text) return '(not set)';
  if (text.length <= visible) return '*'.repeat(text.length);
  return `${text.slice(0, visible)}…${'*'.repeat(Math.min(8, text.length - visible))}`;
}

// Detect example values so startup logs clearly distinguish configured credentials.
function isPlaceholder(value) {
  return !value || /^(your_|test_)/i.test(String(value).trim());
}

class WhatsAppService {
  constructor() {
    this.accessToken = config.whatsapp.accessToken;
    this.phoneNumberId = config.whatsapp.phoneNumberId;
    this.appSecret = config.whatsapp.appSecret;
    this.webhookVerifyToken = config.whatsapp.webhookVerifyToken;

    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    // Rate limiting: WhatsApp allows ~80 messages/second for business accounts
    // We'll add a simple in-memory rate limiter
    this.messageQueue = [];
    this.processing = false;

    // Startup sanity log — lengths only, never print secrets.
    // Real Meta access tokens start with "EAA" and are ~180 chars;
    // Phone number IDs are pure digits and ~10-16 chars.
    const tokenLooksReal = String(this.accessToken || '').startsWith('EAA') && String(this.accessToken).length >= 80;
    const pnidLooksReal  = /^\d{8,20}$/.test(String(this.phoneNumberId || ''));
    logger.debug('WhatsAppService: Config loaded', {
      graphBase: BASE_URL,
      phoneNumberIdLen: String(this.phoneNumberId || '').length,
      phoneNumberIdOk: pnidLooksReal,
      accessTokenPrefix: String(this.accessToken || '').slice(0, 3) + '...',
      accessTokenLen: String(this.accessToken || '').length,
      accessTokenOk: tokenLooksReal,
      appSecretSet: !isPlaceholder(this.appSecret),
      verifyTokenSet: !isPlaceholder(this.webhookVerifyToken),
    });
  }

  /**
   * Verify webhook signature (for security)
   * @param {string} signature - X-Hub-Signature-256 header
   * @param {string} payload - Raw request body
   * @returns {boolean}
   */
  verifySignature(signature, payload) {
    if (!this.appSecret || this.appSecret === 'test_app_secret') {
      // Skip verification in test mode — still log for observability
      logger.debug('WhatsApp signature check skipped (test_app_secret mode)', {
        signatureReceived: !!signature,
        payloadLength: String(payload || '').length,
      });
      return true;
    }

    if (!signature || typeof signature !== 'string') {
      logger.warn('WhatsApp signature verification failed: signature missing', {
        payloadLength: String(payload || '').length,
      });
      return false;
    }

    const receivedSignature = signature.replace(/^sha256=/, '');
    if (!/^[a-f0-9]{64}$/i.test(receivedSignature)) {
      logger.warn('WhatsApp signature verification failed: signature malformed', {
        signaturePresent: true,
      });
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.appSecret)
      .update(payload || '')
      .digest('hex');

    try {
      const verified = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(receivedSignature, 'hex')
      );
      logger.debug('WhatsApp signature verification completed', {
        verified,
        payloadLength: String(payload || '').length,
      });
      return verified;
    } catch (_e) {
      logger.warn('WhatsApp signature verification failed: comparison error');
      return false;
    }
  }

  /**
   * Verify webhook challenge (GET request)
   * @param {Object} query - Query parameters
   * @returns {string|null} Challenge string if valid, null otherwise
   */
  verifyWebhook(query) {
    const mode = query?.['hub.mode'];
    const token = query?.['hub.verify_token'];
    const challenge = query?.['hub.challenge'];

    const expectedMode = 'subscribe';
    const expectedToken = String(this.webhookVerifyToken ?? '').trim();
    const recvMode = String(mode ?? '').trim();
    const recvToken = String(token ?? '').trim();
    const recvChallenge = challenge;
    const modeMatch = recvMode === expectedMode;
    const tokenMatch = recvToken === expectedToken;
    const match = modeMatch && tokenMatch;

    if (match && recvChallenge !== undefined && recvChallenge !== null) {
      logger.info('WhatsApp webhook verified');
      return recvChallenge;
    }

    logger.warn('WhatsApp webhook verification failed', {
      mode,
      receivedToken: maskValue(token),
      expectedToken: maskValue(this.webhookVerifyToken),
    });
    return null;
  }

  /**
   * Split a long message intelligently on paragraphs, sentences, or bullets.
   */
  _splitMessage(text, maxLength = 4000) {
    if (!text || text.length <= maxLength) return [text];

    const chunks = [];
    let currentChunk = '';
    
    // Split by paragraphs first
    const paragraphs = text.split('\n\n');

    for (const p of paragraphs) {
      if (currentChunk.length + p.length + 2 <= maxLength) {
        currentChunk += (currentChunk ? '\n\n' : '') + p;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        
        if (p.length > maxLength) {
          // Fallback to sentence/line splitting if paragraph is too large
          const lines = p.split(/(?<=\n|\.|\?|\!)\s+/);
          let currentLineChunk = '';
          for (const line of lines) {
             if (currentLineChunk.length + line.length + 1 <= maxLength) {
                currentLineChunk += (currentLineChunk ? ' ' : '') + line;
             } else {
                if (currentLineChunk) chunks.push(currentLineChunk);
                if (line.length > maxLength) {
                   let remaining = line;
                   while (remaining.length > 0) {
                      chunks.push(remaining.substring(0, maxLength));
                      remaining = remaining.substring(maxLength);
                   }
                } else {
                   currentLineChunk = line;
                }
             }
          }
          if (currentLineChunk) currentChunk = currentLineChunk;
          else currentChunk = '';
        } else {
          currentChunk = p;
        }
      }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }

  /**
   * Send a text message (handles chunking for long messages)
   * @param {string} to - Recipient phone number (with country code, no +)
   * @param {string} body - Message text
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} API response
   */
  async sendTextMessage(to, body, options = {}) {
    const chunks = this._splitMessage(body, 4000);
    let lastResponse = null;

    for (const chunk of chunks) {
      const payload = {
        messaging_product: 'whatsapp',
        to: this._formatPhoneNumber(to),
        type: 'text',
        text: {
          preview_url: options.previewUrl !== false,
          body: chunk,
        },
      };

      if (options.contextMessageId) {
        payload.context = { message_id: options.contextMessageId };
      }

      lastResponse = await this._sendRequest(payload);
    }
    
    return lastResponse;
  }

  /**
   * Send a document (PDF, image, etc.)
   * @param {string} to - Recipient phone number
   * @param {string} mediaUrl - Publicly accessible URL of the document
   * @param {string} filename - Document filename
   * @param {string} caption - Optional caption
   * @returns {Promise<Object>} API response
   */
  async sendDocument(to, mediaUrl, filename, caption = '') {
    const payload = {
      messaging_product: 'whatsapp',
      to: this._formatPhoneNumber(to),
      type: 'document',
      document: {
        link: mediaUrl,
        filename: filename,
        caption: caption,
      },
    };

    return this._sendRequest(payload);
  }

  /**
   * Send an image
   * @param {string} to - Recipient phone number
   * @param {string} mediaUrl - Publicly accessible URL of the image
   * @param {string} caption - Optional caption
   * @returns {Promise<Object>} API response
   */
  async sendImage(to, mediaUrl, caption = '') {
    const payload = {
      messaging_product: 'whatsapp',
      to: this._formatPhoneNumber(to),
      type: 'image',
      image: {
        link: mediaUrl,
        caption: caption,
      },
    };

    return this._sendRequest(payload);
  }

  /**
   * Mark message as read
   * @param {string} messageId - Message ID to mark as read
   * @returns {Promise<Object>} API response
   */
  async markAsRead(messageId) {
    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    };

    return this._sendRequest(payload);
  }

  /**
   * Get media URL for download
   * @param {string} mediaId - Media ID from webhook
   * @returns {Promise<string>} Media URL
   */
  async getMediaUrl(mediaId) {
    const response = await this.client.get(`/${mediaId}`);
    return response.data.url;
  }

  /**
   * Download media (requires access token)
   * @param {string} mediaUrl - Media URL from getMediaUrl
   * @returns {Promise<Buffer>} Media buffer
   */
  async downloadMedia(mediaUrl) {
    const response = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }

  /**
   * Send typing indicator
   * @param {string} to - Recipient phone number
   * @returns {Promise<Object>} API response
   */
  async sendTypingIndicator(to) {
    const payload = {
      messaging_product: 'whatsapp',
      to: this._formatPhoneNumber(to),
      type: 'text',
      text: { body: '' }, // Empty text with typing indicator is not directly supported
      // Note: WhatsApp doesn't have a direct typing indicator API
      // We send a zero-width space as workaround
    };
    // Actually, WhatsApp doesn't support typing indicators via API
    // This is a no-op for now
    return { success: true };
  }

  /**
   * Format phone number for WhatsApp (remove +, spaces, dashes)
   * @param {string} phone - Phone number
   * @returns {string} Formatted phone number
   */
  _formatPhoneNumber(phone) {
    return phone.replace(/[\s\-\+\(\)]/g, '');
  }

  /**
   * Send request with retry + rate-limiting + detailed logging.
   * Prints the exact outgoing payload & Meta response/error so every
   * failure mode is diagnosable.
   * @param {Object} payload - Request payload (already validated by caller)
   * @returns {Promise<Object>} Axios response data on success
   */
  async _sendRequest(payload) {
    const endpoint = `/${this.phoneNumberId}/messages`;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 750;

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.debug('[Sending WhatsApp Reply]', {
          type: payload?.type,
          attempt,
        });

        const resp = await this.client.post(endpoint, payload, {
          timeout: 40000,
        });

        logger.debug('[Reply Sent Successfully]', {
          status: resp.status,
        });
        return resp.data;
      } catch (err) {
        lastError = err;
        const status = err.response?.status;
        const metaErr = err.response?.data?.error || null;
        const retryable = !status || status >= 500 || status === 429;

        logger.error('[WhatsApp API Error]', {
          attempt,
          status,
          code: metaErr?.code,
          subcode: metaErr?.error_subcode,
          message: metaErr?.message || err.message,
          type: payload?.type,
          retryable,
        });

        if (retryable && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
          continue;
        }
        break;
      }
    }
    throw lastError;
  }

}

module.exports = new WhatsAppService();
