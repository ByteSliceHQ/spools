# Build a CRM with Spools

You are a coding agent, and the person you work for wants a CRM of their own. Spools is an open
source CRM framework: it brings the sign-in, data layer, security, search, email and tests, and you
write what is specific to their business. Follow these steps in order.

Everything here happens in one new folder on this machine. It needs no accounts, and nothing is
deployed. Do not ask for a password, an API key or a token, and do not read one from another
project.

## 1. Learn the business

If the person has not told you already, ask these in one message and wait for the answers:

- What does the business sell, and to whom?
- What should the CRM track? For example companies, people, deals, policies, projects or orders.
- What stages does a deal, or whatever they track, move through?
- What should happen on its own? For example a task when a deal is won, or an email before a
  renewal.
- What is the business called, and what email domain does the team sign in with?

Short answers are enough. Where they have no preference, choose something sensible and say what you
chose.

## 2. Check Bun

Spools needs [Bun](https://bun.sh) 1.4 or newer.

```bash
bun --version
```

If Bun is missing or older, tell the person and ask before you install or upgrade it.

## 3. Make the Spool

Run this in the folder where the person keeps their projects. Pass `--yes`, or the command stops to
ask questions you cannot answer from here.

```bash
bun create @swirls/spools my-crm --name "Acme" --domain acme.com --yes
```

- `my-crm` is the new folder. It must not exist yet, or it must be empty.
- `--name` is the business, as the CRM shows it.
- `--domain` lets in everyone with an email address at that domain. Use `--email` for one person.

The command installs the packages and writes `.env` with fresh secrets. Leave `.env` alone.

## 4. Read the guide in the new folder

```bash
cd my-crm
```

Read `AGENTS.md`. It says where each kind of change goes and which files are generated. It is the
guide for this Spool from now on, and it wins over this page where they differ.

## 5. Describe the business

Most of the CRM is `crm.config.json`: objects, fields, pipelines, views, actions, automations and
email sequences. Change it to fit what you learned in step 1, then regenerate what is made from it:

```bash
bun run crm:gen
```

Reach for the config first. If the config cannot say it, write a hook or a handler in
`src/app/extensions.ts`, and after that a page in `src/routes`. Never edit anything in
`node_modules`, and never query the database directly.

- [Configuration](https://spools.codes/docs/configuration) lists every key.
- [Extending](https://spools.codes/docs/extending) covers hooks, handlers and pages.
- [Build with coding agents](https://spools.codes/docs/coding-agents) shows requests and where each
  one goes.

## 6. Check your work

```bash
bun run check
```

It checks the types, the lint rules, the config and the tests, and each failure says what to
change. Fix what it reports and run it again until it passes.

## 7. Run it

`scripts/seed.ts` adds demo companies, contacts and deals. It fits the objects a new Spool starts
with. If you renamed or removed them, change the seed to match before you run it.

```bash
bun run db:seed
bun run dev
```

`bun run dev` keeps running. Start it in the background, or give the person the command.
The CRM is at http://localhost:3000, and they are signed straight in. Records are kept in a Postgres
inside the server, in `.data/pglite`.

## 8. Report

Tell the person:

- where the folder is and how to start the CRM,
- what you put in the config: the objects, the pipelines and the automations,
- anything you chose for them, and anything they asked for that you left out,
- that `bun run check` passes.

## Later, and only when they ask

A new Spool runs on a development sign-in and a database inside the server. A production build
refuses to start that way. Moving to real services means accounts and keys, and those are the
person's to create. They put the keys in `.env` themselves.

- [Choose a sign-in](https://spools.codes/docs/auth) and
  [a database](https://spools.codes/docs/database).
- [Deploy it](https://spools.codes/docs/deployment).
- [Bring records over](https://spools.codes/docs/coding-agents#moving-from-another-crm) from another
  CRM or a spreadsheet.
