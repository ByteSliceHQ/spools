import { createStart } from '@tanstack/react-start'

import { authMiddleware, csrfMiddleware } from '@swirls/spools/start'

export const startInstance = createStart(() => ({
  // Keep csrfMiddleware first: it refuses a request before anything acts on it.
  requestMiddleware: [csrfMiddleware, authMiddleware],
}))
