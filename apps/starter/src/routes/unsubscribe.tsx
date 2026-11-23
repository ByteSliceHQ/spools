import { createFileRoute } from '@tanstack/react-router'

import { unsubscribeHandlers } from '@swirls/spools/api/unsubscribe'
import { unsubscribePage } from '@swirls/spools/pages/unsubscribe'

export const Route = createFileRoute('/unsubscribe')({
  ...unsubscribePage,
  server: { handlers: unsubscribeHandlers },
})
