# API reference

The package's entry points. Anything that isn't listed here is internal and may change in a
patch release. The types are the reference for each function: your editor shows them, and
the links lead to the source.

## Your Spool

| Import                         | Exports                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@swirls/spools`               | [`defineSpool`](../packages/spools/src/server/spool.ts), and the types `Spool` and `SpoolOptions`                                                                        |
| `@swirls/spools/extensions`    | [`defineExtensions`](../packages/spools/src/crm/extensions.ts), and the record functions for hooks and handlers                                                          |
| `@swirls/spools/handlers`      | [Handlers](../packages/spools/src/server/handlers.ts) for your own server functions and endpoints: `crmHandler`, `apiRoute`, `cronRoute`, `publicHandler`, `publicRoute` |
| `@swirls/spools/oxlint`        | [Lint rules](../packages/spools/src/oxlint/index.ts) that refuse a server function or endpoint without one                                                               |
| `@swirls/spools/config-schema` | [The config's schema](../packages/spools/src/crm/config-schema.ts), for checking a `crm.config.json`                                                                     |
| `@swirls/spools/server`        | [`serveSpool`](../packages/spools/src/server/entry.ts), for `src/server.ts`                                                                                              |
| `@swirls/spools/start`         | [The request middleware](../packages/spools/src/server/middleware.ts), for `src/start.ts`                                                                                |
| `@swirls/spools/theme.css`     | The styles, for `src/styles.css`                                                                                                                                         |

`defineSpool` takes:

| Option       | Type            |                                                            |
| ------------ | --------------- | ---------------------------------------------------------- |
| `crm`        | the config      | Required. The contents of `crm.config.json`                |
| `extensions` | `Extensions`    | Your hooks and handlers                                    |
| `auth`       | `AuthAdapter`   | Required. See [Signing in](auth.md)                        |
| `database`   | `StoreAdapter`  | Required. See [Database](database.md)                      |
| `files`      | `FilesAdapter`  | Without it, the Files pages say files aren't set up        |
| `email`      | `EmailAdapter`  | Without it, emails are logged                              |
| `vault`      | `VaultAdapter`  | Without it, no outside tokens are stored                   |
| `agents`     | `AgentsAdapter` | Without it, workflows are skipped and the assistant is off |

## Adapters

| Import                             | Exports                                         |
| ---------------------------------- | ----------------------------------------------- |
| `@swirls/spools/auth/clerk`        | `clerk`                                         |
| `@swirls/spools/auth/better-auth`  | `betterAuth`                                    |
| `@swirls/spools/auth/dev`          | `devAuth`                                       |
| `@swirls/spools/auth/<name>/ui`    | The browser half of each, for `src/spool.ui.ts` |
| `@swirls/spools/database/postgres` | `postgres`                                      |
| `@swirls/spools/database/pglite`   | `pglite`                                        |
| `@swirls/spools/database/prisma`   | `prisma`                                        |
| `@swirls/spools/files/drive`       | `drive`, `localBlobs`, `s3Blobs`                |
| `@swirls/spools/files/flashdrive`  | `flashdrive`                                    |
| `@swirls/spools/email/resend`      | `resend`                                        |
| `@swirls/spools/vault/aes`         | `aes`                                           |
| `@swirls/spools/vault/cipherstash` | `cipherstash`                                   |
| `@swirls/spools/agents/swirls`     | `swirls`                                        |

[Adapters](adapters.md#what-ships) lists the packages and variables each needs.

## Writing an adapter

`@swirls/spools/adapter` has the [ports, types, and helpers](../packages/spools/src/adapter.ts)
an adapter is made from. [Write your own](adapters.md#write-your-own) has worked examples.

| Port        | Provides                                                  | Adapter type    |
| ----------- | --------------------------------------------------------- | --------------- |
| `Auth`      | The people on the team and the accounts they sign in with | `AuthAdapter`   |
| `Store`     | Reading and writing tables                                | `StoreAdapter`  |
| `FileStore` | Folders, files, uploads, and downloads                    | `FilesAdapter`  |
| `Email`     | Sending, and reports of delivery                          | `EmailAdapter`  |
| `Vault`     | Sealing and opening tokens                                | `VaultAdapter`  |
| `Agents`    | Running workflows and the assistant                       | `AgentsAdapter` |

## Pages and endpoints

Each route file in `src/routes` mounts one of these:

```ts
import { createFileRoute } from '@tanstack/react-router'

import { tasksPage } from '@swirls/spools/pages/tasks'

export const Route = createFileRoute('/_crm/tasks')(tasksPage)
```

| Import                   | What it is                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@swirls/spools/pages/*` | Route options for each page: `home`, `list`, `record`, `tasks`, `notes`, `files`, `reports`, `workflows`, `integrations`, `assistant`, `sign-in`, `unsubscribe`, and the `layout` around them |
| `@swirls/spools/api/*`   | Handlers for each endpoint under `/api`                                                                                                                                                       |
| `@swirls/spools/ui/*`    | The interface's own components, for pages you write                                                                                                                                           |

## The `spools` command

Run in a Spool's folder. The scripts in `package.json` call it for you.

| Command               | What it does                                                                    |
| --------------------- | ------------------------------------------------------------------------------- |
| `spools gen`          | Checks `crm.config.json` and regenerates the schemas made from it               |
| `spools init`         | First run: names the CRM, sets who may use it, writes `.env` with fresh secrets |
| `spools harden`       | Takes Supabase's Data API roles off the tables                                  |
| `spools stats`        | Recomputes the last activity, last contact, and next task dates on every record |
| `spools check-client` | Fails if Effect, which server code runs on, reached the browser bundle          |

`check-client` reads `dist/client`, and `.vercel/output/static` after a Vercel build. To
check another folder, name it: `spools check-client build/public`.
