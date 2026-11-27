/**
 * Filters and sorting for lists of records: what a condition is, which
 * operators each field type has, how relative dates become days, and how a
 * condition reads on screen. Pure and shared by server and client: no
 * database. Zod reads filters as they arrive (from a link, a saved view or the
 * assistant) before anything here relies on their shape. The server turns
 * conditions into a query in `src/server/filter-query.ts`; the browser builds
 * them in `src/crm/ui/filter-bar.tsx`.
 */
import { z } from 'zod'

import type { CrmField } from './field-types'
import { fieldLabel } from './naming'

export type Op =
  // text
  | 'contains'
  | 'notContains'
  | 'is'
  | 'isNot'
  | 'startsWith'
  | 'endsWith'
  // numbers
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  // numbers and dates
  | 'between'
  // dates
  | 'on'
  | 'before'
  | 'after'
  | 'inLast'
  | 'inNext'
  | 'olderThan'
  // select, teammate, relation
  | 'in'
  | 'notIn'
  // yes/no
  | 'yes'
  | 'no'
  // any field
  | 'empty'
  | 'notEmpty'
  // records of another object that point at this one
  | 'has'
  | 'hasNone'
  // many related records (a `relations` field)
  | 'anyOf'
  | 'allOf'
  | 'noneOf'

export type Scalar = string | number

export type Condition = {
  /**
   * `stage` (a field, or a system field such as `createdAt`), `client.town`
   * (a field of the record a relation points to) or `~deals.client` (the deals
   * whose `client` is this record).
   */
  field: string
  op: Op
  value?: Scalar | Scalar[]
  /** For `has` and `hasNone`: conditions the related records must meet. */
  where?: Condition[]
}

/** Groups of conditions. A record matches when it meets every condition of any one group. */
export type Filters = Condition[][]

export type Sort = { field: string; dir: 'asc' | 'desc' }

/** At most this many levels of sorting. */
export const MAX_SORTS = 3
/**
 * How much one set of filters may ask of the database. Every condition is a
 * test on every row, and a filter fits in a link, so these bound what a link
 * can cost: at most this many "or" groups, conditions in a group, conditions
 * inside one "has …", and conditions altogether.
 */
export const MAX_GROUPS = 4
export const MAX_CONDITIONS = 10
export const MAX_INNER = 5
export const MAX_TOTAL = 40
const MAX_VALUES = 100
/** No field path is longer than this; anything longer isn't one. */
const MAX_PATH = 120

/** How many conditions a set of filters holds, counting those inside "has …". */
export const countConditions = (filters: Filters): number =>
  filters.reduce((n, group) => n + group.reduce((m, c) => m + 1 + (c.where?.length ?? 0), 0), 0)

/** In a teammate filter, stands for whoever is looking at the list. */
export const ME = '@me'

// ── Fields ──────────────────────────────────────────────────────────────────

type SystemField = Extract<CrmField, { type: 'datetime' | 'date' | 'user' }>

const system = (type: SystemField['type'], label: string): SystemField => ({
  type,
  label,
  required: false,
  searchable: false,
})

/** Dates the CRM keeps on every record from its activities and tasks (see `refreshStats`). */
export const STAT_FIELDS = {
  lastActivityAt: system('datetime', 'Last activity'),
  lastContactedAt: system('datetime', 'Last contacted'),
  nextTaskDue: system('date', 'Next task due'),
} as const

/** Columns every object has beside its configured fields. They can be shown, sorted and filtered, not edited. */
export const SYSTEM_COLUMNS: Record<string, SystemField> = {
  createdAt: system('datetime', 'Created'),
  updatedAt: system('datetime', 'Updated'),
  createdBy: system('user', 'Created by'),
  ...STAT_FIELDS,
}

/** Activity kinds that count as being in touch with someone. */
export const CONTACT_KINDS = ['call', 'meeting', 'email'] as const
/** Activity kinds that count as work on a record. Field edits and automations don't. */
export const ACTIVITY_KINDS = [...CONTACT_KINDS, 'note', 'task'] as const

