import { Effect } from 'effect'

import { tick } from '../server/marketing'
import { cronRoute } from '../server/runtime/boundary'

/** Leave room to answer before a serverless function's time limit. */
const BUDGET_MS = 45_000

/**
 * Publishes the scheduled posts that are due. For hosts with no long-lived
 * process (SERVERLESS=1): point a cron job at this route and set CRON_SECRET.
 * See docs/marketing.md.
 */
export const marketingHandlers = {
  GET: cronRoute('cron.marketing', () =>
    Effect.map(tick({ budgetMs: BUDGET_MS }), (result) => Response.json({ ok: true, ...result })),
  ),
}
