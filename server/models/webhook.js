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

// Compound indexes for common query patterns
// Index for sorting by timestamp with event filter
webhookSchema.index({ timestamp: -1, event: 1 });

// Index for recipient search with timestamp sorting
webhookSchema.index({ recipient: 1, timestamp: -1 });

// Index for subject search with timestamp sorting  
webhookSchema.index({ 'message.headers.subject': 1, timestamp: -1 });

// Index for message ID lookups (fix field name - should be 'message-id' not 'messageId')
webhookSchema.index({ 'message.headers.message-id': 1, timestamp: 1 });

// Index for timestamp range queries
webhookSchema.index({ timestamp: -1 });

// Text index for faster full-text search on recipient and subject
// Note: MongoDB text indexes can only have one per collection, so we prioritize
// recipient as it's likely more commonly searched
webhookSchema.index({ recipient: 'text', 'message.headers.subject': 'text' });

module.exports = mongoose.model('Webhook', webhookSchema); 