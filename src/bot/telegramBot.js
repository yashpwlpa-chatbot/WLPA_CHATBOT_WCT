/**
 * TelegramBot
 * -----------
 * The orchestration layer that:
 *   - Registers command & message handlers with the Telegram library.
 *   - Delegates ALL logic to services.
 *   - Persists every interaction via ChatService.
 *   - Integrates: SearchService, ConversationMemory, ScenarioUnderstanding,
 *     IncidentService, AmendmentService, enhanced GeminiService.
 *
 * Transport modes:
 *   - Polling (default for dev) → long-lived bot polls Telegram.
 *   - Webhook (set USE_WEBHOOK=true and WEBHOOK_URL) → Express route
 *     receives updates and forwards them through `processUpdate()`.
 *
 * Library compatibility:
 *   - node-telegram-bot-api v0.x → loaded with CommonJS `require()`.
 *   - node-telegram-bot-api v1.x → loaded with dynamic ESM `import()`
 *     (v1.x is ESM-only; we fall back automatically).
 *
 * Public API:
 *   - init()         → async, must be awaited at server startup.
 *   - getInstance()  → returns the constructed bot (throws if not init'd).
 *   - processUpdate()→ forwards a raw update to the bot (webhook mode).
 */

const config = require('../config');
const logger = require('../utils/logger');
const {
  ERROR_MESSAGES,
  MESSAGE_TYPES,
  LANGUAGE_NAMES,
  KEYBOARD_BUTTONS,
  INLINE_CALLBACKS,
  TEXT,
} = require('../utils/constants');

const keyboards = require('../utils/keyboards');
const messages = require('../utils/messages');
const TelegramService = require('../services/TelegramService');
const UserService = require('../services/UserService');
const ChatService = require('../services/ChatService');
const GeminiService = require('../services/GeminiService');
const VoiceService = require('../services/VoiceService');
const LanguageService = require('../services/LanguageService');
const MenuService = require('../services/MenuService');
const PDFService = require('../services/PDFService');
const SearchService = require('../services/SearchService');
const ScenarioUnderstandingService = require('../services/ScenarioUnderstandingService');
const IncidentService = require('../services/IncidentService');
const AmendmentService = require('../services/AmendmentService');

/**
 * Loads `node-telegram-bot-api` regardless of whether the installed version
 * is CommonJS (v0.x) or ESM-only (v1.x).
 */
async function loadTelegramBotCtor() {
  try {
    const mod = require('node-telegram-bot-api');
    return mod.default || mod;
  } catch (err) {
    const code = err && err.code;
    const msg = String(err && err.message || '');
    const isEsm =
      code === 'ERR_REQUIRE_ESM' ||
      code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ||
      /require\(\) of ES Module/i.test(msg) ||
      /exports.*main.*not defined/i.test(msg) ||
      /ESM/i.test(msg);
    if (isEsm) {
      const mod = await import('node-telegram-bot-api');
      return mod.default || mod;
    }
    throw err;
  }
}

// ----- Bot instance state (singleton) -----
let _bot = null;
let _initPromise = null;

// ----- Handler helpers (pure functions) -----

async function resolveLanguage(msg, text) {
  try {
    const existing = await UserService.findByTelegramId(msg.from.id);
    const user = await UserService.upsertFromTelegram(
      msg.from,
      existing?.preferredLanguage || 'en'
    );
    const hadPreference = !!existing?.preferredLanguage;
    // Priority: command > stored preference > detection (sticky once set).
    const language = await LanguageService.resolve({
      text,
      storedLanguage: user.preferredLanguage,
    });
    if (!hadPreference && language) {
      await UserService.updatePreferredLanguage(msg.from.id, language);
    }
    return language || user.preferredLanguage || 'en';
  } catch (err) {
    logger.warn('Language resolution failed; defaulting to en', { error: err.message });
    return 'en';
  }
}

function escapeHtml(text) {
  return (text || '').replace(/[&<>]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
  }[c]));
}

