/* Automation: landing page registration → WebinarGeek

   Replaces broadcast.growthclub.org's /api/v1/webinar/register. The landing
   page posts the same body it sent that backend; we subscribe the person to the
   webinar's next published session (the same one /webinar/upcoming shows) and
   answer in the backend's shape, { success, watchLink }, so the page's success
   handling is unchanged.

   The session is chosen here, never taken from the request, so the page can't
   be used to register people for other sessions. REGISTRATION_BROADCAST_ID, if
   set, pins a specific session instead. WebinarGeek's own webhook then syncs
   the registration to GHL through /webinargeek/ghl. */

import { json } from '../lib/http.js';
import { sendEmail } from '../lib/email.js';
import { findUpcomingBroadcast } from '../lib/upcoming-broadcast.js';
import { LP_ORIGINS as ALLOWED_ORIGINS } from './webinar-upcoming.js';
const API = 'https://app.webinargeek.com/api/v2';
const WG_TIMEOUT_MS = 8000;
// Background retries after the visitor has had their reply; Workers allow
// about 30 s of work after the response.
const RETRY_DELAYS_MS = [5000, 15000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Visitors with valid details always see success. If WebinarGeek can't take
   the registration right now, the reply is { success: true, pending: true },
   the Worker retries in the background, and if that fails too the team is
   emailed the details to add by hand. Only invalid input returns an error. */
export async function handleWebinarRegister(request, env, ctx, deps = { sendEmail, sleep }) {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!ALLOWED_ORIGINS.has(origin)) return withCors(json({ success: false, message: 'Forbidden' }, 403), cors);

  let data;
  try {
    data = await request.json();
  } catch {
    return withCors(json({ success: false, message: 'Invalid request' }, 400), cors);
  }

  const subscriber = parseRegistration(data);
  if (!subscriber) return withCors(json({ success: false, message: 'Please enter your name and a valid email address' }, 400), cors);

  try {
    const { broadcastId, watchLink } = await register(env, subscriber);
    console.log('Webinar register', broadcastId, subscriber.email, watchLink ? 'ok' : 'no watch link');
    return withCors(json({ success: true, watchLink, broadcastId: Number(broadcastId) }), cors);
  } catch (err) {
    console.error('Webinar register failed, retrying in background', subscriber.email, err.message);
    const work = retryThenAlert(env, subscriber, data, err.message, deps);
    if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
    return withCors(json({ success: true, watchLink: '', pending: true }), cors);
  }
}

// Resolve the session and subscribe; throws on any failure.
async function register(env, subscriber) {
  if (!env.WEBINARGEEK_API_KEY) throw new Error('WEBINARGEEK_API_KEY missing');
  const broadcastId = await resolveBroadcast(env);
  if (!broadcastId) throw new Error('no upcoming published session');
  const watchLink = await subscribe(env.WEBINARGEEK_API_KEY, broadcastId, subscriber);
  return { broadcastId, watchLink };
}

async function retryThenAlert(env, subscriber, data, firstError, deps) {
  let lastError = firstError;
  for (const delay of RETRY_DELAYS_MS) {
    await deps.sleep(delay);
    try {
      const { broadcastId } = await register(env, subscriber);
      console.log('Webinar register succeeded on retry', broadcastId, subscriber.email);
      return;
    } catch (err) {
      lastError = err.message;
    }
  }
  console.error('Webinar register FAILED after retries, emailing team', subscriber.email, lastError);
  try {
    await deps.sendEmail(env.NOTIFY_EMAIL, failedRegistrationEmail(env, subscriber, data, lastError));
  } catch (err) {
    console.error('Webinar register: could not email the team either', subscriber.email, err.message);
  }
}

export function failedRegistrationEmail(env, subscriber, data, error) {
  const name = [subscriber.firstname, subscriber.surname].filter(Boolean).join(' ');
  const lines = [
    'Someone registered on the webinar landing page, but WebinarGeek could not take the registration,',
    'even after retrying. They were shown the normal success page.',
    '',
    'Please add them to the upcoming session in WebinarGeek by hand:',
    '',
    `Name: ${name}`,
    `Email: ${subscriber.email}`,
    subscriber.company ? `Company: ${subscriber.company}` : null,
    subscriber.phone ? `Phone: ${subscriber.phone}` : null,
    `Page: ${text(data && data.submittedFromUrl, 500) || 'unknown'}`,
    `Time: ${new Date().toISOString()}`,
    '',
    `Error: ${error}`,
  ].filter(l => l !== null);
  return {
    from: env.NOTIFY_FROM,
    fromName: 'FINTECH Circle Website',
    to: env.NOTIFY_TO,
    replyTo: subscriber.email,
    subject: `ACTION NEEDED: webinar registration failed for ${name || subscriber.email}`,
    text: lines.join('\n'),
  };
}

/* Pure: validates the page's body and builds WebinarGeek's subscriber.
   The page sends one full-name field; WebinarGeek wants first and surname. */
export function parseRegistration(data) {
  if (!data || typeof data !== 'object') return null;
  const email = text(data.email, 255).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const parts = text(data.name, 160).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;

  const subscriber = { firstname: parts[0], email };
  if (parts.length > 1) subscriber.surname = parts.slice(1).join(' ');
  const company = text(data.company, 120);
  if (company) subscriber.company = company;
  const phone = text(data.phone, 20);
  if (/^\+?[0-9 ()-]{7,20}$/.test(phone)) subscriber.phone = phone;
  return subscriber;
}

// A pinned session wins; otherwise the webinar's next published session.
async function resolveBroadcast(env) {
  const pinned = String(env.REGISTRATION_BROADCAST_ID || '').trim();
  if (/^\d+$/.test(pinned)) return pinned;
  const next = await findUpcomingBroadcast(env.WEBINARGEEK_API_KEY, env.WEBINAR_ID);
  return next ? String(next.id) : null;
}

async function subscribe(apiKey, broadcastId, subscriber) {
  const headers = { 'Api-Token': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
  const res = await fetch(`${API}/broadcasts/${broadcastId}/subscriptions`, {
    method: 'POST', headers, body: JSON.stringify(subscriber), signal: AbortSignal.timeout(WG_TIMEOUT_MS),
  });
  if (res.ok) return (await res.json()).watch_link || '';

  // Already registered: hand back their existing join link instead of failing.
  const body = await res.text();
  const existing = await fetch(`${API}/subscriptions?broadcast_id=${broadcastId}&email=${encodeURIComponent(subscriber.email)}`, { headers });
  if (existing.ok) {
    const sub = ((await existing.json()).subscriptions || [])[0];
    if (sub && sub.watch_link) return sub.watch_link;
  }
  throw new Error(`WebinarGeek ${res.status}: ${body.slice(0, 300)}`);
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://webinar.fintechcircle.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withCors(response, cors) {
  for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
  return response;
}
