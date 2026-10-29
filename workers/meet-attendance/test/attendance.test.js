import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateOpportunity, findMeetingLink, resolveMeetCode, judge, decideAppointment, runCheck, rulesFrom, report,
  applicantName, pastCallsReport, isNoteTaker } from '../src/attendance.js';
import { GoogleAuthError } from '../src/lib/google.js';

const MIN = 60_000;
const START = Date.parse('2026-10-27T10:00:00Z');
const END = START + 30 * MIN;
const RULES = rulesFrom({});
const CALENDLY = 'https://calendly.com/events/90a22550-9a2d-4ca7-8e5d-921d245adae2/google_meet';

const EVENT = {
  id: 'appt1', contactId: 'contact1', title: 'Board Positioning call', appointmentStatus: 'confirmed',
  startTime: '2026-10-27T10:00:00Z', endTime: '2026-10-27T10:30:00Z', address: CALENDLY,
};

function kv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { store, get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); } };
}

// Fake Meet: participants as [{ name, user, sessions: [[startMin, endMin|null]] }], minutes from START.
function fakeMeet(conferences) {
  return {
    conferences: async () => conferences.map((c, i) => ({
      name: 'conferenceRecords/c' + i,
      startTime: new Date(START + c.start * MIN).toISOString(),
      endTime: c.ended === false ? undefined : new Date(START + 40 * MIN).toISOString(),
      participants: c.participants,
    })),
    participants: async conf => conf.participants.map(p => ({
      name: 'p/' + p.name, sessions: p.sessions,
      ...(p.user ? { signedinUser: { user: p.user, displayName: p.name } } : { anonymousUser: { displayName: p.name } }),
    })),
    sessions: async p => p.sessions.map(([s, e]) => ({
      startTime: new Date(START + s * MIN).toISOString(),
      endTime: e === null ? undefined : new Date(START + e * MIN).toISOString(),
    })),
  };
}

const SUSANNE = { name: 'Susanne Chishti', user: 'users/111', sessions: [[0, 16]] };
const deps = (meet, now) => ({ meet, resolve: async () => 'dcw-anib-afw', hostIds: ['users/111'], rules: RULES, now });

test('link: Calendly redirect link, direct Meet link, or none', () => {
  assert.deepEqual(findMeetingLink(EVENT), { calendlyUrl: CALENDLY });
  assert.deepEqual(findMeetingLink({ notes: 'Join https://meet.google.com/DCW-anib-afw now' }), { code: 'dcw-anib-afw' });
  assert.equal(findMeetingLink({ address: 'Zoom' }), null);
});

test('resolve: reads the Meet code from the redirect without following it', async () => {
  let options;
  const code = await resolveMeetCode({ calendlyUrl: CALENDLY }, async (url, opts) => {
    options = opts;
    return new Response(null, { status: 302, headers: { location: 'https://meet.google.com/dcw-anib-afw' } });
  });
  assert.equal(code, 'dcw-anib-afw');
  assert.equal(options.redirect, 'manual');
  assert.equal(await resolveMeetCode({ calendlyUrl: CALENDLY }, async () => new Response('gone', { status: 404 })), null);
});

test('judge: an applicant in the call counts as Showed straight away', () => {
  const d = judge({ conferences: 1, attendees: [{ name: 'Jane', isHost: false, minutes: 20 }], end: END, now: END + 15 * MIN, rules: RULES });
  assert.equal(d.outcome, 'showed');
});

test('judge: waits until the final check before any absence decision', () => {
  const d = judge({ conferences: 1, attendees: [{ name: 'Susanne', isHost: true, minutes: 16 }], end: END, now: END + 60 * MIN, rules: RULES });
  assert.equal(d.outcome, 'wait');
});

test('judge: host waited alone → No Show', () => {
  const d = judge({ conferences: 1, attendees: [{ name: 'Susanne', isHost: true, minutes: 16 }], end: END, now: END + 120 * MIN, rules: RULES });
  assert.equal(d.outcome, 'noshow');
});

