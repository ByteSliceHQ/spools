import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import { config, Email, EmailError, type EmailAdapter } from '@swirls/spools/adapter'

/**
 * Email through Postmark (https://postmarkapp.com).
 *
 *   POSTMARK_TOKEN   a server token
 *   EMAIL_FROM       who it comes from
 */
export const postmark = (): EmailAdapter => ({
  id: 'postmark',
  label: 'Postmark',
  // Shown in the boot report.
  features: [{ name: 'Email (Postmark)', vars: ['POSTMARK_TOKEN', 'EMAIL_FROM'] }],
  layer: Layer.effect(
    Email,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient

      return Email.of({
        send: Effect.fn('Postmark.send')(function* (email) {
          const token = yield* config.variable('POSTMARK_TOKEN')
          const from = yield* config.variable('EMAIL_FROM')

          if (!token || !from) {
            return { id: null, sent: false }
          }

          const request = HttpClientRequest.post('https://api.postmarkapp.com/email').pipe(
            HttpClientRequest.setHeader('x-postmark-server-token', token),
            HttpClientRequest.bodyJsonUnsafe({
              From: from,
              To: email.to,
              Subject: email.subject,
              TextBody: email.text,
              HtmlBody: email.html,
            }),
          )

          const response = yield* http
            .execute(request)
            .pipe(
              Effect.mapError(() => new EmailError({ message: 'Postmark could not be reached' })),
            )

          if (response.status >= 300) {
            return yield* new EmailError({
              message: `Postmark refused the email (${response.status})`,
            })
          }

          return { id: null, sent: true }
        }),
        // Bounces and complaints, posted to /api/webhooks/email.
        delivery: () => Effect.succeed('unconfigured' as const),
      })
    }),
  ),
})
