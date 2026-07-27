/**
 * User-facing messages.
 * ---------------------
 * All copy shown to users lives here so:
 *   1. It's easy to translate / edit / audit
 *   2. Strings are organized so they can be edited or translated easily
 *   3. No text is hard-coded inside bot.js
 *
 * Each constant is an object keyed by language code (en | hi | mr).
 */

const { KEYBOARD_BUTTONS } = require('./constants');

// ============================================================================
// MAIN MENU / HELP
// ============================================================================

const HELP_TEXT = {
  en:
    "👋 <b>Wildlife (Protection) Act Assistant</b>\n\n" +
    "I'm here to help you understand India's Wildlife (Protection) Act, 1972.\n\n" +
    "<b>What I can do:</b>\n" +
    '• Answer questions about any Section or Schedule\n' +
    '• Transcribe your voice questions\n' +
    '• Reply in English, हिन्दी, or मराठी\n' +
    '• Send you the official PDF\n\n' +
    '<b>Quick menu:</b> Use the buttons below to navigate.\n' +
    '<b>Type freely:</b> Just send any question about WLPA.\n\n' +
    '⚠️ <i>I provide legal INFORMATION only, not legal advice.</i>',
  hi:
    "👋 <b>वन्यजीव (संरक्षण) अधिनियम सहायक</b>\n\n" +
    "मैं भारत के वन्यजीव (संरक्षण) अधिनियम, 1972 को समझने में आपकी सहायता के लिए यहाँ हूँ।\n\n" +
    "<b>मैं क्या कर सकता हूँ:</b>\n" +
    '• किसी भी धारा या अनुसूची के बारे में प्रश्नों के उत्तर\n' +
    '• आपके वॉइस संदेशों का ट्रांसक्रिप्शन\n' +
    '• अंग्रेज़ी, हिन्दी, या मराठी में उत्तर\n' +
    '• आधिकारिक PDF भेजना\n\n' +
    '<b>त्वरित मेनू:</b> नीचे दिए गए बटनों का उपयोग करें।\n' +
    '<b>स्वतंत्र रूप से टाइप करें:</b> WLPA के बारे में कोई भी प्रश्न भेजें।\n\n' +
    '⚠️ <i>मैं केवल कानूनी जानकारी देता हूँ, कानूनी सलाह नहीं।</i>',
  mr:
    "👋 <b>वन्यजीव (संरक्षण) कायदा सहाय्यक</b>\n\n" +
    "भारताच्या वन्यजीव (संरक्षण) कायदा, 1972 समजून घेण्यासाठी मी तुमच्या मदतीसाठी येथे आहे.\n\n" +
    "<b>मी काय करू शकतो:</b>\n" +
    '• कोणत्याही कलम किंवा अनुसूचीबद्दल प्रश्नांची उत्तरे\n' +
    '• तुमच्या व्हॉइस संदेशांचे ट्रान्सक्रिप्शन\n' +
    '• इंग्रजी, हिंदी, किंवा मराठीत उत्तर\n' +
    '• अधिकृत PDF पाठवणे\n\n' +
    '<b>द्रुत मेनू:</b> खालील बटणे वापरा.\n' +
    '<b>मोकळे टाइप करा:</b> WLPA बद्दल कोणताही प्रश्न पाठवा.\n\n' +
    '⚠️ <i>मी फक्त कायदेशीर माहिती देतो, कायदेशीर सल्ला नाही.</i>',
};

// ============================================================================
// ABOUT
// ============================================================================

