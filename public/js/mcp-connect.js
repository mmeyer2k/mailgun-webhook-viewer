// "Connect MCP" button: copies a prompt the user pastes into Claude Code, which
// then installs this server against itself.

// Built from location.origin rather than a configured value, so the prompt
// names whatever host this page was actually served on. That used to be
// unsound: /mcp checked the Host header against MCP_ALLOWED_HOSTS while the
// static files serving this very script did not, so the button happily handed
// out a URL the endpoint answered with 403. The Host allowlist is gone and
// location.origin is now genuinely the right source.
function mcpInstallPrompt() {
    const url = `${window.location.origin}/mcp`;
    return `Add the Mailgun webhook archive as an MCP server, then verify it:

1. Run: claude mcp add --transport http mailgun ${url}
2. Reconnect so the tools load, then call describe_collection on the
   webhooks collection and show me the indexes it reports.

It's read-only and reachable only from our private/Tailscale network. It ships
its own usage instructions in the MCP handshake — read those before querying;
the collection holds ~100M documents and unindexed queries are refused, not run.
`;
}

// navigator.clipboard is undefined outside a secure context, which is exactly
// the normal case here: plain http:// on a Tailscale address. The textarea +
// execCommand path is deprecated but still works there, so it's the fallback
// rather than the other way around.
function copyText(text) {
    if (navigator.clipboard) {
        return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    }
    return legacyCopy(text);
}

function legacyCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    document.body.appendChild(textarea);
    textarea.select();

    try {
        if (!document.execCommand('copy')) {
            return Promise.reject(new Error('execCommand("copy") returned false'));
        }
        return Promise.resolve();
    } catch (err) {
        return Promise.reject(err);
    } finally {
        document.body.removeChild(textarea);
    }
}

let toastTimer = null;

function showToast(message) {
    const toast = document.getElementById('mcpToast');
    // textContent, not innerHTML — the failure message interpolates the URL.
    toast.textContent = message;
    toast.classList.add('visible');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 6000);
}

function copyMcpPrompt() {
    copyText(mcpInstallPrompt())
        .then(() => showToast('Copied — paste it into Claude Code'))
        .catch(() => showToast(`Copy failed. Add it manually: ${window.location.origin}/mcp`));
}
