#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'

/**
 * Makes the relations fixture's database and its tables, for the integration
 * tests on a Postgres store (TEST_STORE=postgres or prisma):
 *
 *   DATABASE_URL=... bun run db:push:relations
 *
 * It writes the Prisma schema for tests/fixtures/relations.config.json, emits
 * its contract (which the Prisma store reads), creates the database beside the
 * one DATABASE_URL names (relations-database.ts) and pushes the schema to it.
 * Running it again changes nothing.
 */
import { $, SQL } from 'bun'

import { devAuth } from '../../src/adapters/auth/dev/server'
import { postgres } from '../../src/adapters/database/postgres/server'
import { generatePrisma } from '../../src/crm/codegen'
import { crmConfigSchema } from '../../src/crm/config-schema'
import crm from '../fixtures/relations.config.json' with { type: 'json' }
import { relationsDatabaseUrl, relationsProject } from './relations-database'

const databaseUrl = process.env['DATABASE_URL']

if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Point it at the database the integration tests use.')
  process.exit(1)
}

const target = relationsDatabaseUrl(databaseUrl)
const name = decodeURIComponent(new URL(target).pathname.slice(1))
const sql = new SQL(databaseUrl)
const [found] = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`

if (!found) {
  await sql.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`)
  console.log(`✓ created the database "${name}"`)
}

await sql.close()

const { schema } = generatePrisma(crmConfigSchema.parse(crm), [devAuth(), postgres()])
await Bun.write(new URL('prisma/schema.prisma', relationsProject), schema)

const project = $.cwd(fileURLToPath(relationsProject)).env({ ...process.env, DATABASE_URL: target })
await project`bun --bun x prisma contract emit`
await project`bun --bun x prisma db update`
