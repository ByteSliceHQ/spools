import { defineSpool } from '@swirls/spools'
import { swirls } from '@swirls/spools/agents/swirls'
import { devAuth } from '@swirls/spools/auth/dev'
import { pglite } from '@swirls/spools/database/pglite'
import { databaseUrl } from '@swirls/spools/database/postgres'
import { prisma } from '@swirls/spools/database/prisma'
import { resend } from '@swirls/spools/email/resend'
import { flashdrive } from '@swirls/spools/files/flashdrive'
import { cipherstash } from '@swirls/spools/vault/cipherstash'

import crm from '../crm.config.json' with { type: 'json' }
import contract from '../prisma/schema.json' with { type: 'json' }
import extensions from '../src/app/extensions'
import { stubAgents } from './assistant-stub'

/**
 * The app with sign-in stubbed (vite.config.e2e.ts uses this in place of
 * src/spool.server.ts). The app's own access list still decides who gets in.
 */
export default defineSpool({
  crm,
  extensions,
  database: databaseUrl(process.env) ? prisma({ contract }) : pglite(),
  files: flashdrive(),
  email: resend(),
  vault: cipherstash(),
  agents: process.env['E2E_ASSISTANT'] === 'stub' ? stubAgents() : swirls(),
  auth: devAuth({
    teammates: [
      // A teammate on the default allowlist domain, and an outsider who must never be listed.
      { id: 'user_teammate', name: 'Tess Teammate', email: 'tess@example.com' },
      { id: 'user_outsider', name: 'Otto Outsider', email: 'otto@elsewhere.test' },
    ],
  }),
})
