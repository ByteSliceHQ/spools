# Contributing to Spools

Thanks for helping improve Spools. We welcome code, documentation, adapters, bug reproductions, and reviews from people at every experience level. You do not need to be a regular contributor to take part.

Read the [documentation](https://spools.codes/docs) for the project concepts and the [code of conduct](./CODE_OF_CONDUCT.md) for community expectations.

## Choose a contribution

Search [issues](https://github.com/ByteSliceHQ/spools/issues) and [pull requests](https://github.com/ByteSliceHQ/spools/pulls) before starting, so you can build on existing work.

Small fixes and documentation improvements can go straight to a pull request. For a new public API, a new port, or a substantial change in behavior, open an issue first. Describe the problem, a concrete use case, and alternatives you have considered. Discussing the approach early can save you work on a change that does not fit the project.

If you are unsure where to begin, the [roadmap](./ROADMAP.md) lists what is planned. Questions and incomplete investigations are welcome when you explain what you know and where you are stuck.

## Report a bug or ask for help

Use the bug report form for a reproducible problem. Include the affected packages and versions, the adapters in use, steps to reproduce, and expected versus actual behavior. A small repository or self-contained example is more useful than a large application dump.

For usage questions, check the [documentation](https://spools.codes/docs), then open an issue with enough context for someone else to follow your setup.

Remove API keys, customer data, and other sensitive content before sharing logs or examples. Report suspected vulnerabilities privately to [security@swirls.ai](mailto:security@swirls.ai); see [SECURITY.md](./SECURITY.md).

## Local development

Install Git and [Bun](https://bun.sh). Use the Bun version in the root `package.json` (`1.4.4` at the time of writing). Fork the repository on GitHub, clone your fork, and create a branch for your change:

```bash
git clone https://github.com/YOUR_USERNAME/spools.git
cd spools
git switch -c your-change
bun install --frozen-lockfile
```

There is nothing to sign up for. With no keys set, the starter keeps its records in a Postgres inside the server (`apps/starter/.data/pglite`) and signs you in as `dev@example.com`.

```bash
bun run dev             # the starter at http://localhost:3000, the website at http://127.0.0.1:8788
bun run verify          # build, type checks, tests, lint, and formatting checks
bun run fmt             # oxfmt (write)
bun run fmt:check       # oxfmt --check
bun run check:package   # a new Spool from the packed packages
```

### Useful filters

```bash
bun run demo                                    # the starter alone
bun run docs                                    # the website alone
bunx turbo run test --filter=@swirls/spools
bunx turbo run check-types --filter=@spools/starter
```

### Tests on every database

The integration tests run on PGlite in the test process. CI also runs them on Postgres through Effect SQL and through Prisma. To do the same, point `DATABASE_URL` at a database made for tests, push the schema from `apps/starter`, and run them from the root. The tests write to it.

```bash
DATABASE_URL=postgresql://localhost/spools_test bun run --cwd apps/starter db:push
TEST_STORE=postgres DATABASE_URL=postgresql://localhost/spools_test bun run test:integration
TEST_STORE=prisma DATABASE_URL=postgresql://localhost/spools_test bun run test:integration
```

The record-scope tests use a second database beside that one (`spools_test_scopes`), which they make, push their own schema to and empty themselves. See [Database](docs/database.md#tests).

### Optional tools

[Flox](https://flox.dev) provides the repository's configured development environment:

```bash
flox activate
bun install
bun run verify
```

To see the starter signed out, as someone else, or with canned assistant replies:

```bash
DEV_AUTH_SIGNED_OUT=1 bun run demo
DEV_AUTH_EMAIL=someone@else.test bun run demo            # not on the access list
E2E_ASSISTANT=stub bun run --cwd apps/starter dev:e2e    # on :3100
```

To test the starter's interface in a browser (Chromium, with Playwright), run `bun run test:e2e` from the root. It builds the starter with the stubbed sign-in, starts it on seeded databases of its own under `apps/starter/e2e/.data`, and runs the tests in `apps/starter/e2e/tests`.
The first run needs the browser: `bunx playwright install chromium`.

To run the React Doctor audit:

```bash
bun run doctor
```

## Find your way around

| Path                     | Role                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| `packages/spools`        | The framework, published as `@swirls/spools`                            |
| `packages/create-spools` | `bun create @swirls/spools`, published as `@swirls/create-spools`       |
| `apps/starter`           | A working Spool: what a new one starts as, and where the framework runs |
| `apps/docs`              | Source for [spools.codes](https://spools.codes)                         |
| `examples/`              | Adapters written outside the framework                                  |
| `docs/`                  | The documentation, in Markdown                                          |
| `tools/oxlint/`          | Repository lint rules                                                   |
| `turbo.json`             | Workspace task graph                                                    |

[Architecture](https://spools.codes/docs/architecture) explains how a Spool is put together and how a request flows. For changes to the server, also read [server code](https://spools.codes/docs/server-code). [AGENTS.md](./AGENTS.md) is a map of where each kind of change goes, for people and coding agents alike.

## Prepare a change for review

Keep a pull request focused on one problem. Follow the surrounding code conventions and explain any change to public behavior. A change to the tables or to `crm.config.json` needs a word on what people with data in them have to do.

Some things we hold to:

- **Extend, don't patch.** A change should add or use an extension point, so that nobody has to edit the framework to get what they need.
- **Ports, not vendors.** The framework asks for a port and never imports an adapter, a vendor's SDK, or the app. Lint refuses it. An adapter that can't keep a port's promise is a reason to talk before bending the port.
- **A new adapter** passes the tests the others do and works without an account in CI. See [writing an adapter](https://spools.codes/docs/adapters#write-your-own).
- **Config first.** If a feature can be expressed in `crm.config.json`, add it to the schema with validation and a clear message, to the generator if it affects storage, and to the [configuration reference](./docs/configuration.md).
- **Generated files are committed.** Run `bun run crm:gen` in `apps/starter` after changing the config or the tables, and `bun run build` after adding a route. CI fails when they are out of date.

Every commit follows [Conventional Commits](https://www.conventionalcommits.org/), and so does the pull request's title.

Use the PR template to explain the problem, the resulting behavior, and how a reviewer can evaluate the change. Link related issues and call out uncertainties or tradeoffs. Draft pull requests are welcome if you want feedback before the work is complete.

You are responsible for understanding and being able to explain the changes you submit, whatever tools you use. Keep descriptions and discussions in your own words and grounded in the work.

### Existing PR checklist

- [ ] `bun run verify` passes
- [ ] Changeset added if `@swirls/spools` behavior changes (`bun run changeset`)
- [ ] Docs updated for API / architecture changes

See [`RELEASE.md`](./RELEASE.md) for versioning and publishing.

## Review and participation

Maintainers review contributions for project fit, correctness, compatibility, and clarity. They may request changes or suggest a smaller approach. If a proposal is declined, maintainers should explain the reason so the discussion remains useful to future contributors.

Keep technical decisions in the issue or pull request where others can follow them. Respectful disagreement is welcome. Explain your reasoning, ask questions, and allow room for people to learn or correct a mistake. Review timing depends on maintainer availability; a concise follow-up on the original thread is welcome if it has gone quiet.

## Contribution terms

By intentionally submitting a contribution for inclusion in Spools, you agree to license it under the project's [Apache-2.0 license](./LICENSE), unless a separate agreement explicitly applies. Only submit work you have the right to contribute. Preserve applicable copyright and license notices and identify the source of any code or assets you bring into the repository.
