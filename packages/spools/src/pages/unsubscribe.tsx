import { lazyRouteComponent } from '@tanstack/react-router'
import { z } from 'zod'

export const unsubscribePage = {
  validateSearch: z.object({ t: z.string().optional() }),
  head: () => ({ meta: [{ title: 'Unsubscribe' }, { name: 'robots', content: 'noindex' }] }),
  component: lazyRouteComponent(() => import('../views/unsubscribe'), 'Unsubscribe'),
}
