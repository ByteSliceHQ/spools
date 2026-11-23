import { createFileRoute } from '@tanstack/react-router'

import { tasksPage } from '@swirls/spools/pages/tasks'

export const Route = createFileRoute('/_crm/tasks')(tasksPage)
