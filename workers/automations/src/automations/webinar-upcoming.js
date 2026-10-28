/* Automation: GET /webinar/upcoming — replaces broadcast.growthclub.org's
   /api/v1/broadcast/upcoming-broadcast for the landing page.

   Answers in the backend's shape so the page reads it unchanged:
   { broadcast_id, broadcast_data: { broadcast_id, date, has_ended, cancelled,
     webinar_title, readable_date, public_replay_link }, countdown_data, source } */

import { findUpcomingBroadcast, utcReadable } from '../lib/upcoming-broadcast.js';
import { json } from '../lib/http.js';

export const LP_ORIGINS = new Set(['https://webinar.fintechcircle.com', 'https://fintechcirclepro.com', 'https://www.fintechcirclepro.com']);

export async function handleWebinarUpcoming(request, env) {
  const origin = request.headers.get('Origin');
  const cors = {
    'Access-Control-Allow-Origin': LP_ORIGINS.has(origin) ? origin : 'https://webinar.fintechcircle.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'public, max-age=60',
    Vary: 'Origin',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  let next;
  try {
    next = await findUpcomingBroadcast(env.WEBINARGEEK_API_KEY, env.WEBINAR_ID);
  } catch (err) {
    console.error('Upcoming broadcast lookup failed', err.message);
    return withCors(json({ broadcast_id: null, message: 'Upcoming broadcast unavailable', countdown_data: null, source: 'worker' }, 502), cors);
  }
  if (!next) return withCors(json({ broadcast_id: null, message: 'No upcoming broadcasts found', countdown_data: null, source: 'worker' }), cors);

  const seconds = Math.max(0, next.date - Date.now() / 1000);
  return withCors(json({
    broadcast_id: next.id,
    broadcast_data: {
      broadcast_id: next.id,
      date: next.date,
      has_ended: false,
      cancelled: false,
      webinar_title: next.title,
      readable_date: utcReadable(next.date),
      public_replay_link: next.public_replay_link,
      source: 'webinargeek',
    },
    countdown_data: {
      days: Math.floor(seconds / 86400),
      hours: Math.floor((seconds % 86400) / 3600),
      minutes: Math.floor((seconds % 3600) / 60),
      seconds: Math.floor(seconds % 60),
      total_seconds: seconds,
      formatted_time: utcReadable(next.date),
    },
    source: 'worker',
  }), cors);
}

function withCors(response, cors) {
  for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
  return response;
}
