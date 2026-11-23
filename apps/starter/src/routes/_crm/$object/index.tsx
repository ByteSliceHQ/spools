import { createFileRoute } from '@tanstack/react-router'

import { listPage } from '@swirls/spools/pages/list'

export const Route = createFileRoute('/_crm/$object/')(listPage)
