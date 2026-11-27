#!/usr/bin/env bun
import { $ } from 'bun'
/**
 * spools gen: compile crm.config.json into:
 *   - prisma/schema.prisma        (Prisma 8 data contract: system tables, one table
 *                                  per object, one per many-to-many relation)
 *   - crm.config.schema.json      (JSON Schema for editor autocomplete)
 * then run `prisma contract emit`.
 *
 * Usage: spools gen [--no-emit]
 */
import { z } from 'zod'

import { generatePrisma } from '../crm/codegen'
import { crmConfigSchema } from '../crm/config-schema'
import { adaptersOf, spool } from '../server/spool'
import { linkTables } from '../server/store/objects'
import { allTables } from '../server/store/schema-sql'

const root = `${process.cwd()}/`
const raw = await Bun.file(`${root}crm.config.json`).json()
const parsed = crmConfigSchema.safeParse(raw)

if (!parsed.success) {
  console.error('crm.config.json is invalid:\n')
  console.error(z.prettifyError(parsed.error))
  process.exit(1)
}

const config = parsed.data

// The app's Spool says which adapters there are, and so which tables they keep.
await import(`${root}src/spool.server.ts`)
const adapters = adaptersOf(spool())
const tables = allTables(config, adapters)

for (const what of ['model', 'name'] as const) {
  const clash = tables.find((t, i) => tables.findIndex((other) => other[what] === t[what]) !== i)

  if (clash) {
    console.error(
      `crm.config.json has an object or a relations field whose table would be another table's: "${clash[what]}". Rename its key.`,
    )

    process.exit(1)
  }
}

const { schema, warnings } = generatePrisma(config, adapters)
await Bun.write(`${root}prisma/schema.prisma`, schema)

const jsonSchema = z.toJSONSchema(crmConfigSchema, { io: 'input', unrepresentable: 'any' })
await Bun.write(`${root}crm.config.schema.json`, `${JSON.stringify(jsonSchema, null, 2)}\n`)

const objects = Object.keys(config.objects).length
const links = linkTables(config).length

console.log(
  `✓ prisma/schema.prisma (${objects} objects + ${links > 0 ? `${links} links tables + ` : ''}${tables.length - objects - links} system tables)`,
)

console.log('✓ crm.config.schema.json')

for (const w of warnings) {
  console.warn(`⚠ ${w}`)
}

// Run targets can name handlers and kinds from src/app/extensions.ts, so check them
// against the real registry (the schema alone can't know what extensions register).
const { validateRunTargets } = await import('../server/actions')
const problems = validateRunTargets()

if (problems.length > 0) {
  console.error(`\ncrm.config.json has unresolved run targets:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}

if (!process.argv.includes('--no-emit')) {
  await $`bunx prisma contract emit`.cwd(root)
}