test('judge: no Meet record is never a No Show', () => {
  const d = judge({ conferences: 0, attendees: [], end: END, now: END + 180 * MIN, rules: RULES });
  assert.equal(d.outcome, 'review');
});

test('judge: a brief guest join or a call still running → review', () => {
  const brief = judge({ conferences: 1, attendees: [{ name: 'Susanne', isHost: true, minutes: 16 }, { name: 'Jane', isHost: false, minutes: 2 }], end: END, now: END + 120 * MIN, rules: RULES });
  assert.equal(brief.outcome, 'review');
  const running = judge({ conferences: 1, attendees: [{ name: 'Susanne', isHost: true, minutes: 150, ongoing: true }], end: END, now: END + 120 * MIN, rules: RULES });
  assert.equal(running.outcome, 'review');
});

test('decide: sums sessions, separates the host, ignores conferences on other days', async () => {
  const meet = fakeMeet([
    { start: 0, participants: [SUSANNE, { name: 'Jane Doe', user: 'users/222', sessions: [[2, 5], [6, 25]] }] },
    { start: -3 * 24 * 60, participants: [{ name: 'Old caller', sessions: [[-4320, -4300]] }] },
  ]);
  const d = await decideAppointment(EVENT, deps(meet, END + 15 * MIN));
  assert.equal(d.outcome, 'showed');
  assert.deepEqual(d.attendees.map(a => [a.name, a.isHost, a.minutes]), [['Susanne Chishti', true, 16], ['Jane Doe', false, 22]]);
});

test('decide: an anonymous or phone guest counts as the applicant', async () => {
  const meet = fakeMeet([{ start: 0, participants: [SUSANNE, { name: 'Jane (phone)', sessions: [[1, 20]] }] }]);
  assert.equal((await decideAppointment(EVENT, deps(meet, END + 15 * MIN))).outcome, 'showed');
});

test('decide: no Meet link → review at the final check, wait before it', async () => {
  const event = { ...EVENT, address: '' };
  const meet = fakeMeet([]);
  assert.equal((await decideAppointment(event, deps(meet, END + 15 * MIN))).outcome, 'wait');
  const d = await decideAppointment(event, deps(meet, END + 120 * MIN));
  assert.equal(d.outcome, 'review');
  assert.match(d.reason, /no Google Meet link/);
});

test('report: readable summary with who joined', () => {
  const text = report(EVENT, { outcome: 'noshow', reason: 'Nobody else joined.', code: 'dcw-anib-afw',
    attendees: [{ name: 'Susanne Chishti', isHost: true, minutes: 16 }] }, 'Europe/London');
  assert.match(text, /^Google Meet attendance: No Show\n/);
  // ICU versions differ on the comma after the weekday.
  assert.match(text, /When: Tuesday,? 27 October 2026 at 10:00/);
  assert.ok(text.includes('- Susanne Chishti (host): 16 min'));
});

// ---- runCheck: the whole cron run with fakes ----

const PIPE = { GHL_PIPELINE_ID: 'pipe', GHL_STAGE_NO_SHOW: 'st-noshow', GHL_STAGE_ATTENDED: 'st-done', GHL_STAGES_BEFORE_CALL: 'st-booked,st-reminder' };
const BOOKED = [{ id: 'opp1', pipelineId: 'pipe', pipelineStageId: 'st-booked', status: 'open' }];

function fakeGhl(events, opportunities = BOOKED) {
  const calls = [];
  return {
    calls,
    events: async (...args) => { calls.push(['events', ...args]); return events; },
    opportunities: async () => opportunities,
    moveOpportunity: async (id, pipelineId, stageId) => { calls.push(['move', id, stageId]); },
    createOpportunity: async o => { calls.push(['create', o]); },
    addNote: async (id, body) => { calls.push(['note', id, body]); },
  };
}

