# When to use Spools

Spools is for teams that want a CRM shaped around their work and build software with coding agents or
TypeScript.

## Choose Spools when

- **You want your agents to build it.** They write the part that is yours, on sign-in, data, security
  and email that are already built.
- **Your objects aren't the usual ones.** You track jobs, sites, policies, or placements,
  and you want them to be first-class records with their own pipelines.
- **You want the data in your own database.** Records are ordinary tables in your Postgres,
  which your other software can read.
- **The CRM has to do something particular.** Winning a deal should open a project, or a new
  contact should be checked against another system. Hooks and handlers are plain TypeScript
  in your repository.
- **You have already chosen your services.** You use a certain sign-in provider, mail
  provider, or cloud, and the CRM should use them too.
- **You want agents working on records.** The assistant and your Swirls workflows go through
  the same checks, hooks, and timeline as your team.
- **You build CRMs for clients.** Each client's CRM is a small repository: a config, a file of
  services, and whatever is theirs alone. The framework updates as a package.

## Choose something else when

- **Nobody on the team works with code or coding agents.** Views, filters, and reports can be
  changed in the app, while objects, fields, and services are changed in files. A hosted CRM is a
  better fit.
- **You need a marketplace of plugins today.** Spools has extension points and a handful of
  adapters. It does not have a catalog of third-party apps.
- **You need a telephone dialer, quoting, or billing.** None of these is built in.
- **You need permissions per record or per field.** Everyone who may use a Spool can see and
  change every record. The access list decides who that is.
- **You need a stable API today.** Spools is in its 0.x releases, and minor versions may
  include breaking changes.

## What you need to run one

|          |                                                                           |
| -------- | ------------------------------------------------------------------------- |
| Runtime  | [Bun](https://bun.sh) 1.4 or newer, in a container, on a VM, or on Vercel |
| Database | Postgres 15 or newer (tested on 17)                                       |
| Sign-in  | Clerk, or Better Auth in your own database                                |
| Optional | A mail provider, a place for files, a key for the vault, a Swirls project |

Spools is written with [TanStack Start](https://tanstack.com/start) and
[Effect](https://effect.website). You can configure a Spool and write hooks and pages without knowing either. You need Effect to write
an adapter or to work on the framework.

## Compared with a template

Spools began as a template you copied and merged updates into. The framework is now a package. Your
repository holds your own files and a version number, so you never merge the framework.
