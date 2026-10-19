/* Automation: Summit website forms → GoHighLevel

   summit.fintechcircle.com has two forms. Its server posts each submission
   here as JSON with the shared secret in X-Webhook-Secret; we upsert the
   contact in GHL, add the form's tag, and email the team. GHL and the email
   are independent, so one failing never blocks the other.

     POST /summit/apply    "Request Your Place"       → Summit_Attendee
     POST /summit/contact  "Contact the Summit Team"  → Summit_ContactUs */

import { GhlClient } from '../lib/ghl.js';
import { sendEmail } from '../lib/email.js';
import { json } from '../lib/http.js';

const ROLE_LABELS = {
  'founder-ceo': 'Founder / CEO',
  'chair-ned': 'Chair / Non-Executive Director',
  'scaleup-leader': 'Senior leader at a fintech scaleup',
  'executive-search': 'Executive search / board advisory',
  other: 'Other',
};

export const SUMMIT_FORMS = {
  apply: {
    tag: 'Summit_Attendee',
    title: 'Summit application',
    email: d => [
      ['First name', d.firstName], ['Last name', d.lastName], ['Email', d.email],
      ['Job title', d.jobTitle], ['Company', d.company], ['Role', ROLE_LABELS[d.role] || d.role],
      ['LinkedIn', d.linkedin], ['Notes', d.notes],
    ],
    map: d => ({
      firstName: text(d.firstName, 80),
      lastName: text(d.lastName, 80),
      customFields: {
        form_type: 'summit-apply',
        job_title: text(d.jobTitle, 120),
        company: text(d.company, 120),
        role: ROLE_LABELS[d.role] || text(d.role, 120),
        linkedin_profile_url: text(d.linkedin, 255),
        enquiry_message: text(d.notes, 1000),
      },
    }),
  },
  contact: {
    tag: 'Summit_ContactUs',
    title: 'Summit contact',
    email: d => [
      ['Name', d.name], ['Email', d.email], ['Organisation', d.organisation],
      ['Subject', d.subject], ['Message', d.message],
    ],
    map: d => ({
      ...splitName(text(d.name, 160)),
      customFields: {
        form_type: 'summit-contact',
        organisation: text(d.organisation, 120),
        enquiry_topic: text(d.subject, 200),
        enquiry_message: text(d.message, 5000),
      },
    }),
  },
};

export function summitFormHandler(formKey) {
  const form = SUMMIT_FORMS[formKey];

  return async function handleSummitForm(request, env, ctx, deps = { sendEmail }) {
    if (!safeEqual(request.headers.get('X-Webhook-Secret'), env.SUMMIT_FORM_SECRET)) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400);
    }

    const contact = mapSummitForm(formKey, data);
    if (!contact) return json({ ok: false, error: 'A valid email is required' }, 400);

    const [ghl, email] = await Promise.allSettled([
      syncToGhl(contact, form.tag, env),
      deps.sendEmail(env.NOTIFY_EMAIL, summitNotification(formKey, data, contact, env)),
    ]);
    if (ghl.status === 'rejected') console.error('Summit form → GHL failed', formKey, contact.email, ghl.reason?.message);
    if (email.status === 'rejected') console.error('Summit form → email failed', formKey, contact.email, email.reason?.message);
    if (ghl.status === 'rejected' && email.status === 'rejected') {
      return json({ ok: false, error: 'Submission failed' }, 502);
    }

    console.log('Summit form', formKey, contact.email, 'ghl:', ghl.status === 'fulfilled' ? ghl.value : 'failed', form.tag, 'email:', email.status);
    return json({ ok: true, tag: form.tag });
  };
}

async function syncToGhl(contact, tag, env) {
  const ghl = new GhlClient(env.GHL_PRIVATE_TOKEN, env.GHL_LOCATION_ID);
  const contactId = await ghl.upsertContact(contact);
  if (!contactId) throw new Error('GHL upsert returned no contact id');
  await ghl.addTags(contactId, [tag]);
  return contactId;
}

export function summitNotification(formKey, data, contact, env) {
  const form = SUMMIT_FORMS[formKey];
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
  const lines = [`New "${form.title}" on summit.fintechcircle.com`, ''];
  for (const [label, value] of form.email(data)) {
    const v = text(value, 5000);
    if (v) lines.push(`${label}: ${v}`);
  }
  lines.push('', `Page: ${contact.customFields.form_submitted_from_url || 'unknown'}`, `GHL tag: ${form.tag}`,
    '', 'The contact has been added to GHL. Reply to this email to answer them directly.');
  return {
    from: env.NOTIFY_FROM,
    fromName: 'FINTECH Circle Summit',
    to: env.NOTIFY_TO,
    replyTo: contact.email,
    subject: `${form.title}: ${name || contact.email}`,
    text: lines.join('\n'),
  };
}

/* Pure mapping from a form submission to a GHL contact. Returns null when
   there is no usable email, which is the only field GHL needs to match on. */
export function mapSummitForm(formKey, data) {
  const form = SUMMIT_FORMS[formKey];
  if (!form || !data || typeof data !== 'object') return null;

  const email = text(data.email, 255).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;

  const contact = { email, source: 'Summit Website', ...form.map(data) };
  contact.customFields.form_submitted_from_url = text(data.submittedFromUrl, 500);
  // Leave empty values out so the upsert never blanks an existing one.
  for (const k of Object.keys(contact)) if (contact[k] === '' || contact[k] === undefined) delete contact[k];
  return contact;
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function splitName(fullName) {
  const parts = fullName.split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

// Compares every character so the response time does not reveal the secret.
function safeEqual(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
