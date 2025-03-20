const ipRangeCheck = require('ip-range-check');

const allowedRanges = [
  '100.64.0.0/10',   // Carrier-grade NAT
  '10.0.0.0/8',      // Private network
  '172.16.0.0/12',   // Private network
  '192.168.0.0/16',  // Private network
  '127.0.0.1/32'     // Localhost
];

const ipCheckMiddleware = (req, res, next) => {
  const clientIp = req.headers['x-forwarded-for'] ||
                  req.ip || 
                  req.connection.remoteAddress || 
                  req.socket.remoteAddress || 
                  req.connection.socket.remoteAddress;

  if (ipRangeCheck(clientIp, allowedRanges)) {
    next();
  } else {
    console.log('Access denied - IP not in allowed range', clientIp);
    res.status(403).json({ error: 'Access denied - IP not in allowed range' });
  }
};

module.exports = ipCheckMiddleware;