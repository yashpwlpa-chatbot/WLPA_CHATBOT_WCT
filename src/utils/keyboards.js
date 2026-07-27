/**
 * Keyboard builders.
 * ---------------
 * Centralizes ALL Telegram keyboard markup so telegramBot.js stays slim
 * and the layouts are easy to scan/edit in one place.
 *
 * Three kinds of keyboards:
 *   1. ReplyKeyboardMarkup      — persistent buttons replacing the user's keyboard
 *   2. InlineKeyboardMarkup     — buttons UNDER a specific message (callback-driven)
 *   3. InlineKeyboardMarkup     — pickers that replace other inline keyboards
 */

const { KEYBOARD_BUTTONS, INLINE_CALLBACKS } = require('./constants');
const SECTIONS_DATA = require('../data/sections.json');
const SPECIES_DATA = require('../data/species.json');

// How many numbered/named cards to show in a single inline picker grid.
const GRID_COLS = 4;
const GRID_ROWS = 5;
const PAGER_SIZE = GRID_COLS * GRID_ROWS; // 20

// ============================================================================
// REPLY KEYBOARDS (persistent menu at the bottom of the chat)
// ============================================================================

/**
 * Main menu — matches the screenshot layout exactly: 7 rows.
 * - Row 1: 📖 Ask WLPA Question         (full width)
 * - Row 2: 🎤 Voice Question            (full width)
 * - Row 3: 📚 Sections | 🐅 Protected Species
 * - Row 4: 📄 Download WLPA PDF         (full width)
 * - Row 5: 🌐 Change Language           (full width)
 * - Row 6: ❓ Help | ℹ️ About
 */
function buildMainKeyboard() {
  return {
    keyboard: [
      [{ text: KEYBOARD_BUTTONS.ASK_WLPA }],
      [{ text: KEYBOARD_BUTTONS.SECTIONS }, { text: KEYBOARD_BUTTONS.SPECIES }],
      [{ text: KEYBOARD_BUTTONS.DOWNLOAD_PDF }, { text: KEYBOARD_BUTTONS.CHANGE_LANGUAGE }],
      [{ text: KEYBOARD_BUTTONS.ABOUT }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: 'Type a WLPA question…',
  };
}

// ============================================================================
// INLINE KEYBOARDS (under a specific message)
// ============================================================================

/**
 * Feedback + actions after every AI answer — FEATURE 6.
 * 5 buttons: helpful, not_helpful, PDF, language, ask another.
 */
function buildFeedbackKeyboard(_language) {
  return {
    inline_keyboard: [
      [
        { text: '👍 Helpful', callback_data: INLINE_CALLBACKS.HELPFUL },
        { text: '👎 Not Helpful', callback_data: INLINE_CALLBACKS.NOT_HELPFUL },
      ],
      [
        { text: '📄 Read Official PDF', callback_data: INLINE_CALLBACKS.READ_PDF },
        { text: '🌐 Change Language', callback_data: INLINE_CALLBACKS.CHANGE_LANG },
      ],
      [{ text: '❓ Ask Another Question', callback_data: INLINE_CALLBACKS.ASK_ANOTHER }],
    ],
  };
}

/** Language picker shown when user taps "Change Language". */
function buildLanguageInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🇬🇧 English', callback_data: INLINE_CALLBACKS.LANG_EN }],
      [{ text: '🇮🇳 हिन्दी', callback_data: INLINE_CALLBACKS.LANG_HI }],
      [{ text: '🇲🇷 मराठी', callback_data: INLINE_CALLBACKS.LANG_MR }],
    ],
  };
}

/**
 * Build a PAGER_SIZE-wide (20) 4-col × 5-row inline grid from a list of entries.
 * Entries: [{label, callbackData}]
 */
function _buildCardGrid(entries) {
  const rows = [];
  const visible = entries.slice(0, PAGER_SIZE);
  for (let i = 0; i < visible.length; i += GRID_COLS) {
    rows.push(
      visible.slice(i, i + GRID_COLS).map(({ label, callbackData }) => ({
        text: label,
        callback_data: callbackData,
      }))
    );
  }
  return rows;
}

/**
 * Section shortcuts — FEATURE 3.
 * 20 numbered buttons arranged as a 4×5 grid + "More sections…" if we have
 * more than 20 sections in the JSON (we do: 41).
 */
