/* Automation: fintechcircle.com forms → GoHighLevel + email notification

   Every form on fintechcircle.com (contact, newsletter, and the enquiry forms
   on the service pages) posts its fields as JSON straight from the browser,
   with `formType` and `submitted_from_url` added. Each submission:
     1. creates or updates the GHL contact (matched on email), with the
        submission saved as a note so earlier ones are not lost, and
     2. emails a notification to the team.

   The two are independent: if one fails the other still happens, and the
   visitor sees an error only when both fail, so a lead is never lost
   silently. */

import { GhlClient } from '../lib/ghl.js';
import { sendEmail } from '../lib/email.js';
import { json } from '../lib/http.js';

const ALLOWED_ORIGINS = new Set(['https://fintechcircle.com', 'https://www.fintechcircle.com']);

// Field → [label in the email, GHL custom field key or a standard contact key].
const FIELDS = {
  firstName: ['First name', 'firstName'],
  lastName: ['Last name', 'lastName'],
  email: ['Email', null],
  topic: ['Topic', 'enquiry_topic'],
  company: ['Company', 'company'],
  organisation: ['Organisation', 'organisation'],
  linkedin: ['LinkedIn', 'linkedin_profile_url'],
  investorType: ['Investor type', 'investor_type'],
  revenue: ['Revenue', 'revenue'],
  target: ['Target banks / institutions', 'target'],
  question: ['Question', 'enquiry_message'],
  group: ['Group details', 'enquiry_message'],
  message: ['Message', 'enquiry_message'],
};

const FORM_NAMES = {
  contact: 'Contact us',
  newsletter: 'Newsletter sign-up',
  'fintech-education': 'Fintech education',
  'fintech-tours': 'Fintech tours',
  'investor-enquiry': 'Invest in fintech startups',
  'itn-films': 'ITN films',
  'pop-up-boards': 'Pop-up boards',
  'sell-into-banks': 'Sell into banks',
  webinars: 'Webinars',
};

const MAX_FIELD = 5000;

export async function handleWebsiteForm(request, env, ctx, deps = { sendEmail }) {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ALLOWED_ORIGINS.has(origin)) return withCors(json({ ok: false, error: 'Forbidden' }, 403), cors);

  let data;
  try {
    data = await request.json();
  } catch {
    return withCors(json({ ok: false, error: 'Invalid JSON' }, 400), cors);
  }

  const submission = parseSubmission(data);
  if (!submission) return withCors(json({ ok: false, error: 'A valid email is required' }, 400), cors);

  const [ghl, email] = await Promise.allSettled([
    syncToGhl(submission, env),
    deps.sendEmail(env.NOTIFY_EMAIL, notificationEmail(submission, env)),
  ]);
  const log = [submission.formType, submission.email];
  if (ghl.status === 'rejected') console.error('Website form → GHL failed', ...log, ghl.reason?.message);
  if (email.status === 'rejected') console.error('Website form → email failed', ...log, email.reason?.message);
  if (ghl.status === 'rejected' && email.status === 'rejected') {
    return withCors(json({ ok: false, error: 'Submission failed' }, 502), cors);
  }

  console.log('Website form', ...log, 'ghl:', ghl.status === 'fulfilled' ? ghl.value : 'failed', 'email:', email.status);
  return withCors(json({ ok: true }), cors);
}

/* Pure: validates and normalises a submission. Returns null without a valid
   email. Only known fields are kept; unknown ones are ignored. */
export function parseSubmission(data) {
  if (!data || typeof data !== 'object') return null;
  const email = text(data.email).toLowerCase().slice(0, 255);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;

  const fields = {};
  for (const key of Object.keys(FIELDS)) {
    const value = text(data[key]);
    if (value && key !== 'email') fields[key] = value;
  }
  const formType = text(data.formType).slice(0, 60) || 'unknown';
  return { email, formType, url: text(data.submitted_from_url).slice(0, 500), fields };
}

export function ghlContact(s) {
  const contact = { email: s.email, source: 'FINTECH Circle Website', customFields: {} };
  for (const [key, value] of Object.entries(s.fields)) {
    const target = FIELDS[key][1];
    if (target === 'firstName' || target === 'lastName') contact[target] = value.slice(0, 80);
    else contact.customFields[target] = value;
  }
  contact.customFields.form_type = s.formType;
  if (s.url) contact.customFields.form_submitted_from_url = s.url;
  return contact;
}

export function notificationEmail(s, env) {
  const formName = FORM_NAMES[s.formType] || s.formType;
  const name = [s.fields.firstName, s.fields.lastName].filter(Boolean).join(' ');
  const lines = [`New "${formName}" submission on fintechcircle.com`, ''];
  lines.push(`Email: ${s.email}`);
  for (const [key, value] of Object.entries(s.fields)) lines.push(`${FIELDS[key][0]}: ${value}`);
  lines.push('', `Page: ${s.url || 'unknown'}`, `Form type: ${s.formType}`, '', 'The contact has been added to GHL. Reply to this email to answer them directly.');
  return {
    from: env.NOTIFY_FROM,
    fromName: 'FINTECH Circle Website',
    to: env.NOTIFY_TO,
    replyTo: s.email,
    subject: `${formName}: ${name || s.email}`,
    text: lines.join('\n'),
  };
}

async function syncToGhl(s, env) {
  const ghl = new GhlClient(env.GHL_PRIVATE_TOKEN, env.GHL_LOCATION_ID);
  const contactId = await ghl.upsertContact(ghlContact(s));
  if (!contactId) throw new Error('GHL upsert returned no contact id');
  // Fields hold only the latest submission; the note keeps each one.
  const note = notificationEmail(s, env).text.split('\n\nThe contact has been added')[0];
  await ghl.addNote(contactId, note).catch(err => console.warn('GHL note failed', contactId, err.message));
  return contactId;
}

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_FIELD) : '';
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://fintechcircle.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withCors(response, cors) {
  for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
  return response;
}
