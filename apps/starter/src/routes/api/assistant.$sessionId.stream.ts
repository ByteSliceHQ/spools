import { createFileRoute } from '@tanstack/react-router'

import { assistantStreamHandlers } from '@swirls/spools/api/assistant-stream'

export const Route = createFileRoute('/api/assistant/$sessionId/stream')({
  server: { handlers: assistantStreamHandlers },
})
