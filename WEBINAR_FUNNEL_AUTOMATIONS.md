# Webinar Funnel Automations — Implementation Guide

**Part 1 of 4 — Automation A1: Registration Capture**
_Landing page → Webinar platform → Spreadsheet → CRM → Automation bus_

Written for an implementer setting this funnel up for a **new client** for the first
time. It assumes you can edit HTML and click around admin panels. It does not assume
you have seen this funnel before, and it does not assume the client uses the same
products as the last one.

Reference implementation: FINTECH Circle, built September 2026 (commit `11f4ce0`).

---

## 0. How to read this guide

### 0.1 Roles, not product names

Every client will use different products. So this guide talks about **roles**. Each
role is a job in the funnel; the product that fills it is swappable.

| Role | What it does | FINTECH Circle uses | Also commonly |
|---|---|---|---|
| **Landing page** | Collects the registration | Static `index.html` on a CDN | Webflow, WordPress, Framer, Next.js |
| **Webinar platform** | Hosts the live session, issues a **per-registrant join link** | WebinarGeek | Zoom Webinars, Demio, Livestorm, GoToWebinar |
| **Registration broker** | A small backend that holds the webinar platform's API key and registers people on the page's behalf | `broadcast.growthclub.org` | Any serverless function; or none, if the CRM registers directly |
| **Spreadsheet** | Human-readable record of every registrant | Google Sheets + Apps Script | Airtable, Notion, Excel/SharePoint |
| **CRM** | Owns the contact, fires the follow-up workflows | GoHighLevel (GHL) | HubSpot, ActiveCampaign, Salesforce, Klaviyo |
| **Automation bus** | Optional glue for anything the CRM cannot do | n8n | Make, Zapier, Workato |
| **Messaging channel** | Delivers confirmations and reminders | WhatsApp (via GHL) | Email, SMS, Telegram |

> **Rule:** when you swap a product, you are swapping a role. Everything else in this
> guide stays the same. Section 11 lists exactly what changes per product.

### 0.2 Conventions used below

- `code like this` = something you type, paste, or literally look for.
- **Bold step names** = a discrete click-path you must complete before the next one.
- ⚠️ = a step that has broken a real deployment. Do not skim these.
- Values you must replace per client are always written as `REPLACE_ME`.

### 0.3 The golden rule of this funnel

> **The webinar platform is the source of truth for the join link. The CRM is the
> source of truth for the contact. The spreadsheet is the source of truth for the
> humans.**

Every design decision below follows from that sentence. If you find yourself making
the spreadsheet drive a workflow, or the CRM invent a join link, stop and re-read it.

---

## 1. The funnel at a glance

| # | Automation | Trigger | Ends with | Status |
|---|---|---|---|---|
| **A1** | **Registration capture** | Visitor submits the form on the landing page | Registrant exists in webinar platform, spreadsheet, CRM and automation bus | **This document** |
| A2 | Confirmation & 24-hour window | Registrant taps "Message us on WhatsApp" on the thank-you page | Confirmation message with join link delivered | Documented in `WHATSAPP_GHL_AUTOMATION.md` |
| A3 | Reminder sequence | Time-based, relative to webinar start | Reminders at T-24h, T-1h, T-10m | Partly in `WHATSAPP_GHL_AUTOMATION.md` §Step 14 |
| A4 | Follow-up sequence | Time-based after the webinar ends, branched on attended or no-show | Replay link, resources and the next-step offer delivered; non-responders exit cleanly | Not yet documented |

This document covers **A1 only, in full**. A1 is the foundation: if it is wrong, every
later automation inherits bad data, and you will debug A3 for a week before realising
the problem was A1.

---

## 2. Automation A1 — what it does

One form submission fans out to **four destinations**. They are deliberately ranked,
because they do not have equal importance:

| Rank | Destination | Purpose | If it fails |
|---|---|---|---|
| 1 (blocking) | **Webinar platform**, via the registration broker | Creates the registrant, returns their unique join link | **Registration is aborted.** The visitor sees an error and stays on the page. Nothing else runs. |
| 2 | **CRM** (GHL) | Creates/updates the contact and starts the messaging workflows | Visitor still registered, but gets no confirmation message. Silent. |
| 3 | **Spreadsheet** (Google Sheets) | Human-readable log for the client | Visitor still registered. Row missing. Silent. |
| 4 | **Automation bus** (n8n) | Downstream glue, reporting, backups | Visitor still registered. Silent. |

⚠️ **Only rank 1 is blocking, and that is intentional.** A visitor must never be
blocked from registering because a spreadsheet was slow. But it also means ranks 2–4
fail *quietly* — nobody finds out unless you test them. Section 8 exists for this
reason.

---

## 3. Order of operations

This is the exact sequence, as implemented. The order matters and is not arbitrary.

