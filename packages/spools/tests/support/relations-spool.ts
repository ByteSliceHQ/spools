import { afterAll, beforeAll } from 'bun:test'

import { PGlite } from '@electric-sql/pglite'

import { devAuth } from '../../src/adapters/auth/dev/server'
import { pglite } from '../../src/adapters/database/pglite/server'
import type { Extensions } from '../../src/crm/extensions'
import { disposeRuntime } from '../../src/server/runtime/app'
import { defineSpool, type Spool, spool } from '../../src/server/spool'
import { installStandIns } from '../../src/testing/run'
import crm from '../fixtures/relations.config.json' with { type: 'json' }

/**
 * A Spool of its own for the tests of many-to-many relations: people who have
 * tags (shown from both sides), are on several teams and have mentors, in a
 * PGlite of its own whose tables the adapter makes when it starts. The Spool
 * the preload file defined is put back when the file is done.
 *
 * Only PGlite: another store would need this config's schema pushed to it.
 */
export function useRelationsSpool(extensions: Extensions = {}): void {
  let before: Spool
  let client: PGlite

  beforeAll(async () => {
    before = spool()
    client = await PGlite.create()
    defineSpool({ crm, extensions, auth: devAuth(), database: pglite({ client }) })
    await installStandIns({})
  })

  afterAll(async () => {
    defineSpool({ ...before, crm: before.config })
    await disposeRuntime()
    await client.close()
  })
}

/** The fixture's config, as it is written. */
export const relationsConfig = crm
