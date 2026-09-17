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
| IP gate | Peer address, all methods, shared middleware fixed in this change |
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

`/mcp` is reached over Tailscale, exactly like the web UI. Only `POST /webhook`
is served over the public internet. The IP gate is therefore the entire access
control story for this endpoint, and it has two defects to address.

**1. The existing registration does not cover POST.** `server/index.js`
registers the check as `app.get('/*', ipCheckMiddleware)`. MCP uses POST, so
the MCP router must apply the middleware explicitly. Missing this makes `/mcp`
the only unauthenticated read path in the application — weaker than
`POST /webhook`, which at least verifies a signature.

**2. The current check trusts a forgeable header.**
`server/middleware/ipCheck.js` reads `req.headers['x-forwarded-for']` first and
unconditionally, and no `trust proxy` setting exists anywhere in `server/`. It
therefore validates a client-supplied string rather than the actual peer.
Measured against the real middleware:

```
200  X-Forwarded-For: 10.0.0.1          (forged private)
200  X-Forwarded-For: 100.101.102.103   (forged Tailscale CGNAT)
403  X-Forwarded-For: 8.8.8.8
```

The listening port is necessarily reachable from the public internet, because
that is how Mailgun delivers webhooks. Anyone who can reach it can therefore
send that header and pass the gate.

**The fix, applied to the shared middleware.** Production is confirmed to have
no reverse proxy — Mailgun and Tailscale clients both reach the Node process
directly — so `ipCheck` gates on `req.socket.remoteAddress` and ignores
`X-Forwarded-For` entirely. Over Tailscale the peer address *is* the
`100.64.0.0/10` address, so the gate behaves exactly as intended and forging it
requires actually being on the tailnet.

No `TRUST_PROXY_HOPS` configuration knob ships with this. There is no proxy to
configure it for, and this codebase has already paid for maintaining machinery
against a use case that did not exist (see the four dead indexes in
`docs/PERFORMANCE.md`). A comment records what to do if a proxy is ever added:
walk back a configured number of hops from the *right* of `X-Forwarded-For`,
never a blind first-value read.

Two details that would otherwise break it silently:

- `ip-range-check` accepts IPv6-mapped IPv4 (`::ffff:10.0.0.1`) against an IPv4
  CIDR directly — verified — so no normalization is needed.
- It does **not** match `::1` against `127.0.0.1/32`. A dual-stack connection to
  `localhost` arrives as `::1`, so `::1/128` must be added to the allowlist or
  local development breaks the moment the header fallback is removed.

### Middleware ordering

Registration must change, not just the check itself. The gate is currently
`app.get('/*', ...)`, which covers only GET; that is why `POST /webhook` is
public today. Switching to `app.use` without reordering would gate the webhook
endpoint and **break Mailgun ingestion**.

The correct order in `server/index.js`:

```js
app.use(cors());
app.use(express.json());

app.use('/webhook', webhookRoutes);   // public by design; signature-verified

app.use(ipCheckMiddleware);           // gates everything below, ALL methods

app.use(express.static(...));
app.use('/api', apiRoutes);
app.use('/mcp', mcpRoutes);
```

This makes the MCP router's own gate unnecessary — one correctly placed check
beats two. It also upgrades the invariant in `CLAUDE.md`: today "any new write
route is not covered", afterwards *every* route except `POST /webhook` is
covered regardless of method. `CLAUDE.md` must be updated to say so, since the
old wording would actively mislead.

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
server/mcp/index.js         router, transport wiring
server/mcp/tools.js         tool definitions and handlers
server/mcp/query.js         sanitization, _id coercion, execution, truncation
server/mcp/explain.js       explain command + plan analysis
server/mcp/instructions.js  the instructions string
test/explain.test.js
test/query.test.js
test/ipCheck.test.js
```

Modified: `server/index.js` (middleware ordering + mount the router),
`server/middleware/ipCheck.js` (peer address, `::1`), `package.json` (deps,
`"test": "node --test"`), `Dockerfile` (node:22), `README.md` (client setup),
`CLAUDE.md` (the new surface, and the corrected access-control invariant).

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
- **`ipCheck`**: a forged `X-Forwarded-For` naming a private or CGNAT address
  is rejected when the peer is public; a genuine `100.64.0.0/10` peer is
  allowed; `::ffff:`-mapped and `::1` peers are allowed. This is the regression
  test for the defect above.
- **Ordering**: `POST /webhook` reaches its handler from a public peer, while
  `POST /mcp` and `GET /api/...` from the same peer are refused. This is the
  test that catches a reordering that silently breaks Mailgun ingestion.

Integration against a live MongoDB is out of scope for the automated suite; it
requires `docker compose up` and is verified manually.

## Out of scope

- A separate read-only MongoDB user (considered, explicitly declined).
- stdio transport.
- Any change to the query logic in `/api` or to the web UI's behaviour. Note
  that the web UI and `/api` *are* affected by the `ipCheck` fix above — they
  gain the corrected gate — but no route handler or page changes.
- The stored-XSS issue in `public/js/events.js` / `event.js` noted in
  `CLAUDE.md`. Untouched by this work.
