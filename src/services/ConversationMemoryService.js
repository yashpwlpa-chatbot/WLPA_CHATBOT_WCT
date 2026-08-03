/**
 * ConversationMemoryService
 * -------------------------
 * Manages conversation history for each user.
 * Maintains last 10 conversations (user question + bot answer pairs).
 * Provides context for follow-up questions like "Explain it.", "What about Section 49M?"
 */

const logger = require('../utils/logger');
const Conversation = require('../models/Conversation');
const User = require('../models/User');

class ConversationMemoryService {
  constructor() {
    // In-memory store: sessionId -> array of turns
    // Each turn: { role: 'user'|'model', text: string, timestamp: Date, language: string, metadata: {} }
    this.memory = new Map();
    // Binds each RAM cache entry to its durable user so context cannot cross users.
    this.cacheOwners = new Map();
    this.maxTurns = 10; // Keep last 10 conversation turns (20 messages total)
    // Gemini receives the newest 12 messages; RAM and MongoDB still retain the full short-term window.
    this.maxContextMessages = 12;
    // Bound prompt growth while retaining durable MongoDB history for later reloads.
    this.maxContextCharacters = 8000;
    this.ttlMs = 24 * 60 * 60 * 1000; // 24 hours TTL for inactive conversations
  }

  /**
   * Return only non-expired RAM history so callers can hydrate it on demand.
   * MongoDB remains the durable source of truth after this cache is removed.
   */
  _getActiveHistory(sessionId) {
    this._cleanupExpired(sessionId);
    return this.memory.get(sessionId) || [];
  }

  /**
   * Clear unowned or mismatched RAM history before it can be used for a
   * different durable user. MongoDB then safely restores only that user's turns.
   */
  _bindCacheOwner(sessionId, userId) {
    if (!sessionId || !userId) return;

    const ownerId = String(userId);
    const existingOwnerId = this.cacheOwners.get(sessionId);
    if (existingOwnerId === ownerId) return;

    if (this.memory.has(sessionId)) {
      logger.warn('ConversationMemoryService: Clearing unverified or mismatched RAM history', {
        sessionId,
        previousOwnerId: existingOwnerId || 'unverified',
        ownerId,
      });
      this.memory.delete(sessionId);
    }

    this.cacheOwners.set(sessionId, ownerId);
  }

  /**
   * Add a conversation turn.
   * @param {number} sessionId - User's Telegram ID
   * @param {string} role - 'user' or 'model'
   * @param {string} text - Message text
   * @param {string} language - Language code
   * @param {Object} metadata - Additional metadata (section references, etc.)
   */
  addTurn(sessionId, role, text, language = 'en', metadata = {}) {
    if (!sessionId) return;

    if (!this.memory.has(sessionId)) {
      this.memory.set(sessionId, []);
    }

    const history = this.memory.get(sessionId);
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

    this._cleanupExpired(sessionId);
  }

  /**
   * Store a turn in RAM first, then persist it without interrupting the bot if
   * MongoDB is unavailable. Internal `model` turns are stored as `assistant`.
   */
  async addPersistentTurn(sessionId, userId, role, text, language = 'en', metadata = {}) {
    // Establish ownership before writing so a stale cache cannot receive this user's turn.
    this._bindCacheOwner(sessionId, userId);
    this.addTurn(sessionId, role, text, language, metadata);

    if (!userId || !text) {
      logger.warn('ConversationMemoryService: Skipping MongoDB persistence without userId or message', {
        sessionId,
      });
      return;
    }

    try {
      await Conversation.create({
        userId,
        role: role === 'model' ? 'assistant' : 'user',
        message: text,
        language,
        metadata,
      });
    } catch (err) {
      logger.warn('ConversationMemoryService: MongoDB persistence failed; using RAM cache only', {
        sessionId,
        error: err.message,
      });
    }
  }

  /**
   * Hydrate an empty or expired RAM cache with only the latest 20 durable turns.
   * The ascending in-memory order matches the current Gemini context format.
   */
  async ensureLoaded(sessionId, userId) {
    if (!sessionId || !userId) {
      return;
    }

    this._bindCacheOwner(sessionId, userId);
    if (this._getActiveHistory(sessionId).length > 0) return;

    try {
      const conversations = await Conversation.find({ userId })
        .sort({ createdAt: -1 })
        .limit(this.maxTurns * 2)
        .select('role message language metadata createdAt')
        .lean();

      const history = conversations.reverse().map((conversation) => ({
        role: conversation.role === 'assistant' ? 'model' : 'user',
        text: conversation.message,
        language: conversation.language,
        // Cache age starts at hydration time; MongoDB keeps the original date permanently.
        timestamp: new Date(),
        metadata: conversation.metadata || {},
      }));

      if (history.length) {
        this.memory.set(sessionId, history);
      }
    } catch (err) {
      logger.warn('ConversationMemoryService: MongoDB history load failed; using RAM cache only', {
        sessionId,
        error: err.message,
      });
    }
  }

