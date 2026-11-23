import { Context, Effect, Layer } from 'effect'
import { z } from 'zod'

import type { Adapter } from './adapter'
import { EmailError } from './errors'

/**
 * The app's email provider: campaign emails, and one-off emails sent when a
 * teammate has no mailbox that may send. Adapters are in src/adapters/email/.
 */

export { EmailError }

export type OutboundEmail = {
  to: string
  subject: string
  text: string
  html: string
  headers?: Record<string, string>
  /**
   * The same value on every attempt to send this one email. A transport that
   * can should use it to drop a repeat (Resend does, for 24 hours), so a retry
   * after a crash doesn't reach the person twice.
   */
  idempotencyKey?: string
}

/** A transport as an app writes one (`email.send` in src/app/extensions.ts). */
export type EmailSender = (email: OutboundEmail) => Promise<{ id: string | null; sent: boolean }>

/** Something the provider learned after an email was sent: campaigns stop mailing the address. */
export type DeliveryEvent = { kind: 'bounced' | 'complained'; addresses: string[] }

/** A stand-in webhook's events, as `layerTest` reads them. */
const testEvents: z.ZodType<DeliveryEvent[]> = z.array(
  z.object({ kind: z.enum(['bounced', 'complained']), addresses: z.array(z.string()) }),
)

/**
 * What a delivery webhook turned out to be: its events, `unverified` when its
 * signature doesn't check out, `unconfigured` when the provider's signing
 * secret isn't set (or the provider sends no webhooks).
 */
export type Delivery = { events: DeliveryEvent[] } | 'unverified' | 'unconfigured'

export class Email extends Context.Service<
  Email,
  {
    /** Send one email. `sent: false` when the provider isn't set up (the email is logged instead). */
    readonly send: (
      email: OutboundEmail,
    ) => Effect.Effect<{ id: string | null; sent: boolean }, EmailError>
    /** Check a delivery webhook's signature and read it. */
    readonly delivery: (payload: string, headers: Headers) => Effect.Effect<Delivery>
  }
>()('spools/Email') {
  /** Emails are written to the log and go nowhere. */
  static readonly log = Layer.succeed(
    Email,
    Email.of({
      send: (email) =>
        Effect.logInfo(
          `[email] no email provider; not sending "${email.subject}" to ${email.to}`,
        ).pipe(Effect.as({ id: null, sent: false })),
      delivery: () => Effect.succeed('unconfigured' as const),
    }),
  )

  /** Emails go to `sender` (tests). A webhook is its events as JSON, verified when its `x-test-signature` is "valid". */
  static readonly layerTest = (sender: EmailSender) =>
    Layer.succeed(
      Email,
      Email.of({
        send: (email) =>
          Effect.tryPromise({
            try: () => sender(email),
            // A stand-in is the transport: its own words, as an app's `email.send` would give them.
            catch: (cause) =>
              new EmailError({ message: cause instanceof Error ? cause.message : String(cause) }),
          }),
        delivery: (payload, headers) =>
          Effect.sync(() =>
            headers.get('x-test-signature') === 'valid'
              ? { events: testEvents.parse(JSON.parse(payload)) }
              : ('unverified' as const),
          ),
      }),
    )
}

export type EmailAdapter = Adapter<Email>
