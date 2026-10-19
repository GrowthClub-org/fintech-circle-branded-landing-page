/* Plain-text email through Cloudflare Email Routing's send_email binding.
   The recipient must be a verified destination address on the account, and
   the sender must be on a domain with Email Routing enabled. */

const encoder = new TextEncoder();

export async function sendEmail(binding, { from, fromName, to, replyTo, subject, text }) {
  const { EmailMessage } = await import('cloudflare:email');
  const raw = buildRawEmail({ from, fromName, to, replyTo, subject, text });
  await binding.send(new EmailMessage(from, to, raw));
}

export function buildRawEmail({ from, fromName, to, replyTo, subject, text, date = new Date() }) {
  const domain = from.split('@')[1];
  const headers = [
    `From: ${fromName ? `${encodeWord(fromName)} <${from}>` : from}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  return headers.join('\r\n') + '\r\n\r\n' + base64(text).replace(/.{76}/g, '$&\r\n') + '\r\n';
}

// RFC 2047 encoded-word, so names and subjects can carry any character.
function encodeWord(value) {
  const clean = String(value).replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${base64(clean)}?=`;
}

function base64(value) {
  let binary = '';
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
