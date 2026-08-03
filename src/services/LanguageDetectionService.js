/**
 * LanguageDetectionService
 * ------------------------
 * Advanced semantic language detection for:
 * - English
 * - Hindi (Devanagari)
 * - Marathi (Devanagari)
 * - Roman Hindi (Hinglish)
 * - Roman Marathi (Marathi in Latin script)
 *
 * Uses multiple signals:
 * 1. Script detection (Devanagari vs Latin)
 * 2. Language-specific vocabulary/keywords
 * 3. Character n-gram patterns (via franc-min)
 * 4. Semantic patterns (common phrases, grammar markers)
 * 5. WLPA domain-specific terms in each language
 */

const logger = require('../utils/logger');
const { LANGUAGES, SUPPORTED_LANGUAGES } = require('../utils/constants');

let francModulePromise;

const loadFrancModule = () => {
  if (!francModulePromise) {
    francModulePromise = import('franc-min');
  }
  return francModulePromise;
};

// Devanagari Unicode range
const DEVANAGARI_REGEX = /[\u0900-\u097F]/;
// Latin characters
const LATIN_REGEX = /[A-Za-z]/;
// Digits
const DIGIT_REGEX = /\d/;

// Hindi keywords (Devanagari)
const HINDI_KEYWORDS = new Set([
  'क्या', 'है', 'हैं', 'का', 'के', 'की', 'में', 'से', 'को', 'पर', 'और', 'या',
  'धारा', 'अनुसूची', 'जानवर', 'पशु', 'पक्षी', 'वन', 'वन्यजीव', 'संरक्षण',
  'अधिनियम', 'कानून', 'दंड', 'सजा', 'जुर्माना', 'शिकार', 'अवैध',
  'कैसे', 'कब', 'कहाँ', 'क्यों', 'कौन', 'कितना', 'बताओ', 'बताइये',
  'समझाओ', 'व्याख्या', 'मतलब', 'अर्थ', 'प्रावधान', 'नियम'
]);

// Marathi keywords (Devanagari)
const MARATHI_KEYWORDS = new Set([
  'काय', 'आहे', 'आहात', 'चा', 'चे', 'ची', 'मध्ये', 'कडून', 'ला', 'वर', 'आणि', 'किंवा',
  'कलम', 'अनुसूची', 'प्राणी', 'पक्षी', 'वन', 'वन्यजीव', 'संरक्षण',
  'कायदा', 'कानून', 'दंड', 'शिक्षा', 'दंड', 'शिकार', 'अवैध',
  'कसे', 'कधी', 'कुठे', 'का', 'कोण', 'किती', 'सांगा', 'स्पष्ट करा',
  'समजावून सांगा', 'अर्थ', 'प्रावधान', 'नियम'
]);

// Roman Hindi keywords (Hinglish) - very common patterns
const ROMAN_HINDI_KEYWORDS = new Set([
  'kya', 'hai', 'hain', 'ka', 'ke', 'ki', 'mein', 'se', 'ko', 'par', 'aur', 'ya',
  'dhara', 'anusuchi', 'janwar', 'pashu', 'pakshi', 'van', 'vanyajeev', 'sankrakshan',
  'adhinium', 'kanoon', 'dand', 'saza', 'jurmana', 'shikar', 'avaidh',
  'kaise', 'kab', 'kahan', 'kyun', 'kaun', 'kitna', 'batao', 'bataiye',
  'samjhao', 'vyakhya', 'matlab', 'arth', 'prawadhan', 'niyam',
  'section', 'schedule', 'wildlife', 'protection', 'act', 'penalty', 'punishment',
  'hunting', 'illegal', 'poaching', 'trade', 'forest', 'animal', 'bird'
]);

// Roman Marathi keywords
const ROMAN_MARATHI_KEYWORDS = new Set([
  'kay', 'ahe', 'ahet', 'cha', 'che', 'chi', 'madhye', 'kadun', 'la', 'var', 'ani', 'kinva',
  'kalam', 'anusuchi', 'prani', 'pakshi', 'van', 'vanyajeev', 'sankrakshan',
  'kayda', 'kanoon', 'dand', 'shikshan', 'shikar', 'avaidh',
  'kase', 'kadhi', 'kuthe', 'ka', 'kon', 'kiti', 'sanga', 'spasht kara',
  'samjavun sanga', 'arth', 'prawadhan', 'niyam',
  'section', 'schedule', 'wildlife', 'protection', 'act', 'penalty', 'punishment',
  'hunting', 'illegal', 'poaching', 'trade', 'forest', 'animal', 'bird'
]);