const ENV = (over = {}) => ({ GHL_CALENDAR_IDS: 'cal1', DRY_RUN: 'false', REPORT_TIMEZONE: 'Europe/London', STATE: kv(), ...PIPE, ...over });
const ACCESS = async () => ({ accessToken: 'x', userId: 'users/111' });
const writes = ghl => ghl.calls.filter(c => c[0] !== 'events');

test('run: No Show moves the opportunity, adds a note and is not repeated', async () => {
  const env = ENV();
  const ghl = fakeGhl([EVENT]);
  const mails = [];
  const run = () => runCheck(env, { now: END + 120 * MIN, ghl, getAccess: ACCESS, meet: fakeMeet([{ start: 0, participants: [SUSANNE] }]),
    resolve: async () => 'dcw-anib-afw', notify: async (s) => mails.push(s) });

  assert.deepEqual(await run(), [{ ids: ['appt1'], outcome: 'noshow' }]);
  assert.deepEqual(ghl.calls.find(c => c[0] === 'move'), ['move', 'opp1', 'st-noshow']);
  const note = ghl.calls.find(c => c[0] === 'note');
  assert.equal(note[1], 'contact1');
  assert.match(note[2], /Opportunity: moved to "No Show"./);
  assert.equal(env.STATE.store.get('done:' + CALENDLY), 'noshow');
  assert.deepEqual(mails, []);

  assert.deepEqual(await run(), []);
  assert.equal(ghl.calls.filter(c => c[0] === 'move').length, 1);
});

test('run: the same booking on both calendars is decided once, one opportunity update', async () => {
  const env = ENV({ GHL_CALENDAR_IDS: 'calA, calB' });
  const ghl = fakeGhl([]);
  ghl.events = async id => [{ ...EVENT, id: id === 'calA' ? 'copyA' : 'copyB', calendarId: id }];
  const result = await runCheck(env, { now: END + 120 * MIN, ghl, getAccess: ACCESS,
    meet: fakeMeet([{ start: 0, participants: [SUSANNE] }]), resolve: async () => 'dcw-anib-afw' });
  assert.deepEqual(result, [{ ids: ['copyA', 'copyB'], outcome: 'noshow' }]);
  assert.deepEqual(writes(ghl).map(c => c[0]), ['move', 'note']);
});

test('opportunity: the newest open one before the call moves; others never pulled back', async () => {
  const ghl = fakeGhl([], [
    { id: 'old', pipelineId: 'pipe', pipelineStageId: 'st-booked', status: 'open', updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'new', pipelineId: 'pipe', pipelineStageId: 'st-reminder', status: 'open', updatedAt: '2026-10-20T00:00:00Z' },
    { id: 'other', pipelineId: 'marketing', pipelineStageId: 'x', status: 'open', updatedAt: '2026-10-25T00:00:00Z' },
  ]);
  await updateOpportunity(ghl, PIPE, 'c1', 'showed', 'Jane');
  assert.deepEqual(writes(ghl), [['move', 'new', 'st-done']]);

  const later = fakeGhl([], [
    { id: 'q', pipelineId: 'pipe', pipelineStageId: 'st-qualified', status: 'open' },
    { id: 'l', pipelineId: 'pipe', pipelineStageId: 'st-booked', status: 'lost' },
  ]);
  assert.match(await updateOpportunity(later, PIPE, 'c1', 'noshow', 'Jane'), /left where it is/);
  assert.deepEqual(writes(later), []);
});

test('opportunity: created at the outcome stage when the contact has none in the pipeline', async () => {
  const ghl = fakeGhl([], [{ id: 'm', pipelineId: 'marketing', pipelineStageId: 'x', status: 'open' }]);
  assert.match(await updateOpportunity(ghl, PIPE, 'c1', 'showed', 'Jane Doe'), /created .* "Call Completed"/);
  assert.deepEqual(writes(ghl), [['create', { contactId: 'c1', name: 'Jane Doe', pipelineId: 'pipe', pipelineStageId: 'st-done' }]]);
});

