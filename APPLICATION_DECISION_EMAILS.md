# Application Decision Emails — replacing the n8n workflow

## What this replaces

The n8n workflow was: *sheet updated → read the status → send the acceptance or
rejection email.* That workflow depended on n8n being up. This does the same job
**inside the spreadsheet itself**, using Google Apps Script.

| | n8n workflow | This |
|---|---|---|
| Where it runs | n8n server | Google's servers, attached to the sheet |
| Trigger | Polls / webhook from Sheets | Native `onEdit` trigger + hourly sweep |
| Cost | Server hosting | Free |
| Fails when | n8n is down | Google Sheets is down |
| Who maintains it | Whoever owns the n8n box | Nobody |

There is already an Apps Script project on this spreadsheet
(`google-sheets-script-enhanced.js` — it is what writes the `Programme Applicants`
tab when someone applies). The decision mailer goes into that same project.

---

## How it works

```
Susanne sets a row's Approval (column Q) to "Accepted" or "Rejected"
   │
   ▼
onEdit trigger fires (installed, not simple — a simple one cannot send mail)
   │
   ├─ Wrong tab, header row, or a different column edited?  → ignore
   ├─ Value is not accept/reject (blank, "Pending")?         → ignore
   ├─ Email Status (column R) already filled?                → ignore (no duplicates)
   │
   ▼
Send the matching email via Gmail, BCC the team
   │
   ▼
Write "accepted — sent 24/09/2026, 14:02" into Email Status
```

An **hourly sweep** re-scans the tab for rows that have a decision but no logged
send, and catches anything the edit trigger missed — a trigger that did not fire, a
day that ran out of send quota, a transient Gmail error. That is what makes this as
dependable as the polling n8n was doing.

---

## Setup

**1. Open the script**

In the spreadsheet: **Extensions → Apps Script**.

**2. Add a NEW file — do not replace the existing one**

In the editor's **Files** panel, click **+ → Script**, name it `DecisionEmails`, and
paste the entire contents of `google-sheets-decision-emails.js` from this repo.
**Save.**

Leave `Code.gs` (the existing `google-sheets-script-enhanced.js`) untouched apart
from the one `onOpen()` change in step 10. Apps Script runs every file in the project
as one shared program, so the two files see each other's functions — there is no
import to write.

No function name in `DecisionEmails` collides with one in `Code.gs`. Two functions
with the same name in one project silently overwrite each other, so if you ever add
more code, check the names first. In particular **do not add a second `onOpen()`** —
edit the existing one.

> ⚠️ The deployed script is the source of truth, not the repo copy. If the two ever
> disagree, believe the Apps Script editor.

**3. Set the configuration**

Edit the `DECISION_CONFIG` block at the top:

| Key | What to set it to | Already correct? |
|---|---|---|
| `sheetName` | The tab Susanne reviews | ✅ `Programme Applicants` |
| `decisionHeaders` | Header of the decision column | ✅ `['Approval', 'Decision']` |
| `logHeader` | Header of the audit column | ✅ `Email Status` |
| `treatAnyLogValueAsSent` | Leave `true` — see below | ✅ |
| `replyTo` | Where applicant replies should land | ✏️ check |
| `bcc` | Team address that keeps a copy. `''` to switch off | ✏️ check |
| `adminEmail` | Who gets told when a send fails | ✏️ check |
| `nextStepUrl` | The link in the acceptance email | ✏️ **set this** |

Both columns are found **by header name**, not by letter. That matters: inserting a
column to the left of Q shifts the `Approval` header and its data across together, so
the lookup still lands on the right cells. (`decisionColumn: 'Q'` pins it to a fixed
letter instead, if the header is ever removed.)

`Application Status` is deliberately *not* in `decisionHeaders`. That column is the
machine's triage at submission time; Q is the human decision. Only Q sends email.

**4. Write the actual copy**

`getAcceptanceEmail()` and `getRejectionEmail()` hold placeholder copy. Replace it
with Susanne's wording before going live. `{{first_name}}`, `{{last_name}}`,
`{{full_name}}` and `{{next_step_url}}` are substituted at send time.

**5. Proof the emails**

Run `previewDecisionEmails` from the editor's function dropdown. Both emails arrive
in your own inbox. No applicant is touched and nothing is logged.

**6. ⚠️ Back-fill the history — before the triggers exist**

Run `backfillDecisionLog()`.

The sheet already holds applications Susanne decided during the n8n era. To this
script those look like rows with a decision in Q and nothing in R — in other words,
unsent. **The first hourly sweep would email the entire back catalogue again.**

`backfillDecisionLog()` stamps every already-decided row as handled and sends nothing.
It reports how many rows it marked, and skips any row whose `Email Status` is already
filled. Run it before step 7, not after.

The same danger is why `treatAnyLogValueAsSent` is `true`: whatever n8n may have
written into `Email Status` counts as "already handled", whatever its wording.

**7. Install the triggers**

Sign in as **the account the emails should come from** — the from-address is always
the account that installs the trigger, and cannot be set in code. Then run
`installDecisionTrigger` once and authorise it (Google will warn the app is
unverified: **Advanced → Go to project → Allow**).

