import { lazyRouteComponent } from '@tanstack/react-router'
import { z } from 'zod'

import { getMarketingFn } from '../server/marketing.functions'

export const marketingPage = {
  validateSearch: z.object({
    tab: z.enum(['website', 'posts', 'ads']).optional(),
  }),
  loader: () => getMarketingFn(),
  component: lazyRouteComponent(() => import('../views/marketing'), 'Marketing'),
}
