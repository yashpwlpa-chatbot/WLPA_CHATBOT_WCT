/**
 * GeminiService
 * -------------
 * Enhanced wrapper around the Gemini REST API with JSON knowledge lookup.
 * Integrates: KnowledgeService, ConversationMemory, PromptEngineering, ScenarioUnderstanding.
 *
 * Flow:
 * 1. Search knowledge base (KnowledgeService)
 * 2. Load the latest cached or durable conversation turns.
 * 3. Build one final prompt from system rules, relevant knowledge, history, and question.
 * 4. Call Gemini once with that final prompt.
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
   * Implements: Search -> provide matching knowledge to Gemini -> Gemini answers with
   * retrieved knowledge as its primary source and a cautious fallback for gaps.
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

    const { telegramId, sessionId, userId, isVoice, scenarioText } = opts;
    const activeSessionId = sessionId || telegramId;
    const normalizedQ = question.trim();
    const cacheKey = `${language}:${normalizedQ.toLowerCase()}`;

    // Hydrate only a cold RAM cache; failures are handled inside the memory service.
    if (activeSessionId) {
      if (userId) {
        await this.memoryService.ensureLoaded(activeSessionId, userId);
      } else if (telegramId) {
        // Telegram cold caches hydrate through the existing Telegram-ID lookup.
        await this.memoryService.ensureLoadedByTelegramId(telegramId);
      }
    }

    const conversationHistory = activeSessionId
      ? this.memoryService.getHistoryAsText(activeSessionId)
      : '';
    const hasConversationHistory = Boolean(conversationHistory);
    const followup = activeSessionId
      ? this.memoryService.detectFollowup(activeSessionId, normalizedQ)
      : { isFollowup: false };

    // Cached standalone answers must not override a context-dependent follow-up.
    if (!hasConversationHistory && answerCache.has(cacheKey)) {
      const cached = answerCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        logger.debug('GeminiService: Cache hit');
        // Keep source attribution accurate even when a previously generated answer is reused.
        const answer = this._applySourceAttribution(cached.data.answer, this._getSourceLabel(normalizedQ));
        return { ...cached.data, answer, source: 'cache' };
      } else {
        answerCache.delete(cacheKey);
      }
    }

    try {
      // Keep amendment-specific material as relevant knowledge in the same Gemini request.
      const amendmentAnswer = await this.amendmentService.answerQuestion(normalizedQ, language);

      // Step 1: Search knowledge base using KnowledgeService
      const previousQuestion = followup.isFollowup
        ? this.memoryService.getLastUserQuestion(activeSessionId)?.text
        : '';
      const retrievalQuery = previousQuestion
        ? `${previousQuestion}\nFollow-up: ${normalizedQ}`
        : normalizedQ;
      const knowledgeResult = await this.knowledgeService.search(retrievalQuery);

      // Search failures or empty results still reach Gemini with the available history.
      // Log prompt inputs without exposing the complete user conversation.
      logger.debug('GeminiService: Building final prompt', {
        resultsCount: knowledgeResult.results.length,
        confidence: knowledgeResult.confidence,
        sources: [...new Set(knowledgeResult.results.map(r => r.source))]
      });

      // Scenario analysis is locally derived from project JSON and stays inside the knowledge block.
      let scenarioAnalysis = '';
      if (scenarioText || this._isScenarioQuestion(normalizedQ)) {
        const analysis = await this.scenarioService.analyzeScenario(scenarioText || normalizedQ, language);
        scenarioAnalysis = this.scenarioService.formatResponse(analysis, language);
      }

      // Keep the JSON context small and add any amendment/scenario material to this same block.
      // Scenarios need broader evidence; simple questions use the top three matches to limit prompt cost.
      const knowledgeContextLimit = scenarioAnalysis ? 5 : 3;
      const knowledgeParts = [this.knowledgeService.formatContextForGemini(knowledgeResult, knowledgeContextLimit)];
      if (amendmentAnswer) knowledgeParts.push(this._formatAmendmentAnswer(amendmentAnswer, language));
      if (scenarioAnalysis) knowledgeParts.push(scenarioAnalysis);
      const kbContext = knowledgeParts.filter(Boolean).join('\n\n') || 'No relevant knowledge was found.';

      // Reuse the existing system prompt unchanged, without injecting other prompt sections.
      const systemPrompt = this.promptService.buildSystemPrompt({
        language,
        context: '',
        conversationHistory: '',
        scenarioAnalysis: ''
      });

      // One Gemini request receives the four required sections in a stable order.
      const finalPrompt = this._buildFinalPrompt({
        systemPrompt,
        knowledge: kbContext,
        conversationHistory: conversationHistory || 'No previous conversation is available.',
        currentQuestion: normalizedQ,
      });

      // Call Gemini API
      const { answer } = await this._callGemini(finalPrompt, language);
      // Normalize high-confidence amendment attribution instead of relying on model formatting.
      const answerWithSource = this._applySourceAttribution(
        answer,
        this._getSourceLabel(normalizedQ, knowledgeResult)
      );

      // Cache the result
      if (!hasConversationHistory) {
        this._setCache(cacheKey, { answer: answerWithSource, model: this.model, source: 'gemini', confidence: knowledgeResult.confidence });
      }

      return { answer: answerWithSource, model: this.model, source: 'gemini', confidence: knowledgeResult.confidence };

    } catch (err) {
      logger.error('GeminiService: generateAnswer failed', { error: err.message, code: err.code });
      throw err;
    }
  }

  /**
   * Keep all context in a single prompt so Gemini receives one coherent request.
   */
  _buildFinalPrompt({ systemPrompt, knowledge, conversationHistory, currentQuestion }) {
    return [
      'SYSTEM PROMPT',
      systemPrompt,
      'RELEVANT KNOWLEDGE',
      knowledge,
      'PREVIOUS CONVERSATION',
      conversationHistory,
      'CURRENT USER QUESTION',
      currentQuestion,
      'INSTRUCTIONS',
      // Retrieved JSON remains the primary source, while Gemini can still help when a valid WLPA topic is absent from it.
      'Use the relevant knowledge as your primary source and resolve follow-up references from the conversation when possible. If the relevant knowledge is empty or incomplete, provide a cautious answer using reliable WLPA knowledge. Never invent or present uncertain legal details as facts.',
    ].join('\n\n----------------------------------------------------\n\n');
  }

  /**
   * Use a specific amendment title when the user's topic is CITES or the 2022
   * amendment, while leaving other source labels generated from their context.
   */
  _getSourceLabel(question, knowledgeResult = null) {
    const query = (question || '').toLowerCase();
    const isCitesOr2022Topic = /\bcites\b|\bschedule\s*iv\b|\bchapter\s*vb\b|\b2022\s+amendment\b/.test(query);
    const has2022AmendmentResult = knowledgeResult?.results?.some((result) =>
      result.source === 'amendments' && Number(result.item?.year) === 2022
    );

    return isCitesOr2022Topic || has2022AmendmentResult
      ? 'The Wild Life (Protection) Amendment Act, 2022'
      : null;
  }

  /**
   * Replace Gemini's generic Source line, or add one before the disclaimer,
   * so CITES answers consistently cite the amendment that introduced it.
   */
  _applySourceAttribution(answer, sourceLabel) {
    if (!answer || !sourceLabel) return answer;

    const sourcePattern = /(\*{1,2}Source\*{1,2}\s*\n)[^\n]*/i;
    if (sourcePattern.test(answer)) {
      return answer.replace(sourcePattern, `$1${sourceLabel}`);
    }

    const disclaimerIndex = answer.search(/\n\s*⚠️/);
    const sourceBlock = `\n\n**Source**\n${sourceLabel}\n`;
    return disclaimerIndex >= 0
      ? `${answer.slice(0, disclaimerIndex)}${sourceBlock}${answer.slice(disclaimerIndex)}`
      : `${answer}${sourceBlock}`;
  }

  /**
   * Call Gemini once with the fully assembled prompt in a single user message.
   */
  async _callGemini(finalPrompt, language) {
    const contents = [{ role: 'user', parts: [{ text: finalPrompt }] }];

    const url = `${BASE_URL}/${this.model}:generateContent`;
    const startedAt = Date.now();

    // Log prompt shape rather than legal text or conversation content.
    logger.debug('Gemini request started', {
      model: this.model,
      endpoint: url,
      promptLength: finalPrompt.length,
      hasSystemPrompt: finalPrompt.includes('SYSTEM PROMPT'),
      hasKnowledge: finalPrompt.includes('RELEVANT KNOWLEDGE'),
      hasConversation: finalPrompt.includes('PREVIOUS CONVERSATION'),
      language,
    });

    try {
      const response = await axios.post(
        `${url}?key=${this.apiKey}`,
        {
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
      // Gemini returns authoritative per-request usage metadata; use it instead of estimating from characters.
      const usageMetadata = response.data?.usageMetadata || {};
      const usage = {
        inputTokens: usageMetadata.promptTokenCount ?? null,
        outputTokens: usageMetadata.candidatesTokenCount ?? null,
        thinkingTokens: usageMetadata.thoughtsTokenCount ?? null,
        totalTokens: usageMetadata.totalTokenCount ?? null,
      };
      logger.info('Gemini response received', {
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        answerLength: answer.length,
        ...usage,
      });
      return { answer, usage };
    } catch (err) {
      logger.error('Gemini request failed', {
        endpoint: url,
        elapsedMs: Date.now() - startedAt,
        status: err.response?.status,
        error: err.response?.data?.error?.message || err.message,
      });
      throw err;
    }
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