function formatTelegramAnswer(answer) {
  return escapeHtml(answer)
    .replace(/\r\n/g, '\n')
    .replace(/^---$/gm, '━━━━━━━━━━━━')
    .replace(/^\s*[-•]\s+/gm, '• ')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>');
}

async function handleStart(msg) {
  await handleHelp(msg);
}

async function handleHelp(msg) {
  const language = await resolveLanguage(msg, '');
  await TelegramService.sendMessage(
    msg.chat.id,
    messages.HELP_TEXT[language] || messages.HELP_TEXT.en,
    { reply_markup: keyboards.buildMainKeyboard() }
  );
}

async function handleVoiceGuide(msg) {
  const language = await resolveLanguage(msg, '');
  await TelegramService.sendMessage(
    msg.chat.id,
    messages.VOICE_GUIDE_TEXT[language] || messages.VOICE_GUIDE_TEXT.en
  );
}

async function handleLanguageMenu(msg) {
  await TelegramService.sendMessage(
    msg.chat.id,
    '🌐 *Change Language*\n\nChoose your preferred language:',
    { reply_markup: keyboards.buildLanguageInlineKeyboard() }
  );
}

async function handleAbout(msg) {
  const language = await resolveLanguage(msg, '');
  await TelegramService.sendMessage(
    msg.chat.id,
    messages.ABOUT_TEXT[language] || messages.ABOUT_TEXT.en,
    { reply_markup: keyboards.buildMainKeyboard() }
  );
}

async function showPdfChoiceMenu(chatId, language) {
  await TelegramService.sendMessage(
    chatId,
    messages.PDF_CHOICE_PROMPT[language] || messages.PDF_CHOICE_PROMPT.en,
    { reply_markup: keyboards.buildPdfChoiceKeyboard() }
  );
}

async function handleDownloadPDF(msg) {
  const language = await resolveLanguage(msg, '');
  await showPdfChoiceMenu(msg.chat.id, language);
}

async function handleSectionsMenu(msg) {
  await TelegramService.sendMessage(
    msg.chat.id,
    '📚 *Sections*\n\nTap a Section below to learn about it instantly:',
    { reply_markup: keyboards.buildSectionsKeyboard(0) }
  );
}

async function handleSpeciesMenu(msg) {
  await TelegramService.sendMessage(
    msg.chat.id,
    '🐅 *Protected Species*\n\nTap a species below to learn about it instantly:',
    { reply_markup: keyboards.buildSpeciesKeyboard(0) }
  );
}

async function handleAskPrompt(msg) {
  const language = await resolveLanguage(msg, '');
  const prompts = {
    en: '📖 Please type your question about the Wildlife (Protection) Act, 1972.\n\nFor example: "What is Section 9?" or "Explain hunting penalties."',
    hi: '📖 कृपया वन्यजीव (संरक्षण) अधिनियम, 1972 के बारे में अपना प्रश्न टाइप करें।\n\nउदाहरण: "धारा 9 क्या है?"',
    mr: '📖 कृपया वन्यजीव (संरक्षण) कायदा, 1972 बद्दल तुमचा प्रश्न टाइप करा.\n\nउदाहरण: "कलम ९ काय आहे?"',
  };
  await TelegramService.sendMessage(msg.chat.id, prompts[language] || prompts.en);
}

async function handleLanguageCommand(msg, lang) {
  const codeMap = { english: 'en', hindi: 'hi', marathi: 'mr' };
  const code = codeMap[lang];
  if (!code) return;

  try {
    await UserService.upsertFromTelegram(msg.from, code);
  } catch (err) {
    logger.warn('Language command upsert failed', { error: err.message });
  }

  const confirm = {
    en: '✅ Language set to English.',
    hi: '✅ भाषा हिन्दी में सेट की गई।',
    mr: '✅ भाषा मराठी वर सेट केली.',
  };
  await TelegramService.sendMessage(
    msg.chat.id,
    `${confirm[code]} (${LANGUAGE_NAMES[code]})`
  );
}

/**
 * Run a synthetic question (from a section/schedule shortcut) through
 * the exact same pipeline as a user-typed question.
 * Single source of truth — when V2 adds RAG, only GeminiService changes.
 */
