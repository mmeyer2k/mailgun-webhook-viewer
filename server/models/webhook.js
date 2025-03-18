const mongoose = require('mongoose');

const webhookSchema = new mongoose.Schema({
  event: {
    type: String,
    required: true,
    index: true,
    enum: ['accepted', 'delivered', 'opened', 'clicked', 'unsubscribed', 'complained', 'failed', 'permanent_fail', 'temporary_fail']
  },
  timestamp: {
    type: Number,
    index: true
  },
  id: String,
  recipient: String,
  message: {
    headers: {
      'message-id': String,
      subject: String,
      from: String,
      to: String
    }
  },
  tags: [String],
  clientInfo: {
    clientName: String,
    clientType: String,
    userAgent: String,
    deviceType: String,
    clientOs: String,
    bot: String
  },
  geolocation: {
    country: String,
    region: String,
    city: String
  },
  delivery: {
    status: String,
    code: Number,
    description: String,
    mxHost: String
  },
  storage: {
    url: String,
    key: String
  },
  reason: String,
}, { timestamps: true });

// Compound index for timestamp-based sorting with filters
webhookSchema.index({ timestamp: -1, recipient: 1 });
webhookSchema.index({ timestamp: -1, 'message.headers.subject': 1 });

// Compound index for message ID lookups with timestamp
webhookSchema.index({ 'message.headers.messageId': 1, timestamp: 1 });

module.exports = mongoose.model('Webhook', webhookSchema); 