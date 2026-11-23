import { createFileRoute } from '@tanstack/react-router'

import { workflowsPage } from '@swirls/spools/pages/workflows'

export const Route = createFileRoute('/_crm/workflows')(workflowsPage)
