import { Effect } from 'effect'

import { cronRoute } from '../server/runtime/boundary'
import { syncAll } from '../server/sync'

/** Leave room to answer before a serverless function's time limit. */
const BUDGET_MS = 45_000

/**
 * Runs one pass of the mailbox sync. For hosts with no long-lived process
 * (SERVERLESS=1): point a cron job at this route and set CRON_SECRET. A pass that runs
 * out of time leaves the remaining accounts for the next one.
 */
export const mailSyncHandlers = {
  GET: cronRoute('cron.mailSync', () =>
    Effect.map(syncAll({ budgetMs: BUDGET_MS }), (run) =>
      Response.json({ ok: !run.problem, ...run }, { status: run.problem ? 503 : 200 }),
    ),
  ),
}
