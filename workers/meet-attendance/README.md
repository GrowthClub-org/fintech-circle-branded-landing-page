# Meet attendance Worker

Records whether applicants attended their Calendly calls, using Google Meet's
own attendance records. The outcome goes into the applicant's opportunity in
the GHL **Sales Call Pipeline**: **No Show** or **Call Completed**. Workflows
that start on those stages fire from there.

GHL's API refuses to change the status of appointments that come from Calendly
(*"Calendly calendars are not supported for this operation"*). So the
appointment itself stays "confirmed", and the opportunity stage shows what
happened.

This is a separate Worker (`fintech-meet-attendance`) from
[`growthclub-automations`](../automations/). They share nothing at runtime, so
a deploy of one can't break the other.

| Route | Purpose |
|---|---|
| `GET /oauth/google/start` | Susanne's one-time Google connection |
| `GET /oauth/google/callback` | Where Google sends her back (the OAuth redirect URI) |
| `GET /status` | Whether Google is connected and whether `DRY_RUN` is on |
| `GET /admin/report?days=35&offset=0&limit=6` | Read-only: what the check would decide for past calls. Needs `Authorization: Bearer <ADMIN_TOKEN>` |
| cron, every 15 min | The attendance check ([src/attendance.js](src/attendance.js)) |

---

## How a call is decided

1. GHL is asked for appointments on the Calendly calendars that ended at least
   15 minutes ago. Appointments that are cancelled, or already marked Showed or
   No Show by hand, are skipped. So are calls already decided, which the
   Worker remembers for 60 days.
2. The appointment holds Calendly's link
   (`https://calendly.com/events/<id>/google_meet`). Calendly redirects that link
   to the Meet room, `meet.google.com/abc-defg-hij`. Only the redirect is read.
3. Google Meet is asked who joined that room around the appointment time, and
   for how long, with their sessions added up.
4. Decision:

| What Meet recorded | Outcome | Checked |
|---|---|---|
| Someone other than Susanne was in the call for 5+ min | **Showed** | from 15 min after the end |
| Susanne joined; nobody else joined | **No Show** | 2 h after the end |
| No Meet record at all (nobody joined, or the call moved to phone or another link) | needs review | 2 h after the end |
| Someone else joined for under 5 min, the call was still running, or there was no Meet link | needs review | 2 h after the end |
| The check kept failing (Google or GHL errors) | needs review | 6 h after the end |

- **Showed / No Show:** the contact's Sales Call Pipeline opportunity moves to
  **Call Completed** or **No Show**, and a note with the evidence (who joined,
  for how long) is added to the contact.
  - Only an open opportunity still at *Call Booked* or *Call Reminder Sent*
    is moved. One at a later stage (Qualified, Won, Lost, …) is never moved
    back.
  - A contact with no opportunity in that pipeline gets a new one, created
    at the outcome stage.
- **AI note-takers** (Circleback, Otter, Fireflies, Fathom, Read.ai and
  similar) are ignored. An applicant's bot joining without them doesn't count
  as attending.
- **Needs review:** GHL is not changed, and an email goes to
  boards@fintechcircle.com. **A missing record is never treated as a no-show.**

Susanne is recognised by her Google account ID, taken from her connection. She
must join calls **signed in as susanne.chishti@fintechcircle.com**. If she
joins from another account, the Worker counts her as the applicant.

### Dry run

`DRY_RUN` in [wrangler.jsonc](wrangler.jsonc) is `"false"` (live). While it
is `"true"`, every decision is emailed as "[Dry run] Would mark …" and **GHL is never
changed**. Appointments decided during the dry run are not revisited later.

---

## Setup, in order

All of this was done on 28 October 2026 and the Worker is live at
**https://fintech-meet-attendance.boards.workers.dev**. The steps are kept
for reference, or for setting it up again.

### 1. Google: OAuth client (you)
Google Cloud → project *FINTECH Circle Meet Attendance* → **Google Auth
Platform → Clients → Create client**:
- Application type: **Web application**
- Name: `Meet attendance Worker`
- Authorized JavaScript origins: leave empty
- Authorized redirect URIs: exactly
  `https://fintech-meet-attendance.boards.workers.dev/oauth/google/callback`

Copy the **Client ID** into `GOOGLE_CLIENT_ID` in [wrangler.jsonc](wrangler.jsonc).
It isn't secret. Keep the **Client secret** for step 4. Don't paste it
anywhere else: not in chat, not in a file, not in email.

Under **Data access**, keep `.../auth/meetings.space.readonly`. The Worker also
asks for `openid` and `email`, which are basic, non-sensitive scopes. It uses
them to check that the account connecting is Susanne's.

