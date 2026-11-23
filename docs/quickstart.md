# Quickstart

Make a CRM, add a field and a board, and create a task when a deal is won. You need
[Bun](https://bun.sh) 1.4 or newer and no accounts.

> `@swirls/spools` is not on npm yet. Until it is, clone
> [the repository](https://github.com/ByteSliceHQ/spools) and work in the Spool it
> contains. Everything from [Look around](#look-around) on is the same.

## Make a Spool

```bash
bun create @swirls/spools my-crm
cd my-crm
bun run db:seed
bun run dev
```

Open http://localhost:3000. You are signed in, and there are companies, contacts, and deals
to look at.

Records are in a Postgres inside the server, which keeps its data in `.data/pglite`. The development
sign-in lets you straight in. A production build refuses to start with it.

## Look around

| File                    | What it holds                                                         |
| ----------------------- | --------------------------------------------------------------------- |
| `crm.config.json`       | Objects, fields, views, actions, automations, and email sequences     |
| `src/spool.server.ts`   | The services your CRM runs on                                         |
| `src/app/extensions.ts` | Your hooks and handlers                                               |
| `src/routes`            | One small file per page. Delete one to drop a page, or write your own |
| `swirls`                | Swirls workflows and the assistant                                    |

## Add a field

Contacts have no field for LinkedIn. Add one under `objects.contacts.fields` in
`crm.config.json`:

```json
"linkedin": { "type": "url", "label": "LinkedIn", "searchable": true }
```

Check the config and regenerate what is made from it, then restart the server:

```bash
bun run crm:gen
bun run dev
```

Open a contact. The field is on the page and in the form, it can be added as a column, and
Cmd+K finds people by it.

## Add a board

Views are part of an object. Add one to `objects.companies.views` that groups companies by
industry:

```json
{
  "id": "industries",
  "label": "By industry",
  "type": "board",
  "groupBy": "industry",
  "cardFields": ["domain", "employees"]
}
```

Run `bun run crm:gen` and restart. The view menu on Companies now offers **By industry**, and
dragging a card to another column changes the company's industry.

## React to a change

Hooks run for every change, whoever makes it: a teammate, a CSV import, or the assistant.
This one makes a task when a deal is won. Add `hooks` to what is already in
`src/app/extensions.ts`:

```ts
import { createTask, defineExtensions } from '@swirls/spools/extensions'

export default defineExtensions({
  // ...the handlers already in the file
  hooks: {
    async afterUpdate({ objectKey, record, previous, actor }) {
      const won = objectKey === 'deals' && record.stage === 'won' && previous.stage !== 'won'

      if (won) {
        await createTask(
          { title: `Send a welcome note for ${record.title}`, objectKey, recordId: record.id },
          actor?.id ?? 'system',
        )
      }
    },
  },
})
```

Drag a deal to Won and open Tasks.

## Choose real services

Each service is one line in `src/spool.server.ts`. To keep records in your own Postgres and
let people sign in with Clerk:

```ts
import { clerk } from '@swirls/spools/auth/clerk'
import { postgres } from '@swirls/spools/database/postgres'

export default defineSpool({
  crm,
  extensions,
  auth: clerk(),
  database: postgres(),
})
```

Install what they use and set their variables in `.env`:

```bash
bun add @clerk/tanstack-react-start @effect/sql-pg
```

The server says at startup which services are on and what the others still need. Create the
tables with `bun run db:push`.

## Next

- Say who may sign in with [`access`](configuration.md#access).
- Read about [signing in](auth.md), [databases](database.md), and
  [writing an adapter](adapters.md#write-your-own).
- Add [workflows and the assistant](swirls.md).
- [Deploy it](deployment.md).
