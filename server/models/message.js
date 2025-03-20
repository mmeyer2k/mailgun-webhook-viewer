const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    index: true
  },
  'body-html': String,
  'body-plain': String,
  attachments: [{
    type: Object
  }],
  'message-headers': [[String]],
}, { 
  timestamps: false,
  strict: true
});

// Indexes
messageSchema.index({ 'headers.MessageId': 1 });
messageSchema.index({ 'headers.Subject': 1 });
messageSchema.index({ 'headers.To': 1 });

module.exports = mongoose.model('Message', messageSchema); 