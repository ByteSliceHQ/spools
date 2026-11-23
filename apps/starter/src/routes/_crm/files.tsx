import { createFileRoute } from '@tanstack/react-router'

import { filesPage } from '@swirls/spools/pages/files'

export const Route = createFileRoute('/_crm/files')(filesPage)