async function processSyntheticQuestion(msg, question, language) {
  const chatId = msg.chat.id;
  await TelegramService.sendChatAction(chatId, 'typing');
  await TelegramService.sendMessage(
    chatId,
    messages.ACK_TEXT.text[language] || messages.ACK_TEXT.text.en
  );

  try {
    await ChatService.ensureConversationMemory(msg.from.id);
    const { answer, model } = await GeminiService.generateAnswer(question, language, {
      telegramId: msg.from.id
    });
    const user = await UserService.findByTelegramId(msg.from.id);
    await ChatService.save({
      userId: user?._id,
      telegramId: msg.from.id,
      messageType: MESSAGE_TYPES.TEXT,
      question,
      answer,
      language,
      aiModel: model,
    });
    await TelegramService.sendMessage(
      chatId,
      formatTelegramAnswer(answer || ERROR_MESSAGES.GENERIC),
      { reply_markup: keyboards.buildMainKeyboard() }
    );
  } catch (err) {
    logger.error('Synthetic-question flow failed', { error: err.message, code: err.code });
    await handleGeminiError(chatId, err, language);
  }
}

/**
 * FEATURE 8: friendly user-facing error messages by category — never
 * expose stack traces or internal API details.
 */
async function handleGeminiError(chatId, err, language = 'en') {
  const code = err.code || 'GEMINI_FAILED';
  const bag = messages.ERROR_MESSAGES[code];
  let msg;
  if (bag && typeof bag === 'object') {
    msg = bag[language] || bag.en;
  }
  if (!msg) {
    // Fallback: use the GENERIC message (always a string).
    msg = typeof messages.ERROR_MESSAGES.GENERIC === 'string'
      ? messages.ERROR_MESSAGES.GENERIC
      : (messages.ERROR_MESSAGES.GENERIC.en || 'Something went wrong.');
  }
  await TelegramService.sendMessage(chatId, msg);
}

async function handleText(msg) {
  const text = (msg.text || '').trim();
  if (!text) return;

  // Reply keyboard button presses — route to the matching handler.
  switch (text) {
    case KEYBOARD_BUTTONS.ASK_WLPA:        return handleAskPrompt(msg);
    case KEYBOARD_BUTTONS.SECTIONS:        return handleSectionsMenu(msg);
    case KEYBOARD_BUTTONS.SPECIES:         return handleSpeciesMenu(msg);
    case KEYBOARD_BUTTONS.DOWNLOAD_PDF:    return handleDownloadPDF(msg);
    case KEYBOARD_BUTTONS.AMENDMENTS:      return handleAmendmentsCommand(msg);
    case KEYBOARD_BUTTONS.CHANGE_LANGUAGE: return handleLanguageMenu(msg);
    case KEYBOARD_BUTTONS.ABOUT:           return handleAbout(msg);
  }

  if (text.startsWith('/')) {
    // Handle special commands
    if (text === '/incident' || text === '/incident@') {
      return handleIncidentCommand(msg);
    }
    if (text === '/amendments' || text === '/amendments@') {
      return handleAmendmentsCommand(msg);
    }
    if (text === '/scenario' || text === '/scenario@') {
      return handleScenarioCommand(msg);
    }
    return; // skip other slash commands
  }

  const chatId = msg.chat.id;
  const language = await resolveLanguage(msg, text);

  logger.info('incoming_message', {
    type: MESSAGE_TYPES.TEXT,
    telegramId: msg.from.id,
    chatId,
    length: text.length,
    language,
  });

  // Check if this is a scenario/real-life question
  const isScenario = ScenarioUnderstandingService._isScenarioQuestion ? 
    ScenarioUnderstandingService._isScenarioQuestion(text) : false;

  await TelegramService.sendChatAction(chatId, 'typing');
  await TelegramService.sendMessage(
    chatId,
    messages.ACK_TEXT.text[language] || messages.ACK_TEXT.text.en
  );

  try {
    await ChatService.ensureConversationMemory(msg.from.id);
    const { answer, model, source, confidence } = await GeminiService.generateAnswer(text, language, {
      telegramId: msg.from.id,
      scenarioText: isScenario ? text : undefined
    });

    const user = await UserService.findByTelegramId(msg.from.id);
    await ChatService.save({
      userId: user?._id,
      telegramId: msg.from.id,
      messageType: MESSAGE_TYPES.TEXT,
      question: text,
      answer,
      language,
      aiModel: model,
      metadata: { source, confidence },
    });

    await TelegramService.sendMessage(
      chatId,
      formatTelegramAnswer(answer || ERROR_MESSAGES.GENERIC),
      { reply_markup: keyboards.buildMainKeyboard() }
    );
  } catch (err) {
    logger.error('Text flow failed', { error: err.message, code: err.code });
    const user = await UserService.findByTelegramId(msg.from.id);
    await ChatService.save({
      userId: user?._id,
      telegramId: msg.from.id,
      messageType: MESSAGE_TYPES.TEXT,
      question: text,
      language,
      error: err.message,
    });
    await handleGeminiError(chatId, err, language);
  }
}

