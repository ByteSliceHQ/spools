# Extending

Most changes are config: see the [configuration reference](configuration.md).
When config isn't enough, extend in code. Server-side extensions live in one file
you own, [`src/app/extensions.ts`](../apps/starter/src/app/extensions.ts):

```ts
import { defineExtensions } from '@swirls/spools/extensions'

export default defineExtensions({
  handlers: {}, // "run": "local:<name>"
  runTargets: {}, // new "<kind>:<name>" targets
  hooks: {}, // record lifecycle
  email: undefined, // campaign email transport
})
```

The full contract, with types, is [`packages/spools/src/crm/extensions.ts`](../packages/spools/src/crm/extensions.ts).

## Handlers: run your own code from a button or automation

```ts
handlers: {
  async markVip(ctx) {
    await updateRecord(ctx.objectKey, ctx.record.id, { status: "customer" }, ctx.actor);
    return { message: "Marked as VIP" };
  },
},
```

```json
{ "id": "markVip", "label": "Mark as VIP", "run": "local:markVip" }
```

`ctx` is `{ objectKey, record, actor, trigger }`. Import `updateRecord` and friends
from `@swirls/spools/extensions` so hooks and automations still run. The returned
`message` is shown to the user.

## Hooks: react to record changes

Hooks run for every write, whether it comes from the CRM or the assistant.

```ts
hooks: {
  // Return new values to change them. Throw to reject the change.
  beforeCreate({ objectKey, values }) {
    if (objectKey === "deals" && !values.owner) throw new Error("Deals need an owner");
  },
  async afterUpdate({ objectKey, record, previous }) {
    if (objectKey === "deals" && previous.stage !== "won" && record.stage === "won") {
      await notifyTeam(`Won: ${record.title}`);
    }
  },
},
```

Available hooks: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`,
`afterDelete`. `beforeUpdate` and `afterUpdate` receive the `previous` record.
Values returned from a `before*` hook are still validated against the config.

A change happens in this order:

1. The `before*` hook runs. Throwing here refuses the change: nothing is written, and staff
   see the message.
2. The record and its lines on the timeline are written together, as one transaction.
3. The `after*` hook and the config's automations run, once the change is kept.

So an `after*` hook can read the record it is told about and change it again. If it throws,
the change stays, and staff see "Saved, but a step after it failed" with the message, so
nobody makes the change a second time.

For simple "when X changes, run Y", prefer `automations` in the config. Use hooks
when you need the previous value, want to change or reject the write, or need
logic that doesn't belong in a workflow.

### Hand a record on to the next step

A hook can create the records and tasks the next person needs. Import from
`@swirls/spools/extensions`: its `createRecord` and `updateRecord` write
through the service, so the new records get their own timeline, hooks and
automations, and `createTask` makes the to-dos. (The framework's own modules
return Effects, which do nothing when awaited; this file is their promise
version.)

```ts
import { createRecord, createTask, updateRecord } from "@swirls/spools/extensions";