function buildSectionsKeyboard(page = 0) {
  const all = Object.keys(SECTIONS_DATA.sections || SECTIONS_DATA || {})
    .map((k) => ({ number: k, _order: _sectionSortKey(k) }))
    .sort((a, b) => a._order - b._order)
    .map(({ number }) => number);

  const offset = page * PAGER_SIZE;
  const pageEntries = all.slice(offset, offset + PAGER_SIZE).map((number) => ({
    label: number,
    callbackData: `${INLINE_CALLBACKS.SECTION_PREFIX}:${number}`,
  }));

  const rows = _buildCardGrid(pageEntries);

  // Build pager row: « Prev | Page X/Y | Next »
  const totalPages = Math.max(1, Math.ceil(all.length / PAGER_SIZE));
  const curPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pagerRow = [];
  if (curPage > 0) {
    pagerRow.push({ text: '◀ Prev', callback_data: `${INLINE_CALLBACKS.SECTION_MORE}:${curPage - 1}` });
  }
  pagerRow.push({ text: `📚 Page ${curPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (curPage < totalPages - 1) {
    pagerRow.push({ text: 'Next ▶', callback_data: `${INLINE_CALLBACKS.SECTION_MORE}:${curPage + 1}` });
  }
  if (pagerRow.length > 0) rows.push(pagerRow);

  return { inline_keyboard: rows };
}

function _sectionSortKey(raw) {
  const m = String(raw).toUpperCase().match(/^(\d+)([A-Z])?$/);
  if (!m) return 999999;
  const num = parseInt(m[1], 10);
  const letter = m[2] ? m[2].charCodeAt(0) - 64 : 0; // A=1, B=2, ...
  return num * 100 + letter;
}

/**
 * Protected Species picker.
 * 20 cards arranged as 4×5 grid (species common names), paginated if >20.
 * Falls back to the Schedule I..VI picker if species.json is empty.
 */
function buildSpeciesKeyboard(page = 0) {
  const speciesMap = SPECIES_DATA.species || SPECIES_DATA || {};
  const allNames = Object.keys(speciesMap);

  // If no species data, fall back to schedules.
  if (!allNames.length) return buildSchedulesKeyboard();

  const offset = page * PAGER_SIZE;
  const pageEntries = allNames.slice(offset, offset + PAGER_SIZE).map((key) => {
    const entry = speciesMap[key];
    const common =
      (typeof entry === 'object' && (entry.commonName || entry.name || entry.common_name)) || key;
    return {
      label: _padLabel(String(common).replace(/\s+/g, ' ').slice(0, 18)),
      callbackData: `${INLINE_CALLBACKS.SPECIES_PREFIX}:${key}`,
    };
  });

  const rows = _buildCardGrid(pageEntries);

  const totalPages = Math.max(1, Math.ceil(allNames.length / PAGER_SIZE));
  const curPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pagerRow = [];
  if (curPage > 0) {
    pagerRow.push({ text: '◀ Prev', callback_data: `${INLINE_CALLBACKS.SPECIES_MORE}:${curPage - 1}` });
  }
  pagerRow.push({ text: `🐅 Page ${curPage + 1}/${totalPages}`, callback_data: 'noop' });
  if (curPage < totalPages - 1) {
    pagerRow.push({ text: 'Next ▶', callback_data: `${INLINE_CALLBACKS.SPECIES_MORE}:${curPage + 1}` });
  }
  if (pagerRow.length > 0) rows.push(pagerRow);

  return { inline_keyboard: rows };
}

/** Pad short labels so all 4-column buttons look uniform width in Telegram. */
function _padLabel(s) {
  const target = 14;
  if (s.length >= target) return s;
  // Surround with thin Unicode spaces for visual centering.
  const pad = target - s.length;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return '\u2004'.repeat(left) + s + '\u2004'.repeat(right);
}

/**
 * Schedule shortcuts — FEATURE 4 (fallback when no species cards available).
 */
function buildSchedulesKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Schedule I', callback_data: `${INLINE_CALLBACKS.SCHEDULE_PREFIX}:1` },
        { text: 'Schedule II', callback_data: `${INLINE_CALLBACKS.SCHEDULE_PREFIX}:2` },
      ],
      [
        { text: 'Schedule III', callback_data: `${INLINE_CALLBACKS.SCHEDULE_PREFIX}:3` },
        { text: 'Schedule IV', callback_data: `${INLINE_CALLBACKS.SCHEDULE_PREFIX}:4` },
      ],
      [
        { text: 'Schedule V', callback_data: `${INLINE_CALLBACKS.SCHEDULE_PREFIX}:5` },
        { text: 'Schedule VI', callback_data: `${INLINE_CALLBACKS.SCHEDULE_PREFIX}:6` },
      ],
    ],
  };
}

/**
 * PDF download chooser shown when the user taps "📄 Download WLPA PDF".
 * Asks: main PDF only? amendments? or main + all amendments?
 */
function buildPdfChoiceKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📄 WLPA Act PDF (Main only)', callback_data: INLINE_CALLBACKS.PDF_MAIN }],
      [{ text: '📜 All Amendment PDFs', callback_data: INLINE_CALLBACKS.PDF_AMENDMENTS_ALL }],
      [{ text: '📜 Choose Specific Amendment…', callback_data: INLINE_CALLBACKS.PDF_AMENDMENTS_MENU }],
      [{ text: '📥 WLPA Act + ALL Amendments', callback_data: INLINE_CALLBACKS.PDF_ALL }],
    ],
  };
}

/**
 * Amendment-year picker grid (for the "Choose Specific Amendment…" flow).
 * Uses PDF_AMENDMENT_PREFIX callbacks so the PDF-download flow in telegramBot
 * stays separate from the inline "amendment summary text" menu.
 */
function buildAmendmentsPickerKeyboard() {
  const years = ['2022', '2006', '2002', '1993', '1991', '1986', '1982'];
  const rows = [];
  for (let i = 0; i < years.length; i += 2) {
    const row = [];
    row.push({
      text: `📄 ${years[i]} Amendment`,
      callback_data: `${INLINE_CALLBACKS.PDF_AMENDMENT_PREFIX}:${years[i]}`,
    });
    if (i + 1 < years.length) {
      row.push({
        text: `📄 ${years[i + 1]} Amendment`,
        callback_data: `${INLINE_CALLBACKS.PDF_AMENDMENT_PREFIX}:${years[i + 1]}`,
      });
    }
    rows.push(row);
  }
  rows.push([
    { text: '⬅ Back to PDF options', callback_data: INLINE_CALLBACKS.PDF_MENU_BACK },
  ]);
  return { inline_keyboard: rows };
}

/**
 * Amendment shortcuts for Telegram.
 * Shows all amendment years with download buttons.
 */
function buildAmendmentsKeyboard() {
  const years = ['2022', '2006', '2002', '1993', '1991', '1986', '1982', '1972'];
  const rows = [];

  for (let i = 0; i < years.length; i += 2) {
    const row = [];
    row.push({
      text: `📄 ${years[i]} Amendment`,
      callback_data: `amend_pdf:${years[i]}`,
    });
    if (i + 1 < years.length) {
      row.push({
        text: `📄 ${years[i + 1]} Amendment`,
        callback_data: `amend_pdf:${years[i + 1]}`,
      });
    }
    rows.push(row);
  }

  rows.push([{ text: '📥 Download All Amendments', callback_data: 'amend_pdf:all' }]);

  return { inline_keyboard: rows };
}

/**
 * Amendment shortcuts for WhatsApp (list message format).
 * Returns list message sections for WhatsApp interactive list.
 */
function buildAmendmentsListSections() {
  const years = ['2022', '2006', '2002', '1993', '1991', '1986', '1982', '1972'];

  return [{
    title: '📜 WLPA Amendments',
    rows: years.map((year) => ({
      id: `amend_pdf:${year}`,
      title: `${year} Amendment`,
      description: year === '1972' ? 'Original Act' : `Amendment Act, ${year}`,
    })),
  }];
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  buildMainKeyboard,
  buildFeedbackKeyboard,
  buildLanguageInlineKeyboard,
  buildSectionsKeyboard,
  buildSpeciesKeyboard,
  buildSchedulesKeyboard,
  buildPdfChoiceKeyboard,
  buildAmendmentsPickerKeyboard,
  buildAmendmentsKeyboard,
  buildAmendmentsListSections,
};
