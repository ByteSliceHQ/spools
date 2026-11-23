import { Effect } from 'effect'

import { publicRoute } from '../server/runtime/boundary'
import { spool } from '../server/spool'

/** The auth adapter's own endpoints, when it has any (a sign-in that runs from this server). */
const handle = (request: Request) => {
  const own = spool().auth.handle
  return own
    ? Effect.promise(() => own(request))
    : Effect.succeed(new Response('Not found', { status: 404 }))
}

export const authHandlers = {
  GET: publicRoute('auth.get', handle),
  POST: publicRoute('auth.post', handle),
}
