# Architecture

A Spool is three things put together in `src/spool.server.ts`: a config that describes
your business, your own code, and the services it runs on.

```ts
export default defineSpool({ crm, extensions, auth: clerk(), database: postgres(), ... });
```

The framework is a package, `@swirls/spools`. Your repository holds what is yours and a
thin layer of files that mount the framework's pages and endpoints, so a new version is
a new version number.

## Yours and the framework's

| Yours: edit freely                       | What it is                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `crm.config.json`                        | Your CRM: objects, fields, views, actions, automations, sequences, and your own [guides](guides.md)                     |
| `src/spool.server.ts`, `src/spool.ui.ts` | Your Spool: which [adapters](adapters.md) it runs on                                                                    |
| `src/app/extensions.ts`                  | Handlers, hooks, run-target kinds, email transport, integration providers                                               |
| `src/routes/**`                          | One small file per page and endpoint. Delete one to drop a page, replace one to write your own, add as many as you like |
| `src/styles.css`                         | Brand colours and theme overrides                                                                                       |
| `swirls/**`                              | Your Swirls workflows and assistant                                                                                     |
| `scripts/seed.ts`                        | Demo data                                                                                                               |

| Generated: never edit                                                                        | Source                           |
| -------------------------------------------------------------------------------------------- | -------------------------------- |
| `prisma/schema.prisma`, `prisma/schema.json`, `prisma/schema.d.ts`, `crm.config.schema.json` | `bun run crm:gen`                |
| `src/routeTree.gen.ts`                                                                       | `bun run dev` or `bun run build` |
| `migrations/**`                                                                              | `bun run db:plan`                |

