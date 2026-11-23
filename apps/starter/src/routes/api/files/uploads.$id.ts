import { createFileRoute } from '@tanstack/react-router'

import { uploadHandlers } from '@swirls/spools/api/upload'

export const Route = createFileRoute('/api/files/uploads/$id')({
  server: { handlers: uploadHandlers },
})
