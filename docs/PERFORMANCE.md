# Why the webhook list and search were slow

Measured on a local throwaway MongoDB 8.3 seeded with **3,000,000** synthetic
webhook documents using the index set this repo shipped with. Production holds
roughly **100M**, so multiply the "before" numbers by ~33 — every one of them
scales linearly with collection size.

## Before / after (end-to-end HTTP, best of 3)

| Request | Before | After |
|---|---:|---:|
| First page load, no filters | 690 ms | 18 ms |
| Search one full email address | 22,384 ms | 15 ms |
| Search an address with no matches | 22,433 ms | 13 ms |
| Search by name prefix | 1,349 ms | 21 ms |
| Filter `event=complained` | 39 ms | 15 ms |
| Date-range filter | 14 ms (returned 0 rows — broken) | 15 ms |
| Deep page (page 400) | 690 ms | 17 ms |

## The two root causes

### 1. Unanchored case-insensitive `$regex` cannot use an index

The old query was:

```js
query.recipient = { $regex: recipient, $options: 'i' };
```

A regex that is neither anchored to the start of the string nor case-sensitive
gives the b-tree nothing to seek on, so MongoDB must examine **every key in the
index**. `explain()` on the 3M-document set, searching for one specific address:

```
keysExamined = 3000000    docsExamined = 1    nReturned = 1    1487 ms
```

It read three million index entries to return one row. At 100M that is 100M
reads per search. The same query as an exact match:

```
keysExamined = 1          docsExamined = 1    nReturned = 1       0 ms
```

**Fix.** `server/routes/api.js` now classifies the input:

- Input that parses as a complete email address → exact match, run against the
  `recipient_ci` index (collation `{locale:'en', strength:2}`, i.e. the index
  itself is case-folded). One key examined, case-insensitivity preserved.
- Anything else → anchored, regex-escaped prefix match (`/^inputhere/`) against
  the plain `recipient` index.
- `?match=contains` restores the old substring behaviour for the rare case that
  needs it. It is slow by construction and bounded by `maxTimeMS`.

Escaping the input matters for speed, not just correctness: MongoDB can only
seek on the literal prefix before the first regex metacharacter, so an
unescaped `maria.thomas5490` seeks on `maria` (187,035 keys, 1505 ms) while the
escaped `maria\.thomas5490` seeks on the whole string (3 keys, 0 ms).

### 2. `countDocuments()` always scans

Every list request ran `countDocuments(query)` to build the pager. With no
filters that is a full pass over the collection for a number MongoDB already
tracks in metadata:

```
countDocuments({})          729 ms      (3M docs; ~24 s at 100M)
estimatedDocumentCount()      2 ms
```

**Fix.** No filter → `estimatedDocumentCount()`. With a filter → the count stops
at 10,000 (`.limit(COUNT_CAP + 1)`) and the UI renders "10,000+". The find and
the count now also run concurrently via `Promise.all` instead of back to back.

Capping the count fixes deep pagination for free: the pager never offers a page
past the cap, so `skip()` can never exceed 10,000 entries. `skip()` walks every
entry it skips — page 10,000 measured 200,000 keys examined.

## Also fixed along the way

**The date filter never worked.** `timestamp` is stored as a Number (unix
seconds) but the filter compared it against `Date` objects. Under BSON type
ordering a Number never matches a Date, so any search with a date range silently
returned zero rows:

```
countDocuments({timestamp: {$gte: new Date(...), $lte: new Date(...)}})  ->        0
countDocuments({timestamp: {$gte: 1767225600,   $lte: 1780272000  }})  ->  3000000
```

**Index order violated the ESR rule.** `{timestamp: -1, event: 1}` put the sort
field ahead of the equality field, so an event filter walked the index in
timestamp order filtering as it went. `{event: 1, timestamp: -1}` examines 20
keys where the old one examined 228.

**Four indexes existed that no query could use.** Total index footprint dropped
from 543.9 MB to 411.2 MB per 3M documents (~18 GB to ~13.7 GB at 100M) *while
adding* the new collation index — that is RAM handed back to the WiredTiger
cache:

| Dropped | Why |
|---|---|
| `recipient_text_..._text` | A text index, 150 MB per 3M docs (~5 GB at 100M). No query ever used `$text`. |
| `timestamp_1` | A single-field index is walked in both directions; `timestamp_-1` already covers it. |
| `timestamp_-1_event_1` | Superseded by `event_1_timestamp_-1`. The planner never chose it. |
| `event_1` | Redundant prefix of `event_1_timestamp_-1`. |
| `messages.headers.*` (×3) | Indexed `headers.MessageId`/`Subject`/`To`, but that schema has no `headers` path — Mailgun's field is `message-headers`. Every document indexed as null. |

## Applying this to production

```bash
node scripts/migrate-indexes.js            # dry run, prints the plan
node scripts/migrate-indexes.js --apply    # create everything, then drop
```

Every CREATE runs and is verified before any DROP, so a failed run cannot leave
a query without an index. On MongoDB 4.2+ these builds do not hold a write lock
for their duration, so the app keeps serving while they run; on 100M documents
expect tens of minutes and heavy IO. Dropping is fast.

`server/index.js` now sets `autoIndex: false` (override with
`MONGO_AUTO_INDEX=true`). Mongoose otherwise issues `createIndex` for every
declared index on every boot, which at this scale means kicking off multi-GB
builds during startup.

## Known limits of the current fix

- **Substring and domain search are still slow.** "everything to @gmail.com" or
  "any subject containing Invoice" cannot use a b-tree prefix. They work via
  `?match=contains` but scan. The proper fix is a normalised, indexed field
  (`recipientDomain`, `subjectLower`) populated on write plus a one-time
  backfill — see the note at the end of this file.
- **Prefix search leans on the query planner.** For a highly selective prefix
  the planner picks the recipient index (3 keys); for a broad one it scans
  `timestamp_-1` and filters (305 keys). A middling prefix is the worst case —
  5,470 keys / 65 ms at 3M. `maxTimeMS(5000)` bounds it absolutely.
- **`recipient_ci` and `recipient_1_timestamp_-1` share a key pattern** and
  differ only by collation. That is legal and the planner picks correctly, but
  `.hint({recipient:1, timestamp:-1})` is now ambiguous — hint by index *name*.
- **Pagination sorts on `timestamp` alone**, which is second-granularity, so
  rows sharing a timestamp can shift across a page boundary. Adding `_id` as a
  tiebreak would need it in the index to avoid an in-memory sort; left alone
  deliberately rather than risk a regression.

### If substring/domain search needs to be fast

Add to the webhook schema, populate in `routes/webhook.js` on write, index, and
backfill the existing rows in batches:

```js
recipientDomain: String,   // 'gmail.com'  — indexed, exact match
subjectLower:    String,   // lowercased   — indexed, anchored prefix
```

A backfill over 100M documents is a batched `updateMany` loop over `_id` ranges;
budget about an hour. New writes get the fields for free, so the backfill can
run gradually rather than as one blocking migration.