```
Visitor clicks "Reserve My Seat"
  │
  ├─ 1. Validate the form
  │     • native HTML validation (checkValidity)
  │     • phone normalised to E.164, or left empty (it is optional)
  │     • abort and focus the bad field if either fails
  │
  ├─ 2. Button → loading state, disabled (stops double-clicks)
  │
  ├─ 3. GET the upcoming broadcast
  │     • returns broadcast_id, webinar title, Unix timestamp, readable date
  │     • failure here is NON-fatal: registration continues without webinar metadata
  │
  ├─ 4. POST the registration to the broker → webinar platform
  │     • ⛔ BLOCKING. Non-2xx or success:false aborts everything below.
  │     • returns the per-registrant watchLink
  │
  └─ on success only:
        │
        ├─ 5. POST to Google Sheets   (fire-and-forget, no-cors, not awaited)
        ├─ 6. POST to n8n             (fire-and-forget, not awaited)
        │
        ├─ 7. Fill the six off-screen CRM fields with values that only exist NOW
        │        (the join link did not exist before step 4 returned)
        │
        ├─ 8. form.requestSubmit()  → the CRM tracking script captures the form
        │        • exactly ONE submit event happens on this page, this is it
        │
        ├─ 9. Write registrationData + broadcastData to sessionStorage
        │        (the thank-you page reads these)
        │
        └─ 10. Wait 600 ms, then redirect to thank-you.html
                 • ⚠️ the delay is load-bearing, see Step 9 below
```

**Why the join link forces this shape:** the per-registrant join link does not exist
until the webinar platform has answered (step 4). So the CRM capture cannot happen on
the visitor's click — it must happen after, programmatically, which is the entire
reason for steps 7–10.

---

## 4. Prerequisites

Collect all of these from the client **before** you start. Missing any one of them
will stall you mid-build.

### From the client
- [ ] Webinar platform login, with permission to create webinars and read the API key
- [ ] CRM sub-account, with permission to create **custom fields** and **workflows**
- [ ] The Google account that will **own** the spreadsheet (not a personal account of
      someone who might leave the company)
- [ ] The client's **timezone** and **locale** (e.g. `Europe/London`, `en-GB`)
- [ ] The webinar's **title, date and time**, confirmed in writing
- [ ] Who receives failure notifications (an email address, ideally a shared inbox)

### From your own stack
- [ ] The registration broker configured with a `clientId` for this client (§5, Step 2)
- [ ] The landing page repo, deployable to a real HTTPS domain
- [ ] An automation bus instance, if the client is using one

### ⚠️ Do this first, before any testing
Create the **CRM custom fields** (§5, Step 6a). The CRM maps incoming form values by
matching the field key against the HTML input's `name`. If the field does not exist
when your first test submission arrives, the value is *captured but unmapped* — it
shows in the raw form data and is absent from the contact, and every message template
renders blank. This is the single most common way this build goes wrong.

---

## 5. Build steps

### Step 1 — Create the webinar on the webinar platform

**WebinarGeek (the reference implementation):**

1. Log in → **Webinars** → **New webinar** → choose **Live**.
2. Set title, date, time and duration. Set the timezone to the **client's** timezone,
   not yours.
3. **Registration → Registration form:** keep it to **Name** and **Email**. Do not add
   fields here. Your landing page is the form; this one is never seen by a visitor.
4. **Registration → Confirmation email:** decide with the client whether WebinarGeek
   sends its own confirmation email. If the CRM is also sending a confirmation, turn
   WebinarGeek's **off**, or the registrant gets two.
5. Note the **webinar ID**. Your broker needs it, or needs to be able to find it.

**Other platforms:** see §11.1. The only thing you need from any of them is:
a webinar identifier, an API credential, and a documented way to register someone and
get back a **unique per-registrant join link**.

⚠️ **Do not use the generic "join" URL** that the platform shows on the webinar's
overview page. That is the same for everyone. If you send it, the platform cannot tell
who attended, and your attendance-based follow-up (A3) has nothing to work with.

---

### Step 2 — Configure the registration broker

The broker is a small backend that holds the webinar platform's API key. It exists so
that the API key is **never in the landing page's source**, where every visitor could
read it.

1. Register a `clientId` for this client. It is a lowercase slug and it is permanent:
   `fintech-circle`, `acme-capital`, and so on.
2. Store the webinar platform credentials against that `clientId`.
3. Confirm both endpoints answer for the new `clientId`:

```bash
# Should return the upcoming webinar
curl "https://broadcast.growthclub.org/api/v1/broadcast/upcoming-broadcast?clientId=REPLACE_ME"

# Should create a registrant and return a watchLink
curl -X POST "https://broadcast.growthclub.org/api/v1/webinar/register" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"REPLACE_ME","name":"Test Person","email":"you+t1@example.com","terms":true}'
```

Do not move on until both work from the command line. Debugging a broker through a
browser form is far slower than debugging it with curl.

> **If the client has no broker:** you have two options. (a) Register through the CRM
> instead — many CRMs have a native webinar-platform integration; the landing page then
> only talks to the CRM. (b) Stand up a one-function proxy on Cloudflare Workers or
> Netlify Functions. What you must **not** do is put the webinar platform's API key in
> the page.

---

### Step 3 — Set the landing page configuration constants

Open `index.html` and find the config block near the top of the main `<script>`:

```js
const backendUrl = 'https://broadcast.growthclub.org';  // registration broker
const CLIENT_ID  = 'fintech-circle';                    // from Step 2

const GOOGLE_SHEETS_URL = 'https://script.google.com/macros/s/REPLACE_ME/exec';
const N8N_WEBHOOK_URL   = 'https://n8n.growthclub.org/webhook/REPLACE_ME';

// Left empty on purpose — the CRM is wired via form tracking, not a webhook.
// See Step 6 and §11.2.
const GHL_WEBHOOK_URL = '';
```

