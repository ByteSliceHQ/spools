# This CRM

A Spool: a CRM built on `@swirls/spools`. The framework is in `node_modules`; what is in
this repository is the business's own.

- **The CRM is defined by `crm.config.json`.** Objects, fields, views, actions,
  automations, email sequences. After editing it run `bun run crm:gen`, then
  `bun run db:push` if `DATABASE_URL` is set (without it, restart the dev server).
- **Never hand-edit** `prisma/schema.*`, `crm.config.schema.json` or
  `src/routeTree.gen.ts`: they're generated.
- **Code goes in `src/app/extensions.ts`**: handlers (`"run": "local:<name>"`), hooks,
  run-target kinds, integration providers. It is plain TypeScript with promises, and
  imports from `@swirls/spools/extensions` (`createRecord`, `updateRecord`,
  `listRecords`, `createTask`, ...). Those writes run hooks, the timeline and
  automations.
- **Services are chosen in `src/spool.server.ts`**: auth, database, files, email,
  vault, agents. An auth adapter's browser half goes in `src/spool.ui.ts`.
- **Pages** are small files in `src/routes` that mount the framework's. Delete one to
  drop a page, spread one to change it, add your own. Inside `src/routes/_crm` a page
  gets the CRM's shell and needs a signed-in teammate. Interface parts are in
  `@swirls/spools/ui/*`.
- **Your own server functions and endpoints** use a handler from `@swirls/spools/handlers`
  (`crmHandler`, `apiRoute`, `cronRoute`, `publicRoute`). It checks who is asking before your
  code runs and gives it the person. `bun run lint` refuses one that goes without.
- **Reach for config first**, then a hook or handler, then a page, then an adapter. Never
  edit anything in `node_modules`, and never query the database directly.
- **Swirls never touches the database.** Workflows and the assistant in `swirls/` call
  the tool API. Run `swirls doctor` after editing a `.swirls` file.
- **Server code never reaches the browser.** It runs on Effect, and `bun run build` fails if
  Effect is in the browser bundle.

```sh
bun run dev        # http://localhost:3000
bun run crm:gen    # after editing crm.config.json
bun run build      # after adding a route file, so that it is typed
bun run check      # types, lint, config, tests. Run it before you are done
bun run swirls:check   # after editing a .swirls file; needs the Swirls CLI (swirls.ai/install)
bun run build && bun run start
```

Docs: https://spools.codes/docs
