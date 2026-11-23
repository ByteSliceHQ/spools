import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'

import {
  disconnect,
  listConnections,
  providerConfigured,
  providers,
  setupProblems,
} from './integrations'
import { crmHandler } from './runtime/boundary'
import * as config from './runtime/config'
import { mailboxStatus } from './sync'

/**
 * Server functions for the Integrations page. Everything is scoped to the
 * signed-in teammate: nobody can see or remove another person's connection, and
 * tokens are never returned.
 */

/** What the teammate can connect, what they have connected, and their mailboxes. */
export const listIntegrationsFn = createServerFn({ method: 'GET' }).handler(
  crmHandler('integrations.list', ({ user }) =>
    Effect.gen(function* () {
      const [connections, mailboxes, problems, env] = yield* Effect.all(
        [listConnections(user.id), mailboxStatus(user), setupProblems, config.environment],
        { concurrency: 'unbounded' },
      )

      const offered = providers()
      return {
        /** Why accounts can't be connected on this deployment yet; empty when they can. */
        problems,
        providers: Object.entries(offered).map(([id, p]) => ({
          id,
          label: p.label,
          description: p.description,
          /** Whoever runs the CRM has set this provider's client id and secret. */
          available: providerConfigured(id, env),
          mailbox: !!p.mailbox,
        })),
        connections: connections.map((c) => ({
          id: c.id,
          provider: c.provider,
          label: offered[c.provider]?.label ?? c.provider,
          account: c.account,
          status: c.status,
          lastError: c.lastError,
          connectedAt: c.connectedAt.toISOString(),
          mailbox: !!offered[c.provider]?.mailbox,
        })),
        /** Every mailbox the CRM uses for this teammate: the sign-in account and the connected ones. */
        mailboxes,
      }
    }),
  ),
)

export const disconnectIntegrationFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(
    crmHandler('integrations.disconnect', ({ data, user }) =>
      Effect.map(disconnect(user.id, data.id), (removed) => ({ removed })),
    ),
  )
