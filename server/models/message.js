const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    index: true
  },
  headers: {
    'Content-Transfer-Encoding': String,
    'Content-Type': String,
    'Date': Date,
    'From': String,
    'Message-Id': String,
    'Mime-Version': String,
    'Subject': String,
    'To': String,
    'X-Order-Number': String,
    sender: String,
    recipients: String,
    from: String,
    subject: String
  },
  content: {
    'body-html': String,
    'body-plain': String,
    'stripped-html': String,
    'stripped-text': String,
    'stripped-signature': String
  },
  attachments: [{
    type: Object
  }],
  'content-id-map': {
    type: Object
  },
  'message-headers': [[String]],
  downloadedAt: Date,
  storageUrl: String,
  storageKey: String
}, { timestamps: true });

// Index for faster lookups
messageSchema.index({ 'headers.Message-Id': 1 });
messageSchema.index({ 'headers.Subject': 1 });
messageSchema.index({ 'headers.To': 1 });

module.exports = mongoose.model('Message', messageSchema); 