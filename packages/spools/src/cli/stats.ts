#!/usr/bin/env bun
/**
 * Fill in every record's "last activity", "last contacted" and "next task due"
 * from the activities and tasks already in the database.
 *
 * The app keeps these up to date as activities and tasks are written. Run this
 * once after adding the columns to a database that already has records (the
 * upgrade that introduced them), or whenever activities were written some other
 * way (an import straight into the table). Safe to run again.
 *
 * Exits with an error, naming the object, if any object could not be done.
 */
import { refreshStats } from '../server/records'
import { disposeRuntime, runServer } from '../server/runtime/app'
import { crmConfig } from '../server/spool'

// The app's Spool: its config and its database.
await import(`${process.cwd()}/src/spool.server.ts`)

let failed = 0

for (const objectKey of Object.keys(crmConfig().objects)) {
  try {
    await runServer(refreshStats(objectKey))
    console.log(`✓ ${objectKey}`)
  } catch (err) {
    failed++
    console.error(`✗ ${objectKey}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

await disposeRuntime()

if (failed > 0) {
  console.error(
    `\n${failed} object(s) were not refreshed. Fix the problem and run this again; it is safe to repeat.`,
  )

  process.exit(1)
}

process.exit(0)