type ObjectLike = {
  label: string
  labelPlural: string
  titleField: string
  fields: Record<string, CrmField>
}
export type Objects = Record<string, ObjectLike>

/** A configured or system field of an object. */
export function fieldOf(obj: ObjectLike, key: string): CrmField | undefined {
  if (Object.hasOwn(obj.fields, key)) {
    return obj.fields[key]
  }

  return Object.hasOwn(SYSTEM_COLUMNS, key) ? SYSTEM_COLUMNS[key] : undefined
}

export const labelOf = (obj: ObjectLike, key: string): string => {
  const field = fieldOf(obj, key)
  return field ? fieldLabel(key, field) : key
}

export type Target =
  | {
      kind: 'field'
      /** The object the field belongs to: the list's own, or the related one for `client.town`. */
      objectKey: string
      key: string
      field: CrmField
      /** Set for `client.town`: the relation on the list's object that leads there. */
      via?: { key: string; field: Extract<CrmField, { type: 'relation' }> }
      label: string
    }
  | {
      kind: 'back'
      /** The object whose records point here, and the relation field they do it with. */
      objectKey: string
      key: string
      label: string
    }

const backLabel = (objects: Objects, selfKey: string, otherKey: string, relKey: string): string => {
  const other = objects[otherKey]

  if (!other) {
    return otherKey
  }

  // "Deals", or "Deals (as contact)" when the object points here through more than one field.
  const routes = Object.values(other.fields).filter(
    (f) => f.type === 'relation' && f.to === selfKey,
  ).length

  return routes > 1
    ? `${other.labelPlural} (as ${fieldLabel(relKey, other.fields[relKey]).toLowerCase()})`
    : other.labelPlural
}

/** What a condition's `field` names, or undefined when the config has no such thing. */
export function resolveTarget(
  objects: Objects,
  objectKey: string,
  path: string,
): Target | undefined {
  // Keys come from page addresses: only an object's own entries count, never `constructor` or `__proto__`.
  const objectOf = (key: string) => (Object.hasOwn(objects, key) ? objects[key] : undefined)
  const obj = objectOf(objectKey)

  if (!obj || path.length > MAX_PATH) {
    return undefined
  }

  if (path.startsWith('~')) {
    const [otherKey, relKey, ...rest] = path.slice(1).split('.')
    const other = otherKey ? objectOf(otherKey) : undefined

    const rel =
      other && relKey && Object.hasOwn(other.fields, relKey) ? other.fields[relKey] : undefined

    if (
      !otherKey ||
      !relKey ||
      rest.length > 0 ||
      rel?.type !== 'relation' ||
      rel.to !== objectKey
    ) {
      return undefined
    }

    return {
      kind: 'back',
      objectKey: otherKey,
      key: relKey,
      label: backLabel(objects, objectKey, otherKey, relKey),
    }
  }

  const [head, tail, ...rest] = path.split('.')

  if (!head || rest.length > 0) {
    return undefined
  }

  const field = fieldOf(obj, head)

  if (!field) {
    return undefined
  }

  if (tail === undefined) {
    return { kind: 'field', objectKey, key: head, field, label: fieldLabel(head, field) }
  }

  if (field.type !== 'relation') {
    return undefined
  }

  const related = objectOf(field.to)
  const inner = related ? fieldOf(related, tail) : undefined

  if (!related || !inner) {
    return undefined
  }

  return {
    kind: 'field',
    objectKey: field.to,
    key: tail,
    field: inner,
    via: { key: head, field },
    label: `${fieldLabel(head, field)} › ${fieldLabel(tail, inner)}`,
  }
}

