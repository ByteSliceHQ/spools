# Build with coding agents

Open your Spool in Claude Code, Cursor, Codex or another coding agent and say what you need. This
page covers what the agent edits and what checks its work.

## Start

Paste this into your agent. It asks about your business, makes the Spool and builds your CRM in it:

```text
Read https://md.spools.codes/prompt.md and follow it to build my CRM with Spools
```

[The page it reads](https://md.spools.codes/prompt.md) is plain text, so you can see what your agent
is told before you paste.

Or make the Spool yourself:

```bash
bun create @swirls/spools my-crm
cd my-crm
bun run db:seed
bun run dev
```

Then open the folder in your agent and ask:

> Build our CRM. We sell commercial insurance, and we track companies, the people at them, policies
> with a renewal date, and claims. Policies move from quoted to bound to renewed or lost. Email the
> account manager 60 days before a policy renews.

Every new Spool has an `AGENTS.md` that tells the agent where each kind of change goes, and a
`CLAUDE.md` that points to it.

## What an agent edits

Most changes are a few lines in one of these places.

| The request                                   | Where it goes                                                     |
| --------------------------------------------- | ----------------------------------------------------------------- |
| Track something, show it, or move it along    | `crm.config.json`: objects, fields, pipelines, views              |
| Email people on a schedule                    | `campaigns` in `crm.config.json`                                  |
| When something happens, do something          | `automations` in the config, or a hook in `src/app/extensions.ts` |
| A page or an endpoint nobody else needs       | A file in `src/routes`                                            |
| Use a different sign-in, database, or service | `src/spool.server.ts`                                             |

The framework is a package, so your agent never edits it and you never merge it.

## What checks the agent's work

Ask the agent to run `bun run check` before it is done. Each of these stops with a message that says
what to change.

- **The config.** Every key it knows is checked against a schema: a column for a field that doesn't
  exist, a board grouped by something that isn't a select, an action that runs nothing. A key the
  schema doesn't know is ignored, so a misspelt one does nothing.
  `crm.config.schema.json` gives the agent the same checks as it types.
- **Who is asking.** Lint refuses a server function or an endpoint that doesn't check the session
  first ([handlers](extending.md#pages-and-endpoints-of-your-own)).
- **Types.** Records, hooks and routes are typed from the config and the route tree.
- **The browser bundle.** `bun run build` fails if Effect, which server code runs on, reached it.
- **The keys.** A production server refuses to start without the keys for its sign-in and database,
  or with the development sign-in on.

Spools comes with one access check for every request, row-level security on every table, tokens
sealed before they are stored, and a time limit on every read from an outside service. Read
[Architecture](architecture.md) and [Security](security.md) for how.

## What to ask for

- "Add a renewals pipeline with a board by status, and a saved view of what is due this quarter."
- "When a deal is won, create a project from it and give its owner a task to send the welcome pack."
- "Email new leads on day 0, day 3, and day 10. Stop when they become a customer."
- "Import this CSV of our contacts. Keep the owner and the last contacted date."
- "Add a page that shows stock levels from our warehouse API next to the open orders."
- "Use Better Auth instead of Clerk, and keep files in our S3 bucket."

## Moving from another CRM

Export your companies, contacts, and deals as CSV from HubSpot, Salesforce, a spreadsheet, or
wherever they are now. Describe the fields you use in `crm.config.json`, then import each file from
the list page: columns are matched to fields by key or label, and relations by the related record's
title. An import is limited to 1,000 rows and does not fire automations, so split large files, or ask
your agent for a script that uses `createRecord`.