// English WLPA keywords
const ENGLISH_KEYWORDS = new Set([
  'what', 'is', 'are', 'the', 'of', 'in', 'to', 'for', 'and', 'or',
  'section', 'schedule', 'wildlife', 'protection', 'act', 'penalty', 'punishment',
  'hunting', 'illegal', 'poaching', 'trade', 'forest', 'animal', 'bird',
  'how', 'when', 'where', 'why', 'who', 'much', 'explain', 'tell', 'about',
  'provision', 'rule', 'law', 'offence', 'fine', 'imprisonment'
]);

// Hindi grammatical markers (common in Roman Hindi)
const HINDI_GRAMMAR_MARKERS = [
  /^(kya|kaise|kab|kahan|kyun|kaun)\s/i,
  /\s(ka|ke|ki|ko|mein|se|par|ne|ko)\s/i,
  /\s(hai|hain|tha|thi|the|hoga|hoge|hogi)\s*$/i,
  /\s(kar|karna|karne|kiya|kya|karo)\s/i
];

// Marathi grammatical markers
const MARATHI_GRAMMAR_MARKERS = [
  /^(kay|kase|kadhi|kuthe|ka|kon)\s/i,
  /\s(cha|che|chi|la|var|madhye|kadun)\s/i,
  /\s(ahe|ahet|hot|hote|honar|hona)\s*$/i,
  /\s(kar|karne|kela|karaycha)\s/i
];

// WLPA-specific terms that appear in Roman Hindi/Marathi queries
const WLPA_ROMAN_HINDI = new Set([
  'section 9', 'section 11', 'section 12', 'section 29', 'section 35',
  'section 39', 'section 40', 'section 42', 'section 44', 'section 48',
  'section 49', 'section 50', 'section 51', 'section 54', 'section 55',
  'schedule 1', 'schedule 2', 'schedule 3', 'schedule 4', 'schedule 5', 'schedule 6',
  'schedule i', 'schedule ii', 'schedule iii', 'schedule iv', 'schedule v', 'schedule vi',
  'wildlife protection act', 'wlpa', 'wild life protection act',
  'tiger', 'elephant', 'leopard', 'rhino', 'lion', 'blackbuck', 'chinkara',
  'peacock', 'peafowl', 'python', 'cobra', 'gharial', 'pangolin',
  'conservation reserve', 'community reserve', 'national park', 'sanctuary',
  'ntca', 'wccb', 'cites', 'ivory', 'shahtoosh', 'red sandalwood'
]);

const WLPA_ROMAN_MARATHI = new Set([
  'kalam 9', 'kalam 11', 'kalam 12', 'kalam 29', 'kalam 35',
  'kalam 39', 'kalam 40', 'kalam 42', 'kalam 44', 'kalam 48',
  'kalam 49', 'kalam 50', 'kalam 51', 'kalam 54', 'kalam 55',
  'anusuci 1', 'anusuci 2', 'anusuci 3', 'anusuci 4', 'anusuci 5', 'anusuci 6',
  'anusuci i', 'anusuci ii', 'anusuci iii', 'anusuci iv', 'anusuci v', 'anusuci vi',
  'vanyajeev sankrakshan kayda', 'wlpa',
  'vagh', 'hatti', 'bibtya', 'genda', 'sher', 'kalya hirna', 'chinkara',
  'mor', 'ajgar', 'nag', 'ghadial', 'khavyа manjаr',
  'sankrakshan arakshit kshetra', 'samuday arakshit kshetra', 'rashtriya udyan', 'abhyaranya',
  'ntca', 'wccb', 'cites', 'ivory', 'shahtoosh', 'rakt chandan'
]);

class LanguageDetectionService {
  constructor() {
    this.stats = { total: 0, byLanguage: {} };
  }

