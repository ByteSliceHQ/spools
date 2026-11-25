# Writing server code

The framework's server side (`packages/spools/src/server`, `src/api` and
`src/adapters` beside it) is written with [Effect](https://effect.website) 4. This
page is for changing it; a Spool's own code in `src/app/extensions.ts` is plain
TypeScript, and its hooks and handlers return promises. Effect never reaches the
browser.

Every server module, server function and API handler is written this way.
`.oxlintrc.json` lists the few files the rules leave out, each for a reason: the runtime
folder (it is where the request and the environment are touched), `env.ts`,
`spool.ts` and `entry.ts` (which run before there is a runtime), and `store/sql.ts`
(pure, with no database of its own).

## Why

- **Failures are in the type.** A function's type says what it can fail with,
  and the compiler won't let a server function fail with something staff can't
  read.
- **Outside services have limits.** Every call to the auth provider, the database,
  the file store, Gmail, Graph, the email provider, the agent engine and the vault has
  a time limit and, where repeating it is safe, retries. They are in one table:
  `packages/spools/src/server/runtime/policies.ts`.
- **Tests swap services, not globals.** A test provides a fake layer for a
  service; nothing is patched on a module and left behind for the next test.
- **When the browser goes away, the work stops.** The program is interrupted
  and its cleanup runs.

## The pieces

| File                                                                   | What it is                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/spools/src/server/runtime/errors.ts`                         | The errors staff can see (`Unauthorized`, `NotFound`, `Invalid`, `NotConfigured`, `DatabaseError`, `AuthError`, `Timeout`) and the `StaffError` union                                      |
| `packages/spools/src/server/runtime/config.ts`                         | Every environment variable, as an Effect `Config`, and the feature list behind the boot report                                                                                             |
| `packages/spools/src/server/runtime/policies.ts`                       | Time limits and retries for each outside service, and `withPolicy`                                                                                                                         |
| `packages/spools/src/server/runtime/adapter.ts`                        | What an adapter is: its layer, what it requires of the environment, the tables it keeps                                                                                                    |
| `packages/spools/src/server/spool.ts`                                  | `defineSpool`, and this process's Spool: `spool()`, `crmConfig()`, `objectTable(key)`                                                                                                      |
| `packages/spools/src/server/store/store.ts`                            | `Store`: the database, as find, count, insert, update and remove over tables ([Database](database.md))                                                                                     |
| `packages/spools/src/server/store/query.ts`, `tables.ts`, `objects.ts` | Conditions and order as data; the system tables; an object's table, from the config                                                                                                        |
| `packages/spools/src/server/runtime/auth.ts`                           | `Auth`: the auth provider's directory, with a fake (`Auth.layerTest`)                                                                                                                      |
| `packages/spools/src/server/runtime/files.ts`                          | `FileStore`: folders, files and uploads                                                                                                                                                    |
| `packages/spools/src/server/runtime/agents.ts`                         | `Agents`: starting workflows and the assistant's chat                                                                                                                                      |
| `packages/spools/src/server/runtime/http.ts`                           | The HTTP client (Effect's `HttpClient` over fetch) every outside service uses, and `appLayer({ fetch })` for a stand-in. A request is aborted when its program is interrupted or times out |
| `packages/spools/src/server/runtime/vault.ts`                          | `Vault`: sealing and opening secrets, with `Vault.layerTest(cipher)` for tests                                                                                                             |
| `packages/spools/src/server/sign-ins.ts`                               | `SignIns`: the Google and Microsoft accounts teammates sign in with, and the auth provider's tokens for them, with `SignIns.layerTest`                                                     |
| `packages/spools/src/server/users.ts`                                  | `Users`: who may use the CRM, the team, sign-in accounts                                                                                                                                   |
| `packages/spools/src/server/runtime/app.ts`                            | `appLayer()` (every service, from the Spool's adapters or a test's stand-ins), the one runtime per process, `runServer` for code on promises                                               |
| `packages/spools/src/server/runtime/boundary.ts`                       | `crmHandler`, `publicHandler`, `apiRoute`, `cronRoute`, `publicRoute`, `toolRoute`: where TanStack Start hands a request to a program                                                      |
| `packages/spools/src/server/runtime/request.ts`                        | `CurrentRequest`: the request's headers, abort signal and session, set by the boundary                                                                                                     |
| `packages/spools/src/server/runtime/email.ts`                          | `Email`: sending, and reading delivery webhooks, with `Email.layerTest(sender)`                                                                                                            |
| `packages/spools/src/server/sequences.ts`                              | `Sequences`: the campaigns the CRM runs, from the config, with `Sequences.layerTest`                                                                                                       |
| `packages/spools/src/server/extension-api.ts`                          | The framework as promises, for `src/app/extensions.ts` and scripts                                                                                                                         |

## A module

```ts
import { Effect } from 'effect'

import { Invalid } from './runtime/errors'
import { Store } from './store/store'
import { GuideProgress } from './store/tables'

/** The ids of the guides this person has finished or dismissed. */
export const seenGuides = Effect.fn('guides.seenGuides')(function* (userId: string) {
  const store = yield* Store
  const rows = yield* store.find(GuideProgress, { where: { userId } })
  return rows.map((r) => r.guideId)
})

export const markGuide = Effect.fn('guides.markGuide')(function* (userId: string, guideId: string) {
  if (!isGuideId(guideId)) return yield* new Invalid({ message: `Unknown guide "${guideId}"` })
  // ...
})
```

- Export `Effect.fn("module.name")(function* () { ... })`. The name becomes a
  span, so a slow request shows which call was slow.
- Fail with `return yield* new SomeError(...)`, never `throw`. The `return`
  tells TypeScript the function stops there.
- Ask for a service with `yield* Store`. Don't import an adapter, the app, `fetch`, a
  vendor SDK or `process.env`: lint refuses them outside `packages/spools/src/server/runtime/`.
- Reads have a time limit and writes have none, because giving up on a write leaves
  its outcome unknown. To expect a particular failure, such as a unique index keeping
  one row, catch `DatabaseError` and check:

  ```ts
  yield *
    store
      .insert(GuideProgress, row)
      .pipe(
        Effect.catchTag('DatabaseError', (error) =>
          Effect.flatMap(existing, (found) => (found ? Effect.void : Effect.fail(error))),
        ),
      )
  ```

- The app's config and extensions come from the Spool (`spool()` in `spool.ts`), read
  when they are used.

- Read a variable with `yield* config.read(config.guidesOffered)`, declared in
  `runtime/config.ts`. Use `Config.Redacted` for secrets and `Config.option` for
  optional ones. Values are read from the environment each time, as
  `process.env` was before, so a variable set while the process runs takes
  effect at once.

## A server function

```ts
export const markGuideFn = createServerFn({ method: 'POST' })
  .validator(guides.markInput)
  .handler(
    crmHandler('markGuide', ({ data, user }) =>
      guides.markGuide(user.id, data.id, data.outcome).pipe(Effect.as({ ok: true })),
    ),
  )
```

`crmHandler` checks the session and the access list, then runs the
program with the validated `data` and the signed-in `user`. There is no other
way for a program to learn who is asking, and nothing inside an Effect asks the auth
adapter for the session or calls `getRequest()`: they belong to the request, and the
boundary reads them before the program starts. `publicHandler` is for the few functions
signed-out pages call; nothing staff-only belongs there.

Validators stay Zod (`.validator(z.object(...))`). The rule is: **Zod for what
comes in, Schema for what comes back.** Zod checks what the browser sends and
the config; Effect `Schema` defines errors and, as services are converted,
checks what outside services answer.

## An API route

The handlers are exported from `src/api`, and a Spool mounts them with a file of three
lines:

```ts
// packages/spools/src/api/warm.ts
export const warmHandlers = {
  GET: cronRoute('cron.warm', () =>
    Effect.gen(function* () {
      const database = yield* (yield* Store).ping
      return Response.json({ ok: true, database })
    }),
  ),
}

// src/routes/api/cron/warm.ts in the app
export const Route = createFileRoute('/api/cron/warm')({ server: { handlers: warmHandlers } })
```

`cronRoute` refuses a request without `Authorization: Bearer $CRON_SECRET`
(401), answers a typed failure as JSON, and stops the run at its limit (50 s by
default) with a 504.

`apiRoute` is for routes staff call while signed in (`/api/files/*`): the
program gets `{ request, params, user }` and answers with a `Response`. Pass
`signedOut` to answer a signed-out visitor your own way (a redirect to
`/sign-in`, say); by default it is 401 JSON. A typed failure the program
doesn't answer itself becomes 500 JSON with its message. Type the program's
input as `RouteInput<{ id: string }>` so `params` has the route's shape.
`publicRoute` is for routes that prove who is calling some other way: a
signed webhook (`/api/webhooks/email`) or a token in a link (one-click
unsubscribe). The program checks the signature or token first.

`toolRoute` is for the tool API Swirls calls back into (`/api/swirls/tools/*`):
it refuses a request without `Authorization: Bearer $SWIRLS_APP_TOKEN` (401).
Nobody is signed in; a tool acts as the assistant.

## What staff see when something fails

| The program fails with              | The page shows                           | The server logs                                                                   |
| ----------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| A `StaffError`                      | Its `message`, exactly (see `errors.ts`) | `[server] <name> failed after <ms> ms: <tag>: <message>` (not for `Unauthorized`) |
| Anything else (a bug)               | What it threw, as before                 | The whole cause, once, with a reference                                           |
| Interrupted (the browser went away) | Nothing: the request is answered 499     | Nothing                                                                           |

The wording of every message staff can see is in the error's class, so a change
of wording is one line in one file. A successful call slower than a second is
logged as `[server] <name> took <ms> ms`.

## A new outside service

1. A port in `packages/spools/src/server/runtime/` (`Context.Service`), in terms of what the CRM needs
   and nothing of one vendor's, with a stand-in for tests and, if a Spool can do
   without it, a layer that says it isn't set up.
2. An adapter in `src/adapters/<port>/<name>/server.ts`. Only it imports the vendor's
   SDK. HTTP goes through `HttpClient` (`yield* HttpClient.HttpClient` from
   `effect/http`), never `fetch`. It names what it requires and the features it
   switches on.
3. A row in `policies.ts`: the time limit and how many retries. Retry only what is safe
   to repeat (reads, writes with an idempotency key), and pass `withPolicy` a predicate
   that refuses retries for answers that won't change (a 4xx other than 429). The
   adapter puts its provider's name to it.
4. Its errors in `errors.ts`, each with a `message` staff can read, added to
   `StaffError`.
5. Its option in `defineSpool` (`spool.ts`) and its layer in `appLayer`
   (`runtime/app.ts`).

## Promises on either side

- **Effect code calling the app's own code.** Hooks, handlers and settings in
  `src/app/extensions.ts` return promises. They are called through
  `fromHook("files.location", () => ...)` (`runtime/errors.ts`), which makes a
  failure an `ExtensionError`; staff see what was thrown, as before.
- **Promise code calling Effect code.** `src/app/extensions.ts` and scripts
  import from `@swirls/spools/extensions` (`recordFolder`,
  `shareRecordFolder`, `filesConfigured`, `listCrmUsers`, `getAccessToken`,
  `findConnections`, ...): each runs the
  Effect version on the process's runtime (`runServer(program)` from
  `runtime/app.ts` underneath). A typed failure rejects with the error itself,
  so its `message` still reaches the page. Don't import the framework modules
  from promise code: they export Effects, and `await`ing one does nothing.

## Tests

The helpers below come from `@swirls/spools/testing`, in this repository's tests and in
your app's: `run`, `failure`, `db`, `testRuntime`, `withEnv`, `runWithEnv`,
`installStandIns`, `installLiveServices`, `bodyText`, and `createFakeStore` (a file store
held in memory).

- **Unit tests** build a runtime from the app layer with stand-ins
  (`testRuntime(appLayer({ fetch: fake, auth: Auth.layerTest(users) }))`, where `fake` answers every outside HTTP call)
  or read configuration from an object (`runWithEnv({ CRON_SECRET: "..." }, program)`).
  `packages/spools/tests/unit/flashdrive.test.ts` shows the file store's retries, refusals
  and answer checking tested that way.
  `packages/spools/tests/unit/boundary.test.ts` shows the boundary, the access list, the cron
  secret and the policies tested that way.
- **Integration tests** run on the app's own runtime, on the store `TEST_STORE` names
  (PGlite in the test process unless you say otherwise; [Database](database.md#tests)):
  `await run(guides.seenGuides(id))`, and `await failure(program)` for the
  typed error a program fails with. To replace an outside service for the
  whole app (the boundary and `extension-api.ts` included), call
  `await installStandIns({ fetch: fake.handle })` (and `vault`, `signIns`,
  `auth` for those services) and `await installLiveServices()` afterwards. One
  `fetch` answers every outside call, so route by URL when a test plays more
  than one provider, and read bodies with `bodyText(init)`: Effect's client
  sends them as bytes; `packages/spools/tests/integration/files.test.ts` does this with
  `createFakeStore()`. Each call starts from fresh services, so
  nothing cached leaks into the next test.
- `packages/spools/tests/unit/guardrails.test.ts` lints code written the old way with this
  repository's lint rules and checks that each one fires.

## The guardrails

`bun run lint` (part of `bun run verify`) refuses, outside the files `.oxlintrc.json`
leaves out. The rules are in `packages/spools/src/oxlint`:

- a server function handler that isn't `crmHandler(...)` or `publicHandler(...)`
  (`spools/server-function-handlers`);
- anything but server functions exported from a `*.functions.ts` file, which browser code
  imports (`spools/server-function-files`);
- an API handler that isn't a route adapter, in a route or exported from `src/api`
  (`spools/route-adapters`);
- `throw` or an exported `async function` in `packages/spools/src/server/**`
  (`spools/effect-modules`);
- `fetch`, `process`, `@tanstack/react-start/server`, a vendor's SDK, a database
  client, an adapter or the app in `packages/spools/src/server/**` outside `packages/spools/src/server/runtime/`
  (and the last two even there);
- an adapter or an auth vendor's SDK in pages, which use `useAuth()`;
- `effect` in browser code (`packages/spools/src/crm/**`, `src/pages/**`, `src/views/**`, and a Spool's
  routes and `src/app/**`).

`bun run build` then fails if Effect reached the browser bundle anyway
(`spools check-client`, which looks for Effect's internal ids in `dist/client`, and in
`.vercel/output/static` for a Vercel build. Name a folder to check that one instead:
`spools check-client build/public`).
