import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'

import { connectionsOverview, disconnect, setupProblems } from './integrations'
import { crmHandler } from './runtime/boundary'
import { mailboxStatus } from './sync'

/**
 * Server functions for the Integrations page. A teammate is sent their own
 * connections and the ones shared with the team, never another person's, and
 * tokens are never returned. Removing one is for whoever it belongs to: its
 * teammate, or for a shared one whoever may manage it.
 */

/** What the teammate can connect, what they and the team have connected, and their mailboxes. */
export const listIntegrationsFn = createServerFn({ method: 'GET' }).handler(
  crmHandler('integrations.list', ({ user }) =>
    Effect.gen(function* () {
      const [overview, mailboxes, problems] = yield* Effect.all(
        [connectionsOverview(user), mailboxStatus(user), setupProblems],
        { concurrency: 'unbounded' },
      )

      return {
        /** Why accounts can't be connected on this deployment yet; empty when they can. */
        problems,
        ...overview,
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
      Effect.map(disconnect(user, data.id), (removed) => ({ removed })),
    ),
  )
