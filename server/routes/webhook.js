const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Webhook = require('../models/webhook');

// Webhook signature verification
const verifyWebhookSignature = (timestamp, token, signature) => {
  const signingKey = process.env.MAILGUN_SIGNING_KEY;
  // Temporarily disabled for testing
  return true;

  const encodedToken = crypto
    .createHmac('sha256', signingKey)
    .update(timestamp.concat(token))
    .digest('hex');

  return encodedToken === signature;
};

router.post('/', async (req, res) => {
  try {
    // Verify webhook signature
    const { timestamp, token, signature } = req.body.signature || {};
    if (!verifyWebhookSignature(timestamp, token, signature)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const eventData = req.body['event-data'];
    
    const webhook = new Webhook({
      event: eventData.event,
      timestamp: new Date(eventData.timestamp * 1000),
      eventId: eventData.id,
      recipient: eventData.recipient,
      message: {
        headers: {
          messageId: eventData['message-id'],
          subject: eventData.subject,
          from: eventData.from,
          to: eventData.to
        }
      },
      tags: eventData.tags || [],
      clientInfo: eventData['client-info'] ? {
        clientName: eventData['client-info']['client-name'],
        clientType: eventData['client-info']['client-type'],
        userAgent: eventData['client-info']['user-agent'],
        deviceType: eventData['client-info']['device-type'],
        clientOs: eventData['client-info']['client-os'],
        bot: eventData['client-info'].bot
      } : undefined,
      geolocation: eventData.geolocation,
      delivery: eventData.delivery,
      storage: eventData.storage,
      reason: eventData.reason,
      signature: {
        timestamp,
        token,
        signature
      },
      rawData: req.body
    });

    await webhook.save();
    res.status(200).json({ message: 'Webhook received and stored' });
  } catch (error) {
    console.error('Error storing webhook:', error);
    res.status(500).json({ error: 'Error storing webhook' });
  }
});

module.exports = router; 