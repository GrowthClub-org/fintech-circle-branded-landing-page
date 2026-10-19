import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSummitForm, summitFormHandler } from '../src/automations/summit-forms.js';

const APPLY = {
  firstName: ' Jane ', lastName: 'Doe', email: 'Jane@Example.com', jobTitle: 'CFO',
  company: 'Acme', role: 'chair-ned', linkedin: 'https://www.linkedin.com/in/jane', notes: '',
  submittedFromUrl: 'https://summit.fintechcircle.com/apply',
};

test('apply form: names, fields and role label', () => {
  const c = mapSummitForm('apply', APPLY);
  assert.equal(c.email, 'jane@example.com');
  assert.equal(c.firstName, 'Jane');
  assert.equal(c.lastName, 'Doe');
  assert.equal(c.source, 'Summit Website');
  assert.deepEqual(c.customFields, {
    form_type: 'summit-apply', job_title: 'CFO', company: 'Acme',
    role: 'Chair / Non-Executive Director',
    linkedin_profile_url: 'https://www.linkedin.com/in/jane',
    enquiry_message: '',
    form_submitted_from_url: 'https://summit.fintechcircle.com/apply',
  });
});

test('contact form: splits the single name field', () => {
  const c = mapSummitForm('contact', { name: 'Mary Jane Smith', email: 'm@x.co', subject: 'Sponsorship', message: 'Hello' });
  assert.equal(c.firstName, 'Mary');
  assert.equal(c.lastName, 'Jane Smith');
  assert.equal(c.customFields.enquiry_topic, 'Sponsorship');
  assert.equal(c.customFields.enquiry_message, 'Hello');
  assert.equal(c.customFields.form_type, 'summit-contact');
});

test('one-word name leaves the last name out rather than blanking it', () => {
  const c = mapSummitForm('contact', { name: 'Cher', email: 'c@x.co' });
  assert.equal(c.firstName, 'Cher');
  assert.ok(!('lastName' in c));
});

test('rejects missing or malformed email, and non-string values', () => {
  assert.equal(mapSummitForm('apply', { ...APPLY, email: '' }), null);
  assert.equal(mapSummitForm('apply', { ...APPLY, email: 'not-an-email' }), null);
  assert.equal(mapSummitForm('apply', null), null);
  assert.equal(mapSummitForm('apply', { ...APPLY, company: { $x: 1 } }).customFields.company, '');
});

function request(body, secret) {
  return new Request('https://w.example/summit/apply', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Webhook-Secret': secret } : {}) },
  });
}

const ENV = {
  SUMMIT_FORM_SECRET: 'shh-secret', GHL_PRIVATE_TOKEN: 'pit-x', GHL_LOCATION_ID: 'loc1', NOTIFY_EMAIL: {},
  NOTIFY_FROM: 'forms@fintechcirclepro.com', NOTIFY_TO: 'boards@fintechcircle.com',
};

async function withFakeGhl(fn, { failUpsert = false } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
    if (String(url).includes('/customFields')) return Response.json({ customFields: [{ id: 'cfJob', fieldKey: 'contact.job_title' }] });
    if (String(url).endsWith('/contacts/upsert')) return failUpsert ? new Response('down', { status: 500 }) : Response.json({ contact: { id: 'c9' } });
    return Response.json({});
  };
  try { await fn(calls); } finally { globalThis.fetch = realFetch; }
}

test('handler: secret required; upserts, tags and emails', async () => {
  await withFakeGhl(async calls => {
    const sent = [];
    const deps = { sendEmail: async (b, m) => sent.push(m) };
    const handle = summitFormHandler('apply');

    assert.equal((await handle(request(APPLY), ENV, {}, deps)).status, 401);
    assert.equal((await handle(request(APPLY, 'wrong-secret'), ENV, {}, deps)).status, 401);
    assert.equal((await handle(request(APPLY, 'shh-secret'), { ...ENV, SUMMIT_FORM_SECRET: undefined }, {}, deps)).status, 401);
    assert.equal((await handle(request({ ...APPLY, email: 'bad' }, 'shh-secret'), ENV, {}, deps)).status, 400);
    assert.equal(calls.filter(c => c.url.includes('/contacts')).length, 0);
    assert.equal(sent.length, 0);

    const res = await handle(request(APPLY, 'shh-secret'), ENV, {}, deps);
    assert.equal(res.status, 200);
    const upsert = calls.find(c => c.url.endsWith('/contacts/upsert'));
    assert.equal(upsert.body.email, 'jane@example.com');
    assert.deepEqual(upsert.body.customFields, [{ id: 'cfJob', field_value: 'CFO' }]);
    const tags = calls.filter(c => c.url.endsWith('/contacts/c9/tags'));
    assert.deepEqual(tags.map(c => [c.method, c.body]), [['POST', { tags: ['Summit_Attendee'] }]]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'boards@fintechcircle.com');
    assert.equal(sent[0].replyTo, 'jane@example.com');
    assert.equal(sent[0].subject, 'Summit application: Jane Doe');
    for (const line of ['Job title: CFO', 'Role: Chair / Non-Executive Director', 'Page: https://summit.fintechcircle.com/apply']) {
      assert.ok(sent[0].text.includes(line), line);
    }
    assert.ok(!sent[0].text.includes('Notes:'), 'empty fields are left out');
  });
});

test('handler: contact form email; GHL down still emails; both down is 502', async () => {
  const body = { name: 'Sam Lee', email: 's@x.co', subject: 'Sponsorship', message: 'Hi there' };
  await withFakeGhl(async () => {
    const sent = [];
    const ok = await summitFormHandler('contact')(request(body, 'shh-secret'), ENV, {}, { sendEmail: async (b, m) => sent.push(m) });
    assert.equal(ok.status, 200);
    assert.equal(sent[0].subject, 'Summit contact: Sam Lee');
    assert.ok(sent[0].text.includes('Message: Hi there'));
    const bad = await summitFormHandler('contact')(request(body, 'shh-secret'), ENV, {}, { sendEmail: async () => { throw new Error('x'); } });
    assert.equal(bad.status, 502);
  }, { failUpsert: true });
});