  /**
   * Main detection method.
   * @param {string} text - Input text
   * @returns {Promise<string>} ISO language code: 'en', 'hi', 'mr'
   */
  async detect(text) {
    if (!text || text.trim() === '') {
      return LANGUAGES.EN;
    }

    this.stats.total++;
    const normalized = text.trim().toLowerCase();
    const words = normalized.split(/\s+/).filter(w => w.length > 0);

    // 1. Script-based detection (highest confidence for Devanagari)
    const hasDevanagari = DEVANAGARI_REGEX.test(text);
    const hasLatin = LATIN_REGEX.test(text);

    if (hasDevanagari && !hasLatin) {
      // Pure Devanagari - use franc-min to distinguish Hindi vs Marathi
      return await this._detectDevanagariLanguage(text);
    }

    if (hasLatin && !hasDevanagari) {
      // Pure Latin script - could be English, Roman Hindi, or Roman Marathi
      return await this._detectLatinLanguage(normalized, words);
    }

    // Mixed script - analyze both
    return await this._detectMixedScript(text, normalized, words);
  }

  /**
   * Detect Hindi vs Marathi in Devanagari script.
   */
  async _detectDevanagariLanguage(text) {
    try {
      const { franc, francAll } = await loadFrancModule();
      const ranked = francAll(text) || [];
      for (const [code] of ranked) {
        if (code === 'hin') return LANGUAGES.HI;
        if (code === 'mar') return LANGUAGES.MR;
      }
      const code = franc(text);
      if (code === 'hin') return LANGUAGES.HI;
      if (code === 'mar') return LANGUAGES.MR;
    } catch (err) {
      logger.warn('franc-min detection failed', { error: err.message });
    }

    // Fallback: keyword counting
    const words = text.split(/\s+/);
    let hiScore = 0, mrScore = 0;

    for (const word of words) {
      if (HINDI_KEYWORDS.has(word)) hiScore++;
      if (MARATHI_KEYWORDS.has(word)) mrScore++;
    }

    if (hiScore > mrScore) return LANGUAGES.HI;
    if (mrScore > hiScore) return LANGUAGES.MR;

    // Default to Hindi for Devanagari if uncertain
    return LANGUAGES.HI;
  }

  /**
   * Detect language in Latin script (English, Roman Hindi, Roman Marathi).
   */
  async _detectLatinLanguage(normalized, words) {
    let enScore = 0, hiScore = 0, mrScore = 0;

    // Count keyword matches
    for (const word of words) {
      if (ENGLISH_KEYWORDS.has(word)) enScore += 2;
      if (ROMAN_HINDI_KEYWORDS.has(word)) hiScore += 3;
      if (ROMAN_MARATHI_KEYWORDS.has(word)) mrScore += 3;
    }

    // Check for WLPA-specific terms
    for (const term of WLPA_ROMAN_HINDI) {
      if (normalized.includes(term)) hiScore += 5;
    }
    for (const term of WLPA_ROMAN_MARATHI) {
      if (normalized.includes(term)) mrScore += 5;
    }

    // Grammar pattern matching
    for (const pattern of HINDI_GRAMMAR_MARKERS) {
      if (pattern.test(normalized)) hiScore += 2;
    }
    for (const pattern of MARATHI_GRAMMAR_MARKERS) {
      if (pattern.test(normalized)) mrScore += 2;
    }

    // Check for "section X" / "schedule X" patterns (common in all)
    if (/\bsection\s+\d+[a-z]?\b/i.test(normalized)) enScore += 1;
    if (/\bschedule\s+\d+\b/i.test(normalized)) enScore += 1;
    if (/\bkalam\s+\d+[a-z]?\b/i.test(normalized)) mrScore += 2;
    if (/\banusuci\s+\d+\b/i.test(normalized)) mrScore += 2;

    // Check for "dhara" / "kalam" (section in Hindi/Marathi)
    if (/\bdhara\s+\d+[a-z]?\b/i.test(normalized)) hiScore += 3;
    if (/\bkalam\s+\d+[a-z]?\b/i.test(normalized)) mrScore += 3;

    // Franc-min as tiebreaker for Latin text
    try {
      const { franc } = await loadFrancModule();
      const code = franc(normalized);
      if (code === 'eng') enScore += 2;
      else if (code === 'hin') hiScore += 2;
      else if (code === 'mar') mrScore += 2;
    } catch (e) {
      // Ignore
    }

    // Determine winner
    const scores = { en: enScore, hi: hiScore, mr: mrScore };
    const maxScore = Math.max(enScore, hiScore, mrScore);
    const winners = Object.entries(scores).filter(([, v]) => v === maxScore);

    if (winners.length === 1) {
      const lang = winners[0][0];
      return LANGUAGES[lang.toUpperCase()] || LANGUAGES.EN;
    }

    // Tie-breaking logic
    // If Hindi and Marathi tied, check for more specific markers
    if (hiScore === mrScore && hiScore > enScore) {
      // Check for distinct Marathi markers
      if (/\b(madhye|kadun|ahet|honar|spasht)\b/.test(normalized)) return LANGUAGES.MR;
      if (/\b(mein|hain|hoga|batao|samjhao)\b/.test(normalized)) return LANGUAGES.HI;
      return LANGUAGES.HI; // Default to Hindi
    }

    // If English tied with others, prefer the non-English if it has WLPA terms
    if (enScore === hiScore && enScore > mrScore) {
      return hiScore > 5 ? LANGUAGES.HI : LANGUAGES.EN;
    }
    if (enScore === mrScore && enScore > hiScore) {
      return mrScore > 5 ? LANGUAGES.MR : LANGUAGES.EN;
    }

    return LANGUAGES.EN;
  }

