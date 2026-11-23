import { createFileRoute } from '@tanstack/react-router'

import { emailWebhookHandlers } from '@swirls/spools/api/email-webhook'

/** Where Resend webhooks set up before /api/webhooks/email still point. The same as it. */
export const Route = createFileRoute('/api/webhooks/resend')({
  server: { handlers: emailWebhookHandlers },
})
