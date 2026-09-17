/**
 * Turn a queryPlanner explain document into a scan verdict.
 *
 * Stage names alone are NOT sufficient. Measured against MongoDB 8.3 with this
 * repo's indexes, the unanchored case-insensitive regex — the 22-second query
 * in docs/PERFORMANCE.md — plans as IXSCAN. MongoDB does use the index; it just
 * walks every key. Checking for COLLSCAN would pass the worst query here
 * straight through.
 *
 * The real signal is the index bounds on the LEADING field:
 *
 *   ["user5@gmail.com", "user5@gmail.com"]  point seek
 *   ["user5", "user6")                      bounded range
 *   ["", {})                                every key
 *   [MinKey, MaxKey]                        every key
 *
 * Only the leading field counts. A trailing [MaxKey, MinKey] on the sort field
 * appears in perfectly healthy plans.
 */

// Bound strings meaning "every key". leadingBoundOf() normalises COUNT_SCAN's
// {startKey, endKey} shape into this same rendering.
const UNBOUNDED = new Set(['[MinKey, MaxKey]', '[MaxKey, MinKey]', '["", {})']);

// Stages that must consume their entire input before emitting a row, so a
// limit cannot rescue them.
const BLOCKING_STAGES = new Set(['SORT', 'GROUP']);

const SEEK_STAGES = new Set(['IXSCAN', 'IDHACK', 'COUNT_SCAN', 'DISTINCT_SCAN']);

function isUnboundedBound(bound) {
  return UNBOUNDED.has(bound);
}

/**
 * Collect every stage node from an explain document, at any depth.
 *
 * One traversal covers all the shapes: classic `winningPlan.inputStage`
 * nesting, SBE's `winningPlan.queryPlan`, aggregate plans whose `queryPlanner`
 * sits at the top level on 8.x, and older servers that nest it under
 * `stages[0].$cursor`.
 */
function collectStages(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => collectStages(child, out));
    return out;
  }
  if (typeof node.stage === 'string') {
    out.push(node);
  }
  Object.values(node).forEach((child) => collectStages(child, out));
  return out;
}

/** Explain renders MinKey/MaxKey as {"_bsontype": "MinKey"} once serialized. */
function bsonLabel(v) {
  if (v && typeof v === 'object' && v._bsontype) return v._bsontype;
  return JSON.stringify(v);
}

/**
 * The bound on the scan's LEADING index field.
 *
 * Two shapes exist, verified against real explain output:
 *   IXSCAN     {recipient: ['["a", "a"]'], timestamp: ['[MaxKey, MinKey]']}
 *   COUNT_SCAN {startKey: {event: 'delivered', ...}, endKey: {...}, ...}
 * Treating the second like the first reads "startKey" as a field name and
 * silently classifies every covered count as a seek.
 */
function leadingBoundOf(scan) {
  const bounds = scan.indexBounds;
  if (!bounds || typeof bounds !== 'object') return null;

  if (bounds.startKey && typeof bounds.startKey === 'object') {
    const field = Object.keys(bounds.startKey)[0];
    if (!field) return null;
    const lo = bsonLabel(bounds.startKey[field]);
    const hi = bsonLabel(bounds.endKey ? bounds.endKey[field] : undefined);
    return `[${lo}, ${hi}]`;
  }

  const first = Object.keys(bounds)[0];
  if (!first) return null;
  const entries = bounds[first];
  return Array.isArray(entries) ? entries[0] : null;
}

function analyzePlan(explainDoc, { hasFilter, hasLimit } = {}) {
  const stages = collectStages(explainDoc);
  const names = stages.map((s) => s.stage);

  const blockingStages = [...new Set(names.filter((n) => BLOCKING_STAGES.has(n)))];
  const collScan = stages.find((s) => s.stage === 'COLLSCAN');
  const seekStage = stages.find((s) => SEEK_STAGES.has(s.stage));

  const indexUsed = seekStage ? seekStage.indexName || null : null;
  const leadingBound = seekStage ? leadingBoundOf(seekStage) : null;

  let scanType = 'indexSeek';
  if (collScan) {
    scanType = 'collectionScan';
  } else if (leadingBound && isUnboundedBound(leadingBound)) {
    scanType = 'fullIndexScan';
  }

  const warnings = [];

  // An unbounded scan with no filter and a limit is the unfiltered list query:
  // it stops after `limit` keys and is genuinely cheap. A limit does NOT rescue
  // a selective filter over an unbounded bound — that is exactly the 22-second
  // case, where the scan runs to the end of the index to find its few matches.
  const rescuedByLimit = !hasFilter && hasLimit && blockingStages.length === 0;

  if (scanType === 'collectionScan' && !rescuedByLimit) {
    warnings.push(
      'Full collection scan. Every document will be read. On the webhooks ' +
      'collection (~100M documents) this will almost certainly exceed the ' +
      'timeout. Filter on an indexed field — call describe_collection to see ' +
      'which fields are indexed.'
    );
  } else if (scanType === 'fullIndexScan' && !rescuedByLimit) {
    warnings.push(
      `Full index scan of ${indexUsed}. The leading field's bounds are ` +
      `${leadingBound}, so every key in the index is read. On the webhooks ` +
      'collection (~100M documents) this measured 22s in docs/PERFORMANCE.md. ' +
      'An unanchored case-insensitive $regex is the usual cause: use an exact ' +
      "match with collation {locale:'en',strength:2} (index recipient_ci), or " +
      'an anchored /^prefix/ instead.'
    );
  }

  if (blockingStages.length > 0 && warnings.length > 0) {
    warnings.push(
      `The plan also contains blocking stage(s) ${blockingStages.join(', ')}, ` +
      'which must consume the entire input before producing a row, so a limit ' +
      'will not bound this.'
    );
  }

  return { scanType, indexUsed, leadingBound, blockingStages, warnings };
}

module.exports = { analyzePlan, isUnboundedBound, collectStages };
