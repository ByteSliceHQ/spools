# Adapters

A Spool runs on services you choose. Each kind of service has a **port**, a small
contract the framework asks for, and one or more **adapters** that provide it. You
choose them in `src/spool.server.ts`:

```ts
import { defineSpool } from '@swirls/spools'
import { swirls } from '@swirls/spools/agents/swirls'
import { clerk } from '@swirls/spools/auth/clerk'
import { postgres } from '@swirls/spools/database/postgres'
import { resend } from '@swirls/spools/email/resend'
import { drive, s3Blobs } from '@swirls/spools/files/drive'
import { aes } from '@swirls/spools/vault/aes'

import crm from '../crm.config.json' with { type: 'json' }
import extensions from './app/extensions'

export default defineSpool({
  crm,
  extensions,
  auth: clerk(),
  database: postgres(),
  files: drive({ blobs: s3Blobs() }),
  email: resend(),
  vault: aes(),
  agents: swirls(),
})
```

When the server starts it logs which adapters it uses and what each still needs
(`[env] Campaign email (Resend): off (set RESEND_API_KEY, EMAIL_FROM)`). A variable
an adapter can't do without stops a production server from starting.

## What ships

| Port     | Import                             | Needs                                                                      |
| -------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Auth     | `@swirls/spools/auth/clerk`        | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `@clerk/tanstack-react-start` |
|          | `@swirls/spools/auth/better-auth`  | `BETTER_AUTH_SECRET`, `APP_URL`, `better-auth`. See [Signing in](auth.md)  |
|          | `@swirls/spools/auth/dev`          | Nothing. Refuses to run in production                                      |
| Database | `@swirls/spools/database/postgres` | `DATABASE_URL`, `@effect/sql-pg`. See [Database](database.md)              |
|          | `@swirls/spools/database/pglite`   | Nothing but `@effect/sql-pglite`                                           |
|          | `@swirls/spools/database/prisma`   | `DATABASE_URL`, `@prisma/orm-postgres`                                     |
| Files    | `@swirls/spools/files/drive`       | A `Blobs`: `localBlobs()` or `s3Blobs()`. See [Files](files.md)            |
|          | `@swirls/spools/files/flashdrive`  | `FLASHDRIVE_API_KEY`, `FLASHDRIVE_DRIVE_ID`                                |
| Email    | `@swirls/spools/email/resend`      | `RESEND_API_KEY`, `EMAIL_FROM`, `resend`                                   |
| Vault    | `@swirls/spools/vault/cipherstash` | The `CS_*` variables, `@cipherstash/stack`                                 |
|          | `@swirls/spools/vault/aes`         | `VAULT_KEY` (`openssl rand -base64 32`)                                    |
| Agents   | `@swirls/spools/agents/swirls`     | `SWIRLS_PROJECT_ID`. See [Swirls](swirls.md)                               |

The packages named here are optional peer dependencies: install the ones your
adapters use.

### Changing one

Change its line in `src/spool.server.ts`. Auth also has a browser half, listed in
`src/spool.ui.ts`; the page uses the one whose id matches the server's and says so if
there is none.

Three things to know before changing one on a Spool with data in it:

- **Auth.** Records keep the user ids of whoever made and owns them, and those ids are
  the auth provider's. A new provider means new ids: owners and "created by" will not
  match until they are mapped over.
- **Vault.** A vault can only open what it sealed. Change it and people reconnect their
  accounts on the Integrations page.
- **Files.** Each record remembers which store its folder is in, so it gets a new,
  empty folder in the new store. Nothing is copied.

Changing the database adapter between `postgres` and `prisma` is safe: they read and
write the same tables.

## Write your own

An adapter is an object with an `id`, a `label` and a layer that provides the port.
Everything you need is in `@swirls/spools/adapter`.

### An email provider

[`examples/postmark.ts`](../examples/postmark.ts):

