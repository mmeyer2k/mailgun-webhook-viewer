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
// messageId (declared above) is the only queried field — both
// GET /api/messages/:id and the dedupe check in routes/webhook.js look it up.
//
// Deliberately NOT indexed: 'headers.MessageId', 'headers.Subject', 'headers.To'
// were declared here, but this schema has no `headers` path (Mailgun's field is
// `message-headers`, an array of [name, value] pairs). Every document indexed as
// null under all three — three full-size indexes storing nothing queryable.

module.exports = mongoose.model('Message', messageSchema); 