const ABOUT_TEXT = {
  en:
    "ℹ️ <b>About this Assistant</b>\n\n" +
    "This is the official AI assistant for <b>India's Wildlife (Protection) Act, 1972</b>.\n\n" +
    "<b>Coverage:</b> All sections and schedules of WLPA 1972\n" +
    "<b>Languages:</b> English, हिन्दी, मराठी\n" +
    "<b>Voice:</b> Whisper-powered transcription\n" +
    "<b>AI:</b> Google Gemini\n\n" +
    "⚠️ <b>Disclaimer:</b> This bot provides legal <i>information</i> only — not legal <i>advice</i>. " +
    "For specific cases, consult a qualified lawyer or your forest department.\n\n" +
    "<b>Version:</b> 1.2",
  hi:
    "ℹ️ <b>इस सहायक के बारे में</b>\n\n" +
    "यह <b>भारत के वन्यजीव (संरक्षण) अधिनियम, 1972</b> का आधिकारिक AI सहायक है।\n\n" +
    "<b>कवरेज:</b> WLPA 1972 के सभी धाराएँ और अनुसूचियाँ\n" +
    "<b>भाषाएँ:</b> अंग्रेज़ी, हिन्दी, मराठी\n" +
    "<b>वॉइस:</b> Whisper-संचालित ट्रांसक्रिप्शन\n" +
    "<b>AI:</b> Google Gemini\n\n" +
    "⚠️ <b>अस्वीकरण:</b> यह बॉट केवल कानूनी <i>जानकारी</i> देता है — कानूनी <i>सलाह</i> नहीं। " +
    "विशिष्ट मामलों के लिए, योग्य वकील या वन विभाग से सलाह लें।\n\n" +
    "<b>संस्करण:</b> 1.2",
  mr:
    "ℹ️ <b>या सहाय्यकाबद्दल</b>\n\n" +
    "हा <b>भारताच्या वन्यजीव (संरक्षण) कायदा, 1972</b> चा अधिकृत AI सहाय्यक आहे.\n\n" +
    "<b>कव्हरेज:</b> WLPA 1972 चे सर्व कलमे आणि अनुसूच्या\n" +
    "<b>भाषा:</b> इंग्रजी, हिंदी, मराठी\n" +
    "<b>व्हॉइस:</b> Whisper-चालित ट्रान्सक्रिप्शन\n" +
    "<b>AI:</b> Google Gemini\n\n" +
    "⚠️ <b>अस्वीकरण:</b> हा बॉट फक्त कायदेशीर <i>माहिती</i> देतो — कायदेशीर <i>सल्ला</i> नाही. " +
    "विशिष्ट प्रकरणांसाठी, पात्र वकील किंवा वनविभागाचा सल्ला घ्या.\n\n" +
    "<b>आवृत्ती:</b> 1.2",
};

// ============================================================================
// STATUS / PROGRESS MESSAGES — FEATURE 7
// ============================================================================

const ACK_TEXT = {
  // Text query: while Gemini is thinking
  text: {
    en: '🔍 Searching the Wildlife Act...',
    hi: '🔍 वन्यजीव अधिनियम में खोज रहे हैं...',
    mr: '🔍 वन्यजीव कायदा शोधत आहे...',
  },
  // Voice query: while Whisper is transcribing
  voiceTranscribing: {
    en: '🎤 Transcribing your voice...',
    hi: '🎤 आपकी आवाज़ का ट्रांसक्रिप्शन हो रहा है...',
    mr: '🎤 तुमचा आवाज ट्रान्सक्राइब करत आहे...',
  },
  // Voice query: while Gemini is thinking (after transcription done)
  voiceThinking: {
    en: '🤖 Preparing answer...',
    hi: '🤖 उत्तर तैयार किया जा रहा है...',
    mr: '🤖 उत्तर तयार करत आहे...',
  },
};

// ============================================================================
// PDF DOWNLOAD — FEATURE 2
// ============================================================================

const PDF_CAPTION = {
  en:
    '📄 <b>Wildlife (Protection) Act, 1972</b>\n\n' +
    'This is the official reference document.\n\n' +
    'You can also ask me questions about any Section, Schedule, or Species.',
  hi:
    '📄 <b>वन्यजीव (संरक्षण) अधिनियम, 1972</b>\n\n' +
    'यह आधिकारिक संदर्भ दस्तावेज़ है।\n\n' +
    'आप किसी भी धारा, अनुसूची, या प्रजाति के बारे में मुझसे प्रश्न पूछ सकते हैं।',
  mr:
    '📄 <b>वन्यजीव (संरक्षण) कायदा, 1972</b>\n\n' +
    'हा अधिकृत संदर्भ दस्तऐवज आहे.\n\n' +
    'तुम्ही कोणत्याही कलम, अनुसूची, किंवा प्रजातीबद्दल मला प्रश्न विचारू शकता.',
};

const PDF_NOT_FOUND = {
  en:
    '⚠️ The official WLPA PDF is not available on this server right now.\n\n' +
    'You can still ask me any question about the Act.',
  hi:
    '⚠️ आधिकारिक WLPA PDF इस सर्वर पर अभी उपलब्ध नहीं है।\n\n' +
    'आप अभी भी अधिनियम के बारे में कोई भी प्रश्न पूछ सकते हैं।',
  mr:
    '⚠️ अधिकृत WLPA PDF या सर्व्हरवर सध्या उपलब्ध नाही.\n\n' +
    'तुम्ही अजूनही कायद्याबद्दल कोणताही प्रश्न विचारू शकता.',
};

