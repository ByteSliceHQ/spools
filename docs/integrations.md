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
- **Accounts shared with the team**: a service your app says is connected once for
  everyone, or once for each branch or region. See [Shared connections](#shared-connections).
- **The accounts your marketing posts through** (LinkedIn, X, Google Ads), once a channel
  or an ad account in the config uses one. These are shared with the team: whoever
  connects one, any teammate can publish through it from the Marketing page. See
  [Marketing](marketing.md).

Each person connects their own accounts. Nobody else can see or remove them, and nobody
else can use them. A shared connection is the exception, and the page lists those under
their own heading.

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

## Shared connections

Some accounts are the business's, not a person's: one accounting system for the
company, or one for each branch, used by whoever presses "Create invoice" and still
working after the person who connected it has left. A provider says so with `shared`
(see [Share a provider with the team](#share-a-provider-with-the-team)):

| The provider says | A connection belongs to              | Who may use it                          |
| ----------------- | ------------------------------------ | --------------------------------------- |
| nothing           | The teammate who connected it        | That teammate                           |
| `shared: 'team'`  | The team. There can be more than one | Everyone on the access list             |
| `shared: 'group'` | One group, chosen when connecting    | Everyone on the access list (see below) |

On the page, shared connections are under **Shared with the team**, for everyone:
which account, the whole team or which group, who connected it and when, and
"Needs reconnecting" when the provider has turned the stored grant down.

- **Who may connect, reconnect and disconnect.** Anyone on the access list, unless the
  provider has `canManage`: then only the people it names. Everyone else sees the
  connection and can use it, without the buttons, and the server refuses them whatever
  they send. Connecting an account that is already connected for the team (or for that
  group) replaces its tokens and records who did it; the connection keeps its id.
- **One connection for each account.** An account is connected once for the team, or once
  for each group, whoever connects it: the database refuses a second row, so two people
  finishing at the same moment end up with one connection holding the tokens of whoever
  was last. Which account it is comes from the provider, asked with the token it just
  issued, never from the address the browser was sent back to (see
  [Add a provider](#add-a-provider)).
- **When whoever connected it leaves.** Nothing changes. A shared connection belongs to
  the team, so nothing that uses, lists or manages it asks whether that person is still
  on the access list. The page goes on saying who connected it, from the name kept at
  the time. This is the opposite of a connected mailbox, which is a person's and stops
  being read when they are removed: the built-in Google and Microsoft mailboxes can't
  be shared, so that rule is as it was.
- **Groups.** A group is a key and a label that your app lists: branches, regions,
  whatever the business is divided by. The key is a plain string of your choosing. Today
  a group's connection can be used by anyone on the access list who asks for that group;
  the CRM has no notion yet of which groups a person belongs to. Limit who may _manage_
  a group's connection with `canManage`, which is told the group.
- **Changing your mind.** Whose a connection is was decided when it was made, and is
  stored with it. Adding `shared` to a provider people have already connected for
  themselves does not hand those connections to the team: each stays with its owner,
  who sees a note on the page, until that person connects the same account again. That
  turns their connection into the team's; nobody else's is touched. Removing `shared`
  leaves existing shared connections shared.

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

Each connection's tokens are sealed for the row they are stored on. For a connection of
one's own that is its teammate, the provider and the account. For a shared connection it
is the provider, the account, and that it is the team's or which group's. Tokens copied
onto another row, or a row edited in the database to turn a personal connection into a
shared one or to move it to another group, are refused.

Disconnecting deletes the stored copy, and asks the provider to revoke the token where it
offers that. There is one case where it does not ask: when another connection holds the
same account at the same OAuth client (a teammate's own beside the team's, two people who
each connected one shared inbox, a Google mailbox and Google Ads on one Google account).
At many providers revoking one token ends every token that account gave the client, which
would stop the other connection without a word. The server logs that it left the grant
in place. The last connection to an account is revoked as it goes.

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

1. **Connect** opens `/api/integrations/<provider>/connect` (with `?group=<key>` for a
   provider shared by group). It checks the CRM session and, for a shared provider,
   that the group is one the provider lists and that this person may manage the
   connection. It sets a ten-minute, HttpOnly cookie holding a nonce and a PKCE
   verifier, and redirects to the provider with a signed `state` that names the
   teammate and, for a shared connection, whose it will be: the team's, or which group's.
2. The provider returns to `/api/integrations/<provider>/callback`. The callback
   is accepted only if the `state` signature is valid and unexpired, it names the
   signed-in teammate, and the cookie's nonce matches: so it only completes in the
   browser that started it. Whose the connection is comes from the signed `state` and
   nothing else in the callback's address. It is then checked against what the provider
   says now, so a `state` made for a personal connection can't make a shared one, one
   made for a group can't be used for another, and a person who stopped being allowed
   to manage the connection in the meantime is refused.
3. The code is exchanged for tokens (with the PKCE verifier), the provider is asked
   which account the new token is for, the tokens are encrypted and the row is written.
   Connecting the same account again replaces its tokens. The write checks and changes
   in one step, so two callbacks for the same account can't leave two rows.

`getAccessToken(connectionId, { as })` (from `@swirls/spools/extensions`) returns a valid
access token, refreshing it when it is about to expire. `as` is the person the call is
for: the token is then only given if they are on the access list and the connection is
theirs or is shared. Someone taken off the access list gets no token, not even for a
connection of their own. When `as` names nobody (`ctx.actor` is `null` in a handler an
automation ran), the call is refused. Code nobody is behind, such as a schedule, says so
by leaving the second argument out: `getAccessToken(connectionId)`. If the provider turns the
refresh down (the person revoked access, or a password change invalidated it), the
connection shows "Needs reconnecting" and is left alone until it is connected
again. A provider that is merely unavailable is tried again later. A token renewed while
its connection was being connected again, or handed to the team, is thrown away and the
new one is used.

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
      // Which account was connected: ask the provider, with the token it just issued.
      account: async ({ get }) =>
        (await get<{ id: string }>('https://books.example.com/api/me')).id,
    },
  },

  handlers: {
    // "run": "local:createInvoice" on an action or automation.
    async createInvoice(ctx) {
      // The books of whoever pressed the button: a connection is its teammate's own
      // unless the provider says it is shared (see below).
      const [connection] = ctx.actor
        ? await findConnections({ provider: 'books', userId: ctx.actor.id })
        : []

      if (!connection) return { message: 'Connect Acme Books on the Integrations page first' }
      // `as` is who the token is for. With no actor (an automation ran this) it is refused.
      const token = await getAccessToken(connection.id, { as: ctx.actor })
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
- **`account` must ask the provider.** `get` calls the provider's API with the token it
  just issued, so its answer is about the account that was really authorized. The
  callback's query string (`query`) is not: it came through the browser, and whoever is
  connecting can change it before it reaches the CRM. Some providers name the account
  only there (a `companyId` or `realmId` parameter). Use that value to know what to ask
  for, and let the provider confirm it:

  ```ts
  account: async ({ get, query }) => {
    const companyId = query.get('companyId')
    if (!companyId) return undefined
    // Fails unless the new token can read this company, so a changed id is refused.
    const company = await get<{ id: string }>(
      `https://books.example.com/api/companies/${encodeURIComponent(companyId)}`,
    )
    return company.id
  },
  ```

  This matters most for a [shared provider](#share-a-provider-with-the-team). Connecting
  an account that is already connected for the team replaces the team's tokens, and the
  account's name is how that connection is found. If the name came from the address, a
  teammate could authorize a company of their own, change `companyId` to the team's, and
  leave the team's connection holding their tokens: every invoice after that would go to
  the wrong company. So a shared connection is refused unless its `account` got an answer
  from the provider through `get`. The CRM can't check what you asked, so ask for
  something only the right account can answer.

- `findConnections` and `getAccessToken` are for server code. Never return a
  token, or another teammate's connection, to the browser.

### Share a provider with the team

Add `shared` to the provider and its connections belong to the team, or to a group of
it, instead of to whoever connected them.

```ts
integrations: {
  // One set of books for the whole company. Only the finance lead connects or removes it.
  books: {
    label: 'Acme Books',
    // ...the OAuth settings above...
    shared: 'team',
    canManage: ['finance@acme.example'],
  },

  // One set of books per branch. Each branch's manager looks after their own.
  branch_books: {
    label: 'Acme Books (branch)',
    // ...
    shared: 'group',
    // A list, or a function that reads your branches from wherever you keep them.
    groups: async () => [
      { key: 'north', label: 'North branch' },
      { key: 'south', label: 'South branch' },
    ],
    canManage: (user, { group }) => managerOf(group) === user.email,
  },
},

handlers: {
  async createInvoice(ctx) {
    // The company's connection. For a branch: { provider: 'branch_books', group: ctx.record.branch }.
    const [connection] = await findConnections({
      provider: 'books',
      shared: 'team',
      // Only what the person who pressed the button may use.
      usableBy: ctx.actor,
    })

    if (!connection) return { message: 'Ask finance to connect Acme Books on the Integrations page' }
    const token = await getAccessToken(connection.id, { as: ctx.actor })
    // ...call the provider with the token...
    return { message: 'Invoice created' }
  },
},
```

| Option          | What it does                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared`        | `'team'`: a connection is everyone's on the access list. `'group'`: it is one group's, chosen when connecting. Left out: it is the teammate's who connected it                                           |
| `groups`        | For `'group'`: what a connection can be made for. `{ key, label }` entries (or keys alone), or a function that returns them. A key is at most 100 characters, with no control characters                 |
| `canManage`     | Who may connect, reconnect and disconnect: a list of email addresses, or `(user, { group }) => boolean` (it may be async; if it throws, nobody may). Left out: anyone on the access list                 |
| `adoptExisting` | For `'team'`, when connections to this provider were already used by everyone before you added `shared` (as marketing accounts were): the ones made before count as the team's without being reconnected |

What your code can ask for:

| Call                                               | Returns                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `findConnections({ provider, shared: 'team' })`    | The team's connections                                                           |
| `findConnections({ provider, group: 'north' })`    | That group's connections, and no other group's                                   |
| `findConnections({ provider, shared: 'group' })`   | Every group's                                                                    |
| `findConnections({ provider, userId })`            | That teammate's own. Never a shared one, whoever connected it                    |
| `findConnections({ provider })`                    | Every connection to the provider, whoever's                                      |
| any of them with `usableBy: ctx.actor`             | Only the ones that person may use. None when there is no actor                   |
| `getAccessToken(connection.id, { as: ctx.actor })` | A token, or a refusal when that person may not use it, or when there is no actor |
| `getAccessToken(connection.id)`                    | A token, for code nobody is behind (a schedule, a webhook)                       |

A connection says whose it is: `shared` (`'team'`, `'group'` or `null`), `group`, and
`connectedBy`, the name of whoever connected a shared one (`null` for one made before
names were kept). `userId` is who connected it.

- Pass `usableBy` and `as` whenever a person caused the call. `ctx.actor` is `null` when
  nobody did (an automation, a script, an import). Passing that `null` does not make the
  call trusted: `getAccessToken` refuses and `findConnections` finds nothing, because
  nobody may use nothing. If a handler really should act for the business when no one is
  signed in, write that out, so it can be seen in the code:

  ```ts
  const token = ctx.actor
    ? await getAccessToken(connection.id, { as: ctx.actor })
    : await getAccessToken(connection.id) // nobody is behind this run: trusted
  ```

- A provider whose declaration contradicts itself (`groups` without `shared: 'group'`,
  `canManage` without `shared`) is left out, with a warning at start-up.
- The built-in Google and Microsoft mailboxes are always each person's own.

## Troubleshooting

| What you see                                                 | What it means                                                                                                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "More accounts can't be connected yet"                       | The list under it names what is missing: `APP_URL`, `APP_SECRET` or the `CS_*` variables                                                                                |
| "… hasn't been set up for this CRM yet"                      | That provider's client id and secret are not set                                                                                                                        |
| "That sign-in link expired or was opened in another browser" | The consent screen was left open for more than ten minutes, or finished in a different browser. Connect again                                                           |
| "… didn't grant ongoing access"                              | The provider sent no refresh token. Remove the CRM from the account's connected apps, then connect again                                                                |
| "Needs reconnecting"                                         | The provider turned the stored grant down. **Reconnect** and pick the same account                                                                                      |
| "The CRM already reaches this mailbox through your sign-in"  | The connection duplicates the sign-in account and is not used. Disconnect it, or leave it                                                                               |
| "Only the people who manage … for this CRM can connect it"   | The provider has `canManage` and it doesn't name you. Ask someone it does                                                                                               |
| "Who … is connected for changed while you were connecting"   | The provider's `shared` setting was changed while the consent screen was open. Connect again                                                                            |
| "Yours alone: it was connected before … was shared"          | You connected it before the provider was shared. Connect the account again under **Shared with the team**                                                               |
| "… which account it is was not confirmed with …"             | A shared provider's `account` took the name from the callback's address without asking the provider. Make it call `get` (see [Add a provider](#add-a-provider))         |
| "Could not read the … account"                               | The provider refused the question `account` asked with the new token: the account named in the address is not the one that was authorized, or the scopes don't cover it |
| "That account can only be used for someone signed in"        | A handler passed `as: ctx.actor` and nobody was signed in (an automation ran it). Decide in the handler what should happen then                                         |
