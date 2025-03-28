async function loadMessageDetails() {
    const urlParams = new URLSearchParams(window.location.search);
    const messageId = urlParams.get('id');

    try {
        const response = await fetch(`/api/messages/${messageId}`);
        const message = await response.json();

        // Fill in message details
        document.getElementById('messageId').textContent = message.messageId;
        document.getElementById('subject').textContent = message.headers?.subject || 'No Subject';
        document.getElementById('from').textContent = message.headers?.from || 'No Sender';
        document.getElementById('to').textContent = message.headers?.to || 'No Recipient';

        // Set HTML content
        const htmlFrame = document.getElementById('htmlFrame');
        htmlFrame.srcdoc = message['body-html'] || 'No HTML content available';

        // Set plain text content
        document.getElementById('plainText').textContent = message['body-plain'] || 'No plain text content available';
    } catch (error) {
        console.error('Error loading message:', error);
    }
}

function showContent(type) {
    // Update tab buttons
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });
    document.querySelector(`button[onclick="showContent('${type}')"]`).classList.add('active');

    // Show selected content panel
    document.querySelectorAll('.content-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    document.getElementById(`${type}Content`).classList.add('active');
}

// Load message details when page loads
loadMessageDetails(); 