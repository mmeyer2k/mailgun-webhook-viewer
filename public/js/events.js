let currentPage = 1;

// Handle Enter key in search fields
function handleEnterKey(event) {
    if (event.key === 'Enter') {
        searchWebhooks();
    }
}

async function searchWebhooks(page = 1) {
    currentPage = page;
    const recipient = document.getElementById('recipient').value;
    const subject = document.getElementById('subject').value;
    const event = document.getElementById('event').value;
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;

    const params = new URLSearchParams({
        page,
        recipient,
        subject,
        event,
        startDate,
        endDate
    });

    // Update URL without reloading the page
    const newUrl = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`;
    window.history.pushState({ path: newUrl }, '', newUrl);

    try {
        const response = await fetch(`/api/webhooks?${params}`);
        const data = await response.json();
        displayWebhooks(data.webhooks);
        displayPagination(data.pages);
        
        // Add this new line to display total results
        document.getElementById('totalResults').textContent = `Total Results: ${data.total}`;
    } catch (error) {
        console.error('Error fetching webhooks:', error);
    }
}

function displayWebhooks(webhooks) {
    const webhooksList = document.getElementById('webhooksList');
    webhooksList.innerHTML = webhooks.map(webhook => `
        <div class="webhook-item">
            <div class="webhook-header">
                <a href="/event.html?id=${webhook._id}&event=${webhook.event}&${getSearchParams()}">${webhook.event.toUpperCase()}</a>
                <span class="webhook-meta">
                    ${new Date(webhook.timestamp).toLocaleString()} | 
                    ${webhook.recipient} |
                    ${webhook.message?.headers?.subject || 'No Subject'}
                </span>
            </div>
            ${webhook.clientInfo?.bot ? `<p class="webhook-detail">Bot: ${webhook.clientInfo.bot}</p>` : ''}
            ${webhook.geolocation ? `
                <p class="webhook-detail">Location: ${[webhook.geolocation.city, webhook.geolocation.region, webhook.geolocation.country]
                    .filter(Boolean).join(', ')}</p>
            ` : ''}
            ${webhook.delivery ? `
                <p class="webhook-detail">Status: ${webhook.delivery.status}${webhook.delivery.description ? ` - ${webhook.delivery.description}` : ''}</p>
            ` : ''}
            ${webhook.reason ? `<p class="webhook-detail">Reason: ${webhook.reason}</p>` : ''}
            <details>
                <summary>Raw Data</summary>
                <pre>${JSON.stringify(webhook.rawData, null, 2)}</pre>
            </details>
        </div>
    `).join('');
}

function displayPagination(totalPages) {
    const pagination = document.getElementById('pagination');
    if (totalPages <= 1) {
        pagination.innerHTML = '';
        return;
    }

    let html = '';
    
    // Show max 7 pages with ellipsis
    const maxVisiblePages = 7;
    let startPage = 1;
    let endPage = totalPages;
    
    if (totalPages > maxVisiblePages) {
        const leftOffset = Math.floor(maxVisiblePages / 2);
        const rightOffset = maxVisiblePages - leftOffset - 1;
        
        if (currentPage <= leftOffset) {
            // Near the start
            endPage = maxVisiblePages - 1;
            html += generatePageButtons(1, endPage);
            html += `<span class="pagination-ellipsis">...</span>`;
            html += generatePageButton(totalPages);
        } else if (currentPage >= totalPages - rightOffset) {
            // Near the end
            startPage = totalPages - maxVisiblePages + 2;
            html += generatePageButton(1);
            html += `<span class="pagination-ellipsis">...</span>`;
            html += generatePageButtons(startPage, totalPages);
        } else {
            // Middle case
            startPage = currentPage - leftOffset;
            endPage = currentPage + rightOffset;
            html += generatePageButton(1);
            html += `<span class="pagination-ellipsis">...</span>`;
            html += generatePageButtons(startPage, endPage);
            html += `<span class="pagination-ellipsis">...</span>`;
            html += generatePageButton(totalPages);
        }
    } else {
        // If total pages is less than max visible, show all pages
        html += generatePageButtons(1, totalPages);
    }
    
    pagination.innerHTML = html;
}

function generatePageButton(pageNum) {
    return `<button onclick="searchWebhooks(${pageNum})" 
                    class="page-button ${pageNum === currentPage ? 'active' : ''}"
                    ${pageNum === currentPage ? 'disabled' : ''}>
                ${pageNum}
            </button>`;
}

function generatePageButtons(start, end) {
    return Array.from(
        { length: end - start + 1 },
        (_, i) => generatePageButton(start + i)
    ).join('');
}

function getSearchParams() {
    const params = new URLSearchParams();
    const recipient = document.getElementById('recipient').value;
    const subject = document.getElementById('subject').value;
    const event = document.getElementById('event').value;
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;

    if (recipient) params.set('search_recipient', recipient);
    if (subject) params.set('search_subject', subject);
    if (event) params.set('search_event', event);
    if (startDate) params.set('search_startDate', startDate);
    if (endDate) params.set('search_endDate', endDate);

    return params.toString();
}

// Restore search criteria from URL
function restoreSearchCriteria() {
    const params = new URLSearchParams(window.location.search);
    
    if (params.has('recipient')) document.getElementById('recipient').value = params.get('recipient');
    if (params.has('subject')) document.getElementById('subject').value = params.get('subject');
    if (params.has('event')) document.getElementById('event').value = params.get('event');
    if (params.has('startDate')) document.getElementById('startDate').value = params.get('startDate');
    if (params.has('endDate')) document.getElementById('endDate').value = params.get('endDate');

    // Always load webhooks, whether there are search params or not
    searchWebhooks();
}

// Initial load
restoreSearchCriteria();

function clearSearch() {
    // Clear all input fields
    document.getElementById('recipient').value = '';
    document.getElementById('subject').value = '';
    document.getElementById('event').value = '';
    document.getElementById('startDate').value = '';
    document.getElementById('endDate').value = '';

    // Reset to first page and search
    currentPage = 1;
    // Clear URL without reloading the page
    window.history.pushState({ path: '/' }, '', '/');
    searchWebhooks();
} 