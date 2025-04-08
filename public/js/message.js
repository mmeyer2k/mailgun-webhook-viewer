async function loadMessageDetails() {
    const urlParams = new URLSearchParams(window.location.search);
    const messageId = urlParams.get('id');

    try {
        const response = await fetch(`/api/messages/${messageId}`);
        const message = await response.json();

        // Helper function to get header value
        const getHeader = (headers, name) => {
            const header = headers.find(h => h[0] === name);
            return header ? header[1] : 'Not available';
        };

        // Fill in message details from message-headers array
        document.getElementById('messageId').textContent = message.messageId;
        document.getElementById('subject').textContent = getHeader(message['message-headers'], 'Subject');
        document.getElementById('from').textContent = getHeader(message['message-headers'], 'From');
        document.getElementById('to').textContent = getHeader(message['message-headers'], 'To');

        // Set HTML content
        const htmlFrame = document.getElementById('htmlFrame');
        htmlFrame.srcdoc = message['body-html'] || 'No HTML content available';

        // Set plain text content
        document.getElementById('plainText').textContent = message['body-plain'] || 'No plain text content available';

        // Set raw data content
        document.getElementById('rawData').textContent = JSON.stringify(message, null, 2);
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

async function printMessage() {
    // Wait for message details if they haven't loaded yet
    if (!document.getElementById('subject').textContent) {
        await loadMessageDetails();
    }
    
    // Copy message details to print area
    document.getElementById('printSubject').textContent = document.getElementById('subject').textContent;
    document.getElementById('printFrom').textContent = document.getElementById('from').textContent;
    document.getElementById('printTo').textContent = document.getElementById('to').textContent;
    document.getElementById('printDate').textContent = new Date().toLocaleString();
    
    const htmlFrame = document.getElementById('htmlFrame');
    const printContent = document.getElementById('printContent');
    
    // Ensure iframe content is loaded
    if (htmlFrame.contentDocument.readyState === 'complete') {
        printContent.innerHTML = htmlFrame.contentDocument.body.innerHTML;
        window.print();
    } else {
        htmlFrame.onload = () => {
            printContent.innerHTML = htmlFrame.contentDocument.body.innerHTML;
            window.print();
        };
    }
}

// Load message details when page loads
document.addEventListener('DOMContentLoaded', () => {
    loadMessageDetails();
});