test('run: one cancelled copy closes the whole booking', async () => {
  const ghl = fakeGhl([EVENT, { ...EVENT, id: 'copy2', appointmentStatus: 'cancelled' }]);
  const result = await runCheck(ENV(), { now: END + 120 * MIN, ghl, getAccess: ACCESS,
    meet: fakeMeet([{ start: 0, participants: [SUSANNE] }]), resolve: async () => 'dcw-anib-afw' });
  assert.deepEqual(result, []);
  assert.deepEqual(writes(ghl), []);
});

test('run: review emails the team and leaves GHL alone', async () => {
  const ghl = fakeGhl([EVENT]);
  const mails = [];
  await runCheck(ENV(), { now: END + 120 * MIN, ghl, getAccess: ACCESS, meet: fakeMeet([]),
    resolve: async () => 'dcw-anib-afw', notify: async (s, t) => mails.push([s, t]) });
  assert.deepEqual(writes(ghl), []);
  assert.equal(mails[0][0], 'Check attendance: Board Positioning call');
  assert.match(mails[0][1], /GHL was not changed/);
});

test('run: dry run only emails what it would do', async () => {
  const ghl = fakeGhl([EVENT]);
  const mails = [];
  await runCheck(ENV({ DRY_RUN: 'true' }), { now: END + 120 * MIN, ghl, getAccess: ACCESS, meet: fakeMeet([{ start: 0, participants: [SUSANNE] }]),
    resolve: async () => 'dcw-anib-afw', notify: async (s) => mails.push(s) });
  assert.deepEqual(writes(ghl), []);
  assert.deepEqual(mails, ['[Dry run] Would mark No Show: Board Positioning call']);
});

test('run: skips closed, too-recent and already-decided appointments without asking Google', async () => {
  const now = END + 120 * MIN;
  const link = n => `https://calendly.com/events/00000000-0000-0000-0000-00000000000${n}/google_meet`;
  const events = [
    { ...EVENT, id: 'a', address: link(1), appointmentStatus: 'cancelled' },
    { ...EVENT, id: 'b', address: link(2), appointmentStatus: 'showed' },
    { ...EVENT, id: 'c', address: link(3), endTime: new Date(now - 5 * MIN).toISOString() },
    { ...EVENT, id: 'd', address: link(4) },
  ];
  let asked = false;
  const result = await runCheck(ENV({ STATE: kv({ ['done:' + link(4)]: 'noshow' }) }), { now, ghl: fakeGhl(events),
    getAccess: async () => { asked = true; return ACCESS(); } });
  assert.deepEqual(result, []);
  assert.equal(asked, false);
});

test('run: a broken Google connection sends one alert a day and changes nothing', async () => {
  const env = ENV({ PUBLIC_URL: 'https://fintech-meet-attendance.boards.workers.dev' });
  const ghl = fakeGhl([EVENT]);
  const mails = [];
  const run = () => runCheck(env, { now: END + 120 * MIN, ghl, notify: async (s, t) => mails.push([s, t]),
    getAccess: async () => { throw new GoogleAuthError('Google connection was revoked'); } });
  await run();
  await run();
  assert.equal(mails.length, 1);
  assert.match(mails[0][1], /fintech-meet-attendance\.boards\.workers\.dev\/oauth\/google\/start/);
  assert.deepEqual(writes(ghl), []);
});

test('run: a failing check is retried, then handed to a person after 6 hours', async () => {
  const failingMeet = { conferences: async () => { throw new Error('Meet 503'); } };
  const mails = [];
  const opts = now => ({ now, ghl: fakeGhl([EVENT]), getAccess: ACCESS, meet: failingMeet,
    resolve: async () => 'dcw-anib-afw', notify: async (s, t) => mails.push(t) });
  const env = ENV();
  assert.deepEqual(await runCheck(env, opts(END + 120 * MIN)), []);
  assert.deepEqual(await runCheck(env, opts(END + 7 * 60 * MIN)), [{ ids: ['appt1'], outcome: 'review' }]);
  assert.match(mails[0], /kept failing: Meet 503/);
});

