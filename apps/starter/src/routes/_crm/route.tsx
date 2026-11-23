import { createFileRoute } from '@tanstack/react-router'

import { crmLayout } from '@swirls/spools/pages/layout'

export const Route = createFileRoute('/_crm')(crmLayout)
