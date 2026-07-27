/**
 * Application-wide constants.
 * Keeping magic strings here avoids typos and makes audits easier.
 */

const LANGUAGES = Object.freeze({
  EN: 'en',
  HI: 'hi',
  MR: 'mr',
});

const SUPPORTED_LANGUAGES = Object.freeze([LANGUAGES.EN, LANGUAGES.HI, LANGUAGES.MR]);

const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  hi: 'हिन्दी',
  mr: 'मराठी',
});

const MESSAGE_TYPES = Object.freeze({
  TEXT: 'text',
  VOICE: 'voice',
});

const ERROR_MESSAGES = Object.freeze({
  GENERIC:
    "I'm having trouble responding right now. Please try again in a moment. " +
    'If this keeps happening, contact an administrator.',
  TRANSCRIPTION_FAILED:
    "Sorry, I couldn't transcribe your voice message. Please try again with a clearer " +
    'recording, or send your question as text.',
  VOICE_DISABLED:
    'Voice messages are not configured on this server yet. ' +
    'Please type your question instead.',
  RATE_LIMIT:
    'You are sending messages too quickly. Please wait a few seconds and try again.',
});

// Telegram UI button labels (shown on the persistent reply keyboard).
// Labels and emojis match the production screenshot layout exactly.
const KEYBOARD_BUTTONS = Object.freeze({
  ASK_WLPA: '📖 Ask WLPA Question',
  SECTIONS: '📚 Sections',
  SPECIES: '🐅 Protected Species',
  DOWNLOAD_PDF: '📄 Download WLPA PDF',
  AMENDMENTS: '📜 Amendments',
  CHANGE_LANGUAGE: '🌐 Change Language',
  ABOUT: 'ℹ️ About',
});

// Callback data identifiers for inline keyboards.
// Format convention: "cb:<kind>:<id>"
const INLINE_CALLBACKS = Object.freeze({
  HELPFUL: 'cb:fb:helpful',
  NOT_HELPFUL: 'cb:fb:not_helpful',
  READ_PDF: 'cb:fb:pdf',
  CHANGE_LANG: 'cb:fb:lang',
  ASK_ANOTHER: 'cb:fb:another',

  LANG_EN: 'cb:lang:en',
  LANG_HI: 'cb:lang:hi',
  LANG_MR: 'cb:lang:mr',

  SECTION_PREFIX: 'cb:section',
  SECTION_MORE: 'cb:section:more',

  SCHEDULE_PREFIX: 'cb:schedule',

  SPECIES_PREFIX: 'cb:species',
  SPECIES_MORE: 'cb:species:more',

  // PDF download choice flow
  PDF_MAIN: 'cb:pdf:main',                   // WLPA Act PDF only
  PDF_AMENDMENTS_ALL: 'cb:pdf:amendments_all', // All amendment PDFs only
  PDF_AMENDMENTS_MENU: 'cb:pdf:amendments',  // Open amendment picker
  PDF_ALL: 'cb:pdf:all',                     // WLPA Act + all amendments
  PDF_AMENDMENT_PREFIX: 'cb:pdf_amend',      // cb:pdf_amend:<year>
  PDF_MENU_BACK: 'cb:pdf_menu:back',         // Back to PDF choice menu

  // Amendment PDF download callbacks
  AMENDMENT_PREFIX: 'amend_pdf',
  AMENDMENT_ALL: 'amend_pdf:all',
});

// Free-form text snippets that don't need a full messages.js entry.
const TEXT = Object.freeze({
  TRANSCRIPTION_FAILED: "Sorry, I couldn't understand your voice message.",
  FEEDBACK_THANKS: '🙏 Thanks for your feedback!',
  LANG_CHANGED_INLINE: '✅ Language updated.',
});

module.exports = {
  LANGUAGES,
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
  MESSAGE_TYPES,
  ERROR_MESSAGES,
  KEYBOARD_BUTTONS,
  INLINE_CALLBACKS,
  TEXT,
};
