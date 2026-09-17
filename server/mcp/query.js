const mongoose = require('mongoose');

const COLLECTIONS = ['webhooks', 'messages'];

const DEFAULTS = {
  limit: 50,
  maxLimit: 1000,
  maxTimeMS: 15000,
  maxTimeCeiling: 120000,
  maxBytes: 100000,
};

// Stages that write to a collection.
const WRITE_STAGES = ['$out', '$merge'];
// Operators that execute JavaScript on the server.
const JS_OPERATORS = ['$function', '$where', '$accumulator'];
const FORBIDDEN = [...WRITE_STAGES, ...JS_OPERATORS];

/**
 * Reject write stages and server-side JavaScript anywhere in a pipeline.
 *
 * This recurses into every nested object and array, because $out, $merge and
 * friends can hide inside $facet, $lookup.pipeline and $unionWith.pipeline. A
 * top-level-only scan is trivially bypassed.
 */
function assertReadOnlyPipeline(pipeline) {
  if (!Array.isArray(pipeline)) {
    throw new Error('pipeline must be an array of aggregation stages');
  }

  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN.includes(key)) {
        throw new Error(
          `${key} is not permitted: this endpoint is read-only. ` +
          `Forbidden anywhere in a pipeline, including nested inside $facet, ` +
          `$lookup.pipeline and $unionWith.pipeline: ${FORBIDDEN.join(', ')}.`
        );
      }
      walk(node[key]);
    }
  })(pipeline);
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const toObjectId = (v) =>
  typeof v === 'string' && OBJECT_ID_RE.test(v) ? new mongoose.Types.ObjectId(v) : v;

/**
 * Convert 24-hex `_id` strings to ObjectId.
 *
 * Queries go through the raw driver rather than the Mongoose models — Mongoose
 * silently drops filter paths absent from the schema, and the schema
 * deliberately omits Mailgun's dashed keys — so the one piece of Mongoose
 * casting worth keeping has to be reapplied by hand.
 */
function coerceIds(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return filter;

  const out = { ...filter };
  if ('_id' in out) {
    const v = out._id;
    if (typeof v === 'string') {
      out._id = toObjectId(v);
    } else if (v && typeof v === 'object' && Array.isArray(v.$in)) {
      out._id = { ...v, $in: v.$in.map(toObjectId) };
    }
  }
  return out;
}

/**
 * Serialize documents up to a byte budget.
 *
 * A large result set would exhaust the agent's context window before it could
 * summarize anything, so the response channel is bounded independently of the
 * query.
 */
function truncateDocs(docs, maxBytes = DEFAULTS.maxBytes) {
  const kept = [];
  let bytes = 0;

  for (const doc of docs) {
    const size = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (bytes + size > maxBytes) {
      return { docs: kept, returned: kept.length, truncated: true };
    }
    kept.push(doc);
    bytes += size;
  }

  return { docs: kept, returned: kept.length, truncated: false };
}

module.exports = {
  COLLECTIONS,
  DEFAULTS,
  assertReadOnlyPipeline,
  coerceIds,
  truncateDocs,
};
