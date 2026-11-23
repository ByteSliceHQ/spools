import { createRouter } from '@tanstack/react-router'

import { forgetWhenChanged, spoolRouter } from '@swirls/spools/ui/router'

import { routeTree } from './routeTree.gen'

export function getRouter() {
  return forgetWhenChanged(createRouter({ routeTree, ...spoolRouter }))
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
