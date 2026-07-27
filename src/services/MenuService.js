/**
 * MenuService
 * -----------
 * Encapsulates the "menu dispatch" logic — given a button label or a
 * callback action, what synthetic question should we ask Gemini?
 *
 * Why this exists:
 *   - Keeps the bot orchestration layer thin (no giant if/else chains)
 *   - Centralizes the section/schedule shortcuts so adding a new
 *     shortcut is a one-line change here
 *   - Future RAG: when RAG replaces Gemini, this service stays
 *     identical — only the question string is consumed differently
 */

const logger = require('../utils/logger');

// Synthetic questions sent to Gemini (or V2 RAG) when a shortcut is tapped.
// These are intentionally short and specific so the model knows what to look up.
const SECTION_QUESTIONS = Object.freeze({
  '2':  'Explain Section 2 of the Wildlife (Protection) Act, 1972 — what does it define?',
  '9':  'Explain Section 9 of the Wildlife (Protection) Act, 1972 — the prohibition of hunting.',
  '11': 'Explain Section 11 of the Wildlife (Protection) Act, 1972 — when is hunting permitted?',
  '12': 'Explain Section 12 of the Wildlife (Protection) Act, 1972 — public hunting permits.',
  '17A': 'Explain Section 17A of the Wildlife (Protection) Act, 1972 — what does it cover?',
  '29': 'Explain Section 29 of the Wildlife (Protection) Act, 1972 — what does it cover?',
  '35': 'Explain Section 35 of the Wildlife (Protection) Act, 1972 — what does it cover?',
  '39': 'Explain Section 39 of the Wildlife (Protection) Act, 1972 — what does it cover?',
  '50': 'Explain Section 50 of the Wildlife (Protection) Act, 1972 — what does it cover?',
  '51': 'Explain Section 51 of the Wildlife (Protection) Act, 1972 — penalties under the Act.',
});

const SCHEDULE_QUESTIONS = Object.freeze({
  '1': 'Explain Schedule I of the Wildlife (Protection) Act, 1972 — what animals does it protect?',
  '2': 'Explain Schedule II of the Wildlife (Protection) Act, 1972 — what animals does it protect?',
  '3': 'Explain Schedule III of the Wildlife (Protection) Act, 1972 — what animals does it protect?',
  '4': 'Explain Schedule IV of the Wildlife (Protection) Act, 1972 — what animals does it protect?',
  '5': 'Explain Schedule V of the Wildlife (Protection) Act, 1972 — what animals does it protect?',
  '6': 'Explain Schedule VI of the Wildlife (Protection) Act, 1972 — what plants does it protect?',
});

class MenuService {
  /**
   * Build a synthetic question for a section shortcut.
   * Returns null if the section number is unknown.
   */
  buildSectionQuestion(sectionNumber) {
    if (!sectionNumber) return null;
    const key = String(sectionNumber).trim();
    return SECTION_QUESTIONS[key] || null;
  }

  /**
   * Build a synthetic question for a schedule shortcut.
   * Returns null if the schedule number is unknown.
   */
  buildScheduleQuestion(scheduleNumber) {
    if (!scheduleNumber) return null;
    const key = String(scheduleNumber).trim();
    return SCHEDULE_QUESTIONS[key] || null;
  }

  /**
   * Build a synthetic question for a protected-species shortcut.
   * Never returns null — generic fallback is fine because SearchService can
   * look up the species key itself (knowledge graph contains species entries).
   */
  buildSpeciesQuestion(speciesKey) {
    if (!speciesKey) return null;
    const clean = String(speciesKey).trim();
    if (!clean) return null;
    // Convert CamelCase → spaced for readability in the question.
    const spaced = clean.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return (
      `Tell me about the species "${spaced}" under the Wildlife (Protection) Act, 1972 — ` +
      `which schedule protects it, what are the hunting penalties, and key conservation notes.`
    );
  }

  /**
   * Parse a callback_data string like "cb:section:9" → returns "9"
   * Returns null if the format is unrecognized or doesn't match the prefix.
   *
   * Accepts both alphanumeric IDs (section 17A) and CamelCase species keys
   * like "AsianElephant" (which include underscores/dashes in some data files).
   */
  parseShortcutCallback(callbackData, prefix) {
    if (!callbackData || !prefix) return null;
    if (!callbackData.startsWith(prefix + ':')) return null;
    const rest = callbackData.slice(prefix.length + 1);
    if (!rest || rest.length === 0) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(rest)) return null;
    return rest;
  }

  /**
   * "More..." button handler — return a placeholder message.
   */
  moreSectionsMessage() {
    logger.debug('User tapped More... on sections shortcut');
    return '📚 More section shortcuts will be added soon.\n\n' +
           'In the meantime, tap *📖 Ask WLPA Question* and type any ' +
           'section number you want to know about.';
  }
}

module.exports = new MenuService();
