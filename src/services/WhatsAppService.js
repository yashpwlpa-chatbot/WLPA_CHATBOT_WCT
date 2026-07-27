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
    logger.info('WhatsAppService: Config loaded', {
      graphBase: BASE_URL,
      phoneNumberIdLen: String(this.phoneNumberId || '').length,
      phoneNumberIdOk: pnidLooksReal,
      accessTokenPrefix: String(this.accessToken || '').slice(0, 3) + '...',
      accessTokenLen: String(this.accessToken || '').length,
      accessTokenOk: tokenLooksReal,
      appSecretSet: !!this.appSecret && this.appSecret !== 'test_app_secret',
      verifyTokenSet: !!this.webhookVerifyToken && this.webhookVerifyToken !== 'test_verify_token',
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
      logger.debug('WhatsApp signature check skipped (test_app_secret mode)');
      return true;
    }

    if (!signature || typeof signature !== 'string') {
      logger.warn('WhatsApp signature missing in request');
      return false;
    }

    const receivedSignature = signature.replace(/^sha256=/, '');
    if (!/^[a-f0-9]{64}$/i.test(receivedSignature)) {
      logger.warn('WhatsApp signature malformed');
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.appSecret)
      .update(payload || '')
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(receivedSignature, 'hex')
      );
    } catch (_e) {
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

    logger.warn('WhatsApp webhook verification failed', { mode, token });
    return null;
  }

  /**
   * Send a text message
   * @param {string} to - Recipient phone number (with country code, no +)
   * @param {string} body - Message text
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} API response
   */
  async sendTextMessage(to, body, options = {}) {
    const payload = {
      messaging_product: 'whatsapp',
      to: this._formatPhoneNumber(to),
      type: 'text',
      text: {
        preview_url: options.previewUrl !== false,
        body: body,
      },
    };

    if (options.contextMessageId) {
      payload.context = { message_id: options.contextMessageId };
    }

    return this._sendRequest(payload);
  }

  /**
   * Send interactive reply buttons (max 3 buttons)
   * @param {string} to - Recipient phone number
   * @param {string} body - Message body
   * @param {Array} buttons - Array of { id, title } (max 3)
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} API response
   */
  async sendReplyButtons(to, body, buttons, options = {}) {
    if (buttons.length > 3) {
      throw new Error('WhatsApp reply buttons maximum is 3');
    }

    const payload = {
      messaging_product: 'whatsapp',
      to: this._formatPhoneNumber(to),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.map((btn, index) => ({
            type: 'reply',
            reply: {
              id: btn.id || `btn_${index}`,
              title: btn.title.substring(0, 20), // WhatsApp limit: 20 chars
            },
          })),
        },
      },
    };

    if (options.header) {
      payload.interactive.header = {
        type: 'text',
        text: options.header.substring(0, 60),
      };
    }
    if (options.footer) {
      payload.interactive.footer = {
        text: options.footer.substring(0, 60),
      };
    }

    return this._sendRequest(payload);
  }

  /**
   * Send interactive list message (scrollable menu, max 10 rows per section)
   * @param {string} to - Recipient phone number
   * @param {string} body - Message body
   * @param {string} buttonText - Button text to open list
   * @param {Array} sections - Array of { title, rows: [{ id, title, description }] }
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} API response
   */
  async sendListMessage(to, body, buttonText, sections, options = {}) {
    // Validate sections
    let totalRows = 0;
    for (const section of sections) {
      if (section.rows && section.rows.length > 10) {
        throw new Error('WhatsApp list section maximum is 10 rows');
      }
      totalRows += section.rows?.length || 0;
    }
    if (totalRows > 10) {
      throw new Error('WhatsApp list message maximum is 10 rows total');
    }

    const payload = {
      messaging_product: 'whatsapp',
      to: this._formatPhoneNumber(to),
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: buttonText.substring(0, 20),
          sections: sections.map(section => ({
            title: section.title.substring(0, 24),
            rows: (section.rows || []).map(row => ({
              id: row.id,
              title: row.title.substring(0, 24),
              description: row.description ? row.description.substring(0, 72) : undefined,
            })).filter(r => r.title),
          })).filter(s => s.rows.length > 0),
        },
      },
    };

    if (options.header) {
      payload.interactive.header = {
        type: 'text',
        text: options.header.substring(0, 60),
      };
    }
    if (options.footer) {
      payload.interactive.footer = {
        text: options.footer.substring(0, 60),
      };
    }

    return this._sendRequest(payload);
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
        logger.info('[Sending WhatsApp Reply]', {
          graphUrl: BASE_URL + endpoint,
          phoneNumberId: this.phoneNumberId,
          to: payload?.to,
          type: payload?.type,
          attempt,
        });
        if (attempt === 1) {
          console.log('[Sending WhatsApp Reply] payload =', JSON.stringify(payload, null, 2));
        } else {
          console.log(`[Sending WhatsApp Reply] retry attempt=${attempt}`);
        }

        const resp = await this.client.post(endpoint, payload, {
          timeout: 40000,
        });

        console.log('[Reply Sent Successfully] status=', resp.status, 'data=', JSON.stringify(resp.data));
        logger.info('[Reply Sent Successfully]', {
          status: resp.status,
          messageId: resp.data?.messages?.[0]?.id,
          to: payload?.to,
        });
        return resp.data;
      } catch (err) {
        lastError = err;
        const status = err.response?.status;
        const metaErr = err.response?.data?.error || null;
        const retryable = !status || status >= 500 || status === 429;

        console.log('[WhatsApp API Error]', {
          attempt,
          status,
          code: metaErr?.code,
          subcode: metaErr?.error_subcode,
          message: metaErr?.message || err.message,
          retryable,
        });
        logger.error('[WhatsApp API Error]', {
          attempt,
          status,
          code: metaErr?.code,
          subcode: metaErr?.error_subcode,
          message: metaErr?.message || err.message,
          fbtraceId: metaErr?.fbtrace_id,
          to: payload?.to,
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

  /**
   * Build main menu list message
   * @param {string} language - Language code
   * @returns {Object} List message config
   */
  buildMainMenu(language = 'en') {
    const menus = {
      en: {
        body: '🦉 *WLPA Assistant*\n\nChoose an option below:',
        buttonText: 'Menu',
        sections: [
          {
            title: '📚 Knowledge',
            rows: [
              { id: 'menu_sections', title: 'Sections', description: 'Browse WLPA sections' },
              { id: 'menu_species', title: 'Species', description: 'Protected species list' },
              { id: 'menu_schedules', title: 'Schedules', description: 'Schedule I-VI details' },
              { id: 'menu_penalties', title: 'Penalties', description: 'Offence penalties' },
            ],
          },
          {
            title: '🛠 Tools',
            rows: [
              { id: 'menu_incident', title: 'Report Incident', description: 'File wildlife incident report' },
              { id: 'menu_amendments', title: 'Amendments', description: 'All WLPA amendments' },
              { id: 'menu_ask', title: 'Ask Question', description: 'Type your WLPA question' },
            ],
          },
          {
            title: '⚙️ Settings',
            rows: [
              { id: 'menu_language', title: 'Change Language', description: 'Switch language' },
              { id: 'menu_help', title: 'Help', description: 'How to use this bot' },
              { id: 'menu_support', title: 'Support', description: 'Contact support' },
            ],
          },
        ],
        footer: 'Wildlife (Protection) Act, 1972 Assistant',
      },
      hi: {
        body: '🦉 *WLPA सहायक*\n\nनीचे से एक विकल्प चुनें:',
        buttonText: 'मेनू',
        sections: [
          {
            title: '📚 ज्ञान',
            rows: [
              { id: 'menu_sections', title: 'धाराएँ', description: 'WLPA धाराएँ ब्राउज़ करें' },
              { id: 'menu_species', title: 'प्रजातियाँ', description: 'संरक्षित प्रजातियों की सूची' },
              { id: 'menu_schedules', title: 'अनुसूचियाँ', description: 'अनुसूची I-VI विवरण' },
              { id: 'menu_penalties', title: 'दंड', description: 'अपराधों के दंड' },
            ],
          },
          {
            title: '🛠 उपकरण',
            rows: [
              { id: 'menu_incident', title: 'घटना रिपोर्ट', description: 'वन्यजीव घटना रिपोर्ट दर्ज करें' },
              { id: 'menu_amendments', title: 'संशोधन', description: 'सभी WLPA संशोधन' },
              { id: 'menu_ask', title: 'प्रश्न पूछें', description: 'अपना WLPA प्रश्न टाइप करें' },
            ],
          },
          {
            title: '⚙️ सेटिंग्स',
            rows: [
              { id: 'menu_language', title: 'भाषा बदलें', description: 'भाषा बदलें' },
              { id: 'menu_help', title: 'सहायता', description: 'बॉट का उपयोग कैसे करें' },
              { id: 'menu_support', title: 'समर्थन', description: 'सहायता से संपर्क करें' },
            ],
          },
        ],
        footer: 'वन्यजीव (संरक्षण) अधिनियम, 1972 सहायक',
      },
      mr: {
        body: '🦉 *WLPA सहाय्यक*\n\nखालीलपासून एक पर्याय निवडा:',
        buttonText: 'मेनू',
        sections: [
          {
            title: '📚 ज्ञान',
            rows: [
              { id: 'menu_sections', title: 'कलमे', description: 'WLPA कलमे ब्राउझ करा' },
              { id: 'menu_species', title: 'प्रजाती', description: 'संरक्षित प्रजातीची यादी' },
              { id: 'menu_schedules', title: 'अनुसूची', description: 'अनुसूची I-VI तपशील' },
              { id: 'menu_penalties', title: 'दंड', description: 'गुन्हांचे दंड' },
            ],
          },
          {
            title: '🛠 साधने',
            rows: [
              { id: 'menu_incident', title: 'घटना अहवाल', description: 'वन्यजीव घटना अहवाल नोंदवा' },
              { id: 'menu_amendments', title: 'सुधारणा', description: 'सर्व WLPA सुधारणा' },
              { id: 'menu_ask', title: 'प्रश्न विचारा', description: 'तुमचा WLPA प्रश्न टाइप करा' },
            ],
          },
          {
            title: '⚙️ सेटिंग्ज',
            rows: [
              { id: 'menu_language', title: 'भाषा बदला', description: 'भाषा बदला' },
              { id: 'menu_help', title: 'मदत', description: 'बॉट कसे वापरावे' },
              { id: 'menu_support', title: 'सहाय्य', description: 'सहाय्यशी संपर्क करा' },
            ],
          },
        ],
        footer: 'वन्यजीव (संरक्षण) कायदा, 1972 सहाय्यक',
      },
    };

    return menus[language] || menus.en;
  }

  /**
   * Build language selection buttons
   * @returns {Object} Reply buttons config
   */
  buildLanguageButtons() {
    return {
      body: '🌐 Choose your language / अपनी भाषा चुनें / तुमची भाषा निवडा',
      buttons: [
        { id: 'lang_en', title: '🇬🇧 English' },
        { id: 'lang_hi', title: '🇮🇳 हिन्दी' },
        { id: 'lang_mr', title: '🇲🇷 मराठी' },
      ],
    };
  }

  /**
   * Build sections list
   * @param {string} language - Language code
   * @returns {Object} List message config
   */
  buildSectionsList(language = 'en') {
    const sectionsData = {
      en: {
        title: '📚 WLPA Sections',
        rows: [
          { id: 'sec_2', title: 'Section 2', description: 'Definitions' },
          { id: 'sec_9', title: 'Section 9', description: 'Prohibition of hunting' },
          { id: 'sec_11', title: 'Section 11', description: 'Hunting permitted cases' },
          { id: 'sec_12', title: 'Section 12', description: 'Special permits' },
          { id: 'sec_17A', title: 'Section 17A', description: 'Specified plants protection' },
          { id: 'sec_29', title: 'Section 29', description: 'Sanctuary protection' },
          { id: 'sec_35', title: 'Section 35', description: 'National Parks' },
          { id: 'sec_39', title: 'Section 39', description: 'Govt property' },
          { id: 'sec_44', title: 'Section 44', description: 'Trade licence' },
          { id: 'sec_50', title: 'Section 50', description: 'Search/seizure powers' },
          { id: 'sec_51', title: 'Section 51', description: 'Penalties' },
        ],
      },
      hi: {
        title: '📚 WLPA धाराएँ',
        rows: [
          { id: 'sec_2', title: 'धारा 2', description: 'परिभाषाएँ' },
          { id: 'sec_9', title: 'धारा 9', description: 'शिकार निषेध' },
          { id: 'sec_11', title: 'धारा 11', description: 'शिकार अनुमति' },
          { id: 'sec_12', title: 'धारा 12', description: 'विशेष अनुमति' },
          { id: 'sec_17A', title: 'धारा 17A', description: 'निर्दिष्ट पौधे संरक्षण' },
          { id: 'sec_29', title: 'धारा 29', description: 'अभयारण्य संरक्षण' },
          { id: 'sec_35', title: 'धारा 35', description: 'राष्ट्रीय उद्यान' },
          { id: 'sec_39', title: 'धारा 39', description: 'सरकारी संपत्ति' },
          { id: 'sec_44', title: 'धारा 44', description: 'व्यापार लाइसेंस' },
          { id: 'sec_50', title: 'धारा 50', description: 'तलाशी/जब्ती अधिकार' },
          { id: 'sec_51', title: 'धारा 51', description: 'दंड' },
        ],
      },
      mr: {
        title: '📚 WLPA कलमे',
        rows: [
          { id: 'sec_2', title: 'कलम 2', description: 'व्याख्या' },
          { id: 'sec_9', title: 'कलम 9', description: 'शिकार बंदी' },
          { id: 'sec_11', title: 'कलम 11', description: 'शिकार परवानगी' },
          { id: 'sec_12', title: 'कलम 12', description: 'विशेष परवानगी' },
          { id: 'sec_17A', title: 'कलम 17A', description: 'निर्दिष्ट वनस्पती संरक्षण' },
          { id: 'sec_29', title: 'कलम 29', description: 'अभयारण्य संरक्षण' },
          { id: 'sec_35', title: 'कलम 35', description: 'राष्ट्रीय उद्यान' },
          { id: 'sec_39', title: 'कलम 39', description: 'शासकीय संपत्ती' },
          { id: 'sec_44', title: 'कलम 44', description: 'व्यापार परवानगी' },
          { id: 'sec_50', title: 'कलम 50', description: 'शोध/जब्ती अधिकार' },
          { id: 'sec_51', title: 'कलम 51', description: 'दंड' },
        ],
      },
    };

    return sectionsData[language] || sectionsData.en;
  }

  /**
   * Build schedules list
   * @param {string} language - Language code
   * @returns {Object} List message config
   */
  buildSchedulesList(language = 'en') {
    return {
      en: {
        title: '📅 WLPA Schedules',
        rows: [
          { id: 'sch_I', title: 'Schedule I', description: 'Highest protection (Tiger, Elephant, etc.)' },
          { id: 'sch_II', title: 'Schedule II', description: 'High protection (Leopard, Bear, etc.)' },
          { id: 'sch_III', title: 'Schedule III', description: 'Protected species' },
          { id: 'sch_IV', title: 'Schedule IV', description: 'CITES species (2022)' },
          { id: 'sch_V', title: 'Schedule V', description: 'Vermin (notification only)' },
          { id: 'sch_VI', title: 'Schedule VI', description: 'Specified plants' },
        ],
      },
      hi: {
        title: '📅 WLPA अनुसूचियाँ',
        rows: [
          { id: 'sch_I', title: 'अनुसूची I', description: 'उच्चतम संरक्षण (बाघ, हाथी, आदि)' },
          { id: 'sch_II', title: 'अनुसूची II', description: 'उच्च संरक्षण (तेंदुआ, भालू, आदि)' },
          { id: 'sch_III', title: 'अनुसूची III', description: 'संरक्षित प्रजातियाँ' },
          { id: 'sch_IV', title: 'अनुसूची IV', description: 'CITES प्रजातियाँ (2022)' },
          { id: 'sch_V', title: 'अनुसूची V', description: 'कीट (अधिसूचना मात्र)' },
          { id: 'sch_VI', title: 'अनुसूची VI', description: 'निर्दिष्ट पौधे' },
        ],
      },
      mr: {
        title: '📅 WLPA अनुसूची',
        rows: [
          { id: 'sch_I', title: 'अनुसूची I', description: 'सर्वोच्च संरक्षण (वाघ, हत्ती, इ.)' },
          { id: 'sch_II', title: 'अनुसूची II', description: 'उच्च संरक्षण (बिबट्या, अस्वल, इ.)' },
          { id: 'sch_III', title: 'अनुसूची III', description: 'संरक्षित प्रजाती' },
          { id: 'sch_IV', title: 'अनुसूची IV', description: 'CITES प्रजाती (2022)' },
          { id: 'sch_V', title: 'अनुसूची V', description: 'कीटक (सूचना फक्त)' },
          { id: 'sch_VI', title: 'अनुसूची VI', description: 'निर्दिष्ट वनस्पती' },
        ],
      },
    }[language] || { title: '📅 WLPA Schedules', rows: [] };
  }

  /**
   * Build amendments list for WhatsApp list message
   * @param {string} language - Language code
   * @returns {Object} List message config
   */
  buildAmendmentsListSections(language = 'en') {
    const years = ['2022', '2006', '2002', '1993', '1991', '1986', '1982', '1972'];
    
    const descriptions = {
      en: {
        '2022': 'CITES implementation, rationalized schedules, invasive species',
        '2006': 'NTCA, Tiger Reserves, WCCB, special tiger penalties',
        '2002': 'Ecological security, National/State Boards, Conservation/Community Reserves, Forfeiture',
        '1993': 'Extended zoo recognition deadline to 18 months',
        '1991': 'Plant protection (Schedule VI), Central Zoo Authority, penalties 12x',
        '1986': 'Chapter VA - Trade ban on scheduled animals, ivory licensing',
        '1982': 'Minor definitions and procedural amendments',
        '1972': 'Original Act - Foundation of wildlife law in India',
      },
      hi: {
        '2022': 'CITES कार्यान्वयन, युक्तिसंगत अनुसूचियाँ, आक्रामक प्रजातियाँ',
        '2006': 'NTCA, बाघ आरक्षित, WCCB, विशेष बाघ दंड',
        '2002': 'पारिस्थितिक सुरक्षा, राष्ट्रीय/राज्य बोर्ड, संरक्षण/सामुदायिक आरक्षित, जब्ती',
        '1993': 'चिड़ियाघर मान्यता की समय सीमा 18 महीने तक बढ़ाई गई',
        '1991': 'पौधा संरक्षण (अनुसूची VI), केंद्रीय चिड़ियाघर प्राधिकरण, दंड 12x',
        '1986': 'अध्याय VA - अनुसूचित जानवरों पर व्यापार प्रतिबंध, हाथीदांत लाइसेंसिंग',
        '1982': 'मामूली परिभाषाएँ और प्रक्रियात्मक संशोधन',
        '1972': 'मूल अधिनियम - भारत में वन्यजीव कानून की नींव',
      },
      mr: {
        '2022': 'CITES कार्यान्वयन, युक्तिसंगत अनुसूचियाँ, आक्रामक प्रजातियाँ',
        '2006': 'NTCA, वाघ आरक्षित, WCCB, विशेष वाघ दंड',
        '2002': 'पारिस्थितिक सुरक्षा, राष्ट्रीय/राज्य बोर्ड, संरक्षण/सामुदायिक आरक्षित, जब्ती',
        '1993': 'चिड़ियाघर मान्यता काळावधी १८ महिन्यांपर्यंत वाढवली',
        '1991': 'वनस्पती संरक्षण (अनुसूची VI), केंद्रीय चिड़ियाघर प्राधिकरण, दंड १२x',
        '1986': 'अध्याय VA - अनुसूचित प्राण्यांवर व्यापार बंदी, हस्तीदंत परवानगी',
        '1982': 'लहान व्याख्या आणि प्रक्रियात्मक सुधारणा',
        '1972': 'मूल कायदा - भारतात वन्यजीव कायद्याची आधारशिला',
      },
    };

    return {
      title: {
        en: '📜 WLPA Amendments',
        hi: '📜 WLPA संशोधन',
        mr: '📜 WLPA संशोधन',
      }[language] || '📜 WLPA Amendments',
      rows: [
        { id: 'amend_pdf:2022', title: '2022 Amendment', description: descriptions[language]?.['2022'] || descriptions.en['2022'] },
        { id: 'amend_pdf:2006', title: '2006 Amendment', description: descriptions[language]?.['2006'] || descriptions.en['2006'] },
        { id: 'amend_pdf:2002', title: '2002 Amendment', description: descriptions[language]?.['2002'] || descriptions.en['2002'] },
        { id: 'amend_pdf:1993', title: '1993 Amendment', description: descriptions[language]?.['1993'] || descriptions.en['1993'] },
        { id: 'amend_pdf:1991', title: '1991 Amendment', description: descriptions[language]?.['1991'] || descriptions.en['1991'] },
        { id: 'amend_pdf:1986', title: '1986 Amendment', description: descriptions[language]?.['1986'] || descriptions.en['1986'] },
        { id: 'amend_pdf:1982', title: '1982 Amendment', description: descriptions[language]?.['1982'] || descriptions.en['1982'] },
        { id: 'amend_pdf:1972', title: '1972 Original Act', description: descriptions[language]?.['1972'] || descriptions.en['1972'] },
      ],
    };
  }

  /**
   * Build penalties quick reference
   * @param {string} language - Language code
   * @returns {Object} Reply buttons or text
   */
  buildPenaltiesReference(language = 'en') {
    const texts = {
      en: {
        body: `⚖️ *WLPA Penalties Quick Reference*\n\n` +
          `*General Offence (Section 51):* 3-7 years, ₹1 Lakh min\n` +
          `*Schedule I/II / Appendix I (Section 51 proviso):* 3-7 years, ₹25K min\n` +
          `*Repeat Offence:* 7 years, ₹5 Lakh min\n` +
          `*Chapter VA (Scheduled Animals):* 1-7 years, ₹5K min\n` +
          `*Tiger Reserve Core (Section 51C):* 3-7 yrs, ₹50K-2L (1st); 7 yrs, ₹5-50L (repeat)\n` +
          `*Compounding (Section 54):* Up to ₹5 Lakh\n` +
          `*Reward (Section 60B):* Up to ₹10,000`,
        buttons: [
          { id: 'pen_details', title: 'Full Details' },
          { id: 'menu_main', title: 'Main Menu' },
        ],
      },
      hi: {
        body: `⚖️ *WLPA दंड त्वरित संदर्भ*\n\n` +
          `*सामान्य अपराध (धारा 51):* 3-7 वर्ष, ₹1 लाख न्यूनतम\n` +
          `*अनुसूची I/II / परिशिष्ट I (धारा 51 प्रावधान):* 3-7 वर्ष, ₹25 हजार न्यूनतम\n` +
          `*दोहराया अपराध:* 7 वर्ष, ₹5 लाख न्यूनतम\n` +
          `*अध्याय VA (अनुसूचित जानवर):* 1-7 वर्ष, ₹5 हजार न्यूनतम\n` +
          `*बाघ आरक्षित कोर (धारा 51C):* 3-7 वर्ष, ₹50हजार-2L (पहला); 7 वर्ष, ₹5-50L (दोहराया)\n` +
          `*समझौता (धारा 54):* ₹5 लाख तक\n` +
          `*पुरस्कार (धारा 60B):* ₹10,000 तक`,
        buttons: [
          { id: 'pen_details', title: 'पूरा विवरण' },
          { id: 'menu_main', title: 'मुख्य मेनू' },
        ],
      },
      mr: {
        body: `⚖️ *WLPA दंड त्वरित संदर्भ*\n\n` +
          `*सामान्य गुन्हा (कलम 51):* ३-७ वर्ष, ₹१ लाख किमान\n` +
          `*अनुसूची I/II / परिशिष्ट I (कलम 51 प्रावधान):* ३-७ वर्ष, ₹२५ हजार किमान\n` +
          `*पुन्हा गुन्हा:* ७ वर्ष, ₹५ लाख किमान\n` +
          `*अध्याय VA (अनुसूचित प्राणी):* १-७ वर्ष, ₹५ हजार किमान\n` +
          `*वाघ आरक्षित कोर (कलम 51C):* ३-७ वर्ष, ₹५०हजार-२L (पहिला); ७ वर्ष, ₹५-५०L (पुन्हा)\n` +
          `*समझौता (कलम 54):* ₹५ लाख पर्यंत\n` +
          `*बक्षीस (कलम 60B):* ₹१०,००० पर्यंत`,
        buttons: [
          { id: 'pen_details', title: 'संपूर्ण तपशील' },
          { id: 'menu_main', title: 'मुख्य मेनू' },
        ],
      },
    };

    return texts[language] || texts.en;
  }
}

module.exports = new WhatsAppService();