/**
 * ChatMessage schema.
 * One document per user ↔ bot interaction (text or voice).
 * Indexed by userId + createdAt for fast history retrieval.
 *
 * Fields:
 *   - userId        : ObjectId reference to User
 *   - telegramId    : denormalized for cheap lookups
 *   - messageType   : 'text' | 'voice'
 *   - question      : final question string sent to Gemini
 *                     (for voice, this equals the transcription)
 *   - transcription : raw Whisper output (only for voice)
 *   - answer        : Gemini response
 *   - language      : language code used for the response
 *   - aiModel       : e.g. 'gemini-1.5-flash'
 *   - metadata      : free-form bag (timings, token usage, etc.)
 *   - error         : populated if the interaction failed
 */
const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    telegramId: {
      type: Number,
      required: true,
      index: true,
    },
    messageType: {
      type: String,
      enum: ['text', 'voice'],
      required: true,
    },
    question: {
      type: String,
      required: true,
      maxlength: 4000,
    },
    transcription: {
      type: String,
      default: null,
      maxlength: 4000,
    },
    answer: {
      type: String,
      default: '',
      maxlength: 8000,
    },
    language: {
      type: String,
      enum: ['en', 'hi', 'mr'],
      default: 'en',
    },
    aiModel: {
      type: String,
      default: '',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    error: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// Compound index for "give me this user's last N messages".
ChatMessageSchema.index({ userId: 1, createdAt: -1 });
ChatMessageSchema.index({ telegramId: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