### 2. GHL: Private Integration token and calendar ID (you)
- Settings → **Private Integrations** → edit the token that
  `growthclub-automations` already uses, and add the scopes
  `calendars/events.readonly`, `opportunities.readonly` and
  `opportunities.write` (it already has `contacts.write`). Both Workers use the same token value, so in step 4 you
  set the same value here. If GHL shows a new token value after you save,
  also update `GHL_PRIVATE_TOKEN` on `growthclub-automations`. Rotating or
  deleting this token later affects both Workers.
- **Done:** `GHL_CALENDAR_IDS` in [wrangler.jsonc](wrangler.jsonc) holds both
  calendars named *Your Board Positioning Journey Begins Today (Calendly) -
  Susanne Chishti* (`jbVJscIGsDKx5MeVDz2Z`, `qlFYdvf8Be69t5meGouK`). They don't
  appear under Calendar Settings, because the Calendly integration creates
  them. Each booking lands on both, so the Worker groups copies by their
  Calendly link, decides once, and sets the status on every copy. To see a
  contact's appointments and their calendar IDs, run
  `node scripts/show-appointments.js <contactId>` from this folder, with the
  token in `.dev.vars`.

### 3. Cloudflare: storage (you)
```sh
cd workers/meet-attendance
npm install
npx wrangler login
npx wrangler kv namespace create STATE
```
Paste the printed `id` into `kv_namespaces` in [wrangler.jsonc](wrangler.jsonc).

### 4. Secrets and deploy (you)
Each command asks for the value; paste it into the prompt.
```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET     # from step 1
npx wrangler secret put GHL_PRIVATE_TOKEN        # same token as growthclub-automations
npx wrangler secret put TOKEN_ENCRYPTION_KEY     # generate below
npm run deploy
```
To generate the encryption key, run this and paste the output straight into
the prompt:
```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
The deploy must print `https://fintech-meet-attendance.boards.workers.dev`. If
it prints anything else, the redirect URI in step 1 must change to match.

### 5. Susanne connects Google (Susanne, once)
Send her: **https://fintech-meet-attendance.boards.workers.dev/oauth/google/start**

She signs in as susanne.chishti@fintechcircle.com on Google's own page,
allows read access to Google Meet information, and sees "Google Meet
connected". She never shares a password, and nobody else sees the token.
Check that `/status` shows `"googleConnected": true`.

### 6. Test in dry run
Book two test calls through the Calendly link, using a non-FINTECH Circle email:
1. **Attended:** Susanne joins signed in, and the test person joins for 5+ min.
   About 15–30 min after the scheduled end, you should get "[Dry run] Would mark Showed".
2. **No-show:** Susanne joins alone and waits. About 2 h after the scheduled end,
   you should get "[Dry run] Would mark No Show".

### 7. Go live
1. Set `"DRY_RUN": "false"` in [wrangler.jsonc](wrangler.jsonc) and run `npm run deploy`.
2. Make sure the no-show follow-up workflow is published, and that it starts
   on **Pipeline Stage Changed → Sales Call Pipeline → No Show**. An
   "Appointment Status" trigger never fires, because the status can't be set.
3. After the first real no-show, confirm the opportunity is at *No Show*
   **and** the workflow ran (check the workflow's Execution Logs).

---

## If something breaks

- **Google connection revoked or expired:** you get one email a day with the
  link from step 5, and nothing in GHL changes. Susanne opens the link again.
  Appointments that are waiting are checked once she reconnects, if that's
  within 6 hours of their end. Older ones arrive as "needs review" emails.
- **Calendly changes its link:** the appointments arrive as "needs review"
  emails. The fix is to read the Meet link through Calendly's API instead,
  which needs a Calendly token.
- **Logs:** `npm run tail`, or Cloudflare → Workers → fintech-meet-attendance →
  Logs. Each decision is one line with the appointment, contact, outcome and
  reason. Tokens are never logged.

## Develop and test

```sh
npm test            # unit tests, no network
cp .dev.vars.example .dev.vars && npm run dev
# then open http://localhost:8787/__scheduled to run one check locally
```

## Data and privacy

- **Read from Google:** only Meet attendance (who joined and for how long) for
  meetings Susanne organises, through the read-only
  `meetings.space.readonly` scope.
- **Kept:** the outcome note in GHL, and for 60 days a "decided" marker per
  appointment ID. Participant lists are not stored anywhere else.
- **Not allowed:** under Google's API user data policy, this data must not be
  used for advertising, sold, or used to train AI models.
- **Privacy notice:** applicants should be told, for example in the privacy
  notice or the booking confirmation, that call attendance is recorded.
