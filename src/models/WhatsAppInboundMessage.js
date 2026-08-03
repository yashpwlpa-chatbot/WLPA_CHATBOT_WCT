const mongoose = require('mongoose');

// One durable record per Meta message ID provides cross-instance idempotency.
const WhatsAppInboundMessageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true, index: true },
  phoneNumber: { type: String, required: true, index: true },
  message: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  processingStartedAt: { type: Date, default: null },
  processedAt: { type: Date, default: null },
  error: { type: String, default: null },
}, { timestamps: true, versionKey: false });

WhatsAppInboundMessageSchema.index({ phoneNumber: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model('WhatsAppInboundMessage', WhatsAppInboundMessageSchema);
