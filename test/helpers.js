/**
 * Start `app` on an ephemeral loopback port, run `fn(base, port)`, and close
 * the server afterwards — even if `fn` throws. Every HTTP-level test in this
 * suite needs exactly this. The peer is always 127.0.0.1, which the IP gate
 * allows, so a 403 in these tests is never the gate itself.
 */
async function withListening(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** The two methods a middleware calls to refuse a request, and what it chose. */
function fakeRes() {
  return {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
  };
}

module.exports = { withListening, fakeRes };
