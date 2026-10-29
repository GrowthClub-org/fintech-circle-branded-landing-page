/* The attendance check, run by the cron trigger every 15 minutes.

   GHL appointment (Calendly calendar)
     → Calendly "google_meet" link in the appointment
     → its redirect to meet.google.com/abc-defg-hij
     → Meet conference records for that code → participants → sessions
     → decision: Showed / No Show / needs review / wait

   Only Showed and No Show change GHL (the appointment status, which fires the
   existing "Appointment Status" workflow). Anything uncertain is emailed to
   NOTIFY_TO instead: a missing Meet record is never treated as a no-show. */

import { GhlClient } from './lib/ghl.js';
import { MeetClient } from './lib/meet.js';
import { getAccess, GoogleAuthError } from './lib/google.js';
import { sendEmail } from './lib/email.js';

const MIN = 60_000;
// First look 15 minutes after the scheduled end.
const FIRST_CHECK_MS = 15 * MIN;
// How far back GHL is asked for appointments; longer than any decision takes.
const LOOKBACK_MS = 26 * 60 * MIN;
// Keep retrying failed checks this long after the end, then hand them to a person.
const GIVE_UP_MS = 6 * 60 * MIN;
const DONE_TTL_SECONDS = 60 * 24 * 60 * 60;
// Already decided, by us or by someone in GHL: never overwrite.
const CLOSED_STATUSES = new Set(['cancelled', 'canceled', 'invalid', 'showed', 'noshow']);

export const OUTCOME_LABEL = { showed: 'Showed', noshow: 'No Show', review: 'Needs review' };

const MEET_CODE = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i;
const CALENDLY_MEET_LINK = /https:\/\/calendly\.com\/events\/[0-9a-f-]{36}\/google_meet/i;

export function rulesFrom(env) {
  return {
    minAttendedMinutes: Number(env.MIN_ATTENDED_MINUTES) || 5,
    finalCheckMs: (Number(env.FINAL_CHECK_MINUTES) || 120) * MIN,
  };
}

/* The appointment's Meet link, wherever GHL put it (address, notes, ...):
   { code } for a direct Meet link, { calendlyUrl } for Calendly's redirect. */
export function findMeetingLink(event) {
  const text = JSON.stringify(event || {});
  const direct = MEET_CODE.exec(text);
  if (direct) return { code: direct[1].toLowerCase() };
  const calendly = CALENDLY_MEET_LINK.exec(text);
  return calendly ? { calendlyUrl: calendly[0] } : null;
}

/* Calendly's link answers with a redirect to the Meet room. Only the redirect
   is read; the Meet page itself is never opened. */
export async function resolveMeetCode(link, fetchImpl = fetch) {
  if (!link) return null;
  if (link.code) return link.code;
  const res = await fetchImpl(link.calendlyUrl, { redirect: 'manual' });
  const match = MEET_CODE.exec(res.headers.get('location') || '');
  return match ? match[1].toLowerCase() : null;
}

/* AI note-takers join as participants under names like "Dragana's Circleback"
   or "Otter.ai". They never count as the applicant attending. Kept to product
   names that aren't also common first names. */
const NOTE_TAKER = /circleback|\botter\b|otter\.ai|fireflies|fathom|read\.ai|tl;?dv|note ?taker|meetgeek|avoma|tactiq|bluedot|sembly|supernormal|notta|\bbot\b/i;

export function isNoteTaker(name) {
  return NOTE_TAKER.test(String(name || ''));
}

/* Everyone who joined this appointment's Meet, with their total minutes.
   Only conferences that started around the appointment count, in case the
   same room was used on another day. */
export async function collectAttendance(meet, code, appt, hostIds, rules, now) {
  const conferences = (await meet.conferences(code)).filter(conf => {
    const start = Date.parse(conf.startTime);
    return start >= appt.start - 60 * MIN && start <= appt.end + rules.finalCheckMs;
  });
  const attendees = [];
  for (const conf of conferences) {
    for (const participant of await meet.participants(conf)) {
      const sessions = await meet.sessions(participant);
      const ms = sessions.reduce((sum, s) =>
        sum + Math.max(0, (s.endTime ? Date.parse(s.endTime) : now) - Date.parse(s.startTime)), 0);
      const user = participant.signedinUser || participant.anonymousUser || participant.phoneUser || {};
      attendees.push({
        name: user.displayName || 'Unknown',
        isHost: Boolean(user.user && hostIds.includes(user.user)),
        isBot: isNoteTaker(user.displayName),
        minutes: Math.round(ms / MIN),
        ongoing: sessions.some(s => !s.endTime) || !conf.endTime,
      });
    }
  }
  return { conferences: conferences.length, attendees };
}

