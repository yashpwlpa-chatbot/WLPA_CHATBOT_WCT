/**
 * WhatsAppController
 * ------------------
 * Handles incoming WhatsApp messages and manages conversation flows.
 * Reuses existing services: GeminiService, SearchService, ConversationMemoryService,
 * ScenarioUnderstandingService, AmendmentService, IncidentService, LanguageDetectionService
 */


const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const WhatsAppService = require('../services/WhatsAppService');

const GRAPH_API_VERSION = 'v20.0'; // Update as needed
const UserService = require('../services/UserService');
const ChatService = require('../services/ChatService');
const GeminiService = require('../services/GeminiService');
const VoiceService = require('../services/VoiceService');
const LanguageService = require('../services/LanguageService');
const SearchService = require('../services/SearchService');
const ConversationMemoryService = require('../services/ConversationMemoryService');
const ScenarioUnderstandingService = require('../services/ScenarioUnderstandingService');
const AmendmentService = require('../services/AmendmentService');
const IncidentService = require('../services/IncidentService');
const LanguageDetectionService = require('../services/LanguageDetectionService');

const { MESSAGE_TYPES } = require('../utils/constants');

// In-memory session store (in production, use Redis or MongoDB)
const userSessions = new Map(); // phoneNumber -> session object
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

// In-memory dedupe cache — message IDs we've already processed within TTL.
// Meta may retry webhook delivery up to 3x if HTTP 200 is slow or not returned.
const PROCESSED_MESSAGE_IDS = new Map(); // messageId -> processedAt (ms)
const DEDUPE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function _dedupePurge() {
  const now = Date.now();
  for (const [mid, ts] of PROCESSED_MESSAGE_IDS) {
    if (now - ts > DEDUPE_TTL_MS) PROCESSED_MESSAGE_IDS.delete(mid);
  }
}
setInterval(_dedupePurge, 5 * 60 * 1000).unref();

function _isMessageAlreadyProcessed(messageId) {
  if (!messageId) return false;
  return PROCESSED_MESSAGE_IDS.has(messageId);
}
function _markMessageProcessed(messageId) {
  if (!messageId) return;
  PROCESSED_MESSAGE_IDS.set(messageId, Date.now());
}

/**
 * Get or create user session
 */
function getSession(phoneNumber) {
  if (!userSessions.has(phoneNumber)) {
    userSessions.set(phoneNumber, {
      state: 'main_menu',
      language: 'en',
      data: {},
      updatedAt: Date.now(),
    });
  }
  const session = userSessions.get(phoneNumber);
  session.updatedAt = Date.now();
  return session;
}

/**
 * Update session state
 */
function updateSession(phoneNumber, updates) {
  const session = getSession(phoneNumber);
  Object.assign(session, updates);
  session.updatedAt = Date.now();
  return session;
}

/**
 * Clear session
 */
function clearSession(phoneNumber) {
  userSessions.delete(phoneNumber);
}

/**
 * Clean up expired sessions
 */
