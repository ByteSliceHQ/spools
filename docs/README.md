# Introduction

Spools is an open source CRM framework. It gives your coding agents the sign-in, data layer,
security, search, email and tests, so they only write what is specific to your business. A CRM built
with it is called a Spool.

A Spool is a config, your services and your own code, put together in one file:

```ts
// src/spool.server.ts
import { defineSpool } from '@swirls/spools'
import { swirls } from '@swirls/spools/agents/swirls'
import { clerk } from '@swirls/spools/auth/clerk'
import { postgres } from '@swirls/spools/database/postgres'

import crm from '../crm.config.json' with { type: 'json' }
import extensions from './app/extensions'

export default defineSpool({
  crm, // your business: objects, fields, pipelines, sequences
  extensions, // your code: hooks and handlers
  auth: clerk(), // your services
  database: postgres(),
  agents: swirls(),
})
```

## What you get

- **Pages for your objects.** Spreadsheet tables with inline editing, drag-and-drop boards, record
  pages with a timeline, forms, reports, and CSV import and export.
- **Search and filters.** Cmd+K finds records, notes, emails, calls, tasks, and files.
  Every list filters by any field, through relations, and by activity.
- **Email.** Sequences that keep their place in your database, one-off email from a
  teammate's own mailbox, and a timeline of the mail and meetings they have with contacts.
- **Marketing.** The tracking tags your website carries and the code for the ones it is
  missing, social posts that a teammate approves before they go out, and ad results.
- **Agents and workflows.** A Swirls assistant that reads and updates records, and
  workflows that run when a record changes or someone presses a button.
- **Your own code.** Hooks, handlers, pages, endpoints, and services.

## Where to start

| If you want to                           | Read                                         |
| ---------------------------------------- | -------------------------------------------- |
| Build one with your agent                | [Build with coding agents](coding-agents.md) |
| See one running                          | [Quickstart](quickstart.md)                  |
| Decide whether it suits you              | [When to use Spools](when-to-use.md)         |
| Describe your business                   | [Configuration](configuration.md)            |
| Choose sign-in, a database, and the rest | [Adapters](adapters.md)                      |
| Add behavior of your own                 | [Extending](extending.md)                    |
| Put it in production                     | [Deployment](deployment.md)                  |
| Understand how it works                  | [Architecture](architecture.md)              |

## Where it stands

Spools is in its 0.x releases. It works end to end, and minor versions may include
breaking changes, which the [changelog](../packages/spools/CHANGELOG.md) explains. The
[status table](../README.md#status) says what has been tested and how, and the
[roadmap](../ROADMAP.md) says what is next.
