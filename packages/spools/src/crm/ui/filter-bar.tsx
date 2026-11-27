import { Check, ChevronRight, ListFilter, Plus, Search, Waypoints, X } from 'lucide-react'
import {
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { z } from 'zod'

import { suggestValuesFn } from '../../server/crm.functions'
import type { CrmField } from '../field-types'
import {
  arityOf,
  backRelations,
  type Condition,
  cleanFilters,
  countConditions,
  defaultOp,
  describe,
  type Filters,
  familyOf,
  isDay,
  MAX_CONDITIONS,
  MAX_GROUPS,
  MAX_INNER,
  MAX_TOTAL,
  ME,
  type Objects,
  type Op,
  operatorsFor,
  opLabel,
  PERIODS,
  resolveTarget,
  type Scalar,
  SYSTEM_COLUMNS,
  sameJson,
  todayIn,
} from '../filters'
import { fieldLabel } from '../naming'
import { fold, searchIndex as searchRecords } from '../search'
import { type Suggestion, suggest } from '../suggest'
import { CrmUsersContext, type RelationTitles } from './fields'
import { fieldTypeIcons } from './icons'
import { Button, cx, Dialog, inputClass, Kbd } from './kit'
import { RelationSearch } from './relation-picker'
import { useSearchIndex } from './search'
import { useCrmConfig } from './use-crm'

/**
 * A list's filters: the chips that show them, the box that turns typing into
 * them, and the editors that change them. What a filter is and which operators
 * a field has are decided in src/crm/filters.ts; what to offer for typed text
 * in src/crm/suggest.ts. This file is only how they look and are worked.
 */

export type FilterBarHandle = {
  /** Put the caret in the box (the `/` key). */
  focus(): void
  /** Open the list of fields to filter by (the `F` key). */
  pickField(): void
  /** Start a filter on one field (a column's "Filter by this column"). */
  filterBy(path: string): void
}

type Lookup = (objectKey: string, id: string) => string | undefined

const formatDay = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' })

// ── Editing one condition ───────────────────────────────────────────────────

/** The operators of a condition on the records that point at this one. */
const BACK_OPS = ['has', 'hasNone'] as const satisfies readonly Op[]

const small =
  'h-7 rounded-lg border border-c-line2 bg-c-raised px-2 text-[13px] text-c-fg focus:border-c-accent focus:outline-none'

/** A date, or a period such as "this month", for the `is`, `before` and `after` operators. */
function DayInput({
  value,
  today,
  onChange,
}: {
  value: Condition['value']
  today: string
  onChange: (v: string) => void
}) {
  const custom = isDay(value)
  return (
    <div className="flex flex-wrap gap-1.5">
      <select
        aria-label="When"
        className={small}
        value={custom ? 'date' : String(value ?? '')}
        onChange={(e) => onChange(e.currentTarget.value === 'date' ? today : e.currentTarget.value)}
      >
        <option value="" disabled>
          Choose…
        </option>
        {PERIODS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        <option value="date">a date…</option>
      </select>
      {custom && (
        <input
          type="date"
          aria-label="Date"
          className={small}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )}
    </div>
  )
}

/**
 * The two ends of a number range. Each box keeps what was typed; the filter
 * gets a value only once both hold a number, so a range with one end typed
 * isn't taken for "between 0 and N".
 */
function NumberRange({
  value,
  onChange,
  onKeyDown,
}: {
  value: Scalar[]
  onChange: (next: number[] | undefined) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  // Only an end that is already a number starts filled in.
  const [typed, setTyped] = useState(() =>
    [0, 1].map((i) => {
      const end = z.number().safeParse(value[i])
      return end.success ? String(end.data) : ''
    }),
  )

  return (
    <div className="flex items-center gap-1.5">
      {[0, 1].map((i) => (
        <input
          key={i}
          type="number"
          inputMode="decimal"
          aria-label={i === 0 ? 'From' : 'To'}
          placeholder={i === 0 ? 'From' : 'To'}
          className={cx(inputClass, 'h-8 py-0')}
          value={typed[i]}
          onChange={(e) => {
            const next = typed.map((t, j) => (j === i ? e.currentTarget.value : t))
            setTyped(next)
            const numbers = next.map((t) => (t.trim() === '' ? Number.NaN : Number(t)))
            onChange(numbers.every(Number.isFinite) ? numbers : undefined)
          }}
          onKeyDown={onKeyDown}
        />
      ))}
    </div>
  )
}

function Checklist({
  options,
  chosen,
  onToggle,
}: {
  options: { value: string; label: string }[]
  chosen: string[]
  onToggle: (value: string) => void
}) {
  const [find, setFind] = useState('')
  const shown = options.filter((o) => fold(o.label).includes(fold(find)))
  return (
    <div>
      {options.length > 8 && (
        <input
          aria-label="Find a value"
          placeholder="Find…"
          value={find}
          onChange={(e) => setFind(e.currentTarget.value)}
          className={cx(small, 'mb-1 w-full')}
        />
      )}
      <div className="max-h-56 overflow-y-auto">
        {shown.map((o) => {
          const on = chosen.includes(o.value)
          return (
            <label
              key={o.value}
              className="hover:bg-c-hov flex min-h-8 cursor-default items-center gap-2 rounded-lg px-1.5"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => onToggle(o.value)}
                className="size-3.5 accent-(--c-accent)"
              />
              <span className="truncate">{o.label}</span>
            </label>
          )
        })}
        {shown.length === 0 && <div className="text-c-fg3 px-1.5 py-1">Nothing matches</div>}
      </div>
    </div>
  )
}

/** The operator and value of one condition. Controlled: every change is handed up. */
function ConditionFields({
  objects,
  objectKey,
  cond,
  onChange,
  onEnter,
  titleOf,
  learn,
}: {
  objects: Objects
  objectKey: string
  cond: Condition
  onChange: (next: Condition) => void
  onEnter: () => void
  titleOf: Lookup
  /** A record's title became known (it was just picked). */
  learn: (objectKey: string, id: string, title: string) => void
}) {
  const users = useContext(CrmUsersContext)
  // "Today" is the business's day, as the server will read it: not the viewer's, and not UTC's.
  const today = todayIn(useCrmConfig().app.timezone)
  const target = resolveTarget(objects, objectKey, cond.field)

  if (!target) {
    return null
  }

  if (target.kind === 'back') {
    const other = objects[target.objectKey]
    const inner = cond.where ?? []
    const fields = other ? [...Object.keys(other.fields), ...Object.keys(SYSTEM_COLUMNS)] : []

    const setInner = (next: Condition[]) => {
      const changed: Condition = { field: cond.field, op: cond.op }

      if (next.length > 0) {
        changed.where = next
      }

      onChange(changed)
    }

    return (
      <div className="space-y-2">
        <select
          aria-label="Operator"
          className={cx(small, 'w-full')}
          value={cond.op}
          onChange={(e) => {
            const op = BACK_OPS.find((o) => o === e.currentTarget.value)

            if (op) {
              onChange({ ...cond, op })
            }
          }}
        >
          <option value="has">has any {target.label.toLowerCase()}</option>
          <option value="hasNone">has no {target.label.toLowerCase()}</option>
        </select>
        {inner.map((w, i) => (
          // Conditions have no identity beyond their place.
          <div key={i} className="border-c-line space-y-1.5 rounded-lg border p-2">
            <div className="flex items-center gap-1.5">
              <span className="text-c-fg3 text-xs">where</span>
              <select
                aria-label="Field"
                className={cx(small, 'min-w-0 flex-1')}
                value={w.field}
                onChange={(e) => {
                  const field = resolveTarget(objects, target.objectKey, e.currentTarget.value)

                  if (field?.kind !== 'field') {
                    return
                  }

                  setInner(
                    inner.map((x, j) =>
                      j === i ? { field: e.currentTarget.value, op: defaultOp(field.field) } : x,
                    ),
                  )
                }}
              >
                {fields.map((k) => (
                  <option key={k} value={k}>
                    {resolveTarget(objects, target.objectKey, k)?.label ?? k}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label="Remove this condition"
                onClick={() => setInner(inner.filter((_, j) => j !== i))}
                className="text-c-fg3 hover:bg-c-hov hover:text-c-fg rounded p-1"
              >
                <X className="size-3" />
              </button>
            </div>
            <ConditionFields
              objects={objects}
              objectKey={target.objectKey}
              cond={w}
              onChange={(next) => setInner(inner.map((x, j) => (j === i ? next : x)))}
              onEnter={onEnter}
              titleOf={titleOf}
              learn={learn}
            />
          </div>
        ))}
        {other && inner.length < MAX_INNER && (
          <button
            type="button"
            onClick={() => {
              const first = other.fields[other.titleField]

              if (first) {
                setInner([...inner, { field: other.titleField, op: defaultOp(first) }])
              }
            }}
            className="text-c-fg2 hover:text-c-fg flex items-center gap-1 text-xs"
          >
            <Plus className="size-3" /> Only those where…
          </button>
        )}
      </div>
    )
  }

  const { field } = target
  const family = familyOf(field)
  const ops = operatorsFor(field)
  const arity = arityOf(cond.op)
  const list = Array.isArray(cond.value) ? cond.value.map(String) : []

  const set = (value: Condition['value']) => {
    const changed: Condition = { field: cond.field, op: cond.op }

    if (value !== undefined) {
      changed.value = value
    }

    onChange(changed)
  }

  const toggle = (v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  const enter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onEnter()
    }
  }

  // Changing the operator keeps the value when the new one takes the same kind.
  const changeOp = (op: Op) => {
    const same =
      arityOf(op) === arity &&
      !(
        family === 'date' &&
        arity === 'one' &&
        ['inLast', 'inNext', 'olderThan'].includes(op) !==
          ['inLast', 'inNext', 'olderThan'].includes(cond.op)
      )

    const changed: Condition = { field: cond.field, op }

    if (same && cond.value !== undefined) {
      changed.value = cond.value
    }

    onChange(changed)
  }

  const pair = Array.isArray(cond.value) ? cond.value : []

  return (
    <div className="space-y-2">
      <select
        aria-label="Operator"
        className={cx(small, 'w-full')}
        value={cond.op}
        onChange={(e) => {
          // Only the operators listed below can be chosen.
          const op = ops.find((o) => o === e.currentTarget.value)

          if (op) {
            changeOp(op)
          }
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {op === 'in' && family === 'choice'
              ? 'is any of'
              : op === 'notIn'
                ? 'is none of'
                : op === 'olderThan'
                  ? 'more than … days ago'
                  : op === 'inLast'
                    ? 'in the last … days'
                    : op === 'inNext'
                      ? 'in the next … days'
                      : opLabel(op)}
          </option>
        ))}
      </select>

      {family === 'text' && arity === 'one' && (
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- The editor opens in response to a click or key press.
          autoFocus
          aria-label="Value"
          className={cx(inputClass, 'h-8 py-0')}
          value={String(cond.value ?? '')}
          onChange={(e) => set(e.currentTarget.value)}
          onKeyDown={enter}
        />
      )}

      {family === 'number' && arity === 'one' && (
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- The editor opens in response to a click or key press.
          autoFocus
          type="number"
          inputMode="decimal"
          aria-label="Value"
          className={cx(inputClass, 'h-8 py-0')}
          value={cond.value === undefined ? '' : String(cond.value)}
          onChange={(e) =>
            set(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))
          }
          onKeyDown={enter}
        />
      )}
      {family === 'number' && arity === 'two' && (
        <NumberRange value={pair} onChange={(next) => set(next)} onKeyDown={enter} />
      )}

      {family === 'date' &&
        arity === 'one' &&
        ['inLast', 'inNext', 'olderThan'].includes(cond.op) && (
          <div className="flex items-center gap-1.5">
            <input
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- The editor opens in response to a click or key press.
              autoFocus
              type="number"
              min={0}
              inputMode="numeric"
              aria-label="Days"
              className={cx(inputClass, 'h-8 w-24 py-0')}
              value={cond.value === undefined ? '' : String(cond.value)}
              onChange={(e) =>
                set(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))
              }
              onKeyDown={enter}
            />
            <span className="text-c-fg2">{cond.op === 'olderThan' ? 'days ago' : 'days'}</span>
          </div>
        )}
      {family === 'date' &&
        arity === 'one' &&
        !['inLast', 'inNext', 'olderThan'].includes(cond.op) && (
          <DayInput value={cond.value} today={today} onChange={(v) => set(v)} />
        )}
      {family === 'date' && arity === 'two' && (
        <div className="flex flex-wrap items-center gap-1.5">
          {[0, 1].map((i) => (
            <input
              key={i}
              type="date"
              aria-label={i === 0 ? 'From' : 'To'}
              className={small}
              value={isDay(pair[i]) ? pair[i] : ''}
              onChange={(e) => {
                const next = [isDay(pair[0]) ? pair[0] : today, isDay(pair[1]) ? pair[1] : today]
                next[i] = e.currentTarget.value
                set(next)
              }}
            />
          ))}
        </div>
      )}

      {arity === 'many' && field.type === 'select' && (
        <Checklist
          options={field.options.map((o) => ({ value: o.value, label: o.label ?? o.value }))}
          chosen={list}
          onToggle={toggle}
        />
      )}
      {arity === 'many' && field.type === 'user' && (
        <Checklist
          options={[
            { value: ME, label: 'Me' },
            ...users.map((u) => ({ value: u.id, label: u.name })),
          ]}
          chosen={list}
          onToggle={toggle}
        />
      )}
      {arity === 'many' && (field.type === 'relation' || field.type === 'relations') && (
        <div>
          {list.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {list.map((id) => (
                <span
                  key={id}
                  className="bg-c-hov flex items-center gap-1 rounded-md py-0.5 pr-1 pl-1.5 text-xs"
                >
                  {titleOf(field.to, id) ?? '…'}
                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() => toggle(id)}
                    className="text-c-fg3 hover:text-c-fg rounded p-0.5"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="border-c-line -mx-2 border-t">
            <RelationSearch
              objectKey={field.to}
              listClassName="max-h-44"
              onPick={(picked) => {
                if (!picked) {
                  return
                }

                learn(field.to, picked.id, picked.title)

                if (!list.includes(picked.id)) {
                  set([...list, picked.id])
                }
              }}
              onEscape={onEnter}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** A floating editor for one condition. Clicking away or Enter keeps the change; Escape drops it. */
function ConditionEditor({
  objects,
  objectKey,
  cond,
  isNew,
  onApply,
  onRemove,
  onClose,
  titleOf,
  learn,
  align = 'left',
}: {
  objects: Objects
  objectKey: string
  cond: Condition
  isNew: boolean
  onApply: (next: Condition) => void
  onRemove?: () => void
  onClose: () => void
  titleOf: Lookup
  learn: (objectKey: string, id: string, title: string) => void
  align?: 'left' | 'right'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState(cond)
  const target = resolveTarget(objects, objectKey, cond.field)
  const cleaned = cleanFilters(objects, objectKey, [[draft]])[0]?.[0]

  const latest = useRef({ cleaned, onApply, onClose, cond, isNew })
  latest.current = { cleaned, onApply, onClose, cond, isNew }

  const finish = () => {
    const now = latest.current

    if (now.cleaned && (now.isNew || !sameJson(now.cleaned, now.cond))) {
      now.onApply(now.cleaned)
    }

    now.onClose()
  }

  const finishRef = useRef(finish)
  finishRef.current = finish

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      // A press on something that is not a node (the window itself) is outside by definition.
      if (ref.current && !(e.target instanceof Node && ref.current.contains(e.target))) {
        finishRef.current()
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        latest.current.onClose()
      }
    }

    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  // Ticking a box or picking a record takes effect at once; typing waits for Enter or a click away.
  const change = (next: Condition) => {
    setDraft(next)
    const immediate = arityOf(next.op) !== 'one' && arityOf(next.op) !== 'two'
    const valid = cleanFilters(objects, objectKey, [[next]])[0]?.[0]

    if (immediate && valid && !isNew) {
      onApply(valid)
    }
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Filter by ${target?.label ?? 'field'}`}
      className={cx(
        'absolute top-full z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-c-line2 bg-c-raised p-2 text-[13px] shadow-xl shadow-black/10',
        align === 'right' ? 'right-0' : 'left-0',
      )}
    >
      <div className="text-c-fg3 mb-2 px-0.5 text-[11px] font-medium">{target?.label}</div>
      <ConditionFields
        objects={objects}
        objectKey={objectKey}
        cond={draft}
        onChange={change}
        onEnter={finish}
        titleOf={titleOf}
        learn={learn}
      />
      <div className="mt-2 flex items-center justify-between">
        {onRemove ? (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" size="sm" disabled={!cleaned} onClick={finish}>
          {isNew ? 'Add filter' : 'Done'}
        </Button>
      </div>
    </div>
  )
}

// ── Choosing a field ────────────────────────────────────────────────────────

type FieldOption = { path: string; label: string; section: string; field?: CrmField }

function fieldOptions(objects: Objects, objectKey: string) {
  const obj = objects[objectKey]

  if (!obj) {
    return { own: [], through: [] }
  }

  const own: FieldOption[] = [
    ...Object.entries(obj.fields).map(([key, field]) => ({
      path: key,
      label: fieldLabel(key, field),
      section: obj.label,
      field,
    })),
    ...Object.entries(SYSTEM_COLUMNS).map(([key, field]) => ({
      path: key,
      label: fieldLabel(key, field),
      section: 'Activity and dates',
      field,
    })),
    ...backRelations(objects, objectKey).map((path) => ({
      path,
      label: resolveTarget(objects, objectKey, path)?.label ?? path,
      section: 'Related records',
    })),
  ]

  const through: FieldOption[] = []

  for (const [key, field] of Object.entries(obj.fields)) {
    if (field.type !== 'relation') {
      continue
    }

    const related = objects[field.to]

    if (!related) {
      continue
    }

    const section = `${fieldLabel(key, field)} ›`

    for (const [inner, def] of [
      ...Object.entries(related.fields),
      ...Object.entries(SYSTEM_COLUMNS),
    ]) {
      if (def.type === 'relation') {
        continue
      }

      through.push({
        path: `${key}.${inner}`,
        label: `${fieldLabel(key, field)} › ${fieldLabel(inner, def)}`,
        section,
        field: def,
      })
    }
  }

  return { own, through }
}

/** The list of everything a list can be filtered by, with a box to narrow it. */
function FieldPicker({
  objects,
  objectKey,
  onPick,
  onClose,
}: {
  objects: Objects
  objectKey: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [find, setFind] = useState('')
  const [active, setActive] = useState(0)
  const { own, through } = useMemo(() => fieldOptions(objects, objectKey), [objects, objectKey])

  // Every word typed must be somewhere in the name: "company ind" finds "Company › Industry".
  const words = fold(find)
    .split(/[\s›]+/)
    .filter(Boolean)

  const typed = words.length > 0
  // Fields of related records are many: they show once something is typed, or their relation is opened.
  const relations = [...new Set(through.map((t) => t.section))]
  const usable = (o: FieldOption) => (o.field ? operatorsFor(o.field).length > 0 : true)

  const shown = typed
    ? [...own, ...through].filter((o) => usable(o) && words.every((w) => fold(o.label).includes(w)))
    : own.filter(usable)

  const rows: ({ kind: 'field'; option: FieldOption } | { kind: 'open'; section: string })[] = [
    ...shown.map((option) => ({ kind: 'field' as const, option })),
    ...(typed ? [] : relations.map((section) => ({ kind: 'open' as const, section }))),
  ]

  const current = Math.min(active, rows.length - 1)

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      // A press on something that is not a node (the window itself) is outside by definition.
      if (ref.current && !(e.target instanceof Node && ref.current.contains(e.target))) {
        onClose()
      }
    }

    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [onClose])

  const choose = (row: (typeof rows)[number] | undefined) => {
    if (!row) {
      return
    }

    if (row.kind === 'open') {
      setFind(`${row.section} `)
      setActive(0)
    } else {
      onPick(row.option.path)
    }
  }

  let section = ''
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Filter by"
      className="border-c-line2 bg-c-raised absolute top-full left-0 z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border shadow-xl shadow-black/10"
    >
      <input
        // Opens on a click or the F key.
        autoFocus
        aria-label="Find a field"
        placeholder="Filter by…"
        value={find}
        onChange={(e) => {
          setFind(e.currentTarget.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()

            setActive(
              Math.max(0, Math.min(rows.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1))),
            )
          } else if (e.key === 'Enter') {
            e.preventDefault()
            choose(rows[current])
          }
        }}
        className="border-c-line placeholder:text-c-fg3 w-full border-b bg-transparent px-3 py-2 text-[13px] outline-none"
      />
      <div className="max-h-72 overflow-y-auto p-1">
        {rows.map((row, i) => {
          const heading = row.kind === 'field' ? row.option.section : 'Fields of related records'
          const first = heading !== section
          section = heading

          const Icon =
            row.kind === 'field'
              ? row.option.field
                ? fieldTypeIcons[row.option.field.type]
                : Waypoints
              : ChevronRight

          return (
            <div key={row.kind === 'field' ? row.option.path : `open:${row.section}`}>
              {first && (
                <div className="text-c-fg3 px-2 pt-1.5 pb-1 text-[11px] font-medium">{heading}</div>
              )}
              <button
                type="button"
                onPointerMove={() => setActive(i)}
                onClick={() => choose(row)}
                className={cx(
                  'flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px]',
                  i === current && 'bg-c-hov',
                )}
              >
                <Icon className="text-c-fg3 size-3.5 shrink-0" />
                <span className="truncate">
                  {row.kind === 'field' ? row.option.label : row.section}
                </span>
              </button>
            </div>
          )
        })}
        {rows.length === 0 && <div className="text-c-fg3 px-2 py-1.5">No field matches</div>}
      </div>
    </div>
  )
}

// ── The bar ─────────────────────────────────────────────────────────────────

type Editing = { group: number; index: number } | { draft: Condition } | null

export function FilterBar({
  objectKey,
  filters,
  onFilters,
  q,
  onQuery,
  titles,
  leading,
  trailing,
  ref,
}: {
  objectKey: string
  filters: Filters
  onFilters: (next: Filters) => void
  /** The text search in force. */
  q: string | undefined
  onQuery: (q: string) => void
  /** Titles of the related records the filters name, sent with the list. */
  titles: RelationTitles
  /** Shown before the chips (the sort control) and after the box (the count). */
  leading?: ReactNode
  trailing?: ReactNode
  ref?: Ref<FilterBarHandle>
}) {
  const config = useCrmConfig()
  const objects: Objects = config.objects
  const obj = objects[objectKey]
  const users = useContext(CrmUsersContext)
  const index = useSearchIndex()
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const known = useRef(new Map<string, string>())
  const [text, setText] = useState(q ?? '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [editing, setEditing] = useState<Editing>(null)
  const [picking, setPicking] = useState(false)
  /** The next filter added starts a new "or" group. */
  const [orNext, setOrNext] = useState(false)
  const [sheet, setSheet] = useState(false)

  const [values, setValues] = useState<{
    q: string
    found: { field: string; value: string; count: number }[]
  }>()

  // The page's search text changed from outside (a link, the Back button): show it.
  // Its own searches coming back in the address are not that: typing may have moved on since.
  const lastQ = useRef(q)
  const sent = useRef(q ?? '')

  if (lastQ.current !== q) {
    lastQ.current = q

    if ((q ?? '') !== sent.current && (q ?? '') !== text.trim()) {
      setText(q ?? '')
    }
  }

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    pickField: () => setPicking(true),
    filterBy: (path) => start(path),
  }))

  const learn = (key: string, id: string, title: string) => known.current.set(`${key}:${id}`, title)

  const titleOf: Lookup = (key, id) =>
    known.current.get(`${key}:${id}`) ??
    titles[key]?.find((t) => t.id === id)?.title ??
    index?.objects[key]?.rows.find((r) => r[0] === id)?.[1]

  const ctx = { users, title: titleOf, day: formatDay }

  const typed = text.trim()

  // Values of text fields come from the server; everything else is worked out here.
  useEffect(() => {
    if (typed.length < 2) {
      return undefined
    }

    let stale = false

    const wait = setTimeout(() => {
      suggestValuesFn({ data: { objectKey, q: typed } }).then(
        (found) => {
          if (!stale) {
            setValues({ q: typed, found })
          }
        },
        () => undefined,
      )
    }, 150)

    return () => {
      stale = true
      clearTimeout(wait)
    }
  }, [objectKey, typed])

  // A list takes only so many filters (src/crm/filters.ts); past that the server would cut them off.
  const total = countConditions(filters)
  const lastFull = (filters[filters.length - 1]?.length ?? 0) >= MAX_CONDITIONS
  const canOr = filters.length < MAX_GROUPS && total < MAX_TOTAL
  const canAdd = total < MAX_TOTAL && (orNext ? canOr : !lastFull || canOr)

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!obj || !typed) {
      return []
    }

    // With no room for another filter, typing is only ever a search.
    if (!canAdd) {
      return [{ kind: 'search', id: 'search', q: typed }]
    }

    const records = index
      ? Object.entries(obj.fields).flatMap(([key, field]) =>
          field.type === 'relation' || field.type === 'relations'
            ? (searchRecords(index, typed, { only: field.to, per: 3 }).groups[0]?.hits ?? []).map(
                (h) => ({
                  field: key,
                  id: h.id,
                  title: h.title,
                }),
              )
            : [],
        )
      : []

    for (const r of records) {
      const field = obj.fields[r.field]

      if (field?.type === 'relation' || field?.type === 'relations') {
        known.current.set(`${field.to}:${r.id}`, r.title)
      }
    }

    return suggest(typed, {
      objects,
      objectKey,
      users,
      records,
      values: values?.q === typed ? values.found : [],
    })
  }, [obj, objects, objectKey, users, index, typed, values, canAdd])

  const search = (value: string, now = false) => {
    clearTimeout(timer.current)

    if (value === (q ?? '')) {
      return
    }

    const send = () => {
      sent.current = value
      onQuery(value)
    }

    if (now) {
      send()
    } else {
      timer.current = setTimeout(send, 250)
    }
  }

  const searchRef = useRef(search)
  searchRef.current = search

  // The list narrows as text is typed, unless the text can only be a filter
  // (">5000", "no email"): then the filter is offered ready to take with Enter,
  // and the list is left alone rather than searched for a word no record holds.
  const first = suggestions[0]
  const sure = first?.kind === 'condition' && first.sure === true

  useEffect(() => {
    setActive(sure ? 0 : -1)
    searchRef.current(sure ? '' : typed, sure)
  }, [typed, sure])

  if (!obj) {
    return null
  }

  const clearText = () => {
    setText('')
    setOpen(false)
    setActive(-1)

    if (q) {
      search('', true)
    } else {
      clearTimeout(timer.current)
    }
  }

  const add = (cond: Condition) => {
    if (!canAdd) {
      return
    }

    const groups = filters.map((g) => [...g])

    // A full set of filters carries on in a new "or" set rather than refusing.
    const last = groups.at(-1)

    if (orNext || !last || lastFull) {
      groups.push([cond])
    } else {
      last.push(cond)
    }

    setOrNext(false)
    onFilters(groups)
  }

  const replace = (group: number, at: number, cond: Condition) =>
    onFilters(filters.map((g, i) => (i === group ? g.map((c, j) => (j === at ? cond : c)) : g)))

  const remove = (group: number, at: number) =>
    onFilters(
      filters
        .map((g, i) => (i === group ? g.filter((_, j) => j !== at) : g))
        .filter((g) => g.length > 0),
    )

  /** Begin a filter on a field: one that needs no value is added at once, the rest open their editor. */
  function start(path: string, typedIt = false) {
    const target = resolveTarget(objects, objectKey, path)

    if (!target) {
      return
    }

    setPicking(false)

    // Text typed to find the field has done its job. A search already in force
    // has nothing to do with a filter started from the button or a column: it stays.
    if (typedIt) {
      clearText()
    }

    setEditing({
      draft:
        target.kind === 'back'
          ? { field: path, op: 'has' }
          : { field: path, op: defaultOp(target.field) },
    })
  }

  const take = (s: Suggestion | undefined) => {
    if (!s) {
      return
    }

    if (s.kind === 'search') {
      search(typed, true)
      setOpen(false)
    } else if (s.kind === 'field') {
      start(s.path, true)
    } else {
      clearText()
      add(s.condition)
    }
  }

  const count = filters.reduce((n, g) => n + g.length, 0)
  const activeId = active >= 0 ? `${listId}-${active}` : undefined

  const chips = (vertical: boolean) =>
    filters.map((group, g) => (
      // Groups have no identity beyond their place.
      <div key={g} className={vertical ? 'space-y-1.5' : 'contents'}>
        {g > 0 && (
          <span className={cx('text-xs font-medium text-c-fg3', vertical && 'block pt-1')}>or</span>
        )}
        {group.map((cond, i) => {
          const d = describe(objects, objectKey, cond, ctx)

          const isEditing =
            editing !== null && 'group' in editing && editing.group === g && editing.index === i

          return (
            // Conditions have no identity beyond their place.
            <div key={`${g}-${i}`} className="relative">
              <span
                className={cx(
                  'flex min-h-7 items-center rounded-lg border border-c-line2',
                  vertical && 'min-h-10',
                  isEditing && 'border-c-accent',
                )}
              >
                <button
                  type="button"
                  onClick={() => setEditing(isEditing ? null : { group: g, index: i })}
                  className={cx(
                    'flex min-w-0 flex-1 items-center gap-1.5 rounded-l-lg py-1 pr-1 pl-2 text-left hover:bg-c-hov',
                    vertical ? 'flex-wrap' : 'max-w-96',
                  )}
                >
                  <span className="text-c-fg2 shrink-0">{d.label}</span>
                  <span className="text-c-fg3 shrink-0">{d.op}</span>
                  {d.value && (
                    <span className={cx('font-medium', !vertical && 'truncate')}>{d.value}</span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Remove filter: ${d.label} ${d.op} ${d.value}`.trim()}
                  onClick={() => {
                    setEditing(null)
                    remove(g, i)
                  }}
                  className="text-c-fg3 hover:bg-c-hov hover:text-c-fg mr-0.5 rounded p-1"
                >
                  <X className="size-3" />
                </button>
              </span>
              {isEditing && (
                <ConditionEditor
                  objects={objects}
                  objectKey={objectKey}
                  cond={cond}
                  isNew={false}
                  onApply={(next) => replace(g, i, next)}
                  onRemove={() => {
                    setEditing(null)
                    remove(g, i)
                  }}
                  onClose={() => setEditing(null)}
                  titleOf={titleOf}
                  learn={learn}
                />
              )}
            </div>
          )
        })}
      </div>
    ))

  const adder = (
    <div className="relative flex items-center gap-1.5" data-guide="filter-add">
      <button
        type="button"
        onClick={() => setPicking(!picking)}
        aria-haspopup="dialog"
        disabled={!canAdd}
        title={
          canAdd
            ? undefined
            : 'This list has all the filters it can take. Remove one to add another.'
        }
        className="border-c-line2 text-c-fg2 hover:bg-c-hov flex h-7 items-center gap-1.5 rounded-lg border px-2 disabled:opacity-50"
      >
        <ListFilter className="text-c-fg3 size-3.5" /> Filter
      </button>
      {count > 0 && (
        <button
          type="button"
          aria-pressed={orNext}
          disabled={!canOr}
          title={
            canOr
              ? 'Start a second set of filters: a record matches when it meets either set'
              : 'This list has all the sets of filters it can take'
          }
          onClick={() => {
            setOrNext(!orNext)

            if (!orNext) {
              setPicking(true)
            }
          }}
          className={cx(
            'flex h-7 items-center rounded-lg border px-2 text-xs font-medium',
            'disabled:opacity-50',
            orNext ? 'border-c-accent text-c-accent' : 'border-c-line2 text-c-fg3 hover:bg-c-hov',
          )}
        >
          or
        </button>
      )}
      {picking && (
        <FieldPicker
          objects={objects}
          objectKey={objectKey}
          onPick={(path) => start(path)}
          onClose={() => setPicking(false)}
        />
      )}
      {editing !== null && 'draft' in editing && (
        <ConditionEditor
          objects={objects}
          objectKey={objectKey}
          cond={editing.draft}
          isNew
          onApply={add}
          onClose={() => setEditing(null)}
          titleOf={titleOf}
          learn={learn}
        />
      )}
    </div>
  )

  return (
    <div
      data-guide="filter-bar"
      className="border-c-line flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1"
    >
      {leading}
      <div className="hidden md:contents">{chips(false)}</div>
      {count > 0 && (
        <button
          type="button"
          onClick={() => setSheet(true)}
          className="border-c-line2 flex h-7 items-center gap-1.5 rounded-lg border px-2 font-medium md:hidden"
        >
          <ListFilter className="text-c-fg3 size-3.5" /> Filters · {count}
        </button>
      )}
      <div className={cx(sheet ? 'hidden' : 'contents')}>{adder}</div>

      <div
        ref={box}
        data-guide="filter-box"
        className="relative ml-auto min-w-44 flex-1 md:max-w-sm"
      >
        <Search className="text-c-fg3 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
        <input
          ref={input}
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label={`Search or filter ${obj.labelPlural.toLowerCase()}`}
          autoComplete="off"
          placeholder="Search, or type to filter…"
          value={text}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            const value = e.currentTarget.value
            setText(value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (suggestions.length === 0) {
                return
              }

              e.preventDefault()
              setOpen(true)
              const next = active + (e.key === 'ArrowDown' ? 1 : -1)
              setActive(Math.max(-1, Math.min(suggestions.length - 1, next)))
            } else if (e.key === 'Enter') {
              e.preventDefault()

              if (open && active >= 0) {
                take(suggestions[active])
              } else {
                search(typed, true)
                setOpen(false)
              }
            } else if (e.key === 'Tab' && !e.shiftKey && open && typed) {
              // Tab takes the highlighted suggestion, or the first one that is a filter.
              const pick = suggestions[Math.max(active, 0)]

              if (pick && pick.kind !== 'search') {
                e.preventDefault()
                take(pick)
              }
            } else if (e.key === 'Backspace' && text === '' && count > 0) {
              const g = filters.length - 1
              remove(g, (filters[g]?.length ?? 1) - 1)
            } else if (e.key === 'Escape') {
              if (open && suggestions.length > 0) {
                setOpen(false)
              } else if (text) {
                clearText()
              } else {
                e.currentTarget.blur()
              }
            }
          }}
          className="border-c-line2 placeholder:text-c-fg3 focus:border-c-accent h-7 w-full rounded-lg border bg-transparent pr-7 pl-7 focus:outline-none"
        />
        {text ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              clearText()
              input.current?.focus()
            }}
            className="text-c-fg3 hover:text-c-fg absolute top-1/2 right-1 -translate-y-1/2 rounded p-1"
          >
            <X className="size-3" />
          </button>
        ) : (
          <span className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 md:block">
            <Kbd>/</Kbd>
          </span>
        )}
        {open && suggestions.length > 0 && (
          // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Only keeps the caret in the box when the list is pressed.
          <div
            onMouseDown={(e) => e.preventDefault()}
            className="border-c-line2 bg-c-raised absolute top-full right-0 z-40 mt-1 w-full min-w-72 rounded-xl border p-1 shadow-xl shadow-black/10"
          >
            <div id={listId} role="listbox" aria-label="Filters to add">
              {suggestions.map((s, i) => {
                const d =
                  s.kind === 'condition'
                    ? describe(objects, objectKey, s.condition, ctx)
                    : undefined

                const target =
                  s.kind === 'condition'
                    ? resolveTarget(objects, objectKey, s.condition.field)
                    : undefined

                const Icon =
                  s.kind === 'search'
                    ? Search
                    : s.kind === 'field'
                      ? ListFilter
                      : target?.kind === 'field'
                        ? fieldTypeIcons[target.field.type]
                        : Waypoints

                return (
                  // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- Focus stays in the box, which handles the keys.
                  <div
                    key={s.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    onPointerMove={() => setActive(i)}
                    onClick={() => take(s)}
                    className={cx(
                      'flex min-h-9 cursor-default items-center gap-2 rounded-lg px-2 text-[13px] md:min-h-8',
                      i === active && 'bg-c-hov',
                      s.kind === 'search' && i > 0 && 'mt-1 border-t border-c-line pt-1',
                    )}
                  >
                    <Icon className="text-c-fg3 size-3.5 shrink-0" />
                    {s.kind === 'condition' && d ? (
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-c-fg2">{d.label}</span>{' '}
                        <span className="text-c-fg3">{d.op}</span>{' '}
                        <span className="font-medium">{d.value}</span>
                      </span>
                    ) : s.kind === 'field' ? (
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-c-fg2">Filter by</span>{' '}
                        <span className="font-medium">{s.label}</span>…
                      </span>
                    ) : s.kind === 'search' ? (
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-c-fg2">Search for</span>{' '}
                        <span className="font-medium">“{s.q}”</span>
                      </span>
                    ) : null}
                    {s.kind === 'condition' && s.count !== undefined && (
                      <span className="text-c-fg3 shrink-0 text-xs tabular-nums">
                        {s.count.toLocaleString()}
                      </span>
                    )}
                    {i === Math.max(active, 0) && s.kind !== 'search' && (
                      <span className="hidden shrink-0 md:block">
                        <Kbd>{active >= 0 ? '↵' : 'Tab'}</Kbd>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
      {trailing}

      <Dialog open={sheet} onClose={() => setSheet(false)} title={`Filters · ${count}`}>
        {sheet && (
          <div className="min-h-64 space-y-2">
            {chips(true)}
            <div className="pt-1">{adder}</div>
            <div className="flex justify-between pt-3">
              <Button
                variant="ghost"
                onClick={() => {
                  onFilters([])
                  setSheet(false)
                }}
              >
                Clear all
              </Button>
              <Button variant="primary" onClick={() => setSheet(false)}>
                <Check className="size-3.5" /> Done
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}