/** Every `~object.field` that points at this object, in config order. */
export function backRelations(objects: Objects, objectKey: string): string[] {
  const out: string[] = []

  for (const [otherKey, other] of Object.entries(objects)) {
    for (const [relKey, field] of Object.entries(other.fields)) {
      if (field.type === 'relation' && field.to === objectKey) {
        out.push(`~${otherKey}.${relKey}`)
      }
    }
  }

  return out
}

// ── Operators ───────────────────────────────────────────────────────────────

export type Family = 'text' | 'number' | 'date' | 'choice' | 'boolean'

export function familyOf(field: CrmField): Family {
  switch (field.type) {
    case 'number':
    case 'currency':
      return 'number'
    case 'date':
    case 'datetime':
      return 'date'
    case 'select':
    case 'relation':
    case 'user':
      return 'choice'
    case 'boolean':
      return 'boolean'
    default:
      return 'text'
  }
}

const FAMILY_OPS: Record<Family, Op[]> = {
  text: ['contains', 'notContains', 'is', 'isNot', 'startsWith', 'endsWith', 'empty', 'notEmpty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'],
  date: ['on', 'before', 'after', 'between', 'inLast', 'inNext', 'olderThan', 'empty', 'notEmpty'],
  choice: ['in', 'notIn', 'empty', 'notEmpty'],
  boolean: ['yes', 'no'],
}

/**
 * What an encrypted field can be asked, by mode. These are the questions the
 * encrypted column types will answer; anything else would need the plaintext.
 */
const ENCRYPTED_OPS: Record<NonNullable<CrmField['encrypted']>, Op[] | 'all'> = {
  storage: ['empty', 'notEmpty'],
  eq: ['empty', 'notEmpty', 'is', 'isNot', 'in', 'notIn'],
  match: ['empty', 'notEmpty', 'contains', 'notContains'],
  search: 'all',
}

/** The operators a field can be filtered with, in the order they are offered. */
export function operatorsFor(field: CrmField): Op[] {
  const ops = FAMILY_OPS[familyOf(field)]
  const allowed = field.encrypted ? ENCRYPTED_OPS[field.encrypted] : 'all'
  return allowed === 'all' ? ops : ops.filter((op) => allowed.includes(op))
}

/** Whether free-text search may read a field: not when its encryption mode rules matching out. */
export const textSearchable = (field: CrmField): boolean =>
  !field.encrypted || field.encrypted === 'match' || field.encrypted === 'search'

export type Arity = 'none' | 'one' | 'two' | 'many'

export function arityOf(op: Op): Arity {
  if (
    op === 'empty' ||
    op === 'notEmpty' ||
    op === 'yes' ||
    op === 'no' ||
    op === 'has' ||
    op === 'hasNone'
  ) {
    return 'none'
  }

  if (op === 'between') {
    return 'two'
  }

  return op === 'in' || op === 'notIn' ? 'many' : 'one'
}

const OP_LABELS: Record<Op, string> = {
  contains: 'contains',
  notContains: 'does not contain',
  is: 'is',
  isNot: 'is not',
  startsWith: 'starts with',
  endsWith: 'ends with',
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'is between',
  on: 'is',
  before: 'is before',
  after: 'is after',
  inLast: 'in the last',
  inNext: 'in the next',
  olderThan: 'more than',
  in: 'is',
  notIn: 'is not',
  yes: 'is yes',
  no: 'is no',
  empty: 'is empty',
  notEmpty: 'is not empty',
  has: 'has any',
  hasNone: 'has none',
  anyOf: 'has any of',
  allOf: 'has all of',
  noneOf: 'has none of',
}

/** How an operator reads between the field's name and its value. */
export const opLabel = (op: Op): string => OP_LABELS[op]

/** The operator a new condition on this field starts with. */
export function defaultOp(field: CrmField): Op {
  const ops = operatorsFor(field)
  return ops[0] ?? 'notEmpty'
}

// ── Dates ───────────────────────────────────────────────────────────────────

