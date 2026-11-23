import { defineSpool } from '@swirls/spools'
import { swirls } from '@swirls/spools/agents/swirls'
import { clerk } from '@swirls/spools/auth/clerk'
import { devAuth } from '@swirls/spools/auth/dev'
import { pglite } from '@swirls/spools/database/pglite'
import { databaseUrl } from '@swirls/spools/database/postgres'
import { prisma } from '@swirls/spools/database/prisma'
import { resend } from '@swirls/spools/email/resend'
import { flashdrive } from '@swirls/spools/files/flashdrive'
import { cipherstash } from '@swirls/spools/vault/cipherstash'

import crm from '../crm.config.json' with { type: 'json' }
import contract from '../prisma/schema.json' with { type: 'json' }
import extensions from './app/extensions'

/**
 * Your Spool: the config, your own code and the services it runs on. To change
 * a service, change its adapter here (and in spool.ui.ts when it has a browser
 * half). See docs/adapters.md.
 */

// A copy with no keys still runs on your machine: a database inside the server, and a sign-in that
// lets you straight in. In a build this is always "production", so a deployment that is missing its
// keys refuses to start instead of falling back to either.
const development = process.env['NODE_ENV'] !== 'production'
const isSet = (name: string) => !!process.env[name] && !process.env[name]?.endsWith('...')

export default defineSpool({
  crm,
  extensions,
  auth: development && !isSet('CLERK_SECRET_KEY') ? devAuth() : clerk(),
  database: development && !databaseUrl(process.env) ? pglite() : prisma({ contract }),
  files: flashdrive(),
  email: resend(),
  vault: cipherstash(),
  agents: swirls(),
})
