import { Effect, Layer, Option, Schema } from 'effect'
import { Resend } from 'resend'

import * as config from '../../../server/runtime/config'
import { type Delivery, Email, type EmailAdapter, EmailError } from '../../../server/runtime/email'
import { policies, withPolicy } from '../../../server/runtime/policies'

/**
 * Email through Resend (https://resend.com).
 *
 *   RESEND_API_KEY         unset -> emails are logged, not sent
 *   EMAIL_FROM             e.g. "Acme <hello@acme.com>" on a Resend-verified domain
 *   RESEND_WEBHOOK_SECRET  signs the bounce and complaint webhook (/api/webhooks/email)
 */

/**
 * The part of a Resend webhook this code reads. The SDK checks the signature and
 * then hands back the JSON as it came, so its shape is checked here.
 */
const WebhookEvent = Schema.Struct({
  type: Schema.String,
  data: Schema.Struct({
    to: Schema.optional(Schema.Union([Schema.mutable(Schema.Array(Schema.String)), Schema.String])),
  }),
})

type WebhookEvent = typeof WebhookEvent.Type

/** Resend's answers that a later try may change: rate limits and its own failures. */
const transient = new Set(['rate_limit_exceeded', 'application_error', 'internal_server_error'])

class Refused {
  readonly _tag = 'Refused'
  constructor(
    readonly name: string,
    readonly message: string,
  ) {}
}

const KINDS = { 'email.bounced': 'bounced', 'email.complained': 'complained' } as const

/** Whether an event type is one the CRM acts on (an own key, so `toString` and the like are not). */
const isKind = (type: string): type is keyof typeof KINDS => Object.hasOwn(KINDS, type)

/** Which addresses a Resend event is about, when it is one the CRM acts on. Exported for tests. */
export function deliveryOf(event: WebhookEvent): Delivery {
  const kind = isKind(event.type) ? KINDS[event.type] : undefined

  const { to } = event.data
  const addresses = Array.isArray(to) ? to : to ? [to] : []
  return { events: kind && addresses.length > 0 ? [{ kind, addresses }] : [] }
}

export const resend = (): EmailAdapter => ({
  id: 'resend',
  label: 'Resend',
  features: [
    { name: 'Campaign email (Resend)', vars: ['RESEND_API_KEY', 'EMAIL_FROM'] },
    { name: 'Bounce/complaint suppression', vars: ['RESEND_WEBHOOK_SECRET'] },
  ],
  layer: Layer.sync(Email, () => {
    let client: { key: string; resend: Resend } | undefined

    const resendFor = (key: string) => {
      if (client?.key !== key) {
        client = { key, resend: new Resend(key) }
      }

      return client.resend
    }

    const send = Effect.fn('Email.send')(function* (
      email: Parameters<typeof Email.Service.send>[0],
    ) {
      const key = yield* config.variable('RESEND_API_KEY')
      const from = yield* config.variable('EMAIL_FROM')

      if (!key || !from) {
        yield* Effect.logInfo(
          `[email] RESEND_API_KEY/EMAIL_FROM unset; not sending "${email.subject}" to ${email.to}`,
        )

        return { id: null, sent: false }
      }

      const { idempotencyKey, ...message } = email
      const api = resendFor(key)

      const attempt = Effect.tryPromise({
        try: () =>
          api.emails.send({ from, ...message }, idempotencyKey ? { idempotencyKey } : undefined),
        catch: (cause) =>
          new Refused('network', cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.flatMap(({ data, error }) =>
          error
            ? Effect.fail(new Refused(error.name, error.message))
            : Effect.succeed({ id: data?.id ?? null, sent: true }),
        ),
      )

      // Only an email with an idempotency key may be sent again: Resend drops the repeat.
      return yield* attempt.pipe(
        withPolicy(
          { ...policies.email, service: 'Resend' },
          (error) => !!idempotencyKey && (error.name === 'network' || transient.has(error.name)),
        ),
        Effect.mapError((error) => new EmailError({ message: `Resend: ${error.message}` })),
      )
    })

    const delivery = Effect.fn('Email.delivery')(function* (payload: string, headers: Headers) {
      const webhookSecret = yield* config.variable('RESEND_WEBHOOK_SECRET')

      if (!webhookSecret) {
        return 'unconfigured'
      }

      const key = (yield* config.variable('RESEND_API_KEY')) ?? 're_unused'
      return yield* Effect.try({
        try: () =>
          resendFor(key).webhooks.verify({
            payload,
            webhookSecret,
            headers: {
              id: headers.get('svix-id') ?? '',
              timestamp: headers.get('svix-timestamp') ?? '',
              signature: headers.get('svix-signature') ?? '',
            },
          }),
        catch: () => null,
      }).pipe(
        // A signed event in a shape this code doesn't know is about nothing the CRM acts on.
        Effect.map((event) =>
          Option.match(Schema.decodeUnknownOption(WebhookEvent)(event), {
            onNone: (): Delivery => ({ events: [] }),
            onSome: deliveryOf,
          }),
        ),
        Effect.orElseSucceed(() => 'unverified' as const),
      )
    })

    return Email.of({ send, delivery })
  }),
})
