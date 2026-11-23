import { createFileRoute } from '@tanstack/react-router'

import { toolsHandlers } from '@swirls/spools/api/tools'

export const Route = createFileRoute('/api/swirls/tools/$tool')({
  server: { handlers: toolsHandlers },
})