You will fill `GOOGLE_SHEETS_URL` in Step 5 and the CRM tracking id in Step 6. Set
`backendUrl` and `CLIENT_ID` now.

Also set the **countdown fallback date**, used only if the broker is unreachable:

```js
targetDate = new Date('2026-09-18T11:00:00Z').getTime(); // UTC; displayed in the client's timezone
```

And the **timezone**, used for the human-readable date and time sent to the CRM. It
appears in `formatWebinarDate()` and `formatWebinarTime()`:

```js
const tz = 'Europe/London';
```

⚠️ Change `tz` in **both** functions, and change the `en-GB` locale in the
`Intl.DateTimeFormat` calls if the client is not British. A US client wants
`en-US` / `America/New_York` and will expect `Friday, September 25, 2026` — which
means you also drop the ordinal-suffix helper. Confirm the format with the client in
writing; nobody notices a wrong date format until it is in a message to 400 people.

---

### Step 4 — Make the form markup capture-ready

The CRM's form-tracking script has three hard requirements. All three are easy to
violate with an otherwise perfectly good form.

**4a. Every input needs a `name`, not just an `id`.**

Hand-built forms often only carry `id`, because the JavaScript looks fields up by id.
The tracker reads `name`. No `name`, no capture.

```html
<input type="text"  id="name"    name="full_name" required>
<input type="email" id="email"   name="email"     required>
<input type="text"  id="company" name="company"   required>
```

**4b. Values that only exist after submit go in off-screen inputs.**

The join link cannot be typed by the visitor — it does not exist yet. It is written
into a field in step 7 of the sequence. ⚠️ **These cannot be `type="hidden"`; the
tracker skips hidden inputs entirely.** Park real text inputs off-screen:

```css
/* Off-screen, NOT display:none — the tracker only reads rendered fields */
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
</div>
```

`readonly`, `tabindex="-1"` and `aria-hidden` keep them out of the tab order and away
from screen readers, so the page stays accessible.

Verify in the browser console that each one is genuinely rendered:

```js
const el = document.getElementById('ghlWatchLink');
el.offsetParent !== null && el.getClientRects().length === 1;   // must be true
```

**4c. The submit button must be `type="button"`.**

⚠️ This is the step people miss, and it sends **duplicate messages to real customers**.

With `type="submit"` the tracker sees two submissions: the visitor's click (off-screen
fields still empty) and the programmatic one (fully populated). Both are captured, the
workflow fires twice, and the registrant gets two confirmations.

```html
<button type="button" class="cta-primary form-submit cta-button">Reserve My Seat</button>
```

A `type="button"` form loses two native behaviours. Put both back:

```js
// (1) Native validation no longer runs by itself
if (!registrationForm.checkValidity()) {
  registrationForm.reportValidity();
  return;
}

// (2) Enter-to-submit has to be restored explicitly
registrationForm.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  if (e.target.tagName !== 'INPUT' || e.target.type === 'hidden') return;

  // Skip controls that use Enter themselves (e.g. the country picker)
  const picker = document.getElementById('countryCombo');
  if (picker && picker.contains(e.target)) return;

  e.preventDefault();
  handleRegistration(e);
});

// (3) The only submit event on this page exists for the tracker. It never navigates.
registrationForm.addEventListener('submit', function (e) {
  e.preventDefault();
});
```

**4d. Phone numbers must be E.164.**

The CRM and WhatsApp both want `+447400123456` — no spaces, no punctuation, no
national trunk zero. The reference page has a country picker that normalises this and
shows the visitor what will be saved ("Will be saved as +447400123456").

The phone field is **optional** in the reference build. Read §9, issue 9 before
deciding whether to keep it optional for your client — it has consequences for
WhatsApp that are expensive to undo later.

---

### Step 5 — Google Sheets

**5a. Create the sheet**

1. Sign in as the account that will **own** the sheet long-term.
2. Create a spreadsheet: `CLIENT_NAME — Webinar Funnel`.
3. Share it with the client's team as needed. Ownership stays with the account in
   step 1.

**5b. Install the Apps Script**

1. In the sheet: **Extensions → Apps Script**.
2. Delete the placeholder `myFunction`.
3. Paste the entire contents of `google-sheets-script-enhanced.js` from this repo.
4. Set the notification recipient near the top of `sendApplicationNotification()` and
   `sendReplayNotification()` — it is `applications@fintechcircle.com` in the
   reference build.
5. **Save** (💾).

**5c. Deploy as a Web App**

