const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const {
  assertReadOnlyPipeline,
  assertNoForbiddenOperators,
  coerceIds,
  collectBounded,
  COLLECTIONS,
} = require('../server/mcp/query');

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

test('rejects $changeStream', () => {
  // A tailable cursor: hasNext() blocks waiting for the next write, past
  // maxTimeMS, holding one of the four concurrency slots indefinitely.
  assert.throws(() => assertReadOnlyPipeline([{ $changeStream: {} }]), /\$changeStream/);
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

// ---------------------------------------------------------------------------
// Operator guard on non-pipeline objects. find/count filters accept $where and
// $expr:{$function} — server-side JavaScript — so the same walk must cover them.
// ---------------------------------------------------------------------------

test('rejects $where in a find filter', () => {
  assert.throws(() => assertNoForbiddenOperators({ recipient: 'a@b.com', $where: 'sleep(1)' }, 'filter'),
    /\$where.*filter/);
});

test('rejects $function nested under $expr in a filter', () => {
  assert.throws(() => assertNoForbiddenOperators(
    { $expr: { $function: { body: 'function(){return true}', args: [], lang: 'js' } } }, 'filter'),
    /\$function/);
});

test('rejects $function in a projection', () => {
  assert.throws(() => assertNoForbiddenOperators(
    { x: { $function: { body: 'function(){}', args: [], lang: 'js' } } }, 'projection'),
    /\$function.*projection/);
});

test('allows an ordinary filter with $regex, $in and ranges', () => {
  assert.doesNotThrow(() => assertNoForbiddenOperators({
    recipient: { $regex: '^user5' },
    event: { $in: ['delivered', 'opened'] },
    timestamp: { $gte: 1, $lte: 2 },
  }, 'filter'));
});

// ---------------------------------------------------------------------------
// Lookup-stage targets. The collection enum only scopes the PRIMARY collection;
// these stages name another one and must be held to the same list.
// ---------------------------------------------------------------------------

test('rejects $unionWith targeting a collection outside the allowlist', () => {
  assert.throws(() => assertReadOnlyPipeline([
    { $limit: 1 },
    { $unionWith: { coll: 'system.users', pipeline: [] } },
  ]), /\$unionWith.*system\.users/);
});

test('rejects the $unionWith string shorthand outside the allowlist', () => {
  // { $unionWith: "name" } is MongoDB shorthand for { $unionWith: { coll: "name" } }.
  // A guard that only inspects object specs waves this straight through.
  assert.throws(() => assertReadOnlyPipeline([{ $limit: 1 }, { $unionWith: 'secrets' }]),
    /\$unionWith.*secrets/);
});

test('allows the $unionWith string shorthand for a permitted collection', () => {
  assert.doesNotThrow(() => assertReadOnlyPipeline([{ $limit: 1 }, { $unionWith: 'messages' }]));
});

test('rejects $lookup from a collection outside the allowlist', () => {
  assert.throws(() => assertReadOnlyPipeline([
    { $lookup: { from: 'secrets', localField: 'a', foreignField: 'b', as: 'x' } },
  ]), /\$lookup.*secrets/);
});

test('rejects the cross-database {db, coll} lookup form', () => {
  assert.throws(() => assertReadOnlyPipeline([
    { $lookup: { from: { db: 'admin', coll: 'system.users' }, pipeline: [], as: 'x' } },
  ]), /\$lookup/);
});

test('rejects $graphLookup outside the allowlist', () => {
  assert.throws(() => assertReadOnlyPipeline([
    { $graphLookup: { from: 'other', startWith: '$a', connectFromField: 'a', connectToField: 'b', as: 'x' } },
  ]), /\$graphLookup.*other/);
});

test('allows $lookup between the two permitted collections', () => {
  assert.doesNotThrow(() => assertReadOnlyPipeline([
    { $match: { event: 'delivered' } },
    { $lookup: { from: 'messages', localField: 'message.headers.message-id', foreignField: 'messageId', as: 'body' } },
  ]));
  assert.deepStrictEqual(COLLECTIONS, ['webhooks', 'messages']);
});

test('allows $lookup with no from (the $documents form)', () => {
  assert.doesNotThrow(() => assertReadOnlyPipeline([
    { $lookup: { pipeline: [{ $documents: [{ a: 1 }] }], as: 'x' } },
  ]));
});

// ---------------------------------------------------------------------------
// Bounded cursor collection. Replaces load-everything-then-trim, which could
// materialise an unbounded aggregate result in the process that also hosts
// webhook ingestion.
// ---------------------------------------------------------------------------

function fakeCursor(docs) {
  let i = 0;
  return {
    closed: false,
    hasNext: async () => i < docs.length,
    next: async () => docs[i++],
    close: async function () { this.closed = true; },
  };
}

test('collectBounded returns everything when under both caps and closes the cursor', async () => {
  const c = fakeCursor([{ a: 1 }, { a: 2 }]);
  const r = await collectBounded(c, { maxBytes: 100000, maxDocs: 1000 });
  assert.strictEqual(r.returned, 2);
  assert.strictEqual(r.truncated, false);
  assert.deepStrictEqual(r.docs, [{ a: 1 }, { a: 2 }]);
  assert.strictEqual(c.closed, true);
});

test('collectBounded stops at the byte cap without reading further', async () => {
  const docs = Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(200) }));
  const c = fakeCursor(docs);
  const r = await collectBounded(c, { maxBytes: 5000, maxDocs: 1000 });
  assert.strictEqual(r.truncated, true);
  assert.ok(r.returned > 0 && r.returned < 500);
  assert.strictEqual(r.docs.length, r.returned);
  assert.strictEqual(c.closed, true);
});

test('collectBounded stops at the document cap and reports truncation when more remain', async () => {
  const c = fakeCursor([{ a: 1 }, { a: 2 }, { a: 3 }]);
  const r = await collectBounded(c, { maxBytes: 100000, maxDocs: 2 });
  assert.strictEqual(r.returned, 2);
  assert.strictEqual(r.truncated, true);
});

test('collectBounded does not report truncation when the cap equals the result size', async () => {
  const c = fakeCursor([{ a: 1 }, { a: 2 }]);
  const r = await collectBounded(c, { maxBytes: 100000, maxDocs: 2 });
  assert.strictEqual(r.returned, 2);
  assert.strictEqual(r.truncated, false);
});

test('collectBounded reports truncation when the first document exceeds the cap', async () => {
  const c = fakeCursor([{ pad: 'x'.repeat(10000) }]);
  const r = await collectBounded(c, { maxBytes: 100, maxDocs: 1000 });
  assert.strictEqual(r.returned, 0);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(c.closed, true);
});

test('collectBounded closes the cursor even if iteration throws', async () => {
  const c = fakeCursor([]);
  c.hasNext = async () => { throw new Error('boom'); };
  await assert.rejects(() => collectBounded(c, { maxBytes: 100, maxDocs: 1 }), /boom/);
  assert.strictEqual(c.closed, true);
});
