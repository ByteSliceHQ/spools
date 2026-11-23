import { createFileRoute } from '@tanstack/react-router'

import { integrationsPage } from '@swirls/spools/pages/integrations'

export const Route = createFileRoute('/_crm/integrations')(integrationsPage)
