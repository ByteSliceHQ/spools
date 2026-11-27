/**
 * Turns what someone types into the list's filter box into filters they can
 * take with one key: "won" offers "Stage is Won", ">5000" offers "Amount >
 * 5,000", "no email" offers "Email is empty". Pure: it reads the config and
 * what it is handed, so everything except looking up records and values
 * happens in the browser as each key is pressed.
 */
import type { CrmField } from './field-types'
import {
  backRelations,
  type Condition,
  familyOf,
  fieldOf,
  isDay,
  labelOf,
  ME,
  type Objects,
  type Op,
  operatorsFor,
  PERIODS,
  resolveTarget,
  SYSTEM_COLUMNS,
} from './filters'
import { fold } from './search'

export type Suggestion =
  /**
   * A finished filter. `count` is how many records have the value, when the
   * server said. `sure` marks text that can only have meant this filter
   * (">5000", "no email", an option's whole name), as opposed to text that
   * might as well be a search ("harbor").
   */
  | { kind: 'condition'; id: string; condition: Condition; count?: number; sure?: boolean }
  /** A field to filter by; choosing it opens the editor for its operator and value. */
  | { kind: 'field'; id: string; path: string; label: string }
  /** Plain text search for what was typed. */
  | { kind: 'search'; id: string; q: string }

export type SuggestContext = {
  objects: Objects
  objectKey: string
  users: { id: string; name: string }[]
  /** Records the typed text matches, for the object's relation fields. */
  records?: { field: string; id: string; title: string }[]
  /** Values of text fields the typed text matches, with how many records hold each. */
  values?: { field: string; value: string; count: number }[]
}

const PER_KIND = 4
const LIMIT = 12

/** The typed text starts the label, or a word in it. */
const startsWord = (label: string, typed: string): boolean => {
  const folded = fold(label)
  return (
    folded.startsWith(typed) || folded.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(typed))
  )
}

// ── Reading amounts and dates ───────────────────────────────────────────────

const AMOUNT = String.raw`\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m)?`

const COMPARE: [RegExp, Op][] = [
  [/^(?:>=|≥|at least|from)$/, 'gte'],
  [/^(?:<=|≤|at most|up to)$/, 'lte'],
  [/^(?:>|over|above|more than|greater than)$/, 'gt'],
  [/^(?:<|under|below|less than)$/, 'lt'],
  [/^(?:=|exactly|)$/, 'eq'],
]

const amount = (digits: string, unit: string | undefined): number =>
  Number(digits.replace(/,/g, '')) * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1)

/** "5000", "> 5,000", "over 5k", "5000-10000", "between 5k and 10k". */
export function parseAmount(text: string): { op: Op; value: number | number[] } | undefined {
  const [, low, lowUnit, high, highUnit] =
    new RegExp(`^(?:between\\s+)?${AMOUNT}\\s*(?:-|–|to|and)\\s*${AMOUNT}$`).exec(text) ?? []

  // Both amounts' digits are in every match of the pattern: they are only missing when it didn't match.
  if (low !== undefined && high !== undefined) {
    const [a, b] = [amount(low, lowUnit), amount(high, highUnit)]
    return { op: 'between', value: [Math.min(a, b), Math.max(a, b)] }
  }

  const [, words = '', digits, unit] = new RegExp(`^(.*?)\\s*${AMOUNT}$`).exec(text) ?? []

  if (digits === undefined) {
    return undefined
  }

  const op = COMPARE.find(([re]) => re.test(words.trim()))?.[1]
  return op ? { op, value: amount(digits, unit) } : undefined
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A day written as 2026-03-09, 3/9/2026 or 3/9/26. */
function parseDay(text: string): string | undefined {
  if (isDay(text)) {
    return text
  }

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text)

  if (!us) {
    return undefined
  }

  const year = us[3]?.length === 2 ? `20${us[3]}` : us[3]
  const day = `${year}-${pad(Number(us[1]))}-${pad(Number(us[2]))}`
  return isDay(day) ? day : undefined
}

