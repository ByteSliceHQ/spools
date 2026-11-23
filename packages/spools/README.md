# @swirls/spools

**Vibe code your entire CRM on rock-solid engineering.**

Spools is an open source CRM framework. It gives your coding agents the sign-in, data layer,
security, search, email and tests, so they only write what is specific to your business. A CRM built
with it is called a Spool.

[Website](https://spools.codes) · [Documentation](https://spools.codes/docs) · [Quickstart](https://spools.codes/docs/quickstart) · [Source](https://github.com/ByteSliceHQ/spools)

```bash
bun create @swirls/spools my-crm
```

```ts
// src/spool.server.ts
import { defineSpool } from '@swirls/spools'
import { swirls } from '@swirls/spools/agents/swirls'
import { clerk } from '@swirls/spools/auth/clerk'
import { postgres } from '@swirls/spools/database/postgres'

import crm from '../crm.config.json' with { type: 'json' }
import extensions from './app/extensions'

export default defineSpool({
  crm,
  extensions,
  auth: clerk(),
  database: postgres(),
  agents: swirls(),
})
```

The [API reference](https://spools.codes/docs/api) lists every entry point. It needs
[Bun](https://bun.sh) 1.4 or newer. The sign-in, database, email and vault services it can run on
are optional peer dependencies: install the ones your adapters use. The Swirls SDK and the AI SDK
come with it.

Built and maintained by the team at [Swirls](https://swirls.ai). Licensed under
[Apache-2.0](./LICENSE).
