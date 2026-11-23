import { Effect } from 'effect'

import { tick } from '../server/campaigns'
import { cronRoute } from '../server/runtime/boundary'

/** Leave room to answer before a serverless function's time limit. */
const BUDGET_MS = 45_000

/**
 * Sends the sequence emails that are due. For hosts with no long-lived process
 * (SERVERLESS=1): point a cron job at this route and set CRON_SECRET. A call that runs
 * out of time leaves the rest for the next one. See docs/campaigns.md.
 */
export const sequencesHandlers = {
  GET: cronRoute('cron.sequences', () =>
    Effect.map(tick({ budgetMs: BUDGET_MS }), (result) => Response.json({ ok: true, ...result })),
  ),
}
