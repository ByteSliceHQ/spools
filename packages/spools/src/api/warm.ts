import { Effect } from 'effect'

import { cronRoute } from '../server/runtime/boundary'
import { Store } from '../server/store/store'

/**
 * Keeps a serverless function ready. Such a host puts an idle function away
 * after a couple of minutes, and the next click then waits seconds for it to
 * start again. Point a cron job at this route every minute (with CRON_SECRET
 * set) and someone coming back from a phone call finds the CRM as they left it.
 * It also keeps a database connection open. See docs/deployment.md.
 */
export const warmHandlers = {
  GET: cronRoute(
    'cron.warm',
    () =>
      Effect.gen(function* () {
        const database = yield* (yield* Store).ping
        return Response.json({ ok: true, database })
      }),
    { limit: '15 seconds' },
  ),
}
