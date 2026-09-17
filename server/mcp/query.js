const mongoose = require('mongoose');

const COLLECTIONS = ['webhooks', 'messages'];

const DEFAULTS = {
  limit: 50,
  maxLimit: 1000,
  maxTimeMS: 15000,
  maxTimeCeiling: 120000,
  maxBytes: 100000,
  // skip() walks every key it skips. api.js caps reachable depth the same way.
  maxSkip: 10000,
  // This process also hosts webhook ingestion. A handful of 120s analytical
  // queries is fine; an unbounded number is how one caller takes it down.
  maxConcurrent: 4,
};

// Stages that write to a collection.
const WRITE_STAGES = ['$out', '$merge'];
// Operators that execute JavaScript on the server.
const JS_OPERATORS = ['$function', '$where', '$accumulator'];
const FORBIDDEN = [...WRITE_STAGES, ...JS_OPERATORS];

// Stages that read from ANOTHER collection. The `collection` tool parameter
// only scopes the primary collection; these must be held to the same list.
const LOOKUP_STAGES = ['$lookup', '$graphLookup', '$unionWith'];

function assertLookupTarget(stage, spec) {
  // $unionWith accepts a bare string as shorthand for { coll: "<name>" };
  // $lookup and $graphLookup are object-only. Normalise to the target name
  // first, then hold every form to the same list.
  let target;
  if (typeof spec === 'string') {
    target = spec;
  } else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    // $lookup uses `from`; $unionWith uses `coll`. A $lookup with neither is
    // the $documents form, which reads no collection and is fine.
    target = spec.from !== undefined ? spec.from : spec.coll;
  } else {
    return;
  }
  if (target === undefined) return;
  if (typeof target !== 'string' || !COLLECTIONS.includes(target)) {
    throw new Error(
      `${stage} may only target ${COLLECTIONS.join(' or ')}; got ` +
      `${JSON.stringify(target)}. The cross-database {db, coll} form is not permitted.`
    );
  }
}

/**
 * Reject write stages, server-side JavaScript, and out-of-scope lookup
 * targets anywhere in a user-supplied query object.
 *
 * This is the read-only boundary. There is no read-only database user behind
 * this endpoint, so the walk has to be complete: it recurses into every nested
 * object and array, because $out and $function can hide inside $facet,
 * $lookup.pipeline, $unionWith.pipeline, and $expr. It applies to EVERY object
 * the caller controls — filter, projection, sort and pipeline alike — because
 * a find filter accepts $where and $expr:{$function} just as a pipeline does.
 */
function assertNoForbiddenOperators(value, what = 'query') {
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN.includes(key)) {
        throw new Error(
          `${key} is not permitted in ${what}: this endpoint is read-only and ` +
          `does not execute server-side JavaScript. Forbidden anywhere, at any ` +
          `depth: ${FORBIDDEN.join(', ')}.`
        );
      }
      if (LOOKUP_STAGES.includes(key)) {
        assertLookupTarget(key, node[key]);
      }
      walk(node[key]);
    }
  })(value);
}

function assertReadOnlyPipeline(pipeline) {
  if (!Array.isArray(pipeline)) {
    throw new Error('pipeline must be an array of aggregation stages');
  }
  assertNoForbiddenOperators(pipeline, 'pipeline');
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
 * Drain a cursor up to a byte budget and a document count, then close it.
 *
 * The previous shape — toArray() then trim — materialised the ENTIRE result
 * before trimming. An aggregate with no $limit over 100M documents would try
 * to hold all of it in the Node process that also runs webhook ingestion.
 * Reading one document at a time and stopping at the first bound hit keeps
 * peak memory proportional to the budget, not the result.
 */
async function collectBounded(cursor, { maxBytes = DEFAULTS.maxBytes, maxDocs = DEFAULTS.maxLimit } = {}) {
  const docs = [];
  let bytes = 0;
  let truncated = false;

  try {
    while (docs.length < maxDocs && (await cursor.hasNext())) {
      const doc = await cursor.next();
      const size = Buffer.byteLength(JSON.stringify(doc), 'utf8');
      if (bytes + size > maxBytes) {
        truncated = true;
        break;
      }
      docs.push(doc);
      bytes += size;
    }
    if (!truncated && docs.length >= maxDocs && (await cursor.hasNext())) {
      truncated = true;
    }
  } finally {
    await Promise.resolve(cursor.close()).catch(() => {});
  }

  return { docs, returned: docs.length, truncated };
}

module.exports = {
  COLLECTIONS,
  DEFAULTS,
  assertNoForbiddenOperators,
  assertReadOnlyPipeline,
  coerceIds,
  collectBounded,
};
