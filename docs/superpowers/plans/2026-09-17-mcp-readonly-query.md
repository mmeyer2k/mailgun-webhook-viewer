# Read-only MCP Query Interface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the Mailgun webhook MongoDB to AI agents as a read-only MCP endpoint that answers questions like "how many emails did user-x@gmail.com receive in the prior year?" without letting an agent unknowingly scan ~100M documents.

**Architecture:** A stateless streamable-HTTP MCP endpoint mounted at `POST /mcp` on the existing Express app. Four tools (`find`, `aggregate`, `count`, `describe_collection`) pass queries through to the raw MongoDB driver. Every query is first planned with a `queryPlanner` explain; if the plan reveals a full collection or full index scan, the tool returns the warning **instead of** results and executes only on an explicit `allowFullScan: true` re-call. Access control is the existing IP gate, repaired in this plan to check the real TCP peer rather than a forgeable header.

**Tech Stack:** Node 22, Express 4, Mongoose 5 (raw driver access via `mongoose.connection.db`), `@modelcontextprotocol/sdk` 1.30.0, `zod` 4, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-17-mcp-readonly-query-design.md`

## Global Constraints

- **`timestamp` is a Number (unix seconds), never a Date.** A `Date` comparison matches nothing under BSON type ordering and silently returns zero rows.
- **Never write `{$regex: input, $options: 'i'}`.** Unanchored + case-insensitive cannot seek; it reads every key in the index.
- **Collection names** are `webhooks` and `messages` (Mongoose pluralization).
- **`maxTimeMS`**: default `15000`, caller ceiling `120000`.
- **Result byte cap**: `100000` bytes serialized.
- **`limit`**: default `50`, hard max `1000`.
- **Hint by index *name***, never key pattern — `recipient_ci` and `recipient_1_timestamp_-1` share a key pattern.
- **CI collation** is exactly `{ locale: 'en', strength: 2 }`.
- All new server files are CommonJS (`require`/`module.exports`), matching the existing codebase.
- The MCP SDK is ESM-first but ships a CJS build; `require('@modelcontextprotocol/sdk/server/mcp.js')` works and is verified.
- Commit after every task.

---

### Task 1: Repair the IP gate

The gate currently reads `X-Forwarded-For` first and unconditionally, so any client can forge a private address. It is also registered as `app.get('/*', ...)`, covering GET only. Both are fixed here, before any new endpoint exists to inherit them.

**Files:**
- Modify: `server/middleware/ipCheck.js`
- Modify: `server/index.js:18-22`
- Create: `test/ipCheck.test.js`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `ipCheckMiddleware(req, res, next)` — unchanged export shape, now gating on `req.socket.remoteAddress`.

- [ ] **Step 1: Add the test script to `package.json`**

In the `"scripts"` block add:

```json
"test": "node --test"
```

- [ ] **Step 2: Write the failing test**

Create `test/ipCheck.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const ipCheck = require('../server/middleware/ipCheck');

// Starts a server bound to 127.0.0.1 and issues a request with the given
// headers. The peer is therefore always 127.0.0.1 (or ::1), which is allowed —
// so any 403 here proves the header was what got rejected, and any 200 on a
// forged header proves the header was trusted.
function withServer(handler) {
  return new Promise((resolve) => {
    const app = express();
    app.use(ipCheck);
    app.use((req, res) => res.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1', async () => {
      const result = await handler(`http://127.0.0.1:${server.address().port}/api/x`);
      server.close(() => resolve(result));
    });
  });
}

test('allows a request with no forwarding header from a local peer', async () => {
  const status = await withServer(async (url) => (await fetch(url)).status);
  assert.strictEqual(status, 200);
});

test('ignores X-Forwarded-For entirely', async () => {
  // A public address in the header must NOT cause a rejection, because the
  // header is not consulted at all; the real peer is local and allowed.
  const status = await withServer(async (url) =>
    (await fetch(url, { headers: { 'X-Forwarded-For': '8.8.8.8' } })).status);
  assert.strictEqual(status, 200);
});

test('rejects a peer outside the allowed ranges', () => {
  // Unit-level: drive the middleware directly with a forged header and a
  // public peer. This is the regression test for the forgeable gate.
  let statusCode = null;
  const req = {
    headers: { 'x-forwarded-for': '10.0.0.1' },
    socket: { remoteAddress: '203.0.113.7' },
  };
  const res = {
    status(c) { statusCode = c; return this; },
    json() { return this; },
  };
  let nextCalled = false;
  ipCheck(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false, 'forged X-Forwarded-For must not pass');
  assert.strictEqual(statusCode, 403);
});

