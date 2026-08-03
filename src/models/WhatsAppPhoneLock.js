const mongoose = require('mongoose');

// A short MongoDB lease ensures only one replica processes a phone's queue.
const WhatsAppPhoneLockSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true, index: true },
  ownerId: { type: String, required: true },
  lockedUntil: { type: Date, required: true, index: true },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('WhatsAppPhoneLock', WhatsAppPhoneLockSchema);
