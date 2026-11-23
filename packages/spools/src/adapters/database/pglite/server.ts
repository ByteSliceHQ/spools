import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { PGliteInterface } from '@electric-sql/pglite'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'

import { adaptersOf, spool } from '../../../server/spool'
import { allTables, schemaSql } from '../../../server/store/schema-sql'
import { sqlStore } from '../../../server/store/sql-store'
import type { StoreAdapter } from '../../../server/store/store'

/**
 * Postgres inside the server process (PGlite): nothing to install, no Docker.
 * For trying a Spool out, for development and for tests.
 *
 * The tables are made, and kept up with the config, each time it starts
 * (src/server/store/schema-sql.ts: it only adds). One process can open a data
 * directory at a time, so it is not for a deployment with several instances;
 * use `postgres()` there.
 */
export type PgliteOptions = {
  /** Where the data is kept. Default `.data/pglite`. `"memory"` keeps it in this process only. */
  dataDir?: string
  /** An instance you opened yourself, used instead of opening one. It is left open. */
  client?: PGliteInterface
}

export function pglite({ dataDir = '.data/pglite', client }: PgliteOptions = {}): StoreAdapter {
  // Loaded when it is used: it carries a database, which an app on another adapter shouldn't load.
  const sql = Layer.unwrap(
    Effect.promise(async () => {
      const { PgliteClient } = await import('@effect/sql-pglite')

      if (client) {
        return PgliteClient.layerFrom(PgliteClient.fromClient({ liveClient: client }))
      }

      if (dataDir === 'memory') {
        return PgliteClient.layer()
      }

      mkdirSync(dirname(dataDir), { recursive: true })
      return PgliteClient.layer({ dataDir })
    }),
  )

  const tables = Layer.effectDiscard(
    Effect.gen(function* () {
      const run = yield* SqlClient.SqlClient

      for (const statement of schemaSql(allTables(spool().config, adaptersOf(spool())))) {
        yield* run.unsafe(statement)
      }
    }),
  )

  return {
    id: 'pglite',
    label: 'PGlite',
    layer: sqlStore.pipe(
      Layer.provide(tables.pipe(Layer.provideMerge(sql))),
      // Nothing works without a database, and there is nothing to retry: say why and stop.
      Layer.orDie,
    ),
  }
}