test('allows an IPv6-mapped IPv4 private peer', () => {
  let nextCalled = false;
  ipCheck({ headers: {}, socket: { remoteAddress: '::ffff:10.0.0.1' } },
          { status() { return this; }, json() { return this; } },
          () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

test('allows the IPv6 loopback peer', () => {
  // A dual-stack connection to localhost arrives as ::1, which does NOT match
  // 127.0.0.1/32. Without ::1/128 in the allowlist, local dev breaks.
  let nextCalled = false;
  ipCheck({ headers: {}, socket: { remoteAddress: '::1' } },
          { status() { return this; }, json() { return this; } },
          () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

test('allows a Tailscale CGNAT peer', () => {
  let nextCalled = false;
  ipCheck({ headers: {}, socket: { remoteAddress: '100.101.102.103' } },
          { status() { return this; }, json() { return this; } },
          () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL. `rejects a peer outside the allowed ranges` fails because the current middleware reads the forged header and calls `next()`. `allows the IPv6 loopback peer` fails because `::1` is not in the allowlist.

- [ ] **Step 4: Rewrite the middleware**

Replace the entire contents of `server/middleware/ipCheck.js`:

```js
const ipRangeCheck = require('ip-range-check');

const allowedRanges = [
  '100.64.0.0/10',   // Carrier-grade NAT — the range Tailscale hands out
  '10.0.0.0/8',      // Private network
  '172.16.0.0/12',   // Private network
  '192.168.0.0/16',  // Private network
  '127.0.0.1/32',    // Localhost
  '::1/128'          // Localhost over IPv6. A dual-stack connection to
                     // "localhost" arrives as ::1, which does NOT match
                     // 127.0.0.1/32.
];

/**
 * Gate every non-webhook route to the private/Tailscale ranges.
 *
 * This checks the real TCP peer address and deliberately ignores
 * X-Forwarded-For. The previous implementation read that header first and
 * unconditionally, with no `trust proxy` configured, so any client on the
 * internet could send `X-Forwarded-For: 10.0.0.1` and pass. The listening port
 * has to be publicly reachable for Mailgun to deliver webhooks, so that was
 * reachable from anywhere.
 *
 * Production runs with no reverse proxy: Mailgun and Tailscale clients both hit
 * this process directly, so the peer IS the client. If a proxy is ever added,
 * the peer becomes the proxy and this must be given an explicitly configured
 * number of hops to walk back from the RIGHT of X-Forwarded-For — never a
 * blind first-value read.
 *
 * ip-range-check matches IPv6-mapped IPv4 (::ffff:10.0.0.1) against IPv4 CIDRs
 * directly, so no normalization is needed.
 */
const ipCheckMiddleware = (req, res, next) => {
  const clientIp = req.socket && req.socket.remoteAddress;

  if (clientIp && ipRangeCheck(clientIp, allowedRanges)) {
    return next();
  }

  console.log('Access denied - IP not in allowed range', clientIp);
  res.status(403).json({ error: 'Access denied - IP not in allowed range' });
};

module.exports = ipCheckMiddleware;
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write the failing ordering test**

The gate must now cover all methods, but `POST /webhook` must stay public or Mailgun ingestion breaks. Append to `test/ipCheck.test.js`:

```js
test('gates all methods except the webhook route', async () => {
  // Mirrors the middleware order in server/index.js. The gate is stubbed to
  // always deny, which stands in for "peer is not in an allowed range" without
  // needing to fake a TCP peer address. What this asserts is POSITION: /webhook
  // is mounted above the gate and stays reachable, everything below is refused
  // for every method.
  const denyAll = (req, res) => res.status(403).json({ error: 'denied' });

  const app = express();
  app.use(express.json());
  app.post('/webhook', (req, res) => res.json({ ingested: true }));
  app.use(denyAll);
  app.post('/mcp', (req, res) => res.json({ mcp: true }));
  app.get('/api/webhooks', (req, res) => res.json({ api: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (path) =>
    (await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })).status;

  try {
    assert.strictEqual(await post('/webhook'), 200, 'webhook must stay public');
    assert.strictEqual(await post('/mcp'), 403, 'MCP must be gated');
    assert.strictEqual((await fetch(`${base}/api/webhooks`)).status, 403, 'API must be gated');
  } finally {
    server.close();
  }
});
```

- [ ] **Step 7: Run it and verify it passes**

Run: `npm test`
Expected: PASS, 7 tests.

This test builds its own app rather than importing `server/index.js`, which
calls `app.listen` and connects to MongoDB on require and so cannot be loaded
in a test. It therefore locks the ordering *contract* that Step 8 implements by
hand — it does not verify `server/index.js` itself. Step 9 covers that
manually. If you change the order in `server/index.js`, change it here too.

- [ ] **Step 8: Reorder middleware in `server/index.js`**

Replace the block from `// Apply IP check to all GET requests for static files` through the `app.use('/api', apiRoutes);` line so the order becomes:

```js
// Mailgun posts here from the public internet, so this route is deliberately
// NOT behind the IP gate — its protection is the HMAC signature check. It is
// mounted ABOVE the gate so that position, not HTTP method, is what keeps it
// public.
app.use('/webhook', webhookRoutes);

// Everything below this line is gated to private/Tailscale ranges, for EVERY
// method. This previously read app.get('/*', ...), which covered GET only.
app.use(ipCheckMiddleware);

app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', apiRoutes);
```

Delete the old `app.get('/*', ipCheckMiddleware);` line, the old
`app.use(express.static(...))` line, and the old `app.use('/webhook', webhookRoutes);`
line from further down, so each appears exactly once in the order above.

- [ ] **Step 9: Verify the app still boots and the ordering holds**

Run: `npm test`
Expected: PASS, 7 tests.

Run: `node -e "require('./server/index.js')" ` then `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/`
Expected: `200` (local peer is allowed). Stop the process with Ctrl-C. A MongoDB connection error in the log is expected and harmless if no database is running.

- [ ] **Step 10: Update the access-control note in `CLAUDE.md`**

In the `### Access control` section, replace the paragraph describing `app.get('/*', ...)` with:

```markdown
`ipCheckMiddleware` (`server/middleware/ipCheck.js`) is registered as
`app.use(ipCheckMiddleware)` in `index.js`, positioned *after* `/webhook` and
*before* everything else. So it gates **every method on every route** — static
files, `/api`, and `/mcp` — to private/CGNAT ranges (the list includes
`100.64.0.0/10`, the CGNAT range Tailscale hands out, and `::1/128`, which is
what a dual-stack `localhost` connection actually arrives as).

`POST /webhook` is public by *position*: it is mounted above the gate, because
Mailgun delivers over the internet. Its only protection is the signature check.
Any new route mounted below the gate is automatically covered; a new route
mounted above it is not.

The gate reads `req.socket.remoteAddress` and deliberately ignores
`X-Forwarded-For`. Reading that header is how this check used to work, and it
meant anyone who could reach the port could forge a private address. There is
no reverse proxy in production; if one is ever added, give the gate an
explicitly configured hop count from the right of the header rather than
restoring a blind first-value read.
```

- [ ] **Step 11: Commit**

```bash
git add package.json server/middleware/ipCheck.js server/index.js test/ipCheck.test.js CLAUDE.md
git commit -m "Gate on the real peer address and cover every method

The IP check read X-Forwarded-For first and unconditionally with no trust
proxy configured, so any client able to reach the port could forge a private
address and read the whole UI and API. It was also registered as app.get('/*'),
covering GET alone.

It now checks req.socket.remoteAddress and is mounted with app.use below
/webhook, so every other route is covered for every method while Mailgun
ingestion stays public by position. ::1/128 joins the allowlist because that is
what a dual-stack localhost connection arrives as."
```

---

### Task 2: Plan analysis

The heart of the safety story. Turns an explain document into a scan verdict.

**Files:**
- Create: `server/mcp/explain.js`
- Create: `test/explain.test.js`
- Use (already committed): `test/fixtures/*.json` — eleven real explain documents captured from MongoDB 8.3 with this repo's index set.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `analyzePlan(explainDoc, { hasFilter, hasLimit })` → `{ scanType, indexUsed, leadingBound, blockingStages, warnings }` where `scanType` is one of `'indexSeek' | 'fullIndexScan' | 'collectionScan'`, `indexUsed` is a string or `null`, `leadingBound` is a string or `null`, `blockingStages` is a string array, and `warnings` is a string array (empty when `scanType === 'indexSeek'`).
  - `isUnboundedBound(boundString)` → boolean.

- [ ] **Step 1: Confirm the fixtures are present**

Run: `ls test/fixtures/`
Expected: eleven `.json` files including `find-unanchored-regex-ci.json` and `find-exact-recipient.json`.

- [ ] **Step 2: Write the failing test**

Create `test/explain.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { analyzePlan, isUnboundedBound } = require('../server/mcp/explain');

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

test('recognises unbounded bound strings', () => {
  assert.strictEqual(isUnboundedBound('[MinKey, MaxKey]'), true);
  assert.strictEqual(isUnboundedBound('[MaxKey, MinKey]'), true);
  assert.strictEqual(isUnboundedBound('["", {})'), true);
  assert.strictEqual(isUnboundedBound('["user5@gmail.com", "user5@gmail.com"]'), false);
  assert.strictEqual(isUnboundedBound('["user5", "user6")'), false);
  assert.strictEqual(isUnboundedBound('[1758070000, 1758067200]'), false);
});

test('an exact recipient match is an index seek', () => {
  const r = analyzePlan(fixture('find-exact-recipient'), { hasFilter: true, hasLimit: true });
  assert.strictEqual(r.scanType, 'indexSeek');
  assert.strictEqual(r.indexUsed, 'recipient_1_timestamp_-1');
  assert.deepStrictEqual(r.warnings, []);
});

test('an exact match with collation seeks the recipient_ci index', () => {
  const r = analyzePlan(fixture('find-exact-collation'), { hasFilter: true, hasLimit: true });
  assert.strictEqual(r.scanType, 'indexSeek');
  assert.strictEqual(r.indexUsed, 'recipient_ci');
});

test('an anchored prefix regex is an index seek', () => {
  const r = analyzePlan(fixture('find-anchored-prefix'), { hasFilter: true, hasLimit: true });
  assert.strictEqual(r.scanType, 'indexSeek');
  assert.deepStrictEqual(r.warnings, []);
});

test('an unanchored case-insensitive regex is a FULL INDEX SCAN despite IXSCAN', () => {
  // The critical case. This plans as IXSCAN — a stage-name check passes it —
  // but its leading bound is ["", {}), meaning every key is read. This is the
  // 22-second query in docs/PERFORMANCE.md.
  const r = analyzePlan(fixture('find-unanchored-regex-ci'), { hasFilter: true, hasLimit: true });
  assert.strictEqual(r.scanType, 'fullIndexScan');
  assert.strictEqual(r.indexUsed, 'recipient_1_timestamp_-1');
  assert.strictEqual(r.leadingBound, '["", {})');
  assert.ok(r.warnings.length > 0);
  assert.match(r.warnings[0], /full index scan/i);
});

test('a filter on an unindexed field is a full index scan', () => {
  const r = analyzePlan(fixture('find-unindexed-field'), { hasFilter: true, hasLimit: true });
  assert.notStrictEqual(r.scanType, 'indexSeek');
  assert.ok(r.warnings.length > 0);
});

test('the unfiltered sorted list query is NOT flagged', () => {
  // Leading bound is full-range, but with no filter and a limit the query stops
  // after `limit` keys. This is the normal list page; flagging it would make
  // the gate cry wolf.
  const r = analyzePlan(fixture('find-unfiltered-sorted'), { hasFilter: false, hasLimit: true });
  assert.deepStrictEqual(r.warnings, []);
});

test('an indexed count is a seek, despite COUNT_SCAN\'s different bounds shape', () => {
  // COUNT_SCAN reports {startKey, endKey} rather than {field: ["[a, b]"]}.
  // Reading it like an IXSCAN treats "startKey" as the leading field name.
  const r = analyzePlan(fixture('count-indexed'), { hasFilter: true, hasLimit: false });
  assert.strictEqual(r.scanType, 'indexSeek');
  assert.strictEqual(r.indexUsed, 'event_1_timestamp_-1');
  assert.strictEqual(r.leadingBound, '["delivered", "delivered"]');
  assert.deepStrictEqual(r.warnings, []);
});

test('a collation seek is not mistaken for a scan', () => {
  // Collation bounds render as CollationKey(0x...) rather than the raw value.
  const r = analyzePlan(fixture('find-exact-collation'), { hasFilter: true, hasLimit: true });
  assert.strictEqual(r.scanType, 'indexSeek');
  assert.match(r.leadingBound, /CollationKey/);
  assert.deepStrictEqual(r.warnings, []);
});

test('an unbounded COUNT_SCAN is flagged', () => {
  const r = analyzePlan({
    queryPlanner: { winningPlan: { stage: 'COUNT', inputStage: {
      stage: 'COUNT_SCAN', indexName: 'event_1_timestamp_-1',
      indexBounds: {
        startKey: { event: { _bsontype: 'MinKey' } },
        endKey: { event: { _bsontype: 'MaxKey' } },
      },
    } } },
  }, { hasFilter: true, hasLimit: false });
  assert.strictEqual(r.scanType, 'fullIndexScan');
  assert.ok(r.warnings.length > 0);
});

test('an unindexed count is a collection scan', () => {
  const r = analyzePlan(fixture('count-unindexed'), { hasFilter: true, hasLimit: false });
  assert.strictEqual(r.scanType, 'collectionScan');
  assert.ok(r.warnings.some((w) => /collection scan/i.test(w)));
});

test('an indexed aggregate with $group reports the blocking stage but seeks', () => {
  const r = analyzePlan(fixture('agg-indexed-group'), { hasFilter: true, hasLimit: false });
  assert.strictEqual(r.scanType, 'indexSeek');
  assert.ok(r.blockingStages.includes('GROUP'));
});

test('an unindexed aggregate is a collection scan', () => {
  const r = analyzePlan(fixture('agg-unindexed-group'), { hasFilter: true, hasLimit: false });
  assert.strictEqual(r.scanType, 'collectionScan');
  assert.ok(r.warnings.length > 0);
});

test('an aggregate with a blocking sort reports it', () => {
  const r = analyzePlan(fixture('agg-blocking-sort'), { hasFilter: true, hasLimit: false });
  assert.ok(r.blockingStages.length > 0);
});

test('handles an explain document with no recognisable plan', () => {
  const r = analyzePlan({}, { hasFilter: true, hasLimit: false });
  assert.strictEqual(r.scanType, 'indexSeek');
  assert.deepStrictEqual(r.warnings, []);
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../server/mcp/explain'`.

- [ ] **Step 4: Implement `server/mcp/explain.js`**

```js
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
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test`
Expected: PASS. 7 ipCheck tests + 15 explain tests.

- [ ] **Step 6: Commit**

```bash
git add server/mcp/explain.js test/explain.test.js
git commit -m "Classify query plans by index bounds

Detects scans from the leading field's index bounds rather than the stage name,
because the unanchored case-insensitive regex — the 22-second query in
PERFORMANCE.md — plans as IXSCAN and a stage check passes it through.

Tested against eleven explain documents captured from a real MongoDB 8.3 with
this repo's index set."
```

---

### Task 3: Query sanitization and execution

**Files:**
- Create: `server/mcp/query.js`
- Create: `test/query.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `assertReadOnlyPipeline(pipeline)` → throws `Error` with a message naming the offending stage; returns `undefined` when clean.
  - `coerceIds(filter)` → a new filter with 24-hex `_id` strings converted to `ObjectId`.
  - `truncateDocs(docs, maxBytes)` → `{ docs, returned, truncated }`.
  - `COLLECTIONS` → `['webhooks', 'messages']`.
  - `DEFAULTS` → `{ limit: 50, maxLimit: 1000, maxTimeMS: 15000, maxTimeCeiling: 120000, maxBytes: 100000 }`.

- [ ] **Step 1: Write the failing test**

Create `test/query.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { assertReadOnlyPipeline, coerceIds, truncateDocs } = require('../server/mcp/query');

test('allows a legitimate pipeline', () => {
  assert.doesNotThrow(() => assertReadOnlyPipeline([
    { $match: { event: 'delivered' } },
    { $group: { _id: '$recipient', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 10 },
  ]));
});

for (const stage of ['$out', '$merge']) {
  test(`rejects ${stage} at the top level`, () => {
    assert.throws(() => assertReadOnlyPipeline([{ $match: {} }, { [stage]: 'x' }]),
      new RegExp(`\\${stage}`));
  });
}

for (const op of ['$function', '$where', '$accumulator']) {
  test(`rejects ${op} anywhere in the pipeline`, () => {
    assert.throws(() => assertReadOnlyPipeline([{ $match: { [op]: 'code' } }]),
      new RegExp(`\\${op}`));
  });
}

test('rejects $out nested inside $facet', () => {
  // A top-level-only scan is trivially bypassed. This is the test that catches
  // it.
  assert.throws(() => assertReadOnlyPipeline([
    { $facet: { a: [{ $match: {} }, { $out: 'stolen' }] } },
  ]), /\$out/);
});

test('rejects $merge nested inside $lookup.pipeline', () => {
  assert.throws(() => assertReadOnlyPipeline([
    { $lookup: { from: 'messages', pipeline: [{ $merge: 'x' }], as: 'm' } },
  ]), /\$merge/);
});

test('rejects $function nested inside $unionWith.pipeline', () => {
  assert.throws(() => assertReadOnlyPipeline([
    { $unionWith: { coll: 'messages', pipeline: [{ $match: { $function: {} } }] } },
  ]), /\$function/);
});

test('rejects a non-array pipeline', () => {
  assert.throws(() => assertReadOnlyPipeline({ $match: {} }), /array/i);
});

test('coerces a 24-hex _id string to ObjectId', () => {
  const id = '507f1f77bcf86cd799439011';
  const out = coerceIds({ _id: id });
  assert.ok(out._id instanceof mongoose.Types.ObjectId);
  assert.strictEqual(out._id.toString(), id);
});

test('coerces every element of an _id $in array', () => {
  const ids = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'];
  const out = coerceIds({ _id: { $in: ids } });
  assert.strictEqual(out._id.$in.length, 2);
  assert.ok(out._id.$in.every((v) => v instanceof mongoose.Types.ObjectId));
});

test('leaves a non-hex _id alone', () => {
  const out = coerceIds({ _id: 'not-an-object-id' });
  assert.strictEqual(out._id, 'not-an-object-id');
});

test('leaves other fields untouched and does not mutate the input', () => {
  const input = { recipient: 'a@b.com', timestamp: { $gte: 1 } };
  const out = coerceIds(input);
  assert.deepStrictEqual(out, input);
  assert.notStrictEqual(out, input);
});

test('returns everything when under the byte cap', () => {
  const docs = [{ a: 1 }, { a: 2 }];
  const r = truncateDocs(docs, 100000);
  assert.strictEqual(r.returned, 2);
  assert.strictEqual(r.truncated, false);
});

test('stops at the byte cap and reports truncation', () => {
  const docs = Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(200) }));
  const r = truncateDocs(docs, 5000);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.returned < 500);
  assert.ok(r.returned > 0);
  assert.strictEqual(r.docs.length, r.returned);
});

test('reports truncation even when the first document exceeds the cap', () => {
  const r = truncateDocs([{ pad: 'x'.repeat(10000) }], 100);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.returned, 0);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../server/mcp/query'`.

- [ ] **Step 3: Implement `server/mcp/query.js`**

```js
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
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm test`
Expected: PASS. 7 ipCheck + 15 explain + 17 query tests.

- [ ] **Step 5: Commit**

```bash
git add server/mcp/query.js test/query.test.js
git commit -m "Add read-only pipeline guard, _id coercion and result truncation

The stage guard recurses into nested pipelines, because \$out and \$merge can
hide inside \$facet, \$lookup.pipeline and \$unionWith.pipeline and a
top-level-only scan is trivially bypassed."
```

---

### Task 4: Agent instructions

**Files:**
- Create: `server/mcp/instructions.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `INSTRUCTIONS` (string), `TOOL_DESCRIPTIONS` (object with keys `find`, `aggregate`, `count`, `describe_collection`, each a string).

- [ ] **Step 1: Create `server/mcp/instructions.js`**

```js
/**
 * Guidance delivered to the connecting agent.
 *
 * INSTRUCTIONS is returned in the `initialize` response, so it lands in the
 * agent's context automatically — this is why the project has no AGENTS.md.
 */

const INSTRUCTIONS = `
This server exposes a READ-ONLY view of a Mailgun webhook archive in MongoDB.

# Scale

The \`webhooks\` collection holds roughly 100 MILLION documents. Ordinary-looking
queries take multiple seconds or time out. Call \`describe_collection\` first to
see the available indexes, and write queries that an index can serve.

Every query is planned before it runs. If the plan is a collection scan or a
full index scan, the tool returns a warning INSTEAD of results, with
\`requiresConfirmation: true\`. When that happens: tell the human what the query
will cost and why, and only re-call with \`allowFullScan: true\` if they agree.
Do not re-call with \`allowFullScan: true\` automatically.

# Schema traps

1. \`timestamp\` is a NUMBER — unix SECONDS, not a Date and not milliseconds.
   Comparing it to a Date matches nothing under BSON type ordering and returns
   zero rows with no error. This is the single most common mistake here.

2. Exact recipient matching needs \`collation: {"locale":"en","strength":2}\`.
   With it, the query seeks the case-folded \`recipient_ci\` index (1 key).
   Without it, matching is case-sensitive against a different index.

3. NEVER use {"$regex": "x", "$options": "i"}. Unanchored + case-insensitive
   cannot seek a b-tree, so it reads every key in the index — measured at 22
   seconds. Use an exact match, or an anchored prefix {"$regex": "^x"}.

4. \`message-headers\` on the \`messages\` collection is an ARRAY of
   [name, value] pairs, not an object.

5. Mailgun's payload uses dashed keys (\`client-info\`, \`user-variables\`,
   \`delivery-status\`) but the schema declares camelCase, and Mongoose dropped
   the mismatches on write. Several fields Mailgun documents are therefore
   ABSENT from stored documents. Confirm a field actually has values before
   building an answer on it.

6. \`hint\` must name an index (e.g. "recipient_ci"), not a key pattern:
   \`recipient_ci\` and \`recipient_1_timestamp_-1\` share a key pattern and
   differ only by collation.

# Collections

- \`webhooks\` — one document per Mailgun event. Fields include \`event\`
  (accepted, delivered, opened, clicked, unsubscribed, complained, failed,
  permanent_fail, temporary_fail), \`timestamp\`, \`recipient\`, \`tags\`,
  \`message.headers.message-id\`, \`message.headers.subject\`.
- \`messages\` — stored MIME bodies, keyed by \`messageId\`. A body exists only
  if some event for that message carried a storage URL, so most messages have
  no body. \`body-html\` and \`body-plain\` are excluded by default because they
  are large; request them explicitly in a projection if you need them.

# Worked example

"How many emails did user-x@gmail.com receive in the prior year?"

count({
  "collection": "webhooks",
  "filter": {
    "recipient": "user-x@gmail.com",
    "event": "delivered",
    "timestamp": {"$gte": 1758067200, "$lte": 1789603200}
  },
  "collation": {"locale": "en", "strength": 2}
})

Note "received" means the \`delivered\` event; \`accepted\` counts what Mailgun
took from the sender, which is a different question. If the distinction matters
to the user's question, say so.
`.trim();

const TOOL_DESCRIPTIONS = {
  find:
    'Read documents from a collection. Returns at most `limit` documents ' +
    '(default 50, max 1000) and is additionally capped at ~100KB of serialized ' +
    'output. On the `messages` collection, `body-html` and `body-plain` are ' +
    'excluded unless you name them in a projection. The query plan is checked ' +
    'first; a scan returns a warning instead of results.',
  aggregate:
    'Run an aggregation pipeline. Read-only: $out, $merge, $function, $where ' +
    'and $accumulator are rejected anywhere in the pipeline, including nested ' +
    'inside $facet, $lookup and $unionWith. Put the most selective indexed ' +
    '$match first. The query plan is checked first; a scan returns a warning ' +
    'instead of results.',
  count:
    'Count matching documents. An empty filter returns the fast metadata ' +
    'estimate (flagged `estimated: true`) rather than scanning. A filtered ' +
    'count has no limit to bound it, so an unindexed filter is especially ' +
    'expensive — the plan is checked first and a scan returns a warning.',
  describe_collection:
    'List a collection\'s indexes (name, key pattern, collation) and its ' +
    'approximate document count. Call this BEFORE writing a query, so you can ' +
    'choose a filter an index can serve.',
};

module.exports = { INSTRUCTIONS, TOOL_DESCRIPTIONS };
```

- [ ] **Step 2: Verify it loads and exports strings**

Run:
```bash
node -e "const i=require('./server/mcp/instructions'); console.log(i.INSTRUCTIONS.length > 500, Object.keys(i.TOOL_DESCRIPTIONS).join(','))"
```
Expected: `true find,aggregate,count,describe_collection`

- [ ] **Step 3: Commit**

```bash
git add server/mcp/instructions.js
git commit -m "Add agent-facing MCP instructions

Delivered in the initialize response, so it reaches the agent automatically.
Leads with the timestamp-is-unix-seconds trap, which returns zero rows silently
rather than erroring."
```

---

### Task 5: The four tools

**Files:**
- Create: `server/mcp/tools.js`

**Interfaces:**
- Consumes: `analyzePlan` (Task 2); `COLLECTIONS`, `DEFAULTS`, `assertReadOnlyPipeline`, `coerceIds`, `truncateDocs` (Task 3); `TOOL_DESCRIPTIONS` (Task 4).
- Produces: `registerTools(server, db)` — registers all four tools on an `McpServer`. `db` is a raw driver `Db`.

- [ ] **Step 1: Implement `server/mcp/tools.js`**

```js
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
```

- [ ] **Step 0: Install the dependencies**

`tools.js` requires `zod` at module load, so the dependencies land here rather
than in Task 6:

```bash
npm install @modelcontextprotocol/sdk@^1.30.0 zod@^4
```

- [ ] **Step 2: Verify the module loads**

Run: `node -e "console.log(typeof require('./server/mcp/tools').registerTools)"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json server/mcp/tools.js
git commit -m "Add find, aggregate, count and describe_collection tools

The explained command and the executed command are built from one object, so
the plan check sees the same collation and hint as the real query. Explaining
without the collation would plan a different query, report a scan, and block
exactly the fast exact-recipient lookup this exists to serve.

count with an empty filter returns the metadata estimate rather than scanning."
```

---

### Task 6: Mount the endpoint

**Files:**
- Create: `server/mcp/index.js`
- Modify: `server/index.js`
- Modify: `package.json`
- Modify: `Dockerfile`
- Create: `test/mcp.test.js`

**Interfaces:**
- Consumes: `registerTools` (Task 5), `INSTRUCTIONS` (Task 4).
- Produces: an Express `Router` mounted at `/mcp`.

- [ ] **Step 1: Confirm the dependencies are present**

Installed in Task 5 Step 0. Verify rather than reinstall:

Run: `node -e "require('@modelcontextprotocol/sdk/server/mcp.js'); require('zod'); console.log('deps ok')"`
Expected: `deps ok`

- [ ] **Step 2: Bump the base image**

In `Dockerfile`, change `FROM node:18` to `FROM node:22`. Node 18 is end-of-life.

- [ ] **Step 3: Write the failing test**

Create `test/mcp.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mcpRouter = require('../server/mcp');

// A stub Db standing in for mongoose.connection.db. Records what it was asked
// to do so the test can assert the guard fired without needing a live MongoDB.
function stubDb({ explainResult }) {
  return {
    commandCalls: [],
    command(cmd) {
      this.commandCalls.push(cmd);
      return Promise.resolve(explainResult);
    },
    collection() {
      return {
        indexes: () => Promise.resolve([{ name: '_id_', key: { _id: 1 } }]),
        estimatedDocumentCount: () => Promise.resolve(12345),
        countDocuments: () => Promise.resolve(7),
        find() { return this; },
        limit() { return this; },
        maxTimeMS() { return this; },
        sort() { return this; },
        skip() { return this; },
        collation() { return this; },
        hint() { return this; },
        toArray: () => Promise.resolve([{ _id: 'a', event: 'delivered' }]),
      };
    },
  };
}

const COLLSCAN_EXPLAIN = {
  queryPlanner: { winningPlan: { stage: 'COLLSCAN', filter: { reason: { $eq: 'x' } } } },
};
const IXSCAN_EXPLAIN = {
  queryPlanner: {
    winningPlan: {
      stage: 'FETCH',
      inputStage: {
        stage: 'IXSCAN',
        indexName: 'recipient_ci',
        indexBounds: { recipient: ['["a@b.com", "a@b.com"]'], timestamp: ['[MaxKey, MinKey]'] },
      },
    },
  },
};

function withApp(db, fn) {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/mcp', mcpRouter(() => db));
    const server = app.listen(0, '127.0.0.1', async () => {
      const url = `http://127.0.0.1:${server.address().port}/mcp`;
      const out = await fn(url);
      server.close(() => resolve(out));
    });
  });
}

// Responses come back as SSE even in stateless mode, so pull the JSON out of
// the `data:` line.
async function rpc(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return line ? JSON.parse(line.slice(5).trim()) : { raw: text, status: res.status };
}

const init = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

test('initialize returns the agent instructions', async () => {
  const out = await withApp(stubDb({ explainResult: IXSCAN_EXPLAIN }), (url) => rpc(url, init));
  assert.ok(out.result.instructions.includes('unix SECONDS'));
});

test('tools/list exposes all four tools', async () => {
  const out = await withApp(stubDb({ explainResult: IXSCAN_EXPLAIN }), async (url) => {
    await rpc(url, init);
    return rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
  const names = out.result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['aggregate', 'count', 'describe_collection', 'find']);
});

test('a scanning query is blocked and not executed', async () => {
  const out = await withApp(stubDb({ explainResult: COLLSCAN_EXPLAIN }), async (url) => {
    await rpc(url, init);
    return rpc(url, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'find', arguments: { collection: 'webhooks', filter: { reason: 'x' } } },
    });
  });
  const payload = JSON.parse(out.result.content[0].text);
  assert.strictEqual(payload.executed, false);
  assert.strictEqual(payload.requiresConfirmation, true);
  assert.ok(payload.warnings.length > 0);
});

test('allowFullScan executes the same query', async () => {
  const out = await withApp(stubDb({ explainResult: COLLSCAN_EXPLAIN }), async (url) => {
    await rpc(url, init);
    return rpc(url, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'find', arguments: { collection: 'webhooks', filter: { reason: 'x' }, allowFullScan: true } },
    });
  });
  const payload = JSON.parse(out.result.content[0].text);
  assert.strictEqual(payload.executed, true);
  assert.ok(payload.warnings.length > 0, 'warnings still reported when overridden');
});

test('an index-backed query runs without confirmation', async () => {
  const out = await withApp(stubDb({ explainResult: IXSCAN_EXPLAIN }), async (url) => {
    await rpc(url, init);
    return rpc(url, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: {
        name: 'find',
        arguments: {
          collection: 'webhooks',
          filter: { recipient: 'a@b.com' },
          collation: { locale: 'en', strength: 2 },
        },
      },
    });
  });
  const payload = JSON.parse(out.result.content[0].text);
  assert.strictEqual(payload.executed, true);
  assert.deepStrictEqual(payload.warnings, []);
  assert.strictEqual(payload.plan.indexUsed, 'recipient_ci');
});

test('the explain carries the collation through to the planner', async () => {
  // Regression guard: explaining without the collation plans a different query
  // and would wrongly report a scan for the fast exact-recipient lookup.
  const db = stubDb({ explainResult: IXSCAN_EXPLAIN });
  await withApp(db, async (url) => {
    await rpc(url, init);
    return rpc(url, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: {
        name: 'find',
        arguments: {
          collection: 'webhooks',
          filter: { recipient: 'a@b.com' },
          collation: { locale: 'en', strength: 2 },
        },
      },
    });
  });
  const explainCall = db.commandCalls.find((c) => c.explain);
  assert.deepStrictEqual(explainCall.explain.collation, { locale: 'en', strength: 2 });
});

test('a write stage is rejected before any database call', async () => {
  const db = stubDb({ explainResult: IXSCAN_EXPLAIN });
  const out = await withApp(db, async (url) => {
    await rpc(url, init);
    return rpc(url, {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        name: 'aggregate',
        arguments: {
          collection: 'webhooks',
          pipeline: [{ $facet: { a: [{ $out: 'stolen' }] } }],
        },
      },
    });
  });
  assert.strictEqual(out.result.isError, true);
  assert.match(out.result.content[0].text, /\$out/);
  assert.strictEqual(db.commandCalls.length, 0, 'must reject before touching the database');
});