export const PERIODS = [
  { id: 'today', label: 'today' },
  { id: 'yesterday', label: 'yesterday' },
  { id: 'tomorrow', label: 'tomorrow' },
  { id: 'thisWeek', label: 'this week' },
  { id: 'lastWeek', label: 'last week' },
  { id: 'nextWeek', label: 'next week' },
  { id: 'thisMonth', label: 'this month' },
  { id: 'lastMonth', label: 'last month' },
  { id: 'nextMonth', label: 'next month' },
  { id: 'thisQuarter', label: 'this quarter' },
  { id: 'lastQuarter', label: 'last quarter' },
  { id: 'nextQuarter', label: 'next quarter' },
  { id: 'thisYear', label: 'this year' },
  { id: 'lastYear', label: 'last year' },
  { id: 'nextYear', label: 'next year' },
] as const

export type Period = (typeof PERIODS)[number]['id']
const isPeriod = (v: string): v is Period => PERIODS.some((p) => p.id === v)
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Whether text is a real calendar day written YYYY-MM-DD. */
const isDayText = (text: string): boolean => {
  if (!DAY.test(text)) {
    return false
  }

  const at = Date.parse(`${text}T00:00:00Z`)
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === text
}

/** A real calendar day written YYYY-MM-DD. "2026-04-31" is not one: the database would refuse it. */
export const isDay = (v: unknown): v is string => {
  const text = z.string().safeParse(v)
  return text.success && isDayText(text.data)
}

/**
 * Whether a value is a number rather than a string. A condition's values are
 * only ever one or the other: `Number` hands a number back as itself (NaN
 * included, which `Object.is` counts as itself), and never turns a string
 * into that same string.
 */
const isNumber = (v: Scalar): v is number => Object.is(Number(v), v)

/** A value that is a day or a period, written as text. */
const isDayOrPeriod = (v: Scalar | undefined): v is string =>
  v !== undefined && !isNumber(v) && (isDayText(v) || isPeriod(v))

const pad = (n: number) => String(n).padStart(2, '0')
/** Calendar arithmetic on a `YYYY-MM-DD` day, done in UTC so no time zone can shift it. */
const utc = (day: string) => new Date(`${day}T00:00:00Z`)

const dayOf = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

const ymd = (y: number, m: number, d: number) => dayOf(new Date(Date.UTC(y, m, d)))

export function addDays(day: string, n: number): string {
  const d = utc(day)
  d.setUTCDate(d.getUTCDate() + n)
  return dayOf(d)
}

/** The first and last day of a period, given today's date. Weeks start on Monday. */
export function periodRange(period: Period, today: string): [string, string] {
  const t = utc(today)
  const y = t.getUTCFullYear()
  const m = t.getUTCMonth()
  const monday = addDays(today, -((t.getUTCDay() + 6) % 7))
  const quarter = Math.floor(m / 3) * 3

  const months = (first: number, count: number): [string, string] => [
    ymd(y, first, 1),
    ymd(y, first + count, 0),
  ]

  switch (period) {
    case 'today':
      return [today, today]
    case 'yesterday':
      return [addDays(today, -1), addDays(today, -1)]
    case 'tomorrow':
      return [addDays(today, 1), addDays(today, 1)]
    case 'thisWeek':
      return [monday, addDays(monday, 6)]
    case 'lastWeek':
      return [addDays(monday, -7), addDays(monday, -1)]
    case 'nextWeek':
      return [addDays(monday, 7), addDays(monday, 13)]
    case 'thisMonth':
      return months(m, 1)
    case 'lastMonth':
      return months(m - 1, 1)
    case 'nextMonth':
      return months(m + 1, 1)
    case 'thisQuarter':
      return months(quarter, 3)
    case 'lastQuarter':
      return months(quarter - 3, 3)
    case 'nextQuarter':
      return months(quarter + 3, 3)
    case 'thisYear':
      return months(0, 12)
    case 'lastYear':
      return months(-12, 12)
    case 'nextYear':
      return months(12, 12)

    default: {
      const unknown: never = period
      throw new Error(`There is no period "${String(unknown)}"`)
    }
  }
}

