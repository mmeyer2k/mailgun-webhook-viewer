/**
 * Shape a stored `messages` document for an agent to read.
 *
 * `find` can return these documents, but it is the wrong tool for reading
 * one: the bodies are excluded unless projected by name, and collectBounded
 * drops any document larger than its byte budget whole — so an ordinary HTML
 * newsletter comes back as `returned: 0, truncated: true`. get_message reads
 * one document by message-id and hands back the body as text, in pages.
 */

const MESSAGE_LIMITS = {
  defaultChars: 20000,
  // Kept under DEFAULTS.maxBytes in query.js, so one page of body costs no
  // more context than one page of find results.
  maxChars: 80000,
};

// The headers a person reads in a mail client. The full set (Received chains,
// DKIM signatures) is still available through find with a projection.
const READABLE_HEADERS = ['Subject', 'From', 'To', 'Cc', 'Reply-To', 'Date'];

// The raw Message-Id header carries <...>; Mailgun's event payload, and so the
// stored messageId, does not. Accept either.
const normalizeMessageId = (id) => String(id).trim().replace(/^<(.*)>$/, '$1');

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// One pass, so `&amp;lt;` decodes to `&lt;` and not on to `<`.
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const named = NAMED_ENTITIES[e.toLowerCase()];
    return named === undefined ? m : named;
  });
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '');

/**
 * Readable text from an email's HTML part.
 *
 * Not a sanitizer and not a renderer: the output goes to an agent as a JSON
 * string, never into a page. It only has to keep the words, the line
 * structure, and the link targets — which are often what the question is
 * about ("which reset link did we send?").
 */
function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    // Source whitespace is layout, not content; only block tags break lines.
    .replace(/\s+/g, ' ');

  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (m, q, href, inner) => {
    const text = stripTags(inner).trim();
    if (!/^https?:/i.test(href) || text === href) return text || href;
    return text ? `${text} (${href})` : href;
  });

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|li|ul|ol|table|h[1-6]|blockquote|section|header|footer)\s*>/gi, '\n');

  return decodeEntities(stripTags(s))
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function pickHeaders(pairs) {
  const headers = {};
  for (const name of READABLE_HEADERS) {
    const hit = (pairs || []).find((h) => Array.isArray(h) && String(h[0]).toLowerCase() === name.toLowerCase());
    if (hit) headers[name] = hit[1];
  }
  return headers;
}

function chooseBody(doc, format) {
  if (format === 'html') {
    return doc['body-html'] ? { source: 'body-html', text: doc['body-html'] } : { source: null, text: '' };
  }
  if (doc['body-plain'] && doc['body-plain'].trim()) {
    return { source: 'body-plain', text: doc['body-plain'] };
  }
  if (doc['body-html']) {
    return { source: 'body-html (converted to text)', text: htmlToText(doc['body-html']) };
  }
  return { source: null, text: '' };
}

function renderMessage(doc, { format = 'text', offset = 0, maxChars } = {}) {
  const limit = Math.min(Math.max(Number(maxChars) || MESSAGE_LIMITS.defaultChars, 1), MESSAGE_LIMITS.maxChars);
  const start = Math.max(Number(offset) || 0, 0);
  const { source, text } = chooseBody(doc, format);
  const body = text.slice(start, start + limit);
  const end = start + body.length;

  return {
    found: true,
    messageId: doc.messageId,
    headers: pickHeaders(doc['message-headers']),
    // The storage URL only opens with the Mailgun API key, which the agent
    // never has, so it is left out.
    attachments: (doc.attachments || []).map((a) => ({
      name: a.name || a.filename,
      contentType: a['content-type'],
      size: a.size,
    })),
    format,
    source,
    offset: start,
    totalChars: text.length,
    truncated: end < text.length,
    nextOffset: end < text.length ? end : null,
    body,
  };
}

module.exports = { MESSAGE_LIMITS, normalizeMessageId, htmlToText, renderMessage };
