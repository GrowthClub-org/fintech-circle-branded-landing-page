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

import { summitSheetRow } from '../src/automations/summit-forms.js';

test('sheet row: keyed by the tab headers, with contact id, tag and GHL-style time', () => {
  const contact = mapSummitForm('apply', APPLY);
  const p = summitSheetRow('apply', contact, 'Summit_Attendee', 'c9', new Date('2026-11-05T14:03:00Z'));
  assert.equal(p.formType, 'summit-apply');
  assert.equal(p.row['Contact Id'], 'c9');
  assert.equal(p.row['First Name'], 'Jane');
  assert.equal(p.row.Email, 'jane@example.com');
  assert.equal(p.row['Business Name'], 'Acme');
  assert.equal(p.row.Tags, 'summit_attendee');
  assert.equal(p.row.role, 'Chair / Non-Executive Director');
  assert.equal(p.row.form_type, 'summit-apply');
  assert.equal(p.row['Last Activity'], 'Nov 5 2026 14:03');
  const c = summitSheetRow('contact', mapSummitForm('contact', { name: 'Sam Lee', email: 's@x.co', organisation: 'Org', subject: 'Hi', message: 'Msg' }), 'Summit_ContactUs', 'c1');
  assert.equal(c.formType, 'summit-contact');
  assert.equal(c.row['Business Name'], 'Org');
  assert.equal(c.row.enquiry_topic, 'Hi');
});

test('sheet: off without SUMMIT_SHEET_URL; when on, posts after GHL and a sheet failure never blocks', async () => {
  for (const sheetUp of [true, false]) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body });
      if (String(url).startsWith('https://sheet.example')) return sheetUp ? new Response('{"status":"success"}') : new Response('nope', { status: 500 });
      if (String(url).includes('/customFields')) return Response.json({ customFields: [] });
      if (String(url).endsWith('/contacts/upsert')) return Response.json({ contact: { id: 'c9' } });
      return Response.json({});
    };
    try {
      const off = await summitFormHandler('apply')(request(APPLY, 'shh-secret'), ENV, {}, { sendEmail: async () => {} });
      assert.equal(off.status, 200);
      assert.equal(calls.filter(c => c.url.startsWith('https://sheet.example')).length, 0, 'nothing sent while off');
      const on = await summitFormHandler('apply')(request(APPLY, 'shh-secret'), { ...ENV, SUMMIT_SHEET_URL: 'https://sheet.example/exec' }, {}, { sendEmail: async () => {} });
      assert.equal(on.status, 200, 'sheet ' + (sheetUp ? 'up' : 'down') + ' still succeeds');
      const posted = calls.filter(c => c.url.startsWith('https://sheet.example'));
      assert.equal(posted.length, 1);
      assert.equal(JSON.parse(posted[0].body).row['Contact Id'], 'c9');
    } finally { globalThis.fetch = real; }
  }
});
