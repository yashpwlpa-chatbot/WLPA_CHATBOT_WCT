/**
 * User schema.
 * One document per Telegram user.
 *
 * Fields:
 *   - telegramId        : numeric Telegram user id (required, unique)
 *   - username          : @handle (may be null)
 *   - firstName         : from Telegram profile
 *   - lastName          : from Telegram profile (may be empty)
 *   - preferredLanguage : ISO 639-1 code (en | hi | mr)
 *   - lastActiveAt      : timestamp of most recent interaction
 *   - createdAt / updatedAt : managed by Mongoose timestamps
 */
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    telegramId: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    username: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },
    firstName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 128,
    },
    lastName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 128,
    },
    preferredLanguage: {
      type: String,
      enum: ['en', 'hi', 'mr'],
      default: 'en',
      index: true,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

module.exports = mongoose.model('User', UserSchema);
