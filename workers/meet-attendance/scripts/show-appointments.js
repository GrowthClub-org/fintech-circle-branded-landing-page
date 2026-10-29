/* Prints a GHL contact's appointments: calendar ID, title, time, status and
   the Meet/Calendly link. Used to find GHL_CALENDAR_ID for the Calendly
   calendar, which the Calendars settings page doesn't list.

   Usage (from workers/meet-attendance, with GHL_PRIVATE_TOKEN in .dev.vars):
     node scripts/show-appointments.js <contactId>

   The token is read from .dev.vars and never printed. */

import { readFileSync } from 'node:fs';

const contactId = process.argv[2];
if (!contactId) {
  console.error('Usage: node scripts/show-appointments.js <contactId>');
  process.exit(1);
}

const vars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
const token = (vars.match(/^GHL_PRIVATE_TOKEN=(.+)$/m) || [])[1]?.trim();
if (!token || token.includes('REPLACE_ME')) {
  console.error('Put the GHL token after GHL_PRIVATE_TOKEN= in .dev.vars first.');
  process.exit(1);
}

const res = await fetch(`https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}/appointments`, {
  headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28', Accept: 'application/json' },
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`GHL answered ${res.status}: ${data.message || data.error || 'no details'}`);
  process.exit(1);
}

const events = data.events || [];
if (!events.length) console.log('No appointments on this contact.');
for (const e of events) {
  const link = (JSON.stringify(e).match(/https:\/\/(?:calendly\.com\/events\/[^"\s]+|meet\.google\.com\/[a-z-]+)/i) || [])[0];
  console.log([
    `calendarId: ${e.calendarId}`,
    `title:      ${e.title}`,
    `start:      ${e.startTime}`,
    `status:     ${e.appointmentStatus}`,
    `link:       ${link || '(none found)'}`,
  ].join('\n') + '\n');
}
