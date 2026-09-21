require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const ipCheckMiddleware = require('./middleware/ipCheck');

const webhookRoutes = require('./routes/webhook');
const movedRouter = require('./routes/moved');
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

// The "this address has moved" notice for the public origin, which now carries
// only /webhook. Mounted ABOVE the gate because it has to answer public
// traffic, and it is the reason public traffic cannot reach anything else: the
// proxy mount in front of it is prefix-matching, so every public path lands
// here. See server/routes/moved.js. Unset VIEWER_BASE_URL leaves it a 404.
app.use('/moved', movedRouter(process.env.VIEWER_BASE_URL));

// Everything below this line is gated to private/Tailscale ranges, for EVERY
// method. This previously read app.get('/*', ...), which covered GET only.
app.use(ipCheckMiddleware);

app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 3000;

// Read-only MCP endpoint for AI agents. Below the IP gate, so it is reachable
// only from the private/Tailscale ranges; the router itself refuses anything
// carrying an Origin header, which is what keeps a browser on those ranges
// from lending its position to a page it loaded.
app.use('/mcp', mcpRouter(() => mongoose.connection.db));

// Every route and middleware above is registered unconditionally, so requiring
// this module yields the fully wired app — which is what test/ipCheck.test.js
// asserts the mount ORDER of. Only the side effects below belong to running as
// a program: connecting, listening, and warning on the console.
if (require.main === module) {
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
}

module.exports = app; 