test('an empty count filter uses the metadata estimate', async () => {
  const db = stubDb({ explainResult: IXSCAN_EXPLAIN });
  const out = await withApp(db, async (url) => {
    await rpc(url, init);
    return rpc(url, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'count', arguments: { collection: 'webhooks' } },
    });
  });
  const payload = JSON.parse(out.result.content[0].text);
  assert.strictEqual(payload.estimated, true);
  assert.strictEqual(payload.count, 12345);
  assert.strictEqual(db.commandCalls.length, 0, 'must not explain or scan for an empty filter');
});
```

- [ ] **Step 4: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../server/mcp'`.

- [ ] **Step 5: Implement `server/mcp/index.js`**

```js
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { INSTRUCTIONS } = require('./instructions');
const { registerTools } = require('./tools');

/**
 * Express router exposing the read-only MCP endpoint.
 *
 * Stateless: a fresh McpServer and transport are built per request
 * (`sessionIdGenerator: undefined`). There is no session state worth keeping
 * for a read-only query API, and the endpoint survives an app restart
 * mid-conversation.
 *
 * Access control is the IP gate in server/index.js, which this router is
 * mounted below. It is NOT re-applied here — one correctly placed gate beats
 * two.
 *
 * @param {() => import('mongodb').Db} getDb resolves the raw driver Db lazily,
 *   so the router can be mounted before MongoDB finishes connecting.
 */
module.exports = function mcpRouter(getDb) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const server = new McpServer(
      { name: 'mailgun-webhooks', version: '1.0.0' },
      { instructions: INSTRUCTIONS }
    );

    try {
      registerTools(server, getDb());
    } catch (err) {
      console.error('MCP tool registration failed:', err);
      return res.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Database unavailable' },
        id: null,
      });
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no stream to resume and no session to delete.
  router.all('/', (req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST.' },
      id: null,
    });
  });

  return router;
};
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npm test`
Expected: PASS. All 8 MCP tests green, alongside the earlier suites.

