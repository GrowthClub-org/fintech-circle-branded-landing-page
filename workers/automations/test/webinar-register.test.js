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
  assert.equal((await handleWebinarRegister(req(BODY), { ...ENV, WEBINARGEEK_API_KEY: '' })).status, 503);
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
