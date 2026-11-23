import { createFileRoute } from '@tanstack/react-router'

import { emailWebhookHandlers } from '@swirls/spools/api/email-webhook'

export const Route = createFileRoute('/api/webhooks/email')({
  server: { handlers: emailWebhookHandlers },
})
