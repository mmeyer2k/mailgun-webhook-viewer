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

test('a filter on an unindexed field is a collection scan', () => {
  const r = analyzePlan(fixture('find-unindexed-field'), { hasFilter: true, hasLimit: true });
  assert.strictEqual(r.scanType, 'collectionScan');
  assert.ok(r.warnings.length > 0);
});

test('the unfiltered sorted list query is NOT flagged', () => {
  // Leading bound is full-range, but with no filter and a limit the query stops
  // after `limit` keys. This is the normal list page; flagging it would make
  // the gate cry wolf.
  const r = analyzePlan(fixture('find-unfiltered-sorted'), { hasFilter: false, hasLimit: true });
  // Unbounded-but-rescued: the classification still says fullIndexScan, it is
  // the warning that is withheld.
  assert.strictEqual(r.scanType, 'fullIndexScan');
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
  // Fail OPEN but loudly: an unrecognised plan must never be reported as a
  // clean seek, because the guard did not actually evaluate anything.
  const r = analyzePlan({}, { hasFilter: true, hasLimit: false });
  assert.strictEqual(r.scanType, 'unknown');
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /did NOT evaluate/);
});

test('ignores rejectedPlans when classifying', () => {
  // Real explain output carries full stage trees for DISCARDED candidates.
  // A rejected COLLSCAN must not condemn the winning IXSCAN beside it.
  const r = analyzePlan({
    queryPlanner: {
      winningPlan: {
        stage: 'FETCH',
        inputStage: {
          stage: 'IXSCAN',
          indexName: 'recipient_ci',
          indexBounds: {
            recipient: ['["a@b.com", "a@b.com"]'],
            timestamp: ['[MaxKey, MinKey]'],
          },
        },
      },
      rejectedPlans: [
        { stage: 'COLLSCAN', filter: { recipient: { $eq: 'a@b.com' } } },
      ],
    },
  }, { hasFilter: true, hasLimit: true });

  assert.strictEqual(r.scanType, 'indexSeek');
  assert.strictEqual(r.indexUsed, 'recipient_ci');
  assert.deepStrictEqual(r.warnings, []);
});

test('an $or plan with one bounded and one unbounded branch is a full index scan', () => {
  // The Critical case. Branch one seeks a single recipient; branch two reads
  // every key in a 100M-row index. Inspecting only the FIRST seek stage
  // reports a clean indexSeek with no warnings — a false all-clear on the
  // worst input this gate exists to catch.
  const r = analyzePlan({
    queryPlanner: {
      winningPlan: {
        stage: 'FETCH',
        inputStage: {
          stage: 'OR',
          inputStages: [
            {
              stage: 'IXSCAN',
              indexName: 'recipient_1_timestamp_-1',
              indexBounds: {
                recipient: ['["a@b.com", "a@b.com"]'],
                timestamp: ['[MaxKey, MinKey]'],
              },
            },
            {
              stage: 'IXSCAN',
              indexName: 'recipient_1_timestamp_-1',
              indexBounds: {
                recipient: ['["", {})', '[/y/i, /y/i]'],
                timestamp: ['[MaxKey, MinKey]'],
              },
            },
          ],
        },
      },
    },
  }, { hasFilter: true, hasLimit: true });

  assert.strictEqual(r.scanType, 'fullIndexScan');
  assert.strictEqual(r.leadingBound, '["", {})');
  assert.ok(r.warnings.length > 0);
});

test('an unbounded interval that is not the first entry is still detected', () => {
  // A leading field can carry several intervals. Reading only entries[0] sees
  // the tight one and misses the one that walks the whole index.
  const r = analyzePlan({
    queryPlanner: {
      winningPlan: {
        stage: 'IXSCAN',
        indexName: 'recipient_1_timestamp_-1',
        indexBounds: { recipient: ['["a", "b")', '[MinKey, MaxKey]'] },
      },
    },
  }, { hasFilter: true, hasLimit: true });

  assert.strictEqual(r.scanType, 'fullIndexScan');
});

test('blocking stages are reported as notes, not warnings', () => {
  // Every aggregate with $group has a blocking GROUP stage. Gating on that
  // would demand confirmation for ordinary analytics, so it is informational.
  const r = analyzePlan(fixture('agg-indexed-group'), { hasFilter: true, hasLimit: false });
  assert.ok(r.blockingStages.includes('GROUP'));
  assert.strictEqual(r.notes.length, 1);
  assert.deepStrictEqual(r.warnings, []);
});
