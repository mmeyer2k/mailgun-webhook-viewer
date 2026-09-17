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
