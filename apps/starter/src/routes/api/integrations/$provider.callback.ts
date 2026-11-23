import { createFileRoute } from '@tanstack/react-router'

import { integrationCallbackHandlers } from '@swirls/spools/api/integration-callback'

export const Route = createFileRoute('/api/integrations/$provider/callback')({
  server: { handlers: integrationCallbackHandlers },
})
