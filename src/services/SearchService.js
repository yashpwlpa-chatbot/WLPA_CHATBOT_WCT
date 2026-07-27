/**
 * SearchService
 * -------------
 * Implements prioritized fuzzy search across all WLPA knowledge bases.
 * Uses Fuse.js for fuzzy matching, typo tolerance, synonyms, partial matches.
 *
 * Priority Order (per requirements):
 *   1. FAQ
 *   2. Sections
 *   3. Species
 *   4. Schedules
 *   5. Penalties
 *   6. Definitions
 *   7. Procedures
 *   8. Amendments
 *   9. Incident Patterns
 *   10. Glossary
 *   11. Gemini (fallback)
 *
 * Returns structured results with confidence scores.
 * High confidence (≥0.7) → return JSON directly
 * Low confidence (<0.7) → escalate to Gemini with context
 */

const Fuse = require('fuse.js');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

class SearchService {
  constructor() {
    this.indices = {};
    this.data = {};
    this.initialized = false;
    this.cache = new Map(); // Simple in-memory cache for frequent queries
    this.cacheMaxSize = 500;
    this.synonyms = null; // Will hold synonym mappings
  }

  /**
   * Load synonyms from JSON file.
   */
  _loadSynonyms() {
    try {
      const synonymsPath = path.join(process.cwd(), 'src', 'data', 'synonyms.json');
      if (fs.existsSync(synonymsPath)) {
        const raw = JSON.parse(fs.readFileSync(synonymsPath, 'utf8'));
        this.synonyms = raw.synonyms || {};
        logger.info('SearchService: Synonyms loaded', { count: Object.keys(this.synonyms).length });
      } else {
        logger.warn('SearchService: Synonyms file not found, proceeding without synonym expansion');
        this.synonyms = {};
      }
    } catch (err) {
      logger.error('SearchService: Failed to load synonyms', { error: err.message });
      this.synonyms = {};
    }
  }

