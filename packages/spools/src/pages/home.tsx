import { lazyRouteComponent } from '@tanstack/react-router'

import { dashboardFn } from '../server/crm.functions'

export const homePage = {
  loader: () => dashboardFn(),
  component: lazyRouteComponent(() => import('../views/home'), 'Home'),
}
