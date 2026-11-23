import { lazyRouteComponent } from '@tanstack/react-router'

import { workflowsFn } from '../server/workspace.functions'

export const workflowsPage = {
  loader: () => workflowsFn(),
  component: lazyRouteComponent(() => import('../views/workflows'), 'Workflows'),
}
