import { createFileRoute } from '@tanstack/react-router'

import { recordPage } from '@swirls/spools/pages/record'

export const Route = createFileRoute('/_crm/$object/$id')(recordPage)
