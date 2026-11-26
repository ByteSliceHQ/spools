#!/usr/bin/env bun
/**
 * Record scopes, for a database that had records before `scopes` was added to
 * crm.config.json:
 *
 *   spools scopes backfill   give the rows that hang off records (timeline,
 *                            tasks, notes, favourites, folders, uploads,
 *                            sequence runs) their record's scope
 *
 * Until it has run, those rows are only there for a role that reaches every
 * scope. Give every record of a scoped object its scope first: a row on a
 * record without one is left as it is. Safe to run again.
 */
import { disposeRuntime, runServer } from '../server/runtime/app'
import { backfillScopes } from '../server/scope-backfill'
import { asSystem } from '../server/scopes'
import { crmConfig } from '../server/spool'

const [what] = process.argv.slice(2)

if (what !== 'backfill') {
  console.error('Usage: spools scopes backfill')
  process.exit(1)
}

// The app's Spool: its config and its database.
await import(`${process.cwd()}/src/spool.server.ts`)

if (!crmConfig().scopes) {
  console.log('crm.config.json has no "scopes": there is nothing to fill in.')
  process.exit(0)
}

let failed = false

try {
  // Every scope is read and written here: this is the system's own work.
  for (const { table, stamped, left } of await runServer(asSystem(backfillScopes()))) {
    const rest = left > 0 ? `, ${left} left (on no record, or on a record with no scope)` : ''
    console.log(`✓ ${table}: ${stamped} given a scope${rest}`)
  }
} catch (err) {
  failed = true
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
}

await disposeRuntime()
process.exit(failed ? 1 : 0)
