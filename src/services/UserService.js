/**
 * UserService
 * -----------
 * Encapsulates all DB operations for the User collection.
 * The bot only talks to services, never to Mongoose models directly,
 * so swapping storage in the future is a single-file change.
 */

const User = require('../models/User');
const logger = require('../utils/logger');

class UserService {
  /**
   * Idempotent upsert: create user if missing, otherwise refresh profile
   * fields and bump lastActiveAt. Always returns the user document.
   */
  async upsertFromTelegram(telegramUser, preferredLanguage) {
    if (!telegramUser || !telegramUser.id) {
      throw new Error('UserService.upsertFromTelegram: missing telegramUser.id');
    }

    const now = new Date();
    const update = {
      $set: {
        telegramId: telegramUser.id,
        username: telegramUser.username || null,
        firstName: telegramUser.first_name || '',
        lastName: telegramUser.last_name || '',
        preferredLanguage,
        lastActiveAt: now,
      },
    };

    try {
      const user = await User.findOneAndUpdate(
        { telegramId: telegramUser.id },
        update,
        {
          new: true,
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        }
      );

      logger.debug('User upserted', {
        telegramId: user.telegramId,
        language: user.preferredLanguage,
      });
      return user;
    } catch (err) {
      logger.error('UserService.upsertFromTelegram failed', { error: err.message });
      throw err;
    }
  }

  /**
   * Idempotent upsert: create or update user by WhatsApp phone number.
   */
  async upsertFromWhatsApp(phoneNumber, preferredLanguage = 'en') {
    if (!phoneNumber) {
      throw new Error('UserService.upsertFromWhatsApp: missing phoneNumber');
    }

    const now = new Date();
    const update = {
      $set: {
        whatsappId: phoneNumber,
        preferredLanguage,
        lastActiveAt: now,
      },
    };

    try {
      const user = await User.findOneAndUpdate(
        { whatsappId: phoneNumber },
        update,
        {
          new: true,
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        }
      );

      logger.debug('User upserted (WhatsApp)', {
        whatsappId: user.whatsappId,
        language: user.preferredLanguage,
      });
      return user;
    } catch (err) {
      logger.error('UserService.upsertFromWhatsApp failed', { error: err.message });
      throw err;
    }
  }

  async findByTelegramId(telegramId) {
    return User.findOne({ telegramId });
  }

  async updatePreferredLanguage(telegramId, language) {
    return User.findOneAndUpdate(
      { telegramId },
      { $set: { preferredLanguage: language, lastActiveAt: new Date() } },
      { new: true }
    );
  }
}

module.exports = new UserService();
