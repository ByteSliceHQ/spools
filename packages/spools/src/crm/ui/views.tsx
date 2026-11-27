import { Link, useRouter } from '@tanstack/react-router'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  EyeOff,
  GripVertical,
  ListFilter,
  Plus,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { updateRecordFn } from '../../server/crm.functions'
import type { Calculation, ResolvedView, ViewSettings } from '../../server/views'
import type { PublicCrmConfig } from '../config'
import type { CrmField } from '../field-types'
import { fieldOf, MAX_SORTS, operatorsFor, pinnedValues, SYSTEM_COLUMNS } from '../filters'
import { fieldLabel } from '../naming'
import { allowedOptions, hasProbabilities, weighted } from '../options'
import { type FieldData, FieldValue, type RecordData, textOf } from './fields'
import { fieldTypeIcons } from './icons'
import { InlineField } from './inline-field'
import { Avatar, Count, cx, MenuDivider, MenuItem, MenuLabel, Popover } from './kit'
import { useWriteReach } from './write-reach'

/**
 * How each view type renders a page of records. To add a view type, add its
 * config shape to `viewSchema` in src/crm/config-schema.ts and a component to
 * `viewComponents` below.
 */

type Obj = PublicCrmConfig['objects'][string]

export type ViewProps = {
  /** Object key, e.g. "contacts". */
  object: string
  obj: Obj
  view: ResolvedView
  rows: RecordData[]
  total: number
  /** Footer values keyed by column, from the server. */
  calculations: Record<string, number | null>
  /** The active search text, if any. */
  query?: string
  /** Filters or a search are narrowing the list: an empty page means nothing matches, not that there is nothing. */
  filtered?: boolean
  titleFieldOf: (objectKey: string) => string
  selected: Set<string>
  onSelect: (ids: Set<string>) => void
  /** Open the new-record dialog, optionally with preset values. */
  onCreate: (preset?: RecordData) => void
  /** Change the view: columns and calculations are saved, a sort is tried on first. */
  onViewChange: (patch: Partial<ViewSettings>) => void
  /** Start a filter on a column. */
  onFilterBy?: (key: string) => void
  /** Called when a record is opened, so the record page can offer previous/next. */
  onOpen: () => void
}

/** A column's heading: the field's label, or a system column's ("Created", "Last contacted"). */
export const columnLabel = (key: string, field: CrmField | undefined) => {
  const known = field ?? (Object.hasOwn(SYSTEM_COLUMNS, key) ? SYSTEM_COLUMNS[key] : undefined)
  return known ? fieldLabel(key, known) : key
}

const NUMERIC = new Set(['number', 'currency'])

const calculationLabels: Record<Calculation, string> = {
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  filled: 'Filled',
  empty: 'Empty',
}

