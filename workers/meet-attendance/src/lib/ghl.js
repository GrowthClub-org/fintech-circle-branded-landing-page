/* Minimal GoHighLevel API v2 client for calendar appointments, authenticated
   with the Private Integration token shared with growthclub-automations.
   Scopes this Worker needs on it: calendars/events.readonly,
   contacts.write, opportunities.readonly, opportunities.write. */

const BASE = 'https://services.leadconnectorhq.com';
const CALENDAR_VERSION = '2021-04-15';
const CONTACT_VERSION = '2021-07-28';

export class GhlClient {
  constructor(token, locationId) {
    if (!token) throw new Error('GHL_PRIVATE_TOKEN is not set');
    if (!locationId || locationId === 'REPLACE_ME') throw new Error('GHL_LOCATION_ID is not set');
    this.token = token;
    this.locationId = locationId;
  }

  async request(method, path, body, version = CALENDAR_VERSION) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + this.token,
        Version: version,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  // Appointments on one calendar between two times (epoch milliseconds).
  async events(calendarId, fromMs, toMs) {
    const query = new URLSearchParams({
      locationId: this.locationId,
      calendarId,
      startTime: String(fromMs),
      endTime: String(toMs),
    });
    const data = await this.request('GET', '/calendars/events?' + query);
    return data.events || [];
  }

  // Appointment status can't be set here: GHL answers "Calendly calendars are
  // not supported for this operation". The opportunity records the outcome.

  addNote(contactId, body) {
    return this.request('POST', `/contacts/${contactId}/notes`, { body }, CONTACT_VERSION);
  }

  async opportunities(contactId) {
    const query = new URLSearchParams({ location_id: this.locationId, contact_id: contactId });
    const data = await this.request('GET', '/opportunities/search?' + query, undefined, CONTACT_VERSION);
    return data.opportunities || [];
  }

  moveOpportunity(id, pipelineId, pipelineStageId) {
    return this.request('PUT', `/opportunities/${id}`, { pipelineId, pipelineStageId }, CONTACT_VERSION);
  }

  createOpportunity({ contactId, name, pipelineId, pipelineStageId }) {
    return this.request('POST', '/opportunities/', {
      locationId: this.locationId, contactId, name, pipelineId, pipelineStageId,
      status: 'open', source: 'Meet attendance',
    }, CONTACT_VERSION);
  }
}
