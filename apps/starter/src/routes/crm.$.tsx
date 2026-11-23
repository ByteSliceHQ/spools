import { createFileRoute } from '@tanstack/react-router'

import { legacyRedirect } from '@swirls/spools/pages/legacy'

export const Route = createFileRoute('/crm/$')(legacyRedirect)
