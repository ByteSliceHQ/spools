import { Effect } from 'effect'
import { z } from 'zod'

import { NO_OFFERS, OUTCOMES, type Outcome, resolveGuides } from '../crm/guides'
import * as config from './runtime/config'
import { failWhen, Invalid } from './runtime/errors'
import { crmConfig } from './spool'
import { Store } from './store/store'
import { GuideProgress } from './store/tables'

/**
 * Which guides each person has finished or dismissed (the `guide_progress`
 * table), so a guide is offered once and stays away on every device.
 *
 * Every function takes the user id from the caller, which gets it from the
 * boundary (`crmHandler`): a browser never names whose progress it is asking about.
 */

/**
 * Whether guides are offered at all. `CRM_GUIDES=off` keeps them quiet (the
 * stubbed-sign-in harness sets it); the Help menu still replays them.
 */
export const guidesOffered: Effect.Effect<boolean> = config.read(config.guidesOffered)

/** A guide of this CRM, or the marker for "don't offer me guides". */
export function isGuideId(id: string): boolean {
  return id === NO_OFFERS || resolveGuides(crmConfig()).some((g) => g.id === id)
}

/**
 * What the browser may send (src/server/guides.functions.ts). Neither has a user
 * id: anything else in the request, a user id included, is dropped.
 */
export const markInput = z.object({
  id: z
    .string()
    .max(64)
    .refine((id) => id !== NO_OFFERS && isGuideId(id), 'Unknown guide'),
  outcome: z.enum(OUTCOMES),
})
export const offersInput = z.object({ on: z.boolean() })

/** The ids of the guides this person has finished or dismissed. */
export const seenGuides = Effect.fn('guides.seenGuides')(function* (userId: string) {
  const store = yield* Store
  const rows = yield* store.find(GuideProgress, { where: { userId }, limit: 500 })
  return rows.map((r) => r.guideId)
})

/**
 * Record that a guide is over for someone. The first outcome stands: replaying
 * a guide later and closing it does not change what was recorded.
 */
export const markGuide = Effect.fn('guides.markGuide')(function* (
  userId: string,
  guideId: string,
  outcome: Outcome,
) {
  yield* failWhen(!isGuideId(guideId), () => new Invalid({ message: `Unknown guide "${guideId}"` }))
  const store = yield* Store
  const existing = store.first(GuideProgress, { where: { userId, guideId } })

  if (yield* existing) {
    return
  }

  yield* store.insert(GuideProgress, { userId, guideId, outcome }).pipe(
    // Two tabs answered at once; the unique index kept one row.
    Effect.catchTag('DatabaseError', (error) =>
      Effect.flatMap(existing, (row) => (row ? Effect.void : Effect.fail(error))),
    ),
  )
})

/** Turn offers off for someone, or back on. What they have already seen is kept either way. */
export const setGuideOffers = Effect.fn('guides.setGuideOffers')(function* (
  userId: string,
  on: boolean,
) {
  if (on) {
    const store = yield* Store
    yield* store.remove(GuideProgress, { where: { userId, guideId: NO_OFFERS } })
  } else {
    yield* markGuide(userId, NO_OFFERS, 'dismissed')
  }
})