hooks: {
  async afterUpdate({ objectKey, record, previous, actor }) {
    const won = objectKey === "deals" && record.stage === "won" && previous.stage !== "won";
    // Guard on the link, so winning the same deal twice doesn't make two projects.
    if (!won || record.projectId) return;
    const project = await createRecord("projects", { title: record.title, companyId: record.companyId }, actor);
    await updateRecord("deals", record.id, { projectId: project.id }, actor);
    await createTask(
      // No assignee means whoever is named as the task's creator.
      { title: "Send the welcome pack", assigneeId: record.owner ? String(record.owner) : null, objectKey: "projects", recordId: project.id },
      actor?.id ?? "system",
    );
  },
},
```

- A hook that updates the record it is handling runs again for that update:
  compare with `previous` (as above) so it does its work once.
- `actor` is `null` for scripts; a CSV import in the CRM has the teammate who ran it.
  Decide what a hand-off should do with no actor; bulk imports that call `records.createRecord` directly skip hooks.
- To give the new record the old one's folder, see `shareRecordFolder` in [Files](files.md).

## Run targets: add a new kind

A run target kind handles every `"<kind>:<name>"` in the config.

```ts
runTargets: {
  slack: {
    validate: (channel) => (channels.includes(channel) ? null : `unknown channel "${channel}"`),
    async run(channel, ctx) {
      await postToSlack(channel, `${ctx.trigger}: ${ctx.record.id}`);
      return { message: `Posted to #${channel}` };
    },
  },
},
```

```json
{ "on": "deals.created", "run": "slack:sales" }
```

`validate` is optional. When present, `bun run crm:gen` and server start-up use it
to reject targets that can't resolve, so a typo fails early.

## Email: use a different provider

Campaign email goes through the Spool's email adapter. To send it some other way
without writing an [adapter](adapters.md#an-email-provider), replace the transport:

```ts
email: {
  async send({ to, subject, text, html, headers }) {
    const id = await myProvider.send({ to, subject, text, html, headers });
    return { id, sent: true };
  },
},
```

Keep the `headers`: they carry the one-click unsubscribe.

## Marketing: add a social or ad network

Add a network under `marketing` and a channel or an ad account in `crm.config.json` can
name it. `posts` networks say how long a post may be and how to send one; `ads` networks
say how to read an account's campaigns. The full example is in
[Marketing](marketing.md#adding-a-network).

```ts
marketing: {
  posts: {
    mastodon: {
      label: "Mastodon",
      limit: 500,
      access: { env: "MASTODON_TOKEN" },
      async publish({ text, token }) {
        // Call the network. Return where the post is; throw to refuse it.
        return { id: "...", url: "https://..." };
      },
    },
  },
},
```

## Integrations: let teammates connect another service

Add an OAuth provider under `integrations` and it appears on the Integrations
page. The framework runs the connect flow and keeps the tokens encrypted; your
handlers find a connection with `findConnections` and ask for a current token with
`getAccessToken`. The full example is in [Integrations](integrations.md#add-a-provider).

A connection belongs to the teammate who connected it. Add `shared: 'team'` for an
account the whole business uses (one accounting system), or `shared: 'group'` with
`groups` for one per branch or region, and `canManage` to say who may connect and
disconnect it. See [Share a provider with the team](integrations.md#share-a-provider-with-the-team).

```ts
integrations: {
  books: {
    label: "Acme Books",
    description: "Create invoices from won deals",
    clientId: "BOOKS_CLIENT_ID",
    clientSecret: "BOOKS_CLIENT_SECRET",
    authUrl: "https://books.example.com/oauth/authorize",
    tokenUrl: "https://books.example.com/oauth/token",
    scopes: ["invoices.write"],
    account: async ({ get }) => (await get<{ id: string }>("https://books.example.com/api/me")).id,
    // Left out, each teammate connects their own. With it, one connection serves everyone.
    shared: "team",
    canManage: ["finance@acme.example"],
  },
},
```

## Files: choose where a record's folder goes

An object with `files` in the config gives each record a folder in the drive, at
`<plural label>/<record title>`, or inside a related record's folder with
`under`. Return another path from `files.location` to lay the drive out your way.
It is asked once per record, when its folder is made. See [Files](files.md).

```ts
files: {
  location: ({ objectKey, record }) => (objectKey === "jobs" ? `Jobs/${record.name}` : ""),
},
```

## Add a field type

A field type is part of the framework, so this is a change to `packages/spools`: two
files, and the compiler lists what's missing.

1. In [`packages/spools/src/crm/field-types.ts`](../packages/spools/src/crm/field-types.ts), add the config shape
   to `fieldSchema` and an entry to `fieldTypes`:

   ```ts
   z.object({ ...fieldBase, type: z.literal("rating"), max: z.number().int().default(5) }),
   ```

   ```ts
   rating: { column: "integer", input: (field) => nullable(z.coerce.number().int().min(0).max(field.max)) },
   ```

2. In [`packages/spools/src/crm/ui/fields.tsx`](../packages/spools/src/crm/ui/fields.tsx), add `rating` to
   `fieldDisplay` and `fieldInput`.

Then run `bun run crm:gen`, and document the type in `docs/configuration.md`.

## Add a view type

1. Add the config shape to `viewSchema` in
   [`packages/spools/src/crm/config-schema.ts`](../packages/spools/src/crm/config-schema.ts).
2. Add a component to `viewComponents` in
   [`packages/spools/src/crm/ui/views.tsx`](../packages/spools/src/crm/ui/views.tsx). Its props are `ViewProps`
   in the same file.
3. Teach `sanitise` in [`packages/spools/src/server/views.ts`](../packages/spools/src/server/views.ts) which
   settings the new type keeps.

## Pages

Each page is a small file in `src/routes` that mounts one of the framework's:

```tsx
import { createFileRoute } from '@tanstack/react-router'

