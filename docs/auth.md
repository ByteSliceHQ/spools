# Signing in

Two separate things decide who gets into a Spool.

- **The auth adapter** says who someone is. You choose it in `src/spool.server.ts`, and
  its browser half in `src/spool.ui.ts`.
- **The access list** in `crm.config.json` says whether they may come in. It compares
  their email address, and only one the auth provider has verified as theirs, with
  `access.allowedEmails` and `access.allowedDomains`. Anyone else who signs in sees a
  page saying they have no access.

```json
"access": { "allowedDomains": ["acme.com"], "allowedEmails": ["accountant@example.org"] }
```

Answers are kept for a minute, so taking someone off the list (or out of the provider)
takes effect within one.

| Adapter        | When                                                       |
| -------------- | ---------------------------------------------------------- |
| `clerk()`      | You want sign-in run for you                               |
| `betterAuth()` | You want it in your own database, with no outside service  |
| `devAuth()`    | Development, tests and demos. Refuses to run in production |

## Clerk

```ts
// src/spool.server.ts
import { clerk } from "@swirls/spools/auth/clerk";
auth: clerk(),

// src/spool.ui.ts
import { clerkClient } from "@swirls/spools/auth/clerk/ui";
export const authClients = [clerkClient];
```

Set `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, and install
`@clerk/tanstack-react-start`. Under Restrictions in the Clerk dashboard, limit sign-ups
to your team; the access list is checked either way.

Clerk holds the Google and Microsoft tokens of the accounts people sign in with, which is
how their [mail and calendar](mailbox.md) are read. It can also make the token that signs
each person in to [Swirls](swirls.md) without an API key.

## Better Auth

```ts
// src/spool.server.ts
import { betterAuth } from "@swirls/spools/auth/better-auth";
auth: betterAuth(),

// src/spool.ui.ts
import { betterAuthClient } from "@swirls/spools/auth/better-auth/ui";
export const authClients = [betterAuthClient];
```

[Better Auth](https://better-auth.com) runs inside your server and keeps its users, sessions
and accounts in your own database. People sign in with a link sent to their address, or with
Google or Microsoft. There are no passwords. Only someone on the access list is sent a link
or gets an account.

Install `better-auth`, then run `bun run crm:gen` and `bun run db:push` to create its four
tables (`auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`). PGlite creates
them itself.

| Variable                                         |                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`                             | Required in production: 32 or more characters (`openssl rand -base64 32`). It signs session cookies and encrypts stored Google and Microsoft tokens. Changing it signs everyone out, and people reconnect their accounts |
| `APP_URL`                                        | Required in production: the app's public address. People must open the app there, or signing in is refused. Cookies are marked secure when it is `https`                                                                 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`       | Adds Google. Redirect URI: `<APP_URL>/api/auth/callback/google`                                                                                                                                                          |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Adds Microsoft. Redirect URI: `<APP_URL>/api/auth/callback/microsoft`                                                                                                                                                    |
| `MICROSOFT_TENANT_ID`                            | The one organization whose people may sign in. See below                                                                                                                                                                 |
| `TRUST_PROXY`                                    | How many proxies are in front of the server, so that rate limits count the right visitor                                                                                                                                 |

In development all of them may be missing: the address is `http://localhost:3000`, and
everyone is signed out when the server restarts.

**Links by email** need an email provider in production (`RESEND_API_KEY` and `EMAIL_FROM`,
or another [email adapter](adapters.md)). In development the link is written to the log. A
link works once, for ten minutes. Opening it shows a page with one button, because mail
filters open links to check them and would otherwise use it up. The answer to asking for a
link is the same, and takes the same time, whether or not the address is on the access list.

**Microsoft** lets any organization put any address in its own people's profiles, so an
address counts only when Microsoft says who owns it. Either set `MICROSOFT_TENANT_ID` to your
own organization, whose word is then taken, or add the `xms_edov` or
`verified_primary_email` optional claim to the ID token in the app's registration. Without
one or the other, signing in with Microsoft always fails.

**Mail and calendar.** "Open profile" in the mailbox panel asks Google or Microsoft for the
[mailbox scopes](mailbox.md). The account must have the address the person signs in with. If
you use the Integrations page too, keep its redirect URIs
(`<APP_URL>/api/integrations/<provider>/callback`) on the same client.

**Swirls** needs `SWIRLS_API_KEY`, because Better Auth gives no identity token that Swirls
could check.

**Removing someone.** Take them off the access list. Their row in `auth_users` stays and
opens nothing. Sessions last thirty days from signing in, and signing out takes effect at
once.

> **Status:** tested against stand-ins for Google and Microsoft, and by hand in a browser
> with links by email. It has not been run against live Google or Microsoft accounts.

## The development sign-in

`devAuth()` signs every request in as one person: whoever `DEV_AUTH_EMAIL` names, or the
first address the access list lets in. `DEV_AUTH_SIGNED_OUT=1` shows the app signed out.
A new Spool uses it until you set a real provider's keys. It refuses to run with
`NODE_ENV=production`, and a production build leaves it out.

## Record scopes

With [`scopes`](configuration.md#scopes) in the config, something has to say which scopes
each person holds.

- **Clerk organizations.** `clerk({ scopes: 'organizations' })`: a person holds the scope of
  each organization they belong to, with their role in it. The scope is the organization's
  slug (so `north` for records whose scope field holds `north`) and the role is the
  membership's without Clerk's prefix: `org:member` is `member` in `scopes.roles`. Give head
  office a role marked `all`. The organization active in the session is the scope the person
  works in; switching with Clerk's own switcher switches the CRM. Not run against a live
  Clerk account yet: the mapping is tested, the calls to Clerk are not.
- **Development.** `devAuth({ scopes: { list, grants } })`, by email address:

  ```ts
  auth: devAuth({
    scopes: {
      list: [{ key: 'north', label: 'North' }, { key: 'south', label: 'South' }],
      grants: { 'dev@example.com': [{ scope: 'north', role: 'member' }] },
    },
  }),
  ```

- **Better Auth, or anything else.** A resolver of your own, in
  [`src/app/extensions.ts`](extending.md#scopes-who-holds-what).

## Your own

An auth adapter has a server half (a directory of people, the session of a request, and
optionally middleware and endpoints under `/api/auth`) and a browser half (the sign-in
form, the account button, signing out). Both contracts are short:
`packages/spools/src/server/runtime/auth.ts` and `packages/spools/src/crm/ui/auth.tsx`.

The one rule that matters is that `AuthUser.email` is an address the provider has
verified, or null. The access list trusts it.

## Changing provider

Records keep the user ids of their owners and of whoever made them, and the ids are the
provider's. Moving to another provider gives everyone a new id, so owners, assignees,
favourites and "created by" won't match until they are mapped across. Plan that before
you switch a Spool people use.