  /**
   * Expand query with synonyms for better matching.
   * Replaces known synonyms with their canonical terms.
   */
  _expandQueryWithSynonyms(query) {
    if (!this.synonyms || Object.keys(this.synonyms).length === 0) {
      return query;
    }

    let expandedQuery = query;
    const lowerQuery = query.toLowerCase();

    // Check for general term synonyms first
    const generalTerms = this.synonyms.GeneralTerms || {};
    for (const [canonical, synonyms] of Object.entries(generalTerms)) {
      for (const synonym of synonyms) {
        const regex = new RegExp('\\b' + synonym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
        if (regex.test(expandedQuery)) {
          expandedQuery = expandedQuery.replace(regex, canonical);
        }
      }
    }

    // Check for entity synonyms (species, etc.)
    for (const [canonical, synonyms] of Object.entries(this.synonyms)) {
      if (canonical === 'GeneralTerms') continue;
      for (const synonym of synonyms) {
        const regex = new RegExp('\\b' + synonym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
        if (regex.test(expandedQuery)) {
          expandedQuery = expandedQuery.replace(regex, canonical);
        }
      }
    }

    return expandedQuery;
  }

  /**
   * Initialize all Fuse indices from JSON knowledge bases.
   * Called once at startup.
   */
  async initialize() {
    if (this.initialized) return;

    // Load synonyms first
    this._loadSynonyms();

    const dataDir = path.join(process.cwd(), 'src', 'data');
    const files = [
      { key: 'faq', file: 'faq.json', weight: 1.0 },
      { key: 'sections', file: 'sections.json', weight: 0.95 },
      { key: 'species', file: 'species.json', weight: 0.9 },
      { key: 'schedules', file: 'schedules.json', weight: 0.85 },
      { key: 'penalties', file: 'penalties.json', weight: 0.8 },
      { key: 'definitions', file: 'definitions.json', weight: 0.75 },
      { key: 'procedures', file: 'procedures.json', weight: 0.7 },
      { key: 'amendments', file: 'amendments.json', weight: 0.65 },
      { key: 'incident_patterns', file: 'incident_patterns.json', weight: 0.6 },
      { key: 'glossary', file: 'glossary.json', weight: 0.55 },
    ];

    for (const { key, file, weight } of files) {
      try {
        const filePath = path.join(dataDir, file);
        if (fs.existsSync(filePath)) {
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          this.data[key] = raw;
          this.indices[key] = this._createFuseIndex(key, raw, weight);
          logger.info('SearchService: Indexed ' + key + ' (' + file + ')');
        } else {
          logger.warn('SearchService: File not found: ' + filePath);
        }
      } catch (err) {
        logger.error('SearchService: Failed to load ' + file, { error: err.message });
      }
    }

    this.initialized = true;
    logger.info('SearchService: All indices initialized');
  }

  /**
   * Create a Fuse index for a specific knowledge base.
   * Configuration tuned per data type.
   */
  _createFuseIndex(key, data, weight) {
    let keys = [];
    let getItems;

    switch (key) {
      case 'faq':
        getItems = () => data.faqs || [];
        keys = [
          { name: 'question', weight: 2.0 },
          { name: 'answer', weight: 1.0 },
          { name: 'keywords', weight: 1.5 },
          { name: 'category', weight: 0.5 }
        ];
        break;

      case 'sections':
        getItems = () => Object.values(data.sections || {});
        keys = [
          { name: 'title', weight: 2.0 },
          { name: 'summary', weight: 1.5 },
          { name: 'keyPoints', weight: 1.0 },
          { name: 'number', weight: 3.0 },
          { name: 'relatedSections', weight: 0.5 }
        ];
        break;

      case 'species':
        getItems = () => Object.values(data.species || {});
        keys = [
          { name: 'commonName', weight: 2.5 },
          { name: 'scientificName', weight: 1.5 },
          { name: 'schedule', weight: 2.0 },
          { name: 'category', weight: 1.0 },
          { name: 'protectionDetails', weight: 1.0 }
        ];
        break;

      case 'schedules':
        getItems = () => Object.values(data.schedules || {});
        keys = [
          { name: 'title', weight: 2.0 },
          { name: 'description', weight: 1.5 },
          { name: 'keyCategories', weight: 1.0 },
          { name: 'legalImplications', weight: 1.0 }
        ];
        break;

      case 'penalties':
        getItems = () => {
          const items = [];
          if (data.penalties) {
            Object.entries(data.penalties).forEach(([k, v]) => {
              if (v && typeof v === 'object' && (v.section || v.imprisonment)) {
                items.push({ ...v, _key: k });
              }
            });
            if (data.summaryTable && data.summaryTable.offences) {
              data.summaryTable.offences.forEach(o => items.push({ ...o, _key: 'summary_' + o.offence }));
            }
          }
          return items;
        };
        keys = [
          { name: 'section', weight: 2.0 },
          { name: 'description', weight: 1.5 },
          { name: 'offence', weight: 2.0 },
          { name: 'imprisonment', weight: 1.0 },
          { name: 'fine', weight: 1.0 }
        ];
        break;

      case 'definitions':
        getItems = () => Object.values(data.definitions || {});
        keys = [
          { name: 'definition', weight: 2.0 },
          { name: 'plainLanguage', weight: 2.5 },
          { name: 'clause', weight: 1.5 },
          { name: 'relatedTerms', weight: 0.5 }
        ];
        break;

      case 'procedures':
        getItems = () => Object.values(data.procedures || {});
        keys = [
          { name: 'title', weight: 2.0 },
          { name: 'steps', weight: 1.5 },
          { name: 'keyPoints', weight: 1.0 },
          { name: 'relatedSections', weight: 0.5 }
        ];
        break;

      case 'amendments':
        getItems = () => {
          const items = [];
          if (data.amendments) {
            Object.values(data.amendments).forEach(a => items.push(a));
          }
          if (data.comparisons) {
            Object.values(data.comparisons).forEach(c => items.push({ ...c, _type: 'comparison' }));
          }
          if (data.keyQuestions) {
            Object.entries(data.keyQuestions).forEach(([k, v]) => items.push({ question: k, answer: v, _type: 'keyQuestion' }));
          }
          return items;
        };
        keys = [
          { name: 'year', weight: 3.0 },
          { name: 'actNumber', weight: 2.0 },
          { name: 'description', weight: 2.0 },
          { name: 'keyChanges', weight: 1.5 },
          { name: 'shortTitle', weight: 2.0 },
          { name: 'question', weight: 2.5 },
          { name: 'answer', weight: 1.5 }
        ];
        break;

      case 'incident_patterns':
        getItems = () => Object.values(data.incidentPatterns || {});
        keys = [
          { name: 'name', weight: 2.0 },
          { name: 'description', weight: 1.5 },
          { name: 'scenarios', weight: 1.5 },
          { name: 'keywords', weight: 2.0 },
          { name: 'practicalSteps', weight: 1.0 }
        ];
        break;

      case 'glossary':
        getItems = () => Object.values(data.glossary || {});
        keys = [
          { name: 'definition', weight: 2.0 },
          { name: 'en', weight: 3.0 },
          { name: 'hi', weight: 1.5 },
          { name: 'mr', weight: 1.5 },
          { name: 'relatedTerms', weight: 0.5 }
        ];
        break;

      default:
        getItems = () => [];
        keys = [];
    }

    const items = getItems();
    if (items.length === 0) return null;

    const fuseOptions = {
      keys,
      threshold: 0.45,        // Lower = more fuzzy (0.0 exact, 1.0 anything)
      distance: 100,          // Max distance for matching
      minMatchCharLength: 2,
      ignoreLocation: true,
      findAllMatches: true,
      includeScore: true,
      includeMatches: true,
      shouldSort: true,
      tokenize: true,
      matchAllTokens: false
    };

    const fuse = new Fuse(items, fuseOptions);
    return { fuse, weight, getItems };
  }

  /**
   * Try to detect a direct "Section N" or "Schedule N" reference and inject a
   * near-perfect synthetic match so the fuzzy engine can't miss it due to
   * tokenization of single-digit numbers (e.g. "9").
   */
  _tryDirectSectionScheduleMatch(query) {
    const synthetic = [];
    const sectionMatch = query.match(/(?:^|\W)(?:section|sec|ss|धारा|कलम)\s*(\d{1,3}[A-Za-z]?)\b/i);
    if (sectionMatch) {
      const num = sectionMatch[1].toUpperCase();
      const sections = this.data.sections?.sections || {};
      let item = sections[num];
      if (!item) {
        const numBase = num.replace(/[A-Za-z]$/, '');
        item = sections[numBase];
      }
      if (item) {
        synthetic.push({
          source: 'sections',
          item,
          matches: [{ indices: [[0, query.length - 1]], value: query, key: 'number' }],
          confidence: 0.99,
          priority: 0,
        });
      }
    }
    const scheduleMatch = query.match(/(?:^|\W)(?:schedule|sch|section|अनुसूची)\s*([1-6]|I{1,3}|IV|V|VI)\b/i);
    if (scheduleMatch) {
      const raw = scheduleMatch[1].toUpperCase();
      const romanMap = { '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V', '6': 'VI' };
      const roman = /^[IVX]+$/.test(raw) ? raw : romanMap[raw];
      const schedules = this.data.schedules?.schedules || {};
      let matched = null;
      for (const key of Object.keys(schedules)) {
        if (schedules[key].title && schedules[key].title.includes(roman)) {
          matched = schedules[key];
          break;
        }
      }
      if (!matched && schedules[roman]) matched = schedules[roman];
      if (matched) {
        synthetic.push({
          source: 'schedules',
          item: matched,
          matches: [{ indices: [[0, query.length - 1]], value: query, key: 'title' }],
          confidence: 0.99,
          priority: 0,
        });
      }
    }
    return synthetic;
  }

  /**
   * Match clear real-world incident terms before applying whole-sentence fuzzy
   * search. Fuse is useful for legal titles, but a sentence such as "I found a
   * tiger skin" should reliably retrieve the illegal-trade guidance.
   */
  _tryDirectIncidentPatternMatch(query) {
    const patterns = this.data.incident_patterns?.incidentPatterns || {};
    const normalizedQuery = query.toLowerCase();
    const matches = [];

    for (const pattern of Object.values(patterns)) {
      const keywords = pattern.keywords || [];
      const keywordHits = keywords.filter((keyword) => {
        const escaped = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'i').test(normalizedQuery);
      });

      const isKillingScenario = pattern.name === 'Poaching / Illegal Hunting'
        && /\bkill(?:ed|ing|s)?\b/i.test(normalizedQuery);
      const isWildlifeTransport = pattern.name === 'Illegal Wildlife Trade'
        && /\btransport(?:ing|ed)?\b/i.test(normalizedQuery)
        && /\b(skin|trophy|animal|wildlife|part|product)\b/i.test(normalizedQuery);

      if (keywordHits.length || isKillingScenario || isWildlifeTransport) {
        matches.push({
          source: 'incident_patterns',
          item: pattern,
          matches: [],
          confidence: Math.min(0.97, 0.9 + keywordHits.length * 0.03),
          priority: 0,
        });
      }
    }

    return matches;
  }

  /**
   * Main search method. Returns structured results with confidence.
   * @param {string} query - User's question
   * @param {Object} options - Search options
   * @returns {Promise<Object>} { results, bestMatch, confidence, shouldUseGemini }
   */
  async search(query, options = {}) {
    if (!this.initialized) await this.initialize();

    // Expand query with synonyms for better matching
    const expandedQuery = this._expandQueryWithSynonyms(query);

    // Fast path: direct "Section N" / "Schedule N" match so we never miss
    // these high-value queries due to fuzzy-tokenization quirks.
    const directMatches = [
      ...this._tryDirectSectionScheduleMatch(expandedQuery),
      ...this._tryDirectIncidentPatternMatch(expandedQuery),
    ];

    // Check cache first (use expanded query for cache key)
    const cacheKey = expandedQuery.toLowerCase().trim();
    if (this.cache.has(cacheKey)) {
      logger.debug('SearchService: Cache hit', { query: cacheKey.substring(0, 50) });
      return this.cache.get(cacheKey);
    }

    const allResults = [];
    const priorityOrder = ['faq', 'sections', 'species', 'schedules', 'penalties', 'definitions', 'procedures', 'amendments', 'incident_patterns', 'glossary'];

    for (const key of priorityOrder) {
      const index = this.indices[key];
      if (!index) continue;

      try {
        const fuseResults = index.fuse.search(expandedQuery);
        for (const result of fuseResults) {
          // Fuse score: 0 = perfect match, 1 = no match. Convert to confidence.
          const confidence = Math.max(0, 1 - result.score) * index.weight;
          if (confidence > 0.15) { // Filter very low confidence
            allResults.push({
              source: key,
              item: result.item,
              matches: result.matches,
              confidence: Math.min(confidence, 1.0),
              priority: priorityOrder.indexOf(key)
            });
          }
        }
      } catch (err) {
        logger.warn('SearchService: Search error in ' + key, { error: err.message });
      }
    }

    // Prepend direct Section/Schedule matches (0.99 confidence) so they always win
    // the sort below, then sort fuzzy results by confidence desc + priority asc.
    const combined = [...directMatches, ...allResults];
    combined.sort((a, b) => {
      if (Math.abs(b.confidence - a.confidence) > 0.05) {
        return b.confidence - a.confidence;
      }
      return a.priority - b.priority;
    });
    allResults.length = 0;
    allResults.push(...combined);

    // Get best match
    const bestMatch = allResults[0] || null;
    const confidence = bestMatch ? bestMatch.confidence : 0;

    // Determine if we should use Gemini.
    // - Direct section/schedule hits (0.99 confidence) always skip Gemini — we trust the KB.
    // - Fuzzy-only results need BOTH confidence >= 0.7 AND a valid "meaningful" best source
    //   (not just an incidental faq/glossary token substring like "Hi" -> FAQ keywords).
    const hasDirectHit = directMatches.length > 0 && confidence >= 0.95;
    const strongFuzzySources = new Set(['sections', 'schedules', 'species', 'penalties', 'procedures', 'definitions', 'amendments', 'incident_patterns']);
    const bestSourceIsStrong = bestMatch && strongFuzzySources.has(bestMatch.source);
    const fuzzyIsReliable = confidence >= 0.7 && bestSourceIsStrong;
    const shouldUseGemini = !hasDirectHit && (!fuzzyIsReliable || allResults.length === 0);

    const result = {
      query,
      expandedQuery,
      results: allResults.slice(0, 10), // Top 10
      bestMatch,
      confidence,
      shouldUseGemini,
      timestamp: new Date().toISOString()
    };

    // Cache the result
    this._setCache(cacheKey, result);

    logger.info('SearchService: Search completed', {
      query: query.substring(0, 50),
      expandedQuery: expandedQuery.substring(0, 50),
      resultsCount: allResults.length,
      bestConfidence: confidence,
      shouldUseGemini
    });

    return result;
  }

  /**
   * Get formatted context for Gemini from search results.
   * Used when escalating to Gemini.
   */
  getContextForGemini(searchResult, maxItems = 5) {
    if (!searchResult || !searchResult.results.length) return '';

    const topResults = searchResult.results.slice(0, maxItems);
    let context = 'RETRIEVED WLPA KNOWLEDGE BASE CONTEXT:\n\n';

    for (const result of topResults) {
      const item = result.item;
      context += `--- Source: ${result.source.toUpperCase()} (Confidence: ${(result.confidence * 100).toFixed(0)}%) ---\n`;

      if (result.source === 'faq') {
        context += `Q: ${item.question}\nA: ${item.answer}\n`;
      } else if (result.source === 'sections') {
        context += `Section ${item.number} - ${item.title}\n${item.summary}\nKey Points:\n${(item.keyPoints || []).map(p => `- ${p}`).join('\n')}\n`;
      } else if (result.source === 'species') {
        context += `${item.commonName} (${item.scientificName}) - Schedule ${item.schedule}\n${item.protectionDetails}\n`;
      } else if (result.source === 'schedules') {
        context += `${item.title}\n${item.description}\nLegal Implications:\n${(item.legalImplications || []).map(l => `- ${l}`).join('\n')}\n`;
      } else if (result.source === 'penalties') {
        context += `${item.section || item.offence}: ${item.imprisonment}, ${item.fine}\n`;
      } else if (result.source === 'definitions') {
        context += `${item.clause}: ${item.plainLanguage}\n`;
      } else if (result.source === 'procedures') {
        context += `${item.title}:\n${(item.steps || []).map((s, i) => `${i+1}. ${s}`).join('\n')}\n`;
      } else if (result.source === 'amendments') {
        if (item._type === 'comparison') {
          context += `Comparison: ${item.oldProvision} → ${item.newProvision} (Reason: ${item.reason})\n`;
        } else if (item.question) {
          context += `Q: ${item.question}\nA: ${item.answer}\n`;
        } else {
          context += `${item.shortTitle}: ${item.description}\nKey Changes:\n${(item.keyChanges || []).map(c => `- ${c}`).join('\n')}\n`;
        }
      } else if (result.source === 'incident_patterns') {
        context += `${item.name}: ${item.description}\nScenarios: ${(item.scenarios || []).join('; ')}\nSteps: ${(item.practicalSteps || []).join('; ')}\n`;
      } else if (result.source === 'glossary') {
        context += `${item.en}: ${item.definition}\n`;
      }

      context += '\n';
    }

    context += '--- END CONTEXT ---\n';
    return context;
  }

  /**
   * Simple in-memory cache with LRU eviction.
   */
  _setCache(key, value) {
    if (this.cache.size >= this.cacheMaxSize) {
      // Remove oldest entry (first key)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  /**
   * Clear cache (useful for testing or data reload).
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache stats.
   */
  getCacheStats() {
    return { size: this.cache.size, maxSize: this.cacheMaxSize };
  }
}

module.exports = new SearchService();