// src/routes/_crm/tasks.tsx
import { tasksPage } from '@swirls/spools/pages/tasks'

export const Route = createFileRoute('/_crm/tasks')(tasksPage)
```

Delete the file and the page is gone. Keep its data and change how it looks:

```tsx
export const Route = createFileRoute('/_crm/tasks')({ ...tasksPage, component: MyTasks })
```

## Pages and endpoints of your own

A page is a route file. Inside `src/routes/_crm` it gets the CRM's shell, and only signed-in
teammates can open it. The framework's parts are in `@swirls/spools/ui/*` (`kit` for buttons and
dialogs, `shell` for the top bar, `workspace`, `views`).

Its data comes from a server function, whose handler is one from `@swirls/spools/handlers`:

```tsx
// src/routes/_crm/stock.tsx
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { crmHandler } from '@swirls/spools/handlers'

const stockFn = createServerFn({ method: 'GET' })
  .validator(z.object({ sku: z.string() }))
  .handler(crmHandler('stock', async ({ data, user }) => lookUpStock(data.sku, user.email)))

export const Route = createFileRoute('/_crm/stock')({
  loader: () => stockFn({ data: { sku: 'A-100' } }),
  component: () => <p>{Route.useLoaderData().count} in stock</p>,
})
```

An endpoint is the same with `apiRoute`:

```ts
// src/routes/api/stock.$sku.ts
import { createFileRoute } from '@tanstack/react-router'

import { apiRoute } from '@swirls/spools/handlers'

export const Route = createFileRoute('/api/stock/$sku')({
  server: {
    handlers: {
      GET: apiRoute<{ sku: string }>('stock', async ({ params, user }) =>
        Response.json(await lookUpStock(params.sku, user.email)),
      ),
    },
  },
})
```

| Handler         | Who it answers                                                                               |
| --------------- | -------------------------------------------------------------------------------------------- |
| `crmHandler`    | A server function, for signed-in teammates on the access list                                |
| `apiRoute`      | An endpoint, for the same people. Anyone else gets 401                                       |
| `cronRoute`     | A scheduled job with `CRON_SECRET`. Anyone else gets 401                                     |
| `publicHandler` | A server function that answers anyone. Nothing staff-only belongs here                       |
| `publicRoute`   | An endpoint that answers anyone, such as a webhook. Check its signature before anything else |

Each checks who is asking before your code runs, hands it the person, stops when the browser goes
away, and shows the page the message of an error you throw. A new Spool's `bun run lint` refuses a
server function or endpoint that goes without one.

## Theme the CRM

The CRM's colours are CSS variables on `.crm`, defined in
[`packages/spools/src/crm/ui/theme.css`](../packages/spools/src/crm/ui/theme.css). Override them in your own
`src/styles.css`, after the theme import, instead of editing the theme file:

```css
.crm {
  --c-accent: #84572f;
  --c-accent-hov: #6b4526;
}
.crm.dark {
  --c-accent: #c08a55;
  --c-accent-hov: #d09c69;
}
```

The CRM follows the system light or dark setting until someone uses the toggle in
the sidebar.

## Give the assistant a new capability

1. Add a tool to `tools` in [`packages/spools/src/server/tools.ts`](../packages/spools/src/server/tools.ts) with a
   Zod input schema.
2. Add a tool workflow to [`swirls/assistant.swirls`](../apps/starter/swirls/assistant.swirls)
   that posts to `/api/swirls/tools/<tool>`, and list it in the agent's `tools`.
3. Run `swirls doctor`, then `swirls deploy`.
