/**
 * Runs before every test file (bunfig.toml): makes a Spool this process's, as
 * src/server.ts does when the server starts. It is the app's config and
 * extensions and the adapters a deployment uses (which are off without their
 * keys), with the development sign-in and the store TEST_STORE names:
 *
 *   pglite     (default) Postgres in this process: nothing to install
 *   postgres   the Postgres at DATABASE_URL, through Effect SQL
 *   prisma     the Postgres at DATABASE_URL, through Prisma 8
 *
 * The last two need the schema pushed first (`bun run db:push`). Point
 * DATABASE_URL at a database made for tests, never at the one you work in.
 */
import crm from '../../../../apps/starter/crm.config.json' with { type: 'json' }
import contract from '../../../../apps/starter/prisma/schema.json' with { type: 'json' }
import extensions from '../../../../apps/starter/src/app/extensions'
import { swirls } from '../../src/adapters/agents/swirls/server'
import { devAuth } from '../../src/adapters/auth/dev/server'
import { pglite } from '../../src/adapters/database/pglite/server'
import { postgres } from '../../src/adapters/database/postgres/server'
import { prisma } from '../../src/adapters/database/prisma/server'
import { resend } from '../../src/adapters/email/resend/server'
import { flashdrive } from '../../src/adapters/files/flashdrive/server'
import { cipherstash } from '../../src/adapters/vault/cipherstash/server'
import { defineSpool } from '../../src/server/spool'
import type { StoreAdapter } from '../../src/server/store/store'

async function store(): Promise<StoreAdapter> {
  const which = process.env['TEST_STORE'] ?? 'pglite'

  if (which === 'postgres') {
    return postgres()
  }

  if (which === 'prisma') {
    return prisma({ contract })
  }

  if (which !== 'pglite') {
    throw new Error(`TEST_STORE is "${which}"; use "pglite", "postgres" or "prisma"`)
  }

  // One instance for the whole run: a test that swaps a service rebuilds the runtime, and the rows must outlive that.
  const { PGlite } = await import('@electric-sql/pglite')
  return pglite({ client: await PGlite.create() })
}

defineSpool({
  crm,
  extensions,
  auth: devAuth(),
  database: await store(),
  files: flashdrive(),
  email: resend(),
  vault: cipherstash(),
  agents: swirls(),
})
