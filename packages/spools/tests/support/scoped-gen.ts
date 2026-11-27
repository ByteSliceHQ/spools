#!/usr/bin/env bun
/**
 * Writes the Prisma schema of the scoped Spool the scopes-*.test.ts files run
 * on, from tests/fixtures/scoped.config.json, and emits its contract
 * (tests/fixtures/scoped/prisma). It is what `spools gen` does for an app; the
 * fixture has no app around it, so this does it here.
 *
 *   bun run test:scopes:gen
 *
 * Run it after changing the fixture, or a system table. CI fails when the
 * files it writes aren't the ones committed.
 */
import { $ } from 'bun'
import { z } from 'zod'

import { generatePrisma } from '../../src/crm/codegen'
import { crmConfigSchema } from '../../src/crm/config-schema'
import raw from '../fixtures/scoped.config.json' with { type: 'json' }

const root = new URL('../fixtures/scoped/', import.meta.url).pathname
const parsed = crmConfigSchema.safeParse(raw)

if (!parsed.success) {
  console.error('tests/fixtures/scoped.config.json is invalid:\n')
  console.error(z.prettifyError(parsed.error))
  process.exit(1)
}

// The scoped Spool's adapters keep no tables of their own (scopes-world.ts).
await Bun.write(`${root}prisma/schema.prisma`, generatePrisma(parsed.data).schema)
await $`bunx prisma contract emit`.cwd(root)
console.log('✓ tests/fixtures/scoped/prisma')
