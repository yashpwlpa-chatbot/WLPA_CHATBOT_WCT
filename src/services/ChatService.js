/**
 * ChatService
 * -----------
 * Persists every interaction to MongoDB for audit trail.
 * Also maintains in-memory conversation history via ConversationMemoryService
 * for real-time context in follow-up questions.
 */

const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
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
    sessionId = null,
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

    // Store each turn through the hybrid memory service for RAM speed and durable recovery.
    const activeSessionId = sessionId || telegramId;
    if (activeSessionId && question) {
      try {
        await ConversationMemoryService.addPersistentTurn(activeSessionId, userId, 'user', question, language, {
          messageType,
          transcription,
          metadata,
          mongoId: mongoDoc?._id
        });

        // Keep the generated answer as a separate assistant turn for Gemini context.
        if (answer) {
          await ConversationMemoryService.addPersistentTurn(activeSessionId, userId, 'model', answer, language, {
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
  async getRecentForUser(userId, telegramId, limit = 20) {
    const query = userId ? { userId } : { telegramId };
    return ChatMessage.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('question answer language messageType aiModel createdAt')
      .lean();
  }

  /**
   * Restore recent persisted messages when the process has no in-memory history.
   * This keeps Telegram follow-up questions meaningful after a server restart.
   */
  async ensureConversationMemory(sessionId, telegramId = null) {
    if (!sessionId) return null;

    try {
      // Resolve the User reference required by the durable Conversation model.
      let user = null;
      if (telegramId) {
        user = await User.findOne({ telegramId }).select('_id').lean();
      } else {
        // If it's WhatsApp, the sessionId is the phoneNumber, so find by whatsappId
        user = await User.findOne({ whatsappId: sessionId }).select('_id').lean();
      }
      
      await ConversationMemoryService.ensureLoaded(sessionId, user?._id);

      if (ConversationMemoryService.getHistory(sessionId, 1).length > 0) {
        return user?._id || null;
      }

      // Preserve access to existing ChatMessage records until they naturally age out.
      const messages = await this.getRecentForUser(user?._id, telegramId, 10);
      for (const message of messages.reverse()) {
        ConversationMemoryService.addTurn(
          sessionId,
          'user',
          message.question,
          message.language,
          { messageType: message.messageType, mongoId: message._id }
        );

        if (message.answer) {
          ConversationMemoryService.addTurn(
            sessionId,
            'model',
            message.answer,
            message.language,
            { aiModel: message.aiModel, mongoId: message._id }
          );
        }
      }

      // Callers pass this verified owner to Gemini for a second ownership-safe load.
      return user?._id || null;
    } catch (err) {
      logger.warn('ChatService: Failed to restore conversation memory', {
        sessionId,
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Get in-memory conversation history (for real-time context).
   */
  getConversationMemory(sessionId, limit = 10) {
    return ConversationMemoryService.getHistory(sessionId, limit);
  }

  /**
   * Get conversation context formatted for Gemini.
   */
  getContextForGemini(sessionId, currentQuestion) {
    return ConversationMemoryService.buildContextForGemini(sessionId, currentQuestion);
  }

  /**
   * Detect if current question is a follow-up.
   */
  detectFollowup(sessionId, currentQuestion) {
    return ConversationMemoryService.detectFollowup(sessionId, currentQuestion);
  }

  /**
   * Get referenced entities from conversation.
   */
  getReferencedEntities(sessionId) {
    return ConversationMemoryService.getReferencedEntities(sessionId);
  }

  /**
   * Clear conversation memory for a user.
   */
  clearMemory(sessionId) {
    ConversationMemoryService.clearHistory(sessionId);
  }
}

module.exports = new ChatService();
