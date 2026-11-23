import { createFileRoute } from '@tanstack/react-router'

import { assistantPage } from '@swirls/spools/pages/assistant'

export const Route = createFileRoute('/_crm/assistant')(assistantPage)
