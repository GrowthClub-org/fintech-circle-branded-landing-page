# Automations Worker (replaces n8n)

A single Cloudflare Worker that hosts all our automations. Each automation is one
route, registered in [src/index.js](src/index.js).

| Route | Automation | Source |
|---|---|---|
| `POST /webinargeek/ghl` | WebinarGeek → GoHighLevel | [src/automations/webinargeek-to-ghl.js](src/automations/webinargeek-to-ghl.js) |
| `POST /summit/apply` | Summit site application form → GHL, tag `Summit_Attendee` | [src/automations/summit-forms.js](src/automations/summit-forms.js) |
| `POST /summit/contact` | Summit site contact form → GHL, tag `Summit_ContactUs` | [src/automations/summit-forms.js](src/automations/summit-forms.js) |
| `POST /website/form` | Every fintechcircle.com form → GHL + email to boards@fintechcircle.com | [src/automations/website-forms.js](src/automations/website-forms.js) |
| `GET /health` | Lists the routes | — |

---

## Automation 1 — WebinarGeek → GHL

WebinarGeek sends a webhook for each registration, viewer, no-show and
unsubscribe. The Worker checks the signature, upserts the contact in GHL
(matched on email), fills the webinar custom fields and sets **state tags**.
GHL workflows start on **Contact Tag added**, which is a free trigger. The
premium Inbound Webhook trigger isn't needed.

The Worker reads the state from the subscription data, not from the event
name. Any event brings GHL fully up to date, and a retried webhook produces
the same result.

### Tags

| Tag | Added when | Removed when |
|---|---|---|
| `webinar registrant` | Any event for an active registrant | They unsubscribe |
| `webinar attended` | They watched in any form, live or replay | They register for a new webinar |
| `live webinar watched` | They watched the live broadcast | They register for a new webinar |
| `watched webinar replay` | They watched the replay | They register for a new webinar |
| `live webinar not watched` | The broadcast has ended and they did not watch live | They register for a new webinar |
| `webinar unsubscribed` | They unsubscribe | They register for a new webinar |
| `clicked webinar CTA` | They click a call-to-action during the webinar | They register for a new webinar |

When someone registers again, the post-webinar tags are cleared. The next
webinar then adds them again, and their workflows fire again. GHL only fires
"tag added" when the tag was not already on the contact.

A no-show who later watches the replay gets `webinar attended` and
`watched webinar replay` while keeping `live webinar not watched`. Use that in the A4
follow-up to stop the no-show sequence.

### Custom fields written

Existing fields, which the landing page already fills:
`watch_link_webinargeek`, `readable_webinar_date`, `readable_webinar_time`,
`webinar_broadcast_date`. They use the same format as `index.html` (Europe/London).
People who register directly on WebinarGeek get the same fields too.

Fields filled only by the Worker (Contact object, type **Text**):

| Field key | Holds |
|---|---|
| `webinar_title_webinargeek` | Webinar title |
| `minutes_viewing_time_webinargeek` | Minutes watched live |
| `cta_clicked` | `yes` once they click a call-to-action |
| `cta_clicked_time` | Time of their latest click, e.g. `16-10-2026 12:30:00 +0100` |
| `minutes_viewing_time_replay_webinargeek` | Minutes of the replay watched |

If a field is missing in GHL, the Worker skips it and logs a warning. It does
not fail. Phone numbers are only sent when they are valid E.164, because GHL
rejects the whole upsert on a bad number. The number that the landing page
captured is never overwritten or blanked.

---

## Automation 2 — Summit website forms → GHL

summit.fintechcircle.com (built in Lovable) has two forms. After the site saves
a submission, its server posts the same data here as JSON, with the shared
secret in the `X-Webhook-Secret` header. The Worker creates or updates the GHL
contact (matched on email) and adds the form's tag.

| Form | Route | Tag | GHL fields |
|---|---|---|---|
| Request Your Place (`/apply`) | `POST /summit/apply` | `Summit_Attendee` | first and last name, `job_title`, `company`, `role`, `linkedin_profile_url`, `enquiry_message` (notes) |
| Contact the Summit Team (`/contact`) | `POST /summit/contact` | `Summit_ContactUs` | name, `organisation`, `enquiry_topic` (subject), `enquiry_message` |

