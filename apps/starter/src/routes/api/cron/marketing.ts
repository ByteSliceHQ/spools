import { createFileRoute } from '@tanstack/react-router'

import { marketingHandlers } from '@swirls/spools/api/marketing'

export const Route = createFileRoute('/api/cron/marketing')({
  server: { handlers: marketingHandlers },
})