/* The decision rules. Returns { outcome: 'wait' | 'showed' | 'noshow' | 'review', reason }. */
export function judge({ conferences, attendees, end, now, rules }) {
  const final = now >= end + rules.finalCheckMs;
  const guests = attendees.filter(a => !a.isHost && !a.isBot);
  const hosts = attendees.filter(a => a.isHost);

  const attended = guests.filter(g => g.minutes >= rules.minAttendedMinutes);
  if (attended.length) {
    return { outcome: 'showed', reason: `${attended.map(g => g.name).join(', ')} joined the call.` };
  }
  if (!final) return { outcome: 'wait', reason: 'Too early to decide.' };

  if (!conferences) {
    return { outcome: 'review', reason: 'Google Meet has no record of this call: nobody joined it, so it may have happened by phone or on another link, or not at all.' };
  }
  if (guests.length) {
    return { outcome: 'review', reason: `Someone other than the host joined, but for under ${rules.minAttendedMinutes} minutes.` };
  }
  if (attendees.some(a => a.ongoing)) {
    return { outcome: 'review', reason: 'The call was still running at the final check.' };
  }
  if (hosts.length) {
    return { outcome: 'noshow', reason: 'The host joined and waited; nobody else joined the call.' };
  }
  return { outcome: 'review', reason: 'The Meet record could not be interpreted.' };
}

export async function decideAppointment(event, { meet, resolve, hostIds, rules, now }) {
  const appt = { start: Date.parse(event.startTime), end: Date.parse(event.endTime) };
  const final = now >= appt.end + rules.finalCheckMs;

  const link = findMeetingLink(event);
  const code = link && await resolve(link);
  if (!code) {
    if (!final) return { outcome: 'wait', reason: 'No Meet code yet.' };
    return {
      outcome: 'review',
      reason: link ? 'The Calendly link in the appointment did not lead to a Google Meet room.' : 'The appointment has no Google Meet link.',
      attendees: [],
    };
  }

  const attendance = await collectAttendance(meet, code, appt, hostIds, rules, now);
  return { ...judge({ ...attendance, end: appt.end, now, rules }), code, attendees: attendance.attendees };
}

/* GHL has two calendars with the same name, and each Calendly booking shows
   up on both. Copies share the Calendly/Meet link, so they are grouped by it
   and decided once. Appointments without a link stay on their own. */
export function groupBookings(events) {
  const groups = new Map();
  for (const event of events) {
    const link = findMeetingLink(event);
    const key = link ? (link.code || link.calendlyUrl) : 'appointment:' + event.id;
    if (!groups.has(key)) groups.set(key, { key, events: [] });
    const group = groups.get(key);
    if (!group.events.some(e => e.id === event.id)) group.events.push(event);
  }
  return [...groups.values()];
}

export function report(event, decision, tz, appointmentIds = [event.id]) {
  const when = Number.isNaN(Date.parse(event.startTime)) ? event.startTime : new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full', timeStyle: 'short', timeZone: tz,
  }).format(new Date(event.startTime));
  const lines = [
    `Google Meet attendance: ${OUTCOME_LABEL[decision.outcome]}`,
    `Why: ${decision.reason}`,
    '',
    `Appointment: ${event.title || '(untitled)'}`,
    `When: ${when}`,
    decision.code ? `Meet code: ${decision.code}` : null,
    `Appointment ID${appointmentIds.length > 1 ? 's' : ''}: ${appointmentIds.join(', ')}`,
    event.contactId ? `Contact ID: ${event.contactId}` : null,
  ];
  if (decision.attendees && decision.attendees.length) {
    lines.push('', 'Who joined:');
    for (const a of decision.attendees) lines.push(`- ${a.name}${a.isHost ? ' (host)' : a.isBot ? ' (note-taker, ignored)' : ''}: ${a.minutes} min`);
  }
  return lines.filter(line => line !== null).join('\n');
}

const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

// "Rachel Bale and FINTECH Circle Board Programme" → "Rachel Bale"
export function applicantName(event) {
  return String(event.title || '').replace(/\s+and\s+FINTECH Circle.*$/i, '').trim() || 'Board Programme applicant';
}

const OUTCOME_STAGE = { showed: 'Call Completed', noshow: 'No Show' };

/* Moves the contact's Sales Call Pipeline opportunity to the outcome's stage.
   GHL's API refuses to change the status of Calendly appointments, so the
   opportunity stage is what records the outcome and starts workflows.
   Only an open opportunity still before the call (GHL_STAGES_BEFORE_CALL) is
   moved, so a later stage (Qualified, Won, ...) is never pulled back. A
   contact with no opportunity in the pipeline gets one. Returns a line for
   the note. */