Re-running it is safe; it removes the old triggers first.

**8. Add the dropdown (optional but recommended)**

Run `installDecisionDropdown`. The decision column becomes a
Pending / Accepted / Rejected dropdown, so a typo can never leave an applicant in
limbo. The script also accepts `Accept`, `Approved`, `Reject`, `Declined` and
similar, case-insensitively.

**9. Test end to end**

Put your own email in a spare row, set its decision to `Accepted`, and watch the
email arrive and the `Email Status` column fill in. Then clear that row.

---

## The column layout

This is the live header row of `Programme Applicants`:

| Col | Header | Written by |
|---|---|---|
| A–K | Timestamp … Future Cohort Month | `prepareApplicationRow()` on submission |
| L | Pricing Tier | `prepareApplicationRow()` |
| M–N | Client ID, Submitted From URL | `prepareApplicationRow()` |
| **O** | Application Status | `determineApplicationStatus()` — **auto-triage**, `Pre-Qualified` / `Under Review` / `Not Qualified` |
| P | Processing Date | `prepareApplicationRow()` |
| **Q** | **Approval** | **Susanne, by hand** — the only column that triggers an email |
| **R** | **Email Status** | This script's audit trail |

`getApplicationHeaders()` in `Code.gs` must match A–P of this table exactly. `doPost`
only writes a header row when the tab is **empty**, so on a live sheet a mismatch is
never corrected — the code just starts writing every new row one column out of step
with the headers and with all the history.

Q and R sit past what `doPost` writes, so form submissions never touch them.

### Adding a field later

Insert the column **in the sheet first** — which shifts the existing data across with
it, keeping history aligned — then add it at the matching position in *both*
`getApplicationHeaders()` and `prepareApplicationRow()`. Appending at the end of the
arrays is not safe here: `appendRow()` writes outward from column A, so a 17th value
would land in Q and overwrite the Approval column.

Keeping O and Q separate is right: O is what the machine guessed at submission time,
Q is what Susanne decided. The mailer only ever reads Q, so the auto-triage in O can
never trigger an email by itself.

---

## ⚠️ Never run "Setup Spreadsheet" again

`setupSpreadsheet()` in `Code.gs` calls `setupSheet()`, which begins with
`sheet.clear()`. Running it from the **FINTECH Circle Tools** menu wipes every row of
the `Programme Applicants`, `Registrants` and `Replays` tabs — including columns P, Q
and R, which it does not know about and will not recreate.

It exists to initialise an empty spreadsheet. On a live sheet it is a data-loss
button. Consider removing that menu item from `onOpen()` now that the sheet holds
real applications and decisions.

---

## Things worth knowing

**Duplicate sends are prevented by the `Email Status` column (R).** Do not edit or
delete that column by hand. To deliberately re-send, select the row and use
**Resend Decision for Selected Row** from the menu (see step 10 below), or clear that
one cell.

**Changing a decision does not re-send, by default.** With
`treatAnyLogValueAsSent: true`, any value in `Email Status` means "handled" — so
flipping a row from Accepted to Rejected sends nothing. This is the safe default
because it also protects every row the old n8n workflow already emailed.

Set it to `false` to make a changed decision send the new email. Run
`backfillDecisionLog()` first: without it, historical rows whose `Email Status`
wording does not match the new format would all be re-sent.

**Send quota.** A consumer Gmail account can send 100 emails/day via Apps Script; a
Google Workspace account 1,500/day. If the quota runs out mid-batch, the row is
marked `FAILED` and the hourly sweep retries it the next day. For application volumes
this is not a real constraint.

**The installable trigger does not fire for changes made by scripts or the Sheets
API** — only for a person editing. Susanne editing by hand, in the browser or the
mobile app, fires it. The hourly sweep covers anything else.

**Failures are never silent.** A failed send writes `FAILED — <reason>` into the log
column and emails `adminEmail`.

**10. Menu items.** Replace the existing `onOpen()` in `Code.gs` with this. Do not add
a second `onOpen()` in `DecisionEmails` — only one would ever run.

```javascript
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FINTECH Circle Tools')
    .addItem('Create Summary Report', 'createSummaryReport')
    .addItem('Export for Mail Merge', 'exportForMailMerge')
    .addSeparator()
    .addItem('Preview Decision Emails', 'previewDecisionEmails')
    .addItem('Resend Decision for Selected Row', 'resendDecisionForSelectedRow')
    .addItem('Install Decision Dropdown', 'installDecisionDropdown')
    .addSeparator()
    .addItem('View Execution Logs', 'viewLogs')
    .addToUi();
}
```

Note that **Setup Spreadsheet** is gone from this version — see the data-loss warning
above. `setupSpreadsheet()` itself is left in the file so it can still be run
deliberately from the editor when setting up a new client's sheet.

---

## The email signature and its banner

`SIGNATURE_CONFIG` holds Susanne's sign-off block. It is appended to both emails by
`sendDecisionEmail()`, so it is defined once and the two templates cannot drift apart.

