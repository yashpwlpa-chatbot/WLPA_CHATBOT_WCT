/**
 * IncidentService
 * ---------------
 * Handles incident reporting and report generation.
 * Collects structured data: Location, Species, Date, Time, Witnesses, Photos.
 * Generates formatted incident reports for Forest Department submission.
 * Supports both Telegram and WhatsApp (future) platforms.
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const ScenarioUnderstandingService = require('./ScenarioUnderstandingService');

class IncidentService {
  constructor() {
    // In-memory store for active incident reports (in production, use MongoDB)
    this.activeReports = new Map(); // telegramId -> report object
    this.submittedReports = new Map(); // reportId -> submitted report
    this.reportFields = [
      { key: 'incidentType', label: 'Incident Type', required: true },
      { key: 'location', label: 'Location (GPS/Address)', required: true },
      { key: 'species', label: 'Species Involved', required: true },
      { key: 'date', label: 'Date (DD/MM/YYYY)', required: true },
      { key: 'time', label: 'Time (HH:MM 24hr)', required: true },
      { key: 'description', label: 'Description', required: true },
      { key: 'witnesses', label: 'Witnesses (names/contact)', required: false },
      { key: 'photos', label: 'Photos/evidence', required: false },
      { key: 'actionTaken', label: 'Action Taken', required: false }
    ];

    this.incidentTypes = [
      'dead_animal',
      'poaching',
      'illegal_trade',
      'human_wildlife_conflict',
      'plant_destruction',
      'nest_disturbance',
      'illegal_possession',
      'animal_attack'
    ];

    this.incidentTypeLabels = {
      en: {
        dead_animal: 'Dead Animal Found',
        poaching: 'Poaching / Illegal Hunting',
        illegal_trade: 'Illegal Wildlife Trade',
        human_wildlife_conflict: 'Human-Wildlife Conflict',
        plant_destruction: 'Protected Plant Destruction',
        nest_disturbance: 'Nest / Breeding Site Disturbance',
        illegal_possession: 'Illegal Possession of Wildlife',
        animal_attack: 'Wild Animal Attack on Human'
      },
      hi: {
        dead_animal: 'मृत जानवर मिला',
        poaching: 'अवैध शिकार',
        illegal_trade: 'अवैध वन्यजीव व्यापार',
        human_wildlife_conflict: 'मानव-वन्यजीव संघर्ष',
        plant_destruction: 'संरक्षित पौधों का विनाश',
        nest_disturbance: 'घोंसला / प्रजनन स्थल छेड़छाड़',
        illegal_possession: 'वन्यजीव का अवैध कब्जा',
        animal_attack: 'इंसान पर जंगली जानवर का हमला'
      },
      mr: {
        dead_animal: 'मृत प्राणी सापडले',
        poaching: 'अवैध शिकार',
        illegal_trade: 'अवैध वन्यजीव व्यापार',
        human_wildlife_conflict: 'मानवी-वन्यजीव संघर्ष',
        plant_destruction: 'संरक्षित वनस्पतीचे नाश',
        nest_disturbance: 'डोळा / प्रजनन स्थळ छेडखानी',
        illegal_possession: 'वन्यजीवाचे अवैध अधिकार',
        animal_attack: 'मानवीवर जंगली प्राणीचा हल्ला'
      }
    };
  }

  /**
   * Initialize the service (called at startup).
   */
  async initialize() {
    logger.debug('IncidentService: Initialized');
  }

  /**
   * Start a new incident report for a user.
   * @param {number} telegramId - User's Telegram ID
   * @param {string} language - Language code
   * @returns {Object} Report object with first field to fill
   */
  startReport(telegramId, language = 'en') {
    const reportId = uuidv4().substring(0, 8);
    const report = {
      reportId,
      telegramId,
      language,
      status: 'in_progress',
      currentField: 0,
      data: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.activeReports.set(telegramId, report);
    logger.info('IncidentService: Started new report', { reportId, telegramId });

    return this._getNextFieldPrompt(report);
  }

  /**
   * Process user's answer to current field.
   * @param {number} telegramId
   * @param {string} answer - User's input
   * @returns {Object} Next field prompt or completion
   */
  processAnswer(telegramId, answer) {
    const report = this.activeReports.get(telegramId);
    if (!report || report.status !== 'in_progress') {
      return { error: 'No active incident report. Use /incident to start.' };
    }

    const field = this.reportFields[report.currentField];
    if (!field) {
      return this._completeReport(report);
    }

    // Validate answer
    const validation = this._validateField(field, answer, report.data);
    if (!validation.valid) {
      return { error: validation.message, retry: true };
    }

    // Store answer
    report.data[field.key] = validation.value;
    report.currentField++;
    report.updatedAt = new Date();

    // Check if complete
    if (report.currentField >= this.reportFields.length) {
      return this._completeReport(report);
    }

    return this._getNextFieldPrompt(report);
  }

  /**
   * Validate a field answer.
   */
  _validateField(field, answer, currentData) {
    const trimmed = answer.trim();

    if (field.required && !trimmed) {
      return { valid: false, message: `${field.label} is required. Please provide a value.` };
    }

    switch (field.key) {
      case 'incidentType':
        const typeMatch = this._matchIncidentType(trimmed);
        if (!typeMatch) {
          return { valid: false, message: `Invalid incident type. Choose from: ${this.incidentTypes.join(', ')}` };
        }
        return { valid: true, value: typeMatch };

      case 'location':
        if (trimmed.length < 5) {
          return { valid: false, message: 'Please provide a more specific location (GPS coordinates, address, or landmark).' };
        }
        return { valid: true, value: trimmed };

      case 'species':
        if (trimmed.length < 2) {
          return { valid: false, message: 'Please specify the species involved (common name or scientific name).' };
        }
        return { valid: true, value: trimmed };

      case 'date':
        if (!this._isValidDate(trimmed)) {
          return { valid: false, message: 'Invalid date format. Use DD/MM/YYYY (e.g., 22/07/2024).' };
        }
        return { valid: true, value: trimmed };

      case 'time':
        if (!this._isValidTime(trimmed)) {
          return { valid: false, message: 'Invalid time format. Use HH:MM in 24-hour format (e.g., 14:30).' };
        }
        return { valid: true, value: trimmed };

      case 'description':
        if (trimmed.length < 10) {
          return { valid: false, message: 'Please provide a more detailed description of what happened.' };
        }
        return { valid: true, value: trimmed };

      case 'witnesses':
        return { valid: true, value: trimmed || 'None provided' };

      case 'photos':
        return { valid: true, value: trimmed || 'None provided' };

      case 'actionTaken':
        return { valid: true, value: trimmed || 'None yet' };

      default:
        return { valid: true, value: trimmed };
    }
  }

  /**
   * Match user input to incident type.
   */
  _matchIncidentType(input) {
    const lower = input.toLowerCase();

    // Direct match
    for (const type of this.incidentTypes) {
      if (lower.includes(type) || type.includes(lower)) {
        return type;
      }
    }

    // Keyword matching
    const keywords = {
      dead_animal: ['dead', 'carcass', 'mortality', 'mrit', 'mrityu'],
      poaching: ['poach', 'hunt', 'kill', 'shikar', 'trap', 'snare', 'poison'],
      illegal_trade: ['trade', 'sell', 'buy', 'smuggl', 'vyapar', 'bechna'],
      human_wildlife_conflict: ['conflict', 'crop', 'livestock', 'attack', 'injury', 'death', 'fasal', 'pashu'],
      plant_destruction: ['plant', 'tree', 'cut', 'uproot', 'paudha', 'ped', 'katna'],
      nest_disturbance: ['nest', 'egg', 'chick', 'breeding', 'dola', 'anda', 'bachcha'],
      illegal_possession: ['possess', 'keep', 'pet', 'own', 'rakhna', 'paltu'],
      animal_attack: ['attack', 'injure', 'bite', 'maul', 'hamla', 'kaatna']
    };

    for (const [type, keys] of Object.entries(keywords)) {
      for (const key of keys) {
        if (lower.includes(key)) return type;
      }
    }

    return null;
  }

  _isValidDate(str) {
    const match = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!match) return false;
    const d = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);
    if (m < 1 || m > 12) return false;
    if (d < 1 || d > 31) return false;
    const date = new Date(y, m - 1, d);
    return date.getDate() === d && date.getMonth() === m - 1 && date.getFullYear() === y;
  }

  _isValidTime(str) {
    const match = str.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return false;
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }

  /**
   * Get prompt for next field.
   */
  _getNextFieldPrompt(report) {
    const field = this.reportFields[report.currentField];
    const lang = report.language;

    const prompts = {
      en: {
        incidentType: `What type of incident? Choose from:\n${this.incidentTypes.map(t => `• ${this.incidentTypeLabels.en[t]}`).join('\n')}`,
        location: 'Location (GPS coordinates, address, village, forest area, landmark):',
        species: 'Species involved (common name, scientific name, or description):',
        date: 'Date of incident (DD/MM/YYYY):',
        time: 'Time of incident (HH:MM, 24-hour format):',
        description: 'Describe what happened in detail:',
        witnesses: 'Witnesses (names, phone numbers) — or "none":',
        photos: 'Photos/evidence available? (describe or "none"):',
        actionTaken: 'Any action already taken? (contacted forest dept, photos taken, etc. — or "none"):'
      },
      hi: {
        incidentType: `घटना का प्रकार चुनें:\n${this.incidentTypes.map(t => `• ${this.incidentTypeLabels.hi[t]}`).join('\n')}`,
        location: 'स्थान (GPS निर्देशांक, पता, गांव, वन क्षेत्र, लैंडमार्क):',
        species: 'संबंधित प्रजाति (सामान्य नाम, वैज्ञानिक नाम, या विवरण):',
        date: 'घटना की तारीख (DD/MM/YYYY):',
        time: 'घटना का समय (HH:MM, 24-घंटे प्रारूप):',
        description: 'विस्तार से बताएं क्या हुआ:',
        witnesses: 'गवाह (नाम, फोन नंबर) — या "कोई नहीं":',
        photos: 'फोटो/सबूत उपलब्ध हैं? (वर्णन करें या "कोई नहीं"):',
        actionTaken: 'कोई कार्रवाई पहले से की गई? (वन विभाग से संपर्क, फोटो ली गई, आदि — या "कोई नहीं"):'
      },
      mr: {
        incidentType: `घटना प्रकार निवडा:\n${this.incidentTypes.map(t => `• ${this.incidentTypeLabels.mr[t]}`).join('\n')}`,
        location: 'स्थान (GPS निर्देशांक, पत्ता, गाव, वन क्षेत्र, लँडमार्क):',
        species: 'संबंधित प्रजाती (सामान्य नाव, वैज्ञानिक नाव, किंवा वर्णन):',
        date: 'घटनेची तारीख (DD/MM/YYYY):',
        time: 'घटनेची वेळ (HH:MM, 24-तास फॉर्मॅट):',
        description: 'काय झाले तपशीलवार सांगा:',
        witnesses: 'साक्षीदार (नाव, फोन नंबर) — किंवा "कोणी नाही":',
        photos: 'फोटो/पुरावे उपलब्ध आहेत? (वर्णन करा किंवा "कोणते नाही"):',
        actionTaken: 'कोणतीही कारवाई झाली आहे का? (वन विभागशी संपर्क, फोटो घेतली, इ. — किंवा "कोणती नाही"):'
      }
    };

    const langPrompts = prompts[lang] || prompts.en;

    return {
      reportId: report.reportId,
      field: field.key,
      fieldLabel: field.label,
      prompt: langPrompts[field.key] || `Enter ${field.label}:`,
      progress: `${report.currentField + 1} / ${this.reportFields.length}`,
      isComplete: false
    };
  }

  /**
   * Complete the report and generate formatted output.
   */
  _completeReport(report) {
    report.status = 'completed';
    report.completedAt = new Date();

    // Move to submitted reports
    this.submittedReports.set(report.reportId, { ...report });
    this.activeReports.delete(report.telegramId);

    // Generate report text
    const reportText = this.generateReportText(report);

    logger.info('IncidentService: Report completed', { reportId: report.reportId, telegramId: report.telegramId });

    return {
      reportId: report.reportId,
      isComplete: true,
      reportText,
      message: 'Incident report completed. You can now submit this to the Forest Department.'
    };
  }

  /**
   * Generate formatted incident report text.
   */
  generateReportText(report) {
    const lang = report.language;
    const labels = {
      en: {
        title: 'WILDLIFE INCIDENT REPORT',
        reportId: 'Report ID',
        dateTime: 'Date & Time of Report',
        incidentType: 'Incident Type',
        location: 'Location',
        species: 'Species Involved',
        incidentDate: 'Date of Incident',
        incidentTime: 'Time of Incident',
        description: 'Description',
        witnesses: 'Witnesses',
        photos: 'Photos/Evidence',
        actionTaken: 'Action Taken',
        reporter: 'Reported By (Telegram ID)',
        wlpaRef: 'Relevant WLPA Sections',
        disclaimer: 'This report is generated for submission to the Forest Department. It does not constitute legal advice.'
      },
      hi: {
        title: 'वन्यजीव घटना रिपोर्ट',
        reportId: 'रिपोर्ट आईडी',
        dateTime: 'रिपोर्ट की तारीख और समय',
        incidentType: 'घटना का प्रकार',
        location: 'स्थान',
        species: 'संबंधित प्रजाति',
        incidentDate: 'घटना की तारीख',
        incidentTime: 'घटना का समय',
        description: 'विवरण',
        witnesses: 'गवाह',
        photos: 'फोटो/सबूत',
        actionTaken: 'की गई कार्रवाई',
        reporter: 'रिपोर्टकर्ता (टेलीग्राम आईडी)',
        wlpaRef: 'संबंधित WLPA धाराएँ',
        disclaimer: 'यह रिपोर्ट वन विभाग को जमा करने के लिए तैयार की गई है। यह कानूनी सलाह नहीं है।'
      },
      mr: {
        title: 'वन्यजीव घटना अहवाल',
        reportId: 'अहवाल आयडी',
        dateTime: 'अहवालची तारीख व वेळ',
        incidentType: 'घटना प्रकार',
        location: 'स्थान',
        species: 'संबंधित प्रजाती',
        incidentDate: 'घटनेची तारीख',
        incidentTime: 'घटनेची वेळ',
        description: 'वर्णन',
        witnesses: 'साक्षीदार',
        photos: 'फोटो/पुरावे',
        actionTaken: 'घेतलेली कारवाई',
        reporter: 'अहवालदाता (टेलीग्राम आयडी)',
        wlpaRef: 'संबंधित WLPA कलमे',
        disclaimer: 'हा अहवाल वन विभागाकडे सादरीकरणासाठी तयार केला आहे. याचे कायदेशीर सल्ला नाही.'
      }
    };

    const l = labels[lang] || labels.en;
    const d = report.data;
    const typeLabel = this.incidentTypeLabels[lang]?.[d.incidentType] || d.incidentType;

    // Get applicable WLPA sections via ScenarioUnderstandingService
    let wlpaSections = 'To be determined by Forest Department';
    // (In full implementation, would call ScenarioUnderstandingService.analyzeScenario)

    let text = `═══════════════════════════════\n`;
    text += `   ${l.title}\n`;
    text += `═══════════════════════════════\n\n`;
    text += `${l.reportId}: ${report.reportId}\n`;
    text += `${l.dateTime}: ${report.completedAt.toLocaleString()}\n\n`;
    text += `──────────────────────────────\n`;
    text += `${l.incidentType}: ${typeLabel}\n`;
    text += `${l.location}: ${d.location}\n`;
    text += `${l.species}: ${d.species}\n`;
    text += `${l.incidentDate}: ${d.date}\n`;
    text += `${l.incidentTime}: ${d.time}\n`;
    text += `──────────────────────────────\n\n`;
    text += `${l.description}:\n${d.description}\n\n`;
    text += `${l.witnesses}: ${d.witnesses}\n`;
    text += `${l.photos}: ${d.photos}\n`;
    text += `${l.actionTaken}: ${d.actionTaken}\n\n`;
    text += `──────────────────────────────\n`;
    text += `${l.reporter}: ${report.telegramId}\n`;
    text += `${l.wlpaRef}: ${wlpaSections}\n\n`;
    text += `──────────────────────────────\n`;
    text += `${l.disclaimer}\n`;
    text += `═══════════════════════════════`;

    return text;
  }

  /**
   * Get active report for a user.
   */
  getActiveReport(telegramId) {
    return this.activeReports.get(telegramId) || null;
  }

  /**
   * Cancel active report.
   */
  cancelReport(telegramId) {
    const report = this.activeReports.get(telegramId);
    if (report) {
      this.activeReports.delete(telegramId);
      return { cancelled: true, reportId: report.reportId };
    }
    return { cancelled: false };
  }

  /**
   * Get submitted report by ID.
   */
  getSubmittedReport(reportId) {
    return this.submittedReports.get(reportId) || null;
  }

  /**
   * Get all reports for a user.
   */
  getUserReports(telegramId) {
    const reports = [];
    for (const report of this.submittedReports.values()) {
      if (report.telegramId === telegramId) {
        reports.push({
          reportId: report.reportId,
          incidentType: report.data.incidentType,
          date: report.data.date,
          status: report.status,
          createdAt: report.createdAt
        });
      }
    }
    return reports.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Clean up old active reports (call periodically).
   */
  cleanupOldReports(maxAgeMs = 30 * 60 * 1000) { // 30 minutes
    const now = Date.now();
    for (const [telegramId, report] of this.activeReports.entries()) {
      if (now - report.updatedAt.getTime() > maxAgeMs) {
        this.activeReports.delete(telegramId);
        logger.info('IncidentService: Cleaned up expired report', { telegramId, reportId: report.reportId });
      }
    }
  }
}

module.exports = new IncidentService();
