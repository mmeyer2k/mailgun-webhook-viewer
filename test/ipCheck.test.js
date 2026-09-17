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

test('the real app mounts /webhook above the gate and everything else below it', () => {
  // The hand-built test above asserts the SHAPE; this one asserts the actual
  // wiring in server/index.js, which is what production runs. Requiring the
  // module is safe because listen() and mongoose.connect() only run under
  // require.main === module.
  const app = require('../server/index');
  const names = app._router.stack.map((layer) => {
    if (layer.name === 'ipCheckMiddleware') return 'gate';
    if (layer.name === 'serveStatic') return 'static';
    if (layer.regexp && layer.regexp.test('/webhook')) return '/webhook';
    if (layer.regexp && layer.regexp.test('/api')) return '/api';
    if (layer.regexp && layer.regexp.test('/mcp')) return '/mcp';
    return null;
  }).filter(Boolean);
  const idx = (n) => names.indexOf(n);
  for (const n of ['/webhook', 'gate', 'static', '/api', '/mcp']) assert.notStrictEqual(idx(n), -1, `${n} not mounted`);
  assert.ok(idx('/webhook') < idx('gate'), 'webhook must be ABOVE the gate');
  // Express's own query/expressInit/jsonParser layers carry a catch-all
  // regexp that also matches '/webhook', so indexOf('/webhook') is 0 whatever
  // happens. lastIndexOf is the one that actually moves if the route is
  // remounted below the gate.
  assert.ok(names.lastIndexOf('/webhook') < idx('gate'), 'webhook route itself must be ABOVE the gate');
  assert.ok(idx('gate') < idx('static') && idx('gate') < idx('/api') && idx('gate') < idx('/mcp'), 'gate must precede static, /api and /mcp');
  assert.strictEqual(names.filter((n) => n === 'gate').length, 1, 'gate registered exactly once');
});
