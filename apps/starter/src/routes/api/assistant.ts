import { createFileRoute } from '@tanstack/react-router'

import { assistantHandlers } from '@swirls/spools/api/assistant'

export const Route = createFileRoute('/api/assistant')({ server: { handlers: assistantHandlers } })
