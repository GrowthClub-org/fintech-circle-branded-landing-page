import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRegistration, handleWebinarRegister } from '../src/automations/webinar-register.js';

const ENV = { WEBINARGEEK_API_KEY: 'wg-key', REGISTRATION_BROADCAST_ID: '6989640' };
const BODY = { name: 'Jane van der Berg', email: ' Jane@Example.com ', company: 'Acme', phone: '+447700900123', submittedFromUrl: 'https://webinar.fintechcircle.com/', terms: true, broadcastId: 1, clientId: 'fintech-circle' };

test('parse: splits the name, lowercases email, keeps company and phone', () => {
  assert.deepEqual(parseRegistration(BODY), { firstname: 'Jane', surname: 'van der Berg', email: 'jane@example.com', company: 'Acme', phone: '+447700900123' });
  assert.deepEqual(parseRegistration({ name: 'Cher', email: 'c@x.co' }), { firstname: 'Cher', email: 'c@x.co' });
  assert.equal(parseRegistration({ name: '', email: 'c@x.co' }), null);
  assert.equal(parseRegistration({ name: 'A B', email: 'nope' }), null);
  assert.equal(parseRegistration({ name: 'A B', email: 'a@b.co', phone: '<script>' }).phone, undefined);
});

function req(body, origin = 'https://webinar.fintechcircle.com', method = 'POST') {
  return new Request('https://w.example/webinar/register', {
    method, body: method === 'POST' ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  });
}

async function withFakeWg(fn, { conflict = false } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body && JSON.parse(init.body) });
    if (String(url).includes('/broadcasts/') && init.method === 'POST') {
      return conflict ? new Response('{"message":"already subscribed"}', { status: 422 }) : Response.json({ id: 9, watch_link: 'https://wg/watch/new' }, { status: 201 });
    }
    if (String(url).includes('/subscriptions?')) return Response.json({ subscriptions: [{ id: 8, watch_link: 'https://wg/watch/existing' }] });
    return new Response('no', { status: 404 });
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
}

test('handler: preflight, origin check and bad input', async () => {
  const pre = await handleWebinarRegister(req(null, 'https://webinar.fintechcircle.com', 'OPTIONS'), ENV);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://webinar.fintechcircle.com');
  assert.equal((await handleWebinarRegister(req(BODY, 'https://evil.example'), ENV)).status, 403);
  assert.equal((await handleWebinarRegister(req({ ...BODY, email: 'x' }), ENV)).status, 400);
});

test('failure: visitor still sees success; retries, then emails the team', async () => {
  const real = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') posts++;
    return new Response('WebinarGeek down', { status: 500 });
  };
  try {
    const sent = [], waits = [];
    const deps = { sendEmail: async (b, m) => sent.push(m), sleep: async ms => waits.push(ms) };
    let background;
    const ctx = { waitUntil: p => { background = p; } };
    const res = await handleWebinarRegister(req(BODY), { ...ENV, NOTIFY_TO: 'boards@fintechcircle.com', NOTIFY_FROM: 'forms@fintechcirclepro.com' }, ctx, deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, watchLink: '', pending: true });
    await background;
    assert.equal(posts, 3, 'first try plus two retries');
    assert.deepEqual(waits, [5000, 15000]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /^ACTION NEEDED: webinar registration failed for Jane van der Berg/);
    for (const line of ['Email: jane@example.com', 'Company: Acme', 'Phone: +447700900123', 'Error: WebinarGeek 500']) assert.ok(sent[0].text.includes(line), line);
  } finally { globalThis.fetch = real; }
});

test('failure: a retry that succeeds sends no email', async () => {
  const real = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && ++posts > 1) return Response.json({ watch_link: 'https://wg/watch/late' }, { status: 201 });
    return new Response('blip', { status: 503 });
  };
  try {
    const sent = [];
    let background;
    const res = await handleWebinarRegister(req(BODY), ENV, { waitUntil: p => { background = p; } }, { sendEmail: async (b, m) => sent.push(m), sleep: async () => {} });
    assert.equal((await res.json()).pending, true);
    await background;
    assert.equal(posts, 2);
    assert.equal(sent.length, 0);
  } finally { globalThis.fetch = real; }
});

test('missing API key is treated as a failure, not shown to the visitor', async () => {
  const sent = [];
  const res = await handleWebinarRegister(req(BODY), { ...ENV, WEBINARGEEK_API_KEY: '' }, {}, { sendEmail: async (b, m) => sent.push(m), sleep: async () => {} });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).pending, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('WEBINARGEEK_API_KEY missing'));
});

test('handler: subscribes to the configured broadcast, ignoring the page', async () => {
  await withFakeWg(async calls => {
    const res = await handleWebinarRegister(req(BODY), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, watchLink: 'https://wg/watch/new', broadcastId: 6989640 });
    const post = calls.find(c => c.method === 'POST');
    assert.ok(post.url.endsWith('/broadcasts/6989640/subscriptions'), 'uses config, not the page broadcastId');
    assert.equal(post.headers['Api-Token'], 'wg-key');
    assert.equal(post.body.firstname, 'Jane');
  });
});

test('handler: already registered returns the existing join link', async () => {
  await withFakeWg(async () => {
    const res = await handleWebinarRegister(req(BODY), ENV);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).watchLink, 'https://wg/watch/existing');
  }, { conflict: true });
});
