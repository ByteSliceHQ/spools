import { createFileRoute } from '@tanstack/react-router'

import { objectLayout } from '@swirls/spools/pages/object'

export const Route = createFileRoute('/_crm/$object')(objectLayout)