```ts
import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import { config, Email, EmailError, type EmailAdapter } from '@swirls/spools/adapter'

/**
 * Email through Postmark (https://postmarkapp.com).
 *
 *   POSTMARK_TOKEN   a server token
 *   EMAIL_FROM       who it comes from
 */
export const postmark = (): EmailAdapter => ({
  id: 'postmark',
  label: 'Postmark',
  // Shown in the boot report.
  features: [{ name: 'Email (Postmark)', vars: ['POSTMARK_TOKEN', 'EMAIL_FROM'] }],
  layer: Layer.effect(
    Email,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient

      return Email.of({
        send: Effect.fn('Postmark.send')(function* (email) {
          const token = yield* config.variable('POSTMARK_TOKEN')
          const from = yield* config.variable('EMAIL_FROM')

          if (!token || !from) {
            return { id: null, sent: false }
          }

          const request = HttpClientRequest.post('https://api.postmarkapp.com/email').pipe(
            HttpClientRequest.setHeader('x-postmark-server-token', token),
            HttpClientRequest.bodyJsonUnsafe({
              From: from,
              To: email.to,
              Subject: email.subject,
              TextBody: email.text,
              HtmlBody: email.html,
            }),
          )

          const response = yield* http
            .execute(request)
            .pipe(
              Effect.mapError(() => new EmailError({ message: 'Postmark could not be reached' })),
            )

          if (response.status >= 300) {
            return yield* new EmailError({
              message: `Postmark refused the email (${response.status})`,
            })
          }

          return { id: null, sent: true }
        }),
        // Bounces and complaints, posted to /api/webhooks/email.
        delivery: () => Effect.succeed('unconfigured' as const),
      })
    }),
  ),
})
```

If all you want is to send email another way, `email.send` in
`src/app/extensions.ts` takes a plain async function and no Effect
([Extending](extending.md#email-use-a-different-provider)).

### A database

A store answers a small set of questions about tables: find, count, insert, update,
remove, plus running a program as one transaction. Implement `Backend` and wrap it with
`makeStore`, which adds the time limits and typed failures every store has. For anything
that speaks Postgres SQL, `sqlBackend` does all of it and you supply two things: a function
that runs a statement, and one that runs a program as a transaction. `callbackTransaction`
makes the second from a driver whose own transaction takes a callback:

[`examples/bun-postgres.ts`](../examples/bun-postgres.ts):

```ts
import { SQL } from 'bun'
import { Effect, Layer } from 'effect'

import {
  callbackTransaction,
  DatabaseError,
  makeStore,
  placeholders,
  sqlBackend,
  Store,
  type StoreAdapter,
} from '@swirls/spools/adapter'

/** Any Postgres, through Bun's own client. */
export const bunPostgres = (url: string): StoreAdapter => ({
  id: 'bun-postgres',
  label: 'Postgres',
  layer: Layer.effect(
    Store,
    Effect.gen(function* () {
      const sql = new SQL(url)
      yield* Effect.addFinalizer(() => Effect.promise(() => sql.close()))

      // Bun's transaction takes a callback, and hands it the connection to use.
      const transaction = callbackTransaction<SQL>((work) => sql.begin((tx) => work(tx)))

      return Store.of(
        makeStore(
          sqlBackend((query) => {
            const { text, params } = placeholders(query)

            // Inside a transaction a statement is the transaction's; otherwise the pool's.
            return Effect.flatMap(transaction.current, (tx) =>
              Effect.tryPromise({
                try: () => (tx ?? sql).unsafe(text, [...params]),
                catch: (cause) => new DatabaseError({ cause }),
              }),
            )
          }, transaction.transact),
        ),
      )
    }),
  ),
})
```

Three promises are easy to break:

- **`update` checks and changes in one step**, and says how many rows it changed.
  Sequences rely on it so that two servers never send the same email.
- **A transaction keeps everything or nothing.** Every statement a program runs inside
  `store.transaction` must go to the transaction's connection, not the pool's, and a
  failure or an interruption must undo it. A record and its timeline rely on it.
- **Values come back as the table describes them**: money and days as strings,
  moments as `Date`. Columns are read in terms of the table, never of the driver.

### Tables of its own

An adapter may keep tables in the Spool's database. Describe them with the table
definitions the framework uses, list them in `tables`, and they are created and
migrated with the rest (`bun run crm:gen`):

```ts
import { table } from '@swirls/spools/adapter'

const Receipt = table.defineTable({
  model: 'Receipt',
  name: 'receipts',
  columns: {
    id: table.id(),
    createdAt: table.createdAt(),
    total: table.float(),
    note: table.optional(table.text()),
  },
  indexes: [['createdAt']],
})
```

Its layer may ask for the `Store`. Don't
make `tables` depend on the environment, or the schema would differ between your
machine and production.

### Check it

In a clone of the repository, run the framework's own tests on your adapter. `packages/spools/tests/unit/store.test.ts`
is what a store promises, and `TEST_STORE` in
`packages/spools/tests/support/preload.ts` puts one under the whole server:

```sh
TEST_STORE=postgres DATABASE_URL=postgresql://localhost/spools_test bun run test:integration
```

## How it fits together

The framework (`packages/spools/src/crm`, `src/server`, `src/pages`) never imports an
adapter, a vendor's SDK or your app; lint refuses it. It asks for a port
(`yield* Store`), and the one Effect runtime per process is built from the Spool's
adapters (`packages/spools/src/server/runtime/app.ts`). Tests build the same runtime
with stand-ins.
