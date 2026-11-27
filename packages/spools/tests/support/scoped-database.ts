import { $, SQL } from 'bun'

import type { AnyTable } from '../../src/server/store/table'

/**
 * The database the scoped Spool of scopes-*.test.ts runs on when TEST_STORE
 * names a real Postgres (tests/integration/scopes-world.ts). Its config is not
 * the starter's: both have companies, contacts and deals, with different
 * columns, so the two can't share a database. This one is the tests' own: on
 * the server DATABASE_URL names, called as that database with `_scopes` after
 * it, or wherever TEST_SCOPES_DATABASE_URL says (for a server where the tests
 * may not create a database).
 *
 * It is made if it isn't there, brought up to the fixture's schema with Prisma
 * (tests/fixtures/scoped/prisma, as `bun run db:push` does for an app), and
 * emptied: the tests seed it themselves, once per run.
 */

const fixture = new URL('../fixtures/scoped/', import.meta.url).pathname

const SUFFIX = '_scopes'

/** Where the scoped Spool's database is, from the environment. */
export function scopedDatabaseUrl(env: Record<string, string | undefined>): string {
  const own = env['TEST_SCOPES_DATABASE_URL']

  if (own) {
    return own
  }

  const main = env['DATABASE_URL']

  if (!main || !URL.canParse(main)) {
    throw new Error(
      'TEST_STORE names a Postgres store, so DATABASE_URL must be the connection string of a database made for tests',
    )
  }

  const url = new URL(main)
  url.pathname = `${url.pathname}${SUFFIX}`
  return url.toString()
}

const databaseName = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1))
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`

/**
 * Makes the scoped Spool's database ready and empty, and says where it is.
 * `tables` are the ones the Spool has: they are what is emptied.
 */
export async function prepareScopedDatabase(
  env: Record<string, string | undefined>,
  tables: readonly AnyTable[],
): Promise<string> {
  const url = scopedDatabaseUrl(env)
  const name = databaseName(url)

  // Everything below empties tables. Only ever in a database that is plainly the tests' own.
  if (!env['TEST_SCOPES_DATABASE_URL'] && !name.endsWith(SUFFIX)) {
    throw new Error(`Refusing to prepare "${name}": it is not the scoped tests' database`)
  }

  const main = env['DATABASE_URL']

  if (!env['TEST_SCOPES_DATABASE_URL'] && main) {
    const server = new SQL(main)

    try {
      const [there] = await server`select 1 as n from pg_database where datname = ${name}`

      if (!there) {
        await server.unsafe(`create database ${ident(name)}`)
      }
    } finally {
      await server.close()
    }
  }

  await $`bun --bun x prisma db update`
    .cwd(fixture)
    .env({ ...env, DATABASE_URL: url })
    .quiet()

  const database = new SQL(url)

  try {
    await database.unsafe(
      `truncate ${tables.map((table) => `"public".${ident(table.name)}`).join(', ')} cascade`,
    )
  } finally {
    await database.close()
  }

  return url
}
