const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Webhook = require('../models/webhook');

// Webhook signature verification
const verifyWebhookSignature = (timestamp, token, signature) => {
  const signingKey = process.env.MAILGUN_SIGNING_KEY;

  // Ensure all required parameters are present
  if (!timestamp || !token || !signature || !signingKey) {
    console.error('Missing signature parameters:', { timestamp, token, signature, hasKey: !!signingKey });
    return false;
  }

  try {
    const encodedToken = crypto
      .createHmac('sha256', signingKey)
      .update(timestamp.concat(token))
      .digest('hex');

    const isValid = encodedToken === signature;
    if (!isValid) {
      console.error('Signature mismatch:', { 
        expected: signature,
        calculated: encodedToken
      });
    }
    return isValid;
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
};

router.post('/', async (req, res) => {
  try {
    // Verify webhook signature
    const { timestamp, token, signature } = req.body.signature || {};
    if (!verifyWebhookSignature(timestamp, token, signature)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const eventData = req.body['event-data'];
    
    const webhook = new Webhook(eventData);

    await webhook.save();
    res.status(200).json({ message: 'Webhook received and stored' });
  } catch (error) {
    console.error('Error storing webhook:', error);
    res.status(500).json({ error: 'Error storing webhook' });
  }
});

module.exports = router; 