/** Today's date where the business is. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** The moment a day begins in a time zone. */
export function startOfDay(day: string, timeZone: string): Date {
  const wall = utc(day).getTime()

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  // What the zone's clock reads at a given moment, as if that reading were UTC.
  const read = (at: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]))
    return Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    )
  }

  // Start from midnight UTC and correct by the zone's offset; a second pass settles days when the clocks change.
  let at = wall - (read(wall) - wall)
  at = wall - (read(at) - at)
  return new Date(at)
}

/**
 * The days a date condition covers, first and last inclusive; either end may
 * be open. Undefined when the condition isn't about a range of days.
 */
export function dayRange(
  cond: Pick<Condition, 'op' | 'value'>,
  today: string,
): [string?, string?] | undefined {
  const { op, value } = cond
  const one = Array.isArray(value) ? value[0] : value

  const days = (v: Scalar | undefined): [string, string] | undefined => {
    if (v === undefined || isNumber(v)) {
      return undefined
    }

    return isPeriod(v) ? periodRange(v, today) : isDayText(v) ? [v, v] : undefined
  }

  if (op === 'on') {
    return days(one)
  }

  if (op === 'before') {
    const r = days(one)
    return r ? [undefined, addDays(r[0], -1)] : undefined
  }

  if (op === 'after') {
    const r = days(one)
    return r ? [addDays(r[1], 1), undefined] : undefined
  }

  if (op === 'between' && Array.isArray(value)) {
    const from = days(value[0])
    const to = days(value[1])

    if (!from || !to) {
      return undefined
    }

    // "Between March and January" means the same span as the other way round.
    return from[0] <= to[1] ? [from[0], to[1]] : [to[0], from[1]]
  }

  const n = Number(one)

  if (!Number.isFinite(n) || n < 0) {
    return undefined
  }

  if (op === 'inLast') {
    return [addDays(today, -n), today]
  }

  if (op === 'inNext') {
    return [today, addDays(today, n)]
  }

  if (op === 'olderThan') {
    return [undefined, addDays(today, -n - 1)]
  }

  return undefined
}

// ── Cleaning ────────────────────────────────────────────────────────────────

/** A string or a finite number: Zod's numbers leave out NaN and the infinities. */
const scalarInput = z.union([z.string(), z.number()])

/**
 * A condition's value as it arrives. Anything that isn't a scalar or a list
 * reads as no value, and an item of a list that isn't a scalar as a gap, so a
 * list keeps its length ("between" needs exactly two). Only the first
 * `MAX_VALUES` items of a list are looked at.
 */
const listItemInput = scalarInput.optional().catch(undefined)

const valueInput = z
  .union([
    scalarInput,
    z
      .array(z.unknown())
      .transform((list) => list.slice(0, MAX_VALUES).map((item) => listItemInput.parse(item))),
  ])
  .optional()
  .catch(undefined)

type RawValue = z.output<typeof valueInput>

/** A condition inside "has …". Its own `where` is never read: conditions nest one level only. */
const innerConditionInput = z.object({ field: z.string(), op: z.string(), value: valueInput })

/**
 * A condition as it arrives, before its field and operator are checked against
 * the config. Only the first few conditions of a "has …" are looked at, so a
 * huge list costs nothing; one that isn't a condition at all is dropped.
 */
const conditionInput = innerConditionInput.extend({
  where: z
    .array(z.unknown())
    .transform((list) =>
      list.slice(0, MAX_INNER * 4).flatMap((item) => {
        const inner = innerConditionInput.safeParse(item)
        return inner.success ? [inner.data] : []
      }),
    )
    .optional()
    .catch(undefined),
})

type RawCondition = z.output<typeof innerConditionInput> & {
  where?: z.output<typeof innerConditionInput>[] | undefined
}