Both also set `form_type` (`summit-apply` or `summit-contact`),
`form_submitted_from_url` and source `Summit Website`.

The secret is `SUMMIT_FORM_SECRET`. The same value must be stored as a secret
in the Lovable project. The call is made from the site's server, never the
browser, so the secret is not visible to visitors.

Response codes: `200` synced, `400` no valid email, `401` wrong or missing
secret, `502` GHL rejected the call.

---

## Automation 3 — fintechcircle.com forms → GHL + email

Every form on fintechcircle.com (contact, newsletter, and the enquiry forms on
the service pages) posts its fields as JSON from the browser to
`POST /website/form`, with `formType` and `submitted_from_url` added. Only
requests from `https://fintechcircle.com` and `https://www.fintechcircle.com`
are accepted (CORS and an Origin check).

Each submission:
1. creates or updates the GHL contact (matched on email), fills the matching
   fields and `form_type` / `form_submitted_from_url`, and adds the whole
   submission as a **note**, since fields only hold the latest one. No tags.
2. emails `NOTIFY_TO` (boards@fintechcircle.com) from `NOTIFY_FROM`
   (forms@fintechcirclepro.com) through Cloudflare Email Routing, with
   Reply-To set to the person who submitted.

The two run independently. The visitor sees an error only if both fail.

| Form field | GHL field |
|---|---|
| `firstName`, `lastName`, `email` | Standard contact fields |
| `topic` | `enquiry_topic` |
| `message`, `question`, `group` | `enquiry_message` |
| `company` / `organisation` | `company` / `organisation` |
| `linkedin` | `linkedin_profile_url` |
| `investorType`, `revenue`, `target` | `investor_type`, `revenue`, `target` |

Email sending needs the recipient to be a verified Email Routing destination on
the Cloudflare account, and the sender's domain to have Email Routing enabled.

---

## Setup

### 1. GHL: Private Integration token
Settings → **Private Integrations** → Create. Scopes:
`contacts.write`, `contacts.readonly`, `locations/customFields.readonly`.
Copy the token (`pit-...`). Also copy the **Location ID** (Settings → Business Profile).

### 2. Deploy the Worker
```sh
cd workers/automations
npm install
npx wrangler login
# put the Location ID into wrangler.jsonc → vars.GHL_LOCATION_ID
npx wrangler secret put GHL_PRIVATE_TOKEN
npx wrangler secret put WEBINARGEEK_WEBHOOK_SECRET   # from step 3
npm run deploy
```
The deploy prints the URL, for example `https://growthclub-automations.<account>.workers.dev`.
To use a custom domain such as `automations.growthclub.org`, add it under
Workers → Settings → Domains & Routes.

### 3. WebinarGeek: webhook
Settings → Integrations → **Webhooks** → New webhook:
- URL: `https://<worker-url>/webinargeek/ghl`
- Events: New registration, Unsubscribed, New viewer, New live viewer,
  New replay viewer, No show
- **Secret**: WebinarGeek doesn't generate one. Enter your own long random
  string here, and use the same value for `WEBINARGEEK_WEBHOOK_SECRET`.

### 4. GHL: workflows
Start each workflow with a **Contact Tag added** trigger that uses one of the
tags above. For example, `live webinar not watched` starts the replay-link sequence.

---

## Develop and test

```sh
npm test            # unit tests, no network
cp .dev.vars.example .dev.vars && npm run dev   # local server on :8787
npm run tail        # live logs from production
```

In production, every run logs a line to **Workers → Logs**, with the event, the
email, the GHL contact ID and the tags.

Response codes:
- `200`: synced, or ignored because the payload is not a subscription or has no email.
- `401`: bad signature.
- `502`: GHL rejected the call. The log has GHL's error text.

## Adding the next automation
1. Create `src/automations/<name>.js` and export a `(request, env, ctx) => Response` handler.
2. Register it in `ROUTES` in `src/index.js`.
3. Add any secrets with `wrangler secret put` and list them in `.dev.vars.example`.
