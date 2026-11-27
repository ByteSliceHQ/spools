# Campaigns

Campaigns are durable email sequences defined in `crm.config.json` (see the
[reference](configuration.md#campaigns)): a few emails with waits between them.
Each record that is enrolled has one row in the database saying which email is
next and when it is due, so a three-week sequence survives deploys and
restarts, and runs the same on a server and on a serverless host.

## Enrolling records

Add an action with `"run": "campaign:<key>"` to the campaign's object, or an
automation such as `{ "on": "contacts.created", "run": "campaign:onboarding" }`.
A record can be enrolled in a campaign only once; repeat clicks do nothing.

Every enrollment, send and skip is written to the record's activity timeline.

## With record scopes

In a Spool with [record scopes](security.md#record-scopes), an enrolment (a row in
`sequence_runs`) belongs to its record's scope.

- **Enrolling is a change to the record.** Someone who only reads a record can't enroll it,
  and isn't offered the action; nobody can enroll a record they can't reach.
- **Counts and lists of runs** are of the scopes the reader holds.
- **Sending.** The tick has nobody signed in. It finds what is due as the system, then sends
  each email with the reach of that run's own scope and nothing more: it reads that record,
  and writes on that record's timeline.
- **Held runs.** A run with no scope is not sent. That is a run enrolled before scopes were
  turned on: nothing says whose record it is for, and sending it as the system would be a
  way round the scopes. Held runs are left out of what a tick takes, so however many there
  are, and however long they have been due, they never stand in the way of a run that can be
  sent. The log says how many were held, each tick (counted up to a thousand). Run
  `bun run db:scopes` (`spools scopes backfill`) and they go out at the next tick; a run
  whose record is gone, or has no scope itself, stays held.
- **A record that moves scope** takes its runs with it.
- Suppression (unsubscribes, bounces, complaints) is by address and is the whole
  business's, whatever the scope: an address that unsubscribed is never emailed again.

## Sending

Email goes through [Resend](https://resend.com). Set `RESEND_API_KEY` and
`EMAIL_FROM`, an address on a domain you've verified in Resend. Without them,
steps still run and are recorded on the timeline as "logged (email not
configured)", which is handy in development.

Every email includes:

- an unsubscribe link at `APP_URL`, signed with `APP_SECRET` (`/unsubscribe?t=...`). Without
  both, sequence email is not sent: an email with a dead unsubscribe link must not go out
- `List-Unsubscribe` and `List-Unsubscribe-Post` headers, so mail clients show a
  one-click unsubscribe (RFC 8058)

## Suppression

Addresses in the `email_suppressions` table never receive campaign email. They're
added when someone unsubscribes or, once the webhook is configured, when an email
bounces or gets a spam complaint:

1. In Resend → Webhooks, add `{APP_URL}/api/webhooks/email` for the events
   `email.bounced` and `email.complained`.
2. Set `RESEND_WEBHOOK_SECRET` to the webhook's signing secret.

Suppression applies to campaigns. Swirls workflows send their own transactional
email and don't consult this list.

## Sending hours

By default an email goes out when it is due, whatever the hour. To keep later
emails to working hours, set `app.sendingHours` in `crm.config.json`:

```json
"app": {
  "name": "Acme",
  "timezone": "America/New_York",
  "sendingHours": { "from": "08:00", "to": "18:00" }
}
```

The hours are on the clock of `app.timezone`, Monday to Friday unless you add
`"weekdaysOnly": false`. An email that falls due outside them waits for the
next opening: later that morning, the next morning, or Monday. An email with
no wait is always sent at once, because someone has just asked for it.

## Operations

- **State** is the `sequence_runs` table: one row per enrolment, with the next
  email, when it is due, and whether the run is active, finished or stopped.
  Nothing is kept in memory or on disk.
- **What sends.** `tick` in `packages/spools/src/server/campaigns.ts` sends every email that is
  due. A server that stays up calls it once a minute. A serverless host has no
  process to keep a timer in, so with
  `SERVERLESS=1`, or on Vercel, a cron job calls `/api/cron/sequences` with `CRON_SECRET` as a
  bearer token. An email goes out within one interval of being due. An email with
  no wait is sent in the request that enrolls the record.
- **Any number of instances.** Two instances, or a cron job overlapping the
  last one, can't send the same email: each run is taken with a single
  conditional update that only one of them wins.
- **Failures.** A send that fails is tried again about ten minutes later, up to
  five times; then the run stops and the record's timeline says so. Every try
  at one email carries the same idempotency key, which Resend uses to drop a
  repeat, so an email that did go out before a crash is not delivered twice. A
  transport of your own (`email.send` in `src/app/extensions.ts`) is handed the
  key as `idempotencyKey`.
- **Stopping.** A run stops when the record is deleted or a `stopWhen` field
  matches. A missing or suppressed address skips that one email.
- **Changing a campaign.** A run in flight reads the campaign from the config
  each time an email is due, by step id: edit a subject or body and the next
  email uses it. A run whose next step was removed stops. Avoid renaming step
  ids while runs are active.
- **Without a scheduled job on a serverless host** only emails with no wait are
  sent; the Workflows page says "Sequences need a scheduled job on this server".
