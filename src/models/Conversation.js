/**
 * Durable conversation turn used to restore short-term memory after restarts.
 * ChatMessage remains the existing audit record; this model stores one turn per
 * user or assistant message so Gemini history can be loaded efficiently.
 */
const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true,
    },
    message: {
      type: String,
      required: true,
      maxlength: 8000,
    },
    language: {
      type: String,
      enum: ['en', 'hi', 'mr'],
      default: 'en',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Supports the latest-history query used when a RAM cache expires or restarts.
ConversationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Conversation', ConversationSchema);
