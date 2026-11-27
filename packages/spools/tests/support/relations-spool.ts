import { afterAll, beforeAll } from 'bun:test'

import { Effect, Layer } from 'effect'

import { devAuth } from '../../src/adapters/auth/dev/server'
import { pglite } from '../../src/adapters/database/pglite/server'
import { postgres } from '../../src/adapters/database/postgres/server'
import { prisma } from '../../src/adapters/database/prisma/server'
import type { Extensions } from '../../src/crm/extensions'
import { disposeRuntime } from '../../src/server/runtime/app'
import { defineSpool, type Spool, spool } from '../../src/server/spool'
import { linkTables, objectTables } from '../../src/server/store/objects'
import { notNull } from '../../src/server/store/query'
import { Store, type StoreAdapter, type StoreShape } from '../../src/server/store/store'
import { Activity } from '../../src/server/store/tables'
import { db, installStandIns } from '../../src/testing/run'
import crm from '../fixtures/relations.config.json' with { type: 'json' }
import { relationsContract, relationsDatabaseUrl } from './relations-database'

/**
 * A Spool of its own for the tests of many-to-many relations: people who have
 * tags (shown from both sides), are on several teams and have mentors. It is on
 * the store TEST_STORE names, as the preload file's Spool is:
 *
 *   pglite     (default) a PGlite of its own, whose tables the adapter makes
 *   postgres   the fixture's database beside DATABASE_URL (relations-database.ts)
 *   prisma     the same database, through Prisma 8 and the fixture's contract
 *
 * The last two need `bun run db:push:relations` first. The database is the
 * fixture's alone, so its records are emptied before the tests. The Spool the
 * preload file defined, and its DATABASE_URL, are put back when the file is done.
 */

/** What is closed when the file is done. */
type Opened = { adapter: StoreAdapter; close: () => Promise<void> }

async function open(): Promise<Opened> {
  const which = process.env['TEST_STORE'] ?? 'pglite'

  if (which === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite')
    const client = await PGlite.create()
    return { adapter: pglite({ client }), close: () => client.close() }
  }

  if (which !== 'postgres' && which !== 'prisma') {
    throw new Error(`TEST_STORE is "${which}"; use "pglite", "postgres" or "prisma"`)
  }

  const databaseUrl = process.env['DATABASE_URL']

  if (!databaseUrl) {
    throw new Error(`TEST_STORE=${which} needs DATABASE_URL`)
  }

  const contract = Bun.file(relationsContract)

  if (which === 'prisma' && !(await contract.exists())) {
    throw new Error(
      "The relations fixture has no Prisma contract. Run 'bun run db:push:relations' in packages/spools first.",
    )
  }

  // The adapters read DATABASE_URL when they connect: for this file it names the fixture's database.
  process.env['DATABASE_URL'] = relationsDatabaseUrl(databaseUrl)

  return {
    adapter: which === 'prisma' ? prisma({ contract: await contract.json() }) : postgres(),
    close: () => {
      process.env['DATABASE_URL'] = databaseUrl
      return Promise.resolve()
    },
  }
}

/** Empties the fixture's tables: a Postgres keeps what the last run left. Links go with their records. */
async function empty(): Promise<void> {
  const config = spool().config

  for (const { table } of linkTables(config)) {
    await db.remove(table, { filter: notNull('id') })
  }

  for (const table of Object.values(objectTables(config))) {
    await db.remove(table, { filter: notNull('id') })
  }

  await db.remove(Activity, { filter: notNull('id') })
}

/**
 * The names of the tables read since the list was last emptied (`reads.length = 0`),
 * one for each `find` and `countValues`: how a test sees which links a page's work read.
 */
export const reads: string[] = []

/** The same store, noting the table of each read in `reads`. */
const noted = (adapter: StoreAdapter): StoreAdapter => ({
  ...adapter,
  layer: Layer.effect(
    Store,
    Store.use((store) => {
      const find: StoreShape['find'] = (table, query) => {
        reads.push(table.name)
        return store.find(table, query)
      }

      const countValues: StoreShape['countValues'] = (table, column, which) => {
        reads.push(table.name)
        return store.countValues(table, column, which)
      }

      return Effect.succeed(Store.of({ ...store, find, countValues }))
    }),
  ).pipe(Layer.provide(adapter.layer)),
})

export function useRelationsSpool(extensions: Extensions = {}): void {
  let before: Spool
  let opened: Opened

  beforeAll(async () => {
    before = spool()
    opened = await open()
    defineSpool({ crm, extensions, auth: devAuth(), database: noted(opened.adapter) })
    await installStandIns({})
    await empty()
  })

  afterAll(async () => {
    defineSpool({ ...before, crm: before.config })
    await disposeRuntime()
    await opened.close()
  })
}

/** The fixture's config, as it is written. */
export const relationsConfig = crm
