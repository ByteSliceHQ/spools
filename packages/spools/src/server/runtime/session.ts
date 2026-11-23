import { getRequest } from '@tanstack/react-start/server'
import { Effect, Option } from 'effect'

import { spool } from '../spool'
import type { Session } from './auth'
import { CurrentRequest } from './request'

/**
 * The session a program runs for, for an adapter that acts as the person. Null
 * outside a request.
 *
 * It comes from the request the boundary read (`CurrentRequest`). An app's own
 * code (a hook or handler in src/app/extensions.ts) calls back in through
 * src/server/extension-api.ts, outside the request's program, so it has none;
 * for that, and only that, the auth adapter is asked here.
 */
export const currentSession: Effect.Effect<Session | null> = Effect.gen(function* () {
  const request = yield* Effect.serviceOption(CurrentRequest)

  if (Option.isSome(request)) {
    return request.value.session
  }

  return yield* Effect.promise(async () => {
    try {
      // Throws outside a request (a schedule, a script).
      return await spool().auth.session(getRequest())
    } catch {
      return null
    }
  })
})
