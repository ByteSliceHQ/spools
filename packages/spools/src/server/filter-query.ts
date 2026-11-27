import type { CrmField } from '../crm/field-types'
import {
  type Condition,
  cleanFilters,
  dayRange,
  type Filters,
  familyOf,
  ME,
  resolveTarget,
  type Scalar,
  startOfDay,
  todayIn,
} from '../crm/filters'
import { phoneDigits } from '../crm/search'
import { crmConfig } from './spool'
import { backRelation, linkSide } from './store/objects'
import {
  and,
  contains,
  digitsContain,
  endsWith,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  neq,
  none,
  not,
  notNull,
  oneOf,
  or,
  type Predicate,
  sameText,
  some,
  startsWith,
} from './store/query'

/**
 * Turns filters (src/crm/filters.ts) into a store condition. What goes in has
 * been through `cleanFilters`, which only lets through fields the config has
 * and operators their type allows.
 */

export type FilterContext = {
  /** Who is looking: what "Me" stands for in a teammate filter. */
  userId?: string
  now?: Date
  /** Where "today" is decided. Defaults to the config's `app.timezone`. */
  timeZone?: string
}

/**
 * "Contains this text", whatever its case. On a phone field, digits typed like
 * a phone number are compared with the stored number's digits alone, so
 * 4105550100 finds (410) 555-0100 and 0100 finds only numbers with 0100 in them.
 */
export function containsText(column: string, field: CrmField | undefined, text: string): Predicate {
  const digits = field?.type === 'phone' ? phoneDigits(text.trim()) : undefined
  return digits ? digitsContain(column, digits) : contains(column, text)
}

/**
 * One condition on a relations field: a condition on the object's rows of the
 * field's links table, reached through its relation to them. "Has all of" is
 * one such test for each record named.
 */
function onLinks(objectKey: string, key: string, cond: Condition): Predicate | undefined {
  const side = linkSide(crmConfig(), objectKey, key)

  if (!side) {
    return undefined
  }

  const ids = (Array.isArray(cond.value) ? cond.value : []).map(String)

  switch (cond.op) {
    case 'empty':
      return none(side.relation)
    case 'notEmpty':
      return some(side.relation)
    case 'anyOf':
      return some(side.relation, oneOf(side.far, ids))
    case 'noneOf':
      return none(side.relation, oneOf(side.far, ids))

    case 'allOf': {
      const each = ids.map((id) => some(side.relation, eq(side.far, id)))
      const [only] = each
      return each.length === 1 && only ? only : and(...each)
    }

    default:
      return undefined
  }
}

/** One condition on a field of an object: a column of its own, or its links. */
function onColumn(
  objectKey: string,
  key: string,
  field: CrmField,
  cond: Condition,
  ctx: Context,
): Predicate | undefined {
  if (field.type === 'relations') {
    return onLinks(objectKey, key, cond)
  }

  const c = field.type === 'relation' ? `${key}Id` : key
  const family = familyOf(field)
  const { op, value } = cond
  const one = Array.isArray(value) ? value[0] : value
  // Text columns hold "" as well as nothing; both are empty.
  const blank = family === 'text' || field.type === 'user' || field.type === 'select'
  const empty = () => (blank ? or(isNull(c), eq(c, '')) : isNull(c))
  const filled = () => (blank ? and(notNull(c), neq(c, '')) : notNull(c))
  /** "Is not X" includes records with nothing there, as a person would expect. */
  const unless = (p: Predicate) => or(isNull(c), not(p))

  if (op === 'empty') {
    return empty()
  }

  if (op === 'notEmpty') {
    return filled()
  }

  if (family === 'text') {
    const text = String(one ?? '')

    switch (op) {
      case 'contains':
        return containsText(c, field, text)
      case 'notContains':
        return unless(containsText(c, field, text))
      case 'is':
        return sameText(c, text)
      case 'isNot':
        return unless(sameText(c, text))
      case 'startsWith':
        return startsWith(c, text)
      case 'endsWith':
        return endsWith(c, text)
    }
  }

  if (family === 'number') {
    // Money is a decimal, read and written as a string; plain numbers are floats.
    const num = (v: Scalar | undefined) =>
      field.type === 'currency' ? Number(v).toFixed(2) : Number(v)

    switch (op) {
      case 'eq':
        return eq(c, num(one))
      case 'neq':
        return unless(eq(c, num(one)))
      case 'gt':
        return gt(c, num(one))
      case 'gte':
        return gte(c, num(one))
      case 'lt':
        return lt(c, num(one))
      case 'lte':
        return lte(c, num(one))
      case 'between':
        return Array.isArray(value) ? and(gte(c, num(value[0])), lte(c, num(value[1]))) : undefined
    }
  }

  if (family === 'date') {
    const zone = ctx.timeZone
    const range = dayRange(cond, todayIn(zone, ctx.now))

    if (!range) {
      return undefined
    }

    const [from, to] = range

    // A date column holds days; a date-and-time column holds moments, so a day is the span between two midnights.
    const parts =
      field.type === 'date'
        ? [from && gte(c, from), to && lte(c, to)]
        : [from && gte(c, startOfDay(from, zone)), to && lt(c, endOfDay(to, zone))]

    const real = parts.filter((p): p is Predicate => !!p)
    return real.length === 2 ? and(...real) : real[0]
  }

  if (family === 'choice') {
    const values = (Array.isArray(value) ? value : []).map((v) =>
      v === ME ? ctx.userId : String(v),
    )

    switch (op) {
      case 'in':
        return oneOf(c, values)
      case 'notIn':
        return unless(oneOf(c, values))
    }
  }

  if (family === 'boolean') {
    if (op === 'yes') {
      return eq(c, true)
    }

    if (op === 'no') {
      return or(eq(c, false), isNull(c))
    }
  }

  return undefined
}

