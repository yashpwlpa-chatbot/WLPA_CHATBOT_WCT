/**
 * ChatService
 * -----------
 * Persists every interaction to MongoDB for audit trail.
 * Also maintains in-memory conversation history via ConversationMemoryService
 * for real-time context in follow-up questions.
 */

const ChatMessage = require('../models/ChatMessage');
const ConversationMemoryService = require('./ConversationMemoryService');
const logger = require('../utils/logger');

class ChatService {
  /**
   * Save a complete interaction to MongoDB AND update in-memory conversation memory.
   * We never throw back to the caller for logging failures — the user
   * experience should not break because a write failed.
   */
  async save({
    userId,
    telegramId,
    messageType,
    question,
    transcription = null,
    answer = '',
    language,
    aiModel = '',
    metadata = {},
    error = null,
  }) {
    // Save to MongoDB (persistent)
    let mongoDoc = null;
    try {
      mongoDoc = await ChatMessage.create({
        userId,
        telegramId,
        messageType,
        question,
        transcription,
        answer,
        language,
        aiModel,
        metadata,
        error,
      });
      logger.debug('ChatMessage saved to MongoDB', {
        id: mongoDoc._id,
        type: messageType,
      });
    } catch (err) {
      logger.error('ChatService.save to MongoDB failed', { error: err.message });
      // Swallow the error — the user-facing flow must continue.
    }

    // Update in-memory conversation memory (for real-time context)
    if (telegramId && question) {
      try {
        // Add user question
        ConversationMemoryService.addTurn(telegramId, 'user', question, language, {
          messageType,
          transcription,
          metadata,
          mongoId: mongoDoc?._id
        });

        // Add bot answer if present
        if (answer) {
          ConversationMemoryService.addTurn(telegramId, 'model', answer, language, {
            aiModel,
            metadata,
            mongoId: mongoDoc?._id
          });
        }
      } catch (memErr) {
        logger.warn('ChatService: Failed to update conversation memory', { error: memErr.message });
      }
    }

    return mongoDoc;
  }

  /**
   * Fetch recent history from MongoDB.
   */
  async getRecentForUser(telegramId, limit = 20) {
    return ChatMessage.find({ telegramId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Restore recent persisted messages when the process has no in-memory history.
   * This keeps Telegram follow-up questions meaningful after a server restart.
   */
  async ensureConversationMemory(telegramId) {
    if (!telegramId || ConversationMemoryService.getHistory(telegramId, 1).length > 0) {
      return;
    }

    try {
      const messages = await this.getRecentForUser(telegramId, 10);
      for (const message of messages.reverse()) {
        ConversationMemoryService.addTurn(
          telegramId,
          'user',
          message.question,
          message.language,
          { messageType: message.messageType, mongoId: message._id }
        );

        if (message.answer) {
          ConversationMemoryService.addTurn(
            telegramId,
            'model',
            message.answer,
            message.language,
            { aiModel: message.aiModel, mongoId: message._id }
          );
        }
      }
    } catch (err) {
      logger.warn('ChatService: Failed to restore conversation memory', {
        telegramId,
        error: err.message,
      });
    }
  }

  /**
   * Get in-memory conversation history (for real-time context).
   */
  getConversationMemory(telegramId, limit = 10) {
    return ConversationMemoryService.getHistory(telegramId, limit);
  }

  /**
   * Get conversation context formatted for Gemini.
   */
  getContextForGemini(telegramId, currentQuestion) {
    return ConversationMemoryService.buildContextForGemini(telegramId, currentQuestion);
  }

  /**
   * Detect if current question is a follow-up.
   */
  detectFollowup(telegramId, currentQuestion) {
    return ConversationMemoryService.detectFollowup(telegramId, currentQuestion);
  }

  /**
   * Get referenced entities from conversation.
   */
  getReferencedEntities(telegramId) {
    return ConversationMemoryService.getReferencedEntities(telegramId);
  }

  /**
   * Clear conversation memory for a user.
   */
  clearMemory(telegramId) {
    ConversationMemoryService.clearHistory(telegramId);
  }
}

module.exports = new ChatService();
