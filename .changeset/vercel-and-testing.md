---
'@swirls/spools': minor
'@swirls/create-spools': minor
---

Vercel is supported again, and an app's tests get the framework's own helpers.

- **Vercel.** `vercel()` from `@swirls/spools/vite` packages the app as a Bun function when
  it is built on Vercel and does nothing anywhere else. A new Spool has it in
  `vite.config.ts`, with a `vercel.json`. Add `nitro` to an existing Spool to use it.
- **No switch on Vercel.** The framework reads Vercel's own `VERCEL` variable, so the timers
  are off and `localBlobs()` is refused there without `SERVERLESS=1`. Other hosts with no
  long-lived process still set `SERVERLESS=1`.
- **`spools check-client`** reads `.vercel/output/static` as well as `dist/client`, and
  checks a folder you name: `spools check-client build/public`.
- **`@swirls/spools/testing`** has `run`, `failure`, `db`, `testRuntime`, `withEnv`,
  `runWithEnv`, `installStandIns`, `installLiveServices`, `bodyText` and `createFakeStore`.
- **`@swirls/spools/guides`** has the guides the CRM offers (`resolveGuides`, `checkGuides`
  and the rest of `crm/guides`).
