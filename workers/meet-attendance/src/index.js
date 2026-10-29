/* Meet attendance Worker: marks Calendly calls in GHL as Showed or No Show
   from Google Meet's attendance records. See README.md.

   fetch:     Susanne's one-time Google connection, plus a status page.
   scheduled: the attendance check (src/attendance.js), every 15 minutes. */

import { startAuth, finishAuth, loadConnection } from './lib/google.js';
import { runCheck, pastCallsReport } from './attendance.js';
import { json } from './lib/http.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const path = pathname.replace(/\/+$/, '') || '/';
    if (request.method !== 'GET') return json({ ok: false, error: 'Not found' }, 404);

    try {
      if (path === '/' || path === '/health') {
        return json({ ok: true, routes: ['GET /oauth/google/start', 'GET /oauth/google/callback', 'GET /status', 'GET /admin/report'] });
      }
      if (path === '/oauth/google/start') return await startAuth(request, env);
      if (path === '/oauth/google/callback') {
        const { status, message } = await finishAuth(request, env);
        return page(status, message);
      }
      // Public, so it says only whether Google is connected: no account, no token.
      if (path === '/status') {
        const connection = await loadConnection(env);
        return json({
          ok: true,
          googleConnected: Boolean(connection),
          connectedAt: connection ? connection.connectedAt : null,
          dryRun: String(env.DRY_RUN).toLowerCase() !== 'false',
        });
      }
      // Read-only report of past calls (names and attendance), so it needs ADMIN_TOKEN.
      if (path === '/admin/report') {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
        const params = new URL(request.url).searchParams;
        const number = (key, fallback, max) => Math.min(max, Math.max(0, Number(params.get(key)) || fallback));
        return json({ ok: true, ...await pastCallsReport(env, {
          days: number('days', 35, 60), offset: number('offset', 0, 1000), limit: number('limit', 6, 10),
        }) });
      }
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (err) {
      console.error(path, 'failed:', (err && err.stack) || err);
      return json({ ok: false, error: 'Internal error' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCheck(env, { now: controller.scheduledTime }).catch(err => {
      console.error('Attendance check failed:', (err && err.stack) || err);
    }));
  },
};

function isAdmin(request, env) {
  const expected = String(env.ADMIN_TOKEN || '');
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (expected.length < 32 || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function page(status, message) {
  const safe = String(message).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FINTECH Circle · Google Meet connection</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.4rem">${status === 200 ? 'Google Meet connected' : 'Not connected'}</h1>
<p>${safe}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}
