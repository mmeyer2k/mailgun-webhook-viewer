const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { INSTRUCTIONS } = require('./instructions');
const { registerTools } = require('./tools');

const rpcError = (res, status, message) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/**
 * Host values the transport will accept. The check is an exact string match
 * against the Host header, port included, so every name a client might type
 * into its MCP config has to be listed. Localhost forms are always present so
 * development works; everything else comes from MCP_ALLOWED_HOSTS.
 */
function defaultAllowedHosts(port, env = process.env) {
  const fromEnv = (env.MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return [...new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...fromEnv])];
}

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
 * to a page they happened to load. Two checks here close that:
 *
 *  - Any request carrying an Origin header is refused. Browsers send Origin on
 *    every POST, including same-origin ones after a DNS rebind; real MCP
 *    clients never send it.
 *  - The Host header must match an allowlisted value, enforced by the SDK's
 *    DNS-rebinding protection. After a rebind the browser's Host is the
 *    attacker's domain, not ours.
 *
 * @param {() => import('mongodb').Db} getDb resolves the raw driver Db lazily,
 *   so the router can be mounted before MongoDB finishes connecting.
 * @param {{ allowedHosts: string[] }} options
 */
function mcpRouter(getDb, { allowedHosts }) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    throw new Error('mcpRouter requires a non-empty allowedHosts list');
  }

  const router = express.Router();

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

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
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
module.exports.defaultAllowedHosts = defaultAllowedHosts;
