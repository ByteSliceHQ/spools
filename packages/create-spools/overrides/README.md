# Your CRM

Built with [Spools](https://github.com/ByteSliceHQ/spools).

```sh
bun run db:seed   # demo data, once
bun run dev       # http://localhost:3000
```

Until you choose real services it keeps its records in a Postgres inside the server
(`.data/pglite`) and signs you straight in. A production build refuses to start that
way.

| Change                                           | Where                                     |
| ------------------------------------------------ | ----------------------------------------- |
| Objects, fields, views, actions, email sequences | `crm.config.json`, then `bun run crm:gen` |
| Which services it runs on                        | `src/spool.server.ts`                     |
| Your own handlers and hooks                      | `src/app/extensions.ts`                   |
| Pages                                            | `src/routes`                              |
| Colours                                          | `src/styles.css`                          |
| Workflows and the assistant                      | `swirls/`                                 |

When you're ready for real services, copy what you need from `.env.example` into
`.env`: `DATABASE_URL` for a Postgres (then `bun run db:push`), Clerk's keys for
sign-in. The [docs](https://spools.codes/docs) cover the
rest.

```sh
bun run check                    # types, lint, config, tests
bun run build && bun run start   # production
```
