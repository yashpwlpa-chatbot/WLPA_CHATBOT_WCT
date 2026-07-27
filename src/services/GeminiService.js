/**
 * GeminiService
 * -------------
 * Enhanced wrapper around the Gemini REST API with RAG pipeline.
 * Integrates: KnowledgeService, ConversationMemory, PromptEngineering, ScenarioUnderstanding.
 *
 * Flow:
 * 1. Search knowledge base (KnowledgeService)
 * 2. If NO verified knowledge found -> Return "I don't have sufficient verified information."
 * 3. If verified knowledge FOUND -> Build enriched prompt with context + history + scenario
 * 4. Call Gemini with enriched prompt (ALWAYS use Gemini to format the answer)
 * 5. Cache frequent Q&A
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { LANGUAGE_NAMES } = require('../utils/constants');

const KnowledgeService = require('./KnowledgeService');
const ConversationMemoryService = require('./ConversationMemoryService');
const PromptEngineeringService = require('./PromptEngineeringService');
const ScenarioUnderstandingService = require('./ScenarioUnderstandingService');
const AmendmentService = require('./AmendmentService');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Simple in-memory cache for frequent Q&A
const answerCache = new Map();
const CACHE_MAX_SIZE = 200;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

class GeminiService {
  constructor() {
    this.apiKey = config.gemini.apiKey;
    this.model = config.gemini.model;
    this.knowledgeService = KnowledgeService;
    this.memoryService = ConversationMemoryService;
    this.promptService = PromptEngineeringService;
    this.scenarioService = ScenarioUnderstandingService;
    this.amendmentService = AmendmentService;
  }

  /**
   * Main entry point: Generate answer for a user question.
   * Implements: Search -> If NO knowledge -> "I don't have sufficient verified information" | Knowledge FOUND -> Gemini formats answer
   *
   * @param {string} question - User's question
   * @param {string} language - ISO code (en | hi | mr)
   * @param {Object} opts
   * @param {number} opts.telegramId - User's Telegram ID (for memory)
   * @param {boolean} opts.isVoice - Whether from voice input
   * @param {string} opts.scenarioText - Raw scenario text if detected
   * @returns {Promise<{answer: string, model: string, source: string, confidence: number}>}
   */
  async generateAnswer(question, language, opts = {}) {
    if (!question || question.trim() === '') {
      return { answer: '', model: this.model, source: 'empty', confidence: 0 };
    }

    const { telegramId, isVoice, scenarioText } = opts;
    const normalizedQ = question.trim();
    const cacheKey = `${language}:${normalizedQ.toLowerCase()}`;
    const conversationHistory = telegramId
      ? this.memoryService.buildContextForGemini(telegramId, normalizedQ)
      : '';
    const hasConversationHistory = Boolean(conversationHistory);
    const followup = telegramId
      ? this.memoryService.detectFollowup(telegramId, normalizedQ)
      : { isFollowup: false };

    // Cached standalone answers must not override a context-dependent follow-up.
    if (!hasConversationHistory && answerCache.has(cacheKey)) {
      const cached = answerCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        logger.info('GeminiService: Cache hit', { query: normalizedQ.substring(0, 50) });
        return { ...cached.data, source: 'cache' };
      } else {
        answerCache.delete(cacheKey);
      }
    }

    try {
      // Step 1: Check for amendment-specific questions (special handling)
      const amendmentAnswer = await this.amendmentService.answerQuestion(normalizedQ, language);
      if (amendmentAnswer) {
        const formatted = this._formatAmendmentAnswer(amendmentAnswer, language);
        if (!hasConversationHistory) {
          this._setCache(cacheKey, { answer: formatted, model: this.model, source: 'amendment_kb', confidence: 0.95 });
        }
        return { answer: formatted, model: this.model, source: 'amendment_kb', confidence: 0.95 };
      }

      // Step 1: Search knowledge base using KnowledgeService
      const previousQuestion = followup.isFollowup
        ? this.memoryService.getLastUserQuestion(telegramId)?.text
        : '';
      const retrievalQuery = previousQuestion
        ? `${previousQuestion}\nFollow-up: ${normalizedQ}`
        : normalizedQ;
      const knowledgeResult = await this.knowledgeService.search(retrievalQuery);

      // Step 2: Check if ANY verified knowledge was found
      const hasVerifiedKnowledge = knowledgeResult.results && knowledgeResult.results.length > 0;

      if (!hasVerifiedKnowledge) {
        // NO verified knowledge found - return standard message
        const answer = "I don't have sufficient verified information.";
        if (!hasConversationHistory) {
          this._setCache(cacheKey, { answer, model: this.model, source: 'no_knowledge', confidence: 0 });
        }
        return { answer, model: this.model, source: 'no_knowledge', confidence: 0 };
      }

      // Step 3: Verified knowledge FOUND - ALWAYS use Gemini to format the answer
      logger.info('GeminiService: Verified knowledge found, using Gemini to format answer', {
        query: normalizedQ.substring(0, 50),
        resultsCount: knowledgeResult.results.length,
        confidence: knowledgeResult.confidence,
        sources: [...new Set(knowledgeResult.results.map(r => r.source))]
      });

      // Get conversation history
      // Analyze scenario if present
      let scenarioAnalysis = '';
      if (scenarioText || this._isScenarioQuestion(normalizedQ)) {
        const analysis = await this.scenarioService.analyzeScenario(scenarioText || normalizedQ, language);
        scenarioAnalysis = this.scenarioService.formatResponse(analysis, language);
      }

      // Build knowledge base context for Gemini
      const kbContext = this.knowledgeService.formatContextForGemini(knowledgeResult);

      // Build system prompt with all context
      const systemPrompt = this.promptService.buildSystemPrompt({
        language,
        context: kbContext,
        conversationHistory,
        scenarioAnalysis
      });

      // Build user message
      const userMessage = this.promptService.buildUserMessage(normalizedQ, {
        isFollowup: followup.isFollowup,
        scenarioText
      });

      // Call Gemini API
      const { answer } = await this._callGemini(systemPrompt, userMessage, language);

      // Cache the result
      if (!hasConversationHistory) {
        this._setCache(cacheKey, { answer, model: this.model, source: 'gemini', confidence: knowledgeResult.confidence });
      }

      return { answer, model: this.model, source: 'gemini', confidence: knowledgeResult.confidence };

    } catch (err) {
      logger.error('GeminiService: generateAnswer failed', { error: err.message, code: err.code });
      throw err;
    }
  }

  /**
   * Call Gemini API with system prompt and user message.
   */
  async _callGemini(systemPrompt, userMessage, language) {
    const contents = [{ role: 'user', parts: [{ text: userMessage }] }];

    const url = `${BASE_URL}/${this.model}:generateContent`;

    const response = await axios.post(
      `${url}?key=${this.apiKey}`,
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature: 0.2,
          topP: 0.85,
          topK: 30,
          maxOutputTokens: 2048,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      },
      { timeout: 30000 }
    );

    const answer = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    return { answer };
  }

    /**
   * Format answer from KnowledgeService search result.
   * Used when high confidence knowledge is found.
   */
  _formatKnowledgeResult(knowledgeResult, language) {
    if (!knowledgeResult.results || knowledgeResult.results.length === 0) {
      return "I don't have sufficient verified information.";
    }

    // Group results by source
    const bySource = {};
    for (const result of knowledgeResult.results) {
      if (!bySource[result.source]) {
        bySource[result.source] = [];
      }
      bySource[result.source].push(result);
    }

    let answer = '';
    let hasContent = false;

    // Process each source category
    const sourceOrder = ['sections', 'species', 'schedules', 'penalties', 'procedures', 'definitions', 'amendments', 'faq', 'glossary', 'incident_patterns'];
    
    for (const source of sourceOrder) {
      if (!bySource[source] || bySource[source].length === 0) continue;
      
      const results = bySource[source].slice(0, 3); // Limit to top 3 per category
      hasContent = true;

      for (const result of results) {
        const item = result.item;
        const confidence = result.confidence;

        if (source === 'sections') {
          const item = result.item;
          answer += `📖 *Section ${item.number} — ${item.title}*\n\n`;
          answer += `*Summary*\n${item.summary}\n\n`;
          if (item.keyPoints?.length) {
            answer += `*Important Points*\n${item.keyPoints.map(p => `- ${p}`).join('\n')}\n\n`;
          }
          if (item.penalties) {
            answer += `*Penalties*\n${item.penalties}\n\n`;
          }
          if (item.relatedSections?.length) {
            answer += `*Related Sections*\n${item.relatedSections.map(s => `\`${s}\``).join(', ')}\n\n`;
          }
        } else if (source === 'species') {
          const item = result.item;
          answer += `🐅 **${item.commonName}** (*${item.scientificName}*)\n\n`;
          answer += `*Schedule:* ${item.schedule} (${item.category})\n`;
          answer += `*IUCN Status:* ${item.conservationStatus}\n\n`;
          answer += `${item.protectionDetails}\n\n`;
          if (item.keySections?.length) {
            answer += `*Key Sections:* ${item.keySections.map(s => `\`${s}\``).join(', ')}\n`;
          }
        } else if (source === 'schedules') {
          const item = result.item;
          answer += `*${item.title}*\n\n`;
          answer += `*🎯 Purpose:* ${item.description}\n\n`;
          answer += `*🛡️ Protection Level:* ${item.protectionLevel}\n\n`;
          if (item.keyCategories) {
            answer += `*📋 Key Contents:*\n`;
            for (const [cat, species] of Object.entries(item.keyCategories)) {
              if (Array.isArray(species) && species.length) {
                answer += `- ${cat}: ${species.slice(0, 5).join(', ')}...\n`;
              }
            }
            answer += '\n';
          }
          if (item.legalImplications?.length) {
            answer += `*⚖️ Legal Implications:*\n${item.legalImplications.map(l => `- ${l}`).join('\n')}\n\n`;
          }
        } else if (source === 'penalties') {
          const item = result.item;
          answer += `⚖️ **Penalty Information**\n\n`;
          if (item.offence) answer += `*Offence:* ${item.offence}\n`;
          if (item.section) answer += `*Section:* ${item.section}\n`;
          if (item.imprisonment) answer += `*Imprisonment:* ${item.imprisonment}\n`;
          if (item.fine) answer += `*Fine:* ${item.fine}\n`;
          if (item.repeatOffence) answer += `*Repeat Offence:* ${item.repeatOffence}\n`;
        } else if (source === 'procedures') {
          const item = result.item;
          answer += `📋 **${item.title}**\n\n`;
          if (item.steps?.length) {
            answer += `*Steps:*\n${item.steps.map((s, i) => `${i+1}. ${s}`).join('\n')}\n\n`;
          }
          if (item.keyPoints?.length) {
            answer += `*Key Points:*\n${item.keyPoints.map(p => `- ${p}`).join('\n')}\n\n`;
          }
        } else if (source === 'definitions') {
          const item = result.item;
          answer += `📖 **${item.clause}**\n\n${item.plainLanguage}\n\n`;
          if (item.relatedTerms?.length) {
            answer += `*Related Terms:* ${item.relatedTerms.join(', ')}`;
          }
        } else if (source === 'amendments') {
          if (item._type === 'comparison') {
            answer = `🔄 **Amendment Comparison**\n\n`;
            answer += `*Old Provision:* ${item.oldProvision}\n`;
            answer += `*New Provision:* ${item.newProvision}\n`;
            answer += `*Reason:* ${item.reason}\n`;
            answer += `*Impact:* ${item.impact}\n`;
          } else if (item.question) {
            answer = `**${item.question}**\n\n${item.answer}`;
          } else {
            answer = `**${item.shortTitle}** (${item.year})\n\n${item.description}\n\n`;
            if (item.keyChanges?.length) {
              answer += `*Key Changes:*\n${item.keyChanges.map(c => `- ${c}`).join('\n')}\n`;
            }
          }
        } else if (source === 'incident_patterns') {
          answer = `🔍 **${item.name}**\n\n${item.description}\n\n`;
          if (item.scenarios?.length) {
            answer += `*Common Scenarios:*\n${item.scenarios.map(s => `- ${s}`).join('\n')}\n\n`;
          }
          if (item.practicalSteps?.length) {
            answer += `*Recommended Steps:*\n${item.practicalSteps.map((s, i) => `${i+1}. ${s}`).join('\n')}\n\n`;
          }
        } else if (source === 'glossary') {
          answer += `📖 **${item.en}**\n\n${item.definition}\n\n`;
          if (item.relatedTerms?.length) {
            answer += `*Related Terms:* ${item.relatedTerms.join(', ')}`;
          }
        } else if (source === 'faq') {
          answer = `**${item.question}**\n\n${item.answer}`;
        } else {
          // Generic fallback
          answer = JSON.stringify(result.item, null, 2);
        }

        // Add confidence indicator
        answer += `\n\n---\n*Confidence: ${(result.confidence * 100).toFixed(0)}% | Source: WLPA Knowledge Base (${source})*`;
        answer += '\n\n';
      }
    }

    if (!hasContent) {
      return "I don't have sufficient verified information.";
    }

    // Add disclaimer
    answer += `\n⚠️ *Disclaimer:* This is general legal information based on the Wildlife (Protection) Act, 1972 and its amendments. For specific legal advice, consult a qualified lawyer or forest department officer.`;

    return answer;
  }

  /**
   * Format structured answer from knowledge base search result.
   */
  _formatStructuredAnswer(searchResult, language) {
    const match = searchResult.bestMatch;
    const item = match.item;
    const source = match.source;

    let answer = '';

    if (source === 'faq') {
      answer = `**${item.question}**\n\n${item.answer}`;
    } else if (source === 'sections') {
      answer = `📖 *Section ${item.number} — ${item.title}*\n\n`;
      answer += `*Summary*\n${item.summary}\n\n`;
      if (item.keyPoints?.length) {
        answer += `*Important Points*\n${item.keyPoints.map(p => `- ${p}`).join('\n')}\n\n`;
      }
      if (item.penalties) {
        answer += `*Penalties*\n${item.penalties}\n\n`;
      }
      if (item.relatedSections?.length) {
        answer += `*Related Sections*\n${item.relatedSections.map(s => `- \`${s}\``).join('\n')}\n\n`;
      }
      answer += `*Source*\nWildlife (Protection) Act, 1972 (as amended)\n\n`;
      answer += `⚠️ *Disclaimer:* This is general legal information, not legal advice.`;
    } else if (source === 'species') {
      answer = `🐅 **${item.commonName}** (*${item.scientificName}*)\n\n`;
      answer += `*Schedule:* ${item.schedule} (${item.category})\n`;
      answer += `*IUCN Status:* ${item.conservationStatus}\n\n`;
      answer += `${item.protectionDetails}\n\n`;
      if (item.keySections?.length) {
        answer += `*Key Sections:* ${item.keySections.map(s => `\`${s}\``).join(', ')}\n`;
      }
    } else if (source === 'schedules') {
      answer = `*${item.title}*\n\n`;
      answer += `*🎯 Purpose:* ${item.description}\n\n`;
      answer += `*🛡️ Protection Level:* ${item.protectionLevel}\n\n`;
      if (item.keyCategories) {
        answer += `*📋 Key Contents:*\n`;
        for (const [cat, species] of Object.entries(item.keyCategories)) {
          if (Array.isArray(species) && species.length) {
            answer += `- ${cat}: ${species.slice(0, 5).join(', ')}...\n`;
          }
        }
        answer += '\n';
      }
      if (item.legalImplications?.length) {
        answer += `*⚖️ Legal Implications:*\n${item.legalImplications.map(l => `- ${l}`).join('\n')}\n\n`;
      }
    } else if (source === 'penalties') {
      answer = `⚖️ **Penalty Information**\n\n`;
      if (item.offence) answer += `*Offence:* ${item.offence}\n`;
      if (item.section) answer += `*Section:* ${item.section}\n`;
      if (item.imprisonment) answer += `*Imprisonment:* ${item.imprisonment}\n`;
      if (item.fine) answer += `*Fine:* ${item.fine}\n`;
      if (item.repeatOffence) answer += `*Repeat Offence:* ${item.repeatOffence}\n`;
    } else if (source === 'definitions') {
      answer = `📖 **${item.clause}**\n\n${item.plainLanguage}\n\n`;
      if (item.relatedTerms?.length) {
        answer += `*Related Terms:* ${item.relatedTerms.join(', ')}`;
      }
    } else if (source === 'procedures') {
      answer = `📋 **${item.title}**\n\n`;
      if (item.steps?.length) {
        answer += `*Steps:*\n${item.steps.map((s, i) => `${i+1}. ${s}`).join('\n')}\n\n`;
      }
      if (item.keyPoints?.length) {
        answer += `*Key Points:*\n${item.keyPoints.map(p => `- ${p}`).join('\n')}\n\n`;
      }
    } else if (source === 'amendments') {
      if (item._type === 'comparison') {
        answer = `🔄 **Amendment Comparison**\n\n`;
        answer += `*Old Provision:* ${item.oldProvision}\n`;
        answer += `*New Provision:* ${item.newProvision}\n`;
        answer += `*Reason:* ${item.reason}\n`;
        answer += `*Impact:* ${item.impact}\n`;
      } else if (item.question) {
        answer = `**${item.question}**\n\n${item.answer}`;
      } else {
        answer = `**${item.shortTitle}** (${item.year})\n\n${item.description}\n\n`;
        if (item.keyChanges?.length) {
          answer += `*Key Changes:*\n${item.keyChanges.map(c => `- ${c}`).join('\n')}\n`;
        }
      }
    } else if (source === 'incident_patterns') {
      answer = `🔍 **${item.name}**\n\n${item.description}\n\n`;
      if (item.scenarios?.length) {
        answer += `*Common Scenarios:*\n${item.scenarios.map(s => `- ${s}`).join('\n')}\n\n`;
      }
      if (item.practicalSteps?.length) {
        answer += `*Recommended Steps:*\n${item.practicalSteps.map((s, i) => `${i+1}. ${s}`).join('\n')}\n\n`;
      }
    } else if (source === 'glossary') {
      answer = `📖 **${item.en}**\n\n${item.definition}\n\n`;
      if (item.relatedTerms?.length) {
        answer += `*Related Terms:* ${item.relatedTerms.join(', ')}`;
      }
    } else {
      // Generic fallback
      answer = JSON.stringify(item, null, 2);
    }

    // Add source attribution
    answer += `\n\n---\n*Source: WLPA Knowledge Base (${source})*`;
    return answer;
  }

  /**
   * Format amendment service answer.
   */
  _formatAmendmentAnswer(amendmentAnswer, language) {
    if (amendmentAnswer.amendmentDetails) {
      return amendmentAnswer.amendmentDetails;
    }
    if (amendmentAnswer.answer) {
      return amendmentAnswer.answer;
    }
    if (amendmentAnswer.comparisonTable) {
      let text = `🔄 **Amendment Comparison**\n\n`;
      for (const row of amendmentAnswer.comparisonTable) {
        text += `**${row.aspect}**\n`;
        text += `- ${amendmentAnswer.amendment1.year}: ${row.amendment1}\n`;
        text += `- ${amendmentAnswer.amendment2.year}: ${row.amendment2}\n\n`;
      }
      if (amendmentAnswer.specificComparison) {
        const comp = amendmentAnswer.specificComparison;
        text += `**Detailed Comparison:**\n`;
        text += `Old: ${comp.oldProvision}\n`;
        text += `New: ${comp.newProvision}\n`;
        text += `Reason: ${comp.reason}\n`;
        text += `Impact: ${comp.impact}\n`;
      }
      return text;
    }
    return JSON.stringify(amendmentAnswer, null, 2);
  }

  /**
   * Check if question is a scenario/real-life situation.
   */
  _isScenarioQuestion(text) {
    const scenarioIndicators = [
      'village', 'farm', 'field', 'forest', 'nest', 'eggs', 'chicks',
      'children', 'villagers', 'disturb', 'attack', 'entered', 'found',
      'injured', 'dead', 'carcass', 'selling', 'buying', 'trade',
      'poach', 'hunt', 'trap', 'snare', 'poison', 'cut', 'uproot',
      'गाँव', 'खेत', 'वन', 'घोंसला', 'अंडे', 'बच्चे', 'बच्चों',
      'हमला', 'घुसा', 'मिला', 'मृत', 'शव', 'बेच', 'खरीद',
      'शिकार', 'फँसाना', 'जहर', 'काट', 'उखाड़',
      'गाव', 'शेत', 'वन', 'डोळा', 'अंडी', 'पिल्ले',
      'हल्ला', 'आला', 'सापडला', 'मृत', 'शव', 'विक्री', 'खरेदी',
      'शिकार', 'फासवणे', 'विष', 'कापणे', 'उचलणे'
    ];
    const lower = text.toLowerCase();
    return scenarioIndicators.some(ind => lower.includes(ind));
  }

  /**
   * Simple cache management.
   */
  _setCache(key, data) {
    if (answerCache.size >= CACHE_MAX_SIZE) {
      const firstKey = answerCache.keys().next().value;
      answerCache.delete(firstKey);
    }
    answerCache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Clear cache (for testing/admin).
   */
  clearCache() {
    answerCache.clear();
  }

  getCacheStats() {
    return { size: answerCache.size, maxSize: CACHE_MAX_SIZE };
  }
}

module.exports = new GeminiService();
