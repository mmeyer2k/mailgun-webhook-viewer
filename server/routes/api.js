const express = require('express');
const router = express.Router();
const ipCheckMiddleware = require('../middleware/ipCheck');
const Webhook = require('../models/webhook');
const Message = require('../models/message');

// Add message details route
router.get('/messages/:id', async (req, res) => {
  try {
    const message = await Message.findOne({ messageId: req.params.id });
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json(message);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching message' });
  }
});

router.get('/webhooks', async (req, res) => {
  try {
    const { event, recipient, subject, startDate, endDate, page = 1, limit = 20 } = req.query;
    
    const query = {};
    if (event) query.event = event;
    if (recipient) query.recipient = { $regex: recipient, $options: 'i' };
    if (subject) query['message.headers.subject'] = { $regex: subject, $options: 'i' };
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    const webhooks = await Webhook.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Webhook.countDocuments(query);

    res.json({
      webhooks,
      total,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching webhooks' });
  }
});

router.get('/webhooks/:id', async (req, res) => {
  try {
    const webhook = await Webhook.findById(req.params.id);
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    
    // Fetch all related events by messageId
    const relatedEvents = await Webhook.find({
      'message.headers.message-id': webhook.message.headers['message-id'],
    }).sort({ timestamp: 1 });

    res.json({
      webhook,
      relatedEvents
    });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching webhook' });
  }
});

module.exports = router; 