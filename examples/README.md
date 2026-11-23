# Examples

Adapters written the way an app would write one, with nothing but `@swirls/spools/adapter`.
Copy one into your app's `src/app` and name it in `src/spool.server.ts`. The
[adapter guide](https://spools.codes/docs/adapters#write-your-own) explains each.

| File                                   | What it is                                      |
| -------------------------------------- | ----------------------------------------------- |
| [`postmark.ts`](./postmark.ts)         | An email adapter that sends through Postmark    |
| [`bun-postgres.ts`](./bun-postgres.ts) | A database adapter on Bun's own Postgres client |

```bash
bun run examples   # checks their types and runs their tests
```

`bun-postgres.test.ts` needs a Postgres it may write to, named in `EXAMPLES_DATABASE_URL`, and is
skipped without one.
