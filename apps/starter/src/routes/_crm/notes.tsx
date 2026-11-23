import { createFileRoute } from '@tanstack/react-router'

import { notesPage } from '@swirls/spools/pages/notes'

export const Route = createFileRoute('/_crm/notes')(notesPage)