  /**
   * Detect language in mixed script text.
   */
  async _detectMixedScript(text, normalized, words) {
    // Count Devanagari vs Latin characters
    const devChars = (text.match(DEVANAGARI_REGEX) || []).length;
    const latChars = (text.match(LATIN_REGEX) || []).length;

    if (devChars > latChars * 2) {
      // Mostly Devanagari
      return await this._detectDevanagariLanguage(text);
    } else if (latChars > devChars * 2) {
      // Mostly Latin
      return await this._detectLatinLanguage(normalized, words);
    } else {
      // Truly mixed - analyze keywords in both scripts
      let hiScore = 0, mrScore = 0, enScore = 0;

      // Devanagari keywords
      const devWords = text.match(/[\u0900-\u097F]+/g) || [];
      for (const w of devWords) {
        if (HINDI_KEYWORDS.has(w)) hiScore += 3;
        if (MARATHI_KEYWORDS.has(w)) mrScore += 3;
      }

      // Latin keywords
      for (const w of words) {
        if (ENGLISH_KEYWORDS.has(w)) enScore += 1;
        if (ROMAN_HINDI_KEYWORDS.has(w)) hiScore += 2;
        if (ROMAN_MARATHI_KEYWORDS.has(w)) mrScore += 2;
      }

      if (hiScore > mrScore && hiScore > enScore) return LANGUAGES.HI;
      if (mrScore > hiScore && mrScore > enScore) return LANGUAGES.MR;
      return LANGUAGES.EN;
    }
  }

  /**
   * Resolve language with priority: command > stored > detection.
   * @param {Object} params - { command, text, storedLanguage }
   */
  async resolve({ command, text, storedLanguage }) {
    // 1. Explicit command
    if (command) {
      const cmdLang = this._resolveCommand(command);
      if (cmdLang) return cmdLang;
    }

    // 2. Stored preference (sticky)
    if (storedLanguage && SUPPORTED_LANGUAGES.includes(storedLanguage)) {
      return storedLanguage;
    }

    // 3. Auto-detection
    return this.detect(text);
  }

  _resolveCommand(command) {
    if (!command) return null;
    const normalized = command.toLowerCase().trim();
    if (normalized === '/english' || normalized === 'english') return LANGUAGES.EN;
    if (normalized === '/hindi' || normalized === 'hindi') return LANGUAGES.HI;
    if (normalized === '/marathi' || normalized === 'marathi') return LANGUAGES.MR;
    return null;
  }

  getStats() {
    return this.stats;
  }

  resetStats() {
    this.stats = { total: 0, byLanguage: {} };
  }
}

module.exports = new LanguageDetectionService();
