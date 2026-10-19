import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubmission, ghlContact, notificationEmail, handleWebsiteForm } from '../src/automations/website-forms.js';
import { buildRawEmail } from '../src/lib/email.js';

const ENV = {
  GHL_PRIVATE_TOKEN: 'pit-x', GHL_LOCATION_ID: 'loc1', NOTIFY_EMAIL: {},
  NOTIFY_FROM: 'forms@fintechcirclepro.com', NOTIFY_TO: 'boards@fintechcircle.com',
};

const CONTACT = {
  topic: 'Board Programme', firstName: 'Jane', lastName: 'Doe', email: ' Jane@Example.com ',
  message: 'Tell me more', formType: 'contact', submitted_from_url: 'https://fintechcircle.com/contact-us',
  sneaky: 'ignored',
};

test('parse: keeps known fields only, lowercases email, rejects bad email', () => {
  const s = parseSubmission(CONTACT);
  assert.equal(s.email, 'jane@example.com');
  assert.equal(s.formType, 'contact');
  assert.deepEqual(s.fields, { firstName: 'Jane', lastName: 'Doe', topic: 'Board Programme', message: 'Tell me more' });
  assert.equal(parseSubmission({ ...CONTACT, email: 'nope' }), null);
  assert.equal(parseSubmission(null), null);
  assert.equal(parseSubmission({ ...CONTACT, message: { $x: 1 } }).fields.message, undefined);
});

test('GHL contact: standard names, custom fields, form type and page', () => {
  const c = ghlContact(parseSubmission({
    firstName: 'Ann', lastName: 'Lee', email: 'a@x.co', linkedin: 'https://linkedin.com/in/a',
    investorType: 'Angel', formType: 'investor-enquiry', submitted_from_url: 'https://fintechcircle.com/invest',
  }));
  assert.equal(c.firstName, 'Ann');
  assert.equal(c.lastName, 'Lee');
  assert.deepEqual(c.customFields, {
    linkedin_profile_url: 'https://linkedin.com/in/a', investor_type: 'Angel',
    form_type: 'investor-enquiry', form_submitted_from_url: 'https://fintechcircle.com/invest',
  });
});

test('newsletter: email only', () => {
  const s = parseSubmission({ email: 'n@x.co', formType: 'newsletter', submitted_from_url: 'https://fintechcircle.com/' });
  assert.deepEqual(ghlContact(s).customFields, { form_type: 'newsletter', form_submitted_from_url: 'https://fintechcircle.com/' });
  assert.equal(notificationEmail(s, ENV).subject, 'Newsletter sign-up: n@x.co');
});

test('notification email: subject, reply-to and every field', () => {
  const e = notificationEmail(parseSubmission(CONTACT), ENV);
  assert.equal(e.to, 'boards@fintechcircle.com');
  assert.equal(e.replyTo, 'jane@example.com');
  assert.equal(e.subject, 'Contact us: Jane Doe');
  for (const line of ['Email: jane@example.com', 'Topic: Board Programme', 'Message: Tell me more', 'Page: https://fintechcircle.com/contact-us']) {
    assert.ok(e.text.includes(line), line);
  }
});

test('raw email: headers and base64 UTF-8 body', () => {
  const raw = buildRawEmail({ from: 'forms@fintechcirclepro.com', fromName: 'FINTECH Circle Website', to: 'boards@fintechcircle.com',
    replyTo: 'jane@example.com', subject: 'Contact us: Zoë', text: 'Héllo', date: new Date('2026-10-13T09:00:00Z') });
  assert.match(raw, /^From: FINTECH Circle Website <forms@fintechcirclepro\.com>\r\n/);
  assert.match(raw, /\r\nReply-To: jane@example\.com\r\n/);
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
  assert.match(raw, /\r\nMessage-ID: <[0-9a-f-]+@fintechcirclepro\.com>\r\n/);
  const body = raw.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0))), 'Héllo');
});

function req(body, origin = 'https://fintechcircle.com', method = 'POST') {
  return new Request('https://w.example/website/form', {
    method, body: method === 'POST' ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  });
}

async function withFakeGhl(fn, { failUpsert = false } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
    if (String(url).includes('/customFields')) return Response.json({ customFields: [{ id: 'cfTopic', fieldKey: 'contact.enquiry_topic' }] });
    if (String(url).endsWith('/contacts/upsert')) return failUpsert ? new Response('nope', { status: 500 }) : Response.json({ contact: { id: 'c1' } });
    return Response.json({});
  };
  try { await fn(calls); } finally { globalThis.fetch = realFetch; }
}

test('handler: CORS preflight and origin check', async () => {
  const pre = await handleWebsiteForm(req(null, 'https://fintechcircle.com', 'OPTIONS'), ENV);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://fintechcircle.com');
  assert.equal((await handleWebsiteForm(req(CONTACT, 'https://evil.example'), ENV)).status, 403);
  assert.equal((await handleWebsiteForm(req(CONTACT, null), ENV)).status, 403);
});

test('handler: upserts, adds a note, emails, and returns 200 with CORS', async () => {
  await withFakeGhl(async calls => {
    const sent = [];
    const res = await handleWebsiteForm(req(CONTACT, 'https://www.fintechcircle.com'), ENV, {}, { sendEmail: async (b, m) => sent.push(m) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://www.fintechcircle.com');
    assert.equal(calls.find(c => c.url.endsWith('/contacts/upsert')).body.email, 'jane@example.com');
    assert.ok(calls.find(c => c.url.endsWith('/contacts/c1/notes')).body.body.includes('Message: Tell me more'));
    assert.equal(calls.filter(c => c.url.includes('/tags')).length, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'Contact us: Jane Doe');
  });
});

test('handler: one channel failing still succeeds; both failing returns 502', async () => {
  await withFakeGhl(async () => {
    const ok = await handleWebsiteForm(req(CONTACT), ENV, {}, { sendEmail: async () => {} });
    assert.equal(ok.status, 200);
    const bad = await handleWebsiteForm(req(CONTACT), ENV, {}, { sendEmail: async () => { throw new Error('smtp'); } });
    assert.equal(bad.status, 502);
  }, { failUpsert: true });
});
