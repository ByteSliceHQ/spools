import { Effect } from 'effect'

import { suppress, verifyUnsubscribeToken } from '../server/email'
import { publicRoute } from '../server/runtime/boundary'

/**
 * One-click unsubscribe from a mail client (RFC 8058, List-Unsubscribe-Post),
 * answered on POST /unsubscribe. The signed token in the link says who.
 * Only the route's server handler imports this, so it stays out of the
 * page's browser code.
 */
const unsubscribe = publicRoute('email.unsubscribeOneClick', (request) =>
  Effect.gen(function* () {
    const token = new URL(request.url).searchParams.get('t') ?? ''
    const email = yield* verifyUnsubscribeToken(token)

    if (!email) {
      return new Response('Invalid token', { status: 400 })
    }

    yield* suppress(email, 'unsubscribed')
    return new Response('Unsubscribed', { status: 200 })
  }),
)

/** RFC 8058 one-click unsubscribe from mail clients (List-Unsubscribe-Post). */
export const unsubscribeHandlers = { POST: unsubscribe }
