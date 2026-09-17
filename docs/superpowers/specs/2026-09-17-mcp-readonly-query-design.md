# Read-only MCP query interface

**Status:** approved design, not yet implemented
**Date:** 2026-09-17

## Goal

Let an AI agent answer questions about the Mailgun webhook data by querying
MongoDB directly — "how many emails did user-x@gmail.com receive in the prior
year?" — without giving it write access and without letting it unknowingly
launch a collection scan across ~100M documents.

## Decisions taken

These were settled during design; they are inputs, not open questions.

| Decision | Choice |
|---|---|
| Transport | Streamable HTTP, mounted on the existing Express app |
| Query freedom | Open `find` / `aggregate` / `count` passthrough — not a fixed tool set |
| Full scans | Warn, then require explicit confirmation before executing |
| Read-only enforcement | Code-level only; no separate read-only Mongo user |
| Agent documentation | MCP `instructions` + tool descriptions; **no `AGENTS.md` file** |
| Tests | `node --test`, no new test dependency |

## Architecture

```
POST /mcp
  └── ipCheckMiddleware          (explicit — see "The IP gate" below)
       └── StreamableHTTPServerTransport   (stateless, per-request)
            └── McpServer
                 ├── find
                 ├── aggregate
                 ├── count
                 └── describe_collection
```

A fresh `McpServer` and transport are constructed per request with
`sessionIdGenerator: undefined` (stateless mode). There is no session state to
manage, and the endpoint survives an app restart mid-conversation. `GET` and
`DELETE` on `/mcp` return 405.

Queries execute against the **raw driver** —
`mongoose.connection.db.collection('webhooks' | 'messages')` — not the Mongoose
models. Mongoose silently drops filter paths absent from the schema, and the
schema deliberately omits Mailgun's dashed keys (`client-info`,
`user-variables`, …). Using the raw collection means the agent can query
whatever is actually stored. The one behaviour added back is coercing a
24-hex-character `_id` string (including inside `$in`) to an `ObjectId`.

### The IP gate

`server/index.js` registers the IP check as `app.get('/*', ipCheckMiddleware)`.
MCP uses **POST**, so the existing registration does not cover it. The MCP
router must apply `ipCheckMiddleware` explicitly.

Getting this wrong makes `/mcp` the only unauthenticated read path in the
application — worse than `POST /webhook`, which at least verifies a signature.
This is the single highest-consequence line in the change.

### New dependencies

