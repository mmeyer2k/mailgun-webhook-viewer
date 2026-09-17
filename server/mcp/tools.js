const { z } = require('zod');
const { analyzePlan } = require('./explain');
const { TOOL_DESCRIPTIONS } = require('./instructions');
const {
  COLLECTIONS,
  DEFAULTS,
  assertReadOnlyPipeline,
  coerceIds,
  truncateDocs,
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

/**
 * Plan a command without executing it.
 *
 * The explained command MUST carry the same collation and hint as the real one.
 * A query only reaches the recipient_ci index if it passes the matching
 * collation; explaining without it plans a DIFFERENT query, reports a scan, and
 * would block exactly the fast exact-recipient lookup this server exists to
 * serve. That is why the command object is built once and used for both.
 */
async function planAndGuard(db, command, { hasFilter, hasLimit, allowFullScan }) {
  let plan;
  try {
    const explained = await db.command({ explain: command, verbosity: 'queryPlanner' });
    plan = analyzePlan(explained, { hasFilter, hasLimit });
  } catch (err) {
    // An explain failure must not block a legitimate query; report it and let
    // maxTimeMS bound the execution.
    return { plan: { scanType: 'unknown', warnings: [], explainError: err.message }, blocked: false };
  }

  const blocked = plan.warnings.length > 0 && !allowFullScan;
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
        skip: z.number().int().nonnegative().optional(),
        collation: collationParam,
        hint: z.string().optional(),
        maxTimeMS: z.number().int().positive().optional(),
        allowFullScan: z.boolean().optional(),
      },
    },
    async (args) => {
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

        const { plan, blocked } = await planAndGuard(db, command, {
          hasFilter: Object.keys(filter).length > 0,
          hasLimit: true,
          allowFullScan: args.allowFullScan,
        });
        if (blocked) return blockedResult(plan);

        const cursor = db.collection(args.collection)
          .find(filter, { projection })
          .limit(limit)
          .maxTimeMS(maxTimeMS);
        if (args.sort) cursor.sort(args.sort);
        if (args.skip) cursor.skip(args.skip);
        if (args.collation) cursor.collation(args.collation);
        if (args.hint) cursor.hint(args.hint);

        const docs = await cursor.toArray();
        const { docs: kept, returned, truncated } = truncateDocs(docs, DEFAULTS.maxBytes);

        return jsonResult({
          executed: true,
          plan: { scanType: plan.scanType, indexUsed: plan.indexUsed },
          warnings: plan.warnings,
          returned,
          truncated,
          documents: kept,
        });
      } catch (err) {
        return errorResult(timeoutMessage(err, null));
      }
    }
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
    async (args) => {
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

        const command = { count: args.collection, query: filter };
        if (args.collation) command.collation = args.collation;
        if (args.hint) command.hint = args.hint;

        const { plan, blocked } = await planAndGuard(db, command, {
          hasFilter: true,
          hasLimit: false,
          allowFullScan: args.allowFullScan,
        });
        if (blocked) return blockedResult(plan);

        const options = { maxTimeMS };
        if (args.collation) options.collation = args.collation;
        if (args.hint) options.hint = args.hint;
        const count = await db.collection(args.collection).countDocuments(filter, options);

        return jsonResult({
          executed: true,
          estimated: false,
          plan: { scanType: plan.scanType, indexUsed: plan.indexUsed },
          warnings: plan.warnings,
          count,
        });
      } catch (err) {
        return errorResult(timeoutMessage(err, null));
      }
    }
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
    async (args) => {
      try {
        assertReadOnlyPipeline(args.pipeline);
      } catch (err) {
        return errorResult(err.message);
      }

      try {
        const maxTimeMS = clampTime(args.maxTimeMS);
        const firstMatch = args.pipeline.find((s) => s && s.$match);
        const hasFilter = Boolean(firstMatch && Object.keys(firstMatch.$match).length > 0);
        const hasLimit = args.pipeline.some((s) => s && s.$limit);

        const command = { aggregate: args.collection, pipeline: args.pipeline, cursor: {} };
        if (args.collation) command.collation = args.collation;
        if (args.hint) command.hint = args.hint;

        const { plan, blocked } = await planAndGuard(db, command, {
          hasFilter,
          hasLimit,
          allowFullScan: args.allowFullScan,
        });
        if (blocked) return blockedResult(plan);

        const options = { maxTimeMS, allowDiskUse: Boolean(args.allowDiskUse) };
        if (args.collation) options.collation = args.collation;
        if (args.hint) options.hint = args.hint;

        const docs = await db.collection(args.collection)
          .aggregate(args.pipeline, options)
          .toArray();
        const { docs: kept, returned, truncated } = truncateDocs(docs, DEFAULTS.maxBytes);

        return jsonResult({
          executed: true,
          plan: { scanType: plan.scanType, indexUsed: plan.indexUsed },
          warnings: plan.warnings,
          returned,
          truncated,
          documents: kept,
        });
      } catch (err) {
        return errorResult(timeoutMessage(err, null));
      }
    }
  );
}

module.exports = { registerTools };