1. **Deploy → New deployment** → gear icon → **Web app**.
2. Configure exactly:
   - **Description:** `CLIENT_NAME form handler v1`
   - **Execute as:** **Me** _(so the script can write to the sheet)_
   - **Who has access:** **Anyone** _(required — the visitor's browser is anonymous)_
3. **Deploy**, then **Authorize access**. Google will warn that the app is unverified:
   **Advanced → Go to (project name) → Allow**. This is expected for your own script.
4. Copy the **Web app URL**. It looks like
   `https://script.google.com/macros/s/AKfycb.../exec`.
5. Paste it into `GOOGLE_SHEETS_URL` in `index.html`.

⚠️ **Every time you edit the script you must redeploy**, and you must use
**Deploy → Manage deployments → edit → Version: New version**. Choosing
**New deployment** instead creates a *second* URL, leaves the old one live, and your
page keeps posting to the stale one. This has already happened in this repo:
`index.html` and `webinar-replay.html` currently point at **two different
deployments**. See §12.

⚠️ **The deployed script is the source of truth, not the file in this repo.** The
repo copy is a starting point that drifts. If you need to know what the live script
does, open the Apps Script editor.

**5d. Confirm the routing**

The script picks a sheet tab from the `formType` field in the payload:

| `formType` sent | Sheet tab used | Sent by |
|---|---|---|
| `application` | `Programme Applicants` | `application.html` |
| `replay` | `Replays` | `webinar-replay.html` |
| anything else (we send `registrant`) | `Registrants` | `index.html` |

The tab and its headers are created automatically on the first submission. You do not
need to pre-create them.

**5e. Registrants tab columns**

In this exact order, written by `prepareRegistrationRow()`:

| # | Column | Source |
|---|---|---|
| 1 | Timestamp | Browser, ISO 8601, UTC |
| 2 | Name | Form `full_name` |
| 3 | Email | Form `email` |
| 4 | Phone | Form phone, E.164, blank if not given |
| 5 | Company | Form `company` |
| 6 | Client ID | `CLIENT_ID` constant |
| 7 | Submitted From URL | `window.location.href` |
| 8 | Broadcast ID | Broker response |
| 9 | Webinar Title | Broker response |
| 10 | Webinar Date | Broker response, `readable_date` |
| 11 | Source | Literal `Landing Page Registration` |
| 12 | Processing Date | Apps Script server time |

Columns 1 and 12 differ by however long the round trip took. If column 12 is minutes
behind column 1, Apps Script is queuing — check the **Executions** log.

**5f. Menu tools**

Reload the sheet. A **FINTECH Circle Tools** menu appears (rename it in `onOpen()`
for a new client), offering: **Setup Spreadsheet**, **Create Summary Report**,
**Export for Mail Merge**, **View Execution Logs**.

---

### Step 6 — CRM (GoHighLevel)

**6a. Create the custom fields — before anything else**

CRM → **Settings → Custom Fields**, on the **Contact** object:

| Field key | Type | Holds |
|---|---|---|
| `readable_webinar_date` | **Text** | `Friday, 25th September 2026` |
| `readable_webinar_time` | **Text** | `11:00 AM BST` |
| `watch_link_webinargeek` | **Text** | The per-registrant join URL |

⚠️ Use **Text**, not Date and not URL. You are storing a formatted display string for
a message template, not a value for the CRM to calculate with. A Date field may reject
or silently reformat what you send.

⚠️ **The field key must match the HTML input's `name` attribute character for
character.** That string match *is* the mapping mechanism. `watch_link_webinargeek`
in the CRM and `name="watch_link_webinargeek"` in the form — identical.

Built-in fields (`full_name`, `first_name`, `last_name`, `email`, `phone`) map
automatically. You do not create those.

**6b. Install the tracking script**

CRM → **Settings → Business Profile → Tracking Code** (or **Sites → Tracking Code**,
depending on the CRM version). Copy the snippet. Paste it immediately before
`</body>` on **every page that has a tracked form**:

```html
<!-- CRM external form tracking -->
<script src="https://link.msgsndr.com/js/external-tracking.js"
  data-tracking-id="tk_REPLACE_ME"></script>
```

**6c. Why form tracking and not a webhook**

The obvious route is a workflow with an **Inbound Webhook** trigger. Check the cost
before you use it: in GHL it is a **premium trigger** and bills credits per execution.
External form tracking is a **standard, free** feature and does the same job for a
custom form.

| Route | Free | Notes |
|---|---|---|
| External form tracking | Yes | Used here. Keeps your own markup and design. |
| Embed a CRM-hosted form | Yes | Supported, but you inherit the CRM's styling. |
| Server-side proxy → CRM API | Yes | Most reliable. Needs somewhere to hold a token. |
| Inbound Webhook trigger | **No** | Premium trigger, charged per execution. |

⚠️ **Never call the CRM API directly from browser JavaScript.** The token would be
readable in page source by every visitor, granting full read/write on the client's CRM.

The webhook path is still present in `index.html` as an inert fallback: `sendToGHL()`
returns immediately while `GHL_WEBHOOK_URL` is empty. Leave it empty unless you have
deliberately chosen the webhook route.

**6d. Populate the fields, then fire one trusted submit**

Inside the success branch, after the broker has responded:

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

if (typeof registrationForm.requestSubmit === 'function') {
  registrationForm.requestSubmit();
} else {
  registrationForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
```

⚠️ **Use `requestSubmit()`, not `dispatchEvent()`.** `requestSubmit()` makes the
*browser* generate the submit event, so it carries `isTrusted: true`. A tracker that
ignores synthetic events still sees it. `dispatchEvent` produces `isTrusted: false`
and can be skipped.

**Name splitting.** Most hero forms ask for one "Full Name"; the CRM wants two fields:

```js
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}
```

This splits on the **first** space, so "Mary Anne Smith" becomes first `Mary`, last
`Anne Smith`. If the client's audience has compound first names and that matters, use
separate First/Last inputs on the form instead.

**6e. Verify the capture reached the contact**

CRM → **Contacts** → open the test contact → **Activity**. Two separate things to
check, and they are not the same thing:

- **Form Data** — everything the tracker captured. If a field is missing here, the
  problem is in the **form** (§4).
- **Mapped Fields** — what actually landed on the contact. If a field is in Form Data
  but not in Mapped Fields, the problem is the **custom field** (§6a): it does not
  exist, or its key does not match the input's `name`.

---

### Step 7 — Automation bus (n8n)

n8n receives the **same payload as the spreadsheet**, over a normal CORS-enabled
`fetch`. Use it for anything the CRM cannot do: a second CRM, Slack alerts, a backup
store, enrichment.

1. In n8n, create a workflow with a **Webhook** trigger, method **POST**.
2. Copy the **Production** URL (not the Test URL — the test URL only listens while you
   have the editor open, which is the single most common n8n mistake).
3. Paste it into `N8N_WEBHOOK_URL` in `index.html`.
4. Add a **Respond to Webhook** node returning `200` quickly, then do the slow work
   after it.

⚠️ n8n must return CORS headers, or the browser blocks the call. The `fetch` to n8n
is a real CORS request (unlike the Sheets call, which uses `mode: 'no-cors'`). In n8n,
set **Allowed Origins (CORS)** on the Webhook node to the landing page's domain.

If the client has no automation bus, set `N8N_WEBHOOK_URL = ''` and add the same
early-return guard that `sendToGHL()` uses. Do not leave a dead URL in place: it
produces a console error on every registration and masks real errors during support.

---

### Step 8 — Hand off to the thank-you page

Before redirecting, store what you know. Do not rely on whatever the broker happens to
echo back:

```js
sessionStorage.setItem('registrationData', JSON.stringify({
  ...result,
  name: name,
  email: email,
  company: company,
  ...(phone ? { phone: phone } : {})
}));

if (broadcastData) {
  sessionStorage.setItem('broadcastData', JSON.stringify(broadcastData));
}
```

`thank-you.html` reads these to fill the "Watch" button and build the WhatsApp
click-to-chat link. It falls back to `broadcastData.broadcast_data.public_replay_link`
if `registrationData.watchLink` is absent, so the button is never dead.

`sessionStorage` is per-tab and cleared when the tab closes. That is fine here: the
thank-you page is reached immediately, in the same tab. Do not use it to carry data
across a session boundary — for example, do not expect it to survive a payment
redirect to an external provider and back.

---

### Step 9 — Delay the redirect

```js
setTimeout(function () {
  window.location.href = 'thank-you.html';
}, 600);
```

⚠️ **This delay is load-bearing.** Navigating immediately cancels the tracking
script's in-flight outbound request. It fails *intermittently* — it works on your fast
laptop and drops maybe one registration in ten on a phone on mobile data. That is the
worst category of bug to diagnose three weeks later, so leave the delay in.

600 ms is the tested value. If you must reduce it, re-run the §8 test on a throttled
connection (DevTools → Network → **Slow 4G**) and confirm every capture still lands.

---

### Step 10 — Deploy and re-test on the real domain

Deploy the page to the client's **actual HTTPS domain** and run §8 again there.
`127.0.0.1` is accepted by the tracker, but domain rules, cookie behaviour and
attribution all differ between localhost and production. A funnel that passes locally
and fails live is common; the reverse never happens.

---

## 6. Data contracts

Exact payloads, for debugging and for anyone re-implementing the page.

### 6.1 Broker → page: upcoming broadcast

`GET {backendUrl}/api/v1/broadcast/upcoming-broadcast?clientId={CLIENT_ID}`

```jsonc
{
  "broadcast_id": "12345",
  "broadcast_data": {
    "webinar_title": "The Insider Roadmap to Access Top UK Fintech Board Seats in 2026",
    "date": 1758794400,                     // Unix seconds — the ONLY reliable time value
    "readable_date": "2026-09-25 10:00:00", // machine string; never show this to a human
    "public_replay_link": "https://..."     // generic fallback link
  }
}
```

⚠️ Always derive display strings from `date` (the Unix timestamp), never from
`readable_date`. The timestamp is unambiguous; the string carries no timezone and will
be an hour wrong across a daylight-saving boundary.

### 6.2 Page → broker: register

`POST {backendUrl}/api/v1/webinar/register`

```jsonc
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "submittedFromUrl": "https://client.com/index.html",
  "terms": true,             // implied by submitting the form
  "broadcastId": "12345",    // omitted if the broadcast fetch failed
  "clientId": "fintech-circle"
}
```

Response:

```jsonc
{ "success": true, "watchLink": "https://webinargeek.com/watch/unique-token" }
```

⚠️ Note what is **not** sent: **company and phone do not reach the webinar platform.**
They go to the spreadsheet and the CRM only. If the client asks "why doesn't
WebinarGeek have their phone number?", this is why. If they need it there, extend the
broker — do not quietly widen this payload without testing, since some platforms
reject unknown fields outright.

### 6.3 Page → Spreadsheet and Automation bus

Both receive the identical object:

```jsonc
{
  "formType": "registrant",
  "timestamp": "2026-09-22T09:14:03.221Z",
  "name": "Jane Smith",
  "email": "jane@example.com",
  "company": "Acme Ltd",
  "phone": "+447400123456",          // "" if not given
  "clientId": "fintech-circle",
  "submittedFromUrl": "https://client.com/index.html",
  "broadcastId": "12345",
  "webinarTitle": "...",
  "webinarDate": "2026-09-25 10:00:00",
  "source": "Landing Page Registration"
}
```

The Sheets call uses `mode: 'no-cors'`, which means **the browser will not let the
page read the response**. A `200` and a `500` are indistinguishable from the page.
This is a constraint of Apps Script Web Apps, not a bug — and it is why you check the
**Executions** log rather than the browser console when rows go missing.

### 6.4 Page → CRM (captured form fields)

| Input `name` | Maps to | Example |
|---|---|---|
| `full_name` | built-in Full Name | `Jane Smith` |
| `email` | built-in Email | `jane@example.com` |
| `company` | built-in Company Name | `Acme Ltd` |
| `first_name` | built-in First Name | `Jane` |
| `last_name` | built-in Last Name | `Smith` |
| `phone` | built-in Phone | `+447400123456` |
| `readable_webinar_date` | custom | `Friday, 25th September 2026` |
| `readable_webinar_time` | custom | `11:00 AM BST` |
| `watch_link_webinargeek` | custom | `https://webinargeek.com/watch/...` |