export async function updateOpportunity(ghl, env, contactId, outcome, name) {
  const stageId = outcome === 'noshow' ? env.GHL_STAGE_NO_SHOW : env.GHL_STAGE_ATTENDED;
  const pipelineId = env.GHL_PIPELINE_ID;
  if (!pipelineId || !stageId) throw new Error('GHL_PIPELINE_ID / stage ids are not set');

  const opportunities = (await ghl.opportunities(contactId)).filter(o => o.pipelineId === pipelineId);
  if (!opportunities.length) {
    await ghl.createOpportunity({ contactId, name, pipelineId, pipelineStageId: stageId });
    return `Opportunity: created in the Sales Call Pipeline at "${OUTCOME_STAGE[outcome]}".`;
  }
  const beforeCall = list(env.GHL_STAGES_BEFORE_CALL);
  const movable = opportunities
    .filter(o => o.status === 'open' && beforeCall.includes(o.pipelineStageId))
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  if (!movable.length) return 'Opportunity: left where it is (already past the call stage, or closed).';
  await ghl.moveOpportunity(movable[0].id, pipelineId, stageId);
  return `Opportunity: moved to "${OUTCOME_STAGE[outcome]}".`;
}

async function apply(booking, decision, { env, ghl, notify, dryRun }) {
  const event = booking.events[0];
  let text = report(event, decision, env.REPORT_TIMEZONE, booking.events.map(e => e.id));
  const label = OUTCOME_LABEL[decision.outcome];

  if (dryRun) {
    return notify(`[Dry run] Would mark ${label}: ${event.title || event.id}`,
      text + '\n\nDRY_RUN is on, so GHL was not changed.');
  }
  if (decision.outcome === 'review') {
    return notify(`Check attendance: ${event.title || event.id}`,
      text + '\n\nGHL was not changed. Please set the appointment status yourself.');
  }

  const contactIds = [...new Set(booking.events.map(e => e.contactId).filter(Boolean))];
  if (!contactIds.length) throw new Error('The appointment has no contact');
  const lines = [];
  for (const contactId of contactIds) {
    lines.push(await updateOpportunity(ghl, env, contactId, decision.outcome, applicantName(event)));
  }
  text += '\n\n' + lines.join('\n');
  for (const contactId of contactIds) {
    // The status is what matters; a failed note is only logged.
    await ghl.addNote(contactId, text).catch(err => console.warn('Note failed for', contactId, err.message));
  }
}

/* Read-only: what the check would decide for past calls. Changes nothing in
   GHL and ignores the "decided" markers. Paged with offset/limit, because one
   request may only make so many outgoing calls. */
export async function pastCallsReport(env, { days = 35, offset = 0, limit = 6, ...deps } = {}) {
  const now = deps.now || Date.now();
  const calendarIds = list(env.GHL_CALENDAR_IDS).filter(id => id !== 'REPLACE_ME');
  const ghl = deps.ghl || new GhlClient(env.GHL_PRIVATE_TOKEN, env.GHL_LOCATION_ID);
  const rules = rulesFrom(env);

  const events = [];
  for (const id of calendarIds) events.push(...await ghl.events(id, now - days * 24 * 60 * MIN, now));
  const bookings = groupBookings(events)
    .filter(b => Date.parse(b.events[0].endTime) <= now - FIRST_CHECK_MS)
    .sort((a, b) => Date.parse(a.events[0].startTime) - Date.parse(b.events[0].startTime));
  const page = bookings.slice(offset, offset + limit);

  const access = await (deps.getAccess || getAccess)(env);
  const meet = deps.meet || new MeetClient(access.accessToken);
  const hostIds = [access.userId, ...list(env.HOST_USER_IDS)];
  const resolve = deps.resolve || resolveMeetCode;

  const rows = [];
  for (const booking of page) {
    const event = booking.events[0];
    const statuses = [...new Set(booking.events.map(e => e.appointmentStatus))];
    const row = {
      start: event.startTime,
      applicant: applicantName(event),
      contactId: event.contactId,
      appointmentIds: booking.events.map(e => e.id),
      ghlStatus: statuses.join('/'),
    };
    if (statuses.some(s => /^cancel/i.test(String(s)))) {
      rows.push({ ...row, outcome: 'cancelled', reason: 'Cancelled in GHL; not checked.' });
      continue;
    }
    try {
      const decision = await decideAppointment(event, { meet, resolve, hostIds, rules, now });
      let reason = decision.reason;
      if (decision.outcome === 'review' && !(decision.attendees || []).length && now - Date.parse(event.startTime) > 28 * 24 * 60 * MIN) {
        reason += ' Google Meet keeps records for about 30 days, so this call may simply be too old.';
      }
      rows.push({ ...row, outcome: decision.outcome, reason, attendees: decision.attendees || [] });
    } catch (err) {
      rows.push({ ...row, outcome: 'error', reason: err.message });
    }
  }
  return { total: bookings.length, offset, count: rows.length, rows };
}