| The framework: `packages/spools` (`@swirls/spools`) | What it is                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/crm/**`                                        | The config contract, field and view registries, the generator, the interface                                                                   |
| `src/server/**`                                     | Records, the service layer, the tool API, sequences, the ports and the Effect runtime (`src/server/runtime/`), the store (`src/server/store/`) |
| `src/adapters/**`                                   | The adapters that ship with it, by port                                                                                                        |
| `src/pages/**`, `src/views/**`                      | Each page's route options, and what it renders (loaded when it is opened)                                                                      |
| `src/api/**`                                        | The handlers behind `/api/*`                                                                                                                   |
| `src/cli/**`                                        | The `spools` command                                                                                                                           |

If you need something the extension points don't cover, open an issue: the aim is
that nobody has to patch the framework.

## Layers

```
Browser ── server functions (server/*.functions.ts) ─┐
Swirls ─── tool API (server/tools.ts) ───────────────┤
Scheduler ─ cron routes (api/*) ─────────────────────┤
                                                     ▼
                    boundary (server/runtime/boundary.ts): who is asking, typed errors, cancellation
                                                     │
                                                     ▼
                    service.ts ─▶ records.ts ─▶ Store ─▶ your database adapter
                        │
                        ├─▶ hooks        (your src/app/extensions.ts)
                        ├─▶ timeline     (activities table)
                        └─▶ automations  (actions.ts ─▶ run targets)

  ports (server/runtime/, server/store/): Auth, Store, FileStore, Email, Vault, Agents,
  each provided by an adapter, with its time limit and retries in one table (policies.ts)
```

Paths on this page are inside `packages/spools/src` unless they start with the name of
one of your own files.

- **The boundary** is where a request becomes an [Effect](https://effect.website)
  program. A server function's handler is `crmHandler(...)` and a route uses an
  adapter (`apiRoute`, `cronRoute`, `publicRoute`, `toolRoute`). It asks the auth adapter for the session and reads the request before the
  program starts, checks the access list, runs the program on the process's one
  runtime, interrupts it if the browser goes away, and turns a typed error into the
  message the page shows. See [Writing server code](server-code.md).
- **Ports** are the only way to the outside. The framework asks for a port
  (`yield* Store`) and never imports an adapter, a vendor's SDK or your app; lint
  refuses it. Each has a stand-in for tests, and its time limit and retries come from
  one table (`policies.ts`). See [Adapters](adapters.md).
- **`records.ts`** is the data layer: config-driven CRUD, search and filters. It
  validates every write against the field definitions.
- **`service.ts`** is what callers use to change records. It wraps the data layer
  with extension hooks, timeline entries and automations, so a change behaves the
  same whether it comes from the UI or the assistant.
- **`views.ts`** merges the views in the config with what users saved in the app,
  and **`workspace.ts`** holds tasks, notes, favourites, reports and CSV export.
  Neither goes through `service.ts`: they aren't config objects, so hooks and
  automations don't apply to them.
- **`actions.ts`** resolves `"run": "<kind>:<name>"` targets through a registry:
  `swirls`, `campaign` and `local` are built in, and extensions can add kinds.
- **Entry points** authenticate, then call the service: server functions check the
  session and the allowlist, and the tool API and the cron routes each
  check a bearer token.
- **Your code stays plain TypeScript.** Hooks and handlers in
  `src/app/extensions.ts` return promises, and the browser never loads Effect.

All of the framework's server code is written with Effect. The few files that stay
plain TypeScript (the Spool itself, the start-up code, the pure SQL compiler) are
listed in `.oxlintrc.json`.

## Registries

Three registries keep features open for extension. Each is typed so the compiler
tells you what's missing.

| Registry    | File                                                                                       | Adds                                                |
| ----------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Field types | `crm/field-types.ts` (schema, column, validation) and `crm/ui/fields.tsx` (display, input) | A new `type` for fields                             |
| View types  | `crm/config-schema.ts` (`viewSchema`) and `crm/ui/views.tsx`                               | A new way to render a list                          |
| Run targets | `runTargets` in your `src/app/extensions.ts`                                               | A new `"<kind>:<name>"` for actions and automations |

See [Extending](extending.md) for worked examples.

## Routes

The CRM is served from the site root. Your `src/routes/_crm/route.tsx` is a pathless
layout: it checks the session, loads the config and renders the shell, and its
children map to `/` (home), `/tasks`, `/notes`, `/reports`, `/workflows`,
`/assistant`, `/<objectKey>` and `/<objectKey>/<id>`. Because an
object's key is the first path segment, keys that would shadow a built-in route
(`tasks`, `api`, `unsubscribe` and so on) are rejected by the config schema, and
an unknown first segment is a 404. `/sign-in` and `/unsubscribe` sit outside the
layout and need no session. `/crm/...`, where the CRM used to live, redirects to
the same page at the root.

### Moving between pages

A click should not wait for anything the browser already has:

- The layout's session check runs before every navigation and every link the
  pointer rests on, so the browser keeps the session it was given (who is signed
  in, the config, the team, favourites, the task count) and reuses it, checking
  again in the background once a minute. The same memory holds what relation
  pickers were given for a search, for a minute, so opening one twice asks once.
  It lives in `crm/memory.ts` and is wired up in `crm/ui/session.ts`. It is a convenience, not access control: every server
  function still checks the session itself, and nothing is remembered on
  the server.
- A page's data is reused for 15 seconds, so going back and forth costs nothing.
  After that the page is still shown at once, as it was, and refreshed behind
  (`defaultStaleTime` in `crm/ui/router.tsx`). Data fetched when a link is hovered is
  used by the click that follows.
- Anything that changes data calls `router.invalidate()`, which reloads what is on
  screen and forgets the remembered session and titles. A change made by a
  teammate shows up the next time the page is fetched.
- A list brings back a related record's id and title only, and a board only the
  fields its cards show (`relations` and `fields` in `listRecords`). Titles for
  many records are fetched together (`recordTitlesOf`).
- Guides cost no request to offer: what each person has seen of them comes with
  the session. See [Guides](guides.md#how-it-works).
- Search matches records in the browser. After the first page has loaded, the
  browser fetches every record's title and unencrypted searchable fields once
  and keeps them in memory (`searchIndex` in `crm/ui/session.ts`), so a key
  press in Cmd+K costs no request. After a change it asks only for what changed
  since. Notes, emails, calls and tasks are searched on the server once typing
  pauses. See [Search and filters](search-and-filters.md#how-it-works).
- A page never carries the records a relation could point at. The picker
  (`crm/ui/relation-picker.tsx`) asks for one page of 50 titles when it is
  opened and searches the server as you type (`searchTitles`), so an object with
  thousands of records costs the same as one with ten, and any of them can be
  chosen. A list sends the titles of the records its filters name, and nothing
  else.

## Request flow: a new record

1. Someone creates a contact in the CRM (or the assistant does, through the tool
   API). The entry point checks who is asking, then calls `service.createRecord`.
2. `service.createRecord` runs `beforeCreate` hooks, validates and inserts the
   record, writes a timeline entry, runs `afterCreate` hooks, then fires
   `contacts.created` automations.
3. The `swirls:new_contact` automation starts a Swirls workflow with
   `{ objectKey, record, actor, trigger }`.
4. The workflow qualifies the contact with AI, emails your team, and writes its
   summary back through `POST /api/swirls/tools/add_note`, which saves a note on
   the record.

## Data model

Every object in the config becomes a table with real, typed columns, plus `id`,
`created_at`, `updated_at`, `created_by`, and three dates kept from the record's
activities and tasks so that lists can filter and sort by them:
`last_activity_at`, `last_contacted_at` and `next_task_due` (`refreshStats` in
`server/records.ts`). These system tables are always present (`server/store/tables.ts`), and an adapter may add its own:

| Table                | Holds                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `activities`         | The timeline for any record. Full-text indexed (`activities_search`) for search                                           |
| `tasks`              | To-dos with a due date and assignee, optionally linked to a record                                                        |
| `notes`              | Titled notes, optionally linked to a record. Full-text indexed (`notes_search`) for search                                |
| `saved_views`        | Views created in the app, and in-app changes to config views                                                              |
| `favorites`          | Each user's starred records                                                                                               |
| `email_suppressions` | Addresses that bounced, complained or unsubscribed                                                                        |
| `mailbox_sync`       | How far the mail and calendar sync has read each of a teammate's mailboxes. No credentials                                |
| `record_folders`     | Which folder in the file store is a record's own. The folders and files themselves are in the store                       |
| `file_uploads`       | A file on its way into the store, until the store confirms it                                                             |
| `integrations`       | Accounts teammates connected on the Integrations page, with their OAuth tokens sealed by the vault before they are stored |
| `sequence_runs`      | Each record's place in an email [sequence](campaigns.md): which email is next and when it is due                          |
| `guide_progress`     | Which [guides](guides.md) each person has finished or dismissed, so each is offered once                                  |

All tables have row-level security enabled with no policies. The app connects as a
privileged role, which bypasses RLS. Supabase's Data API roles get nothing.