- [ ] **Step 7: Mount the router in `server/index.js`**

Add near the other route requires:

```js
const mcpRouter = require('./mcp');
```

Then, immediately after the `app.use('/api', apiRoutes);` line (so it sits below the IP gate):

```js
// Read-only MCP endpoint for AI agents. Below the IP gate, so it is reachable
// only from the private/Tailscale ranges.
app.use('/mcp', mcpRouter(() => mongoose.connection.db));
```

- [ ] **Step 8: Verify the full app boots with the endpoint mounted**

Run: `npm test`
Expected: PASS, all suites.

Run: `node -e "require('./server/index.js')"` in one terminal, then:
```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'
```
Expected: an SSE `data:` line whose JSON contains `"serverInfo":{"name":"mailgun-webhooks"` and an `instructions` field. Stop the process afterwards.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json Dockerfile server/mcp/index.js server/index.js test/mcp.test.js
git commit -m "Mount the read-only MCP endpoint at POST /mcp

Stateless streamable HTTP: a fresh server and transport per request, no session
state to manage. Mounted below the IP gate, so it inherits the private/Tailscale
restriction rather than carrying its own check.

Also bumps the Docker base image off end-of-life Node 18."
```

---

### Task 7: Verify against a real database and document it

Every test so far uses fixtures or stubs. This task proves the thing works end to end, and writes down how to connect to it.

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
```
Wait for `Connected to MongoDB` in `docker compose logs app`.

