import { Effect } from 'effect'

import { suppress } from './email'
import { Email } from './runtime/email'

/** Answers the email provider's delivery webhook: addresses that bounce or complain are suppressed. */
export const handleDelivery = Effect.fn('delivery.handle')(function* (request: Request) {
  const payload = yield* Effect.promise(() => request.text())
  const delivery = yield* (yield* Email).delivery(payload, request.headers)

  if (delivery === 'unconfigured') {
    return new Response('Webhook not configured', { status: 503 })
  }

  if (delivery === 'unverified') {
    return new Response('Invalid signature', { status: 401 })
  }

  for (const { kind, addresses } of delivery.events) {
    yield* Effect.forEach(addresses, (to) => suppress(to, kind), { concurrency: 5 })
  }

  return new Response('ok')
})