const PDF_CHOICE_PROMPT = {
  en:
    '📄 <b>Download WLPA PDFs</b>\n\n' +
    'Which documents would you like to receive?',
  hi:
    '📄 <b>WLPA PDF डाउनलोड</b>\n\n' +
    'आप कौन से दस्तावेज़ प्राप्त करना चाहते हैं?',
  mr:
    '📄 <b>WLPA PDF डाउनलोड</b>\n\n' +
    'तुम्हाला कोणते दस्तऐवज हवे आहेत?',
};

const PDF_AMENDMENTS_PICKER_PROMPT = {
  en: '📜 <b>Choose an Amendment</b>\n\nSelect the amendment year:',
  hi: '📜 <b>संशोधन चुनें</b>\n\nसंशोधन वर्ष चुनें:',
  mr: '📜 <b>सुधारणा निवडा</b>\n\nसुधारणेचे वर्ष निवडा:',
};

// ============================================================================
// VOICE GUIDE
// ============================================================================

const VOICE_GUIDE_TEXT = {
  en:
    '🎤 <b>Voice Guide</b>\n\n' +
    'You can send voice messages in English, Hindi, or Marathi!\n\n' +
    '1. Hold the 🎙 mic button in Telegram\n' +
    '2. Speak your WLPA question\n' +
    '3. Release — I will transcribe and reply in text\n\n' +
    '<b>Example:</b> "What is Section 9?"',
  hi:
    '🎤 <b>वॉइस गाइड</b>\n\n' +
    'आप अंग्रेज़ी, हिन्दी या मराठी में वॉइस मैसेज भेज सकते हैं!\n\n' +
    '1. Telegram में 🎙 माइक बटन दबाए रखें\n' +
    '2. अपना WLPA सवाल बोलें\n' +
    '3. छोड़ दें — मैं ट्रांसक्राइब करके टेक्स्ट में जवाब दूँगा\n\n' +
    '<b>उदाहरण:</b> "धारा 9 क्या है?"',
  mr:
    '🎤 <b>व्हॉइस मार्गदर्शक</b>\n\n' +
    'तुम्ही इंग्रजी, हिंदी किंवा मराठीत व्हॉइस मेसेज पाठवू शकता!\n\n' +
    '1. Telegram मधील 🎙 माइक बटन दाबून ठेवा\n' +
    '2. तुमचा WLPA प्रश्न बोला\n' +
    '3. सोडा — मी ट्रान्सक्राइब करून मजकुरात उत्तर देतो\n\n' +
    '<b>उदाहरण:</b> "कलम ९ काय आहे?"',
};

// ============================================================================
// FEEDBACK / INLINE BUTTON ACKS
// ============================================================================

const FEEDBACK_THANKS = {
  en: '🙏 Thanks for your feedback!',
  hi: '🙏 आपकी प्रतिक्रिया के लिए धन्यवाद!',
  mr: '🙏 तुमच्या अभिप्रायाबद्दल धन्यवाद!',
};

const FEEDBACK_IMPROVE = {
  en: "🙏 Thanks! We'll work to improve.",
  hi: '🙏 धन्यवाद! हम सुधार के लिए काम करेंगे।',
  mr: '🙏 धन्यवाद! आम्ही सुधारण्यासाठी काम करू.',
};

const LANG_CHANGED_INLINE = {
  en: '✅ Language updated to English.',
  hi: '✅ भाषा हिन्दी में अपडेट की गई।',
  mr: '✅ भाषा मराठी वर अपडेट केली.',
};

const ASK_ANOTHER_TEXT = {
  en: '❓ Please type your next question about the Wildlife (Protection) Act.',
  hi: '❓ कृपया वन्यजीव (संरक्षण) अधिनियम के बारे में अपना अगला प्रश्न टाइप करें।',
  mr: '❓ कृपया वन्यजीव (संरक्षण) कायद्याबद्दल तुमचा पुढील प्रश्न टाइप करा.',
};

// ============================================================================
// ERROR MESSAGES — FEATURE 8 (no stack traces)
// ============================================================================

