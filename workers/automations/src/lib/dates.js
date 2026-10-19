/* Same output as formatWebinarDate / formatWebinarTime / formatWebinarBroadcastDate
   in index.html, so a contact looks identical in GHL whether it arrived through
   the landing page or through WebinarGeek. Keep the two in step. */

function ordinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

export function formatWebinarDate(unixSeconds, tz) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: tz }).format(d);
  const day = Number(new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: tz }).format(d));
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: tz }).format(d);
  const year = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: tz }).format(d);
  return weekday + ', ' + day + ordinalSuffix(day) + ' ' + month + ' ' + year;
}

export function formatWebinarTime(unixSeconds, tz) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(d).toUpperCase();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short', timeZone: tz }).formatToParts(d);
  const zone = (parts.find(part => part.type === 'timeZoneName') || {}).value || '';
  return (clock + ' ' + zone).replace(/\s+/g, ' ').trim();
}

/* "25-09-2026 11:00:00 +0100" — the format already stored in the
   *_webinargeek fields (broadcast_date, email_verified_at, ...). */
export function formatTimestamp(unixSeconds, tz) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const p = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: tz, timeZoneName: 'longOffset',
  }).formatToParts(d).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  // "GMT+01:00" → "+0100"; plain "GMT" → "+0000"
  const m = /([+-])(\d{2}):?(\d{2})/.exec(p.timeZoneName || '');
  const offset = m ? m[1] + m[2] + m[3] : '+0000';
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second} ${offset}`;
}

export function formatWebinarBroadcastDate(unixSeconds, tz) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const p = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: tz,
  }).formatToParts(d).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}
