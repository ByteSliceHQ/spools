# Spools

**Vibe code your entire CRM on rock-solid engineering.**

Spools is an open source CRM framework. It gives your coding agents the sign-in, data layer, security, search, email and tests, so they only write what is specific to your business. A CRM built with it is called a Spool.

[Website](https://spools.codes) · [Documentation](https://spools.codes/docs) · [Quickstart](https://spools.codes/docs/quickstart) · [Contributing](./CONTRIBUTING.md)

Built and maintained by the team at [Swirls](https://swirls.ai).

## Why Spools

Your agents write a config, choose the services and add your own code. Spools handles everything underneath:

- **Access checked on every request.** Pages and endpoints check the session and the access list. Lint refuses one your agent writes without the check.
- **Typed Postgres tables.** Each object is a table in your database, with migrations and row-level security.
- **Each email sent once.** Sequences keep their place through a restart, and two servers never send the same email.
- **Each post sent once.** Social posts go out when a teammate approves them, to LinkedIn, X, Facebook or a network you add, and never twice.
- **Secrets kept on the server.** Tokens are sealed before they are stored, and the build fails if server code built on Effect reaches the browser.
- **Time limits on outside calls.** Failures are typed with [Effect](https://effect.website), and calls are retried where that is safe.
- **More than 500 tests.** The server tests run on all three database adapters.

Most changes are a few lines you can read. The framework updates as a package, so you never merge it. You can [import your records](https://spools.codes/docs/coding-agents#moving-from-another-crm) from HubSpot, Salesforce or a spreadsheet.

Read [building with coding agents](https://spools.codes/docs/coding-agents) and [when to use Spools](https://spools.codes/docs/when-to-use).

## Get started

Install [Bun](https://bun.sh) 1.4 or later, then make a Spool:

```bash
bun create @swirls/spools my-crm
cd my-crm
bun run db:seed
bun run dev
```

Open http://localhost:3000. You need no accounts. Until you choose real services, records go in a Postgres inside the server and you are signed straight in. A production build refuses to start that way.

Or let your coding agent do all of it. Paste this into Claude Code, Cursor or Codex:

```text
Read https://md.spools.codes/prompt.md and follow it to build my CRM with Spools
```

Once you have a Spool, open the folder in your agent and say what you need:

> Build our CRM. We sell commercial insurance, and we track companies, the people at them, policies with a renewal date, and claims. Policies move from quoted to bound to renewed or lost.

`AGENTS.md` tells your agent where each kind of change goes, and `bun run check` tells it what to fix. The [quickstart](https://spools.codes/docs/quickstart) makes a few changes by hand.

## What a Spool looks like

```ts
// src/spool.server.ts
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
  crm, // your business
  extensions, // your code
  auth: clerk(),
  database: postgres(),
  files: drive({ blobs: s3Blobs() }),
  email: resend(),
  vault: aes(),
  agents: swirls(),
})
```

Each page and endpoint is a small file in `src/routes`. Delete one to drop a page, or write your own.

| Import                                                                             | What it is                                                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `@swirls/spools`                                                                   | `defineSpool`                                                          |
| `@swirls/spools/extensions`                                                        | For `src/app/extensions.ts`: hooks, handlers, and the record functions |
| `@swirls/spools/auth/*`, `database/*`, `files/*`, `email/*`, `vault/*`, `agents/*` | The adapters that ship with it                                         |
| `@swirls/spools/adapter`                                                           | What an adapter is written with                                        |
| `@swirls/spools/pages/*`, `api/*`, `ui/*`                                          | Pages, endpoints, and interface parts for your route files             |

## Parts

| Part       | Ships with                                                                          | Without one                                 |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `auth`     | Clerk, Better Auth, a development sign-in                                           | Required                                    |
| `database` | Any Postgres through Effect SQL, PGlite in the server, Prisma 8 (release candidate) | Required                                    |
| `files`    | Your database with a local disk or any S3 bucket, FlashDrive                        | The Files pages say files aren't set up     |
| `email`    | Resend, or your own function                                                        | Emails are logged                           |
| `vault`    | CipherStash, AES-256-GCM                                                            | No outside tokens are stored                |
| `agents`   | Swirls                                                                              | Workflows are skipped, the assistant is off |

Every database adapter passes the same 122 integration tests. See [choosing adapters and writing your own](https://spools.codes/docs/adapters).

## Before deploying

Read the [deployment guide](https://spools.codes/docs/deployment) and the [security guide](https://spools.codes/docs/security). Everyone on the access list can see and change every record, and fields marked `encrypted` are stored as plaintext until `@cipherstash/stack-prisma` supports Prisma 8.

Spools is early software (0.x). It works end to end, and minor versions may include breaking changes, which the [changelog](./packages/spools/CHANGELOG.md) explains.

### Status

| Area                                                                           | State                                                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Config, records, views, search, tasks, notes, reports, CSV, actions, sequences | Unit and integration tested on PGlite, Postgres through Effect SQL, and Postgres through Prisma |
| Interface                                                                      | Browser tests cover access, records, the board, search, import, tasks and the assistant         |
| Swirls workflows, assistant, tool API                                          | `swirls doctor` clean and the tool API tested; not yet run against a live project               |
| Better Auth, Resend, FlashDrive, S3, the AES vault                             | Tested against stand-ins; not yet run against live accounts                                     |
| Marketing: the website check, posts, ad results, and each built-in network     | Tested against stand-ins; not yet run against live LinkedIn, X, Meta or Google Ads accounts     |
| Clerk, CipherStash, the Swirls adapter                                         | Only the code around the service is tested; not yet run against live accounts                   |
| Field encryption in the database                                               | Not yet                                                                                         |

What's next is in the [roadmap](./ROADMAP.md).

## Explore locally

```bash
git clone https://github.com/ByteSliceHQ/spools.git
cd spools
bun install
bun run dev
```

The starter CRM runs at http://localhost:3000 and the website at http://127.0.0.1:8788. `bun run verify` runs the build, types, tests, lint and formatting. CI also runs the tests on Postgres and Prisma, makes a new Spool from the packed packages, and runs `swirls doctor`.

| Path                     | What it is                                                           |
| ------------------------ | -------------------------------------------------------------------- |
| `packages/spools`        | `@swirls/spools`, the framework                                      |
| `packages/create-spools` | `@swirls/create-spools`, which makes a new Spool                     |
| `apps/starter`           | A working Spool: what `create-spools` copies, and where work happens |
| `apps/docs`              | Source for [spools.codes](https://spools.codes)                      |
| `examples`               | Adapters written outside the framework                               |
| `docs`                   | The documentation                                                    |

## Help and contributions

Use [GitHub issues](https://github.com/ByteSliceHQ/spools/issues) for bugs, feature proposals, and usage questions. Include a small reproduction when reporting a bug, and remove credentials and customer data from anything you share.

Code, documentation, adapters, reproductions, and thoughtful reviews are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) to get started and our [code of conduct](./CODE_OF_CONDUCT.md) for community expectations.

Report suspected vulnerabilities privately to [security@swirls.ai](mailto:security@swirls.ai), following [SECURITY.md](./SECURITY.md).

Spools is maintained by the team behind Swirls, which also makes [Looms](https://looms.sh), a durable execution runtime for agents and workflows.

## License

Spools is licensed under [Apache-2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