/**
 * Filters as they arrive: groups of conditions, one group, or the older map of
 * field to exact value (`{ "pipeline": "residential" }`), which becomes one
 * group of "is" conditions (or "is yes" and "is no" for true and false).
 * Anything else holds no conditions.
 */
const groupsInput = z
  .union([
    z.array(z.array(z.unknown())),
    z.array(z.unknown()).transform((group) => [group]),
    z
      .looseObject({})
      .transform((legacy) => [
        Object.entries(legacy).map(([field, value]) =>
          value === true || value === false
            ? { field, op: value ? 'yes' : 'no' }
            : { field, op: 'in', value: [value] },
        ),
      ]),
  ])
  .catch([])

/** One level of sorting as it arrives: only `field` has to be there, and any `dir` but "desc" sorts up. */
const sortInput = z.object({
  field: z.string(),
  dir: z.literal('desc').optional().catch(undefined),
})

const number = (v: Scalar | undefined): number | undefined => {
  if (v === undefined) {
    return undefined
  }

  const n = isNumber(v) ? v : v.trim() !== '' ? Number(v.replace(/[$,\s]/g, '')) : NaN
  return Number.isFinite(n) ? n : undefined
}

function cleanValue(
  field: CrmField,
  op: Op,
  value: RawValue,
): Condition['value'] | null | undefined {
  const arity = arityOf(op)

  if (arity === 'none') {
    return undefined
  }

  const family = familyOf(field)

  if (arity === 'many') {
    // An option the config no longer has is kept: the filter then matches nothing,
    // where dropping it would make an old view show everything.
    const list = (Array.isArray(value) ? value : [value])
      .filter((v) => v !== undefined)
      .map((v) => String(v).slice(0, 500))

    const unique = [...new Set(list)]
    return unique.length > 0 ? unique : null
  }

  if (arity === 'two') {
    if (!Array.isArray(value) || value.length !== 2) {
      return null
    }

    const [first, second] = value

    if (family === 'number') {
      const [a, b] = [number(first), number(second)]
      return a === undefined || b === undefined ? null : [Math.min(a, b), Math.max(a, b)]
    }

    return isDayOrPeriod(first) && isDayOrPeriod(second) ? [first, second] : null
  }

  // One value is asked for: a list is not one.
  if (Array.isArray(value)) {
    return null
  }

  if (family === 'number') {
    return number(value) ?? null
  }

  if (family === 'date') {
    if (op === 'inLast' || op === 'inNext' || op === 'olderThan') {
      const n = number(value)
      return n !== undefined && n >= 0 && n <= 36_500 ? Math.floor(n) : null
    }

    return isDayOrPeriod(value) ? value : null
  }

  return value !== undefined && !isNumber(value) && value.trim() !== '' ? value.slice(0, 500) : null
}

const isOp = (op: string): op is Op => Object.hasOwn(OP_LABELS, op)

function cleanCondition(
  objects: Objects,
  objectKey: string,
  raw: RawCondition,
  nested = false,
): Condition | undefined {
  const { field, op, value, where } = raw
  const target = resolveTarget(objects, objectKey, field)

  if (!target) {
    return undefined
  }

  if (target.kind === 'back') {
    if (nested || (op !== 'has' && op !== 'hasNone')) {
      return undefined
    }

    const inner = (where ?? [])
      .flatMap((w) => cleanCondition(objects, target.objectKey, w, true) ?? [])
      .slice(0, MAX_INNER)

    const condition: Condition = { field, op }

    if (inner.length > 0) {
      condition.where = inner
    }

    return condition
  }

  // One step only: a condition inside "has" can't itself reach through a relation.
  if (nested && target.via) {
    return undefined
  }

  if (!isOp(op) || !operatorsFor(target.field).includes(op)) {
    return undefined
  }

  const cleaned = cleanValue(target.field, op, value)

  if (cleaned === null) {
    return undefined
  }

  const condition: Condition = { field, op }

  if (cleaned !== undefined) {
    condition.value = cleaned
  }

  return condition
}

