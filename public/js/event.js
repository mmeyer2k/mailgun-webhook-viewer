// Get message ID from URL
const urlParams = new URLSearchParams(window.location.search);
const messageId = urlParams.get('id');
const eventType = urlParams.get('event');

// Set up back link with search parameters
function setupBackLink() {
    const searchParams = new URLSearchParams();
    
    // Copy search parameters from URL to new URL
    for (const [key, value] of urlParams.entries()) {
        if (key.startsWith('search_')) {
            searchParams.set(key.replace('search_', ''), value);
        }
    }
    
    const backLink = document.getElementById('backLink');
    if (searchParams.toString()) {
        backLink.href = `/?${searchParams.toString()}`;
    }
}

setupBackLink();

async function loadMessage() {
    try {
        const response = await fetch(`/api/webhooks/${messageId}`);
        const { webhook, relatedEvents } = await response.json();
        
        // Update event type badge
        const eventBadge = document.getElementById('eventType');
        eventBadge.textContent = webhook.event.toUpperCase();
        eventBadge.className = `event-badge ${webhook.event}`;

        // Update page title based on event type
        const eventTitle = document.getElementById('eventTitle');
        const titles = {
            accepted: 'Email Acceptance',
            delivered: 'Email Delivery',
            opened: 'Email Open Event',
            clicked: 'Email Click Event',
            complained: 'Spam Complaint',
            failed: 'Delivery Failure',
            permanent_fail: 'Permanent Delivery Failure',
            temporary_fail: 'Temporary Delivery Failure',
            unsubscribed: 'Unsubscribe Event'
        };
        eventTitle.textContent = titles[webhook.event] || 'Email Event Details';
        document.title = `${titles[webhook.event]} - Mailgun Webhook Manager`;

        // Update metadata
        document.getElementById('subject').textContent = webhook.message?.headers?.subject || 'No Subject';
        document.getElementById('from').textContent = webhook.message?.headers?.from || 'N/A';
        document.getElementById('to').innerHTML = webhook.message?.headers?.to ? 
            `<a href="/?recipient=${encodeURIComponent(webhook.message.headers.to)}" class="recipient-link">${webhook.message.headers.to}</a>` : 
            'N/A';
        
        // Make message ID clickable
        const msgId = webhook.message?.headers?.['message-id'];
        document.getElementById('messageId').innerHTML = msgId ? 
            `<a href="/message.html?id=${encodeURIComponent(msgId)}" class="message-link">${msgId}</a>` : 
            'N/A';
        
        // Add back timeline display
        displayTimeline(relatedEvents);
        
        // Display raw data
        document.getElementById('rawData').textContent = JSON.stringify(webhook, null, 2);

    } catch (error) {
        console.error('Error loading message:', error);
    }
}

// Load message on page load
loadMessage();

function displayTimeline(events) {
    const timeline = document.getElementById('timeline');
    timeline.innerHTML = events.map(event => `
        <div class="timeline-event ${event.event} ${event._id === messageId ? 'current' : ''}"
             onclick="window.location.href='/event.html?id=${event._id}&event=${event.event}&${getSearchParamsFromUrl()}'">
            <div class="timeline-time">${new Date(event.timestamp * 1000).toLocaleString()}</div>
            <div class="timeline-event-type">${event.event.toUpperCase()}</div>
            ${getEventDetails(event)}
        </div>
    `).join('');
}

function getEventDetails(event) {
    let details = [];
    
    if (event.delivery) {
        details.push(`Status: ${event.delivery.status}${event.delivery.description ? ` - ${event.delivery.description}` : ''}`);
    }
    if (event.clientInfo?.bot) {
        details.push(`Bot: ${event.clientInfo.bot}`);
    }
    if (event.geolocation) {
        details.push(`Location: ${[event.geolocation.city, event.geolocation.region, event.geolocation.country]
            .filter(Boolean).join(', ')}`);
    }
    if (event.reason) {
        details.push(`Reason: ${event.reason}`);
    }
    
    return details.length ? `
        <div class="timeline-details">
            ${details.join('<br>')}
        </div>
    ` : '';
}

function generateEventDetails(webhook) {
    let details = '<dl>';
    
    // Get raw event data
    const eventData = webhook.rawData['event-data'];
    
    switch(webhook.event) {
        case 'delivered':
            details += `
                <dt>Delivery Status</dt>
                <dd>${webhook.delivery?.status || 'N/A'}</dd>
                <dt>MX Host</dt>
                <dd>${webhook.delivery?.mxHost || 'N/A'}</dd>
                <dt>SMTP Response</dt>
                <dd>${eventData?.delivery?.['smtp-response'] || 'N/A'}</dd>
                <dt>Attempt Number</dt>
                <dd>${eventData?.delivery?.['attempt-no'] || '1'}</dd>
                <dt>Session Duration</dt>
                <dd>${eventData?.delivery?.['session-seconds'] || '0'}s</dd>
            `;
            break;
        case 'failed':
        case 'permanent_fail':
        case 'temporary_fail':
            details += `
                <dt>Failure Reason</dt>
                <dd>${webhook.reason || 'Unknown'}</dd>
                <dt>Code</dt>
                <dd>${webhook.delivery?.code || 'N/A'}</dd>
            `;
            break;
        case 'clicked':
        case 'opened':
            details += `
                <dt>Client</dt>
                <dd>${webhook.clientInfo?.clientName || 'Unknown'} (${webhook.clientInfo?.deviceType || 'Unknown'})</dd>
                <dt>Location</dt>
                <dd>${[webhook.geolocation?.city, webhook.geolocation?.region, webhook.geolocation?.country].filter(Boolean).join(', ') || 'Unknown'}</dd>
            `;
            break;
        case 'complained':
            details += `
                <dt>Complaint Type</dt>
                <dd>Spam Report</dd>
            `;
            break;
    }
    
    details += '</dl>';
    return details;
}

function getSearchParamsFromUrl() {
    const params = new URLSearchParams();
    for (const [key, value] of urlParams.entries()) {
        if (key.startsWith('search_')) {
            params.append(key, value);
        }
    }
    return params.toString();
} 