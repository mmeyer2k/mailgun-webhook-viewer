const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { INSTRUCTIONS } = require('./instructions');
const { registerTools } = require('./tools');

const rpcError = (res, status, message) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/**
 * Express router exposing the read-only MCP endpoint.
 *
 * Stateless: a fresh McpServer and transport are built per request
 * (`sessionIdGenerator: undefined`). There is no session state worth keeping
 * for a read-only query API, and the endpoint survives an app restart
 * mid-conversation.
 *
 * Access control is the IP gate in server/index.js, which this router is
 * mounted below. That gate checks the TCP peer — and in a browser-borne attack
 * the peer is a legitimate user on the allowed network, lending their position
 * to a page they happened to load. The Origin refusal below closes that.
 *
 * There is deliberately NO Host allowlist. The SDK's DNS-rebinding protection
 * is an exact string match, port included, against every hostname a client
 * might type; keeping it correct meant enumerating tailnet names in an env var,
 * and the first name anyone forgot returned a bare 403 that MCP clients report
 * as an auth failure. Two things already cover the attack it defends against:
 * tailscale serve terminates TLS for the single MagicDNS name it holds a cert
 * for, so a rebound https page fails the handshake before reaching us; and a
 * rebound page's POST still carries Origin, which is refused below.
 *
 * @param {() => import('mongodb').Db} getDb resolves the raw driver Db lazily,
 *   so the router can be mounted before MongoDB finishes connecting.
 */
function mcpRouter(getDb) {
  const router = express.Router();

  // The whole of this endpoint's browser defence. Done here rather than through
  // the transport's `allowedOrigins`: that option is a value allowlist which
  // no-ops when the list is empty, so it can say "only these origins" but not
  // "no Origin at all". Moving this check into `allowedOrigins: []` would
  // silently disable it. Real MCP clients never send Origin; browsers always
  // do on a POST, including a same-origin one after a DNS rebind.
  router.use((req, res, next) => {
    if (req.headers.origin !== undefined) {
      return rpcError(res, 403, 'Requests with an Origin header are not accepted on this endpoint.');
    }
    next();
  });

  router.post('/', async (req, res) => {
    const server = new McpServer(
      { name: 'mailgun-webhooks', version: '1.0.0' },
      { instructions: INSTRUCTIONS }
    );

    // getDb() returns undefined until mongoose finishes connecting, and
    // registerTools does not throw on it — it happily registers tools that
    // close over nothing and fail one call later, deep inside the transport.
    // Check the value instead of catching a throw that never comes.
    const db = getDb();
    if (!db) return rpcError(res, 503, 'Database not connected yet. Retry shortly.');
    registerTools(server, db);

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
  router.all('/', (req, res) => rpcError(res, 405, 'Method not allowed. Use POST.'));

  return router;
}

module.exports = mcpRouter;
