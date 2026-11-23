import { getRouteApi } from '@tanstack/react-router'
import { BarChart3, Download, Users } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import {
  ACTIVITY_COLUMNS,
  activityTotals,
  type PersonActivity,
  RANGE_PRESETS,
} from '../crm/activity'
import { fieldLabel } from '../crm/naming'
import { ObjectIcon } from '../crm/ui/icons'
import { Avatar, Button, cx, inputClass } from '../crm/ui/kit'
import { objectIndex, TopBar } from '../crm/ui/shell'
import { useCrmConfig } from '../crm/ui/use-crm'
import { DEFAULT_RANGE, rangeChoice, rangeOf } from '../pages/reports'
import { activityReportCsvFn } from '../server/workspace.functions'

const route = getRouteApi('/_crm/reports')

const barColors = new Map(
  Object.entries({
    gray: 'bg-zinc-400',
    red: 'bg-red-500',
    orange: 'bg-orange-500',
    amber: 'bg-amber-500',
    green: 'bg-green-500',
    teal: 'bg-teal-500',
    blue: 'bg-blue-500',
    indigo: 'bg-indigo-500',
    purple: 'bg-purple-500',
    pink: 'bg-pink-500',
  }),
)

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Calls, emails, meetings, completed tasks and notes per teammate, for a chosen period. */
function TeamActivity({ rows, truncated }: { rows: PersonActivity[]; truncated: boolean }) {
  const searchParams = route.useSearch()
  const navigate = route.useNavigate()
  const [exporting, setExporting] = useState(false)
  const range = rangeOf(searchParams)
  const selected = searchParams.range ?? DEFAULT_RANGE
  // `to` is exclusive; show and edit the last day that is included.
  const lastDay = new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate() - 1)
  const totals = activityTotals(rows)
  const nothing = totals.total === 0

  async function exportCsv() {
    setExporting(true)

    try {
      const { csv } = await activityReportCsvFn({ data: range })
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `team-activity-${isoDay(range.from)}-to-${isoDay(lastDay)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  return (
    <section
      className="border-c-line bg-c-raised rounded-xl border lg:col-span-2"
      aria-label="Team activity"
      data-guide="report-activity"
    >
      <header className="flex flex-wrap items-center gap-2 p-4 pb-3">
        <Users className="text-c-fg2 size-3.5" />
        <h2 className="font-medium">Team activity</h2>
        <span className="text-c-fg3">
          {range.from.toLocaleDateString()} to {lastDay.toLocaleDateString()}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Period"
            value={selected}
            onChange={(e) => {
              const choice = rangeChoice.safeParse(e.target.value)

              if (!choice.success) {
                return
              }

              const next = choice.data

              void navigate({
                search:
                  next === 'custom'
                    ? { range: 'custom', from: isoDay(range.from), to: isoDay(lastDay) }
                    : { range: next === DEFAULT_RANGE ? undefined : next },
                replace: true,
              })
            }}
            className={cx(inputClass, 'w-auto py-1')}
          >
            {RANGE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom range</option>
          </select>
          {selected === 'custom' && (
            <>
              <input
                type="date"
                aria-label="From"
                value={isoDay(range.from)}
                max={isoDay(lastDay)}
                onChange={(e) =>
                  navigate({ search: (s) => ({ ...s, from: e.target.value }), replace: true })
                }
                className={cx(inputClass, 'w-auto py-1')}
              />
              <input
                type="date"
                aria-label="To"
                value={isoDay(lastDay)}
                min={isoDay(range.from)}
                onChange={(e) =>
                  navigate({ search: (s) => ({ ...s, to: e.target.value }), replace: true })
                }
                className={cx(inputClass, 'w-auto py-1')}
              />
            </>
          )}
          <Button onClick={exportCsv} disabled={exporting}>
            <Download className="text-c-fg2 size-3.5" /> Export CSV
          </Button>
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 tabular-nums">
          <thead>
            <tr className="text-c-fg2 text-left text-xs">
              <th className="border-c-line border-y px-4 py-2 font-medium">Person</th>
              {ACTIVITY_COLUMNS.map((c) => (
                <th key={c.key} className="border-c-line border-y px-4 py-2 text-right font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="border-c-line border-b px-4 py-2">
                  <span className="flex items-center gap-2">
                    <Avatar name={r.name} size="sm" />
                    <span className="truncate">{r.name}</span>
                  </span>
                </td>
                {ACTIVITY_COLUMNS.map((c) => (
                  <td
                    key={c.key}
                    className={cx(
                      'border-b border-c-line px-4 py-2 text-right',
                      r[c.key] === 0 && 'text-c-fg3',
                      c.key === 'total' && 'font-medium',
                    )}
                  >
                    {r[c.key].toLocaleString()}
                    {c.key === 'calls' && r.calls > 0 && (
                      <span className="text-c-fg3 ml-1.5 text-xs">
                        ({r.callsConnected} connected)
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <td className="px-4 py-2.5">Total</td>
              {ACTIVITY_COLUMNS.map((c) => (
                <td key={c.key} className="px-4 py-2.5 text-right">
                  {totals[c.key].toLocaleString()}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      {(nothing || truncated) && (
        <p className="border-c-line text-c-fg3 border-t px-4 py-3">
          {truncated
            ? 'This period has more activity than one report can count. Pick a shorter period for exact numbers.'
            : "Nothing was logged in this period. Calls and meetings are logged from a record's page."}
        </p>
      )}
    </section>
  )
}

export function Reports(): ReactNode {
  const { breakdowns, created, activity } = route.useLoaderData()
  const config = useCrmConfig()

  return (
    <>
      <TopBar icon={<BarChart3 className="text-c-fg2 size-3.5" />} title="Reports" />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-3 lg:grid-cols-2">
          <TeamActivity rows={activity.rows} truncated={activity.truncated} />
          {created.map(({ objectKey, weeks }, i) => {
            const obj = config.objects[objectKey]
            const max = Math.max(1, ...weeks.map((w) => w.count))
            const total = weeks.reduce((sum, w) => sum + w.count, 0)
            return (
              <figure
                key={`created:${objectKey}`}
                // Guides point at the first chart to introduce them all.
                data-guide={i === 0 ? 'report-charts' : undefined}
                className="border-c-line bg-c-raised rounded-xl border p-4"
              >
                <figcaption className="flex items-center gap-2">
                  <ObjectIcon icon={obj?.icon} index={objectIndex(config, objectKey)} size="sm" />
                  <span className="font-medium">New {obj?.labelPlural.toLowerCase()} per week</span>
                  <span className="text-c-fg2 ml-auto tabular-nums">
                    {total.toLocaleString()} in 12 weeks
                  </span>
                </figcaption>
                <div className="mt-4 flex h-28 items-end gap-1.5">
                  {weeks.map((w) => (
                    <div
                      key={w.week}
                      className="flex h-full flex-1 flex-col justify-end"
                      title={`Week of ${w.week}: ${w.count}`}
                    >
                      <div
                        className={cx('rounded-t bg-c-accent', w.count === 0 && 'opacity-20')}
                        style={{ height: `${Math.max(3, (w.count / max) * 100)}%` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="text-c-fg3 mt-1.5 flex justify-between text-[11px]">
                  <span>{weeks[0]?.week}</span>
                  <span>this week</span>
                </div>
              </figure>
            )
          })}

          {breakdowns.map((b) => {
            const obj = config.objects[b.objectKey]
            const useValue = b.valueField !== null && b.rows.some((r) => r.total > 0)
            const metric = (r: (typeof b.rows)[number]) => (useValue ? r.total : r.count)
            const max = Math.max(1, ...b.rows.map(metric))
            const valueDef = b.valueField ? obj?.fields[b.valueField] : undefined

            const format = (n: number) =>
              useValue
                ? new Intl.NumberFormat(undefined, {
                    style: 'currency',
                    currency: valueDef?.type === 'currency' ? valueDef.currency : 'USD',
                    maximumFractionDigits: 0,
                  }).format(n)
                : n.toLocaleString()

            return (
              <figure
                key={`${b.objectKey}:${b.field}`}
                className="border-c-line bg-c-raised rounded-xl border p-4"
              >
                <figcaption className="flex items-center gap-2">
                  <ObjectIcon icon={obj?.icon} index={objectIndex(config, b.objectKey)} size="sm" />
                  <span className="font-medium">
                    {obj?.labelPlural} by {fieldLabel(b.field, obj?.fields[b.field]).toLowerCase()}
                  </span>
                  {useValue && b.valueField && (
                    <span className="text-c-fg2 ml-auto">
                      {fieldLabel(b.valueField, obj?.fields[b.valueField])}
                    </span>
                  )}
                </figcaption>
                <div className="mt-4 space-y-2">
                  {b.rows.map((r) => (
                    <div
                      key={r.value}
                      className="grid grid-cols-[8rem_1fr_auto] items-center gap-3"
                    >
                      <span className="text-c-fg2 truncate">{r.label}</span>
                      <div className="bg-c-hov h-4 rounded">
                        <div
                          className={cx(
                            'h-4 rounded',
                            barColors.get(r.color ?? 'blue') ?? 'bg-blue-500',
                          )}
                          style={{ width: `${(metric(r) / max) * 100}%` }}
                        />
                      </div>
                      <span className="w-24 text-right tabular-nums">
                        {format(metric(r))}
                        {useValue && <span className="text-c-fg3 ml-1.5">({r.count})</span>}
                      </span>
                    </div>
                  ))}
                </div>
                {useValue && b.weighted && (
                  <p className="border-c-line text-c-fg2 mt-3 flex justify-between border-t pt-3">
                    <span>Weighted by win probability</span>
                    <span className="tabular-nums">
                      <span className="text-c-fg font-medium">
                        {format(b.rows.reduce((sum, r) => sum + r.weighted, 0))}
                      </span>{' '}
                      of {format(b.rows.reduce((sum, r) => sum + r.total, 0))}
                    </span>
                  </p>
                )}
              </figure>
            )
          })}
        </div>
      </div>
    </>
  )
}