async function handleVoice(msg) {
  const chatId = msg.chat.id;
  const voice = msg.voice;

  logger.info('incoming_message', {
    type: MESSAGE_TYPES.VOICE,
    telegramId: msg.from.id,
    chatId,
    duration: voice?.duration,
    mimeType: voice?.mime_type,
  });

  if (!VoiceService.isAvailable()) {
    await TelegramService.sendMessage(chatId, ERROR_MESSAGES.VOICE_DISABLED);
    return;
  }

  const language = await resolveLanguage(msg, '');
  await TelegramService.sendChatAction(chatId, 'record_voice');
  await TelegramService.sendMessage(
    chatId,
    messages.ACK_TEXT.voiceTranscribing[language] || messages.ACK_TEXT.voiceTranscribing.en
  );

  try {
    // 1. Download voice bytes (kept in memory; no temp file needed).
    const buffer = await TelegramService.downloadFile(voice.file_id);

    // 2. Transcribe
    const transcription = await VoiceService.transcribe(buffer);
    if (!transcription) {
      await TelegramService.sendMessage(chatId, TEXT.TRANSCRIPTION_FAILED);
      return;
    }

    // 3. Use the SAME text pipeline from here on.
    const effectiveLanguage = await resolveLanguage(msg, transcription);
    await TelegramService.sendChatAction(chatId, 'typing');
    await TelegramService.sendMessage(
      chatId,
      messages.ACK_TEXT.voiceThinking[language] || messages.ACK_TEXT.voiceThinking.en
    );
    await ChatService.ensureConversationMemory(msg.from.id);
    const { answer, model } = await GeminiService.generateAnswer(
      transcription,
      effectiveLanguage,
      { telegramId: msg.from.id }
    );

    const user = await UserService.findByTelegramId(msg.from.id);
    await ChatService.save({
      userId: user?._id,
      telegramId: msg.from.id,
      messageType: MESSAGE_TYPES.VOICE,
      question: transcription,
      transcription,
      answer,
      language: effectiveLanguage,
      aiModel: model,
      metadata: { duration: voice.duration, mimeType: voice.mime_type },
    });

    const reply = `🗣 <i>${escapeHtml(transcription)}</i>\n\n${formatTelegramAnswer(answer)}`;
    await TelegramService.sendMessage(
      chatId,
      reply || ERROR_MESSAGES.GENERIC,
      { reply_markup: keyboards.buildMainKeyboard() }
    );
  } catch (err) {
    logger.error('Voice flow failed', { error: err.message, code: err.code });
    const user = await UserService.findByTelegramId(msg.from.id);
    await ChatService.save({
      userId: user?._id,
      telegramId: msg.from.id,
      messageType: MESSAGE_TYPES.VOICE,
      question: '[voice transcription failed]',
      language,
      error: err.message,
    });

    let msgText = TEXT.TRANSCRIPTION_FAILED;
    switch (err.code) {
      case 'NO_BACKEND':
      case 'WHISPER_NOT_CONFIGURED':
        msgText = ERROR_MESSAGES.VOICE_DISABLED;
        break;
      case 'EMPTY_AUDIO':
        msgText = TEXT.TRANSCRIPTION_FAILED;
        break;
      case 'FILE_TOO_LARGE':
        msgText = `The voice message is too large. Please send a shorter one.`;
        break;
      case 'WHISPER_AUTH':
      case 'LOCAL_TRANSCRIPTION_FAILED':
      case 'WHISPER_FAILED':
      default:
        msgText = TEXT.TRANSCRIPTION_FAILED;
        break;
    }
    await TelegramService.sendMessage(chatId, msgText);
  }
}

