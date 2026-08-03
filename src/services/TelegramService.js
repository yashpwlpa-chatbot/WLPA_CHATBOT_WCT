/**
 * TelegramService
 * ---------------
 * Centralizes all interactions with the Telegram Bot API.
 *
 * - sendMessage / sendChatAction: thin wrappers around the official API.
 * - downloadFile: fetches voice files so STT can consume them.
 *
 * Keeping Telegram-specific calls inside this service means we can later
 * Pure Telegram Bot API wrapper.
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const API_BASE = `https://api.telegram.org/bot${config.telegram.token}`;

class TelegramService {
  constructor() {
    this.client = axios.create({
      baseURL: API_BASE,
      timeout: 30000,
    });
  }

  async sendMessage(chatId, text, extra = {}) {
    try {
      // Telegram has a 4096 char limit per message; split if needed.
      const chunks = this._splitMessage(text || '');
      for (const chunk of chunks) {
        await this.client.post('/sendMessage', {
          chat_id: chatId,
          text: chunk,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...extra,
        });
      }
      return true;
    } catch (err) {
      const apiMessage = err.response?.data?.description || err.message;
      logger.error('Telegram sendMessage failed', { error: apiMessage });
      // Final fallback: try without HTML in case formatting caused it.
      try {
        await this.client.post('/sendMessage', {
          chat_id: chatId,
          text: this._stripHtml(text),
          disable_web_page_preview: true,
        });
        return true;
      } catch (innerErr) {
        logger.error('Telegram fallback sendMessage failed', {
          error: innerErr.response?.data?.description || innerErr.message,
        });
        return false;
      }
    }
  }

  /**
   * Show "typing..." while we work on an answer.
   */
  async sendChatAction(chatId, action = 'typing') {
    try {
      await this.client.post('/sendChatAction', { chat_id: chatId, action });
    } catch (err) {
      // Non-fatal – just log.
      logger.warn('Telegram sendChatAction failed', { error: err.message });
    }
  }

  /**
   * Resolve a file_id to a downloadable URL using Telegram's getFile,
   * then fetch the bytes. Returns a Buffer ready for Whisper.
   */
  async downloadFile(fileId) {
    if (!fileId) throw new Error('TelegramService.downloadFile: missing fileId');

    const meta = await this.client.post('/getFile', { file_id: fileId });
    const filePath = meta.data?.result?.file_path;
    if (!filePath) {
      throw new Error('Telegram getFile returned no file_path');
    }

    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${filePath}`;
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(response.data);
  }

  // --- helpers ---

  _splitMessage(text) {
    if (text.length <= 4000) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, 4000));
      remaining = remaining.slice(4000);
    }
    return chunks;
  }

  _stripHtml(text) {
    return (text || '').replace(/<[^>]*>/g, '');
  }

  /**
   * Acknowledge a callback query (removes the "loading" indicator on the button).
   * Used after handling an inline-keyboard press.
   */
  async answerCallbackQuery(callbackQueryId, text = '') {
    try {
      await this.client.post('/answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text,
        show_alert: false,
      });
      return true;
    } catch (err) {
      logger.warn('Telegram answerCallbackQuery failed', { error: err.message });
      return false;
    }
  }

  /**
   * Edit the text and inline keyboard on an existing bot message.
   */
  async editMessageText(chatId, messageId, text, extra = {}) {
    try {
      await this.client.post('/editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
      });
      return true;
    } catch (err) {
      const apiMsg = err.response?.data?.description || err.message;
      logger.warn('Telegram editMessageText failed', {
        error: apiMsg,
      });
      return false;
    }
  }

  /**
   * Edit the inline keyboard on an existing bot message.
   * Used to swap the "feedback" buttons for the "language picker" buttons,
   * then back to feedback after a language is chosen.
   */
  async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    try {
      await this.client.post('/editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      });
      return true;
    } catch (err) {
      const apiMsg = err.response?.data?.description || err.message;
      logger.warn('Telegram editMessageReplyMarkup failed', {
        error: apiMsg,
      });
      return false;
    }
  }

  /**
   * Send a document (PDF, image, etc.) by local file path.
   * Uses Telegram's multipart/form-data sendDocument endpoint.
   *
   * @param {number|string} chatId
   * @param {string} filePath - absolute path to the file on disk
   * @param {string} [caption] - optional caption (HTML supported)
   * @returns {Promise<boolean>}
   */
  async sendDocument(chatId, filePath, caption = '') {
    const FormData = require('form-data');
    const fs = require('fs');
    if (!filePath) throw new Error('TelegramService.sendDocument: missing filePath');
    if (!fs.existsSync(filePath)) {
      throw new Error(`TelegramService.sendDocument: file not found at ${filePath}`);
    }

    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', fs.createReadStream(filePath));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }

    try {
      await this.client.post('/sendDocument', form, {
        headers: form.getHeaders(),
        timeout: 60000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return true;
    } catch (err) {
      const apiMsg = err.response?.data?.description || err.message;
      logger.error('Telegram sendDocument failed', { error: apiMsg });
      throw err;
    }
  }
}

module.exports = new TelegramService();
