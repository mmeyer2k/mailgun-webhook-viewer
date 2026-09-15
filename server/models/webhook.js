const mongoose = require('mongoose');

const webhookSchema = new mongoose.Schema({
  event: {
    type: String,
    required: true,
    enum: ['accepted', 'delivered', 'opened', 'clicked', 'unsubscribed', 'complained', 'failed', 'permanent_fail', 'temporary_fail']
  },
  timestamp: {
    type: Number
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

// ---------------------------------------------------------------------------
// Indexes. This collection holds ~100M documents, so every index costs real RAM
// (~1.5GB per simple index at that scale) and slows every webhook insert. Each
// one below maps to exactly one query in server/routes/api.js. Do not add an
// index without a query that uses it, and check `$indexStats` before adding one.
//
// IMPORTANT: build these with scripts/migrate-indexes.js, not via Mongoose
// autoIndex on boot — see server/index.js.
// ---------------------------------------------------------------------------

// Unfiltered list page: find({}).sort({timestamp:-1}).
// A single-field index is walked in either direction, so this also serves any
// ascending timestamp sort. No separate {timestamp: 1} needed.
webhookSchema.index({ timestamp: -1 });

// Event filter + timestamp sort. Equality field FIRST, then the sort field
// (the ESR rule). The old {timestamp:-1, event:1} had this backwards, which
// made Mongo walk the index in timestamp order filtering as it went; measured
// 228 keys examined vs 20 for the same 20 rows.
webhookSchema.index({ event: 1, timestamp: -1 });

// Recipient prefix search (anchored, case-sensitive) + timestamp sort.
webhookSchema.index({ recipient: 1, timestamp: -1 });

// Exact recipient lookup, case-insensitively. strength:2 makes the index itself
// case-folded so find({recipient}).collation(CI_COLLATION) is a single-key seek
// rather than a 100M-key scan. The collation here MUST stay in sync with
// CI_COLLATION in server/routes/api.js.
webhookSchema.index(
  { recipient: 1, timestamp: -1 },
  { name: 'recipient_ci', collation: { locale: 'en', strength: 2 } }
);

// Subject prefix search + timestamp sort.
webhookSchema.index({ 'message.headers.subject': 1, timestamp: -1 });

// Timeline lookup in GET /api/webhooks/:id (all events for one message).
webhookSchema.index({ 'message.headers.message-id': 1, timestamp: 1 });

// Deliberately NOT indexed:
//   { recipient: 'text', 'message.headers.subject': 'text' }
//     A text index was declared here but no query ever used $text. It measured
//     150MB per 3M docs (~5GB at 100M) of pure write and RAM overhead.
//   { timestamp: 1 } and { timestamp: -1, event: 1 }
//     Redundant with the two indexes above; the planner never chose either.

module.exports = mongoose.model('Webhook', webhookSchema); 