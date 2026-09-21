# mailgun-webhook-viewer
An endpoint to collect and view Mailgun webhooks

## MCP endpoint (read-only, for AI agents)

`POST /mcp` exposes the webhook archive to MCP-capable agents as a read-only
query interface. It is behind the same IP gate as the web UI, so it is reachable
only from the private/Tailscale ranges.

Add it to Claude Code:

```bash
claude mcp add --transport http mailgun http://<tailscale-host>:3000/mcp
```

Or click **Connect MCP** on the web UI: it copies a ready-made prompt — with the
URL already filled in from the host you are browsing — that you paste into
Claude Code to have it install and verify the server itself.

Tools: `describe_collection`, `find`, `count`, `aggregate`. Usage guidance —
the schema traps, which queries are index-backed — is delivered to the agent
automatically in the MCP `instructions` block; there is no separate doc to read.

Queries are planned before they run. Anything that would scan the collection or
walk an entire index comes back with `requiresConfirmation: true` and is not
executed; re-call with `allowFullScan: true` to override.

If a client reports `406 Not Acceptable`, it is not sending
`Accept: application/json, text/event-stream`, which the protocol requires.

The endpoint refuses any request carrying an `Origin` header, which is what
keeps a browser on the allowed network from lending its position to a page it
loaded. Real MCP clients never send one. There is no Host allowlist to
configure: reach the endpoint by whatever tailnet name or IP the app is served
on.