/* One cron run. deps are injectable for tests. */
export async function runCheck(env, deps = {}) {
  const now = deps.now || Date.now();
  const calendarIds = String(env.GHL_CALENDAR_IDS || '').split(',').map(s => s.trim()).filter(id => id && id !== 'REPLACE_ME');
  if (!calendarIds.length) throw new Error('GHL_CALENDAR_IDS is not set');
  const ghl = deps.ghl || new GhlClient(env.GHL_PRIVATE_TOKEN, env.GHL_LOCATION_ID);
  const notify = deps.notify || ((subject, text) => sendEmail(env.NOTIFY_EMAIL, {
    from: env.NOTIFY_FROM, fromName: 'FINTECH Circle Meet Attendance', to: env.NOTIFY_TO, subject, text,
  }));
  const rules = rulesFrom(env);
  const dryRun = String(env.DRY_RUN).toLowerCase() !== 'false';

  const events = [];
  for (const id of calendarIds) events.push(...await ghl.events(id, now - LOOKBACK_MS, now));
  const due = [];
  for (const booking of groupBookings(events)) {
    // One cancelled or hand-marked copy closes the whole booking.
    if (booking.events.some(e => CLOSED_STATUSES.has(String(e.appointmentStatus || '').toLowerCase()))) continue;
    if (!(Date.parse(booking.events[0].endTime) <= now - FIRST_CHECK_MS)) continue;
    if (await env.STATE.get('done:' + booking.key)) continue;
    due.push(booking);
  }
  if (!due.length) return [];

  let access;
  try {
    access = await (deps.getAccess || getAccess)(env);
  } catch (err) {
    if (!(err instanceof GoogleAuthError)) throw err;
    console.error(err.message);
    // One email a day while the connection is broken, not one per run.
    if (!await env.STATE.get('alert:google')) {
      await notify('Meet attendance: Google connection needs Susanne',
        `${err.message}\n\nLink: ${env.PUBLIC_URL || ''}/oauth/google/start\n\n${due.length} appointment(s) are waiting to be checked. Nothing in GHL was changed.`);
      await env.STATE.put('alert:google', '1', { expirationTtl: 86400 });
    }
    return [];
  }

  const meet = deps.meet || new MeetClient(access.accessToken);
  const hostIds = [access.userId, ...String(env.HOST_USER_IDS || '').split(',')].map(s => s.trim()).filter(Boolean);
  const resolve = deps.resolve || resolveMeetCode;
  const results = [];

  for (const booking of due) {
    const event = booking.events[0];
    const ids = booking.events.map(e => e.id);
    let decision;
    try {
      decision = await decideAppointment(event, { meet, resolve, hostIds, rules, now });
    } catch (err) {
      console.error('Check failed for appointment', ids.join(','), err.message);
      if (now < Date.parse(event.endTime) + GIVE_UP_MS) continue;
      decision = { outcome: 'review', reason: `The attendance check kept failing: ${err.message}`, attendees: [] };
    }
    if (decision.outcome === 'wait') continue;

    try {
      await apply(booking, decision, { env, ghl, notify, dryRun });
    } catch (err) {
      console.error('Could not record the outcome for appointment', ids.join(','), err.message);
      if (now < Date.parse(event.endTime) + GIVE_UP_MS) continue;
      // Still failing hours later: hand it to a person rather than let it age out unseen.
      decision = { ...decision, reason: `${decision.reason} GHL could not be updated automatically: ${err.message}`, outcome: 'review' };
      try {
        await apply(booking, decision, { env, ghl, notify, dryRun });
      } catch (mailErr) {
        console.error('Could not email the review for appointment', ids.join(','), mailErr.message);
        continue;
      }
    }
    await env.STATE.put('done:' + booking.key, decision.outcome, { expirationTtl: DONE_TTL_SECONDS });
    console.log(JSON.stringify({ appointments: ids, contact: event.contactId, outcome: decision.outcome, reason: decision.reason, dryRun }));
    results.push({ ids, outcome: decision.outcome });
  }
  return results;
}
