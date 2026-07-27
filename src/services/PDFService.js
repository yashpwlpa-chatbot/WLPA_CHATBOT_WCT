/**
 * PDFService
 * ----------
 * Sends PDF documents (WLPA Act + Amendments) to Telegram/WhatsApp chats.
 *
 * Configuration:
 *   - Main WLPA PDF path from WLPA_PDF_PATH env var (default: assets/wlpa.pdf)
 *   - Amendment PDFs in assets/amendments/ folder
 *
 * Why a separate service:
 *   - Keeps messaging services focused on generic messaging
 *   - PDF logic (existence check, fallbacks, captions) is centralized
 *   - Easy to extend later (e.g. add "send specific page" feature)
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');
const TelegramService = require('./TelegramService');
const WhatsAppService = require('./WhatsAppService');
const { PDF_CAPTION, PDF_NOT_FOUND } = require('../utils/messages');

class PDFService {
  constructor() {
    // Main WLPA Act PDF
    this.mainPdfPath = this._resolvePath(config.pdf.path);
    
    // Amendment PDFs
    this.amendmentsDir = path.join(process.cwd(), 'assets', 'amendments');
    this.amendmentFiles = {
      '1982': 'amendment1982.pdf',
      '1986': 'amendment1986.pdf',
      '1991': 'amendment1991.pdf',
      '1993': 'amendment1993.pdf',
      '2002': 'amendment2002.pdf',
      '2006': 'amendment2006.pdf',
      '2022': 'amendment2022.pdf',
    };
    
    this._existsCache = new Map(); // cached existence checks
  }

  _resolvePath(p) {
    if (!p) return null;
    return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  }

  /**
   * Get the file path for a specific amendment year
   * @param {string} year - Amendment year (e.g., '1982', '2022')
   * @returns {string|null} Full file path or null if not found
   */
  getAmendmentPath(year) {
    const filename = this.amendmentFiles[year];
    if (!filename) return null;
    return path.join(this.amendmentsDir, filename);
  }

  /**
   * Get the main WLPA Act PDF path
   * @returns {string|null}
   */
  getMainPdfPath() {
    return this.mainPdfPath;
  }

  /**
   * Lazily check if a PDF file exists on disk.
   * Result is cached so we don't stat() on every send.
   * 
   * @param {string} filePath - Full path to PDF file
   * @returns {boolean}
   */
  fileExists(filePath) {
    if (!filePath) return false;
    
    if (this._existsCache.has(filePath)) {
      return this._existsCache.get(filePath);
    }
    
    try {
      const exists = fs.existsSync(filePath);
      this._existsCache.set(filePath, exists);
      if (!exists) {
        logger.warn('PDF not found at path', { path: filePath });
      }
      return exists;
    } catch (err) {
      logger.error('PDF existence check failed', { path: filePath, error: err.message });
      this._existsCache.set(filePath, false);
      return false;
    }
  }

  /**
   * Send the main WLPA Act PDF to a Telegram chat.
   * Alias for sendMainPdf — kept because many inline/cmd sites call sendPDF.
   * @param {number|string} chatId
   * @param {string} language - ISO code (en | hi | mr)
   * @returns {Promise<boolean>} true if PDF was sent, false otherwise
   */
  async sendPDF(chatId, language = 'en') {
    return this.sendMainPdf(chatId, language);
  }

  /**
   * Send the main WLPA Act PDF to a Telegram chat.
   * @param {number|string} chatId
   * @param {string} language - ISO code (en | hi | mr)
   * @returns {Promise<boolean>} true if PDF was sent, false otherwise
   */
  async sendMainPdf(chatId, language = 'en') {
    return this._sendPdf(chatId, this.mainPdfPath, language, 'main');
  }

  /**
   * Send a specific amendment PDF to a Telegram chat.
   * @param {number|string} chatId
   * @param {string} year - Amendment year (e.g., '1982', '2022')
   * @param {string} language - ISO code (en | hi | mr)
   * @returns {Promise<boolean>} true if PDF was sent, false otherwise
   */
  async sendAmendmentPdf(chatId, year, language = 'en') {
    const filePath = this.getAmendmentPath(year);
    if (!filePath) {
      await TelegramService.sendMessage(
        chatId,
        `Amendment ${year} PDF not configured.`
      );
      return false;
    }
    return this._sendPdf(chatId, filePath, language, `amendment_${year}`);
  }

  /**
   * Send a specific amendment PDF via WhatsApp.
   * @param {string} phoneNumber - WhatsApp phone number
   * @param {string} year - Amendment year
   * @param {string} language - ISO code (en | hi | mr)
   * @returns {Promise<boolean>}
   */
  async sendAmendmentPdfWhatsApp(phoneNumber, year, language = 'en') {
    const filePath = this.getAmendmentPath(year);
    if (!filePath) {
      await WhatsAppService.sendTextMessage(phoneNumber, `Amendment ${year} PDF not configured.`);
      return false;
    }

    if (!this.fileExists(filePath)) {
      await WhatsAppService.sendTextMessage(phoneNumber, `Amendment ${year} PDF not found.`);
      return false;
    }

    // For WhatsApp, we need to upload the media first or use a public URL
    // Since we have local files, we'll need to upload them to WhatsApp first
    // For now, return false - would need media upload implementation
    logger.warn('WhatsApp amendment PDF send not fully implemented - needs media upload');
    return false;
  }

  /**
   * Send the main WLPA Act PDF via WhatsApp.
   * @param {string} phoneNumber
   * @param {string} language
   * @returns {Promise<boolean>}
   */
  async sendMainPdfWhatsApp(phoneNumber, language = 'en') {
    if (!this.fileExists(this.mainPdfPath)) {
      await WhatsAppService.sendTextMessage(phoneNumber, 'WLPA PDF not found.');
      return false;
    }
    logger.warn('WhatsApp main PDF send not fully implemented - needs media upload');
    return false;
  }

  /**
   * Send all configured amendment PDFs to a Telegram chat.
   * @param {number|string} chatId
   * @param {string} language
   * @returns {Promise<number>} count of PDFs successfully sent
   */
  async sendAllAmendmentPdfs(chatId, language = 'en') {
    const years = this.getAvailableAmendments().sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    let sent = 0;
    for (const year of years) {
      const ok = await this.sendAmendmentPdf(chatId, year, language);
      if (ok) sent += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return sent;
  }

  /**
   * Send main WLPA PDF followed by all amendment PDFs.
   * @param {number|string} chatId
   * @param {string} language
   * @returns {Promise<{ main: boolean, amendments: number }>}
   */
  async sendMainAndAllAmendments(chatId, language = 'en') {
    const main = await this.sendMainPdf(chatId, language);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const amendments = await this.sendAllAmendmentPdfs(chatId, language);
    return { main, amendments };
  }

  /**
   * Internal method to send PDF via Telegram.
   * @private
   */
  async _sendPdf(chatId, filePath, language, type) {
    if (!this.fileExists(filePath)) {
      await TelegramService.sendMessage(
        chatId,
        PDF_NOT_FOUND[language] || PDF_NOT_FOUND.en
      );
      return false;
    }

    try {
      logger.info('pdf_send', { chatId, path: filePath, language, type });
      
      // Determine caption based on type
      let caption = PDF_CAPTION[language] || PDF_CAPTION.en;
      if (type.startsWith('amendment_')) {
        const year = type.replace('amendment_', '');
        const captions = {
          en: `📄 <b>WLPA Amendment Act, ${year}</b>\n\nOfficial amendment document.`,
          hi: `📄 <b>WLPA संशोधन अधिनियम, ${year}</b>\n\nआधिकारिक संशोधन दस्तावेज़।`,
          mr: `📄 <b>WLPA संशोधन कायदा, ${year}</b>\n\nअधिकृत संशोधन दस्तऐवज।`,
        };
        caption = captions[language] || captions.en;
      }
      
      await TelegramService.sendDocument(chatId, filePath, caption);
      return true;
    } catch (err) {
      logger.error('Failed to send PDF', { path: filePath, error: err.message });
      await TelegramService.sendMessage(
        chatId,
        PDF_NOT_FOUND[language] || PDF_NOT_FOUND.en
      );
      return false;
    }
  }

  /**
   * Get list of available amendment years
   * @returns {string[]}
   */
  getAvailableAmendments() {
    return Object.keys(this.amendmentFiles);
  }

  /**
   * Check if amendment PDF exists
   * @param {string} year
   * @returns {boolean}
   */
  hasAmendment(year) {
    const filePath = this.getAmendmentPath(year);
    return filePath ? this.fileExists(filePath) : false;
  }
}

module.exports = new PDFService();