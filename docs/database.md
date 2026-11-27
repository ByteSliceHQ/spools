# Database

Records and the CRM's own tables are kept through one port, the **store**. Server code
asks it questions in terms of tables and conditions, never SQL or an ORM, so what is
underneath is a choice you make in `src/spool.server.ts`.

| Adapter                | When                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `pglite()`             | Trying a Spool out, development, tests. Postgres inside the server process: nothing to install |
| `postgres()`           | Deployments. Any Postgres 15 or newer (tested on 17): Supabase, Neon, RDS, Fly, your own       |
| `prisma({ contract })` | The same, through the Prisma 8 client, which is a release candidate today                      |

All three pass the same integration tests, and `postgres` and `prisma` read and write
the same tables.

## PGlite

```ts
database: pglite(),                          // in .data/pglite
database: pglite({ dataDir: "memory" }),     // gone when the process ends
```

Its tables are made when it starts and kept up with the config from then on. It only
adds (tables, columns, indexes); it never drops, renames or retypes anything, so a
field you remove from the config leaves its column behind. A required field added to
an object that already has records is left empty on them.

One process can open a data directory at a time. Stop the dev server before
`bun run db:seed`, and use `postgres()` where several instances run.

## Postgres

```ts
database: postgres(),                        // DATABASE_URL, or POSTGRES_URL
database: postgres({ maxConnections: 20 }),
```

- `DATABASE_URL` wins. Without it `POSTGRES_URL` is used, which Supabase's and
  other hosting integrations set.
- `sslmode=require` in the URL means TLS with the certificate checked.
  `sslmode=no-verify` is TLS without checking it. `POSTGRES_URL` with `require` is
  relaxed to `no-verify`, because the Supabase pooler's chain isn't one a client
  trusts.
- On Supabase's transaction pooler (port 6543) prepared statements are turned off.
  Use the session pooler or a direct connection for migrations.

## Schema and migrations

`bun run crm:gen` writes `prisma/schema.prisma` from `crm.config.json`, the system
tables, and any tables your adapters keep. Prisma's CLI migrates a Postgres from it,
whichever adapter the server uses:

```sh
bun run db:push                       # development: make the database match
bun run db:plan -- --name add-tier    # production: write a migration
bun run db:migrate                    # and apply it
```

Every table has row-level security on with no policies, and `spools harden` (which
`db:push` and `db:migrate` run) takes Supabase's Data API roles off them. The app
connects as a privileged role.

## Record scopes

Seven system tables (`activities`, `tasks`, `notes`, `favorites`, `record_folders`,
`file_uploads`, `sequence_runs`) have a nullable `scope` column with an index on it: a copy of
the scope of the record each row hangs off. It is empty and unused unless `crm.config.json`
has [`scopes`](configuration.md#scopes), and an object named there gets an index on its scope
field. Upgrading to the version that added them is one schema change and no data change:
`bun run crm:gen`, then `bun run db:push` in development, or `bun run db:plan -- --name
record-scopes` and `bun run db:migrate` for a production database. When you turn scopes on,
`bun run db:scopes` fills the column in for rows that were already there.

Scopes are kept by a guard every store is behind (`packages/spools/src/server/store/scope.ts`),
so an adapter you write inherits them by building its store with `makeStore`. Code with nobody
signed in reaches a scoped table only inside `asSystem(...)`.

The guard hands your backend the query already narrowed. One part of that is in the order: a
sort by a related record's column (`['company', 'name']`) reaches a backend as
`{ related: ['company', 'name'], where }` when the related object is scoped, and a row whose
related record doesn't meet `where` must sort as a row with no related record. A backend built
on `sqlBackend` gets this from `selectSql`. One that writes its own `ORDER BY` has to write the
condition too (TypeScript stops it building until it handles the new form); the Prisma adapter
writes the same subselect through `relatedOrderText`.

## Using the store

Server code in the framework, and an adapter that keeps its own tables, reach the
database like this:

```ts
import { asc, contains, or } from '../server/store/query'
import { Store } from '../server/store/store'
import { Task } from '../server/store/tables'

const store = yield * Store
const open =
  yield *
  store.find(Task, {
    where: { assigneeId: user.id, completedAt: null },
    filter: or(contains('title', 'call'), contains('title', 'email')),
    order: [asc('dueDate', 'last')],
    limit: 50,
  })
```

`where` is columns that must equal a value, and `null` means empty. `filter` is
anything else: comparisons, text, relations, full-text search
(`packages/spools/src/server/store/query.ts`). A row's TypeScript type follows from its
table, and `update`, `remove` and `lock` refuse to run with no condition of the caller's own,
whoever is asking.

Writes that belong together go in a transaction: everything in it is kept, or none of it.

```ts
const record =
  yield *
  store.transaction(
    Effect.gen(function* () {
      const made = yield* store.insert(Invoice, values)
      yield* store.insert(InvoiceLine, { invoiceId: made.id, ...line })
      return made
    }),
  )
```

A failure, a bug or the request going away undoes what the program had written. Inside one,
`store.lock(table, { where: { id } })` holds a row until the transaction ends, so reading a
row and then writing something that depends on it can't be interleaved with someone else
doing the same. Creating, changing and deleting a record are each a transaction: a record is
never saved without its line on the timeline. Keep a transaction to store calls: code that
reaches the store some other way (an app's hook) is on another connection and doesn't see
what isn't kept yet.

Your own code in `src/app/extensions.ts` uses the promise functions instead
([Extending](extending.md)): `createRecord`, `listRecords` and the rest run hooks, the
timeline and automations, which the store knows nothing about.

## Tests

```sh
bun run test:integration                                  # PGlite, nothing to set up
TEST_STORE=postgres DATABASE_URL=... bun run test:integration
TEST_STORE=prisma   DATABASE_URL=... bun run test:integration
```

Point `DATABASE_URL` at a database made for tests, with the schema pushed
(`bun run db:push`). The tests write to it.