The **Fintech for Good banner is sent as an inline image**, not a hotlink. That matters:
most mail clients block remote `<img>` by default, so a hotlinked banner shows as a
broken box until the reader clicks "display images". An inline image is a real
attachment referenced by `cid:`, and renders straight away.

To switch it on:

1. Save the banner as a file — right-click it in Susanne's Gmail signature → **Save
   image as**, or take it from fintechcircle.com.
2. Upload it to **Google Drive**, in the Drive of the account that runs the script.
3. Open it and copy the id out of the URL —
   `drive.google.com/file/d/`**`THIS_PART`**`/view`.
4. Paste that into `bannerDriveFileId`.

Then run `previewDecisionEmails()` and check the banner renders in your inbox.

| Setting | Effect |
|---|---|
| `bannerDriveFileId` set | Inline image. **Use this.** |
| Blank, `bannerUrl` set | Hotlinked image — blocked by default in many clients |
| Both blank | Signature sends without the banner; text and links still appear |

If the Drive fetch ever fails, the error is logged and the email still goes out
without the banner — a missing image never blocks a decision email. The banner is
fetched **once per execution**, so an hourly sweep sending forty emails hits Drive
once, not forty times.

---

## Deploying vs saving — they are not the same thing

Apps Script runs your code two different ways, and only one of them cares about
deployments:

| Runs from | Uses which code | Needs a deploy? |
|---|---|---|
| `doPost` — the Web App the landing pages POST to | The **deployed version**, frozen at deploy time | **Yes** |
| `onApplicationDecision`, `sweepPendingDecisions` — triggers | The **latest saved** code | **No** |
| Menu items and anything run from the editor | The **latest saved** code | **No** |

So: **the decision mailer needs no deployment at all.** Save the file, run
`installDecisionTrigger()`, done.

**Changes to `doPost` or anything it calls — `prepareApplicationRow()`,
`getApplicationHeaders()`, `determineApplicationStatus()` — do need a deploy**, or the
live form keeps writing rows the old way.

**Deploy → Manage deployments → pencil icon → Version: New version → Deploy.**

⚠️ Do **not** use **Deploy → New deployment**. That mints a second URL, leaves the old
one live, and the pages keep posting to the stale one. This has already happened in
this project:

| Page | Web App URL |
|---|---|
| `index.html`, `application.html`, `application-future.html` | `AKfycbx7ByoZ…` |
| `webinar-replay.html` | `AKfycbyGWFvn…` |

The application form posts to `AKfycbx7ByoZ…`, so **that is the deployment to update**
for the Pricing Tier change. The replay deployment is stale but harmless here —
`prepareReplayRow()` is unchanged. Worth consolidating onto one deployment separately.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing happens on edit | Triggers not installed, or installed on a different account. Check **Apps Script → Triggers**. |
| `No decision column found` | `decisionColumn` is blank *and* row 1 has no matching header. Set `decisionColumn: 'Q'`. |
| Emails fire off the wrong column | A column was inserted left of Q, shifting the decision data. Update `decisionColumn`, or switch to header lookup (step 3). |
| Email sent from the wrong address | The trigger was installed by that account. Delete the triggers, sign in as the right account, run `installDecisionTrigger` again. |
| Sends once then never again | The row's log cell already records that decision. Expected — that is the duplicate guard. |
| Applicant says it landed in spam | Expected for a plain Gmail send with links. Either warm it up, or route through the CRM instead (below). |

Execution history lives in **Apps Script → Executions**. Every run, every error.

---

## Alternative: send through GoHighLevel instead

If you would rather the emails came from the CRM — branded templates, open tracking,
better deliverability, and the contact record updated in the same step — keep the
same trigger and swap only `sendDecisionEmail()`:

1. In GHL, create a contact custom field `programme_decision` (**Text**).
2. Build two GHL workflows triggered on that field changing to `accepted` /
   `rejected`, each sending the relevant email template.
3. In the Apps Script, replace the `GmailApp.sendEmail(...)` call with a
   `UrlFetchApp.fetch()` to the GHL API v2 contact upsert, setting
   `programme_decision`. Hold the token in **Project Settings → Script Properties**,
   never in the code.

⚠️ Do not use a GHL **Inbound Webhook** trigger for this — it is a premium trigger
billed per execution. See `WHATSAPP_GHL_AUTOMATION.md` §"Why external form tracking,
not an Inbound Webhook". A field-change trigger on a contact is free.

This is more moving parts than sending from Gmail. Start with Gmail; move to GHL if
deliverability or branding turns out to matter.

---

## Other options considered

| Option | Verdict |
|---|---|
| **Apps Script (this)** | ✅ Free, lives with the data, no server. |
| Self-host n8n again | Same failure mode you just hit. |
| n8n Cloud | Works, ~€20/mo, still an external dependency for one small job. |
| Zapier / Make | Works, but the free tiers poll every 15 min and Sheets triggers burn tasks fast. |
| GHL alone | GHL cannot watch a Google Sheet without a paid webhook trigger. |
