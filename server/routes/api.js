const express = require('express');
const router = express.Router();
const Webhook = require('../models/webhook');
const Message = require('../models/message');

// --- tuning knobs -----------------------------------------------------------
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// Counting every match on a 100M-doc collection is a full index scan (~20s).
// We count at most COUNT_CAP+1 and render anything past that as "10,000+".
const COUNT_CAP = 10000;
// Hard ceiling so a pathological query can never pin a mongod core indefinitely.
const QUERY_TIMEOUT_MS = 5000;
// strength:2 == case-insensitive. MUST match the collation on the recipient_ci
// index, or the query silently degrades to a full collection scan.
const CI_COLLATION = { locale: 'en', strength: 2 };

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isFullAddress = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const toUnix = (d, endOfDay) => {
  const ms = Date.parse(endOfDay ? `${d}T23:59:59.999Z` : `${d}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

/**
 * Translate query params into a Mongo filter that an index can actually serve.
 *
 * The old code used { $regex: input, $options: 'i' } for recipient and subject.
 * An unanchored case-insensitive regex cannot seek into a b-tree, so every one
 * of those searches examined *every* key in the index — 100M reads to return 20
 * rows. See docs/PERFORMANCE.md for the measurements.
 *
 * match=contains restores the old substring behaviour for the rare case where
 * it's genuinely needed; it is slow by construction and guarded by maxTimeMS.
 */
function buildQuery({ event, recipient, subject, startDate, endDate, match }) {
  const query = {};
  let collation = null;
  const contains = match === 'contains';

  if (event) query.event = event;

  if (recipient) {
    const r = recipient.trim();
    if (contains) {
      query.recipient = { $regex: escapeRegex(r), $options: 'i' };
    } else if (isFullAddress(r)) {
      // Index seek against recipient_ci. 1 key examined instead of 100M.
      query.recipient = r;
      collation = CI_COLLATION;
    } else {
      // Anchored prefix against the plain recipient index. Case-sensitive by
      // necessity (regex ignores collation), so normalise to lowercase —
      // Mailgun delivers recipients already lowercased.
      query.recipient = { $regex: `^${escapeRegex(r.toLowerCase())}` };
    }
  }

  if (subject) {
    const s = subject.trim();
    query['message.headers.subject'] = contains
      ? { $regex: escapeRegex(s), $options: 'i' }
      : { $regex: `^${escapeRegex(s)}` };
  }

  // timestamp is a Number (unix seconds), not a Date. Comparing it against a
  // Date object never matches under BSON type ordering — the old code's date
  // filter silently returned zero rows.
  if (startDate || endDate) {
    const range = {};
    const from = startDate && toUnix(startDate, false);
    const to = endDate && toUnix(endDate, true);
    if (from !== null && from !== undefined) range.$gte = from;
    if (to !== null && to !== undefined) range.$lte = to;
    if (Object.keys(range).length) query.timestamp = range;
  }

  return { query, collation };
}

router.get('/messages/:id', async (req, res) => {
  try {
    const message = await Message.findOne({ messageId: req.params.id })
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean();
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json(message);
  } catch (error) {
    console.error('Error fetching message:', error);
    res.status(500).json({ error: 'Error fetching message' });
  }
});

router.get('/webhooks', async (req, res) => {
  try {
    const { query, collation } = buildQuery(req.query);

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    // skip() walks every skipped key, so cap the reachable page depth. The
    // capped count already stops the UI rendering pages past this point.
    const maxPage = Math.ceil(COUNT_CAP / limit);
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), maxPage);

    const isUnfiltered = Object.keys(query).length === 0;

    const findQ = Webhook.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean();
    if (collation) findQ.collation(collation);

    // An unfiltered count is pure metadata (~2ms); countDocuments({}) scans the
    // whole collection (~20s at 100M) for the identical answer.
    let countQ;
    if (isUnfiltered) {
      countQ = Webhook.estimatedDocumentCount();
    } else {
      countQ = Webhook.countDocuments(query)
        .limit(COUNT_CAP + 1)
        .maxTimeMS(QUERY_TIMEOUT_MS);
      if (collation) countQ.collation(collation);
    }

    const [webhooks, rawTotal] = await Promise.all([findQ, countQ]);

    const totalIsExact = isUnfiltered || rawTotal <= COUNT_CAP;
    const total = totalIsExact ? rawTotal : COUNT_CAP;

    res.json({
      webhooks,
      total,
      totalIsExact,
      pages: Math.min(Math.ceil(total / limit), maxPage)
    });
  } catch (error) {
    if (error.name === 'MongoServerError' && error.code === 50) {
      return res.status(504).json({
        error: 'Search timed out. Narrow the search — a full email address or a date range is much faster than a partial match.'
      });
    }
    console.error('Error fetching webhooks:', error);
    res.status(500).json({ error: 'Error fetching webhooks' });
  }
});

router.get('/webhooks/:id', async (req, res) => {
  try {
    const webhook = await Webhook.findById(req.params.id).lean();
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const messageId = webhook.message && webhook.message.headers
      ? webhook.message.headers['message-id']
      : null;

    // Served by the {message.headers.message-id, timestamp} index.
    const relatedEvents = messageId
      ? await Webhook.find({ 'message.headers.message-id': messageId })
          .sort({ timestamp: 1 })
          .limit(MAX_LIMIT)
          .maxTimeMS(QUERY_TIMEOUT_MS)
          .lean()
      : [];

    res.json({ webhook, relatedEvents });
  } catch (error) {
    console.error('Error fetching webhook:', error);
    res.status(500).json({ error: 'Error fetching webhook' });
  }
});

module.exports = router;
