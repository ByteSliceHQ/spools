# Your app's tests

Tests of your own config, handlers and hooks go here: `bun test`.

Most need no database: call a hook or a handler with what it would be given. A test that does
need one makes a Spool with a database of its own, so it never writes to the one in `.env`:

```ts
import { defineSpool } from '@swirls/spools'
import { devAuth } from '@swirls/spools/auth/dev'
import { pglite } from '@swirls/spools/database/pglite'

defineSpool({ crm, extensions, auth: devAuth(), database: pglite({ dataDir: 'memory' }) })
```

`@swirls/spools/testing` then runs server code on that Spool, and stands in for the services
outside it:

```ts
import { createFakeStore, installStandIns, run } from '@swirls/spools/testing'

const rows = await run(program) // an Effect program, on the Spool above
await installStandIns({ fetch: createFakeStore().handle }) // a file store held in memory
```

The guides the CRM offers are in `@swirls/spools/guides` (`resolveGuides`, `checkGuides`), for
a test that checks the ones in your config.
