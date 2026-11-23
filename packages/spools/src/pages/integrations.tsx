import { lazyRouteComponent } from '@tanstack/react-router'
import { z } from 'zod'

import { listIntegrationsFn } from '../server/integrations.functions'

export const integrationsPage = {
  validateSearch: z.object({
    /** Set by the OAuth callback: the id of the new connection. */
    connected: z.string().optional(),
    error: z.string().max(500).optional(),
  }),
  loader: () => listIntegrationsFn(),
  component: lazyRouteComponent(() => import('../views/integrations'), 'Integrations'),
}