function cleanupSessions() {
  const now = Date.now();
  for (const [phone, session] of userSessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL) {
      userSessions.delete(phone);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupSessions, 5 * 60 * 1000);

/**
 * Resolve language for WhatsApp user
 */
async function resolveLanguage(phoneNumber, text) {
  const session = getSession(phoneNumber);

  // 1. Explicit language command
  const cmdLang = LanguageDetectionService._resolveCommand(text);
  if (cmdLang) {
    session.language = cmdLang;
    return cmdLang;
  }

  // 2. Stored preference
  if (session.language) {
    return session.language;
  }

  // 3. Auto-detect
  const detected = await LanguageDetectionService.detect(text);
  session.language = detected;
  return detected;
}

/**
 * Send main menu
 */
async function sendMainMenu(phoneNumber, language = 'en') {
  const menu = WhatsAppService.buildMainMenu(language);
  await WhatsAppService.sendListMessage(
    phoneNumber,
    menu.body,
    menu.buttonText,
    menu.sections,
    { footer: menu.footer }
  );
}

/**
 * Send language selection
 */
async function sendLanguageSelection(phoneNumber) {
  const langMenu = WhatsAppService.buildLanguageButtons();
  await WhatsAppService.sendReplyButtons(
    phoneNumber,
    langMenu.body,
    langMenu.buttons
  );
}

/**
 * Handle main menu selection
 */
async function handleMenuSelection(phoneNumber, selectionId, language) {
  const session = getSession(phoneNumber);

  switch (selectionId) {
    case 'menu_sections':
      await sendSectionsList(phoneNumber, language);
      session.state = 'sections_list';
      break;

    case 'menu_species':
      await sendSpeciesList(phoneNumber, language);
      session.state = 'species_list';
      break;

    case 'menu_schedules':
      await sendSchedulesList(phoneNumber, language);
      session.state = 'schedules_list';
      break;

    case 'menu_penalties':
      await sendPenaltiesReference(phoneNumber, language);
      session.state = 'penalties_ref';
      break;

    case 'menu_incident':
      await startIncidentReport(phoneNumber, language);
      break;

    case 'menu_amendments':
      await sendAmendmentsSummary(phoneNumber, language);
      session.state = 'amendments';
      break;

    case 'menu_ask':
      await promptForQuestion(phoneNumber, language);
      session.state = 'awaiting_question';
      break;

    case 'menu_language':
      await sendLanguageSelection(phoneNumber);
      session.state = 'language_selection';
      break;

    case 'menu_help':
      await sendHelp(phoneNumber, language);
      session.state = 'main_menu';
      break;

    case 'menu_support':
      await sendSupport(phoneNumber, language);
      session.state = 'main_menu';
      break;

    case 'menu_main':
      await sendMainMenu(phoneNumber, language);
      session.state = 'main_menu';
      break;

    default:
      await sendMainMenu(phoneNumber, language);
      session.state = 'main_menu';
  }
}

/**
 * Send sections list
 */
async function sendSectionsList(phoneNumber, language) {
  const sections = WhatsAppService.buildSectionsList(language);
  await WhatsAppService.sendListMessage(
    phoneNumber,
    `📚 *${sections.title}*\n\nSelect a section to learn more:`,
    'Sections',
    [{ title: 'Sections', rows: sections.rows }],
    { footer: 'Tap a section for details' }
  );
}

/**
 * Send species list (using list message with categories)
 */
async function sendSpeciesList(phoneNumber, language) {
  // Group species by category for list message
  const speciesData = {
    en: {
      title: '🐅 Protected Species',
      sections: [
        {
          title: 'Schedule I - Highest Protection',
          rows: [
            { id: 'sp_tiger', title: 'Tiger', description: 'Panthera tigris - Endangered' },
            { id: 'sp_elephant', title: 'Asian Elephant', description: 'Elephas maximus - Endangered' },
            { id: 'sp_rhino', title: 'Indian Rhino', description: 'Rhinoceros unicornis - Vulnerable' },
            { id: 'sp_leopard', title: 'Leopard', description: 'Panthera pardus - Vulnerable' },
            { id: 'sp_lion', title: 'Asiatic Lion', description: 'Panthera leo persica - Endangered' },
            { id: 'sp_gib', title: 'Great Indian Bustard', description: 'Ardeotis nigriceps - Critically Endangered' },
            { id: 'sp_gharial', title: 'Gharial', description: 'Gavialis gangeticus - Critically Endangered' },
            { id: 'sp_pangolin', title: 'Indian Pangolin', description: 'Manis crassicaudata - Endangered' },
            { id: 'sp_redpanda', title: 'Red Panda', description: 'Ailurus fulgens - Endangered' },
            { id: 'sp_dolphin', title: 'Gangetic Dolphin', description: 'Platanista gangetica - Endangered' },
          ],
        },
        {
          title: 'Schedule II - High Protection',
          rows: [
            { id: 'sp_peafowl', title: 'Indian Peafowl', description: 'Pavo cristatus - National Bird' },
            { id: 'sp_python', title: 'Indian Python', description: 'Python molurus - Near Threatened' },
            { id: 'sp_kingcobra', title: 'King Cobra', description: 'Ophiophagus hannah - Vulnerable' },
          ],
        },
      ],
    },
    hi: {
        title: '🐅 संरक्षित प्रजातियाँ',
        sections: [
          {
            title: 'अनुसूची I - उच्चतम संरक्षण',
            rows: [
              { id: 'sp_tiger', title: 'बाघ', description: 'पैंथेरा टाइग्रिस - संकटग्रस्त' },
              { id: 'sp_elephant', title: 'हाथी', description: 'एलिफस मैक्सिमस - संकटग्रस्त' },
              { id: 'sp_rhino', title: 'गैंडा', description: 'राइनोसेरोस यूनिकॉर्निस - संवेदनशील' },
              { id: 'sp_leopard', title: 'तेंदुआ', description: 'पैंथेरा पार्डस - संवेदनशील' },
              { id: 'sp_lion', title: 'शेर', description: 'पैंथेरा लियो पर्सिका - संकटग्रस्त' },
              { id: 'sp_gib', title: 'सोन चिड़िया', description: 'आर्डेओटिस नाइग्रिसेप्स - गंभीर रूप से संकटग्रस्त' },
              { id: 'sp_gharial', title: 'घड़ियाल', description: 'गावियालिस गैंगेटिकस - गंभीर रूप से संकटग्रस्त' },
              { id: 'sp_pangolin', title: 'पैंगोलिन', description: 'मानिस क्रैसिकॉडेटा - संकटग्रस्त' },
              { id: 'sp_redpanda', title: 'रेड पांडा', description: 'आइलुरस फुलगेन्स - संकटग्रस्त' },
              { id: 'sp_dolphin', title: 'गंगा डॉल्फिन', description: 'प्लैनिस्टा गैंगेटिका - संकटग्रस्त' },
            ],
          },
          {
            title: 'अनुसूची II - उच्च संरक्षण',
            rows: [
              { id: 'sp_peafowl', title: 'मोर', description: 'पावो क्रिस्टेटस - राष्ट्रीय पक्षी' },
              { id: 'sp_python', title: 'अजगर', description: 'पाइथन मोलुरस - संकट के निकट' },
              { id: 'sp_kingcobra', title: 'किंग कोबरा', description: 'ओफियोफैगस हन्नाह - संवेदनशील' },
            ],
          },
        ],
    },
    mr: {
        title: '🐅 संरक्षित प्रजाती',
        sections: [
          {
            title: 'अनुसूची I - सर्वोच्च संरक्षण',
            rows: [
              { id: 'sp_tiger', title: 'वाघ', description: 'पैंथेरा टाइग्रिस - संकटग्रस्त' },
              { id: 'sp_elephant', title: 'हत्ती', description: 'एलिफस मैक्सिमस - संकटग्रस्त' },
              { id: 'sp_rhino', title: 'गेंडा', description: 'राइनोसेरोस यूनिकॉर्निस - संवेदनशील' },
              { id: 'sp_leopard', title: 'बिबट्या', description: 'पैंथेरा पार्डस - संवेदनशील' },
              { id: 'sp_lion', title: 'शेर', description: 'पैंथेरा लियो पर्सिका - संकटग्रस्त' },
              { id: 'sp_gib', title: 'माळ पक्षी', description: 'आर्डेओटिस नाइग्रिसेप्स - गंभीर संकटग्रस्त' },
              { id: 'sp_gharial', title: 'घड्याळ', description: 'गावियालिस गैंगेटिकस - गंभीर संकटग्रस्त' },
              { id: 'sp_pangolin', title: 'खवले मांजर', description: 'मानिस क्रैसिकॉडेटा - संकटग्रस्त' },
              { id: 'sp_redpanda', title: 'रेड पांडा', description: 'आइलुरस फुलगेन्स - संकटग्रस्त' },
              { id: 'sp_dolphin', title: 'गंगा डॉल्फिन', description: 'प्लैनिस्टा गैंगेटिका - संकटग्रस्त' },
            ],
          },
          {
            title: 'अनुसूची II - उच्च संरक्षण',
            rows: [
              { id: 'sp_peafowl', title: 'मोर', description: 'पावो क्रिस्टेटस - राष्ट्रीय पक्षी' },
              { id: 'sp_python', title: 'अजगर', description: 'पाइथन मोलुरस - संकटात' },
              { id: 'sp_kingcobra', title: 'राजा नाग', description: 'ओफियोफैगस हन्नाह - संवेदनशील' },
            ],
          },
        ],
      },
    };

    const data = speciesData[language] || speciesData.en;
    await WhatsAppService.sendListMessage(
      phoneNumber,
      `🐅 *${data.title}*\n\nSelect a species for details:`,
      'Species',
      data.sections,
      { footer: 'Tap a species for protection details' }
    );
}

/**
 * Send schedules list
 */
async function sendSchedulesList(phoneNumber, language) {
  const schedules = WhatsAppService.buildSchedulesList(language);
  await WhatsAppService.sendListMessage(
    phoneNumber,
    `📅 *${schedules.title}*\n\nSelect a schedule for details:`,
    'Schedules',
    [{ title: 'Schedules', rows: schedules.rows }],
    { footer: 'Tap a schedule for protection details' }
  );
}

/**
 * Send penalties reference
 */
async function sendPenaltiesReference(phoneNumber, language) {
  const penalties = WhatsAppService.buildPenaltiesReference(language);
  await WhatsAppService.sendReplyButtons(
    phoneNumber,
    penalties.body,
    penalties.buttons
  );
}

/**
 * Send amendments summary
 */
async function sendAmendmentsSummary(phoneNumber, language) {
  const summary = await AmendmentService.getAllAmendmentsSummary(language);
  await WhatsAppService.sendTextMessage(phoneNumber, summary);
}

/**
 * Prompt for question
 */
async function promptForQuestion(phoneNumber, language) {
  const prompts = {
    en: '📖 Please type your question about the Wildlife (Protection) Act, 1972.\n\nFor example: "What is Section 9?" or "Explain hunting penalties."',
    hi: '📖 कृपया वन्यजीव (संरक्षण) अधिनियम, 1972 के बारे में अपना प्रश्न टाइप करें।\n\nउदाहरण: "धारा 9 क्या है?"',
    mr: '📖 कृपया वन्यजीव (संरक्षण) कायदा, 1972 बद्दल तुमचा प्रश्न टाइप करा.\n\nउदाहरण: "कलम ९ काय आहे?"',
  };
  await WhatsAppService.sendTextMessage(phoneNumber, prompts[language] || prompts.en);
}

/**
 * Send help message
 */
async function sendHelp(phoneNumber, language) {
  const helpTexts = {
    en: `👋 *WLPA Assistant Help*\n\nI can help you with:\n• WLPA sections, schedules, species\n• Penalties and legal provisions\n• Amendments (1972-2022)\n• Incident reporting\n• Real-life scenario analysis\n\nUse the menu below or type your question directly.`,
    hi: `👋 *WLPA सहायक मदद*\n\nमैं आपकी सहायता कर सकता हूँ:\n• WLPA धाराएँ, अनुसूचियाँ, प्रजातियाँ\n• दंड और कानूनी प्रावधान\n• संशोधन (1972-2022)\n• घटना रिपोर्टिंग\n• वास्तविक स्थिति विश्लेषण\n\nनीचे मेनू का उपयोग करें या सीधे प्रश्न टाइप करें।`,
    mr: `👋 *WLPA सहाय्यक मदत*\n\nमी तुमची सहाय्य करू शकतो:\n• WLPA कलमे, अनुसूची, प्रजाती\n• दंड आणि कायदेशीर प्रावधान\n• सुधारणा (1972-2022)\n• घटना अहवाल\n• वास्तविक परिस्थिती विश्लेषण\n\nखालील मेनू वापरा किंवा थेट प्रश्न टाइप करा।`,
  };
  await WhatsAppService.sendTextMessage(phoneNumber, helpTexts[language] || helpTexts.en);
  await sendMainMenu(phoneNumber, language);
}

/**
 * Send support info
 */
async function sendSupport(phoneNumber, language) {
  const supportTexts = {
    en: `📞 *Support*\n\nFor technical issues:\n• Email: support@wlpa-bot.in\n• GitHub: github.com/wlpa-bot\n\nFor wildlife emergencies:\n• Forest Dept Helpline: 1926 (toll-free)\n• WCCB: +91-11-23383445`,
    hi: `📞 *समर्थन*\n\nतकनीकी समस्याओं के लिए:\n• ईमेल: support@wlpa-bot.in\n• GitHub: github.com/wlpa-bot\n\nवन्यजीव आपातकाल के लिए:\n• वन विभाग हेल्पलाइन: 1926 (टोल-फ्री)\n• WCCB: +91-11-23383445`,
    mr: `📞 *सहाय्य*\n\nतांत्रिक समस्यांसाठी:\n• ईमेल: support@wlpa-bot.in\n• GitHub: github.com/wlpa-bot\n\nवन्यजीव आपत्कालीन परिस्थितीसाठी:\n• वन विभाग हेल्पलाइन: 1926 (टोल-फ्री)\n• WCCB: +91-11-23383445`,
  };
  await WhatsAppService.sendTextMessage(phoneNumber, supportTexts[language] || supportTexts.en);
}

/**
 * Start incident report
 */
async function startIncidentReport(phoneNumber, language) {
  const session = getSession(phoneNumber);
  const result = IncidentService.startReport(phoneNumber, language);

  session.state = 'incident_reporting';
  session.incidentData = { reportId: result.reportId };

  await WhatsAppService.sendReplyButtons(
    phoneNumber,
    result.prompt,
    result.isComplete ? [] : [{ id: 'cancel_incident', title: 'Cancel' }]
  );
}

/**
 * Handle incident report answers
 */
async function handleIncidentAnswer(phoneNumber, answer, language) {
  const session = getSession(phoneNumber);
  const result = IncidentService.processAnswer(phoneNumber, answer);

  if (result.error) {
    await WhatsAppService.sendTextMessage(phoneNumber, `${result.error}\n\nPlease try again:`);
    return;
  }

  if (result.isComplete) {
    await WhatsAppService.sendTextMessage(phoneNumber, result.reportText);
    await WhatsAppService.sendReplyButtons(
      phoneNumber,
      'Report completed. You can now forward this to the Forest Department.',
      [{ id: 'menu_main', title: 'Main Menu' }]
    );
    session.state = 'main_menu';
    session.incidentData = null;
  } else {
    await WhatsAppService.sendReplyButtons(
      phoneNumber,
      result.prompt,
      [{ id: 'cancel_incident', title: 'Cancel' }]
    );
  }
}

/**
 * Handle section selection
 */
async function handleSectionSelection(phoneNumber, selectionId, language) {
  const sectionMap = {
    sec_2: 'Explain Section 2 of the Wildlife (Protection) Act, 1972 — what does it define?',
    sec_9: 'Explain Section 9 of the Wildlife (Protection) Act, 1972 — the prohibition of hunting.',
    sec_11: 'Explain Section 11 of the Wildlife (Protection) Act, 1972 — when is hunting permitted?',
    sec_12: 'Explain Section 12 of the Wildlife (Protection) Act, 1972 — public hunting permits.',
    sec_17A: 'Explain Section 17A of the Wildlife (Protection) Act, 1972 — what does it cover?',
    sec_29: 'Explain Section 29 of the Wildlife (Protection) Act, 1972 — what does it cover?',
    sec_35: 'Explain Section 35 of the Wildlife (Protection) Act, 1972 — what does it cover?',
    sec_39: 'Explain Section 39 of the Wildlife (Protection) Act, 1972 — what does it cover?',
    sec_44: 'Explain Section 44 of the Wildlife (Protection) Act, 1972 — what does it cover?',
    sec_50: 'Explain Section 50 of the Wildlife (Protection) Act, 1972 — what does it cover?',
    sec_51: 'Explain Section 51 of the Wildlife (Protection) Act, 1972 — penalties under the Act.',
  };

  const question = sectionMap[selectionId];
  if (question) {
    await processQuestion(phoneNumber, question, language, { isSynthetic: true });
  } else {
    await sendMainMenu(phoneNumber, language);
  }
}

/**
 * Handle schedule selection
 */
async function handleScheduleSelection(phoneNumber, selectionId, language) {
  const scheduleMap = {
    sch_I: 'Explain Schedule I of the Wildlife (Protection) Act, 1972 — what animals does it protect?',
    sch_II: 'Explain Schedule II of the Wildlife (Protection) Act, 1972 — what animals does it protect?',
    sch_III: 'Explain Schedule III of the Wildlife (Protection) Act, 1972 — what animals does it protect?',
    sch_IV: 'Explain Schedule IV of the Wildlife (Protection) Act, 1972 — CITES species.',
    sch_V: 'Explain Schedule V of the Wildlife (Protection) Act, 1972 — vermin species.',
    sch_VI: 'Explain Schedule VI of the Wildlife (Protection) Act, 1972 — specified plants.',
  };

  const question = scheduleMap[selectionId];
  if (question) {
    await processQuestion(phoneNumber, question, language, { isSynthetic: true });
  } else {
    await sendMainMenu(phoneNumber, language);
  }
}

/**
 * Handle species selection
 */
async function handleSpeciesSelection(phoneNumber, selectionId, language) {
  const speciesQuestions = {
    sp_tiger: 'Tell me about Tiger protection under WLPA',
    sp_elephant: 'Tell me about Asian Elephant protection under WLPA',
    sp_rhino: 'Tell me about Indian Rhinoceros protection under WLPA',
    sp_leopard: 'Tell me about Leopard protection under WLPA',
    sp_lion: 'Tell me about Asiatic Lion protection under WLPA',
    sp_gib: 'Tell me about Great Indian Bustard protection under WLPA',
    sp_gharial: 'Tell me about Gharial protection under WLPA',
    sp_pangolin: 'Tell me about Indian Pangolin protection under WLPA',
    sp_redpanda: 'Tell me about Red Panda protection under WLPA',
    sp_dolphin: 'Tell me about Gangetic Dolphin protection under WLPA',
    sp_peafowl: 'Tell me about Peafowl protection under WLPA',
    sp_python: 'Tell me about Indian Python protection under WLPA',
    sp_kingcobra: 'Tell me about King Cobra protection under WLPA',
  };

  const question = speciesQuestions[selectionId];
  if (question) {
    await processQuestion(phoneNumber, question, language, { isSynthetic: true });
  } else {
    await sendMainMenu(phoneNumber, language);
  }
}

/**
 * Handle penalties button actions
 */
async function handlePenaltiesAction(phoneNumber, actionId, language) {
  switch (actionId) {
    case 'pen_details':
      await processQuestion(phoneNumber, 'Explain all WLPA penalties in detail', language);
      break;
    case 'menu_main':
      await sendMainMenu(phoneNumber, language);
      break;
  }
}

/**
 * Handle language selection
 */
async function handleLanguageSelection(phoneNumber, selectionId) {
  const langMap = {
    lang_en: 'en',
    lang_hi: 'hi',
    lang_mr: 'mr',
  };

  const language = langMap[selectionId];
  if (language) {
    const session = getSession(phoneNumber);
    session.language = language;

    const confirm = {
      en: '✅ Language set to English.',
      hi: '✅ भाषा हिन्दी में सेट की गई।',
      mr: '✅ भाषा मराठी वर सेट केली।',
    };

    await WhatsAppService.sendTextMessage(phoneNumber, confirm[language]);
    await sendMainMenu(phoneNumber, language);
  }
}

/**
 * Process a question through the full pipeline
 */
async function processQuestion(phoneNumber, question, language, options = {}) {
  const session = getSession(phoneNumber);

  // Check if it's a scenario
  const isScenario = ScenarioUnderstandingService._isScenarioQuestion
    ? ScenarioUnderstandingService._isScenarioQuestion(question)
    : false;

  logger.info('[Calling Chatbot]', {
    phoneNumber,
    language,
    question: question.slice(0, 200),
    isScenario,
  });
  console.log('[Calling Chatbot] phone=' + phoneNumber + ' | q="' + question.slice(0, 120) + '"');

  // Send "searching" indicator (not supported natively, send short text)
  if (!options.isSynthetic) {
    try { await WhatsAppService.sendTextMessage(phoneNumber, '🔍 Searching...'); }
    catch (_e) { /* no-op if send fails */ }
  }

  try {
    const { answer, model, source, confidence } = await GeminiService.generateAnswer(
      question,
      language,
      {
        telegramId: parseInt(phoneNumber.replace(/\D/g, '').slice(-9)) || 0,
        scenarioText: isScenario ? question : undefined,
      }
    );

    logger.info('[Generated Reply]', {
      phoneNumber,
      model,
      source,
      confidence,
      answerLen: answer.length,
      answerPreview: answer.slice(0, 200),
    });
    console.log('[Generated Reply] phone=' + phoneNumber + ' | src=' + source + ' | model=' + model + ' | preview="' + answer.slice(0, 160).replace(/\n/g, ' ') + '"');

    // Save to chat history
    const user = await UserService.findByTelegramId(parseInt(phoneNumber.replace(/\D/g, '').slice(-9)) || 0);
    await ChatService.save({
      userId: user?._id,
      telegramId: parseInt(phoneNumber.replace(/\D/g, '').slice(-9)) || 0,
      messageType: MESSAGE_TYPES.TEXT,
      question,
      answer,
      language,
      aiModel: model,
      metadata: { source, confidence, platform: 'whatsapp' },
    });

    // Update conversation memory
    ConversationMemoryService.addTurn(
      parseInt(phoneNumber.replace(/\D/g, '').slice(-9)) || 0,
      'user',
      question,
      language
    );
    ConversationMemoryService.addTurn(
      parseInt(phoneNumber.replace(/\D/g, '').slice(-9)) || 0,
      'model',
      answer,
      language
    );

    // Send answer with follow-up buttons
    await WhatsAppService.sendReplyButtons(
      phoneNumber,
      answer,
      [
        { id: 'menu_main', title: 'Main Menu' },
        { id: 'ask_another', title: 'Ask Another' },
      ],
      { footer: `Source: ${source} | Confidence: ${Math.round(confidence * 100)}%` }
    );

  } catch (err) {
    logger.error('WhatsApp question processing failed', { error: err.message, phoneNumber });
    await WhatsAppService.sendTextMessage(
      phoneNumber,
      '⚠️ Sorry, I encountered an error. Please try again.'
    );
  }
}

/**
 * Handle incoming text message
 */
async function handleTextMessage(phoneNumber, text) {
  const session = getSession(phoneNumber);
  const language = await resolveLanguage(phoneNumber, text);

  // Handle special commands
  if (text.startsWith('/')) {
    const cmd = text.toLowerCase().trim();
    if (cmd === '/start' || cmd === '/menu') {
      await sendMainMenu(phoneNumber, language);
      return;
    }
    if (cmd === '/help') {
      await sendHelp(phoneNumber, language);
      return;
    }
    if (cmd === '/language') {
      await sendLanguageSelection(phoneNumber);
      return;
    }
    if (cmd === '/incident') {
      await startIncidentReport(phoneNumber, language);
      return;
    }
    if (cmd === '/amendments') {
      await sendAmendmentsSummary(phoneNumber, language);
      return;
    }
    if (cmd === '/cancel') {
      clearSession(phoneNumber);
      await WhatsAppService.sendTextMessage(phoneNumber, 'Session cancelled. Type /start to begin.');
      return;
    }
  }

  // Handle session-based flows
  switch (session.state) {
    case 'incident_reporting':
      await handleIncidentAnswer(phoneNumber, text, language);
      return;

    case 'awaiting_question':
      await processQuestion(phoneNumber, text, language);
      session.state = 'main_menu';
      return;

    case 'language_selection':
      // Handled via button clicks
      return;

    default:
      // Check for button callback IDs in text (some clients send button text)
      const buttonActions = [
        'menu_main', 'menu_sections', 'menu_species', 'menu_schedules',
        'menu_penalties', 'menu_incident', 'menu_amendments', 'menu_ask',
        'menu_language', 'menu_help', 'menu_support',
        'lang_en', 'lang_hi', 'lang_mr',
        'sec_2', 'sec_9', 'sec_11', 'sec_12', 'sec_17A', 'sec_29',
        'sec_35', 'sec_39', 'sec_44', 'sec_50', 'sec_51',
        'sch_I', 'sch_II', 'sch_III', 'sch_IV', 'sch_V', 'sch_VI',
        'sp_tiger', 'sp_elephant', 'sp_rhino', 'sp_leopard', 'sp_lion',
        'sp_gib', 'sp_gharial', 'sp_pangolin', 'sp_redpanda', 'sp_dolphin',
        'sp_peafowl', 'sp_python', 'sp_kingcobra',
        'pen_details', 'ask_another', 'cancel_incident'
      ];

      if (buttonActions.includes(text)) {
        await handleButtonAction(phoneNumber, text, language);
        return;
      }

      // Regular question
      await processQuestion(phoneNumber, text, language);
  }
}

/**
 * Handle button actions
 */
async function handleButtonAction(phoneNumber, actionId, language) {
  const session = getSession(phoneNumber);

  // Main menu actions
  const menuActions = [
    'menu_sections', 'menu_species', 'menu_schedules', 'menu_penalties',
    'menu_incident', 'menu_amendments', 'menu_ask', 'menu_language',
    'menu_help', 'menu_support', 'menu_main'
  ];

  if (menuActions.includes(actionId)) {
    await handleMenuSelection(phoneNumber, actionId, language);
    return;
  }

  // Language selection
  if (actionId.startsWith('lang_')) {
    await handleLanguageSelection(phoneNumber, actionId);
    return;
  }

  // Amendment list selection
  if (actionId.startsWith('amend_pdf:')) {
    const year = actionId.replace('amend_pdf:', '');
    if (year === 'all') {
      // For WhatsApp, we can't easily send multiple PDFs, so send the summary
      await sendAmendmentsSummary(phoneNumber, language);
      await WhatsAppService.sendReplyButtons(
        phoneNumber,
        'Amendment PDFs are available. Use the buttons below to request specific amendments.',
        [
          { id: 'menu_main', title: 'Main Menu' },
          { id: 'amend_list', title: 'Show Amendments List' }
        ]
      );
    } else {
      // For WhatsApp, we can't directly send PDF files without uploading them first
      // Send a message with the amendment info instead
      const amendment = await AmendmentService.getAmendment(year, language);
      if (amendment) {
        await WhatsAppService.sendTextMessage(phoneNumber, amendment);
      } else {
        await WhatsAppService.sendTextMessage(phoneNumber, `Amendment ${year} details not found.`);
      }
      await WhatsAppService.sendReplyButtons(
        phoneNumber,
        'Use /amendments to see all amendments, or type your question.',
        [{ id: 'menu_main', title: 'Main Menu' }]
      );
    }
    return;
  }

  // Section selection
  if (actionId.startsWith('sec_')) {
    await handleSectionSelection(phoneNumber, actionId, language);
    return;
  }

  // Schedule selection
  if (actionId.startsWith('sch_')) {
    await handleScheduleSelection(phoneNumber, actionId, language);
    return;
  }

  // Species selection
  if (actionId.startsWith('sp_')) {
    await handleSpeciesSelection(phoneNumber, actionId, language);
    return;
  }

  // Penalties actions
  if (actionId === 'pen_details' || actionId === 'ask_another') {
    await handlePenaltiesAction(phoneNumber, actionId, language);
    return;
  }

  // Cancel incident
  if (actionId === 'cancel_incident') {
    clearSession(phoneNumber);
    await WhatsAppService.sendTextMessage(phoneNumber, 'Incident report cancelled.');
    await sendMainMenu(phoneNumber, language);
    return;
  }

  // Default: back to main menu
  await sendMainMenu(phoneNumber, language);
}

/**
 * Main webhook handler — Meta Cloud API delivery.
 *
 * Strategy:
 *  1. Verify X-Hub-Signature-256 using the EXACT raw bytes (req.rawBody).
 *  2. Return HTTP 200 *immediately* so Meta stops retrying; process messages
 *     asynchronously afterwards (best practice per Meta docs).
 *  3. Ignore statuses/reads — only actual user messages.
 *  4. Dedupe by message.id — Meta can retry webhooks 3x.
 */
async function handleWebhook(req, res) {
  try {
    // === 1. Signature check — use req.rawBody (captured BEFORE express.json()) ===
    const signature = req.headers?.['x-hub-signature-256'];
    const rawBody = (typeof req.rawBody === 'string' ? req.rawBody : '') || '';

    if (!WhatsAppService.verifySignature(signature, rawBody)) {
      logger.warn('WhatsApp: Invalid signature');
      return res.status(403).send('Invalid signature');
    }

    // === 2. Return HTTP 200 IMMEDIATELY — Meta retries if >15s no response ===
    // Process everything after response already sent to avoid duplicate deliveries.
    res.sendStatus(200);

    // === 3. Extract the standard Meta webhook envelope ===
    //    entry[0].changes[0].value.messages[] / statuses[] / contacts[]
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const statuses = value?.statuses;
    const contacts = value?.contacts;

    // Ignore status updates (delivered/read/sent) — they're not user messages.
    if (!messages || messages.length === 0) {
      if (statuses && statuses.length > 0) {
        const codes = statuses.map((s) => s.status).join(',');
        logger.debug('[Webhook Received] status update (ignored)', { statuses: codes });
      } else {
        logger.debug('[Webhook Received] no messages field (ignored)');
      }
      return;
    }

    const contactName = contacts?.[0]?.profile?.name || contacts?.[0]?.wa_id || '';

    logger.info('[Webhook Received]', {
      entryId: entry?.id,
      messages: messages.length,
      fromFirst: messages[0]?.from,
      contactName,
    });

    // Process each message (asynchronously — we've already returned 200)
    for (const message of messages) {
      try {
        const messageId = message.id;
        const from = message.from;
        const ts = message.timestamp;
        const type = message.type;

        // === 4. Dedupe: never process the same message.id twice ===
        if (_isMessageAlreadyProcessed(messageId)) {
          logger.info('[Duplicate Message] skipping', { messageId, from });
          continue;
        }
        _markMessageProcessed(messageId);

        // === [Message Parsed] — print extracted fields ===
        logger.info('[Message Parsed]', {
          messageId,
          from,
          timestamp: ts,
          type,
        });

        if (type === 'text') {
          const text = message?.text?.body ?? '';
          logger.info('[Message Parsed] text body', { length: text.length, text: text.slice(0, 200) });
          console.log('[Message Parsed] from=' + from + ' | type=text | body="' + text.slice(0, 200) + '"');
        } else if (type === 'interactive') {
          const subType = message?.interactive?.type;
          const id = message?.interactive?.button_reply?.id || message?.interactive?.list_reply?.id || '';
          console.log(`[Message Parsed] from=${from} | type=interactive:${subType} | id=${id}`);
        } else if (type === 'audio' || type === 'voice') {
          console.log(`[Message Parsed] from=${from} | type=${type} | mediaId=${message?.audio?.id || message?.voice?.id || ''}`);
        }

        // Mark as read (best effort; swallow error so rest still runs)
        try {
          if (messageId) await WhatsAppService.markAsRead(messageId);
        } catch (e) {
          logger.debug('markAsRead best-effort failed', { err: e.message, messageId });
        }

        // Dispatch by message type
        if (message.type === 'text') {
          await handleTextMessage(from, message.text.body);
        } else if (message.type === 'interactive') {
          const interactive = message.interactive;
          let actionId = '';
          if (interactive.type === 'button_reply') actionId = interactive.button_reply.id;
          else if (interactive.type === 'list_reply') actionId = interactive.list_reply.id;

          if (actionId) {
            const session = getSession(from);
            const language = session.language || 'en';
            await handleButtonAction(from, actionId, language);
          }
        } else if (message.type === 'audio' || message.type === 'voice') {
          if (VoiceService.isAvailable()) {
            try {
              const mediaUrl = await WhatsAppService.getMediaUrl(message.audio?.id || message.voice?.id);
              const buffer = await WhatsAppService.downloadMedia(mediaUrl);
              const transcription = await VoiceService.transcribe(buffer);
              if (transcription) {
                await handleTextMessage(from, transcription);
              } else {
                await WhatsAppService.sendTextMessage(from, 'Sorry, I could not transcribe the voice message.');
              }
            } catch (err) {
              logger.error('WhatsApp voice processing failed', { error: err.message });
              await WhatsAppService.sendTextMessage(from, 'Voice processing failed. Please type your question.');
            }
          } else {
            await WhatsAppService.sendTextMessage(from, 'Voice messages are not configured on this server.');
          }
        } else {
          await WhatsAppService.sendTextMessage(
            from,
            'I can only process text and voice messages. Please type or speak your question.'
          );
        }
      } catch (msgErr) {
        // Per-message error — try to tell the user instead of letting the whole loop die
        logger.error('WhatsApp per-message processing failed', {
          error: msgErr.message,
          stack: msgErr.stack,
          from: message?.from,
          messageId: message?.id,
        });
        try {
          if (message?.from) {
            await WhatsAppService.sendTextMessage(message.from,
              '⚠️ I encountered an error. Please try again in a moment.');
          }
        } catch (_) { /* ignore send failure */ }
      }
    }
  } catch (err) {
    logger.error('WhatsApp webhook top-level error', { error: err.message, stack: err.stack });
    // NOTE: HTTP response may already have been sent, so this is just safety
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
}

/**
 * Webhook verification (GET)
 */
function verifyWebhook(req, res) {
  const challenge = WhatsAppService.verifyWebhook(req.query);
  if (challenge) {
    return res.send(challenge);
  }
  res.status(403).send('Verification failed');
}

/**
 * Setup WhatsApp webhook with Meta
 */
async function setupWebhook() {
  if (!config.whatsapp.webhookUrl) {
    logger.warn('WhatsApp webhook URL not configured, skipping webhook setup');
    return;
  }

  try {
    const webhookUrl = `${config.whatsapp.webhookUrl}/whatsapp`;
    const fields = 'messages,message_reads,message_deliveries,message_reactions,message_template_status_updates';

    // Subscribe to webhook events
    const response = await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.whatsapp.phoneNumberId}/subscriptions`,
      {
        object: 'whatsapp_business_account',
        callback_url: webhookUrl,
        fields: fields,
        verify_token: config.whatsapp.webhookVerifyToken,
      },
      {
        headers: {
          Authorization: `Bearer ${config.whatsapp.accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    logger.info('WhatsApp webhook subscribed', { url: webhookUrl, response: response.data });
  } catch (err) {
    // If already subscribed, it might return an error - check if it's already subscribed
    if (err.response?.data?.error?.code === 100 && err.response?.data?.error?.error_subcode === 2209014) {
      logger.info('WhatsApp webhook already subscribed');
    } else {
      logger.error('WhatsApp webhook setup failed', { error: err.message, stack: err.stack });
      // Don't throw - webhook might already be set up
    }
  }
}

module.exports = {
  handleWebhook,
  verifyWebhook,
  handleTextMessage,
  handleButtonAction,
  processQuestion,
  sendMainMenu,
  sendLanguageSelection,
  getSession,
  updateSession,
  clearSession,
  userSessions,
  setupWebhook,
};