⚠️ **Empty values are omitted from the payload entirely.** A single-word name yields
an empty `last_name`; a blank optional phone yields an empty `phone`. The CRM drops
both from Form Data. This looks exactly like a capture bug and is not one. Always
test with a full name **and** a phone number, then separately without.

---

## 7. Failure behaviour

| What fails | Visitor sees | Data lands in | Silent? |
|---|---|---|---|
| Broadcast fetch (`GET`) | Nothing wrong | Everything, minus webinar title/date/time; CRM date fields blank | Console warning only |
| Registration (`POST`) non-2xx | `alert()`, button resets, stays on page | **Nothing anywhere** | No |
| Registration returns `success: false` | Same as above | **Nothing anywhere** | No |
| Google Sheets | Nothing wrong | Everything except the sheet row | **Yes** |
| n8n | Nothing wrong | Everything except n8n | **Yes** — console error only |
| CRM tracking script blocked (ad blocker) | Nothing wrong | Everything except the CRM | **Yes, completely** |
| Visitor closes the tab during the 600 ms delay | Nothing wrong | Webinar platform yes; CRM capture may be lost | **Yes** |

The last two are the reason to reconcile. **Weekly, compare the row count in the
`Registrants` tab against the contact count in the CRM.** A persistent gap means
captures are being lost, usually to ad blockers. If the gap is material for a given
client, move the CRM sync to the server-side proxy route (§11.2), which no browser
extension can block.

