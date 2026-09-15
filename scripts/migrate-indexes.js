#!/usr/bin/env node
/**
 * Bring the webhooks/messages indexes in line with server/models/*.js.
 *
 *   node scripts/migrate-indexes.js            # dry run — prints the plan only
 *   node scripts/migrate-indexes.js --apply    # actually create, then drop
 *   node scripts/migrate-indexes.js --apply --skip-drops
 *
 * Order matters: every CREATE runs and is verified before any DROP, so a failed
 * run can never leave a query without an index to serve it.
 *
 * On MongoDB 4.2+ index builds do not hold a collection-level write lock for
 * their duration, but they are still IO- and RAM-heavy. On ~100M documents
 * expect tens of minutes and run it off-peak. Dropping an index is fast.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const SKIP_DROPS = process.argv.includes('--skip-drops');
const CI = { locale: 'en', strength: 2 };

const CREATE = [
  ['webhooks', { timestamp: -1 }, {}],
  ['webhooks', { event: 1, timestamp: -1 }, {}],
  ['webhooks', { recipient: 1, timestamp: -1 }, {}],
  ['webhooks', { recipient: 1, timestamp: -1 }, { name: 'recipient_ci', collation: CI }],
  ['webhooks', { 'message.headers.subject': 1, timestamp: -1 }, {}],
  ['webhooks', { 'message.headers.message-id': 1, timestamp: 1 }, {}],
  ['messages', { messageId: 1 }, {}]
];

// Dead weight. See the "Deliberately NOT indexed" notes in the models.
//
// Ops counts below are from $indexStats over 315 days of production uptime.
// Re-check with:
//   db.webhooks.aggregate([{$indexStats:{}}])
// before adding to this list — an index that is merely unused *today* may just
// be waiting on a query pattern that has not run since the last mongod restart.
const DROP = [
  // Zero recorded reads.
  ['webhooks', 'recipient_text_message.headers.subject_text'],  // 2211 MB, 0 ops — no query uses $text
  ['webhooks', 'message.headers.messageId_1_timestamp_1'],      //  747 MB, 0 ops — indexes `messageId`,
                                                                //    but the real field is `message-id`
  // Sort-field-first duplicates of indexes kept above (ESR). The planner picks
  // them occasionally but the correctly-ordered equivalents are strictly better.
  ['webhooks', 'timestamp_-1_message.headers.subject_1'],       // 2331 MB, 14 ops
  ['webhooks', 'timestamp_-1_recipient_1'],                     // 1902 MB,  6 ops
  ['webhooks', 'timestamp_-1_event_1'],                         // 1158 MB,  6 ops

  // Redundant single-field / prefix indexes. A single-field index is walked in
  // either direction, so timestamp_-1 serves the ascending sort that timestamp_1
  // currently answers; event_1 is a prefix of event_1_timestamp_-1.
  ['webhooks', 'timestamp_1'],                                  //  713 MB, 281 ops -> moves to timestamp_-1
  ['webhooks', 'event_1'],                                      //  217 MB,  87 ops -> moves to event_1_timestamp_-1

  // Index a `headers` path that this schema does not have.
  ['messages', 'headers.MessageId_1'],                          //   34 MB, 0 ops
  ['messages', 'headers.Subject_1'],                            //   34 MB, 0 ops
  ['messages', 'headers.To_1']                                  //   34 MB, 0 ops
];

const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';

async function report(db, label) {
  console.log(`\n=== index inventory (${label}) ===`);
  for (const coll of ['webhooks', 'messages']) {
    let stats;
    try {
      stats = await db.collection(coll).stats();
    } catch (e) {
      console.log(`  ${coll}: not present`);
      continue;
    }
    const sizes = stats.indexSizes || {};
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    console.log(`  ${coll} — ${stats.count.toLocaleString()} docs, ${mb(total)} of indexes`);
    Object.keys(sizes)
      .sort((a, b) => sizes[b] - sizes[a])
      .forEach((k) => console.log(`      ${mb(sizes[k]).padStart(10)}  ${k}`));
  }
}

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set (create .env from .env.sample)');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    autoIndex: false
  });
  const db = mongoose.connection.db;
  console.log(`connected to ${mongoose.connection.name}`);
  await report(db, 'before');

  console.log(`\n=== plan ===${APPLY ? '' : '   (DRY RUN — nothing will change)'}`);
  for (const [coll, keys, opts] of CREATE) {
    console.log(`  CREATE ${coll}: ${JSON.stringify(keys)}${opts.collation ? ' +collation' : ''}`);
  }
  if (SKIP_DROPS) {
    console.log('  (drops skipped via --skip-drops)');
  } else {
    for (const [coll, name] of DROP) console.log(`  DROP   ${coll}: ${name}`);
  }

  if (!APPLY) {
    console.log('\nRe-run with --apply to execute.');
    await mongoose.disconnect();
    return;
  }

  console.log('\n=== creating ===');
  for (const [coll, keys, opts] of CREATE) {
    const t = Date.now();
    try {
      const name = await db.collection(coll).createIndex(keys, opts);
      console.log(`  ok   ${coll}.${name}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.error(`  FAIL ${coll} ${JSON.stringify(keys)}: ${e.message}`);
      console.error('  aborting before any drop; nothing has been removed.');
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  if (!SKIP_DROPS) {
    console.log('\n=== dropping ===');
    for (const [coll, name] of DROP) {
      try {
        await db.collection(coll).dropIndex(name);
        console.log(`  dropped ${coll}.${name}`);
      } catch (e) {
        // IndexNotFound (27) just means a previous run already handled it.
        if (e.code === 27 || /index not found/i.test(e.message)) {
          console.log(`  absent  ${coll}.${name}`);
        } else {
          console.error(`  FAIL    ${coll}.${name}: ${e.message}`);
        }
      }
    }
  }

  await report(db, 'after');
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
