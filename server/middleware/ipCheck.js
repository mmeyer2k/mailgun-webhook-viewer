const ipRangeCheck = require('ip-range-check');

const allowedRanges = [
  '100.64.0.0/10',   // Carrier-grade NAT — the range Tailscale hands out
  '10.0.0.0/8',      // Private network
  '172.16.0.0/12',   // Private network
  '192.168.0.0/16',  // Private network
  '127.0.0.1/32',    // Localhost
  '::1/128'          // Localhost over IPv6. A dual-stack connection to
                     // "localhost" arrives as ::1, which does NOT match
                     // 127.0.0.1/32.
];

/**
 * Gate every non-webhook route to the private/Tailscale ranges.
 *
 * This checks the real TCP peer address and deliberately ignores
 * X-Forwarded-For. The previous implementation read that header first and
 * unconditionally, with no `trust proxy` configured, so any client on the
 * internet could send `X-Forwarded-For: 10.0.0.1` and pass. The listening port
 * has to be publicly reachable for Mailgun to deliver webhooks, so that was
 * reachable from anywhere.
 *
 * Production runs with no reverse proxy: Mailgun and Tailscale clients both hit
 * this process directly, so the peer IS the client. If a proxy is ever added,
 * the peer becomes the proxy and this must be given an explicitly configured
 * number of hops to walk back from the RIGHT of X-Forwarded-For — never a
 * blind first-value read.
 *
 * ip-range-check matches IPv6-mapped IPv4 (::ffff:10.0.0.1) against IPv4 CIDRs
 * directly, so no normalization is needed.
 */
const ipCheckMiddleware = (req, res, next) => {
  const clientIp = req.socket && req.socket.remoteAddress;

  if (clientIp && ipRangeCheck(clientIp, allowedRanges)) {
    return next();
  }

  console.log('Access denied - IP not in allowed range', clientIp);
  res.status(403).json({ error: 'Access denied - IP not in allowed range' });
};

module.exports = ipCheckMiddleware;