/**
 * Filters as the rest of the code may rely on them: every condition names
 * something the config has, uses an operator its field allows and carries a
 * value of the right shape. Anything else is dropped, and anything past the
 * limits above is cut off, so a config change or a hand-edited link can
 * neither break a list nor make it expensive. Also accepts the older form, a
 * map of field to exact value (`{ "pipeline": "residential" }`).
 */
export function cleanFilters(objects: Objects, objectKey: string, raw: unknown): Filters {
  let budget = MAX_TOTAL
  const out: Filters = []

  for (const group of groupsInput.parse(raw)) {
    if (out.length >= MAX_GROUPS || budget <= 0) {
      break
    }

    const kept: Condition[] = []

    // Looking at a few more than can be kept lets valid conditions through after dropped ones, without reading a huge list.
    for (const given of group.slice(0, MAX_CONDITIONS * 4)) {
      if (kept.length >= MAX_CONDITIONS || budget <= 0) {
        break
      }

      const parsed = conditionInput.safeParse(given)
      const condition = parsed.success ? cleanCondition(objects, objectKey, parsed.data) : undefined

      if (!condition) {
        continue
      }

      // The conditions inside "has …" count too; one that doesn't fit is cut back to what does.
      const { where, ...plain } = condition
      const inner = where?.slice(0, Math.max(0, budget - 1))
      const fitted: Condition = inner && inner.length > 0 ? { ...plain, where: inner } : plain
      budget -= 1 + (fitted.where?.length ?? 0)
      kept.push(fitted)
    }

    if (kept.length > 0) {
      out.push(kept)
    }
  }

  return out
}

/** Sort levels that name a column of the object; relations sort by the related record's title. */
export function cleanSort(objects: Objects, objectKey: string, raw: unknown): Sort[] {
  const obj = objects[objectKey]

  if (!obj || !raw) {
    return []
  }

  const list = Array.isArray(raw) ? raw : [raw]
  const seen = new Set<string>()
  const out: Sort[] = []

  for (const item of list) {
    const parsed = sortInput.safeParse(item)

    if (!parsed.success) {
      continue
    }

    const { field, dir } = parsed.data

    if (seen.has(field) || !fieldOf(obj, field)) {
      continue
    }

    seen.add(field)
    out.push({ field, dir: dir ?? 'asc' })
  }

  return out.slice(0, MAX_SORTS)
}

/** Whether two values write the same JSON: how filters and sorts are compared. */
export const sameJson = <T>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The fields a set of filters pins to one value, as { field: value }: what a
 * record created from the list should start with, and which pipeline a board's
 * stages belong to. Only when there is a single group, since with "or" no one
 * value is certain.
 */
export function pinnedValues(filters: Filters): Record<string, string | boolean> {
  const [group] = filters
  const out = new Map<string, string | boolean>()

  if (filters.length !== 1 || !group) {
    return Object.fromEntries(out)
  }

  for (const c of group) {
    if (c.field.includes('.') || c.field.startsWith('~')) {
      continue
    }

    if (c.op === 'yes') {
      out.set(c.field, true)
    } else if (c.op === 'no') {
      out.set(c.field, false)
    } else if (
      c.op === 'in' &&
      Array.isArray(c.value) &&
      c.value.length === 1 &&
      c.value[0] !== ME
    ) {
      out.set(c.field, String(c.value[0]))
    }
  }

  return Object.fromEntries(out)
}

