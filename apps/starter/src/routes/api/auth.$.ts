import { createFileRoute } from '@tanstack/react-router'

import { authHandlers } from '@swirls/spools/api/auth'

export const Route = createFileRoute('/api/auth/$')({ server: { handlers: authHandlers } })