// ----- Incident Reporting Command -----

async function handleIncidentCommand(msg) {
  const chatId = msg.chat.id;
  const language = await resolveLanguage(msg, '');

  const result = IncidentService.startReport(msg.from.id, language);
  if (result.error) {
    await TelegramService.sendMessage(chatId, result.error);
    return;
  }

  await TelegramService.sendMessage(chatId, result.prompt, {
    reply_markup: { force_reply: true, selective: true }
  });
}

async function handleIncidentAnswer(msg) {
  const chatId = msg.chat.id;
  const report = IncidentService.getActiveReport(msg.from.id);

  if (!report) {
    // Not in incident reporting mode
    return false;
  }

  const result = IncidentService.processAnswer(msg.from.id, msg.text);
  if (result.error) {
    await TelegramService.sendMessage(chatId, `${result.error}\n\nPlease try again:`);
    return true;
  }

  if (result.isComplete) {
    await TelegramService.sendMessage(chatId, result.reportText, {
      parse_mode: 'HTML'
    });
    await TelegramService.sendMessage(chatId, 'Report completed. You can now forward this to the Forest Department.', {
      reply_markup: keyboards.buildMainKeyboard()
    });
  } else {
    await TelegramService.sendMessage(chatId, result.prompt, {
      reply_markup: { force_reply: true, selective: true }
    });
  }
  return true;
}

// ----- Amendments Command -----

async function handleAmendmentsCommand(msg) {
  const chatId = msg.chat.id;
  const language = await resolveLanguage(msg, '');

  const summary = AmendmentService.getAllAmendmentsSummary(language);
  await TelegramService.sendMessage(chatId, summary, {
    parse_mode: 'HTML',
    reply_markup: keyboards.buildMainKeyboard()
  });
}

// ----- Scenario Analysis Command -----

async function handleScenarioCommand(msg) {
  const chatId = msg.chat.id;
  const language = await resolveLanguage(msg, '');

  const prompts = {
    en: '🔍 **Scenario Analysis Mode**\n\nDescribe the situation in detail. For example:\n"In our village there are 10 peepal trees where 200 pairs of herons nest. Children disturb the nests. What should I do?"\n\nType your scenario:',
    hi: '🔍 **स्थिति विश्लेषण मोड**\n\nस्थिति का विस्तार से वर्णन करें। उदाहरण:\n"हमारे गाँव में 10 पीपल के पेड़ हैं जहाँ 200 जोड़ी बगुले घोंसला बनाते हैं। बच्चे घोंसलों को परेशान करते हैं। मुझे क्या करना चाहिए?"\n\nअपनी स्थिति लिखें:',
    mr: '🔍 **परिस्थिति विश्लेषण मोड**\n\nपरिस्थितीचा तपशीलवार वर्णन करा। उदाहरण:\n"आमच्या गावात १० पीपळीचे झाड आहेत जिथे २०० जोडी बगुले घोंसट बनवतात। मुलं घोंसटे छेडतात। मी काय करावे?"\n\nतुमची परिस्थिती लिहा:',
  };

  await TelegramService.sendMessage(chatId, prompts[language] || prompts.en, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, selective: true }
  });

  // Set a flag to indicate scenario mode (could use a more sophisticated approach)
  // For now, we'll handle scenario analysis in the regular text handler
}

// ----- Inline keyboard callback handler -----

