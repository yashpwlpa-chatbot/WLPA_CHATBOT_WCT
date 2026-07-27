/**
 * LanguageService
 * ---------------
 * Enhanced language detection with support for:
 * - English
 * - Hindi (Devanagari)
 * - Marathi (Devanagari)
 * - Roman Hindi / Hinglish (e.g., "Section 9 kya hai")
 * - Roman Marathi (e.g., "Kalam 9 kay ahe")
 *
 * Uses LanguageDetectionService for semantic detection.
 * Maintains backward compatibility with existing resolve() interface.
 */

const LanguageDetectionService = require('./LanguageDetectionService');
const config = require('../config');
const { LANGUAGES, SUPPORTED_LANGUAGES, LANGUAGE_NAMES } = require('../utils/constants');
const logger = require('../utils/logger');

class LanguageService {
  constructor() {
    this.detectionService = LanguageDetectionService;
  }

  /**
   * Resolve a language from an override command like "/english".
   * Returns null if the command is not a recognized override.
   */
  resolveCommand(command) {
    return this.detectionService._resolveCommand(command);
  }

  /**
   * Detect language from raw text using semantic detection.
   * Supports Devanagari, Roman Hindi, Roman Marathi, and English.
   */
  async detect(text) {
    return this.detectionService.detect(text);
  }

  /**
   * Resolve the effective language for an incoming message.
   *
   * Priority (highest to lowest):
   *   1. Explicit command (/english, /hindi, /marathi)
   *   2. Stored preference (user previously chose via /cmd or button)
   *   3. Auto-detection from text (semantic)
   *
   * Once a user picks a language, their choice is sticky and not
   * overwritten by later auto-detection - per requirement.
   */
  async resolve({ command, text, storedLanguage }) {
    // 1. Explicit command
    const fromCommand = this.resolveCommand(command);
    if (fromCommand) return fromCommand;

    // 2. Stored preference (sticky)
    if (storedLanguage && SUPPORTED_LANGUAGES.includes(storedLanguage)) {
      return storedLanguage;
    }

    // 3. Semantic auto-detection
    return this.detect(text);
  }

  getName(code) {
    return LANGUAGE_NAMES[code] || code;
  }

  isSupported(code) {
    return SUPPORTED_LANGUAGES.includes(code);
  }
}

module.exports = new LanguageService();