const ERROR_MESSAGES = {
  GENERIC:
    "I'm having trouble responding right now. Please try again in a moment. " +
    'If this keeps happening, contact an administrator.',
  GEMINI_AUTH: {
    en: '⚠️ The AI service is temporarily unavailable.\n\nPlease try again in a few moments.\n\nMeanwhile you can use 📄 Download WLPA PDF.',
    hi: '⚠️ AI सेवा अस्थायी रूप से अनुपलब्ध है।\n\nकृपया कुछ देर बाद पुनः प्रयास करें।\n\nइस बीच आप 📄 WLPA PDF डाउनलोड कर सकते हैं।',
    mr: '⚠️ AI सेवा तात्पुरती अनुपलब्ध आहे.\n\nकृपया काही वेळाने पुन्हा प्रयत्न करा.\n\nदरम्यान तुम्ही 📄 WLPA PDF डाउनलोड करू शकता.',
  },
  GEMINI_SERVER: {
    en: '⚠️ The AI service is temporarily unavailable.\n\nPlease try again in a few moments.\n\nMeanwhile you can use 📄 Download WLPA PDF.',
    hi: '⚠️ AI सेवा अस्थायी रूप से अनुपलब्ध है।\n\nकृपया कुछ देर बाद पुनः प्रयास करें।\n\nइस बीच आप 📄 WLPA PDF डाउनलोड कर सकते हैं।',
    mr: '⚠️ AI सेवा तात्पुरती अनुपलब्ध आहे.\n\nकृपया काही वेळाने पुन्हा प्रयत्न करा.\n\nदरम्यान तुम्ही 📄 WLPA PDF डाउनलोड करू शकता.',
  },
  GEMINI_TIMEOUT: {
    en: '⚠️ The AI service took too long to respond.\n\nPlease try again with a shorter question.\n\nMeanwhile you can use 📄 Download WLPA PDF.',
    hi: '⚠️ AI सेवा ने उत्तर देने में बहुत समय लिया।\n\nकृपया छोटा प्रश्न के साथ पुनः प्रयास करें।\n\nइस बीच आप 📄 WLPA PDF डाउनलोड कर सकते हैं।',
    mr: '⚠️ AI सेवेला उत्तर देण्यास खूप वेळ लागला.\n\nकृपया लहान प्रश्नासह पुन्हा प्रयत्न करा.\n\nदरम्यान तुम्ही 📄 WLPA PDF डाउनलोड करू शकता.',
  },
  GEMINI_RATE_LIMIT: {
    en: '⚠️ Too many requests right now. Please wait a moment and try again.',
    hi: '⚠️ अभी बहुत अधिक अनुरोध हैं। कृपया एक पल प्रतीक्षा करें और पुनः प्रयास करें।',
    mr: '⚠️ आत्ता खूप विनंत्या आहेत. कृपया थोडा वेळ थांबा आणि पुन्हा प्रयत्न करा.',
  },
  TRANSCRIPTION_FAILURE:
    "Sorry, I couldn't understand your voice message. Please try again with a clearer recording, or send your question as text.",
  VOICE_DISABLED:
    'Voice messages are not configured on this server yet. Please type your question instead.',
  RATE_LIMIT:
    'You are sending messages too quickly. Please wait a few seconds and try again.',
};

// ============================================================================
// MAIN MENU GUIDE (shown alongside main keyboard)
// ============================================================================

const MAIN_MENU_INTRO = {
  en:
    '👋 <b>Welcome to the WLPA Assistant</b>\n\n' +
    'Choose an option below, or simply type your question.',
  hi:
    '👋 <b>WLPA सहायक में आपका स्वागत है</b>\n\n' +
    'नीचे दिया गया विकल्प चुनें, या बस अपना प्रश्न टाइप करें।',
  mr:
    '👋 <b>WLPA सहाय्यकामध्ये आपले स्वागत आहे</b>\n\n' +
    'खालील पर्याय निवडा, किंवा फक्त तुमचा प्रश्न टाइप करा.',
};

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  HELP_TEXT,
  ABOUT_TEXT,
  ACK_TEXT,
  PDF_CAPTION,
  PDF_NOT_FOUND,
  PDF_CHOICE_PROMPT,
  PDF_AMENDMENTS_PICKER_PROMPT,
  VOICE_GUIDE_TEXT,
  FEEDBACK_THANKS,
  FEEDBACK_IMPROVE,
  LANG_CHANGED_INLINE,
  ASK_ANOTHER_TEXT,
  ERROR_MESSAGES,
  MAIN_MENU_INTRO,
  KEYBOARD_BUTTONS, // re-export for convenience
};
