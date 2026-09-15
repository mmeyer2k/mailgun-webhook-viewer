require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const ipCheckMiddleware = require('./middleware/ipCheck');

const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Apply IP check to all GET requests for static files
app.get('/*', ipCheckMiddleware);

// Serve static files after IP check
app.use(express.static(path.join(__dirname, '../public')));

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

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 