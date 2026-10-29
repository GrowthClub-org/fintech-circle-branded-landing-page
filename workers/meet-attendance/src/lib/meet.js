/* Read-only Google Meet REST API v2 client: conference records, their
   participants and each participant's sessions. Needs the
   meetings.space.readonly scope, and only sees meetings Susanne organises. */

const BASE = 'https://meet.googleapis.com/v2/';
const MEETING_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export class MeetClient {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  async get(path, params = {}) {
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + this.accessToken, Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Meet GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  // Follows nextPageToken until every item is in.
  async all(path, key, params = {}) {
    const items = [];
    let pageToken;
    do {
      const data = await this.get(path, { ...params, pageSize: '100', pageToken });
      items.push(...(data[key] || []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return items;
  }

  conferences(meetingCode) {
    if (!MEETING_CODE.test(meetingCode)) throw new Error(`Not a Meet code: ${meetingCode}`);
    return this.all('conferenceRecords', 'conferenceRecords', { filter: `space.meeting_code = "${meetingCode}"` });
  }

  participants(conference) {
    return this.all(conference.name + '/participants', 'participants');
  }

  sessions(participant) {
    return this.all(participant.name + '/participantSessions', 'participantSessions');
  }
}
