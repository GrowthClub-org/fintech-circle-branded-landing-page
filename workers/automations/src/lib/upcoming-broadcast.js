/* The next session of a WebinarGeek webinar that people can register for.

   Only published episodes count, so a draft session is never picked, and only
   the configured webinar is searched (no account-wide fallback). The result is
   cached in memory for a minute, so a busy page does not hit WebinarGeek on
   every load. */

const API = 'https://app.webinargeek.com/api/v2';
const TTL_MS = 60 * 1000;
let cache = { key: '', at: 0, value: null };

export async function findUpcomingBroadcast(apiKey, webinarId, now = Date.now()) {
  const key = `${webinarId}`;
  if (cache.key === key && now - cache.at < TTL_MS && cache.value) return cache.value;

  const res = await fetch(`${API}/webinars/${webinarId}`, { headers: { 'Api-Token': apiKey, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`WebinarGeek ${res.status} on webinar ${webinarId}: ${(await res.text()).slice(0, 200)}`);
  const value = pickUpcoming(await res.json(), now);
  cache = { key, at: now, value };
  return value;
}

/* Pure: earliest broadcast that is in the future, not ended, not cancelled,
   in a published episode. Returns null when there is none. */
export function pickUpcoming(webinar, now = Date.now()) {
  const candidates = [];
  for (const episode of (webinar && webinar.episodes) || []) {
    if (episode.published !== true) continue;
    for (const b of episode.broadcasts || []) {
      if (!b.date || b.date * 1000 <= now || b.has_ended || b.cancelled) continue;
      candidates.push({ broadcast: b, episode });
    }
  }
  candidates.sort((a, b) => a.broadcast.date - b.broadcast.date);
  const next = candidates[0];
  if (!next) return null;
  return {
    id: next.broadcast.id,
    date: next.broadcast.date,
    title: next.episode.title || webinar.title || null,
    public_replay_link: next.broadcast.public_replay_link || null,
  };
}

export function clearUpcomingCache() {
  cache = { key: '', at: 0, value: null };
}

// "2026-11-20 11:00:00" in UTC, the backend's readable_date format.
export function utcReadable(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
