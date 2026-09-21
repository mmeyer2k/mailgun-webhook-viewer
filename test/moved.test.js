const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const movedRouter = require('../server/routes/moved');
const { withListening } = require('./helpers');

const BASE = 'https://viewer.example.ts.net:8081';

function withApp(baseUrl, fn) {
  const app = express();
  app.use('/moved', movedRouter(baseUrl));
  // Stands in for everything below the IP gate in server/index.js. If a public
  // request ever reaches THIS, the notice has failed to contain it.
  app.use((req, res) => res.status(200).send('LEAKED APP CONTENT'));
  return withListening(app, (base) => fn(`${base}/moved`));
}

const get = async (url) => {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
};

test('renders a page linking to the configured viewer URL', async () => {
  const out = await withApp(BASE, (url) => get(url));
  assert.strictEqual(out.status, 200);
  assert.ok(out.body.includes(`href="${BASE}/"`), `link missing from:\n${out.body}`);
  assert.match(out.body, /has moved/i);
});

// The whole point of the page: a link the human clicks, never a redirect an
// attacker can aim. Nothing here may emit a Location header.
test('does not redirect', async () => {
  const out = await withApp(BASE, (url) => get(url));
  assert.strictEqual(out.location, null);
  assert.ok(out.status < 300, `expected a rendered page, got ${out.status}`);
});

// Mounted with app.use, so it swallows every path beneath it. A proxy mount at
// "/" is prefix-matching, which means the public origin's /api/webhooks arrives
// here as /moved/api/webhooks — if that fell through, the app would be exposed
// again exactly the way it was before.
test('answers deep subpaths instead of letting them fall through', async () => {
  const out = await withApp(BASE, (url) => get(`${url}/api/webhooks`));
  assert.strictEqual(out.status, 200);
  assert.ok(!out.body.includes('LEAKED APP CONTENT'), 'request fell through to the app');
  assert.ok(out.body.includes('has moved'));
});

test('carries the original path and query into the link', async () => {
  const out = await withApp(BASE, (url) => get(`${url}/event.html?id=abc&x=1`));
  assert.ok(out.body.includes(`href="${BASE}/event.html?id=abc&amp;x=1"`),
    `expected the deep link, got:\n${out.body}`);
});

// The path is caller-controlled and lands inside an href attribute. events.js
// already has an unescaped-interpolation problem (see CLAUDE.md); this must not
// add a second one.
test('escapes the caller-controlled path instead of reflecting it', async () => {
  const out = await withApp(BASE, (url) => get(`${url}/"><script>alert(1)</script>`));
  assert.ok(!out.body.includes('<script>alert(1)</script>'), 'reflected script tag');
  assert.ok(!out.body.includes('"><script'), 'broke out of the href attribute');
  assert.ok(out.body.includes('&lt;script&gt;') || out.body.includes('%3Cscript%3E'));
});

// No configured URL means there is nothing honest to link to. Guessing one from
// the request's own Host header is what would make this an open redirect.
test('404s when no viewer URL is configured', async () => {
  const out = await withApp(undefined, (url) => get(url));
  assert.strictEqual(out.status, 404);
  assert.ok(!out.body.includes('LEAKED APP CONTENT'));
});

test('a trailing slash on the configured URL does not double up', async () => {
  const out = await withApp(`${BASE}/`, (url) => get(`${url}/event.html`));
  assert.ok(out.body.includes(`href="${BASE}/event.html"`), `got:\n${out.body}`);
});