- [ ] **Step 2: Seed enough data to plan against**

```bash
docker compose exec -T mongodb mongosh mailgun-webhooks --quiet --eval '
for (let i = 0; i < 5000; i++) {
  db.webhooks.insertOne({
    event: i % 3 ? "delivered" : "opened",
    timestamp: 1758067200 + i * 60,
    recipient: "user" + i + "@gmail.com",
    message: { headers: { "message-id": "m" + i, subject: "Subject " + i } }
  });
}
print("seeded " + db.webhooks.countDocuments({}));
'
node scripts/migrate-indexes.js --apply
```

- [ ] **Step 3: Confirm `describe_collection` reports the real indexes**

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"describe_collection","arguments":{"collection":"webhooks"}}}'
```
Expected: an index list including `recipient_ci` with `strength: 2`, and a non-zero `estimatedDocumentCount`.

- [ ] **Step 4: Confirm the motivating question answers without a warning**

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"count","arguments":{"collection":"webhooks","filter":{"recipient":"user42@gmail.com","event":"delivered","timestamp":{"$gte":1758067200,"$lte":1789603200}},"collation":{"locale":"en","strength":2}}}}'
```
Expected: `"executed": true`, `"warnings": []`, and a numeric count. If `warnings` is non-empty, the collation is not reaching the planner — check that `planAndGuard` receives the same command object that is executed.