async function handleCallbackQuery(query) {
  const data = query.data || '';
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const fromId = query.from?.id;

  if (!chatId || !messageId) {
    await TelegramService.answerCallbackQuery(query.id, 'Error');
    return;
  }

  const fakeMsg = {
    chat: { id: chatId },
    from: query.from,
    message_id: messageId,
  };

  const language = await resolveLanguage(fakeMsg, '');

  switch (data) {
    case INLINE_CALLBACKS.HELPFUL:
      await TelegramService.answerCallbackQuery(
        query.id,
        messages.FEEDBACK_THANKS[language] || messages.FEEDBACK_THANKS.en
      );
      logger.info('feedback_positive', { telegramId: fromId });
      return;

    case INLINE_CALLBACKS.NOT_HELPFUL:
      await TelegramService.answerCallbackQuery(
        query.id,
        messages.FEEDBACK_IMPROVE[language] || messages.FEEDBACK_IMPROVE.en
      );
      logger.info('feedback_negative', { telegramId: fromId });
      return;

    case INLINE_CALLBACKS.READ_PDF:
      await TelegramService.answerCallbackQuery(query.id, '📄');
      await showPdfChoiceMenu(chatId, language);
      return;

    case INLINE_CALLBACKS.PDF_MAIN:
      await TelegramService.answerCallbackQuery(query.id, '📄 Sending WLPA Act PDF…');
      await PDFService.sendMainPdf(chatId, language);
      return;

    case INLINE_CALLBACKS.PDF_AMENDMENTS_ALL:
      await TelegramService.answerCallbackQuery(query.id, '📜 Sending all amendments…');
      await PDFService.sendAllAmendmentPdfs(chatId, language);
      return;

    case INLINE_CALLBACKS.PDF_ALL:
      await TelegramService.answerCallbackQuery(query.id, '📥 Sending all PDFs…');
      await PDFService.sendMainAndAllAmendments(chatId, language);
      return;

    case INLINE_CALLBACKS.PDF_AMENDMENTS_MENU:
      await TelegramService.answerCallbackQuery(query.id, '📜');
      {
        const pickerText =
          messages.PDF_AMENDMENTS_PICKER_PROMPT[language] || messages.PDF_AMENDMENTS_PICKER_PROMPT.en;
        const edited = await TelegramService.editMessageText(
          chatId,
          messageId,
          pickerText,
          { reply_markup: keyboards.buildAmendmentsPickerKeyboard() }
        );
        if (!edited) {
          await TelegramService.sendMessage(chatId, pickerText, {
            reply_markup: keyboards.buildAmendmentsPickerKeyboard(),
          });
        }
      }
      return;

    case INLINE_CALLBACKS.PDF_MENU_BACK:
      await TelegramService.answerCallbackQuery(query.id, '⬅');
      {
        const choiceText = messages.PDF_CHOICE_PROMPT[language] || messages.PDF_CHOICE_PROMPT.en;
        const edited = await TelegramService.editMessageText(
          chatId,
          messageId,
          choiceText,
          { reply_markup: keyboards.buildPdfChoiceKeyboard() }
        );
        if (!edited) {
          await showPdfChoiceMenu(chatId, language);
        }
      }
      return;

    case INLINE_CALLBACKS.CHANGE_LANG:
      await TelegramService.editMessageReplyMarkup(
        chatId, messageId, keyboards.buildLanguageInlineKeyboard()
      );
      await TelegramService.answerCallbackQuery(query.id, '🌐');
      return;

    case INLINE_CALLBACKS.ASK_ANOTHER:
      await TelegramService.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
      await TelegramService.sendMessage(
        chatId,
        messages.ASK_ANOTHER_TEXT[language] || messages.ASK_ANOTHER_TEXT.en
      );
      await TelegramService.answerCallbackQuery(query.id, '');
      return;

    case INLINE_CALLBACKS.LANG_EN:
      await handleLanguageCommand(fakeMsg, 'english');
      await TelegramService.editMessageReplyMarkup(
        chatId, messageId, { inline_keyboard: [] }
      );
      await TelegramService.answerCallbackQuery(
        query.id, messages.LANG_CHANGED_INLINE[language] || messages.LANG_CHANGED_INLINE.en
      );
      return;

    case INLINE_CALLBACKS.LANG_HI:
      await handleLanguageCommand(fakeMsg, 'hindi');
      await TelegramService.editMessageReplyMarkup(
        chatId, messageId, { inline_keyboard: [] }
      );
      await TelegramService.answerCallbackQuery(
        query.id, messages.LANG_CHANGED_INLINE[language] || messages.LANG_CHANGED_INLINE.en
      );
      return;

    case INLINE_CALLBACKS.LANG_MR:
      await handleLanguageCommand(fakeMsg, 'marathi');
      await TelegramService.editMessageReplyMarkup(
        chatId, messageId, { inline_keyboard: [] }
      );
      await TelegramService.answerCallbackQuery(
        query.id, messages.LANG_CHANGED_INLINE[language] || messages.LANG_CHANGED_INLINE.en
      );
      return;
  }

  // Silent indicator buttons (page X/Y labels) don't need action.
  if (data === 'noop') {
    try { await TelegramService.answerCallbackQuery(query.id, ''); } catch (_) {}
    return;
  }

  // Pager callbacks: "cb:section:more:<page>"  and "cb:species:more:<page>"
  // → edit the inline reply markup to show a new page.
  if (typeof data === 'string' && data.startsWith(`${INLINE_CALLBACKS.SECTION_MORE}:`)) {
    const page = parseInt(data.slice(INLINE_CALLBACKS.SECTION_MORE.length + 1), 10);
    await TelegramService.answerCallbackQuery(query.id, '📚');
    try {
      await TelegramService.editMessageReplyMarkup(
        chatId, messageId, keyboards.buildSectionsKeyboard(Number.isFinite(page) ? page : 0)
      );
    } catch (_) { /* message too old to edit → ignore */ }
    return;
  }
  if (typeof data === 'string' && data.startsWith(`${INLINE_CALLBACKS.SPECIES_MORE}:`)) {
    const page = parseInt(data.slice(INLINE_CALLBACKS.SPECIES_MORE.length + 1), 10);
    await TelegramService.answerCallbackQuery(query.id, '🐅');
    try {
      await TelegramService.editMessageReplyMarkup(
        chatId, messageId, keyboards.buildSpeciesKeyboard(Number.isFinite(page) ? page : 0)
      );
    } catch (_) { /* message too old to edit → ignore */ }
    return;
  }

  // Generic shortcut prefix handlers (section | schedule | species)
  const sectionId = MenuService.parseShortcutCallback(data, INLINE_CALLBACKS.SECTION_PREFIX);
  if (sectionId) {
    const explicit = MenuService.buildSectionQuestion(sectionId);
    const question = explicit ||
      `Explain Section ${sectionId} of the Wildlife (Protection) Act, 1972 — what does it cover, penalties, and key rules?`;
    await TelegramService.answerCallbackQuery(query.id, `📖 Section ${sectionId}`);
    await processSyntheticQuestion(fakeMsg, question, language);
    return;
  }
  const scheduleId = MenuService.parseShortcutCallback(data, INLINE_CALLBACKS.SCHEDULE_PREFIX);
  if (scheduleId) {
    const question = MenuService.buildScheduleQuestion(scheduleId) ||
      `Explain Schedule ${scheduleId} of the Wildlife (Protection) Act, 1972 — what species or plants it lists and the protection level.`;
    const roman = ['I', 'II', 'III', 'IV', 'V', 'VI'][parseInt(scheduleId, 10) - 1] || scheduleId;
    await TelegramService.answerCallbackQuery(query.id, '🐅 Schedule ' + roman);
    await processSyntheticQuestion(fakeMsg, question, language);
    return;
  }
  const speciesKey = MenuService.parseShortcutCallback(data, INLINE_CALLBACKS.SPECIES_PREFIX);
  if (speciesKey) {
    const question = MenuService.buildSpeciesQuestion(speciesKey);
    const display = speciesKey.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    await TelegramService.answerCallbackQuery(query.id, '🐅 ' + display);
    if (question) {
      await processSyntheticQuestion(fakeMsg, question, language);
    } else {
      try { await TelegramService.answerCallbackQuery(query.id, 'Unknown species'); } catch (_) {}
    }
    return;
  }

  // PDF download flow: cb:pdf_amend:<year>
  if (typeof data === 'string' && data.startsWith(`${INLINE_CALLBACKS.PDF_AMENDMENT_PREFIX}:`)) {
    const year = data.slice(INLINE_CALLBACKS.PDF_AMENDMENT_PREFIX.length + 1);
    await TelegramService.answerCallbackQuery(query.id, `📄 ${year} Amendment`);
    await PDFService.sendAmendmentPdf(chatId, year, language);
    return;
  }

  // Amendment PDF download handler (legacy amend_pdf: callbacks from /amendments menu)
  if (data.startsWith('amend_pdf:')) {
    const year = data.replace('amend_pdf:', '');
    await TelegramService.answerCallbackQuery(query.id, '📄 ' + (year === 'all' ? 'All Amendments' : year + ' Amendment'));
    
    if (year === 'all') {
      // Send all amendment PDFs
      const years = ['2022', '2006', '2002', '1993', '1991', '1986', '1982', '1972'];
      for (const y of years) {
        await PDFService.sendAmendmentPdf(chatId, y, language);
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } else {
      await PDFService.sendAmendmentPdf(chatId, year, language);
    }
    return;
  }

  if (data) {
    logger.warn('Unhandled callback_data', { data, telegramId: fromId });
    try { await TelegramService.answerCallbackQuery(query.id, 'Unknown action'); } catch (_) {}
  }
}

// ----- Public API -----

async function init() {
  if (_bot) return _bot;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const TelegramBot = await loadTelegramBotCtor();

    const opts = config.telegram.useWebhook ? { webHook: false } : { polling: true };
    _bot = new TelegramBot(config.telegram.token, opts);

    _registerHandlers(_bot);

    // Initialize all new services
    await SearchService.initialize();
    await ScenarioUnderstandingService.initialize();
    await AmendmentService.initialize();
    await IncidentService.initialize();

    logger.info('Telegram bot initialized', {
      mode: config.telegram.useWebhook ? 'webhook' : 'polling',
    });
    return _bot;
  })();

  return _initPromise;
}

