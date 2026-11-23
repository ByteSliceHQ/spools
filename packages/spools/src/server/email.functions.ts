import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'

import { suppress, verifyUnsubscribeToken } from './email'
import { publicHandler } from './runtime/boundary'
import { Invalid } from './runtime/errors'

/**
 * Unsubscribing, for people who aren't signed in: the page's button proves
 * who they are with the signed token in the link. (Mail clients' one-click
 * unsubscribe is unsubscribe-route.ts, kept apart so the page's browser code
 * never imports it.)
 */

/** The Unsubscribe button on /unsubscribe. */
export const unsubscribeFn = createServerFn({ method: 'POST' })
  .validator(z.object({ token: z.string().max(1000) }))
  .handler(
    publicHandler('email.unsubscribe', ({ data }) =>
      Effect.gen(function* () {
        const email = yield* verifyUnsubscribeToken(data.token)

        if (!email) {
          return yield* new Invalid({ message: 'This unsubscribe link is invalid.' })
        }

        yield* suppress(email, 'unsubscribed')
        return { ok: true }
      }),
    ),
  )
