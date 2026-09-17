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
 *
 * EVERY seek stage in the plan is classified, not just the first one. An $or
 * plans as one IXSCAN per branch, and a $lookup sub-pipeline contributes its
 * own $cursor stage; a plan whose first branch seeks a single recipient and
 * whose second reads every key in the index is a full index scan, and reading
 * only the first stage reports it as clean. Likewise a single leading field
 * can carry several intervals, so all of them are checked.
 */

// Bound strings meaning "every key". leadingBounds() normalises COUNT_SCAN's
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
  for (const [key, child] of Object.entries(node)) {
    // rejectedPlans holds complete stage trees for candidates the planner
    // DISCARDED, and allPlansExecution does the same under executionStats
    // verbosity. Walking them lets a rejected COLLSCAN misclassify the fast
    // winning IXSCAN beside it — which would block the exact-recipient lookup
    // this gate exists to let through.
    if (key === 'rejectedPlans' || key === 'allPlansExecution') continue;
    collectStages(child, out);
  }
  return out;
}

/** Explain renders MinKey/MaxKey as {"_bsontype": "MinKey"} once serialized. */
function bsonLabel(v) {
  if (v && typeof v === 'object' && v._bsontype) return v._bsontype;
  return JSON.stringify(v);
}

/**
 * EVERY bound on the scan's LEADING index field, as an array of strings.
 *
 * Two shapes exist, verified against real explain output:
 *   IXSCAN     {recipient: ['["a", "a"]'], timestamp: ['[MaxKey, MinKey]']}
 *   COUNT_SCAN {startKey: {event: 'delivered', ...}, endKey: {...}, ...}
 * Treating the second like the first reads "startKey" as a field name and
 * silently classifies every covered count as a seek, so it is normalised into
 * a one-element array holding the same [lo, hi] rendering.
 *
 * The leading field is an ARRAY because one field can be scanned over several
 * intervals — {recipient: {$in: [...]}} or an $or folded into one scan. If any
 * one of them is unbounded the whole scan walks the index, so the caller has
 * to see all of them, not just the first.
 */
function leadingBounds(scan) {
  const bounds = scan.indexBounds;
  if (!bounds || typeof bounds !== 'object') return [];

  if (bounds.startKey && typeof bounds.startKey === 'object') {
    const field = Object.keys(bounds.startKey)[0];
    if (!field) return [];
    const lo = bsonLabel(bounds.startKey[field]);
    const hi = bsonLabel(bounds.endKey ? bounds.endKey[field] : undefined);
    return [`[${lo}, ${hi}]`];
  }

  const first = Object.keys(bounds)[0];
  if (!first) return [];
  const entries = bounds[first];
  return Array.isArray(entries) ? entries : [];
}

function analyzePlan(explainDoc, { hasFilter, hasLimit } = {}) {
  const stages = collectStages(explainDoc);

  // No stage node anywhere means the walk did not understand this explain
  // shape — a future server version, or an error document. Returning
  // 'indexSeek' with no warnings would be indistinguishable from "the guard
  // ran and this query is fine". Fail open, but say so.
  if (stages.length === 0) {
    return {
      scanType: 'unknown',
      indexUsed: null,
      leadingBound: null,
      blockingStages: [],
      notes: [],
      warnings: [
        'Could not recognise any plan stage in the explain output. The ' +
        'full-scan guard did NOT evaluate this query; it will run unchecked, ' +
        'bounded only by maxTimeMS. Treat the result as unverified.',
      ],
    };
  }

  const names = stages.map((s) => s.stage);

  const blockingStages = [...new Set(names.filter((n) => BLOCKING_STAGES.has(n)))];
  const collScan = stages.find((s) => s.stage === 'COLLSCAN');

  // Classify every seek stage, and prefer an offending one when reporting:
  // indexUsed and leadingBound must name the branch that caused the verdict,
  // and the interval within it — that is what the agent needs to fix its
  // query. Bounds are computed once per stage and reused for the report.
  const seeks = stages
    .filter((s) => SEEK_STAGES.has(s.stage))
    .map((s) => ({ stage: s, bounds: leadingBounds(s) }));
  const unboundedSeek = seeks.find((s) => s.bounds.some(isUnboundedBound));
  const seek = unboundedSeek || seeks[0] || null;

  const indexUsed = seek ? seek.stage.indexName || null : null;
  const leadingBound = seek ? seek.bounds.find(isUnboundedBound) || seek.bounds[0] || null : null;

  let scanType = 'indexSeek';
  if (collScan) {
    scanType = 'collectionScan';
  } else if (unboundedSeek) {
    scanType = 'fullIndexScan';
  }

  const warnings = [];
  const notes = [];

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

  // Informational, never blocking: EVERY aggregate with $group has a blocking
  // GROUP stage, so gating on one would demand confirmation for ordinary
  // analytics. warnings is reserved for scans and the unrecognised plan.
  if (blockingStages.length > 0) {
    notes.push(
      `Plan contains blocking stage(s) ${blockingStages.join(', ')}: they ` +
      'consume their whole input before emitting a row, so a limit does not ' +
      "bound them. Bounded by maxTimeMS and MongoDB's 100MB in-memory limit."
    );
  }

  return { scanType, indexUsed, leadingBound, blockingStages, notes, warnings };
}

module.exports = { analyzePlan, isUnboundedBound, collectStages };
