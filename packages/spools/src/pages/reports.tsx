import { lazyRouteComponent } from '@tanstack/react-router'
import { z } from 'zod'

import { customRange, presetRange, RANGE_PRESETS, type RangePreset } from '../crm/activity'
import { activityReportFn, reportsFn } from '../server/workspace.functions'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** Team activity period: a preset, or "custom" with `from` and `to`. */
export const rangeChoice = z.enum([...RANGE_PRESETS.map((p) => p.id), 'custom'])

const search = z.object({
  range: rangeChoice.optional(),
  from: day.optional(),
  to: day.optional(),
})

export type Search = z.infer<typeof search>

export const DEFAULT_RANGE: RangePreset = 'thisMonth'

/** The dates a search selects; a custom range that isn't usable falls back to the default. */
export const rangeOf = ({ range, from, to }: Search) =>
  (range === 'custom' ? customRange(from, to) : null) ??
  presetRange(range && range !== 'custom' ? range : DEFAULT_RANGE)

export const reportsPage = {
  validateSearch: search,
  loaderDeps: ({ search: s }: { search: Search }) => s,
  loader: async ({ deps }: { deps: Search }) => {
    const [reports, activity] = await Promise.all([
      reportsFn(),
      activityReportFn({ data: rangeOf(deps) }),
    ])

    return { ...reports, activity }
  },
  component: lazyRouteComponent(() => import('../views/reports'), 'Reports'),
}
