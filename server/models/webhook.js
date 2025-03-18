const mongoose = require('mongoose');

const webhookSchema = new mongoose.Schema({
  event: {
    type: String,
    required: true,
    index: true,
    enum: ['accepted', 'delivered', 'opened', 'clicked', 'unsubscribed', 'complained', 'failed', 'permanent_fail', 'temporary_fail']
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  eventId: {   // Mailgun's event ID (unique within a day)
    type: String,
    index: true
  },
  recipient: {
    type: String,
    required: true,
    index: true
  },
  message: {
    headers: {
      messageId: String,
      subject: {
        type: String,
        index: true
      },
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
  signature: {
    timestamp: String,
    token: String,
    signature: String
  },
  rawData: Object
}, { timestamps: true });

// Compound index for timestamp-based sorting with filters
webhookSchema.index({ timestamp: -1, recipient: 1 });
webhookSchema.index({ timestamp: -1, 'message.headers.subject': 1 });

// Compound index for message ID lookups with timestamp
webhookSchema.index({ 'message.headers.messageId': 1, timestamp: 1 });

module.exports = mongoose.model('Webhook', webhookSchema); 