/** "today", "this month", "last 30 days", "over 30 days ago", "before 3/1/2026". Several when the text is unfinished. */
export function parseDates(text: string): { op: Op; value: string | number }[] {
  const days = /^(\d{1,4})\s*\+?\s*d(?:ays?)?$/

  const rules: [RegExp, Op][] = [
    [/^(?:in the |in )?(?:last|past) (.+)$/, 'inLast'],
    [/^(?:in the |in )?next (.+)$/, 'inNext'],
    [/^(?:more than|over|older than) (.+?)(?: ago)?$/, 'olderThan'],
    [/^(.+?) ago$/, 'olderThan'],
  ]

  for (const [re, op] of rules) {
    const n = days.exec(re.exec(text)?.[1] ?? '')

    if (n) {
      return [{ op, value: Number(n[1]) }]
    }
  }

  const plus = /^(\d{1,4})\s*\+\s*d(?:ays?)?$/.exec(text)

  if (plus) {
    return [{ op: 'olderThan', value: Number(plus[1]) }]
  }

  const [, side, after] = /^(before|after)\s+(.+)$/.exec(text) ?? []
  const body = after ?? text
  const op: Op = side === 'before' || side === 'after' ? side : 'on'
  const day = parseDay(body)

  if (day) {
    return [{ op, value: day }]
  }

  if (body.length < 3) {
    return []
  }

  return PERIODS.filter(
    (p) => p.label.startsWith(body) || p.label.replace(' ', '') === body.replace(' ', ''),
  )
    .slice(0, PER_KIND)
    .map((p) => ({ op, value: p.id }))
}

// ── Suggestions ─────────────────────────────────────────────────────────────

const can = (field: CrmField, op: Op) => operatorsFor(field).includes(op)

/** Conditions on one field for the text that follows its name ("stage won", "amount > 5000"). */
function forField(path: string, field: CrmField, rest: string, ctx: SuggestContext): Condition[] {
  const family = familyOf(field)

  if (rest === '') {
    return []
  }

  if (/^(?:is )?(?:empty|blank|missing|unknown)$/.test(rest)) {
    return can(field, 'empty') ? [{ field: path, op: 'empty' }] : []
  }

  if (family === 'number') {
    const parsed = parseAmount(rest)
    return parsed ? [{ field: path, ...parsed }] : []
  }

  if (family === 'date') {
    return parseDates(rest).map((d) => ({ field: path, ...d }))
  }

  if (family === 'boolean') {
    if (/^(?:y|yes|true|on)$/.test(rest)) {
      return [{ field: path, op: 'yes' }]
    }

    return /^(?:n|no|false|off)$/.test(rest) ? [{ field: path, op: 'no' }] : []
  }

  if (field.type === 'select') {
    return field.options
      .filter((o) => startsWord(o.label ?? o.value, rest))
      .slice(0, PER_KIND)
      .map((o) => ({ field: path, op: 'in' as const, value: [o.value] }))
  }

  if (field.type === 'user') {
    const people = /^(?:me|mine|my)$/.test(rest)
      ? [ME]
      : ctx.users.filter((u) => startsWord(u.name, rest)).map((u) => u.id)

    return people.slice(0, PER_KIND).map((id) => ({ field: path, op: 'in' as const, value: [id] }))
  }

  if (family === 'text') {
    const op = (['contains', 'is'] as const).find((o) => can(field, o))
    return op ? [{ field: path, op, value: rest }] : []
  }

  return []
}

/**
 * What to offer for the text in the filter box, most likely first: values of
 * fields, records, amounts and dates, emptiness, fields by name, and last,
 * a plain search for the text.
 */
