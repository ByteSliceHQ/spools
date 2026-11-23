import { createFileRoute } from '@tanstack/react-router'

import { fileHandlers } from '@swirls/spools/api/file'

export const Route = createFileRoute('/api/files/$id')({ server: { handlers: fileHandlers } })
