import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pickUpcoming, clearUpcomingCache } from '../src/lib/upcoming-broadcast.js';
import { handleWebinarUpcoming } from '../src/automations/webinar-upcoming.js';
import { handleWebinarRegister } from '../src/automations/webinar-register.js';

const NOW = Date.parse('2026-10-28T09:00:00Z');
const at = iso => Date.parse(iso) / 1000;
const WEBINAR = {
  id: 575538, title: 'Board seats 2027',
  episodes: [
    { id: 1, title: 'Draft episode', published: false, broadcasts: [{ id: 111, date: at('2026-11-01T11:00:00Z') }] },
    { id: 2, title: 'Live episode', published: true, broadcasts: [
      { id: 220, date: at('2026-10-16T11:00:00Z'), has_ended: true },
      { id: 221, date: at('2026-11-05T11:00:00Z'), cancelled: true },
      { id: 222, date: at('2026-11-27T11:00:00Z') },
      { id: 223, date: at('2026-11-20T11:00:00Z'), public_replay_link: null },
    ] },
  ],
};

beforeEach(() => clearUpcomingCache());

test('pick: earliest future session in a published episode', () => {
  assert.deepEqual(pickUpcoming(WEBINAR, NOW), { id: 223, date: at('2026-11-20T11:00:00Z'), title: 'Live episode', public_replay_link: null });
});

test('pick: drafts, ended, cancelled and past sessions are skipped; none left → null', () => {
  const onlyBad = { episodes: [WEBINAR.episodes[0], { published: true, broadcasts: WEBINAR.episodes[1].broadcasts.slice(0, 2) }] };
  assert.equal(pickUpcoming(onlyBad, NOW), null);
  assert.equal(pickUpcoming({}, NOW), null);
});

async function withFakeWg(fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    if (String(url).endsWith('/webinars/575538')) return Response.json(WEBINAR);
    if (String(url).includes('/subscriptions') && init.method === 'POST') return Response.json({ watch_link: 'https://wg/watch/x' }, { status: 201 });
    return new Response('no', { status: 404 });
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
}
const ENV = { WEBINARGEEK_API_KEY: 'k', WEBINAR_ID: '575538' };

test('upcoming: answers in the backend\'s shape', async () => {
  await withFakeWg(async () => {
    const res = await handleWebinarUpcoming(new Request('https://w/webinar/upcoming', { headers: { Origin: 'https://fintechcirclepro.com' } }), ENV);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://fintechcirclepro.com');
    const j = await res.json();
    assert.equal(j.broadcast_id, 223);
    assert.equal(j.broadcast_data.broadcast_id, 223);
    assert.equal(j.broadcast_data.readable_date, '2026-11-20 11:00:00');
    assert.equal(j.broadcast_data.webinar_title, 'Live episode');
    assert.ok('public_replay_link' in j.broadcast_data);
  });
});

test('upcoming: WebinarGeek down → 502 with broadcast_id null, so the page falls back', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 500 });
  try {
    const res = await handleWebinarUpcoming(new Request('https://w/webinar/upcoming'), ENV);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).broadcast_id, null);
  } finally { globalThis.fetch = real; }
});

test('register: without a pin, uses the same next published session', async () => {
  await withFakeWg(async calls => {
    const req = new Request('https://w/webinar/register', { method: 'POST', headers: { Origin: 'https://webinar.fintechcircle.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A B', email: 'a@b.co' }) });
    const res = await handleWebinarRegister(req, ENV);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).broadcastId, 223);
    assert.ok(calls.some(c => c.method === 'POST' && c.url.endsWith('/broadcasts/223/subscriptions')));
  });
});

test('register: a pinned session wins over the lookup', async () => {
  await withFakeWg(async calls => {
    const req = new Request('https://w/webinar/register', { method: 'POST', headers: { Origin: 'https://webinar.fintechcircle.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A B', email: 'a@b.co' }) });
    const res = await handleWebinarRegister(req, { ...ENV, REGISTRATION_BROADCAST_ID: '999' });
    assert.equal((await res.json()).broadcastId, 999);
    assert.ok(!calls.some(c => c.url.endsWith('/webinars/575538')), 'no lookup when pinned');
  });
});