function formatCalculation(
  field: CrmField | undefined,
  kind: Calculation,
  value: number | null,
): string {
  if (value === null) {
    return '—'
  }

  if (field?.type === 'currency' && kind !== 'filled' && kind !== 'empty') {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: field.currency }).format(
      value,
    )
  }

  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function TableView(props: ViewProps) {
  const {
    object,
    obj,
    view,
    rows,
    total,
    calculations,
    query,
    filtered,
    titleFieldOf,
    selected,
    onSelect,
    onCreate,
    onViewChange,
    onFilterBy,
    onOpen,
  } = props

  const { columns, sort } = view.settings
  const [menu, setMenu] = useState<string | null>(null)
  // Rows are selected to be deleted, so only the ones this person can change can be.
  const reach = useWriteReach()
  const writable = rows.filter((r) => reach.record(object, r))
  const allSelected = writable.length > 0 && writable.every((r) => selected.has(textOf(r.id)))

  const hidden = [...Object.keys(obj.fields), ...Object.keys(SYSTEM_COLUMNS)].filter(
    (k) => !columns.includes(k),
  )

  /** Sort by a column alone, or (from "then sort by this") after the columns already sorted by. */
  const sortBy = (field: string, dir: 'asc' | 'desc', add: boolean) => {
    const others = sort.filter((s) => s.field !== field)
    onViewChange({ sort: add ? [...others, { field, dir }].slice(-MAX_SORTS) : [{ field, dir }] })
    setMenu(null)
  }

  const toggle = (id: string) => {
    const next = new Set(selected)

    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }

    onSelect(next)
  }

  const line = 'border-b border-c-line'

  return (
    <table data-guide="table" className="h-full w-max min-w-full border-separate border-spacing-0">
      <thead>
        <tr>
          {columns.map((c, i) => {
            const field = obj.fields[c]
            const Icon = field ? fieldTypeIcons[field.type] : Clock
            const sortable = c !== 'createdBy'
            const level = sort.findIndex((s) => s.field === c)
            const active = sort[level]
            const known = fieldOf(obj, c)
            const filterable = !!onFilterBy && !!known && operatorsFor(known).length > 0
            const first = i === 0
            return (
              <th
                key={c}
                className={cx(
                  line,
                  'sticky top-0 z-20 h-8 border-r bg-c-bg p-0 text-left font-medium text-c-fg2',
                  first && 'left-0 z-30',
                )}
                style={{ minWidth: first ? 280 : 168 }}
              >
                <div className="relative flex h-8 items-center">
                  {first &&
                    (writable.length > 0 ? (
                      <label className="flex h-8 w-9 shrink-0 items-center justify-center">
                        <span className="sr-only">Select all</span>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={() =>
                            onSelect(
                              allSelected ? new Set() : new Set(writable.map((r) => textOf(r.id))),
                            )
                          }
                          className="size-3.5 accent-(--c-accent)"
                        />
                      </label>
                    ) : (
                      <span className="w-9 shrink-0" />
                    ))}
                  <button
                    type="button"
                    onClick={() => setMenu(menu === c ? null : c)}
                    className={cx(
                      'flex h-8 min-w-0 flex-1 items-center gap-1.5 pr-2 hover:bg-c-hov',
                      first ? 'pl-0.5' : 'pl-2.5',
                    )}
                  >
                    <Icon className="text-c-fg3 size-3.5 shrink-0" strokeWidth={2} />
                    <span className="text-c-fg truncate">{columnLabel(c, field)}</span>
                    {active &&
                      (active.dir === 'asc' ? (
                        <ArrowUp className="size-3" />
                      ) : (
                        <ArrowDown className="size-3" />
                      ))}
                    {active && sort.length > 1 && (
                      <span className="text-c-fg3 text-[10px]">{level + 1}</span>
                    )}
                  </button>
                  <Popover open={menu === c} onClose={() => setMenu(null)}>
                    {sortable && (
                      <>
                        <MenuItem onSelect={() => sortBy(c, 'asc', false)}>
                          <ArrowUp className="text-c-fg2 size-3.5" /> Sort ascending
                        </MenuItem>
                        <MenuItem onSelect={() => sortBy(c, 'desc', false)}>
                          <ArrowDown className="text-c-fg2 size-3.5" /> Sort descending
                        </MenuItem>
                        {sort.length > 0 && !(sort.length === 1 && active) && (
                          <MenuItem onSelect={() => sortBy(c, active?.dir ?? 'asc', true)}>
                            <Plus className="text-c-fg2 size-3.5" /> Then sort by this
                          </MenuItem>
                        )}
                      </>
                    )}
                    {filterable && (
                      <MenuItem
                        onSelect={() => {
                          setMenu(null)
                          onFilterBy?.(c)
                        }}
                      >
                        <ListFilter className="text-c-fg2 size-3.5" /> Filter by this column
                      </MenuItem>
                    )}
                    {!first && (
                      <MenuItem
                        onSelect={() => {
                          onViewChange({ columns: columns.filter((k) => k !== c) })
                          setMenu(null)
                        }}
                      >
                        <EyeOff className="text-c-fg2 size-3.5" /> Hide column
                      </MenuItem>
                    )}
                  </Popover>
                </div>
              </th>
            )
          })}
          <th className={cx(line, 'sticky top-0 z-20 w-full bg-c-bg p-0 text-left font-normal')}>
            {hidden.length > 0 && (
              <div className="relative inline-block">
                <button
                  type="button"
                  onClick={() => setMenu(menu === '+' ? null : '+')}
                  className="text-c-fg3 hover:text-c-fg flex h-8 items-center gap-1.5 px-2.5"
                >
                  <Plus className="size-3.5" /> Add column
                </button>
                <Popover
                  open={menu === '+'}
                  onClose={() => setMenu(null)}
                  className="max-h-72 overflow-y-auto"
                >
                  {hidden.map((k) => {
                    const field = fieldOf(obj, k)
                    const Icon = field ? fieldTypeIcons[field.type] : Clock
                    return (
                      <MenuItem
                        key={k}
                        onSelect={() => {
                          onViewChange({ columns: [...columns, k] })
                          setMenu(null)
                        }}
                      >
                        <Icon className="text-c-fg3 size-3.5" /> {columnLabel(k, field)}
                      </MenuItem>
                    )
                  })}
                </Popover>
              </div>
            )}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const id = textOf(r.id)
          const isSelected = selected.has(id)
          const rowBg = isSelected ? 'bg-c-sel' : 'bg-c-bg group-hover/row:bg-c-hov'
          return (
            <tr key={id} className="group/row">
              {columns.map((c, i) => {
                const field = obj.fields[c]

                if (i === 0) {
                  return (
                    <td
                      key={c}
                      className={cx(line, 'sticky left-0 z-10 h-[30px] border-r p-0', rowBg)}
                    >
                      <div className="flex h-[30px] items-center">
                        {reach.record(object, r) ? (
                          <label className="flex h-full w-9 shrink-0 items-center justify-center">
                            <span className="sr-only">Select row</span>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggle(id)}
                              className={cx(
                                'size-3.5 accent-(--c-accent)',
                                !isSelected &&
                                  'opacity-0 group-hover/row:opacity-100 focus:opacity-100',
                              )}
                            />
                          </label>
                        ) : (
                          <span className="w-9 shrink-0" />
                        )}
                        <Link
                          to="/$object/$id"
                          params={{ object, id }}
                          onClick={onOpen}
                          className="flex min-w-0 flex-1 items-center gap-2 pr-2.5 font-medium hover:underline"
                        >
                          <Avatar name={textOf(r[c], '?')} size="sm" />
                          <span className="truncate">{textOf(r[c], 'Untitled')}</span>
                        </Link>
                      </div>
                    </td>
                  )
                }

                return (
                  <td
                    key={c}
                    className={cx(
                      line,
                      'h-[30px] max-w-80 border-r p-0',
                      isSelected && 'bg-c-sel',
                      field && NUMERIC.has(field.type) && 'tabular-nums',
                    )}
                  >
                    {field ? (
                      <InlineField
                        objectKey={object}
                        record={r}
                        fieldKey={c}
                        field={field}
                        titleFieldOf={titleFieldOf}
                      />
                    ) : (
                      <div className="truncate px-2.5">
                        <FieldValue
                          field={undefined}
                          fieldKey={c}
                          record={r}
                          titleFieldOf={titleFieldOf}
                        />
                      </div>
                    )}
                  </td>
                )
              })}
              <td className={cx(line, isSelected && 'bg-c-sel')} />
            </tr>
          )
        })}
        {rows.length === 0 && (
          <tr>
            <td colSpan={columns.length + 1} className="text-c-fg3 px-6 py-14 text-center">
              No {obj.labelPlural.toLowerCase()}{' '}
              {query ? `match "${query}"` : filtered ? 'match these filters' : 'here yet'}.
            </td>
          </tr>
        )}
        {reach.any && (
          <tr>
            <td className={cx(line, 'sticky left-0 z-10 h-[30px] bg-c-bg p-0')}>
              <button
                type="button"
                onClick={() => onCreate()}
                className="text-c-fg3 hover:text-c-fg flex h-[30px] w-full items-center gap-2 px-2.5"
              >
                <Plus className="size-3.5" /> New {obj.label.toLowerCase()}
              </button>
            </td>
            <td colSpan={columns.length} className={line} />
          </tr>
        )}
        {/* Takes up the leftover height, so the footer sits at the bottom of the window. */}
        <tr>
          <td colSpan={columns.length + 1} className="p-0" />
        </tr>
      </tbody>
      <tfoot data-guide="table-foot">
        <tr className="group/foot">
          {columns.map((c, i) => {
            const field = obj.fields[c]
            const kind = view.settings.calculations[c]

            const options: Calculation[] =
              field && NUMERIC.has(field.type)
                ? ['sum', 'avg', 'min', 'max', 'filled', 'empty']
                : ['filled', 'empty']

            return (
              <td
                key={c}
                className={cx(
                  'sticky bottom-0 z-10 h-8 border-t border-r border-c-line bg-c-bg p-0',
                  i === 0 && 'left-0 z-20',
                )}
              >
                {i === 0 ? (
                  <div className="flex h-8 items-center justify-end gap-1 px-2.5 tabular-nums">
                    <span className="font-medium">{total.toLocaleString()}</span>
                    <span className="text-c-fg3">count</span>
                  </div>
                ) : (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setMenu(menu === `calc:${c}` ? null : `calc:${c}`)}
                      className="text-c-fg3 hover:bg-c-hov hover:text-c-fg flex h-8 w-full items-center justify-end gap-1 px-2.5"
                    >
                      {kind ? (
                        <>
                          <span className="text-c-fg font-medium tabular-nums">
                            {formatCalculation(field, kind, calculations[c] ?? null)}
                          </span>
                          <span>{calculationLabels[kind].toLowerCase()}</span>
                        </>
                      ) : (
                        <span className="flex items-center gap-1 opacity-0 group-hover/foot:opacity-100">
                          <Plus className="size-3" /> Add calculation
                        </span>
                      )}
                    </button>
                    {menu === `calc:${c}` && (
                      <div className="border-c-line2 bg-c-raised absolute right-0 bottom-full z-40 mb-1 min-w-44 rounded-xl border p-1 text-left shadow-xl shadow-black/10">
                        <MenuLabel>Calculate</MenuLabel>
                        {options.map((o) => (
                          <MenuItem
                            key={o}
                            trailing={
                              kind === o ? <Check className="text-c-accent size-3.5" /> : undefined
                            }
                            onSelect={() => {
                              onViewChange({
                                calculations: { ...view.settings.calculations, [c]: o },
                              })

                              setMenu(null)
                            }}
                          >
                            {calculationLabels[o]}
                          </MenuItem>
                        ))}
                        {kind && (
                          <>
                            <MenuDivider />
                            <MenuItem
                              onSelect={() => {
                                const { [c]: _removed, ...rest } = view.settings.calculations
                                onViewChange({ calculations: rest })
                                setMenu(null)
                              }}
                            >
                              Remove
                            </MenuItem>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </td>
            )
          })}
          <td className="border-c-line bg-c-bg sticky bottom-0 z-10 border-t" />
        </tr>
      </tfoot>
    </table>
  )
}

const dotColors = new Map([
  ['gray', 'bg-zinc-400'],
  ['red', 'bg-red-500'],
  ['orange', 'bg-orange-500'],
  ['amber', 'bg-amber-500'],
  ['green', 'bg-green-500'],
  ['teal', 'bg-teal-500'],
  ['blue', 'bg-blue-500'],
  ['indigo', 'bg-indigo-500'],
  ['purple', 'bg-purple-500'],
  ['pink', 'bg-pink-500'],
])

const isEmpty = (value: FieldData) => value === null || value === undefined || value === ''

function BoardView({ object, obj, view, rows, titleFieldOf, onCreate, onOpen }: ViewProps) {
  const router = useRouter()
  const reach = useWriteReach()
  const groupBy = view.settings.groupBy ?? ''
  const group = obj.fields[groupBy]

  // A board filtered to one value of the field its stages depend on (one
  // pipeline) only shows that value's stages. Unfiltered, it shows them all.
  const scope =
    group?.type === 'select' && group.dependsOn
      ? pinnedValues(view.settings.filters)[group.dependsOn]
      : undefined

  const options =
    group?.type !== 'select'
      ? []
      : scope === undefined || scope === true || scope === false
        ? group.options
        : allowedOptions(group, scope)

  const showWeighted = group?.type === 'select' && hasProbabilities(group)
  // Cards moved by drag and drop, shown in their new column until the reload lands.
  const [moved, setMoved] = useState<Record<string, string>>({})
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [error, setError] = useState<string>()

  const cardFields = view.settings.cardFields.filter((f) => f !== groupBy)
  // The first currency field on the object is totalled under each column.
  const totalField = Object.keys(obj.fields).find((k) => obj.fields[k]?.type === 'currency')
  const totalDef = totalField ? obj.fields[totalField] : undefined

  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: totalDef?.type === 'currency' ? totalDef.currency : 'USD',
    }).format(n)

  const columnOf = (r: RecordData) => moved[textOf(r.id)] ?? r[groupBy]

  async function drop(value: string) {
    const id = dragging
    setOver(null)
    setDragging(null)
    const row = rows.find((r) => textOf(r.id) === id)

    if (!id || !row || columnOf(row) === value || !reach.record(object, row)) {
      return
    }

    setMoved((m) => ({ ...m, [id]: value }))
    setError(undefined)

    try {
      await updateRecordFn({ data: { objectKey: object, id, values: { [groupBy]: value } } })
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move the card')
    } finally {
      setMoved((m) => {
        const { [id]: _done, ...rest } = m
        return rest
      })
    }
  }

  if (options.length === 0) {
    return (
      <p className="text-c-fg3 p-10 text-center">
        Add a select field to {obj.labelPlural.toLowerCase()} to use a board.
      </p>
    )
  }

  return (
    <div className="flex h-full flex-col" data-guide="board">
      {error && (
        <div className="border-c-line text-c-danger border-b bg-red-500/10 px-4 py-2 text-xs">
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
        {options.map((opt) => {
          const items = rows.filter((r) => columnOf(r) === opt.value)

          const total = totalField
            ? items.reduce((sum, r) => sum + (Number(r[totalField]) || 0), 0)
            : 0

          return (
            <section
              key={opt.value}
              aria-label={opt.label ?? opt.value}
              onDragOver={(e) => {
                e.preventDefault()
                setOver(opt.value)
              }}
              onDragLeave={() => setOver((o) => (o === opt.value ? null : o))}
              onDrop={() => drop(opt.value)}
              className={cx(
                'flex w-[272px] shrink-0 flex-col rounded-xl border bg-c-panel',
                over === opt.value ? 'border-c-accent' : 'border-c-line',
              )}
            >
              <header className="flex h-10 items-center gap-2 px-3">
                <span className={cx('size-2.5 rounded-full', dotColors.get(opt.color ?? 'gray'))} />
                <h2 className="truncate font-semibold">{opt.label ?? opt.value}</h2>
                <Count>{items.length}</Count>
                {opt.probability !== undefined && (
                  <span className="text-c-fg3 text-xs tabular-nums" title="Win probability">
                    {opt.probability}%
                  </span>
                )}
                {reach.any && (
                  <>
                    <button
                      type="button"
                      aria-label={`New ${obj.label.toLowerCase()} in ${opt.label ?? opt.value}`}
                      data-guide="board-add"
                      onClick={() => onCreate({ [groupBy]: opt.value })}
                      className="text-c-fg3 hover:bg-c-hov hover:text-c-fg ml-auto rounded-md p-1"
                    >
                      <Plus className="size-3.5" />
                    </button>
                    <GripVertical className="text-c-fg3 size-3.5" aria-hidden="true" />
                  </>
                )}
              </header>
              <div className="flex min-h-10 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
                {items.map((r) => {
                  const id = textOf(r.id)
                  const shown = cardFields.filter((f) => !isEmpty(r[f]))
                  // A card is dragged to change its record: one this person can't change stays put.
                  const movable = reach.record(object, r)
                  return (
                    <Link
                      key={id}
                      to="/$object/$id"
                      params={{ object, id }}
                      onClick={onOpen}
                      draggable={movable}
                      onDragStart={(e) => {
                        if (!movable) {
                          e.preventDefault()
                          return
                        }

                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', id)
                        setDragging(id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      className={cx(
                        'block rounded-lg border border-c-line bg-c-raised p-2.5 hover:border-c-line2',
                        movable && 'cursor-grab active:cursor-grabbing',
                        dragging === id && 'opacity-40',
                      )}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        <Avatar name={textOf(r[obj.titleField], '?')} size="sm" />
                        <span className="truncate">{textOf(r[obj.titleField], 'Untitled')}</span>
                      </div>
                      {shown.length > 0 && (
                        <div className="text-c-fg2 mt-2 space-y-1.5">
                          {shown.map((f) => {
                            const field = obj.fields[f]
                            const Icon = field ? fieldTypeIcons[field.type] : Clock
                            return (
                              <div key={f} className="flex items-center gap-2">
                                <Icon className="text-c-fg3 size-3.5 shrink-0" strokeWidth={2} />
                                <span className="min-w-0 truncate">
                                  <FieldValue
                                    field={field}
                                    fieldKey={f}
                                    record={r}
                                    titleFieldOf={titleFieldOf}
                                    plain
                                  />
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </Link>
                  )
                })}
              </div>
              {totalField && (
                <footer className="border-c-line flex h-8 items-center justify-end gap-1 border-t px-3 tabular-nums">
                  {showWeighted && (
                    <span className="mr-auto flex items-center gap-1">
                      <span className="font-medium">{money(weighted(total, opt))}</span>
                      <span className="text-c-fg3">weighted</span>
                    </span>
                  )}
                  <span className="font-medium">{money(total)}</span>
                  <span className="text-c-fg3">sum</span>
                </footer>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

const viewComponents: Record<ResolvedView['type'], (props: ViewProps) => ReactNode> = {
  table: TableView,
  board: BoardView,
}

/** Renders `view` with the component registered for its type. */
export function RecordView(props: ViewProps) {
  const View = viewComponents[props.view.type]
  return <View {...props} />
}
