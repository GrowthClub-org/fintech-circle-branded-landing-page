/* Automation Worker — replaces n8n.

   Every automation is one route. To add the next one, write a handler in
   src/automations/ and register it here. Handlers receive (request, env, ctx)
   and return a Response. */

import { handleWebinarGeekToGhl } from './automations/webinargeek-to-ghl.js';
import { summitFormHandler } from './automations/summit-forms.js';
import { handleWebsiteForm } from './automations/website-forms.js';
import { handleWebinarRegister } from './automations/webinar-register.js';
import { handleWebinarUpcoming } from './automations/webinar-upcoming.js';
import { json } from './lib/http.js';

const ROUTES = {
  'POST /webinargeek/ghl': handleWebinarGeekToGhl,
  'POST /summit/apply': summitFormHandler('apply'),
  'POST /summit/contact': summitFormHandler('contact'),
  'POST /website/form': handleWebsiteForm,
  'OPTIONS /website/form': handleWebsiteForm,
  'POST /webinar/register': handleWebinarRegister,
  'OPTIONS /webinar/register': handleWebinarRegister,
  'GET /webinar/upcoming': handleWebinarUpcoming,
  'OPTIONS /webinar/upcoming': handleWebinarUpcoming,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const key = request.method + ' ' + pathname.replace(/\/+$/, '');

    if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      return json({ ok: true, routes: Object.keys(ROUTES) });
    }

    const handler = ROUTES[key];
    if (!handler) return json({ ok: false, error: 'Not found' }, 404);

    try {
      return await handler(request, env, ctx);
    } catch (err) {
      console.error(key, 'failed:', (err && err.stack) || err);
      return json({ ok: false, error: 'Internal error' }, 500);
    }
  },
};
