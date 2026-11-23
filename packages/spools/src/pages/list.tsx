import { lazyRouteComponent } from '@tanstack/react-router'
import { z } from 'zod'

import { getListFn } from '../server/workspace.functions'

const scalar = z.union([z.string(), z.number()])

const condition = z.object({
  field: z.string(),
  op: z.string(),
  value: z.union([scalar, z.array(scalar)]).optional(),
  where: z
    .array(
      z.object({
        field: z.string(),
        op: z.string(),
        value: z.union([scalar, z.array(scalar)]).optional(),
      }),
    )
    .optional(),
})

/** A list page's address: the view, the search, the page and any unsaved filters and sort. */
export const listSearch = z.object({
  view: z.string().optional(),
  q: z.string().optional(),
  // A page number nobody could mean is the first page.
  page: z.number().int().positive().max(10_000).optional().catch(undefined),
  /**
   * Filters and sort that differ from the saved view's. They live in the page
   * address so a filtered list can be linked to, and so trying a filter doesn't
   * change the view for everyone. A link that doesn't parse shows the view as saved.
   */
  f: z.array(z.array(condition)).optional().catch(undefined),
  s: z
    .array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }))
    .optional()
    .catch(undefined),
  /** Open the new-record dialog (set by the command palette). */
  new: z.boolean().optional(),
})

export const listPage = {
  validateSearch: listSearch,
  loaderDeps: ({ search: { new: _new, ...deps } }: { search: z.output<typeof listSearch> }) => deps,
  loader: ({
    params,
    deps,
  }: {
    params: { object: string }
    deps: Omit<z.output<typeof listSearch>, 'new'>
  }) =>
    getListFn({
      data: {
        objectKey: params.object,
        viewId: deps.view,
        q: deps.q,
        page: deps.page ?? 1,
        filters: deps.f,
        sort: deps.s,
      },
    }),
  component: lazyRouteComponent(() => import('../views/list'), 'ObjectList'),
}