  /**
   * Resolve the durable User reference only when a cold cache needs hydration.
   * This lets every existing channel reuse the same cache API without changes.
   */
  async ensureLoadedByTelegramId(sessionId) {
    if (!sessionId || this._getActiveHistory(sessionId).length > 0) {
      return;
    }

    try {
      // Telegram users are stored by telegramId, not by the generic session key.
      const user = await User.findOne({ telegramId: sessionId }).select('_id').lean();
      await this.ensureLoaded(sessionId, user?._id);
    } catch (err) {
      logger.warn('ConversationMemoryService: User lookup failed; using RAM cache only', {
        sessionId,
        error: err.message,
      });
    }
  }

  /**
   * Format only the newest conversation turns as chronological plain text for
   * the final Gemini prompt; no full database history is ever included.
   */
  getHistoryAsText(sessionId, maxMessages = this.maxContextMessages, maxCharacters = this.maxContextCharacters) {
    const recentTurns = this._getActiveHistory(sessionId).slice(-maxMessages);
    const selectedTurns = [];
    let characterCount = 0;

    // Build backwards so the most recent user/assistant exchange is always retained.
    for (let index = recentTurns.length - 1; index >= 0; index -= 1) {
      const turn = recentTurns[index];
      const formattedTurn = `${turn.role === 'model' ? 'Assistant' : 'User'}:\n${turn.text}`;
      const separatorLength = selectedTurns.length ? 2 : 0;

      if (selectedTurns.length && characterCount + separatorLength + formattedTurn.length > maxCharacters) {
        break;
      }

      selectedTurns.unshift(formattedTurn);
      characterCount += separatorLength + formattedTurn.length;
    }

    return selectedTurns.join('\n\n');
  }

  /**
   * Get conversation history for a user, formatted for Gemini API.
   * @param {number} sessionId
   * @returns {Array} Array of { role, parts: [{ text }] }
   */
  getHistoryForGemini(sessionId) {
    const history = this._getActiveHistory(sessionId);
    return history.map(turn => ({
      role: turn.role === 'model' ? 'model' : 'user',
      parts: [{ text: turn.text }]
    }));
  }

  /**
   * Get raw conversation history (for debugging/display).
   * @param {number} sessionId
   * @param {number} limit - Max turns to return
   */
  getHistory(sessionId, limit = this.maxTurns) {
    const history = this._getActiveHistory(sessionId);
    return history.slice(-limit * 2);
  }

  /**
   * Get the last user question.
   * @param {number} sessionId
   * @returns {Object|null} Last user turn or null
   */
  getLastUserQuestion(sessionId) {
    const history = this._getActiveHistory(sessionId);
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        return history[i];
      }
    }
    return null;
  }

  /**
   * Get the last bot answer.
   * @param {number} sessionId
   * @returns {Object|null} Last model turn or null
   */
  getLastBotAnswer(sessionId) {
    const history = this._getActiveHistory(sessionId);
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
   * @param {number} sessionId
   * @returns {Object} { sections: [], schedules: [], species: [], acts: [] }
   */
  getReferencedEntities(sessionId) {
    const history = this._getActiveHistory(sessionId);
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
   * @param {number} sessionId
   * @param {string} currentQuestion
   * @returns {Object} { isFollowup: boolean, contextType: string, referencedEntity: string }
   */
  detectFollowup(sessionId, currentQuestion) {
    const lowerQ = currentQuestion.toLowerCase().trim();
    const history = this._getActiveHistory(sessionId);

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
          const entities = this.getReferencedEntities(sessionId);
          referencedEntity = entities.sections[0] || '';
        }
        if (!referencedEntity && type === 'schedule_followup') {
          const entities = this.getReferencedEntities(sessionId);
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
   * @param {number} sessionId
   * @param {string} currentQuestion
   * @returns {string} Formatted context string
   */
  buildContextForGemini(sessionId, currentQuestion) {
    const history = this._getActiveHistory(sessionId);
    if (history.length === 0) return '';

    const followup = this.detectFollowup(sessionId, currentQuestion);
    const entities = this.getReferencedEntities(sessionId);

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
  clearHistory(sessionId) {
    this.memory.delete(sessionId);
    this.cacheOwners.delete(sessionId);
  }

  /**
   * Clean up expired conversations.
   */
  _cleanupExpired(sessionId) {
    const history = this.memory.get(sessionId);
    if (!history) return;

    const now = Date.now();
    const validTurns = history.filter(turn => now - turn.timestamp.getTime() < this.ttlMs);

    if (validTurns.length !== history.length) {
      this.memory.set(sessionId, validTurns);
      if (validTurns.length === 0) {
        this.memory.delete(sessionId);
      }
    }
  }

  /**
   * Global cleanup - call periodically.
   */
  cleanupAll() {
    for (const sessionId of this.memory.keys()) {
      this._cleanupExpired(sessionId);
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