/** The moment the day after `day` begins: the first moment that is no longer `day`. */
function endOfDay(day: string, zone: string): Date {
  const next = new Date(`${day}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return startOfDay(next.toISOString().slice(0, 10), zone)
}

type Context = Required<FilterContext>

/** Operators that are true of an empty field: "is not X", "does not contain", "is empty", "is no". */
const TRUE_OF_NOTHING = new Set<Condition['op']>([
  'empty',
  'noneOf',
  'notIn',
  'isNot',
  'notContains',
  'neq',
  'no',
])

function compile(objectKey: string, cond: Condition, ctx: Context): Predicate | undefined {
  const target = resolveTarget(crmConfig().objects, objectKey, cond.field)

  if (!target) {
    return undefined
  }

  if (target.kind === 'back') {
    const relation = backRelation(target.objectKey, target.key)
    const conditions = (cond.where ?? []).flatMap((w) => compile(target.objectKey, w, ctx) ?? [])
    const inner = conditions.length > 1 ? and(...conditions) : conditions[0]
    return cond.op === 'hasNone' ? none(relation, inner) : some(relation, inner)
  }

  if (target.via) {
    // Through a relation: the record it points to must meet the condition.
    const condition = onColumn(target.objectKey, target.key, target.field, cond, ctx)
    const related = condition && some(target.via.key, condition)
    // A record that points to nothing has no such field at all, which is what
    // "is empty" and "is not X" ask for: the same answer as for an empty field of its own.
    return related && TRUE_OF_NOTHING.has(cond.op)
      ? or(isNull(`${target.via.key}Id`), related)
      : related
  }

  return onColumn(target.objectKey, target.key, target.field, cond, ctx)
}

/**
 * A condition for a list's filters: every condition of any one group. Undefined
 * when there is nothing to filter by.
 */
export function compileFilters(
  objectKey: string,
  filters: Filters | undefined,
  context: FilterContext = {},
): Predicate | undefined {
  const groups = cleanFilters(crmConfig().objects, objectKey, filters ?? [])

  if (groups.length === 0) {
    return undefined
  }

  // "Me" with nobody looking (a background job) matches no one rather than everyone.
  const ctx: Context = {
    userId: context.userId ?? '',
    now: context.now ?? new Date(),
    timeZone: context.timeZone ?? crmConfig().app.timezone,
  }

  const any = groups.map((group) => {
    const parts = group.flatMap((cond) => compile(objectKey, cond, ctx) ?? [])
    const [only] = parts
    return parts.length === 1 && only ? only : and(...parts)
  })

  return any.length === 1 ? any[0] : or(...any)
}
