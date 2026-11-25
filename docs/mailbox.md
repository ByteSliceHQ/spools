# Mailbox: email and calendar from the sign-in

Teammates who sign in to the CRM with Google or Microsoft can let it use that same
account: mail and meetings with known contacts are logged on those contacts'
timelines, and emails written in the CRM go out from the teammate's own mailbox.

For that account there is no "connect your account" step and the CRM stores no
tokens. The auth provider holds them; the CRM asks it for a teammate's current token each
time it needs one.

A teammate can also connect other mailboxes (a second address, a shared inbox, or
their only one if they sign in with an email and password) on the
[Integrations page](integrations.md). Those are read and sent from in exactly the
same way; only where the tokens live differs.

> **Status:** built and tested against stubbed Clerk, Google and Microsoft APIs.
> It has not yet been run against live accounts. The points marked "to confirm"
> below are the ones a first live run should check.

## What it does

|                                                   |                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| An email the teammate sent to a contact           | "sent an email: _subject_", with a short preview. Counts as an email for the sender           |
| An email a contact sent them                      | "received an email: _subject_", with a short preview. Shown on the timeline, not counted      |
| A finished calendar event with a contact          | "had a meeting: _title_". Counts as a meeting for each teammate who attended                  |
| An email written with "Compose email" on a record | Sent from the teammate's mailbox, so it is in their Sent folder and replies come back to them |

- Only mail and meetings involving an address that is already on a CRM record are
  kept, and only the subject, a short preview and the time. Message bodies are
  never fetched, and everything else in the mailbox is read past.
- An email between colleagues that copies a contact is logged once, from the
  sender's mailbox.
- Nothing is logged twice: each entry carries the email's Message-ID or the
  event's id. An email sent from the CRM is logged at once and then matched to
  the mailbox's copy when the next read meets it.
- A teammate with no mailbox that may send (no Google or Microsoft sign-in, no
  connected mailbox, or no send permission) still sends through the app's email
  provider (Resend). The composer says so when their mailbox should have worked
  and didn't.
- A teammate with more than one mailbox that may send picks which in the
  composer's **From** row.
- Campaign emails always go through the app's email provider.

Each teammate sees what their mailboxes allow under the envelope button at the
bottom of the sidebar and on the Integrations page, with a "Read now" button and
the last error if a read failed.

## Setup

For the sign-in account, all of it is in Clerk and the provider's console; the CRM
needs no keys of its own. (Connecting further mailboxes has its own
[setup](integrations.md#setup).)

1. **Use your own OAuth credentials in Clerk.** In the Clerk dashboard, open the
   Google or Microsoft social connection, turn on **Use custom credentials** and
   enter the client ID and secret from step 2 or 3. Clerk cannot hand out tokens
   for connections on its shared development credentials.
2. **Google.** In Google Cloud, create an OAuth client (Web application) with
   Clerk's redirect URI, enable the Gmail and Calendar APIs, and add the scopes
   below. Publish the app ("In production"), or make it internal to your
   Workspace; an app left in testing is limited to its test users.
3. **Microsoft.** In Microsoft Entra, register an app with Clerk's redirect URI
   and add the delegated Graph permissions below. Clerk signs in through the
   `common` audience, so the registration has to accept accounts from any
   organisation; who may use the CRM is still decided by `access` in
   `crm.config.json`. Your tenant may need an administrator to consent to the
   mail permissions.
4. **Add the scopes to the Clerk connection** (the Scopes field appears once
   custom credentials are on):

   | Provider  | To read                                                                                               | To send                                      |
   | --------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
   | Google    | `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/calendar.readonly` | `https://www.googleapis.com/auth/gmail.send` |
   | Microsoft | `Mail.Read`, `Calendars.Read` (and `offline_access`)                                                  | `Mail.Send`                                  |

   The list lives in [`packages/spools/src/crm/mailbox.ts`](../packages/spools/src/crm/mailbox.ts). Reading and
   sending are checked separately, so you can grant only one.

5. **Teammates who signed in before the scopes were added** reconnect once: the
   mailbox panel's "Open profile" button opens their Clerk profile, which asks
   for the extra permissions.

## The schedule

Mailboxes are read every `MAILBOX_SYNC_MINUTES` (default 5; `0` turns the
schedule off), the first time going back `MAILBOX_LOOKBACK_DAYS` (default 30).
Accounts that have waited longest go first.

The schedule is a timer in the server process. On a host with no long-lived process
(`SERVERLESS=1`, or Vercel) the timer is off. Set `CRON_SECRET` (16+ random characters) and have a
cron job call `/api/cron/mail-sync` with it as a bearer token.

Each call reads for about 45 seconds and leaves any remaining accounts for the
next call. It answers 401 without the right token and 503 when Clerk cannot
provide tokens at all.

## To confirm on a first live run

- That the token Clerk returns for Microsoft works against Microsoft Graph with
  the mail scopes, and still works days later (Clerk fetches a fresh token when
  asked; it needs a refresh token from the provider to do so).
- That Clerk obtains a Google refresh token. Google only gives one when offline
  access is requested.
- Clerk's rate limit for retrieving tokens, with every teammate read every few
  minutes.

## Troubleshooting

| What you see                                                   | What it means                                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Clerk is using its shared development credentials"            | Step 1 is not done for that provider                                                                                                               |
| "No access to read your mail and calendar yet" in the panel    | The account hasn't granted the read scopes: step 4, then the teammate reconnects                                                                   |
| "… denied access (401/403). Reconnect the account"             | The grant was revoked or is too narrow; the teammate reconnects from their profile, or on the Integrations page for a mailbox they connected there |
| The panel says there is no mailbox                             | The teammate signed in with an email and password or another provider. They can connect a mailbox on the Integrations page                         |
| "Sent from the shared address, not your mailbox" after sending | Their mailbox refused the send; the reason follows, and the email went through the app's provider instead                                          |