- `@modelcontextprotocol/sdk` ^1.30.0
- `zod` (version per the SDK's peer range)

`Dockerfile` moves from `node:18` (EOL) to `node:22`.

## Tools

All four take a `collection` enum (`"webhooks" | "messages"`) rather than
duplicating each tool per collection.

### `find`

Params: `collection`, `filter`, `projection`, `sort`, `limit`, `skip`,
`collation`, `hint`, `maxTimeMS`, `allowFullScan`.

- `limit` defaults to 50, hard maximum 1000.
- `hint` should name an index (`"recipient_ci"`), not a key pattern:
  `recipient_ci` and `recipient_1_timestamp_-1` share a key pattern and differ
  only by collation, so a pattern hint is ambiguous.
- On `messages`, `body-html` and `body-plain` are projected **away** by default.
  They are large enough to exhaust an agent's context in a single response.
  An explicit `projection` naming them overrides this.

### `aggregate`

Params: `collection`, `pipeline`, `collation`, `hint`, `allowDiskUse`
(default `false`), `maxTimeMS`, `allowFullScan`.

### `count`

Params: `collection`, `filter`, `collation`, `maxTimeMS`, `allowFullScan`.

An **empty filter** skips both the explain and the count command and returns
`estimatedDocumentCount()`, tagged `{ estimated: true }`. `countDocuments({})`
scans the collection for a number MongoDB already holds in metadata (~20s vs.
~2ms at 100M). This mirrors the rule in `CLAUDE.md`.

### `describe_collection`

Params: `collection`. Returns the index list (name, key pattern, collation) and
`estimatedDocumentCount()`. This is what lets an agent work out which query
shapes are index-backed *before* writing one, rather than discovering it from a
warning afterwards.

## The full-scan gate

Every `find`, `aggregate`, and non-empty `count` is planned before it is run.

### Obtaining the plan

Use a raw `explain` **command** rather than a cursor method, so the behaviour
does not depend on the driver version bundled with Mongoose 5:

```js
db.command({ explain: { find: coll, filter, sort, limit, skip, collation, hint }, verbosity: 'queryPlanner' })
db.command({ explain: { aggregate: coll, pipeline, cursor: {}, collation, hint }, verbosity: 'queryPlanner' })
db.command({ explain: { count: coll, query: filter, collation, hint }, verbosity: 'queryPlanner' })
```

`queryPlanner` verbosity plans without executing — single-digit milliseconds
even against 100M documents.

**The explained command must carry the same `collation` and `hint` as the real
one.** A query only reaches the `recipient_ci` index if it passes the matching
collation; explaining without it plans a *different* query, reports a COLLSCAN,
and blocks a query that would in fact have been a single-key seek. The explain
options and the execution options must come from one object, not two.

### Parsing the plan

Plan shape varies by MongoDB version and execution engine: classic plans nest
under `winningPlan.inputStage`, SBE plans nest under `winningPlan.queryPlan`,
and aggregate plans may appear under `stages[0].$cursor.queryPlanner` or at the
top level. Rather than pattern-match each shape, **deep-walk the entire explain
document** collecting every `stage` and `indexName` value found at any depth.
One traversal handles every version.

Classify from the collected stages:

- `COLLSCAN` present → full collection scan.
- `SORT` present → blocking in-memory sort (hard-fails past 100MB).
- `IXSCAN` / `IDHACK` / `COUNT_SCAN` / `DISTINCT_SCAN` → index-backed; report
  every `indexName` seen.

### Warn, then confirm

If the plan contains `COLLSCAN` or a blocking `SORT`, the tool **returns
without executing**:

```json
{
  "executed": false,
  "requiresConfirmation": true,
  "plan": { "stage": "COLLSCAN", "indexUsed": null },
  "warnings": [
    "COLLSCAN on webhooks (~100M documents). This query reads every document and will very likely exceed the 15s timeout. An exact recipient match with collation {locale:'en',strength:2} uses the recipient_ci index instead."
  ],
  "hint": "Re-call with allowFullScan: true to run it anyway."
}
```

The MCP instructions direct the agent to **surface this warning to the human
and get their agreement** before re-calling with `allowFullScan: true`. That is
the point of the gate: a scan against production should be a decision somebody
made, not one that happened.

When `allowFullScan: true`, the query executes and the `plan` and `warnings`
are returned alongside the results.

## Read-only enforcement

Enforcement is code-level only, by explicit choice. The MCP layer never invokes
anything but `find`, `aggregate`, `countDocuments`, and
`estimatedDocumentCount`.

Pipelines are rejected before execution if any stage is:

- `$out`, `$merge` — write to a collection
- `$function`, `$where`, `$accumulator` — execute JavaScript server-side

The check must **recurse into nested pipelines**, since these stages can be
hidden inside `$facet`, `$lookup.pipeline`, and `$unionWith.pipeline`. A
top-level-only scan is trivially bypassed and is the most likely way this
control fails.

## Response bounds

Not restrictions on what can be asked — bounds on what comes back.

- `maxTimeMS` defaults to **15000** (the UI uses 5000; analytical queries are
  legitimately slower), caller-overridable to a ceiling of 120000.
- Results are serialized document by document and truncated at **~100KB**,
  returning `{ returned: n, truncated: true }`. Without this a large result
  destroys the agent's context before it can summarize anything.
- A `maxTimeMS` expiry (`MongoServerError` code 50) returns the plan and a
  message naming the index that would have served the query, so the agent can
  correct itself rather than retry blindly.

Results are returned as a single JSON text block.

## Agent instructions

No `AGENTS.md`. Guidance lives in the MCP `instructions` string (delivered at
`initialize`) and in per-tool descriptions, both of which land in the agent's
context automatically.

Content:

- **`timestamp` is a Number — unix seconds, not a Date.** Comparing it to a
  Date matches nothing under BSON type ordering and returns zero rows silently.
  This is the most common way to write a wrong query here and belongs first.
- Exact recipient matching requires `collation: {locale:'en', strength:2}` to
  reach the `recipient_ci` index; without it the query scans.
- Never use `{$regex: input, $options: 'i'}` — unanchored and case-insensitive
  cannot seek a b-tree. Use an anchored `^prefix` or an exact match.
- `message-headers` on `messages` is an array of `[name, value]` pairs, not an
  object.
- Mailgun's payload uses dashed keys; the schema declares camelCase and
  Mongoose drops the mismatches on write. Several documented fields are
  therefore absent from stored documents — confirm a field populates before
  relying on it.
- The index list, and the instruction to call `describe_collection` first.
- How to respond to `requiresConfirmation`: tell the human what the scan costs,
  and only then re-call with `allowFullScan: true`.

Worked example — the motivating question:

```js
count("webhooks", {
  recipient: "user-x@gmail.com",
  timestamp: { $gte: 1758067200, $lte: 1789603200 },  // 2025-09-17 .. 2026-09-17
  event: "delivered"
}, { collation: { locale: "en", strength: 2 } })
```

## Files

```
server/mcp/index.js         router, transport wiring, ipCheck
server/mcp/tools.js         tool definitions and handlers
server/mcp/query.js         sanitization, _id coercion, execution, truncation
server/mcp/explain.js       explain command + plan analysis
server/mcp/instructions.js  the instructions string
test/explain.test.js
test/query.test.js
```

Modified: `server/index.js` (mount the router), `package.json` (deps,
`"test": "node --test"`), `Dockerfile` (node:22), `README.md` (client setup),
`CLAUDE.md` (document the new surface and that it is IP-gated).

## Testing

`npm test` → `node --test`. No new dependency; Node's built-in runner is
sufficient. Coverage targets the pure functions where a bug would be silent
rather than loud:

- **Plan analysis** against recorded explain fixtures: classic `COLLSCAN`,
  classic `IXSCAN`, SBE-shaped `winningPlan.queryPlan`, aggregate
  `stages[0].$cursor`, and a blocking `SORT`. Each asserts the expected
  classification and warning.
- **Pipeline rejection**: `$out`, `$merge`, `$function`, `$where`,
  `$accumulator` — each at top level *and* nested inside `$facet`,
  `$lookup.pipeline`, and `$unionWith.pipeline`. A legitimate pipeline passes
  untouched.
- **`_id` coercion**: 24-hex string becomes `ObjectId`; a non-hex string is
  left alone; `{$in: [...]}` is handled element-wise.
- **Truncation**: under the cap returns everything with `truncated: false`;
  over the cap stops at the boundary and reports `truncated: true`.

Integration against a live MongoDB is out of scope for the automated suite; it
requires `docker compose up` and is verified manually.

## Out of scope

- A separate read-only MongoDB user (considered, explicitly declined).
- stdio transport.
- Any change to the existing `/api` routes or the web UI.