/** Every record a set of filters names through a relation, as { objectKey: ids }, so their titles can be fetched. */
export function relationIds(
  objects: Objects,
  objectKey: string,
  filters: Filters,
): Record<string, string[]> {
  const out: Record<string, Set<string>> = {}

  const visit = (key: string, cond: Condition) => {
    const target = resolveTarget(objects, key, cond.field)

    if (!target) {
      return
    }

    if (target.kind === 'back') {
      for (const inner of cond.where ?? []) {
        visit(target.objectKey, inner)
      }

      return
    }

    if (target.field.type !== 'relation' || !Array.isArray(cond.value)) {
      return
    }

    const ids = out[target.field.to] ?? new Set<string>()
    out[target.field.to] = ids

    for (const v of cond.value) {
      ids.add(String(v))
    }
  }

  for (const group of filters) {
    for (const cond of group) {
      visit(objectKey, cond)
    }
  }

  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]))
}

// ── Reading a condition aloud ───────────────────────────────────────────────

export type Describe = {
  users: { id: string; name: string }[]
  /** The title of a related record, when known. */
  title: (objectKey: string, id: string) => string | undefined
  /** Formats a day for display; defaults to the day as written. */
  day?: (day: string) => string
}

const periodLabel = (v: Scalar): string | undefined => PERIODS.find((p) => p.id === v)?.label

function valueText(field: CrmField, v: Scalar, ctx: Describe): string {
  if (field.type === 'select') {
    return field.options.find((o) => o.value === v)?.label ?? String(v)
  }

  if (field.type === 'user') {
    return v === ME ? 'Me' : (ctx.users.find((u) => u.id === v)?.name ?? 'Someone')
  }

  if (field.type === 'relation') {
    return ctx.title(field.to, String(v)) ?? '…'
  }

  if (field.type === 'currency' && isNumber(v)) {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: field.currency,
      maximumFractionDigits: 2,
    })
      .format(v)
      .replace(/\.00$/, '')
  }

  if (field.type === 'number' && isNumber(v)) {
    return v.toLocaleString()
  }

  if (field.type === 'date' || field.type === 'datetime') {
    // A number is never a day, and writes the same either way.
    const text = String(v)
    return periodLabel(v) ?? (isDayText(text) ? (ctx.day?.(text) ?? text) : text)
  }

  return String(v)
}

/** What `describe` says: the field's label, the operator and the value. */
export type Described = { label: string; op: string; value: string }

/** A condition as three pieces of text: "Stage", "is", "Won or Lost". */
export function describe(
  objects: Objects,
  objectKey: string,
  cond: Condition,
  ctx: Describe,
): Described {
  const target = resolveTarget(objects, objectKey, cond.field)

  if (!target) {
    return { label: cond.field, op: opLabel(cond.op), value: '' }
  }

  if (target.kind === 'back') {
    const inner = (cond.where ?? []).map((w) => {
      const d = describe(objects, target.objectKey, w, ctx)
      return [d.label, d.op, d.value].filter(Boolean).join(' ')
    })

    const op = cond.op === 'hasNone' ? 'has no' : 'has'
    return {
      label: objects[objectKey]?.label ?? 'Record',
      op,
      value: `${target.label.toLowerCase()}${inner.length > 0 ? ` where ${inner.join(' and ')}` : ''}`,
    }
  }

  const { field } = target

  const values =
    cond.value === undefined ? [] : Array.isArray(cond.value) ? cond.value : [cond.value]

  const texts = values.map((v) => valueText(field, v, ctx))
  let value: string

  if (cond.op === 'between') {
    value = texts.join(' and ')
  } else if (cond.op === 'inLast' || cond.op === 'inNext') {
    value = `${texts[0]} day${values[0] === 1 ? '' : 's'}`
  } else if (cond.op === 'olderThan') {
    value = `${texts[0]} day${values[0] === 1 ? '' : 's'} ago`
  } else if (cond.op === 'in') {
    value = texts.join(' or ')
  } else if (cond.op === 'notIn') {
    value = texts.join(' or ')
  } else if (familyOf(field) === 'text' && texts[0] !== undefined) {
    value = `“${texts[0]}”`
  } else {
    value = texts.join(', ')
  }

  return { label: target.label, op: opLabel(cond.op), value }
}