// ---- helpers and the past-calls report ----

test('applicant name comes from the appointment title', () => {
  assert.equal(applicantName({ title: 'Rachel Bale and FINTECH Circle Board Programme' }), 'Rachel Bale');
  assert.equal(applicantName({ title: '' }), 'Board Programme applicant');
});


test('past report: decides every past booking without changing GHL, and pages', async () => {
  const link = n => `https://calendly.com/events/00000000-0000-0000-0000-00000000000${n}/google_meet`;
  const events = [
    { ...EVENT, id: 'a', address: link(1) },
    { ...EVENT, id: 'b', address: link(2), appointmentStatus: 'cancelled' },
    { ...EVENT, id: 'c', address: link(3) },
  ];
  const ghl = { events: async () => events };  // no write methods: any write would throw
  const now = END + 3 * 24 * 60 * MIN;
  const first = await pastCallsReport(ENV(), { now, limit: 2, ghl, getAccess: ACCESS,
    meet: fakeMeet([{ start: 0, participants: [SUSANNE] }]), resolve: async () => 'dcw-anib-afw' });
  assert.equal(first.total, 3);
  assert.deepEqual(first.rows.map(r => [r.appointmentIds[0], r.outcome]), [['a', 'noshow'], ['b', 'cancelled']]);
  assert.equal(first.rows[0].applicant, 'Board Positioning call');
  const second = await pastCallsReport(ENV(), { now, offset: 2, limit: 2, ghl, getAccess: ACCESS,
    meet: fakeMeet([]), resolve: async () => 'dcw-anib-afw' });
  assert.deepEqual(second.rows.map(r => r.outcome), ['review']);
});

test('run: an opportunity update failing is retried, then emailed after 6 hours', async () => {
  const env = ENV();
  const mails = [];
  const ghl = fakeGhl([EVENT]);
  ghl.opportunities = async () => { throw new Error('GHL 401 opportunities'); };
  const opts = now => ({ now, ghl, getAccess: ACCESS, notify: async (s, t) => mails.push(t),
    meet: fakeMeet([{ start: 0, participants: [SUSANNE] }]), resolve: async () => 'dcw-anib-afw' });
  assert.deepEqual(await runCheck(env, opts(END + 120 * MIN)), []);
  assert.equal(env.STATE.store.get('done:' + CALENDLY), undefined);
  assert.deepEqual(await runCheck(env, opts(END + 7 * 60 * MIN)), [{ ids: ['appt1'], outcome: 'review' }]);
  assert.match(mails[0], /GHL could not be updated automatically: GHL 401 opportunities/);
});

test('note-takers: recognised by product name, real names are not', () => {
  for (const n of ["Dragana's Circleback", 'Otter.ai', 'Fireflies.ai Notetaker', 'Fathom', 'Read.ai meeting notes', 'tl;dv', 'MeetGeek bot'])
    assert.ok(isNoteTaker(n), n);
  for (const n of ['Rachel Bale', 'Glenn Burgess', 'Jamie Grain', 'Botha Smith', 'Abbott'])
    assert.ok(!isNoteTaker(n), n);
});

test('decide: an applicant\'s note-taker alone is not attendance', async () => {
  const meet = fakeMeet([{ start: 0, participants: [SUSANNE, { name: "Jane's Circleback", user: 'users/333', sessions: [[0, 20]] }] }]);
  const d = await decideAppointment(EVENT, deps(meet, END + 120 * MIN));
  assert.equal(d.outcome, 'noshow');
  assert.ok(report(EVENT, d, 'Europe/London').includes("- Jane's Circleback (note-taker, ignored): 20 min"));
});
