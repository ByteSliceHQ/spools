import { createFileRoute } from '@tanstack/react-router'

import { mailSyncHandlers } from '@swirls/spools/api/mail-sync'

export const Route = createFileRoute('/api/cron/mail-sync')({
  server: { handlers: mailSyncHandlers },
})
