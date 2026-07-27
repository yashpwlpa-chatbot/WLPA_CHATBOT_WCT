/**
 * ConversationMemoryService
 * -------------------------
 * Manages conversation history for each user.
 * Maintains last 10 conversations (user question + bot answer pairs).
 * Provides context for follow-up questions like "Explain it.", "What about Section 49M?"
 */

const logger = require('../utils/logger');

class ConversationMemoryService {
  constructor() {
    // In-memory store: telegramId -> array of turns
    // Each turn: { role: 'user'|'model', text: string, timestamp: Date, language: string, metadata: {} }
    this.memory = new Map();
    this.maxTurns = 10; // Keep last 10 conversation turns (20 messages total)
    this.ttlMs = 24 * 60 * 60 * 1000; // 24 hours TTL for inactive conversations
  }

  /**
   * Add a conversation turn.
   * @param {number} telegramId - User's Telegram ID
   * @param {string} role - 'user' or 'model'
   * @param {string} text - Message text
   * @param {string} language - Language code
   * @param {Object} metadata - Additional metadata (section references, etc.)
   */
  addTurn(telegramId, role, text, language = 'en', metadata = {}) {
    if (!telegramId) return;

    if (!this.memory.has(telegramId)) {
      this.memory.set(telegramId, []);
    }

    const history = this.memory.get(telegramId);
    history.push({
      role,
      text: text || '',
      language,
      timestamp: new Date(),
      metadata
    });

    // Trim to maxTurns * 2 (user + model pairs)
    const maxMessages = this.maxTurns * 2;
    if (history.length > maxMessages) {
      // Remove oldest messages, keep pairs together
      const excess = history.length - maxMessages;
      history.splice(0, excess);
    }

    this._cleanupExpired(telegramId);
  }

  /**
   * Get conversation history for a user, formatted for Gemini API.
   * @param {number} telegramId
   * @returns {Array} Array of { role, parts: [{ text }] }
   */
  getHistoryForGemini(telegramId) {
    const history = this.memory.get(telegramId) || [];
    return history.map(turn => ({
      role: turn.role === 'model' ? 'model' : 'user',
      parts: [{ text: turn.text }]
    }));
  }

  /**
   * Get raw conversation history (for debugging/display).
   * @param {number} telegramId
   * @param {number} limit - Max turns to return
   */
  getHistory(telegramId, limit = this.maxTurns) {
    const history = this.memory.get(telegramId) || [];
    return history.slice(-limit * 2);
  }

