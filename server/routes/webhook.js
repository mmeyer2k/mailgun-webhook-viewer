const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const Webhook = require('../models/webhook');
const Message = require('../models/message');

// Webhook signature verification
const verifyWebhookSignature = (timestamp, token, signature) => {
  const signingKey = process.env.MAILGUN_API_KEY;

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
    
    // Save webhook event
    const webhook = new Webhook(eventData);
    await webhook.save();

    const messageId = eventData.message.headers['message-id'];
    const existingEvent = await Message.findOne({ messageId: messageId });

    // Download and store message content if URL exists
    if (eventData.storage?.url && !existingEvent) {
      try {
        const response = await axios.get(eventData.storage.url, {
          auth: {
            username: process.env.MAILGUN_API_USERNAME || 'api',
            password: process.env.MAILGUN_API_KEY
          }
        });

        if (!response.data) {
          throw new Error('No data received from Mailgun API');
        }

        // Store message content
        if (Object.keys(response.data).includes("body-html")) {
          const message = new Message({...response.data, messageId});
          await message.save();
        }
      } catch (error) {
        console.error('Error downloading/parsing event: ', error);
        res.status(500).json({ error: 'Error downloading/parsing event' });
        return;
      }
    }

    res.status(200).json({ message: 'Webhook received and stored' });
  } catch (error) {
    console.error('Error storing webhook:', error);
    res.status(500).json({ error: 'Error storing webhook' });
  }
});

module.exports = router; 