function _registerHandlers(bot) {
  bot.onText(/^\/start$/, handleStart);
  bot.onText(/^\/help$/, handleHelp);
  bot.onText(/^\/(english|hindi|marathi)$/i, (msg, match) =>
    handleLanguageCommand(msg, match[1].toLowerCase())
  );
  bot.onText(/^\/incident$/i, handleIncidentCommand);
  bot.onText(/^\/amendments$/i, handleAmendmentsCommand);
  bot.onText(/^\/scenario$/i, handleScenarioCommand);

  bot.on('voice', handleVoice);
  bot.on('text', async (msg) => {
    // Check if user is in incident reporting mode
    const activeReport = IncidentService.getActiveReport(msg.from.id);
    if (activeReport && activeReport.status === 'in_progress') {
      await handleIncidentAnswer(msg);
      return;
    }
    await handleText(msg);
  });

  bot.on('message', (msg) => {
    if (!msg.text && !msg.voice) {
      logger.debug('Unsupported message type ignored', { chatId: msg.chat.id });
    }
  });

  bot.on('polling_error', (err) => {
    const cause = err && err.cause;
    logger.error('Telegram polling_error', {
      message: err.message,
      code: err.code,
      causeCode: cause && (cause.code || cause.errno),
      causeMessage: cause && cause.message,
    });
  });
  bot.on('webhook_error', (err) =>
    logger.error('Telegram webhook_error', { error: err.message })
  );

  bot.on('callback_query', handleCallbackQuery);
}

function getInstance() {
  if (!_bot) {
    throw new Error('Telegram bot not initialized. Call init() first.');
  }
  return _bot;
}

function processUpdate(update) {
  if (!_bot) {
    logger.warn('processUpdate called before init - dropping update');
    return;
  }
  try {
    _bot.processUpdate(update);
  } catch (err) {
    logger.error('processUpdate failed', { error: err.message });
  }
}

module.exports = { init, getInstance, processUpdate };
