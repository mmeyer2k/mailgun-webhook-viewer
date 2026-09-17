const { z } = require('zod');
const { analyzePlan } = require('./explain');
const { TOOL_DESCRIPTIONS } = require('./instructions');
const {
  COLLECTIONS,
  DEFAULTS,
  assertNoForbiddenOperators,
  assertReadOnlyPipeline,
  coerceIds,
  collectBounded,
} = require('./query');

const jsonResult = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const errorResult = (message) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
});

// Shared parameter shapes. registerTool takes a raw Zod shape object, not a
// z.object(...).
const collectionParam = z.enum(COLLECTIONS);
// Plain object rather than .passthrough(), which zod 4 deprecates. locale and
// strength are the only fields any query here needs.
const collationParam = z
  .object({ locale: z.string(), strength: z.number().optional() })
  .optional();

const clampTime = (v) =>
  Math.min(Math.max(Number(v) || DEFAULTS.maxTimeMS, 1), DEFAULTS.maxTimeCeiling);

// One slot per in-flight query across all three tools. This process also
// serves webhook ingestion; a pile-up of 120-second aggregates must fail
// fast rather than starve it.
let inFlight = 0;
async function withSlot(fn) {
  if (inFlight >= DEFAULTS.maxConcurrent) {
    return errorResult(
      `Too many concurrent queries (limit ${DEFAULTS.maxConcurrent}). Wait for ` +
      'an in-flight query to finish and retry.'
    );
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
  }
}

/**
 * Plan a command without executing it.
 *
 * The explained command MUST carry the same collation and hint as the real one.
 * A query only reaches the recipient_ci index if it passes the matching
 * collation; explaining without it plans a DIFFERENT query, reports a scan, and
 * would block exactly the fast exact-recipient lookup this server exists to
 * serve. A guard that explains one query and runs another is not a guard.
 *
 * What is guaranteed to match, per tool:
 *  - count: the very same object is explained and then handed to db.command,
 *    so nothing can drift. This is why the tool does not use countDocuments():
 *    the driver implements it as aggregate([{$match}, {$group}]), a different
 *    command with a different plan from the `count` that was explained.
 *  - find: the explained command mirrors the cursor field for field — filter,
 *    limit, sort, skip, projection, collation, hint.
 *  - aggregate: the explained command carries the same pipeline (with _id
 *    strings already coerced), collation, hint and allowDiskUse.
 *
 * Only maxTimeMS may differ, and only where the driver takes it as a cursor
 * option rather than a command field: it is a deadline, not a plan input.
 */
async function planAndGuard(db, command, { hasFilter, hasLimit, allowFullScan }) {
  let plan;
  try {
    const explained = await db.command({ explain: command, verbosity: 'queryPlanner' });
    plan = analyzePlan(explained, { hasFilter, hasLimit });
  } catch (err) {
    // Fail open: an explain failure must not block a legitimate query. But say
    // so loudly — an empty warnings array would be indistinguishable from "the
    // guard ran and this query is fine".
    return {
      plan: {
        scanType: 'unknown',
        indexUsed: null,
        leadingBound: null,
        blockingStages: [],
        notes: [],
        warnings: [
          `Could not plan this query before running it (${err.message}). The ` +
          'full-scan guard did NOT run, so this query executed unchecked, ' +
          'bounded only by maxTimeMS. Treat the result as unverified.',
        ],
        explainError: err.message,
      },
      blocked: false,
    };
  }

  // 'unknown' means the guard never evaluated this plan. Blocking on that
  // would turn every explain shape we fail to parse into a hard stop; the
  // warning is loud enough. Fail open, but never silently.
  const blocked = plan.scanType !== 'unknown' && plan.warnings.length > 0 && !allowFullScan;
  return { plan, blocked };
}

const blockedResult = (plan) =>
  jsonResult({
    executed: false,
    requiresConfirmation: true,
    plan: {
      scanType: plan.scanType,
      indexUsed: plan.indexUsed,
      leadingBound: plan.leadingBound,
      blockingStages: plan.blockingStages,
    },
    warnings: plan.warnings,
    notes: plan.notes || [],
    hint:
      'This query was NOT run. Tell the user what it will cost and why, then ' +
      're-call with allowFullScan: true only if they agree.',
  });

