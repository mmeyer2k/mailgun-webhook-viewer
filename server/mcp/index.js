const path = require('path');
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { INSTRUCTIONS } = require('./instructions');
const { registerTools } = require('./tools');

// The shape of a Chrome (and Edge, Brave) extension origin: a 32-character
// ID in the a-p alphabet. No web page can present one — the browser sets
// Origin — so matching the shape cannot let a page in.
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

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
  //
  // The one exception is browser extensions. Chrome stamps an extension's
  // requests with Origin: chrome-extension://<id> and the extension cannot
  // omit it. No web page can present that origin, and a content script sends
  // its page's origin rather than the extension's, so the exemption reaches
  // extension pages and workers only — which, given host permissions, could
  // already read /api without any Origin check at all. Do NOT widen this to
  // page origins: an allowed page origin hands /mcp to every script on that
  // page, including the viewer's own (CLAUDE.md, "Known rough edges").
  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    if (!EXTENSION_ORIGIN.test(origin)) {
      return rpcError(res, 403, 'Requests with an Origin header are not accepted on this endpoint.');
    }

    res.vary('Origin');
    res.set('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
        'Access-Control-Max-Age': '600',
      });
      // Chrome's private-network preflight: this server is on a tailnet address.
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.set('Access-Control-Allow-Private-Network', 'true');
      }
      return res.sendStatus(204);
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

  // The Connect MCP button hands out this URL, and people open it in a browser.
  // Navigation asks for text/html; an MCP client's GET asks for
  // text/event-stream and falls through to the 405 below. A top-level GET
  // navigation sends no Origin, so this sits behind the same check as POST.
  router.get('/', (req, res, next) => {
    if (!/\btext\/html\b/.test(req.get('accept') || '')) return next();
    res.sendFile(path.join(__dirname, '../../public/mcp.html'));
  });

  // Stateless mode has no stream to resume and no session to delete.
  router.all('/',(req, res) => rpcError(res, 405, 'Method not allowed. Use POST.'));

  return router;
}

module.exports = mcpRouter;