---

## 8. Test plan

Run all of it on the **live domain**. Tick every box before handing over.

**Test 1 — Complete registration (the happy path)**
1. Register with a **full name including a surname**, a real email and a **phone number**.
2. Webinar platform → registrants: the person is listed.
3. Spreadsheet → `Registrants`: a new row, all 12 columns populated.
4. n8n → Executions: one execution, payload matches §6.3.
5. CRM → the new contact → Activity:
   - **Form Data** lists **all nine** fields, not just the visible ones
   - **Mapped Fields** includes the three custom fields
   - `watch_link_webinargeek` holds a **real** URL, not a placeholder or blank
   - ⚠️ exactly **one** submission is recorded — two means §4c was skipped
6. Thank-you page: the Watch button's `href` is the per-registrant link.

**Test 2 — Minimal registration**

7. Register with a **single-word name** and **no phone**.
8. Confirm `last_name` and `phone` are simply **absent** from Form Data, and nothing
   errors. This is expected behaviour (§6.4).

**Test 3 — Uniqueness**

9. Compare the `watchLink` from Test 1 and Test 2. They must be **different**. If they
   are identical, the broker is handing out the generic link and per-registrant
   attendance tracking will not work (§5, Step 1).

**Test 4 — Interaction edge cases**

10. Press **Enter** inside the country picker: it must select a country, **not**
    register.
11. Press **Enter** inside the Email field: it **must** register.
12. Submit with Email empty: native validation blocks it and focuses the field.
13. Enter a malformed phone: the inline hint turns red and submission is blocked.

**Test 5 — Resilience**

14. DevTools → Network → **Slow 4G**, register again. Everything still lands.
15. Enable an ad blocker, register again. The registration still succeeds — only the
    CRM capture is lost. Confirms the fan-out is correctly non-blocking.

**Test 6 — Cleanup**

16. Delete every test registrant from the webinar platform, the CRM and the
    spreadsheet. ⚠️ Do this before the client looks. Test contacts left in a CRM get
    swept into a real campaign and are then genuinely difficult to remove.

---

## 9. Troubleshooting

Ordered by how likely you are to hit them.

**1. No rows appear in the spreadsheet.**
Check Apps Script → **Executions** first, not the browser. No execution at all → the
URL in `GOOGLE_SHEETS_URL` is wrong or points at an old deployment. Execution with an
error → read the message. Execution succeeded but no row → you are looking at the
wrong sheet tab, or the wrong spreadsheet (§5, Step 5d).

**2. Fields are captured by the CRM but do not reach the contact.**
Present in **Form Data**, absent from **Mapped Fields** = the custom field did not
exist when the submission arrived, or its key does not match the input's `name`. Fix
the field, then **submit again** — the CRM does not retroactively map old submissions.

**3. Message templates render blank where the date or link should be.**
Same root cause as 2. Check the merge tag spelling too: `{{contact.readable_webinar_date}}`.

