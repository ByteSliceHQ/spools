import { z } from 'zod'

import { validateRunTargets } from './actions'
import { startSequences } from './campaigns'
import { logEnvironment } from './env'
import { withSecurityHeaders } from './headers'
import { validateIntegrations } from './integrations'
import { startMarketing } from './marketing'
import { validateMarketing } from './marketing-networks'
import { runtime } from './runtime/app'
import { crmConfig } from './spool'
import { SCOPES_ENFORCED } from './store/scope'
import { startSync } from './sync'

type Handler = { fetch(request: Request): Response | Promise<Response> }

/** A schedule that can't start (the database is down at boot) is said once, not left as an unhandled rejection. */
const schedule = (name: string, started: Promise<unknown>) =>
  void started.catch((cause: unknown) => {
    console.error(`[server] The ${name} schedule did not start`, cause)
  })

/** What a fetch that was called off throws. A DOMException is not always an `Error` instance, so its name decides. */
const abort = z.object({ name: z.literal('AbortError') })

/**
 * The server entry of a Spool, over TanStack Start's: reports the environment,
 * checks the config's run targets, starts the two schedules (sequence emails,
 * mailbox sync), and answers requests, each answer with the headers in headers.ts. Called once when the server boots (dev
 * and prod), after src/spool.server.ts has defined the Spool.
 */
export function serveSpool(start: Handler): Handler {
  logEnvironment()

  // A config that asks for scopes must get them. Until the store keeps to them, don't serve it.
  if (crmConfig().scopes && !SCOPES_ENFORCED) {
    throw new Error(
      'crm.config.json has "scopes", which this version reads but does not enforce yet: ' +
        'every allowed user would still see every record. Remove the key to start the server.',
    )
  }

  // Fail loudly if the config references a workflow kind, campaign or handler that doesn't exist.
  const problems = validateRunTargets()

  if (problems.length > 0) {
    const message = `crm.config.json has unresolved run targets:\n  ${problems.join('\n  ')}`

    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(message)
    }

    console.error(`[config] ${message}`)
  }

  for (const problem of validateMarketing()) {
    console.warn(`[marketing] ${problem}`)
  }

  for (const problem of validateIntegrations()) {
    console.warn(`[integrations] ${problem}; it is not offered`)
  }

  // Send sequence emails as they fall due (on a serverless host a cron job does this instead).
  schedule('sequence', runtime().runPromise(startSequences()))
  // Read teammates' mailboxes and calendars on a schedule (a no-op until an account grants access).
  schedule('mailbox sync', runtime().runPromise(startSync()))
  // Publish scheduled posts as they fall due (a no-op without `marketing.channels` in the config).
  schedule('marketing', runtime().runPromise(startMarketing()))

  return {
    async fetch(request) {
      try {
        return withSecurityHeaders(await start.fetch(request))
      } catch (err) {
        // The browser went away mid-request (a navigation cancels in-flight loads).
        // Nobody is waiting for a response, so this is not an error worth logging.
        if (request.signal.aborted && abort.safeParse(err).success) {
          return new Response(null, { status: 499 })
        }

        throw err
      }
    },
  }
}
