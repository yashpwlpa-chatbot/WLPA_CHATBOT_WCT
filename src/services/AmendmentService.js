/**
 * AmendmentService
 * ----------------
 * Handles all queries related to WLPA amendments (1972, 1982, 1986, 1991, 1993, 2002, 2006, 2022).
 * Supports:
 * - "What changed in 1991?"
 * - "What was introduced in the 2002 amendment?"
 * - "Compare 1991 and 2022 amendments."
 * - "Which amendment introduced Conservation Reserve?"
 * - "Which amendment created NTCA?"
 * - Structured comparison: Old Provision → New Provision → Reason → Impact
 */

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

class AmendmentService {
  constructor() {
    this.data = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      const dataDir = path.join(process.cwd(), 'src', 'data');
      const amendmentsPath = path.join(dataDir, 'amendments.json');
      if (fs.existsSync(amendmentsPath)) {
        this.data = JSON.parse(fs.readFileSync(amendmentsPath, 'utf8'));
        this.initialized = true;
        logger.debug('AmendmentService: Initialized');
      }
    } catch (err) {
      logger.error('AmendmentService: Initialization failed', { error: err.message });
    }
  }

  /**
   * Get information about a specific amendment year.
   * @param {string|number} year - Amendment year (e.g., "2022", "1991")
   * @param {string} language - Language code
   * @returns {Object} Amendment details
   */
  async getAmendment(year, language = 'en') {
    if (!this.initialized) await this.initialize();
    if (!this.data) return null;

    const yearStr = String(year).trim();
    const amendment = this.data.amendments?.[yearStr];

    if (!amendment) {
      // Try partial match
      for (const [key, value] of Object.entries(this.data.amendments)) {
        if (key.includes(yearStr) || yearStr.includes(key)) {
          return this._formatAmendment(value, language);
        }
      }
      return null;
    }

    return this._formatAmendment(amendment, language);
  }

  /**
   * Get comparison between two amendments.
   * @param {string|number} year1 - First amendment year
   * @param {string|number} year2 - Second amendment year
   * @param {string} language
   * @returns {Object} Comparison details
   */
  async compareAmendments(year1, year2, language = 'en') {
    if (!this.initialized) await this.initialize();
    if (!this.data) return null;

    const a1 = await this.getAmendment(year1, language);
    const a2 = await this.getAmendment(year2, language);

    if (!a1 || !a2) return null;

    // Look for specific comparison in data
    const comparisonKey = `${year1}_${year2}`;
    const comparisonKeyRev = `${year2}_${year1}`;
    let specificComparison = null;

    if (this.data.comparisons) {
      for (const [key, comp] of Object.entries(this.data.comparisons)) {
        if (key.includes(String(year1)) && key.includes(String(year2))) {
          specificComparison = comp;
          break;
        }
      }
    }

    return {
      amendment1: a1,
      amendment2: a2,
      specificComparison,
      comparisonTable: this._generateComparisonTable(a1, a2),
      language,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Answer specific questions about amendments.
   * @param {string} question - User's question
   * @param {string} language
   * @returns {Object} Answer with details
   */
  async answerQuestion(question, language = 'en') {
    if (!this.initialized) await this.initialize();
    if (!this.data) return null;

    const lowerQ = question.toLowerCase();

    // "Which amendment introduced X?"
    const introducedPatterns = [
      /which amendment (introduced|created|added|established) (.+?)[\?\.]?$/i,
      /(.+?) (was introduced|was created|was added|was established) in which amendment/i,
      /(introduced|created|added|established) by which amendment/i
    ];

    for (const pattern of introducedPatterns) {
      const match = question.match(pattern);
      if (match) {
        const feature = (match[2] || match[1] || '').toLowerCase().trim();
        return this._findAmendmentForFeature(feature, language);
      }
    }

    // "What changed in YEAR?"
    const changedPatterns = [
      /what changed in (\d{4})/i,
      /what (were the|are the) changes in (\d{4})/i,
      /changes in (\d{4}) amendment/i,
      /(\d{4}) amendment (changes|introduced|added)/i
    ];

    for (const pattern of changedPatterns) {
      const match = question.match(pattern);
      if (match) {
        const year = match[1] || match[2];
        return this.getAmendment(year, language);
      }
    }

    // "Compare X and Y amendments"
    const comparePatterns = [
      /compare (\d{4}) and (\d{4})/i,
      /difference between (\d{4}) and (\d{4})/i,
      /(\d{4}) vs (\d{4}) amendment/i,
      /compare (\d{4}) amendment (with|to) (\d{4})/i
    ];

    for (const pattern of comparePatterns) {
      const match = question.match(pattern);
      if (match) {
        return this.compareAmendments(match[1], match[2], language);
      }
    }

    // Key questions from data
    if (this.data.keyQuestions) {
      for (const [key, answer] of Object.entries(this.data.keyQuestions)) {
        if (lowerQ.includes(key.toLowerCase().replace(/[?]/g, ''))) {
          return { answer, source: 'keyQuestions', language };
        }
      }
    }

    return null;
  }

  /**
   * Find which amendment introduced a specific feature.
   */
  _findAmendmentForFeature(feature, language) {
    const featureLower = feature.toLowerCase();

    // Known features mapping
    const featureMap = {
      'conservation reserve': { year: '2002', detail: 'Sections 36A, 36B', enhanced: '2022 (Central Govt power)' },
      'community reserve': { year: '2002', detail: 'Sections 36C, 36D' },
      'national tiger conservation authority': { year: '2006', detail: 'Chapter IVB, Section 38L', alias: 'ntca' },
      'ntca': { year: '2006', detail: 'Chapter IVB, Section 38L' },
      'tiger reserve': { year: '2006', detail: 'Section 38V' },
      'wildlife crime control bureau': { year: '2006', detail: 'Chapter IVC, Section 38Y', alias: 'wccb' },
      'wccb': { year: '2006', detail: 'Chapter IVC, Section 38Y' },
      'cites': { year: '2022', detail: 'Chapter VB (Sections 49D-49R), Schedule IV' },
      'schedule iv': { year: '2022', detail: 'CITES species list' },
      'management authority': { year: '2022', detail: 'Section 49E' },
      'scientific authority': { year: '2022', detail: 'Section 49F' },
      'voluntary surrender': { year: '2022', detail: 'Section 42A' },
      'invasive alien species': { year: '2022', detail: 'Section 2(16A), Section 62A' },
      'vermin': { year: '1991', detail: 'Section 62 (notification-based)', changed: '2022 (only Schedule II)' },
      'forfeiture': { year: '2002', detail: 'Chapter VIA (Sections 58A-58Y)' },
      'protected area': { year: '2002', detail: 'Section 2(24A) - definition' },
      'national board': { year: '2002', detail: 'Section 5A' },
      'state board': { year: '2002', detail: 'Section 6' },
      'central zoo authority': { year: '1991', detail: 'Chapter IVA (Sections 38A-38J)' },
      'specified plants': { year: '1991', detail: 'Chapter IIIA (Sections 17A-17H), Schedule VI' },
      'chapter va': { year: '1986', detail: 'Sections 49A-49C (scheduled animal trade ban)' },
      'scheduled animal': { year: '1986', detail: 'Section 49A definition' },
      'ecological security': { year: '2002', detail: 'Long title amendment' },
      'conservation protection management': { year: '2022', detail: 'Long title amendment' }
    };

    for (const [key, value] of Object.entries(featureMap)) {
      if (featureLower.includes(key) || key.includes(featureLower)) {
        const amendment = this.data.amendments?.[value.year];
        return {
          feature: key,
          amendmentYear: value.year,
          detail: value.detail,
          enhancedBy: value.enhanced,
          amendmentDetails: amendment ? this._formatAmendment(amendment, language) : null,
          language
        };
      }
    }

    // Search in amendment keyChanges
    for (const [year, amendment] of Object.entries(this.data.amendments || {})) {
      if (amendment.keyChanges) {
        for (const change of amendment.keyChanges) {
          if (change.toLowerCase().includes(featureLower) || featureLower.includes(change.toLowerCase().substring(0, 20))) {
            return {
              feature,
              amendmentYear: year,
              detail: change,
              amendmentDetails: this._formatAmendment(amendment, language),
              language
            };
          }
        }
      }
    }

    return { feature, found: false, language };
  }

  /**
   * Format amendment for display.
   */
  _formatAmendment(amendment, language) {
    const labels = {
      en: { year: 'Year', act: 'Act Number', assent: 'Date of Assent', title: 'Short Title', desc: 'Description', changes: 'Key Changes', sectionsAdded: 'Sections Added', sectionsMod: 'Sections Modified', schedules: 'Schedules Changed', impact: 'Impact' },
      hi: { year: 'वर्ष', act: 'अधिनियम संख्या', assent: 'स्वीकृति की तारीख', title: 'संक्षिप्त शीर्षक', desc: 'विवरण', changes: 'मुख्य परिवर्तन', sectionsAdded: 'जोड़ी गई धाराएँ', sectionsMod: 'संशोधित धाराएँ', schedules: 'बदली गई अनुसूचियाँ', impact: 'प्रभाव' },
      mr: { year: 'वर्ष', act: 'अधिनियम क्रमांक', assent: 'मान्यतेची तारीख', title: 'संक्षिप्त शीर्षक', desc: 'वर्णन', changes: 'मुख्य बदल', sectionsAdded: 'जोडलेली कलमे', sectionsMod: 'सुधारलेली कलमे', schedules: 'बदलेली अनुसूच्या', impact: 'परिणाम' }
    };
    const l = labels[language] || labels.en;

    let formatted = `**${l.year}:** ${amendment.year}\n`;
    formatted += `**${l.act}:** ${amendment.actNumber}\n`;
    formatted += `**${l.assent}:** ${amendment.dateOfAssent}\n`;
    formatted += `**${l.title}:** ${amendment.shortTitle}\n\n`;
    formatted += `**${l.desc}:** ${amendment.description}\n\n`;

    if (amendment.keyChanges && amendment.keyChanges.length) {
      formatted += `**${l.changes}:**\n`;
      for (const change of amendment.keyChanges) {
        formatted += `- ${change}\n`;
      }
      formatted += '\n';
    }

    if (amendment.sectionsAdded && amendment.sectionsAdded.length) {
      formatted += `**${l.sectionsAdded}:** ${amendment.sectionsAdded.join(', ')}\n`;
    }
    if (amendment.sectionsModified && amendment.sectionsModified.length) {
      formatted += `**${l.sectionsMod}:** ${amendment.sectionsModified.join(', ')}\n`;
    }
    formatted += `**${l.schedules}:** ${amendment.schedulesChanged}\n\n`;
    formatted += `**${l.impact}:** ${amendment.impact}\n`;

    return formatted;
  }

  /**
   * Generate comparison table between two amendments.
   */
  _generateComparisonTable(a1, a2) {
    const table = [];

    // Compare key aspects
    const aspects = [
      { key: 'year', label: 'Year' },
      { key: 'shortTitle', label: 'Short Title' },
      { key: 'description', label: 'Focus Area' },
      { key: 'schedulesChanged', label: 'Schedules Impact' }
    ];

    for (const aspect of aspects) {
      table.push({
        aspect: aspect.label,
        amendment1: a1[aspect.key] || 'N/A',
        amendment2: a2[aspect.key] || 'N/A'
      });
    }

    return table;
  }

  /**
   * Get all amendment years.
   */
  getAmendmentYears() {
    if (!this.data) return [];
    return Object.keys(this.data.amendments || {}).sort((a, b) => parseInt(a) - parseInt(b));
  }

  /**
   * Get summary of all amendments.
   */
  getAllAmendmentsSummary(language = 'en') {
    if (!this.data) return '';

    const years = this.getAmendmentYears();
    const labels = {
      en: 'WLPA AMENDMENTS TIMELINE',
      hi: 'WLPA संशोधन समयरेखा',
      mr: 'WLPA संशोधन टाइमलाइन'
    };

    let summary = `**${labels[language] || labels.en}**\n\n`;

    for (const year of years) {
      const amend = this.data.amendments[year];
      summary += `**${year}** — ${amend.shortTitle}\n`;
      summary += `${amend.description.substring(0, 150)}...\n\n`;
    }

    return summary;
  }
}

module.exports = new AmendmentService();
