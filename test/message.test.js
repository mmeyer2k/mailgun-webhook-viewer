const test = require('node:test');
const assert = require('node:assert');
const { normalizeMessageId, htmlToText, renderMessage, MESSAGE_LIMITS } = require('../server/mcp/message');

test('normalizeMessageId strips angle brackets and whitespace', () => {
  // The raw Message-Id header carries <...>; Mailgun's event payload, and so
  // the stored messageId, does not. An agent may paste either.
  assert.strictEqual(normalizeMessageId(' <abc@mg.example.com> '), 'abc@mg.example.com');
  assert.strictEqual(normalizeMessageId('abc@mg.example.com'), 'abc@mg.example.com');
});

test('htmlToText drops head, style and script content', () => {
  const html = '<html><head><title>T</title><style>p{color:red}</style></head>' +
    '<body><script>alert(1)</script><p>Hello</p></body></html>';
  assert.strictEqual(htmlToText(html), 'Hello');
});

test('htmlToText keeps block structure as line breaks', () => {
  const html = '<div>One</div><p>Two<br>Three</p><ul><li>a</li><li>b</li></ul>';
  assert.strictEqual(htmlToText(html), 'One\nTwo\nThree\n- a\n- b');
});

test('htmlToText keeps link targets, which is often what the question is about', () => {
  assert.strictEqual(
    htmlToText('<a href="https://x.example/reset?t=1">Reset password</a>'),
    'Reset password (https://x.example/reset?t=1)'
  );
  // A link whose text already is the URL is not repeated.
  assert.strictEqual(htmlToText('<a href="https://x.example">https://x.example</a>'), 'https://x.example');
});

test('htmlToText decodes entities once, not twice', () => {
  assert.strictEqual(htmlToText('a&nbsp;&amp;&nbsp;b &lt;x&gt; &#39;q&#x27; &amp;lt;'), "a & b <x> 'q' &lt;");
});

test('htmlToText collapses layout whitespace', () => {
  const html = '<table>\n  <tr>\n    <td>  Total:   </td>\n    <td> $10 </td>\n  </tr>\n\n\n\n</table>';
  assert.strictEqual(htmlToText(html), 'Total: $10');
});

const doc = {
  messageId: 'abc@mg.example.com',
  'message-headers': [
    ['Received', 'from somewhere'],
    ['subject', 'Your order'],
    ['From', 'Shop <shop@example.com>'],
    ['To', 'user@example.com'],
    ['Date', 'Tue, 21 Oct 2026 10:00:00 +0000'],
  ],
  'body-plain': 'Plain body',
  'body-html': '<p>HTML body</p>',
  attachments: [{ url: 'https://storage.mailgun.net/x', 'content-type': 'application/pdf', name: 'invoice.pdf', size: 1234 }],
};

test('renderMessage prefers the plain-text part', () => {
  const out = renderMessage(doc, {});
  assert.strictEqual(out.found, true);
  assert.strictEqual(out.source, 'body-plain');
  assert.strictEqual(out.body, 'Plain body');
  assert.strictEqual(out.headers.Subject, 'Your order', 'header names match case-insensitively');
  assert.strictEqual(out.headers.From, 'Shop <shop@example.com>');
  assert.strictEqual(out.headers.Cc, undefined);
  assert.strictEqual(out.headers.Received, undefined, 'only the readable headers are returned');
});

test('renderMessage converts HTML when there is no plain part', () => {
  const out = renderMessage({ ...doc, 'body-plain': '  ' }, {});
  assert.strictEqual(out.source, 'body-html (converted to text)');
  assert.strictEqual(out.body, 'HTML body');
});

test('renderMessage returns raw HTML on request', () => {
  const out = renderMessage(doc, { format: 'html' });
  assert.strictEqual(out.source, 'body-html');
  assert.strictEqual(out.body, '<p>HTML body</p>');
});

test('renderMessage lists attachments without their storage URL', () => {
  // The URL only opens with the Mailgun API key, which the agent never has.
  const out = renderMessage(doc, {});
  assert.deepStrictEqual(out.attachments, [{ name: 'invoice.pdf', contentType: 'application/pdf', size: 1234 }]);
});

test('renderMessage pages through a long body', () => {
  const long = { ...doc, 'body-plain': 'x'.repeat(25) };
  const first = renderMessage(long, { maxChars: 10 });
  assert.strictEqual(first.body.length, 10);
  assert.strictEqual(first.totalChars, 25);
  assert.strictEqual(first.truncated, true);
  assert.strictEqual(first.nextOffset, 10);

  const last = renderMessage(long, { maxChars: 10, offset: 20 });
  assert.strictEqual(last.body.length, 5);
  assert.strictEqual(last.truncated, false);
  assert.strictEqual(last.nextOffset, null);
});

test('renderMessage clamps maxChars to the ceiling', () => {
  const huge = { ...doc, 'body-plain': 'x'.repeat(MESSAGE_LIMITS.maxChars + 10) };
  const out = renderMessage(huge, { maxChars: MESSAGE_LIMITS.maxChars * 10 });
  assert.strictEqual(out.body.length, MESSAGE_LIMITS.maxChars);
});

test('renderMessage reports an empty body rather than inventing one', () => {
  const out = renderMessage({ messageId: 'm', 'message-headers': [] }, {});
  assert.strictEqual(out.body, '');
  assert.strictEqual(out.source, null);
  assert.strictEqual(out.totalChars, 0);
});
