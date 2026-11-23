import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import * as guides from './guides'
import { crmHandler } from './runtime/boundary'

/**
 * What the browser may change about guides: its own progress, and nothing
 * else. Neither function takes a user id; it is always the signed-in person's.
 * What they have seen arrives with the session (`getCrmSession`).
 */

/** A guide was finished or dismissed: don't offer it to this person again. */
export const markGuideFn = createServerFn({ method: 'POST' })
  .validator(guides.markInput)
  .handler(
    crmHandler('markGuide', ({ data, user }) =>
      guides.markGuide(user.id, data.id, data.outcome).pipe(Effect.as({ ok: true })),
    ),
  )

/** Stop offering this person guides, or start again. */
export const setGuideOffersFn = createServerFn({ method: 'POST' })
  .validator(guides.offersInput)
  .handler(
    crmHandler('setGuideOffers', ({ data, user }) =>
      guides.setGuideOffers(user.id, data.on).pipe(Effect.as({ ok: true })),
    ),
  )