  /**
   * Get the last user question.
   * @param {number} telegramId
   * @returns {Object|null} Last user turn or null
   */
  getLastUserQuestion(telegramId) {
    const history = this.memory.get(telegramId) || [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        return history[i];
      }
    }
    return null;
  }

  /**
   * Get the last bot answer.
   * @param {number} telegramId
   * @returns {Object|null} Last model turn or null
   */
  getLastBotAnswer(telegramId) {
    const history = this.memory.get(telegramId) || [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'model') {
        return history[i];
      }
    }
    return null;
  }

  /**
   * Extract referenced entities from conversation history.
   * Useful for resolving "Section 49M", "that section", "it", etc.
   * @param {number} telegramId
   * @returns {Object} { sections: [], schedules: [], species: [], acts: [] }
   */
  getReferencedEntities(telegramId) {
    const history = this.memory.get(telegramId) || [];
    const entities = {
      sections: new Set(),
      schedules: new Set(),
      species: new Set(),
      acts: new Set()
    };

    // Patterns to extract references
    const sectionPattern = /\b(?:section|sec|dhara|kalam)\s+(\d+[a-z]?)\b/gi;
    const schedulePattern = /\b(?:schedule|sch|anusuci)\s+(\d+|[ivx]+)\b/gi;
    const actPattern = /\b(?:wlpa|wildlife protection act|wild life protection act|act)\b/gi;

    for (const turn of history) {
      const text = turn.text || '';

      // Sections
      let match;
      while ((match = sectionPattern.exec(text)) !== null) {
        entities.sections.add(match[1].toUpperCase());
      }

      // Schedules
      while ((match = schedulePattern.exec(text)) !== null) {
        entities.schedules.add(match[1].toUpperCase());
      }

      // Acts
      if (actPattern.test(text)) {
        entities.acts.add('WLPA');
      }

      // Species from metadata
      if (turn.metadata?.species) {
        turn.metadata.species.forEach(s => entities.species.add(s));
      }
    }

    // Convert Sets to Arrays
    return {
      sections: Array.from(entities.sections),
      schedules: Array.from(entities.schedules),
      species: Array.from(entities.species),
      acts: Array.from(entities.acts)
    };
  }

  /**
   * Check if current question is a follow-up to previous context.
   * @param {number} telegramId
   * @param {string} currentQuestion
   * @returns {Object} { isFollowup: boolean, contextType: string, referencedEntity: string }
   */
  detectFollowup(telegramId, currentQuestion) {
    const lowerQ = currentQuestion.toLowerCase().trim();
    const history = this.memory.get(telegramId) || [];

    // Explicit follow-up phrases
    const followupPatterns = [
      { pattern: /^(explain it|tell me more|elaborate|more details|explain further)$/i, type: 'elaborate' },
      { pattern: /^(what about|what is|tell me about)\s+(.+)$/i, type: 'reference' },
      { pattern: /^(and|also|additionally)\s+/i, type: 'continuation' },
      { pattern: /^(that section|this section|the section)\s*$/i, type: 'section_reference' },
      { pattern: /^(what is the punishment|what are the penalties|penalty)\s*$/i, type: 'penalty_followup' },
      { pattern: /^(which schedule|what schedule)\s*$/i, type: 'schedule_followup' },
      { pattern: /^(it|this|that)\s+(is|was|means?)\s*/i, type: 'reference' }
    ];

    for (const { pattern, type } of followupPatterns) {
      const match = lowerQ.match(pattern);
      if (match) {
        let referencedEntity = match[2] || '';
        if (!referencedEntity && type === 'section_reference') {
          const entities = this.getReferencedEntities(telegramId);
          referencedEntity = entities.sections[0] || '';
        }
        if (!referencedEntity && type === 'schedule_followup') {
          const entities = this.getReferencedEntities(telegramId);
          referencedEntity = entities.schedules[0] || '';
        }
        return { isFollowup: true, contextType: type, referencedEntity: referencedEntity.trim() };
      }
    }

    // Short follow-ups such as "bird", "what about tigers", or "in a forest"
    // depend on the immediately preceding question even when they contain no pronoun.
    if (lowerQ.length <= 60 && lowerQ.split(/\s+/).length <= 6 && history.length > 0) {
      return { isFollowup: true, contextType: 'short_continuation', referencedEntity: '' };
    }

    // Implicit follow-up: short questions that likely refer to previous context
    if (lowerQ.length < 50 && history.length > 0) {
      const shortFollowupPatterns = [
        /^(punishment|penalty|fine|imprisonment|saza|dand|jurmana)$/i,
        /^(schedule|anusuci)\s*$/i,
        /^(section|dhara|kalam)\s*$/i,
        /^(procedure|process|kaise|kase)$/i,
        /^(definition|meaning|arth|matlab)$/i
      ];
      for (const pattern of shortFollowupPatterns) {
        if (pattern.test(lowerQ)) {
          return { isFollowup: true, contextType: 'implicit', referencedEntity: '' };
        }
      }
    }

    return { isFollowup: false, contextType: 'none', referencedEntity: '' };
  }

  /**
   * Build enriched context for Gemini from conversation history.
   * @param {number} telegramId
   * @param {string} currentQuestion
   * @returns {string} Formatted context string
   */
  buildContextForGemini(telegramId, currentQuestion) {
    const history = this.memory.get(telegramId) || [];
    if (history.length === 0) return '';

    const followup = this.detectFollowup(telegramId, currentQuestion);
    const entities = this.getReferencedEntities(telegramId);

    let context = 'CONVERSATION HISTORY (last 10 turns):\n\n';

    // Include last 5 turns (10 messages) for context
    const recentTurns = history.slice(-10);
    for (const turn of recentTurns) {
      const prefix = turn.role === 'user' ? 'User' : 'Assistant';
      const lang = turn.language ? ` [${turn.language}]` : '';
      context += `${prefix}${lang}: ${turn.text}\n`;
    }

    context += '\n--- ENTITIES REFERENCED IN CONVERSATION ---\n';
    if (entities.sections.length) context += `Sections: ${entities.sections.join(', ')}\n`;
    if (entities.schedules.length) context += `Schedules: ${entities.schedules.join(', ')}\n`;
    if (entities.species.length) context += `Species: ${entities.species.join(', ')}\n`;

    if (followup.isFollowup) {
      context += `\n--- FOLLOW-UP DETECTED ---\n`;
      context += `Type: ${followup.contextType}\n`;
      if (followup.referencedEntity) {
        context += `Likely referring to: ${followup.referencedEntity}\n`;
      }
      context += `Current question: "${currentQuestion}"\n`;
      context += `INSTRUCTION: Answer in context of previous conversation. Do not ask for clarification.\n`;
    }

    context += '\n--- END CONVERSATION CONTEXT ---\n';

    return context;
  }

  /**
   * Clear conversation history for a user.
   */
  clearHistory(telegramId) {
    this.memory.delete(telegramId);
  }

  /**
   * Clean up expired conversations.
   */
  _cleanupExpired(telegramId) {
    const history = this.memory.get(telegramId);
    if (!history) return;

    const now = Date.now();
    const validTurns = history.filter(turn => now - turn.timestamp.getTime() < this.ttlMs);

    if (validTurns.length !== history.length) {
      this.memory.set(telegramId, validTurns);
      if (validTurns.length === 0) {
        this.memory.delete(telegramId);
      }
    }
  }

  /**
   * Global cleanup - call periodically.
   */
  cleanupAll() {
    for (const telegramId of this.memory.keys()) {
      this._cleanupExpired(telegramId);
    }
  }

  /**
   * Get stats.
   */
  getStats() {
    let totalTurns = 0;
    for (const history of this.memory.values()) {
      totalTurns += history.length;
    }
    return {
      activeUsers: this.memory.size,
      totalTurns,
      maxTurnsPerUser: this.maxTurns
    };
  }
}

module.exports = new ConversationMemoryService();
