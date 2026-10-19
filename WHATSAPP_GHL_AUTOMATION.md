# WhatsApp Automation via GoHighLevel — Implementation Playbook

## Overview

This is a working, reusable recipe for connecting a **custom-built landing page** to
**GoHighLevel (GHL)**, so that a webinar registration creates a fully-populated contact
and a WhatsApp conversation can be automated from it.

It is written to be repeated for a different client. Everything client-specific is
listed in [Values to swap per client](#values-to-swap-per-client) at the end.

Built and verified for FINTECH Circle, September 2026.

### Why WhatsApp needs the customer to message first

WhatsApp does not let a business message someone freely. Sending is governed by a
**24-hour customer service window**, which opens when the *customer* sends a message.

That is the whole reason for the click-to-chat button on the thank-you page: the
registrant taps it, sends a pre-filled message, and that opens the window your
automation replies into.

### Data flow

```
Registration form (your page)
   │  1. POST to the webinar platform (WebinarGeek) → returns per-registrant watch link
   │  2. Fill off-screen fields with the watch link + webinar date/time
   │  3. Fire ONE trusted submit → GHL's tracking script captures the form
   ▼
GHL contact created, custom fields mapped
   │
   ▼
Thank-you page: "Message Us on WhatsApp" → wa.me link, pre-filled message
   │
   ▼
Registrant sends message → 24-hour window opens
   │
   ▼
GHL workflow replies: confirmation, then reminders
```

### Why external form tracking, not an Inbound Webhook

The obvious route is a GHL workflow with an **Inbound Webhook** trigger. Do not use it
unless you have checked the cost: it is a **premium trigger** and bills credits per
execution.

**GHL external form tracking is a standard, free feature** and does the same job for a
custom form. The rest of this document uses it.

Other free routes, if external form tracking does not suit:

| Route | Free | Notes |
|---|---|---|
| External form tracking | Yes | Used here. Keeps your own form markup and design. |
| Embed a GHL form | Yes | Fully supported, but you inherit GHL's styling. |
| Server-side proxy → GHL API v2 | Yes | Most reliable. Needs somewhere to keep a token (see [Fallback](#fallback-server-side-proxy)). |
| Inbound Webhook trigger | **No** | Premium trigger, charged per execution. |

> Never call the GHL API directly from browser JavaScript. The token would be readable
> in page source by every visitor, granting full read/write on the CRM.

---

## What you need before starting

- A GHL sub-account with WhatsApp connected
- The GHL **external tracking script** for that sub-account
  (Settings → the tracking code with `data-tracking-id="tk_..."`)
- Permission to create **custom fields** in GHL
- The client's **WhatsApp Business number** in international format, digits only
- Whatever the webinar platform returns as a per-registrant join link

---

## Part 1: GHL setup

### Step 1: Create the custom fields first

**Do this before any testing.** GHL's auto-matching works against *existing* custom
fields — if the field does not exist when a submission arrives, the value is captured
but left unmapped, and your message templates render empty.

Create these on the **Contact** object (Settings → Custom Fields):

| Field key | Type | Holds |
|---|---|---|
| `readable_webinar_date` | Text | `Friday, 25th September 2026` |
| `readable_webinar_time` | Text | `11:00 AM BST` |
| `watch_link_webinargeek` | Text | Per-registrant join URL |
| `webinar_broadcast_date` | Text | `2026-09-25 11:00:00` — machine-readable, for date maths in workflows |

Use **Text**, not Date. You are sending a formatted display string for use in a
message, not a date for GHL to calculate with — a Date field may reject or reformat it.

The **unique key must exactly match the HTML `name` attribute** of the corresponding
form input. That string match is how auto-mapping works.

### Step 2: Add the tracking script to the site

Immediately before `</body>` on every page with a tracked form:

```html
<!-- GoHighLevel external form tracking -->
<script src="https://link.msgsndr.com/js/external-tracking.js"
  data-tracking-id="tk_REPLACE_ME"></script>
```

Requirements the tracker imposes, all of which shape Part 2:

- A real `<form>` element (not an iframe, not a third-party widget)
- Inputs must have **`name` attributes** — `id` alone is invisible to it
- Fields must be **rendered**. `type="hidden"` inputs are skipped entirely.

---

## Part 2: The registration form

### Step 3: Give every field a `name`

Hand-built forms often only carry `id`, because the JavaScript looks fields up by id.
The tracker reads `name`. Without it, nothing is captured.

```html
<input type="text"  id="name"    name="full_name" required>
<input type="email" id="email"   name="email"     required>
<input type="text"  id="company" name="company"   required>
```

Standard fields (`full_name`, `email`, `first_name`, `last_name`, `phone`) auto-map to
built-in GHL contact fields. Custom ones map to the fields created in Step 1.

### Step 4: Add off-screen fields for values known only after submit

The per-registrant watch link does not exist until the webinar platform has responded,
so it cannot be typed by the user. It is written into a field just before the tracked
submit.

**These cannot be `type="hidden"` — the tracker ignores those.** Use ordinary text
inputs parked off-screen:

```css
/* Off-screen, not display:none - GHL's tracker only reads rendered fields */
.offscreen-fields {
  position: absolute;
  left: -9999px;
  top: 0;
  width: 1px;
  height: 1px;
  overflow: hidden;
}
```

```html
<div class="offscreen-fields" aria-hidden="true">
  <input type="text" name="first_name"             id="ghlFirstName"   tabindex="-1" readonly autocomplete="off">
  <input type="text" name="last_name"              id="ghlLastName"    tabindex="-1" readonly autocomplete="off">
  <input type="text" name="phone"                  id="ghlPhone"       tabindex="-1" readonly autocomplete="off">
  <input type="text" name="readable_webinar_date"  id="ghlWebinarDate" tabindex="-1" readonly autocomplete="off">
  <input type="text" name="readable_webinar_time"  id="ghlWebinarTime" tabindex="-1" readonly autocomplete="off">
  <input type="text" name="watch_link_webinargeek" id="ghlWatchLink"   tabindex="-1" readonly autocomplete="off">
  <input type="text" name="webinar_broadcast_date" id="ghlBroadcastDate" tabindex="-1" readonly autocomplete="off">
</div>
```

`readonly`, `tabindex="-1"` and `aria-hidden` keep them out of the tab order and away
from screen readers. Verify with `offsetParent !== null` and
`getClientRects().length === 1` — both must hold, or the tracker will skip them.

### Step 5: Make the submit button `type="button"`

This is the step people miss, and it causes **duplicate messages to real customers**.

With `type="submit"`, the tracker sees **two** submissions:

1. The user's click, with the off-screen fields still empty
2. The programmatic one, fully populated

Both are captured, so the workflow fires twice and the registrant gets the confirmation
WhatsApp twice.

Change the button to `type="button"` and drive registration from a click handler. The
only submit event on the page is then the populated one.

A `type="button"` form loses two native behaviours, so restore both:

```js
// Native validation no longer runs on its own
if (!form.checkValidity()) {
  form.reportValidity();
  return;
}
```

```js
// Enter-to-submit has to be put back explicitly
form.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  if (e.target.tagName !== 'INPUT' || e.target.type === 'hidden') return;

  // Skip controls that use Enter themselves, e.g. a country picker
  const picker = document.getElementById('countryCombo');
  if (picker && picker.contains(e.target)) return;

  e.preventDefault();
  handleRegistration(e);
});
```

```js
// Exists only so the tracker can read the form - never to navigate
form.addEventListener('submit', function (e) {
  e.preventDefault();
});
```

### Step 6: Populate, then fire one trusted submit

Inside the success branch, once the platform has responded:

```js
const registrantName = splitName(name);
const webinarUnix = broadcastData?.broadcast_data?.date || null;

// Fall back so the message never goes out with an empty join link
const watchLink = result.watchLink
  || broadcastData?.broadcast_data?.public_replay_link
  || '';

document.getElementById('ghlFirstName').value   = registrantName.first;
document.getElementById('ghlLastName').value    = registrantName.last;
document.getElementById('ghlPhone').value       = phone;
document.getElementById('ghlWebinarDate').value = formatWebinarDate(webinarUnix);
document.getElementById('ghlWebinarTime').value = formatWebinarTime(webinarUnix);
document.getElementById('ghlWatchLink').value   = watchLink;
document.getElementById('ghlBroadcastDate').value = formatWebinarBroadcastDate(webinarUnix);

if (typeof form.requestSubmit === 'function') {
  form.requestSubmit();
} else {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
```

**Use `requestSubmit()`, not `dispatchEvent`.** `requestSubmit()` makes the *browser*
generate the submit event, so it carries `isTrusted: true`. A tracker that ignores
synthetic events still sees it. `dispatchEvent` produces `isTrusted: false`.

### Step 7: Delay the redirect

Navigating immediately cancels the tracker's outbound request. This fails
*intermittently* rather than obviously — the worst kind of bug to diagnose later.

```js
setTimeout(function () {
  window.location.href = 'thank-you.html';
}, 600);
```

### Step 8: Format dates for humans, in the client's timezone

Webinar APIs usually return a Unix timestamp and a machine string like
`2026-09-25 10:00:00`. Neither belongs in a WhatsApp message. Derive the display
strings from the **timestamp**, not the string, so daylight saving is handled:

```js
function ordinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function formatWebinarDate(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const tz = 'Europe/London';
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: tz }).format(d);
  const day = Number(new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: tz }).format(d));
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: tz }).format(d);
  const year = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: tz }).format(d);
  return weekday + ', ' + day + ordinalSuffix(day) + ' ' + month + ' ' + year;
}

function formatWebinarTime(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const tz = 'Europe/London';
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz
  }).format(d).toUpperCase();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short', timeZone: tz }).formatToParts(d);
  const zone = (parts.find(part => part.type === 'timeZoneName') || {}).value || '';
  return (clock + ' ' + zone).replace(/\s+/g, ' ').trim();
}
```

Produces `Friday, 25th September 2026` and `11:00 AM BST`, switching to `GMT`
automatically in winter. Change the `tz` constant for a client in another region.

For a machine-readable copy (date maths in workflows, sorting, or a Date-typed custom
field), add a third formatter. `hourCycle: 'h23'` matters — without it midnight comes
out as `24:00:00` in some engines:

```js
function formatWebinarBroadcastDate(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: 'Europe/London'
  }).formatToParts(d).reduce(function (acc, part) {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' +
    parts.hour + ':' + parts.minute + ':' + parts.second;
}
```

Produces `2026-09-25 11:00:00`. Build it in the **same timezone as the display
fields**, or the stored value will disagree with the time the registrant was shown —
the webinar API often returns UTC, which is an hour out from BST.

### Step 9: Split the name

GHL wants first and last names. Most hero forms ask for one "Full Name":

```js
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}
```

This splits on the first space, so compound first names land in the last name. If that
matters to the client, use separate First/Last inputs instead.

### Step 10: Send the phone in E.164

WhatsApp and GHL both want `+447400123456` — no spaces, no national trunk prefix.
If the form has a country selector, combine and normalise before sending:

```js
// National input: drop punctuation and the leading trunk zero, prepend the dial code
let digits = digitsOf(countryDialCode) + input.replace(/\D/g, '').replace(/^0+/, '');

// Input that already starts with "+": trust it, do not prepend anything
if (input.charAt(0) === '+') digits = digitsOf(input);

const phone = '+' + digits;
```

---

## Part 3: The thank-you page — opening the 24-hour window

### Step 11: Click-to-chat with a pre-filled message

Replace any "join our WhatsApp group" link with a one-to-one chat link. A group does
not open a service window; a direct message does.

```html
<div class="step-card" id="whatsappStep">
  <h3>Message Us on WhatsApp</h3>
  <p>Send us a message and we will reply with your join link and resources.</p>
  <a href="#" id="whatsappLink" target="_blank" rel="noopener">Message Us on WhatsApp</a>
</div>
```

```js
// International format, digits only. No +, spaces or dashes.
const WHATSAPP_NUMBER = '447366234449';

// Include the email only when no phone was captured - see Pitfall 8
const INCLUDE_EMAIL_REFERENCE = true;

function buildWhatsAppHref(reg) {
  const opening = 'Hi Susanne, I’ve registered for the Board Briefing.';
  const ask = ' Please send me my join link and resources.';
  const needsReference = INCLUDE_EMAIL_REFERENCE && reg && reg.email && !reg.phone;
  const ref = needsReference ? ' (' + reg.email + ')' : '';
  return 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(opening + ref + ask);
}

document.addEventListener('DOMContentLoaded', function () {
  const reg = JSON.parse(sessionStorage.getItem('registrationData'));
  const step = document.getElementById('whatsappStep');
  const link = document.getElementById('whatsappLink');

  if (WHATSAPP_NUMBER) {
    link.href = buildWhatsAppHref(reg);
  } else if (step) {
    // Hide rather than render a dead button if the number is not configured yet
    step.style.display = 'none';
  }
});
```

Hiding the card while the number is unset means the page is safe to deploy before the
client has supplied it.

### Step 12: Carry the registrant's details across pages

The thank-you page needs the email to personalise the message. Store what you know,
rather than relying on whatever the registration API happens to echo back:

```js
sessionStorage.setItem('registrationData', JSON.stringify({
  ...result,
  name: name,
  email: email,
  company: company,
  ...(phone ? { phone: phone } : {})
}));
```

---

## Part 4: GHL workflows

### Step 13: Confirmation

- **Trigger:** Form Submission (free) — filter to the external form by its identifier,
  which is the `<form>` element's `id`
- **Action:** Send WhatsApp message

The window is open because the registrant messaged first, so this can be a **free-form
message** rather than an approved template.

Template used for FINTECH Circle:

```
Dear {{contact.first_name}}, your place is confirmed for the Board Briefing.

*The Insider Roadmap to Access Top UK Fintech Board Seats in 2026*
{{contact.readable_webinar_date}}, {{contact.readable_webinar_time}} · 60 minutes

Join the Board Briefing here:
{{contact.watch_link_webinargeek}}

Best regards, Susanne
Reply 'STOP' to end receiving communications
```

### Step 14: Reminders — read this before planning the schedule

The most common and expensive misunderstanding:

> "The customer messaged us, so we can send anything free for 24 hours."

Only partly true, and the gap is where budgets break:

| What you send | Inside the 24h window | Outside it |
|---|---|---|
| Free-form message | Free | Not permitted |
| **Utility** template | Free | Charged |
| **Marketing** template | **Charged** | Charged |

Two consequences:

1. **The window runs 24 hours from the customer's *last* message**, not from
   registration. If the webinar is a week away, your 1-day reminder is far outside it
   and must be a template.
2. **Word reminders as utility, not promotion.** "Your session starts tomorrow, here is
   your link" is utility. "Don't miss this amazing opportunity" is marketing, and is
   charged even inside an open window.

Marketing templates also require documented opt-in — add a consent checkbox to the
registration form if you plan to send any.

> WhatsApp pricing and category rules change regularly. Confirm current rates and
> categories in the client's Meta Business account before quoting costs.

---

## Pitfalls

Each of these cost real debugging time. They are listed in the order you are likely to
hit them.

**1. Inbound Webhook is a premium trigger.**
Use external form tracking instead. See [Why external form tracking](#why-external-form-tracking-not-an-inbound-webhook).

**2. Inputs with only `id` are invisible.**
The tracker reads `name`. A form built for JavaScript often has neither.

**3. `type="hidden"` fields are never captured.**
Symptom: visible fields arrive, hidden ones are absent from `Form Data` entirely. Use
off-screen rendered inputs (Step 4).

**4. Capture is not the same as mapping.**
A field can appear in `Form Data` and still be missing from `Mapped Fields`, which means
it never reached the contact and merge tags render empty. Almost always because the
custom field did not exist, or its key does not match the input's `name` exactly.

**5. Two captures per registration.**
Caused by leaving the button as `type="submit"`. Fires the workflow twice and sends the
customer two WhatsApp messages. See Step 5.

**6. `dispatchEvent` produces an untrusted event.**
Use `requestSubmit()` so the browser generates it. See Step 6.

**7. Redirecting too fast silently drops the capture.**
Delay ~600ms. See Step 7.

**8. Empty values are omitted from the payload.**
A single-word name yields an empty `last_name`, and a blank optional phone yields an
empty `phone` — GHL drops both from `Form Data`. This looks like a bug and is not.
Always test with a full name *and* a phone number.

**9. An optional phone field breaks WhatsApp matching.**
Inbound WhatsApp is identified by phone number. A contact registered without one cannot
be matched, so GHL creates a **second, phone-only contact** with no email. The two share
no field, so GHL's duplicate detection will not merge them and workflows cannot merge
contacts. Options: make phone required; collect it on the thank-you page and submit it
with the email so GHL updates the existing contact; route phone-less registrants to
email instead; or merge by hand.

**10. Enter inside a custom dropdown can trigger registration.**
If the page has a combobox (e.g. a country picker), `preventDefault()` in its key
handler stops the *browser* acting but not the event *bubbling* to a form-level
Enter-to-submit listener. Call `stopPropagation()` on the keys the widget handles, and
have the form listener ignore events originating inside it. See Step 5.

**11. A stray `</div>` can silently re-parent the submit button.**
The HTML parser resolves an unmatched closing tag by closing an ancestor early, which
can move the button outside the `<form>`. Submission may still work via the form owner
pointer, so it looks fine functionally while rendering in the wrong place. Check that
`<div>` open and close counts match after editing markup.

---

## Testing checklist

Test on the **live domain** as well as locally — `127.0.0.1` is accepted by the tracker,
but domain rules and attribution can differ.

1. Register with a **full name including a surname** and a **phone number**
2. In GHL → Contacts → the new contact → Activity, check:
   - `Form Data` lists **all** fields, not just the visible ones
   - `Mapped Fields` includes the custom fields, not just `full_name` / `email`
   - `watch_link_webinargeek` holds a real join URL, not a placeholder
   - Only **one** submission was recorded for the registration
3. Register a second time **without** a phone — confirm `phone` and `last_name` are
   simply absent rather than causing an error
4. Tap the WhatsApp button on the thank-you page; check the pre-filled message and that
   the conversation lands in GHL
5. Confirm the workflow fires **once** and the confirmation renders date, time and join
   link — no empty merge tags
6. If the form has a country picker, type a country name and press **Enter**: it must
   select the country, not submit the form

---

## Fallback: server-side proxy

If external form tracking cannot capture the form — a framework that never emits a real
submit event, a widget-based form, an iframe — proxy through a small server-side
function instead. On Cloudflare Workers, Netlify Functions or similar:

```
Browser → /api/ghl (your own domain)
        → GHL API v2 contact upsert, token held as a server-side secret
        → add a tag
        → GHL workflow triggers on "Tag Added" (a free trigger)
```

Advantages: the token is never exposed, it is same-origin so CORS does not arise, and it
completes even if the visitor closes the tab. GHL API calls themselves are free — only
premium *workflow* actions are charged.

---

## Values to swap per client

| Value | Where | Example |
|---|---|---|
| GHL tracking id | `<script data-tracking-id>` | `tk_2e56d38ddaaa481ca49bd2dbae70ab7a` |
| WhatsApp number | `WHATSAPP_NUMBER` | `447366234449` |
| Pre-filled message | `buildWhatsAppHref()` | "Hi Susanne, I've registered…" |
| Timezone | `formatWebinarDate` / `formatWebinarTime` | `Europe/London` |
| Locale | `Intl.DateTimeFormat` calls | `en-GB` |
| Custom field keys | GHL + input `name` attributes | `readable_webinar_date` |
| Form identifier | `<form id>` | `registrationForm` |
| Webinar platform field | watch link lookup | `result.watchLink` |

---

## Reference implementation

| File | Contains |
|---|---|
| `index.html` | Registration form, off-screen fields, date formatting, tracked submit |
| `thank-you.html` | WhatsApp click-to-chat |

Relevant commits, newest first:

```
a6ce296  Remove the GHL tracking diagnostic log now that mapping works
19f6e70  Stop Enter in the country picker registering, and drop the email reference
6207d59  Render the GHL tracking fields off-screen instead of type=hidden
99195b7  Wire GHL external form tracking into the registration form
bd108e9  Send registrations straight to GHL via an inbound webhook (fallback, inert)
24ff536  Set the WhatsApp Business number for the thank-you page click-to-chat
5f0907a  Replace the WhatsApp group link with click-to-chat on the thank-you page
```

`bd108e9` is the unused webhook path, left in place and inert (`GHL_WEBHOOK_URL` empty)
as a ready-made fallback.