function timeoutMessage(err, plan) {
  if (err && err.code === 50) {
    return (
      `Query exceeded maxTimeMS and was killed by the server. Plan was ` +
      `${plan && plan.scanType ? plan.scanType : 'unknown'}` +
      `${plan && plan.indexUsed ? ` using index ${plan.indexUsed}` : ''}. ` +
      'Narrow the query: an exact recipient match with collation ' +
      "{locale:'en',strength:2}, or a tighter timestamp range, is far faster."
    );
  }
  return err.message;
}

function registerTools(server, db) {
  server.registerTool(
    'describe_collection',
    {
      description: TOOL_DESCRIPTIONS.describe_collection,
      inputSchema: { collection: collectionParam },
    },
    async ({ collection }) => {
      try {
        const col = db.collection(collection);
        const indexes = await col.indexes();
        const count = await col.estimatedDocumentCount();
        return jsonResult({
          collection,
          estimatedDocumentCount: count,
          indexes: indexes.map((i) => ({
            name: i.name,
            key: i.key,
            collation: i.collation
              ? { locale: i.collation.locale, strength: i.collation.strength }
              : null,
          })),
        });
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  server.registerTool(
    'find',
    {
      description: TOOL_DESCRIPTIONS.find,
      inputSchema: {
        collection: collectionParam,
        filter: z.record(z.string(), z.any()).optional(),
        projection: z.record(z.string(), z.any()).optional(),
        sort: z.record(z.string(), z.number()).optional(),
        limit: z.number().int().positive().max(DEFAULTS.maxLimit).optional(),
        skip: z.number().int().nonnegative().max(DEFAULTS.maxSkip).optional(),
        collation: collationParam,
        hint: z.string().optional(),
        maxTimeMS: z.number().int().positive().optional(),
        allowFullScan: z.boolean().optional(),
      },
    },
    async (args) => withSlot(async () => {
      try {
        assertNoForbiddenOperators(args.filter || {}, 'filter');
        if (args.projection) assertNoForbiddenOperators(args.projection, 'projection');
        if (args.sort) assertNoForbiddenOperators(args.sort, 'sort');
      } catch (err) {
        return errorResult(err.message);
      }

      let plan = null;
      try {
        const filter = coerceIds(args.filter || {});
        const limit = Math.min(args.limit || DEFAULTS.limit, DEFAULTS.maxLimit);
        const maxTimeMS = clampTime(args.maxTimeMS);

        // `messages` bodies are large enough to exhaust an agent's context.
        let projection = args.projection;
        if (args.collection === 'messages' && !projection) {
          projection = { 'body-html': 0, 'body-plain': 0 };
        }

        const command = { find: args.collection, filter, limit };
        if (args.sort) command.sort = args.sort;
        if (args.skip) command.skip = args.skip;
        if (projection) command.projection = projection;
        if (args.collation) command.collation = args.collation;
        if (args.hint) command.hint = args.hint;

        const guard = await planAndGuard(db, command, {
          hasFilter: Object.keys(filter).length > 0,
          hasLimit: true,
          allowFullScan: args.allowFullScan,
        });
        plan = guard.plan;
        if (guard.blocked) return blockedResult(plan);

        const cursor = db.collection(args.collection)
          .find(filter, { projection })
          .limit(limit)
          .maxTimeMS(maxTimeMS);
        if (args.sort) cursor.sort(args.sort);
        if (args.skip) cursor.skip(args.skip);
        if (args.collation) cursor.collation(args.collation);
        if (args.hint) cursor.hint(args.hint);

        const { docs: kept, returned, truncated } = await collectBounded(cursor, {
          maxBytes: DEFAULTS.maxBytes,
          maxDocs: limit,
        });

        return jsonResult({
          executed: true,
          plan: { scanType: plan.scanType, indexUsed: plan.indexUsed },
          warnings: plan.warnings,
          notes: plan.notes || [],
          returned,
          truncated,
          documents: kept,
        });
      } catch (err) {
        return errorResult(timeoutMessage(err, plan));
      }
    })
  );

  server.registerTool(
    'count',
    {
      description: TOOL_DESCRIPTIONS.count,
      inputSchema: {
        collection: collectionParam,
        filter: z.record(z.string(), z.any()).optional(),
        collation: collationParam,
        hint: z.string().optional(),
        maxTimeMS: z.number().int().positive().optional(),
        allowFullScan: z.boolean().optional(),
      },
    },
    async (args) => withSlot(async () => {
      try {
        assertNoForbiddenOperators(args.filter || {}, 'filter');
      } catch (err) {
        return errorResult(err.message);
      }

      let plan = null;
      try {
        const filter = coerceIds(args.filter || {});
        const maxTimeMS = clampTime(args.maxTimeMS);

        // countDocuments({}) scans the whole collection for a number MongoDB
        // already holds in metadata: ~20s vs ~2ms at 100M documents.
        if (Object.keys(filter).length === 0) {
          const count = await db.collection(args.collection).estimatedDocumentCount();
          return jsonResult({
            executed: true,
            estimated: true,
            count,
            note: 'Metadata estimate; an empty filter is never counted exactly.',
          });
        }

        // ONE object, explained and then executed. countDocuments() would be
        // the obvious call, but the 3.x driver implements it as
        // aggregate([{$match}, {$group}]) — so the tool would report the plan
        // of a `count` command and then run an aggregate with a different one.
        const command = { count: args.collection, query: filter, maxTimeMS };
        if (args.collation) command.collation = args.collation;
        if (args.hint) command.hint = args.hint;

        const guard = await planAndGuard(db, command, {
          hasFilter: true,
          hasLimit: false,
          allowFullScan: args.allowFullScan,
        });
        plan = guard.plan;
        if (guard.blocked) return blockedResult(plan);

        const result = await db.command(command);
        const count = result.n;

        return jsonResult({
          executed: true,
          estimated: false,
          plan: { scanType: plan.scanType, indexUsed: plan.indexUsed },
          warnings: plan.warnings,
          notes: plan.notes || [],
          count,
        });
      } catch (err) {
        return errorResult(timeoutMessage(err, plan));
      }
    })
  );

  server.registerTool(
    'aggregate',
    {
      description: TOOL_DESCRIPTIONS.aggregate,
      inputSchema: {
        collection: collectionParam,
        pipeline: z.array(z.record(z.string(), z.any())),
        collation: collationParam,
        hint: z.string().optional(),
        allowDiskUse: z.boolean().optional(),
        maxTimeMS: z.number().int().positive().optional(),
        allowFullScan: z.boolean().optional(),
      },
    },
    async (args) => withSlot(async () => {
      try {
        assertReadOnlyPipeline(args.pipeline);
      } catch (err) {
        return errorResult(err.message);
      }

      let plan = null;
      try {
        const maxTimeMS = clampTime(args.maxTimeMS);

        // find and count coerce 24-hex _id strings to ObjectId; a pipeline
        // whose first stage is {$match: {_id: "..."}} deserves the same, or an
        // agent that pastes an _id out of a find result silently matches
        // nothing. Only top-level $match stages: deeper ones may belong to
        // $lookup sub-pipelines against other shapes.
        const pipeline = args.pipeline.map((s) =>
          (s && s.$match && typeof s.$match === 'object') ? { ...s, $match: coerceIds(s.$match) } : s);

        // Only the FIRST stage counts as "the filter". A $match after a $group
        // filters the group output, not the collection, so it cannot bound the
        // scan — treating it as a filter mislabels the plan.
        const first = pipeline[0];
        const hasFilter = Boolean(first && first.$match && Object.keys(first.$match).length > 0);
        const hasLimit = pipeline.some((s) => s && s.$limit);

        const command = {
          aggregate: args.collection,
          pipeline,
          cursor: {},
          // allowDiskUse changes what the planner may choose for a blocking
          // stage, so the explained command has to carry it too.
          allowDiskUse: Boolean(args.allowDiskUse),
        };
        if (args.collation) command.collation = args.collation;
        if (args.hint) command.hint = args.hint;

        const guard = await planAndGuard(db, command, {
          hasFilter,
          hasLimit,
          allowFullScan: args.allowFullScan,
        });
        plan = guard.plan;
        if (guard.blocked) return blockedResult(plan);

        const options = { maxTimeMS, allowDiskUse: Boolean(args.allowDiskUse) };
        if (args.collation) options.collation = args.collation;
        if (args.hint) options.hint = args.hint;

        const cursor = db.collection(args.collection).aggregate(pipeline, options);
        const { docs: kept, returned, truncated } = await collectBounded(cursor, {
          maxBytes: DEFAULTS.maxBytes,
          maxDocs: DEFAULTS.maxLimit,
        });

        return jsonResult({
          executed: true,
          plan: { scanType: plan.scanType, indexUsed: plan.indexUsed },
          warnings: plan.warnings,
          notes: plan.notes || [],
          returned,
          truncated,
          documents: kept,
        });
      } catch (err) {
        return errorResult(timeoutMessage(err, plan));
      }
    })
  );
}

module.exports = { registerTools };
