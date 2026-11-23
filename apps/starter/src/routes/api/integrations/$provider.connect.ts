import { createFileRoute } from '@tanstack/react-router'

import { integrationConnectHandlers } from '@swirls/spools/api/integration-connect'

export const Route = createFileRoute('/api/integrations/$provider/connect')({
  server: { handlers: integrationConnectHandlers },
})