**4. The registrant receives two confirmation messages.**
The submit button is still `type="submit"`. See §4c. Check the contact's Activity —
you will see two submissions, one with empty off-screen fields.

**5. `watch_link_webinargeek` is empty.**
The broker returned `success: true` without a `watchLink`. The page falls back to
`public_replay_link`; if that is also absent the field is empty. Check the broker's
response with the curl command in §5, Step 2.

**6. Nothing at all reaches the CRM.**
In order: (a) is the tracking script present before `</body>` on this page? (b) is
`data-tracking-id` the right sub-account? (c) is an ad blocker active? (d) are you on
the live domain? (e) open the Network tab and confirm a request to `msgsndr.com` fires
on submit.

**7. It works locally, not in production.**
Almost always mixed content or a CORS origin. Check that every URL is `https://`, and
that the n8n webhook's allowed origins include the production domain.

**8. Registration succeeds but the countdown shows the wrong date.**
The broadcast fetch failed and the page fell back to the hardcoded date (§5, Step 3).
The console logs `Using fallback countdown date`.

**9. A registrant's WhatsApp message creates a second, duplicate contact.**
Inbound WhatsApp is identified by **phone number**. A contact registered without one
cannot be matched, so the CRM creates a second, phone-only contact with no email. The
two share no field, so duplicate detection will not merge them. Options, in order of
preference: make the phone field **required**; collect it on the thank-you page and
submit it alongside the email so the CRM updates the existing contact; route
phone-less registrants to email instead; merge by hand. **Decide this before launch.**

**10. Pressing Enter inside the country picker registers instead of selecting.**
`preventDefault()` in the widget's key handler stops the *browser* acting, but not the
event *bubbling* to the form-level Enter listener. Call `stopPropagation()` on the
keys the widget handles, and have the form listener ignore events that originate
inside it (§4c).

**11. The submit button renders outside the form after an HTML edit.**
A stray `</div>` makes the parser close an ancestor early, re-parenting the button.
Submission may still work via the form-owner pointer, so it looks fine functionally
while rendering in the wrong place. Count `<div>` opens and closes after editing.

---

## 10. Per-client swap list

Everything client-specific, in one table. Work top to bottom for a new client.

| # | Value | Where | Reference value |
|---|---|---|---|
| 1 | Client ID | `CLIENT_ID` in `index.html` + broker config | `fintech-circle` |
| 2 | Broker URL | `backendUrl` | `https://broadcast.growthclub.org` |
| 3 | Sheets Web App URL | `GOOGLE_SHEETS_URL` | `https://script.google.com/macros/s/AKfycbx7.../exec` |
| 4 | n8n webhook URL | `N8N_WEBHOOK_URL` | `https://n8n.growthclub.org/webhook/4035665d-...` |
| 5 | CRM tracking id | `<script data-tracking-id>` | `tk_2e56d38ddaaa481ca49bd2dbae70ab7a` |
| 6 | Timezone | `tz` in both format functions | `Europe/London` |
| 7 | Locale | `Intl.DateTimeFormat` calls | `en-GB` |
| 8 | Date format | `formatWebinarDate()` | `Friday, 25th September 2026` |
| 9 | Countdown fallback date | `initializeCountdown()` | `2026-09-18T11:00:00Z` |
| 10 | Default dial code | country picker `value` | `+44` |
| 11 | Custom field keys | CRM + input `name` attributes | `watch_link_webinargeek` |
| 12 | Form identifier | `<form id>` — the CRM filters workflows on this | `registrationForm` |
| 13 | Notification recipient | Apps Script | `applications@fintechcircle.com` |
| 14 | Sheet menu name | `onOpen()` in Apps Script | `FINTECH Circle Tools` |
| 15 | WhatsApp number | `WHATSAPP_NUMBER` in `thank-you.html` | `447366234449` |
| 16 | Pre-filled message | `buildWhatsAppHref()` | "Hi Susanne, I've registered…" |

---

## 11. Platform variations

### 11.1 Webinar platform

What the funnel needs from **any** webinar platform: (a) register someone by name and
email via API, (b) get back a **unique per-registrant join link**, (c) ideally, read
attendance afterwards for A3.

| Platform | Per-registrant link | Notes |
|---|---|---|
| **WebinarGeek** (reference) | Yes | Broker returns it as `result.watchLink`. |
| **Zoom Webinars** | Yes — `join_url` from `POST /webinars/{id}/registrants` | ⚠️ Requires **registration enabled** on the webinar; without it there is no registrant API and every attendee shares one link. Uses Server-to-Server OAuth, so the broker must refresh tokens. |
| **Zoom Meetings** | **No** | Meetings have no registrant API. Do not use for this funnel — you lose per-person links and attendance. |
| **Demio** | Yes — `join_link` | Simple API key. Closest drop-in to WebinarGeek. |
| **Livestorm** | Yes — via `POST /sessions/{id}/people` | Response shape differs noticeably; budget time for mapping. |
| **GoToWebinar** | Yes — `joinUrl` | OAuth; the API is dated but stable. |
| **YouTube Live / a plain stream** | **No** | No registration concept at all. You must gate access yourself, e.g. a token in the thank-you page URL. Attendance tracking is not available. |

