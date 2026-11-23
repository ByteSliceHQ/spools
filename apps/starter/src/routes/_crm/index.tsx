import { createFileRoute } from '@tanstack/react-router'

import { homePage } from '@swirls/spools/pages/home'

export const Route = createFileRoute('/_crm/')(homePage)
