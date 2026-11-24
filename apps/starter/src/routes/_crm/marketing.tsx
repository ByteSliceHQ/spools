import { createFileRoute } from '@tanstack/react-router'

import { marketingPage } from '@swirls/spools/pages/marketing'

export const Route = createFileRoute('/_crm/marketing')(marketingPage)
