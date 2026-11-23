import { createFileRoute } from '@tanstack/react-router'

import { sequencesHandlers } from '@swirls/spools/api/sequences'

export const Route = createFileRoute('/api/cron/sequences')({
  server: { handlers: sequencesHandlers },
})
