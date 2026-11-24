# Integrations: accounts teammates connect

The Integrations page (`/integrations`) is where a teammate sees every account the
CRM works with on their behalf, and connects more:

- **The account they sign in with.** A Google or Microsoft sign-in is a mailbox
  already; nothing is connected and the CRM stores no tokens for it. See
  [Mailbox](mailbox.md).
- **More mailboxes.** A second address, a shared inbox, or the only mailbox of
  someone who signs in with an email and password. Google and Microsoft are built
  in.
- **Other services** your app adds, such as an accounting or phone system. See
  [Add a provider](#add-a-provider).
- **The accounts your marketing posts through** (LinkedIn, X, Google Ads), once a channel
  or an ad account in the config uses one. These are shared: whoever connects one, any
  teammate can publish through it from the Marketing page. See [Marketing](marketing.md).

Each person connects their own accounts. Nobody else can see or remove them, and nobody
else can use them, except a marketing account, which is connected for the team.

> **Status:** built and tested against stubbed providers and a stand-in for
> CipherStash. It has not yet been run against live Google, Microsoft or
> CipherStash accounts.

## Connected mailboxes

A connected mailbox is treated exactly like the sign-in one:

- Its mail and finished meetings with known contacts are logged on timelines, on
  the same [schedule](mailbox.md#the-schedule), credited to the teammate who
  connected it. Only the subject, a short preview and the time are kept.
- The teammate can send from it. "Compose email" shows a **From** choice when
  they have more than one mailbox that may send. Left alone, the CRM uses the
  address it knows them by, then their sign-in, then a connected mailbox.
- A person can connect several mailboxes, including several from one provider.
- Connecting the address you already sign in with is harmless: the CRM uses
  whichever of the two has the access it needs, and the sign-in when both do.
  This is also the way to give the CRM mail access without adding the mail scopes
  to your Clerk connection.
- When a teammate is removed from `access` in `crm.config.json`, their connected
  mailboxes stop being read. The stored tokens stay until they are disconnected
  or the rows are deleted.

Connecting asks for the scopes listed in [`packages/spools/src/crm/mailbox.ts`](../packages/spools/src/crm/mailbox.ts)
(read mail and calendar, send mail), the same ones the sign-in uses.

## How tokens are stored

The sign-in's tokens stay with the auth provider. A connected account's tokens are the
CRM's to keep, so they are sealed by the [vault](adapters.md): by default with [CipherStash](https://cipherstash.com)
(`@cipherstash/stack`) inside the app before they are written to the
`integrations` table, each value under its own key from ZeroKMS. The database
only holds ciphertext, so a database dump or a leaked backup cannot be used to
read anyone's mail.

There is no plaintext fallback. Without its keys the vault refuses
to store anything and the page says more accounts can't be connected yet. The
code is in [`packages/spools/src/server/runtime/vault.ts`](../packages/spools/src/server/runtime/vault.ts).

Disconnecting asks the provider to revoke the token where it offers that, and
deletes the stored copy either way.

## Setup

The sign-in mailbox needs none of this. To let teammates connect more accounts:

### 1. The vault

With `vault: aes()` there is one thing to set, a key of your own:
`VAULT_KEY=$(openssl rand -base64 32)`. Keep it somewhere other than the database:
whoever has both can read every connected account. To change it, put the old key in
`VAULT_OLD_KEYS` so what it sealed still opens.

With `vault: cipherstash()`:

Create a workspace and an access key, then set:

```sh
CS_WORKSPACE_CRN=
CS_CLIENT_ID=
CS_CLIENT_KEY=
CS_CLIENT_ACCESS_KEY=
```

`APP_URL` (the public address of the app) and `APP_SECRET` (32+ characters; signs
the OAuth `state`) must be set too.

### 2. Google

In the Google Cloud console, create an OAuth client of type **Web application**.
It can be the same client your Clerk connection uses, with one more redirect URI.

- Authorised redirect URI: `{APP_URL}/api/integrations/google/callback`
- Enable the Gmail API and the Google Calendar API for the project.
- OAuth consent screen: for a Google Workspace organisation choose **Internal**,
  which needs no review by Google. An **External** app that asks for Gmail scopes
  must pass Google's verification before people outside your test-user list can
  connect.

```sh
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

### 3. Microsoft

In Microsoft Entra, register an application with a **Web** platform (or add the
redirect URI to the one your Clerk connection uses):

- Redirect URI: `{APP_URL}/api/integrations/microsoft/callback`
- API permissions (delegated): `openid`, `email`, `offline_access`, `User.Read`,
  `Mail.Read`, `Calendars.Read`, `Mail.Send`. Some tenants require an
  administrator to consent.
- Create a client secret.

```sh
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
# Your tenant id limits connecting to your organisation. Default: common (any Microsoft account).
MICROSOFT_TENANT_ID=
```

A provider is offered once its client id and secret are set; you can set up one
and not the other. The server logs which parts are on at start-up.

## How connecting works

1. **Connect** opens `/api/integrations/<provider>/connect`. It checks the CRM
   session, sets a ten-minute, HttpOnly cookie holding a nonce and a PKCE verifier,
   and redirects to the provider with a signed `state` that names the teammate.
2. The provider returns to `/api/integrations/<provider>/callback`. The callback
   is accepted only if the `state` signature is valid and unexpired, it names the
   signed-in teammate, and the cookie's nonce matches: so it only completes in the
   browser that started it.
3. The code is exchanged for tokens (with the PKCE verifier), the account is
   identified, the tokens are encrypted and the row is written. Connecting the
   same account again replaces its tokens.

`getAccessToken(connectionId)` (from `@swirls/spools/extensions`) returns a valid
access token, refreshing it when it is about to expire. If the provider turns the
refresh down (the person revoked access, or a password change invalidated it), the
connection shows "Needs reconnecting" and is left alone until it is connected
again. A provider that is merely unavailable is tried again later.

## Add a provider

Anything that speaks OAuth 2 with the authorization-code flow can be added in
`integrations` in `src/app/extensions.ts`. The framework shows it on the page,
runs the flow, encrypts and refreshes the tokens. Your code decides what to do
with them.

```ts
import { defineExtensions, findConnections, getAccessToken } from '@swirls/spools/extensions'

export default defineExtensions({
  integrations: {
    // The key is the provider's id: it is in the redirect URI and the database.
    books: {
      label: 'Acme Books',
      description: 'Create invoices from won deals',
      // Names of the environment variables that hold the client id and secret.
      clientId: 'BOOKS_CLIENT_ID',
      clientSecret: 'BOOKS_CLIENT_SECRET',
      authUrl: 'https://books.example.com/oauth/authorize',
      tokenUrl: 'https://books.example.com/oauth/token',
      scopes: ['invoices.write'],
      // Some providers want the client id and secret as HTTP Basic, not in the form body.
      tokenAuth: 'basic',
      // Which account was connected: from the provider's API, or the callback's query string.
      account: async ({ get, query }) =>
        query.get('companyId') ??
        (await get<{ id: string }>('https://books.example.com/api/me')).id,
    },
  },

  handlers: {
    // "run": "local:createInvoice" on an action or automation.
    async createInvoice(ctx) {
      // Whoever pressed the button, or anyone on the team who connected the books.
      const [connection] = [
        ...(ctx.actor ? await findConnections({ provider: 'books', userId: ctx.actor.id }) : []),
        ...(await findConnections({ provider: 'books' })),
      ]
      if (!connection) return { message: 'Connect Acme Books on the Integrations page first' }
      const token = await getAccessToken(connection.id)
      await fetch('https://books.example.com/api/invoices', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ customer: ctx.record.name }),
      })
      return { message: 'Invoice created' }
    },
  },
})
```

- Register `{APP_URL}/api/integrations/<id>/callback` as the redirect URI with
  the provider.
- The provider must issue a refresh token; a connection without one is refused. For a
  provider that only gives a long-lived access token, set `refreshToken: 'optional'`: the
  connection then works until that token runs out, and shows "Needs reconnecting" after.
- An id is lower-case letters, digits, `-` or `_`. `google` and `microsoft` are
  taken. A provider with a bad id is left out, with a warning at start-up.
- `findConnections` and `getAccessToken` are for server code. Never return a
  token, or another teammate's connection, to the browser.

## Troubleshooting

| What you see                                                 | What it means                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| "More accounts can't be connected yet"                       | The list under it names what is missing: `APP_URL`, `APP_SECRET` or the `CS_*` variables                      |
| "… hasn't been set up for this CRM yet"                      | That provider's client id and secret are not set                                                              |
| "That sign-in link expired or was opened in another browser" | The consent screen was left open for more than ten minutes, or finished in a different browser. Connect again |
| "… didn't grant ongoing access"                              | The provider sent no refresh token. Remove the CRM from the account's connected apps, then connect again      |
| "Needs reconnecting"                                         | The provider turned the stored grant down. **Reconnect** and pick the same account                            |
| "The CRM already reaches this mailbox through your sign-in"  | The connection duplicates the sign-in account and is not used. Disconnect it, or leave it                     |
