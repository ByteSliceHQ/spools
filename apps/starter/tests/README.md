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
