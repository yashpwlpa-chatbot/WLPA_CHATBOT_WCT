/**
 * KnowledgeService
 * ----------------
 * High-level knowledge access layer that wraps SearchService.
 * Provides a clean interface for searching WLPA knowledge base.
 * Handles synonym expansion, result formatting, and structured responses.
 */

const SearchService = require('./SearchService');
const logger = require('../utils/logger');

class KnowledgeService {
  constructor() {
    this.searchService = SearchService;
  }

  /**
   * Initialize the knowledge service (delegates to SearchService).
   */
  async initialize() {
    await this.searchService.initialize();
    logger.info('KnowledgeService: Initialized');
  }

  /**
   * Search the knowledge base for relevant information.
   * 
   * @param {string} question - User's question
   * @param {Object} options - Search options
   * @returns {Promise<Object>} Structured search results with categorized knowledge
   */
  async search(question, options = {}) {
    const startTime = Date.now();
    
    if (!question || question.trim() === '') {
      return this._emptyResult(question, 'Empty question');
    }

    try {
      // Search using the search service (includes synonym expansion)
      const searchResult = await this.searchService.search(question, options);
      
      // Log search metrics
      const searchTime = Date.now() - startTime;
      logger.info('KnowledgeService: Search completed', {
        question: question.substring(0, 100),
        expandedQuery: searchResult.expandedQuery,
        resultsCount: searchResult.results?.length || 0,
        bestConfidence: searchResult.confidence,
        shouldUseGemini: searchResult.shouldUseGemini,
        searchTimeMs: searchTime
      });

      // Format results by category
      const categorizedResults = this._categorizeResults(searchResult.results);
      
      // Build response
      const result = {
        question,
        expandedQuery: searchResult.expandedQuery,
        confidence: searchResult.confidence,
        shouldUseGemini: searchResult.shouldUseGemini,
        searchTimeMs: searchTime,
        timestamp: new Date().toISOString(),
        results: searchResult.results || [],
        ...categorizedResults
      };

      // Log matched objects for debugging
      logger.debug('KnowledgeService: Matched objects', {
        question: question.substring(0, 100),
        categories: Object.keys(categorizedResults).filter(k => categorizedResults[k].length > 0),
        counts: Object.fromEntries(
          Object.entries(categorizedResults)
            .filter(([_, v]) => v.length > 0)
            .map(([k, v]) => [k, v.length])
        )
      });

      return result;
    } catch (err) {
      logger.error('KnowledgeService.search failed', { error: err.message, question: question.substring(0, 100) });
      return this._emptyResult(question, 'Search failed: ' + err.message);
    }
  }

  /**
   * Categorize search results by knowledge type.
   */
  _categorizeResults(results) {
    const categories = {
      species: [],
      sections: [],
      penalties: [],
      amendments: [],
      procedures: [],
      definitions: [],
      faq: [],
      glossary: [],
      schedules: [],
      incident_patterns: []
    };

    for (const result of results) {
      const category = result.source;
      if (categories.hasOwnProperty(category)) {
        // Add confidence and source info to each item
        const item = {
          ...result.item,
          _confidence: result.confidence,
          _source: result.source
        };
        categories[category].push(item);
      }
    }

    return categories;
  }

  /**
   * Format search results for Gemini context.
   * Returns formatted context string for LLM prompt.
   */
  formatContextForGemini(searchResult, maxItems = 5) {
    if (!searchResult || !searchResult?.results?.length) return '';

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
   * Get statistics about the knowledge base.
   */
  getStats() {
    const stats = {};
    for (const [key, data] of Object.entries(this.searchService.data)) {
      if (key === 'faq') stats[key] = data.faqs?.length || 0;
      else if (key === 'species') stats[key] = Object.keys(data.species || {}).length;
      else if (key === 'sections') stats[key] = Object.keys(data.sections || {}).length;
      else if (key === 'schedules') stats[key] = Object.keys(data.schedules || {}).length;
      else if (key === 'penalties') stats[key] = Object.keys(data.penalties || {}).length;
      else if (key === 'definitions') stats[key] = Object.keys(data.definitions || {}).length;
      else if (key === 'procedures') stats[key] = Object.keys(data.procedures || {}).length;
      else if (key === 'amendments') stats[key] = Object.keys(data.amendments || {}).length;
      else if (key === 'incident_patterns') stats[key] = Object.keys(data.incidentPatterns || {}).length;
      else if (key === 'glossary') stats[key] = Object.keys(data.glossary || {}).length;
    }
    return {
      ...stats,
      totalItems: Object.values(stats).reduce((a, b) => a + b, 0),
      synonymCount: this.searchService.synonyms ? Object.keys(this.searchService.synonyms).length : 0
    };
  }

  /**
   * Reload all knowledge bases (useful for hot-reload in development).
   */
  async reload() {
    this.searchService.clearCache();
    this.searchService.initialized = false;
    await this.searchService.initialize();
    logger.info('KnowledgeService: Reloaded all knowledge bases');
  }

  /**
   * Return empty result structure for error cases.
   */
  _emptyResult(question, reason) {
    return {
      question,
      expandedQuery: '',
      confidence: 0,
      shouldUseGemini: true,
      searchTimeMs: 0,
      timestamp: new Date().toISOString(),
      results: [],
      species: [],
      sections: [],
      penalties: [],
      amendments: [],
      procedures: [],
      definitions: [],
      faq: [],
      glossary: [],
      schedules: [],
      incident_patterns: [],
      error: reason
    };
  }
}

module.exports = new KnowledgeService();