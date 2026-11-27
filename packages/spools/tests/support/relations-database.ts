/**
 * Where the relations fixture's tables are kept on a Postgres store. Its
 * config is not the starter's (its `companies` has other columns), and Prisma
 * refuses a database that holds tables its contract doesn't, so the fixture has
 * a database of its own beside the one `DATABASE_URL` names: the same server,
 * the same name with `_relations` after it.
 *
 * `bun run db:push:relations` (push-relations.ts) makes it and pushes the
 * fixture's schema to it.
 */
export function relationsDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  url.pathname = `${url.pathname.replace(/\/$/, '')}_relations`
  return url.toString()
}

/** The folder the fixture's Prisma project is in: its config, and the schema and contract generated for it. */
export const relationsProject = new URL('../fixtures/relations/', import.meta.url)

/** The contract `prisma contract emit` wrote for the fixture. Generated, not committed. */
export const relationsContract = new URL('prisma/schema.json', relationsProject)
