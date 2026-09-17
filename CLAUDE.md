# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
docker compose up          # Full stack: app (:3000), MongoDB (:27017), mongo-express (127.0.0.1:8081, admin/pass)
npm run dev                # App only, with nodemon reload (requires a reachable MONGODB_URI)
npm start                  # App only, no reload

node scripts/migrate-indexes.js            # dry run: print the index plan
node scripts/migrate-indexes.js --apply    # create new indexes, then drop dead ones

npm test                   # node --test; no framework, no build step
```

Docker Compose bind-mounts `./server`, `./public`, and `./.env`, so edits reload live inside the container. Copy `.env.sample` to `.env` first; `MAILGUN_API_KEY` doubles as both the webhook signing key and the HTTP Basic password used to fetch stored message bodies.

There is no linter or build step; `npm test` runs Node's built-in test runner.

## Architecture

Express + Mongoose app with two halves that meet in MongoDB:

**Ingest** (`server/routes/webhook.js`, mounted at `POST /webhook`) — Mailgun posts here. The handler verifies the HMAC-SHA256 signature (`timestamp + token` keyed by `MAILGUN_API_KEY`), saves `req.body['event-data']` as a `Webhook` document, and — only when the event carries `storage.url` and no `Message` exists yet for that `message-id` — fetches the full MIME content from Mailgun and saves it as a `Message`. So a message body exists only if some event for it included a storage URL (typically `accepted`/`stored`); the viewer must tolerate its absence.

**Viewing** (`server/routes/api.js` at `/api`, plus static `public/`) — three pages, each a static HTML file paired with a script that fetches JSON:
- `index.html` + `js/events.js` → `GET /api/webhooks` (filter, paginate, search)
- `event.html` + `js/event.js` → `GET /api/webhooks/:id`, which returns the event *plus* every sibling event sharing its `message.headers['message-id']`, rendered as a timeline
- `message.html` + `js/message.js` → `GET /api/messages/:id` (`:id` is the Mailgun message-id, not a Mongo `_id`), rendering the stored body in a sandboxed iframe

Search state round-trips through the URL: the list page writes filters as query params, and links into `event.html` re-encode them with a `search_` prefix so the back link can restore them.

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
`$function`, `$where` and `$accumulator` are rejected anywhere in ANY
caller-controlled object — filter, projection, sort and pipeline — including
nested inside `$facet`, `$lookup`, `$unionWith` and `$expr`. Lookup stages may
only target `webhooks` or `messages`. Results are drained one document at a
time to a byte and count budget, never `toArray()`'d, because this process also
hosts webhook ingestion.

The router refuses any request with an `Origin` header and enforces a Host
allowlist (`MCP_ALLOWED_HOSTS`). Both exist because the IP gate checks the TCP
peer, and a browser on the allowed network lends that position to any page it
loads. Global CORS was removed for the same reason.

### Access control

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

## Scale

The production `webhooks` collection holds ~100M documents. That number is the
single most important fact about this codebase: it turns ordinary-looking query
code into multi-second scans. Before changing anything under `/api`, read
`docs/PERFORMANCE.md` — it records measured before/after numbers and explains
why the query shapes are written the way they are.

The rules that follow from it:

- **Never add `countDocuments()` on an unbounded filter.** It scans. Use
  `estimatedDocumentCount()` when there is no filter, or cap it with
  `.limit(COUNT_CAP + 1)` and report "N+".
  The MCP `count` tool deliberately runs the `count` command on caller-supplied
  filters; it is protected by the plan gate (a scan returns
  `requiresConfirmation` instead of running) and by `maxTimeMS`, which is why it
  is the one exception.
- **Never use `{ $regex: input, $options: 'i' }`.** An unanchored
  case-insensitive regex cannot seek into an index and will examine every key in
  the collection. Use exact match against the `recipient_ci` collation index, or
  an anchored `/^escaped/` prefix. Always run user input through `escapeRegex` —
  it governs how much of the string MongoDB can seek on, not just correctness.
- **Index order follows ESR**: equality fields, then sort fields, then ranges.
- **Every index must map to a real query.** Four indexes here were maintained
  for years against queries that did not exist. Check `$indexStats` before
  adding one, and record the reasoning in the model file.
- **Indexes are built by `scripts/migrate-indexes.js`, not on boot.**
  `server/index.js` sets `autoIndex: false`; Mongoose would otherwise start
  multi-GB index builds on every restart.

## Data model gotchas

`server/models/webhook.js` and `server/models/message.js` store Mailgun payloads
nearly verbatim, which leaves several sharp edges:

- **`timestamp` is a Number (unix seconds)**, not a Date. The frontend
  multiplies by 1000, and `api.js` converts date inputs with `toUnix()`. The
  original code compared this field against `Date` objects, which under BSON
  type ordering never matches — the date filter silently returned zero rows for
  as long as it existed. Don't reintroduce that.
- **Mailgun's event payload uses dashed keys** (`client-info`,
  `delivery-status`, `log-level`, `user-variables`) while the schema declares
  camelCase (`clientInfo`, `delivery`). Mongoose is strict by default, so a key
  that doesn't match the schema is silently dropped. Confirm a field actually
  populates against a real payload before building UI on it.
- **`Message` keeps Mailgun's literal field names** — `body-html`, `body-plain`,
  `message-headers` — so they need bracket notation. `message-headers` is an
  array of `[name, value]` pairs, not an object; `js/message.js` has a
  `getHeader` helper for it.
- **`recipient_ci` shares a key pattern with `recipient_1_timestamp_-1`**,
  differing only by collation. `.hint()` on that key pattern is ambiguous — hint
  by index name. A query only reaches the collation index if it passes the
  matching `.collation()`; forget it and the query silently scans instead.

## Known rough edges

Not perf-related, and not addressed:

- `displayWebhooks()` in `public/js/events.js` interpolates `recipient` and
  `subject` straight into `innerHTML`. Those values come from inbound webhook
  payloads, so a crafted subject line is stored XSS against anyone viewing the
  list. The same pattern is in `event.js`.
- `.gitignore` was empty for years; it now covers `node_modules/`, `.env`, and the `.superpowers/` scratch directory.
