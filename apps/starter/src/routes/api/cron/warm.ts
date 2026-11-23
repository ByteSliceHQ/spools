import { createFileRoute } from '@tanstack/react-router'

import { warmHandlers } from '@swirls/spools/api/warm'

export const Route = createFileRoute('/api/cron/warm')({ server: { handlers: warmHandlers } })