- [ ] **Step 5: Confirm the slow regex IS blocked**

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find","arguments":{"collection":"webhooks","filter":{"recipient":{"$regex":"user42","$options":"i"}}}}}'
```
Expected: `"executed": false`, `"requiresConfirmation": true`, and a warning naming a full index scan. **This is the acceptance test for the whole feature** — this query plans as `IXSCAN`, so if it comes back executed, the bounds check is not working.

- [ ] **Step 6: Confirm the override works**

Re-run Step 5 with `"allowFullScan": true` added to `arguments`.
Expected: `"executed": true`, with the warning still present in `warnings`.

- [ ] **Step 7: Confirm a write stage is refused**

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"aggregate","arguments":{"collection":"webhooks","pipeline":[{"$facet":{"a":[{"$out":"stolen"}]}}]}}}'
```
Expected: an error naming `$out`. Then confirm nothing was created:
```bash
docker compose exec -T mongodb mongosh mailgun-webhooks --quiet --eval 'printjson(db.getCollectionNames())'
```
Expected: no `stolen` collection.

- [ ] **Step 8: Tear down**

```bash
docker compose down -v
```

- [ ] **Step 9: Document the endpoint in `README.md`**

Append:

```markdown
## MCP endpoint (read-only, for AI agents)

`POST /mcp` exposes the webhook archive to MCP-capable agents as a read-only
query interface. It is behind the same IP gate as the web UI, so it is reachable
only from the private/Tailscale ranges.

Add it to Claude Code:

```bash
claude mcp add --transport http mailgun http://<tailscale-host>:3000/mcp
```

Tools: `describe_collection`, `find`, `count`, `aggregate`. Usage guidance —
the schema traps, which queries are index-backed — is delivered to the agent
automatically in the MCP `instructions` block; there is no separate doc to read.

Queries are planned before they run. Anything that would scan the collection or
walk an entire index comes back with `requiresConfirmation: true` and is not
executed; re-call with `allowFullScan: true` to override.

If a client reports `406 Not Acceptable`, it is not sending
`Accept: application/json, text/event-stream`, which the protocol requires.
```

