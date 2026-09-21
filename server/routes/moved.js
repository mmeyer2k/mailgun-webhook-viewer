const express = require('express');

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape for both text and quoted-attribute contexts. */
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const page = (target) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>This address has moved</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #666; --bg: #fbfbfb; --card: #fff; --line: #e3e3e3; --accent: #2f6fdb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8e8; --muted: #9a9a9a; --bg: #161616; --card: #1f1f1f; --line: #333; --accent: #7aa7f0; }
  }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: var(--bg); color: var(--fg); padding: 1.5rem;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 34rem; background: var(--card); border: 1px solid var(--line);
         border-radius: 10px; padding: 1.75rem 2rem; }
  h1 { margin: 0 0 .75rem; font-size: 1.25rem; letter-spacing: -.01em; }
  p { margin: 0 0 1rem; }
  .muted { color: var(--muted); font-size: .9rem; margin-bottom: 0; }
  a.go { display: inline-block; word-break: break-all; font-weight: 600;
         color: var(--accent); text-decoration: none; }
  a.go:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <h1>This address has moved</h1>
  <p>The viewer is now served here:</p>
  <p><a class="go" href="${escapeHtml(target)}">${escapeHtml(target)}</a></p>
  <p>Update your bookmark. You will need to be connected to Tailscale &mdash; that address is not reachable from the public internet.</p>
  <p class="muted">Only the webhook endpoint remains on this address.</p>
</main>
</body>
</html>
`;

/**
 * The notice served on the PUBLIC origin, where only the webhook endpoint still
 * lives. Mount it ABOVE the IP gate with app.use() — never app.get():
 *
 * Tailscale's `--set-path /` proxy mount is prefix-matching, so every public
 * path arrives here with the mount prefix in front of it (the public /api/…
 * becomes /moved/api/…). app.use() swallows all of them and answers with this
 * page; app.get() would match only the exact path and let the rest fall through
 * to the gate — which passes, because behind a proxy the peer is loopback. That
 * fall-through is precisely how this app ended up on the public internet.
 *
 * It renders a LINK and never a redirect. `baseUrl` comes from configuration
 * rather than from the request's own Host header on purpose: this endpoint is
 * internet-facing, so a target derived from Host would be an attacker-chosen
 * one — an open redirect if we sent a 302, and a phishing link either way.
 * No URL is hardcoded here, so nothing about the deployment leaks into the repo;
 * with nothing configured there is nothing honest to link to, so it 404s.
 *
 * @param {string|undefined} baseUrl absolute origin of the real viewer
 */
function movedRouter(baseUrl) {
  const router = express.Router();
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';

  router.use((req, res) => {
    if (!base) return res.status(404).type('text/plain').send('Not found');
    // Mounted via app.use, so req.url is the remainder after the mount point
    // and always starts with '/' — it is caller-controlled and only ever
    // reaches the response escaped.
    res.status(200).type('html').send(page(base + req.url));
  });

  return router;
}

module.exports = movedRouter;
