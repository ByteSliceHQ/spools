import { createFileRoute } from '@tanstack/react-router'

import { reportsPage } from '@swirls/spools/pages/reports'

export const Route = createFileRoute('/_crm/reports')(reportsPage)
