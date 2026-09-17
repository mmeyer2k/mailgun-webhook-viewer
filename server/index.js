require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const ipCheckMiddleware = require('./middleware/ipCheck');

const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');
const mcpRouter = require('./mcp');

const app = express();

// Middleware
app.use(express.json());

// Mailgun posts here from the public internet, so this route is deliberately
// NOT behind the IP gate — its protection is the HMAC signature check. It is
// mounted ABOVE the gate so that position, not HTTP method, is what keeps it
// public.
app.use('/webhook', webhookRoutes);

// Everything below this line is gated to private/Tailscale ranges, for EVERY
// method. This previously read app.get('/*', ...), which covered GET only.
app.use(ipCheckMiddleware);

app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 3000;

// Read-only MCP endpoint for AI agents. Below the IP gate, so it is reachable
// only from the private/Tailscale ranges. The Host allowlist must name every
// host:port a client will use; only the localhost forms are built in.
const mcpAllowedHosts = mcpRouter.defaultAllowedHosts(PORT);
if (!process.env.MCP_ALLOWED_HOSTS) {
  console.warn('MCP_ALLOWED_HOSTS is not set: /mcp will accept only localhost Host headers.');
}
app.use('/mcp', mcpRouter(() => mongoose.connection.db, { allowedHosts: mcpAllowedHosts }));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
    // These options were added by Cursor for docker compatibility ...?
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  retryWrites: true,
  // Mongoose otherwise issues createIndex for every declared index on every
  // boot. Against ~100M documents that kicks off multi-GB index builds during
  // startup. Indexes are managed explicitly by scripts/migrate-indexes.js.
  autoIndex: process.env.MONGO_AUTO_INDEX === 'true'
})
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 