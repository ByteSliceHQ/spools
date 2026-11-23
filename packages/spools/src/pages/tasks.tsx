import { lazyRouteComponent } from '@tanstack/react-router'
import { z } from 'zod'

import { listTasksFn } from '../server/workspace.functions'

const search = z.object({ scope: z.enum(['mine', 'all']).optional() })
type Scope = 'mine' | 'all'
type Deps = { scope: Scope }

export const tasksPage = {
  validateSearch: search,
  loaderDeps: (from: { search: z.output<typeof search> }): Deps => ({
    scope: from.search.scope ?? 'mine',
  }),
  loader: ({ deps }: { deps: Deps }) => listTasksFn({ data: { scope: deps.scope } }),
  component: lazyRouteComponent(() => import('../views/tasks'), 'Tasks'),
}