**What changes in the page when you swap platform:** exactly one line, the watch-link
lookup, plus its field name in the CRM.

```js
// WebinarGeek / current broker
const watchLink = result.watchLink || broadcastData?.broadcast_data?.public_replay_link || '';

// Zoom
const watchLink = result.join_url || '';

// Demio
const watchLink = result.join_link || '';
```

If you rename the CRM custom field from `watch_link_webinargeek` to something neutral
like `watch_link`, you must change it in **three** places: the CRM field key, the input's
`name` attribute, and every message template's merge tag. Doing it at the start of a
new client build is five minutes; doing it after launch means re-mapping live contacts.

### 11.2 CRM

| CRM | How the page reaches it | Cost | Notes |
|---|---|---|---|
| **GoHighLevel** (reference) | External form tracking script | Free | Inbound Webhook trigger is **premium** — avoid. |
| **HubSpot** | **Forms API** — `POST /submissions/v3/integration/submit/{portalId}/{formGuid}` | Free | Cleanest of all. Create a HubSpot form, never render it, post JSON to it. Also accepts the `hutk` cookie for attribution. Custom fields = HubSpot **contact properties**; the property's *internal name* must match your key. |
| **ActiveCampaign** | Hosted form URL, or API v3 from the broker | Free | Browser-side API calls are not safe — route through the broker. |
| **Salesforce** | Web-to-Lead endpoint, or API from the broker | Free | Web-to-Lead is a plain HTML POST: simple, but it gives no success response. |
| **Klaviyo** | Client-side `/client/subscriptions` with a public key | Free | The public key is safe in the page by design. Good fit for email-only funnels. |
| **Mailchimp** | Broker only | Free | No safe browser-side write path. |

**If the CRM has no form-tracking script** (everything except GHL, effectively), use
the **server-side proxy** shape instead — it is more reliable anyway:

```
Browser → /api/crm (your own domain)
        → CRM API upsert, token held as a server-side secret
        → add a tag
        → CRM workflow triggers on "Tag Added" (free in every CRM listed)
```

Advantages: the token is never exposed, it is same-origin so CORS does not arise, ad
blockers cannot stop it, and it completes even if the visitor closes the tab. With
this route you can delete §4b, §4c and Step 9 entirely — no off-screen fields, no
`type="button"` dance, no redirect delay.

⚠️ Whichever CRM: the three custom fields still have to exist **before** the first
submission, and the key still has to match exactly. That rule is universal.

### 11.3 Spreadsheet

| Product | How | Notes |
|---|---|---|
| **Google Sheets** (reference) | Apps Script Web App | Free, no auth needed in the page. ⚠️ `no-cors` means no error feedback. Quota is ~20,000 calls/day — irrelevant at webinar volumes. |
| **Airtable** | API from the broker | ⚠️ Never put an Airtable token in the page; it is account-wide. |
| **Notion** | API from the broker | Same warning. Slow API; write asynchronously. |
| **Excel / SharePoint** | Power Automate, "When an HTTP request is received" | Closest equivalent to the Apps Script pattern for Microsoft-only clients. |

### 11.4 Messaging channel

| Channel | Opt-in needed | Notes |
|---|---|---|
| **WhatsApp** (reference) | Customer must message **first** to open a 24-hour window | The whole reason for the click-to-chat button on the thank-you page. Full rules in `WHATSAPP_GHL_AUTOMATION.md`. |
| **Email** | Registration is sufficient consent for transactional mail | Simplest. No window, no templates, no per-message cost. |
| **SMS** | Explicit consent; regional rules vary | Needs the phone field to be **required**. |

---

## 12. Known issues and drift

Real state of this repo as of commit `11f4ce0`. Read before trusting a file.

1. **Two Apps Script deployments are live.** `index.html` posts to one Web App URL,
   `webinar-replay.html` posts to a different one. If both should write to the same
   spreadsheet, consolidate onto one deployment and update both pages.

2. **`INTEGRATION_SUMMARY.md` is stale.** It lists the broker as
   `https://api.revopstrack.com` (the live value is `https://broadcast.growthclub.org`)
   and its Registrants column list omits **Phone**. Trust `index.html` and
   `google-sheets-script-enhanced.js` over that file.

3. **The repo's Apps Script files are not the source of truth.** The deployed script
   lives in Google's cloud and is edited there. `google-sheets-script.js` and
   `google-sheets-script-enhanced.js` are starting templates that drift. Read the live
   script in the Apps Script editor before diagnosing sheet behaviour.

4. **The failure alert does not interpolate.** In `handleRegistration()`'s catch block
   the template placeholder sits inside single quotes, so a failed registration shows
   the literal text `Error: ${error.message}` rather than the reason. Cosmetic, but it
   wastes support time — the real error is always in the browser console.

5. **`google-sheets-script.js` (the basic version) is superseded.** Deploy
   `google-sheets-script-enhanced.js`; only it handles all three form types.

---

## Next in this series

- **Part 2 — A2: Confirmation and the 24-hour messaging window.** Largely written:
  see `WHATSAPP_GHL_AUTOMATION.md`.
- **Part 3 — A3: Reminder sequence,** including template categories and what each
  message costs inside and outside the window.
- **Part 4 — A4: Follow-up sequence.** What happens after the webinar ends: the
  attended and no-show branches, replay delivery, the next-step offer, and how
  non-responders exit the sequence.