- [ ] **Step 10: Document it in `CLAUDE.md`**

In the `## Architecture` section, after the **Viewing** paragraph, add:

```markdown
**Agent queries** (`server/mcp/`, mounted at `POST /mcp`) — a read-only MCP
endpoint. Four tools (`find`, `aggregate`, `count`, `describe_collection`) pass
queries to the raw driver; `server/mcp/instructions.js` carries the schema
guidance the agent receives at `initialize`.

Every query is planned with a `queryPlanner` explain before it runs, and
`server/mcp/explain.js` classifies the plan by the **index bounds on the leading
field**, not by stage name. That distinction matters: the unanchored
case-insensitive regex — the 22-second query in `docs/PERFORMANCE.md` — plans as
`IXSCAN`, so a COLLSCAN check would pass the worst query shape here straight
through. A flagged query returns its warning instead of results and runs only on
an explicit `allowFullScan: true`.

Read-only is enforced in code, not by a database user: `$out`, `$merge`,
`$function`, `$where` and `$accumulator` are rejected anywhere in a pipeline,
including nested inside `$facet`, `$lookup` and `$unionWith`.
```

Also update the `## Commands` block to include:

```bash
npm test                   # node --test; no framework, no build step
```

and correct the line in that section which currently reads "There is no test
suite, linter, or build step" to "There is no linter or build step; `npm test`
runs Node's built-in test runner."

- [ ] **Step 11: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Document the MCP endpoint

Records the acceptance test that matters: the unanchored case-insensitive
regex must come back blocked, because it plans as IXSCAN and a stage-name
check would let it through."
```

---

## Verification

After Task 7, the following must all hold:

- [ ] `npm test` passes with all suites green.
- [ ] A forged `X-Forwarded-For: 10.0.0.1` from a public peer gets 403.
- [ ] `POST /webhook` still reaches its handler from a public peer.
- [ ] The motivating question — count for one recipient over a year — executes with no warnings.
- [ ] `{"$regex": "...", "$options": "i"}` comes back `executed: false`.
- [ ] `$out` nested inside `$facet` is refused and creates no collection.