export function suggest(text: string, ctx: SuggestContext): Suggestion[] {
  const raw = text.trim()
  const typed = fold(raw)
  const obj = ctx.objects[ctx.objectKey]

  if (!typed || !obj) {
    return []
  }

  const fields: [string, CrmField][] = [
    ...Object.entries(obj.fields),
    ...Object.entries(SYSTEM_COLUMNS),
  ]

  const out: Suggestion[] = []
  const seen = new Set<string>()

  const add = (condition: Condition, extra: { count?: number; sure?: boolean } = {}) => {
    const id = JSON.stringify(condition)

    if (seen.has(id) || out.length >= LIMIT) {
      return
    }

    seen.add(id)
    out.push({ kind: 'condition', id, condition, ...extra })
  }

  const sure = { sure: true }

  const addField = (path: string) => {
    const target = resolveTarget(ctx.objects, ctx.objectKey, path)
    const id = `field:${path}`

    if (!target || seen.has(id) || out.length >= LIMIT) {
      return
    }

    seen.add(id)
    out.push({ kind: 'field', id, path, label: target.label })
  }

  // A field's name followed by something: the rest is read as that field's value.
  for (const [key, field] of fields) {
    const label = fold(labelOf(obj, key))

    for (const sep of [' ', ':']) {
      if (!typed.startsWith(label + sep)) {
        continue
      }

      const rest = typed.slice(label.length + 1).trim()
      const original = raw.slice(raw.length - rest.length)

      for (const c of forField(key, field, familyOf(field) === 'text' ? original : rest, ctx)) {
        add(c, sure)
      }
    }
  }

  // Values: select options, teammates, yes/no fields by name.
  const options = fields.flatMap(([key, field]) =>
    field.type === 'select'
      ? field.options
          .filter((o) => startsWord(o.label ?? o.value, typed))
          .map((o) => ({
            condition: { field: key, op: 'in' as const, value: [o.value] },
            whole: fold(o.label ?? o.value) === typed,
          }))
      : [],
  )

  // An option named in full comes before ones that merely start the same way.
  options.sort((a, b) => Number(b.whole) - Number(a.whole))

  for (const o of options.slice(0, PER_KIND * 2)) {
    add(o.condition, o.whole ? sure : {})
  }

  const userFields = fields.filter(([, f]) => f.type === 'user')

  const people = /^(?:me|mine|my)$/.test(typed)
    ? [ME]
    : ctx.users.filter((u) => startsWord(u.name, typed)).map((u) => u.id)

  const named = (id: string) =>
    id === ME || ctx.users.some((u) => u.id === id && fold(u.name) === typed)

  for (const id of people.slice(0, 2)) {
    for (const [key] of userFields.slice(0, PER_KIND)) {
      add({ field: key, op: 'in', value: [id] }, named(id) ? sure : {})
    }
  }

  for (const v of (ctx.values ?? []).slice(0, PER_KIND * 2)) {
    const field = fieldOf(obj, v.field)

    if (field && can(field, 'is')) {
      add({ field: v.field, op: 'is', value: v.value }, { count: v.count })
    }
  }

  // Records the object can point to.
  for (const r of (ctx.records ?? []).slice(0, PER_KIND * 2)) {
    // A relations field holds many: "has any of" this one.
    const many = fieldOf(obj, r.field)?.type === 'relations'
    add({ field: r.field, op: many ? 'anyOf' : 'in', value: [r.id] })
  }

  // Amounts and dates, on every field that can hold one.
  const parsedAmount = parseAmount(typed)

  if (parsedAmount) {
    const numeric = fields.filter(([, f]) => familyOf(f) === 'number')
    // Money first: an amount typed into a CRM is usually a value.
    numeric.sort(([, a], [, b]) => Number(b.type === 'currency') - Number(a.type === 'currency'))
    // A bare number could be a search (a phone number, an order number); "> 5000" or "5k-10k" could not.
    const certain = parsedAmount.op !== 'eq' || /^=|^exactly/.test(typed) ? sure : {}

    for (const [key] of numeric.slice(0, PER_KIND)) {
      add({ field: key, ...parsedAmount }, certain)
    }
  }

  const dates = parseDates(typed)

  if (dates.length > 0) {
    const dated = fields.filter(([, f]) => familyOf(f) === 'date')

    for (const d of dates.slice(0, dates.length > 1 ? 2 : 1)) {
      for (const [key] of dated.slice(0, dates.length > 1 ? 3 : 6)) {
        add({ field: key, ...d }, sure)
      }
    }
  }

  // Emptiness: "no email", "phone is empty", "has deals".
  const without =
    /^(?:no|without|missing|empty|blank)\s+(.+)$/.exec(typed) ??
    /^(.+?)\s+(?:is\s+)?(?:empty|blank|missing)$/.exec(typed)

  const having = /^(?:has|have|with|any)\s+(.+)$/.exec(typed)
  const about = without?.[1] ?? having?.[1]

  if (about) {
    for (const [key, field] of fields) {
      const op = without ? 'empty' : 'notEmpty'

      if (field.type !== 'boolean' && startsWord(labelOf(obj, key), about) && can(field, op)) {
        add({ field: key, op }, sure)
      }
    }

    for (const path of backRelations(ctx.objects, ctx.objectKey)) {
      const target = resolveTarget(ctx.objects, ctx.objectKey, path)

      if (target && startsWord(target.label, about)) {
        add({ field: path, op: without ? 'hasNone' : 'has' }, sure)
      }
    }
  }

  for (const [key, field] of fields) {
    if (field.type !== 'boolean') {
      continue
    }

    const [, negated] = /^(?:not|no|un)\s*(.+)$/.exec(typed) ?? []

    if (negated !== undefined && startsWord(labelOf(obj, key), negated)) {
      add({ field: key, op: 'no' })
    } else if (startsWord(labelOf(obj, key), typed)) {
      add({ field: key, op: 'yes' })
    }
  }

  // Fields by name, then the records that point here.
  for (const [key] of fields) {
    if (startsWord(labelOf(obj, key), typed)) {
      addField(key)
    }
  }

  for (const path of backRelations(ctx.objects, ctx.objectKey)) {
    const target = resolveTarget(ctx.objects, ctx.objectKey, path)

    if (target && startsWord(target.label, typed)) {
      addField(path)
    }
  }

  // What the text can only have meant goes first.
  const certain = (s: Suggestion) => (s.kind === 'condition' && s.sure ? 0 : 1)
  out.sort((a, b) => certain(a) - certain(b))
  return [...out, { kind: 'search', id: 'search', q: raw }]
}
