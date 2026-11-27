# Agent instructions

## Commits

Every commit must follow the [Conventional Commits](https://www.conventionalcommits.org/)
specification:

```text
<type>(optional-scope): <imperative summary>
```

Use one of these types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`,
`revert`, `style`, or `test`.

- Keep the summary concise, lowercase, and free of a trailing period.
- Use `feat` for new user-facing behavior and `fix` for user-facing bug fixes.
- Use `!` before the colon and a `BREAKING CHANGE:` footer for breaking changes.
- Do not create commits such as `Update files`, `WIP`, or `Release package`.
- Give pull requests a Conventional Commit title so squash merges remain compliant.
- Run the repository's verification commands before committing.

## The repository

This repository is a framework, an app that uses it, and the website. The framework is
`packages/spools` (`@swirls/spools`). `apps/starter` is a working Spool: a config-driven CRM
served from `/`, where the framework is developed. `packages/create-spools` makes a new app
from it. `apps/docs` is the website, whose documentation is `docs/`. Stack: TanStack Start
(Vite), Effect, Tailwind v4, and whichever services the Spool chose. This file is the map for
coding agents. Read `docs/architecture.md` first.

In the rest of this file `P` is `packages/spools/src`, and a path that starts with `src/`,
`swirls/`, `prisma/` or `crm.config.json` is in `apps/starter`.

## Golden rules

- **The CRM is defined by `crm.config.json`.** Objects, fields, views, actions,
  automations, campaigns and an app's own guides live there (contract:
  `P/crm/config-schema.ts`, docs: `docs/configuration.md`). After editing it, run
  `bun run crm:gen` then, if `DATABASE_URL` is set, `bun run db:push`. Never hand-edit
  `prisma/schema.prisma`, `prisma/schema.json`, `prisma/schema.d.ts` or
  `crm.config.schema.json`: they're generated, and CI fails if they drift.
- **A Spool chooses its services in `src/spool.server.ts`** (`defineSpool`), and auth's
  browser half in `src/spool.ui.ts`. The framework asks for **ports** (`Store`, `Auth`,
  `FileStore`, `Email`, `Vault`, `Agents`) and never imports an adapter, a vendor's SDK
  or the app: lint refuses it. Adapters are in `P/adapters/<port>/<name>`
  (`docs/adapters.md`).
- **Extend, don't patch.** App-specific server code goes in `src/app/extensions.ts`
  (handlers, hooks, run-target kinds, email transport, integration providers, the file
  layout). Only change `packages/spools` when adding a framework capability.
- **Write through `P/server/service.ts`** (`createRecord`, `updateRecord`,
  `deleteRecord`): it runs hooks, the timeline and automations. `records.ts` is the raw
  data layer underneath; use it directly only for reads and activities.
- **The database is the `Store`** (`docs/database.md`): `find`, `first`, `count`,
  `insert`, `update`, `remove` over tables (`P/server/store/tables.ts`, an object's from
  `objectTable(key)`), with conditions from `P/server/store/query.ts`. No SQL, no ORM.
  `update` checks and changes in one step and says how many rows it changed. Anything
  new must work on every store: run the integration tests on each (`TEST_STORE`).
- **All data access goes through `P/server`.** Components call server functions
  (`P/server/*.functions.ts`) and never import server modules. Every CRM server
  function's handler is `crmHandler(...)`, which checks the session and the allowlist,
  and every `/api` handler uses a route adapter (`apiRoute`, `cronRoute`,
  `publicRoute`, `toolRoute`) from `P/server/runtime/boundary.ts`.
- **Server code is written with Effect** (docs/server-code.md). Export
  `Effect.fn("module.name")(function* () { ... })`, fail with a typed error from
  `P/server/runtime/errors.ts` (its `message` is what staff read), and read env through
  `Config`. Lint refuses the old way (promises, `throw`, `fetch`, `process.env`)
  everywhere but the few files `.oxlintrc.json` leaves out. Effect never goes in browser
  code or `src/app/**`.
- **The app's config and extensions come from the Spool** (`spool()`, `crmConfig()`,
  `getObject(key)` in `P/server/spool.ts`), read when they are used. There is one Spool
  per process.
- **Agents never touch the database.** Workflows and the assistant call the tool API
  (`P/server/tools.ts`). Add a capability there, then a tool workflow in
  `swirls/assistant.swirls`.
- **A page is three pieces**: route options in `P/pages/<name>.tsx`, what it renders in
  `P/views/<name>.tsx` (loaded lazily; reaches its route with `getRouteApi`), and a
  three-line file in `src/routes` that mounts it. An endpoint is handlers in
  `P/api/<name>.ts` and its file in `src/routes/api`. A new page or endpoint needs the
  route file here, and a line in the changeset telling apps to add it.
- **Browser code imports `P/crm/naming.ts` for helpers**, not `config-schema.ts`
  (which pulls Zod and the config schema into the browser bundle). Type-only
  imports are fine. Pages reach the auth provider with `useAuth()` (`P/crm/ui/auth.tsx`).
- **System columns.** Every object's table has `createdAt`, `updatedAt`,
  `createdBy`, `lastActivityAt`, `lastContactedAt` and `nextTaskDue`
  (`SYSTEM_COLUMNS` in `P/crm/filters.ts`). They can be shown, sorted and
  filtered, not edited, and their names can't be used as field keys.
- **System tables** are described in `P/server/store/tables.ts`, not the config. They
  aren't CRM objects: no hooks or automations, and their keys (`tasks`, `notes`,
  `reports`, `workflows`, `integrations`, `marketing`, `files`, `assistant`) can't be used as object
  keys. An adapter may add its own (`tables`), which must not depend on the environment.
- **Timeline summaries are sentence fragments** that follow the actor's name
  ("changed Stage to Won", "added a note: Pricing call"): lower-case, no full stop.
- **Single business per deployment**, deny-by-default `access` allowlist, no roles.
- **Encryption:** fields marked `"encrypted"` are stored as plaintext because
  `@cipherstash/stack-prisma` 1.2.1 only supports Prisma Next 0.17, not Prisma 8.
  `crm:gen` warns about each one. Don't remove the markers.

## Where things go

- **CRM object, field, view, action, automation, campaign.** `crm.config.json` → `bun run crm:gen` → `bun run db:push`
- **App-side action handler (`"run": "local:<name>"`).** `handlers` in `src/app/extensions.ts`
- **Record lifecycle logic (validate, react to changes).** `hooks` in `src/app/extensions.ts`
- **New run-target kind (`"run": "<kind>:<name>"`).** `runTargets` in `src/app/extensions.ts`
- **New field type.** `P/crm/field-types.ts` + `P/crm/ui/fields.tsx` (compiler lists what's missing)
- **New view type.** `viewSchema` in `P/crm/config-schema.ts` + `P/crm/ui/views.tsx`
- **Pipelines: dependent select options (`dependsOn`, `when`), win `probability`.** Rules in `P/crm/options.ts` (no Zod, shared by server and client); enforced on every write in `P/server/records.ts`
- **Swirls workflow (`"run": "swirls:<name>"`).** `swirls/<name>.swirls`, root `inputSchema: crm_event`; validate with `swirls doctor`. Started by `Agents.executeWorkflow` (the port `P/server/runtime/agents.ts`; the Swirls adapter `P/adapters/agents/swirls`: workflow ids cached a minute, the `agentsRead`/`agentsRun` policies; a start is never retried)
- **Assistant capability.** A tool in `P/server/tools.ts` (each returns an Effect; a typed failure reaches the agent as `{ ok: false, error }`), served by `toolRoute` at `/api/swirls/tools/*`, + a tool workflow in `swirls/assistant.swirls`
- **The Ask page (the assistant's chat).** `P/pages/assistant.tsx` and `P/views/assistant.tsx`, parts `P/crm/ui/assistant.tsx`, pure helpers (chat groups, titles, tool steps, linked records) `P/crm/assistant.ts`. Its chats are listed in the shell's sidebar in place of the navigation (`OWN_SIDEBAR` and `useShell().panel` in `P/crm/ui/shell.tsx`). The agent engine keeps the chats; the server side gets one only through `Agents.chat` (`P/server/runtime/agents.ts`), which `E2E_ASSISTANT=stub` swaps for canned replies (`e2e/assistant-stub.ts`). Name, greeting and suggested prompts: `assistant` in `crm.config.json`. docs/swirls.md#the-assistant
- **Email sequences (campaigns).** When each email is due, and sending hours, in `P/crm/sequences.ts` (pure). The engine is `P/server/campaigns.ts`: an enrolment is a row in `sequence_runs`, and `tick` sends what is due. `startSequences` forks `sequenceSchedule` (a tick now, then once a minute) on a server that stays up; on a serverless host a cron job calls `/api/cron/sequences` (`P/api/sequences.ts`). Nothing is kept in memory or on disk. A run is taken with one `Store.update` that checks and changes it (`hold`), never by reading then writing, or two ticks send the same email. Every send carries an `idempotencyKey`, and only a send that has one is retried (the `resend` policy). Transport: the app's `email.send`, else the `Email` port (`P/server/runtime/email.ts`); templates, unsubscribe tokens and suppression in `P/server/email.ts`; unsubscribing in `P/server/email.functions.ts`. Tests replace `Email` and `Sequences` (`P/server/sequences.ts`) through `installStandIns`; docs/campaigns.md
- **Generic CRM UI.** `P/crm/ui/*` (`kit.tsx` primitives, `shell.tsx`, `views.tsx`, `workspace.tsx`), pages `P/pages`, `P/views`; their files `src/routes/_crm/**` (a pathless layout: they map to `/`, `/tasks`, `/$object`)
- **CRM colours.** Override `.crm { --c-accent: … }` in `src/styles.css`; tokens are in `P/crm/ui/theme.css`
- **Saved views, footer calculations.** `P/server/views.ts`
- **Speed of moving between pages.** The browser keeps the session and what relation pickers were last given between pages (`P/crm/memory.ts`, pure; wired in `P/crm/ui/session.ts`), and the router reuses a page's data for a few seconds and refreshes it behind after that (`P/crm/ui/router.tsx`). After any change, call `router.invalidate()`: it reloads the page and forgets what was remembered. Lists ask for related records by title only (`relations: "titles"` in `listRecords`) and boards for the card's fields only (`fields`); look up many titles with `recordTitlesOf`, never one `getRecord` per row. On Vercel or another serverless host (`config.serverless`), `/api/cron/warm` keeps the function from going cold (docs/deployment.md)
- **Logged calls and meetings, team activity report.** Kinds, outcomes, date ranges and the per-person counts in `P/crm/activity.ts` (pure, shared); storage and queries in `P/server/workspace.ts`
- **Teammates' mail and calendar, sending from their mailbox.** Through the Google or Microsoft account they sign in with (the auth provider keeps its tokens) and any mailbox they connected on the Integrations page. Scopes and what they allow in `P/crm/mailbox.ts` (pure, shared); sign-in accounts and the auth provider's tokens through the `SignIns` service (`P/server/sign-ins.ts`); accounts from both sources, tokens, provider calls (the `mailApi` policy: reads retried on 429/5xx with `Retry-After`, sends never repeated) and sending in `P/server/mailbox.ts`; provider readers (Gmail, Graph), matching addresses to records, `ingest` and the schedule (`syncSchedule`, a fiber started by `startSync` in `src/server.ts`) in `P/server/sync.ts`; cron entry `src/routes/api/cron/mail-sync.ts`; panel `P/crm/ui/mailbox.tsx`. Synced activities carry `externalId` and go through `addActivityOnce`; docs/mailbox.md
- **Files.** A file browser over the `FileStore` port (`P/server/runtime/files.ts`), whose adapters are `P/adapters/files/*`. Names and limits in `P/crm/files.ts` (pure, shared); breadcrumbs, listing, record folders (`record_folders`), uploads (`file_uploads`) and the library in `P/server/files.ts`; server functions `P/server/files.functions.ts`; handlers `P/api/file.ts`, `P/api/upload.ts`; the browser `P/crm/ui/files.tsx`, used by the Files page and a record's Files tab. An object opts in with `files: { folders, under }`; top-level `files` names the shared library. Tests of the FlashDrive adapter use ``createFakeStore`from`@swirls/spools/testing` (`P/testing/fake-file-store.ts`)`; an app's hooks reach record folders through `@swirls/spools/extensions`; docs/files.md
- **Accounts teammates connect (more mailboxes, other services).** OAuth flow, token refresh and the built-in Google and Microsoft providers in `P/server/integrations.ts`; tokens are sealed by the `Vault` port (`P/server/runtime/vault.ts`; adapters `P/adapters/vault/*`; no plaintext fallback) before they reach the `integrations` table; token exchange and refresh go through `HttpClient` with the `oauth` policy. Handlers `P/api/integration-*.ts`, page `P/pages/integrations.tsx`. An app adds a provider under `integrations` in `src/app/extensions.ts` and gets tokens from `getAccessToken` in `@swirls/spools/extensions`. Tests use `Vault.layerTest` through `installStandIns`; docs/integrations.md
- **Marketing: the website's tags, social posts, ad results.** Set up under `marketing` in `crm.config.json`, which is what makes the Marketing page appear. Tags (how each is found in a page, its install code), post limits and UTM parameters in `P/crm/marketing.ts` (pure, shared). The engine is `P/server/marketing.ts`: the site scan (the `website` policy), posts (`marketing_posts`) and ad results (`marketing_ads`). Networks are a registry (`P/server/marketing-networks.ts`): the built-in ones (linkedin, x, facebook; meta, google) call each API through `HttpClient` with the `marketingApi` policy (reads retried, a post never), and an app adds or replaces one under `marketing` in `src/app/extensions.ts`. A network gets its token from the environment or from a teammate's connection (`accessToken`); the OAuth providers for the built-in ones are in `P/server/marketing-providers.ts` and are offered on the Integrations page only while the config uses them. A channel or ad account is reached `direct` (that code) or `via: "swirls"` (`publish_<network>` / `ads_<network>` through `Agents.executeWorkflow`, answered by the tools `post_result` and `save_ads`); `site_profile` is always a workflow. A post is taken with one `Store.update` (`hold`) and never sent twice: a `NetworkFailure` that is `uncertain` leaves a note to look at the channel first. Scheduling and publishing are server functions only (`P/server/marketing.functions.ts`): the tool API can draft and nothing more. `tick` publishes what is due (`startMarketing`, or `/api/cron/marketing` on a serverless host). Tests replace `MarketingSource` (`P/server/marketing-source.ts`), `Agents` and `fetch` through `installStandIns`. Workflows: `swirls/marketing.swirls` (`site_profile`) and `examples/swirls/marketing-networks.swirls` (every network, for `via: "swirls"`); docs/marketing.md
- **Tasks, notes, favourites, reports, CSV export.** `P/server/workspace.ts` + `P/server/workspace.functions.ts`; CSV parsing in `P/crm/csv.ts`
- **Choosing a related record.** `P/crm/ui/relation-picker.tsx`: `RelationInput` (forms), `RelationPopover` (inline editing), `RelationSearch` (the list filter). It searches the server as you type (`searchTitles` in `P/server/records.ts`, through `searchRelationFn`); never send a page the list of records a relation could point at. A value known only by its id gets its title from `titles` when the page has it (a list sends the ones its filters name) or from `relationTitlesFn`. CSV import matches names on the server (`matchTitles`)
- **Many-to-many relations (`"type": "relations"`).** A field with no column: its links are rows of a table of their own, described in `P/server/store/objects.ts` (`linkTables`, `linkSide`: which column is this record's, which the other's, and the relation from the object's table to its links). Names, limits and which side owns the table (the one without `inverse`) in `P/crm/links.ts` (pure, shared). Only `P/server/records.ts` reads and writes links (`withLinks`, `writeLinks`, `removeLinks`), through the store with ordinary conditions; `changeRecord` says what a write linked and let go, which `service.ts` puts on the timeline. Written as `<field>Ids`: a list replaces the set (refused when the record holds more than a read shows), `{ add, remove }` changes it, and the interface always sends the second (`P/crm/links-form.ts`, pure: the change a form sends, and whether a picker knows a record is held). A write to links happens with both ends held: `holdRecord` takes the record and the records the change names in one order (by table name, then id), which is what keeps the same pair linked from both sides at once from deadlocking or being written twice; never hold one end and then the other. Their tests run on a Spool of their own (`packages/spools/tests/support/relations-spool.ts`), which on Postgres needs `bun run db:push:relations` first. Filters (`anyOf`, `allOf`, `noneOf`) compile to `related` conditions in `P/server/filter-query.ts`. The picker is `RelationsInput` in `P/crm/ui/relation-picker.tsx`. A field key must never reach a store `select`, order or `where` unless its type has a column (`fieldTypes[type].column`)
- **Record CRUD.** `P/server/records.ts` (data) under `P/server/service.ts` (hooks, timeline, automations)
- **Filters and sorting.** What a condition is, the operators each field type has (and each encryption mode allows), relative dates and `cleanFilters` in `P/crm/filters.ts` (pure, shared). `P/server/filter-query.ts` turns conditions into a store predicate for `listRecords` and `countMatching`. Everything that arrives from a page address, a saved view, the config or the assistant goes through `cleanFilters` first: it drops what the config doesn't allow and cuts a filter back to the size limits declared beside it (a filter fits in a link, so its cost must be bounded). Server function validators check shape only and never refuse a filter for its size or contents. The filter box, chips and editors are `P/crm/ui/filter-bar.tsx`; what typed text offers is `P/crm/suggest.ts` (pure). Filters and sort a person changes live in the list page's address (`f`, `s`) until saved to the view. docs/search-and-filters.md
- **Search (Cmd+K).** Records are matched in the browser against an index of titles and unencrypted `searchable` fields: matching, ranking and the index store in `P/crm/search.ts` (pure), built by `quickIndex` in `P/server/search.ts`, held by `searchIndex` in `P/crm/ui/session.ts`. Never put an `encrypted` field other than the title in it, nor long text. Notes, emails, calls and tasks are searched by `deepSearch` (Postgres full-text indexes declared in `P/crm/codegen.ts`). The palette is `P/crm/ui/search.tsx`
- **Guides (the tours that show people around).** What a guide is, the built-in ones, which is offered where and the config checks in `P/crm/guides.ts` (pure, shared). An app replaces, turns off or adds guides under `guides` in `crm.config.json`, never in framework files; the welcome is offered first, then guides for one object, then the rest. Steps point at `data-guide` anchors (listed in `ANCHORS`); a step whose anchor is missing from the page is left out, so write each step to be true whenever its anchor is there. What each person has finished or dismissed is the `guide_progress` table (`P/server/guides.ts`, server functions in `P/server/guides.functions.ts`, which take no user id); it reaches the browser with the session, so offering a guide must never add a request. The offer, the step card and the Help menu are `P/crm/ui/guides.tsx`: nothing in it may be modal or take focus unasked. `CRM_GUIDES=off` stops offers (the e2e harness sets it). When a page gains or loses something a guide mentions, update the guide and docs/guides.md with it
- **Last activity, last contacted, next task due.** Columns on every object's table, recomputed by `refreshStats` in `P/server/records.ts` whenever an activity or task is written (`addActivity`, the task functions in `workspace.ts`). Which activity kinds count is in `P/crm/filters.ts`. Write activities through `addActivity`, or run `bun run db:stats` afterwards (it exits non-zero if any object fails)
- **Tables and the schema.** Described in `P/server/store/tables.ts` (system) and `objects.ts` (from the config). `P/crm/codegen.ts` (pure) turns them into Prisma's schema for `spools gen` (`P/cli/gen.ts`); `P/server/store/schema-sql.ts` into the SQL PGlite makes for itself. A change here must leave `prisma/schema.json` as it was unless it means to change the database
- **A database adapter, or the store port.** `P/server/store/store.ts` (the port, `Backend`, `makeStore`), `sql.ts` (conditions as Postgres SQL, pure), `sql-store.ts` (a store over Effect's `SqlClient`); adapters `P/adapters/database/*`; what a store promises is `packages/spools/tests/unit/store.test.ts`. docs/database.md
- **Auth.** The port `P/server/runtime/auth.ts` (directory, `session`, `handle`) and `P/crm/ui/auth.tsx` (browser half); adapters `P/adapters/auth/*`. Who may use the CRM is `P/server/users.ts`, from the config's access list and the verified email. docs/auth.md
- **What an app may import.** `exports` in `packages/spools/package.json`
- **What a new Spool starts as.** `apps/starter`, through `packages/create-spools/scripts/template.ts`, with `packages/create-spools/overrides` on top. `bun run check:package` makes one from the packed packages and runs it
- **Env vars.** `.env.example`, the `Config` declaration (and `features` entry, for the boot report) in `P/server/runtime/config.ts`; required ones in `P/server/env.ts`
- **New server module.** `P/server/<name>.ts` with `Effect.fn` functions; tests use `run`/`failure` (integration) or `testRuntime` with fake layers (unit) from `@swirls/spools/testing` (`P/testing/run.ts`). docs/server-code.md
- **New server function or API route.** `.handler(crmHandler("name", ({ data, user }) => program))` (or `publicHandler` for signed-out pages); routes use an adapter from `P/server/runtime/boundary.ts`. Lint enforces both
- **Errors staff see.** A `Schema.TaggedError` with a staff-readable `message` (shared ones in `P/server/runtime/errors.ts`, a module's own next to it), added to `StaffError`. The boundary shows the message as it is; anything else is logged in full and rethrown
- **New outside service, time limits and retries.** A port in `P/server/runtime/` with a stand-in, an adapter in `P/adapters/<port>/<name>` (only it imports the SDK; HTTP goes through Effect's `HttpClient`, never `fetch`), a row in `policies.ts` (`withPolicy`), its option in `defineSpool` and its layer in `appLayer` (`runtime/app.ts`)
- **Calling Effect code from promise code.** `src/app/extensions.ts`: `@swirls/spools/extensions` (`P/server/extension-api.ts`). Scripts: `runServer(program)` and `disposeRuntime()` from `P/server/runtime/app.ts`. Never `await` a framework function directly: it returns an Effect, and awaiting it does nothing
- **Calling promise code from Effect code.** The app's own hooks, handlers and settings: `fromHook` (`runtime/errors.ts`)

## Commands

At the root, over every workspace:

```sh
bun run dev                # the starter on :3000 and the website on :8788
bun run demo               # the starter alone
bun run docs               # the website alone
bun run verify             # everything below
bun run check-types
bun run test               # unit tests
bun run test:integration   # the server on PGlite; TEST_STORE=postgres|prisma with DATABASE_URL for the others
bun run lint               # oxlint
bun run fmt                # oxfmt, in place
bun run check:package      # builds and packs the packages, makes a new Spool from them and runs it
bun run changeset
```

`bun run test:e2e` runs the browser tests (Playwright, Chromium) in `apps/starter/e2e/tests` against the stubbed-sign-in build, on seeded databases of their own; it is not part of `verify`, and CI runs it as the `e2e` job.
The first run needs `bunx playwright install chromium`. When a page's roles, labels or wording change, change the tests that read them.

In `apps/starter`:

```sh
bun run dev          # http://localhost:3000; with no keys set, PGlite and the development sign-in
bun run db:seed      # demo data
bun run crm:gen      # config -> Prisma schema + JSON Schema + contract emit (spools gen)
bun run db:push      # sync the database at DATABASE_URL to the contract (prisma db update)
bun run db:stats     # refill last activity / last contacted / next task due
bun run swirls:check # swirls doctor
bun run build && bun run start   # production server (server.prod.ts)
bun run demo         # built copy on localhost:3100 with the development sign-in; for tunnels (HOST=:: for the whole network), never for production or real data
```

Bun loads `.env` from the folder a command runs in, so the app's is `apps/starter/.env`.
`DATABASE_URL` in a command's environment wins over it, and an empty one means PGlite
(`DATABASE_URL= bun run dev`). Check what it points at before running anything that writes.

## Bun, Vite and the server

- Bun is the package manager, script runner, test runner and runtime
  (`bunx --bun vite`). TanStack Start requires Vite, so use Vite for the app
  rather than `Bun.serve()` HTML imports. Prefer Bun APIs elsewhere (`Bun.file`,
  `Bun.$`, `bun:test`, `bun:sqlite`).
- Run the Prisma CLI as `bun --bun x prisma …` so Bun loads `.env` (Node won't,
  and there's no dotenv).
- `src/server.ts` is the custom Start server entry: it defines the Spool, then
  `serveSpool` (`P/server/entry.ts`) logs the env report and starts the two schedules
  (sequence emails, mailbox sync). `server.prod.ts` serves `dist/` with
  `Bun.serve`, and on SIGTERM/SIGINT stops taking requests and disposes the Effect
  runtime (closing the database pool).
- One Effect runtime per process (`runtime()` in `P/server/runtime/app.ts`), built on
  first use and kept on `globalThis`, so a dev reload doesn't open a second pool.
- Production must run with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` (set in
  `bun run start` and the Dockerfile). Otherwise Bun can reuse modules transpiled
  in dev mode and SSR crashes with `context._currentValue`.

- In this repository `@swirls/spools` is its source, so a change shows at once. What npm gets
  is `packages/spools/dist`: JavaScript and declarations, built by
  `packages/spools/scripts/assemble.ts`. Either way TanStack Start compiles its server
  functions, because it has `@tanstack/react-start` as a peer dependency. Files named
  `*.server.ts` can't be imported by browser code, and `*.client.ts` can't be imported
  by the server: that is why the browser halves are in `spool.ui.ts`.
- `bunfig.toml` uses hoisted installs so the app and the framework share one React.
- `packages/spools` is type-checked with the starter's generated route tree, which is how a
  view knows its page's data.

## Prisma 8 notes

Prisma migrates every Postgres, and is one of the database adapters
(`P/adapters/database/prisma`).

- Schema files must start with `// use prisma-8`.
- Row-level security is declared with `@@rls` on every model (Prisma reverts RLS
  that's only set in SQL). `spools harden` revokes the Supabase API roles.
- Generated ids use `@onCreate(uuid())`. Dates are `DateString`, money is
  `NumericString(14, 2)` (both come back as strings).
- Its raw SQL refuses `null` and `Date` parameters; `store/sql.ts` writes them out.
- Server functions can't return `unknown`-typed values (Start checks
  serializability): give records concrete types, or JSON-encode.

## Swirls DSL

Use the `swirls-lang` skill before writing `.swirls` files, and run
`swirls doctor` after. HTTP nodes can't reach private addresses, so local
write-backs need a tunnel (see `docs/swirls.md`).
