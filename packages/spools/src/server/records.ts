import { Effect } from 'effect'
import { z } from 'zod'

import type { CrmObject } from '../crm/config-schema'
import { titleKey } from '../crm/csv'
import {
  fieldInputSchema,
  isTextLike,
  type LinksChange,
  linksChangeSchema,
} from '../crm/field-types'
import {
  ACTIVITY_KINDS,
  CONTACT_KINDS,
  cleanSort,
  type Filters,
  fieldOf,
  type Sort,
  SYSTEM_COLUMNS,
} from '../crm/filters'
import { countKey, idsKey, inverseOf, LINKS_READ } from '../crm/links'
import { fieldLabel } from '../crm/naming'
import { reconcileDependents, touchesDependents } from '../crm/options'
import { compileFilters, containsText } from './filter-query'
import { Invalid } from './runtime/errors'
import { crmConfig, getObject, objectTable } from './spool'
import { type CrmRecord, type CrmValue, type LinkSide, linkSide, linkTables } from './store/objects'
import {
  and,
  asc,
  desc,
  eq,
  type Order,
  oneOf,
  or,
  type Predicate,
  type Query,
  type Scalar,
} from './store/query'
import { Store } from './store/store'
import { Activity, RecordFolder } from './store/tables'

/**
 * Generic, config-driven record access. An object's table comes from the config
 * (store/objects.ts); values are validated on the way in by Zod schemas derived
 * from crm.config.json.
 *
 * Every function is an Effect on the `Store` service. Values that don't
 * satisfy the config fail with `Invalid`, whose message names each field.
 */

export type { CrmRecord, CrmValue } from './store/objects'

/** A value that is neither a list nor a related record. */
const scalarValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.date(),
  z.null(),
  z.undefined(),
])

/** Any value a row can hold, lists and related records included. */
const storedValue: z.ZodType<CrmValue> = z.lazy(() =>
  z.union([scalarValue, z.array(storedValue), z.record(z.string(), storedValue)]),
)

const relatedValue = z.record(z.string(), storedValue)

/**
 * A stored value as text, the way `String` writes it, so titles, summaries and
 * comparisons read the same as they always have. A related record has no text
 * of its own and reads as nothing, rather than "[object Object]".
 */
export function valueText(value: CrmValue): string {
  if (Array.isArray(value)) {
    // As `join` writes a list: an empty item is an empty string.
    return value
      .map((item) => (item === null || item === undefined ? '' : valueText(item)))
      .join(',')
  }

  const scalar = scalarValue.safeParse(value)
  return scalar.success ? String(scalar.data) : ''
}

/** The related record a row carries for a relation (the whole record, or its id and title), if `value` is one. */
export const relatedRecord = (value: CrmValue) => relatedValue.safeParse(value).data

/** One field of the related record a row carries for a relation. */
export const relatedField = (value: CrmValue, key: string): CrmValue => relatedRecord(value)?.[key]

const relationFields = (obj: CrmObject) =>
  Object.entries(obj.fields)
    .filter(([, f]) => f.type === 'relation')
    .map(([k]) => k)

/**
 * How much of each related record comes back with a row:
 * - `full`: the whole related record (a single record's page, hooks, the assistant);
 * - `titles`: its id and title only, which is all a list, a board or an export shows;
 * - `none`: nothing, for work that only reads the row's own columns.
 */
export type Relations = 'full' | 'titles' | 'none'

function related(
  obj: CrmObject,
  relations: Relations = 'full',
  only?: string[],
): Query<CrmRecord>['include'] {
  if (relations === 'none') {
    return {}
  }

  const keys = relationFields(obj).filter((key) => !only || only.includes(key))
  return Object.fromEntries(
    keys.map((key) => {
      const field = obj.fields[key]
      const title = field?.type === 'relation' ? getObject(field.to).titleField : 'id'
      return [key, relations === 'full' ? ('all' as const) : [title]]
    }),
  )
}

/** Field problems as one message, a line per field: what staff read. */
const issuesMessage = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.map((i) => `${i.path.map(String).join('.') || 'value'}: ${i.message}`).join('\n')

/** The schema submitted values are checked against: an entry for each of the object's fields. */
function inputSchema(obj: CrmObject, partial: boolean) {
  const shape: Record<string, z.ZodType> = {}

  for (const [key, field] of Object.entries(obj.fields)) {
    const k =
      field.type === 'relation' ? `${key}Id` : field.type === 'relations' ? idsKey(key) : key

    const s = fieldInputSchema(field)
    shape[k] = partial ? s.optional() : s
  }

  return z.object(shape).strip()
}

/**
 * Values as they are submitted for a record (a form, an import, a hook, the
 * assistant), keyed by field and not yet checked: the object's schema decides
 * which of them are kept.
 */
export type RecordInput = z.input<ReturnType<typeof inputSchema>>

/** Submitted values once the object's schema has checked them. */
export type RecordValues = z.output<ReturnType<typeof inputSchema>>

/**
 * What is wrong with submitted values, field by field; empty when they satisfy
 * the config. For code that wants to fix values rather than refuse them (an
 * import that moves a value it can't use into the notes).
 */
export function inputIssues(
  objectKey: string,
  data: RecordInput,
  partial = false,
): { path: PropertyKey[]; message: string }[] {
  const result = inputSchema(getObject(objectKey), partial).safeParse(data)
  return result.success ? [] : result.error.issues
}

/** Validate submitted values against the object's fields. Unknown keys are dropped. */
export const parseInput = (
  objectKey: string,
  data: RecordInput,
  partial = false,
): Effect.Effect<RecordValues, Invalid> => {
  const result = inputSchema(getObject(objectKey), partial).safeParse(data)
  return result.success
    ? Effect.succeed(result.data)
    : Effect.fail(new Invalid({ message: issuesMessage(result.error.issues) }))
}

export type ListQuery = {
  objectKey: string
  q?: string
  /** One column or several: records equal on the first are ordered by the next. A relation sorts by its record's title. */
  sort?: Sort | Sort[]
  /** Exact matches. Keys are field keys; relations accept either `company` or `companyId`. */
  where?: Record<string, string | number | boolean | null>
  /** Conditions with operators, as lists build them (src/crm/filters.ts). Applied as well as `where`. */
  filters?: Filters
  /** Who is asking: what "Me" means in a teammate filter. */
  viewerId?: string
  limit?: number
  offset?: number
  /** How much of each related record to bring back. Defaults to `full`. */
  relations?: Relations
  /** How many related records each `relations` field brings back for a row. Defaults to `LINKS_READ`. */
  links?: number
  /**
   * Bring back only these fields of each row (with its id and timestamps), for
   * views that show a few of them on many rows. A system column may be named
   * too. Unknown keys are ignored, and a `relations` field that isn't named
   * has none of its links read.
   */
  fields?: string[]
}

/** A `where` key as a filterable column, or why it can't be one. */
function whereColumn(obj: CrmObject, key: string): { column: string } | { problem: string } {
  if (key === 'id' || key === 'createdBy') {
    return { column: key }
  }

  const base =
    key.endsWith('Id') &&
    Object.hasOwn(obj.fields, key.slice(0, -2)) &&
    obj.fields[key.slice(0, -2)]?.type === 'relation'
      ? key.slice(0, -2)
      : key

  const field = Object.hasOwn(obj.fields, base) ? obj.fields[base] : undefined

  if (!field) {
    return { problem: `Unknown field "${key}"` }
  }

  if (field.encrypted) {
    return { problem: `"${key}" is encrypted; use the text query instead` }
  }

  if (field.type === 'relations') {
    return {
      problem: `"${key}" holds many records; use filters instead (anyOf, allOf, noneOf)`,
    }
  }

  return { column: field.type === 'relation' ? `${base}Id` : base }
}

/** `where` with its keys turned into columns, or `Invalid` naming the first that can't be one. */
function whereColumns(
  obj: CrmObject,
  where: ListQuery['where'],
): Effect.Effect<Record<string, Scalar>, Invalid> {
  const columns: Record<string, Scalar> = {}

  for (const [key, value] of Object.entries(where ?? {})) {
    const found = whereColumn(obj, key)

    if ('problem' in found) {
      return Effect.fail(new Invalid({ message: found.problem }))
    }

    columns[found.column] = value
  }

  return Effect.succeed(columns)
}

/** A query's conditions and text search, as one condition. Shared by listing and counting. */
function matches(
  objectKey: string,
  { q, filters, viewerId }: Pick<ListQuery, 'q' | 'filters' | 'viewerId'>,
): Predicate | undefined {
  const obj = getObject(objectKey)

  const parts = [
    compileFilters(objectKey, filters, { userId: viewerId }),
    matchingText(obj, searchableFields(obj), q),
  ].filter((p): p is Predicate => p !== undefined)

  return parts.length > 1 ? and(...parts) : parts[0]
}

/** The fields free-text search reads. The config only lets text-like fields whose encryption allows matching be searchable. */
export const searchableFields = (obj: CrmObject) =>
  Object.entries(obj.fields)
    .filter(([, f]) => f.searchable)
    .map(([k]) => k)

/**
 * Rows where, for every word typed, some one of `fields` contains it, whatever
 * its case: "smith easton" finds the Smith in Easton. Undefined when nothing
 * was typed, or there is nothing to search.
 */
export function matchingText(
  obj: CrmObject,
  fields: string[],
  q: string | undefined,
): Predicate | undefined {
  const search = q?.trim()

  if (!search || fields.length === 0) {
    return undefined
  }

  // A phone number is one thing to look for however it is spaced; anything else is words.
  const words = /^[\d\s().+-]+$/.test(search) ? [search] : search.split(/\s+/).slice(0, 8)
  return and(...words.map((word) => or(...fields.map((f) => containsText(f, obj.fields[f], word)))))
}

export const listRecords = Effect.fn('records.listRecords')(function* ({
  objectKey,
  q,
  sort,
  where,
  filters,
  viewerId,
  limit = 50,
  offset = 0,
  relations = 'full',
  links,
  fields,
}: ListQuery) {
  const obj = getObject(objectKey)
  const columns = yield* whereColumns(obj, where)

  const order = cleanSort(crmConfig().objects, objectKey, sort).map(({ field, dir }): Order => {
    const def = fieldOf(obj, field)
    // Empty values go last whichever way the column is sorted. A relation sorts by its record's title.
    return {
      by: def?.type === 'relation' ? [field, getObject(def.to).titleField] : field,
      dir,
      nulls: 'last',
    }
  })

  if (order.length === 0) {
    order.push(desc('createdAt'))
  }

  const wanted = fields?.filter((f) => Object.hasOwn(obj.fields, f))

  // A relations field has no column: its records are read from its links, below.
  const own = wanted?.flatMap((f) => {
    const type = obj.fields[f]?.type
    return type === 'relations' ? [] : [type === 'relation' ? `${f}Id` : f]
  })

  const system = fields?.filter((f) => Object.hasOwn(SYSTEM_COLUMNS, f)) ?? []
  const store = yield* Store

  const rows = yield* store.find(objectTable(objectKey), {
    where: columns,
    filter: matches(objectKey, { q, filters, viewerId }),
    // Without a list of fields, every column comes back.
    select: own && [...new Set(['id', 'createdAt', 'updatedAt', ...system, ...own])],
    include: related(obj, relations, wanted),
    // The id settles ties, so paging never shows a record twice or skips one.
    order: [...order, asc('id')],
    limit: Math.min(limit, 500),
    offset,
  })

  return relations === 'none' ? rows : yield* withLinks(objectKey, rows, { only: wanted, links })
})

/** How many records match a query (ignores paging). */
export const countMatching = Effect.fn('records.countMatching')(function* (
  query: Pick<ListQuery, 'objectKey' | 'q' | 'where' | 'filters' | 'viewerId'>,
) {
  const where = yield* whereColumns(getObject(query.objectKey), query.where)
  const store = yield* Store
  return yield* store.count(objectTable(query.objectKey), {
    where,
    filter: matches(query.objectKey, query),
  })
})

export type RelatedGroup = { objectKey: string; field: string; rows: CrmRecord[] }

/**
 * Records in other objects that point at this record through a relation field,
 * or hold it in a relations field that has no inverse here.
 */
export const relatedRecords = Effect.fn('records.relatedRecords')(function* (
  objectKey: string,
  id: string,
  limit = 25,
) {
  const pointers: { objectKey: string; field: string; many: boolean }[] = []

  for (const [otherKey, other] of Object.entries(crmConfig().objects)) {
    for (const [field, def] of Object.entries(other.fields)) {
      if (def.type === 'relation' && def.to === objectKey) {
        pointers.push({ objectKey: otherKey, field, many: false })
      }

      // A relations field that holds this record, unless this object shows the same links itself (an inverse).
      if (
        def.type === 'relations' &&
        def.to === objectKey &&
        def.inverse === undefined &&
        inverseOf(crmConfig().objects, otherKey, field) === undefined
      ) {
        pointers.push({ objectKey: otherKey, field, many: true })
      }
    }
  }

  return yield* Effect.forEach(
    pointers,
    ({ many, ...p }) =>
      Effect.map(
        listRecords({
          objectKey: p.objectKey,
          ...(many
            ? { filters: [[{ field: p.field, op: 'anyOf', value: [id] }]] }
            : { where: { [`${p.field}Id`]: id } }),
          limit,
          relations: 'titles',
        }),
        (rows): RelatedGroup => ({ ...p, rows }),
      ),
    { concurrency: 'unbounded' },
  )
})

/**
 * The titles of many records of one object, by id, in one query per 500 ids.
 * Ids that match nothing are simply absent from the result.
 */
export const recordTitlesOf = Effect.fn('records.recordTitlesOf')(function* (
  objectKey: string,
  ids: string[],
) {
  const obj = getObject(objectKey)
  const store = yield* Store
  const titles = new Map<string, string>()
  const unique = [...new Set(ids)]
  const chunks: string[][] = []

  for (let at = 0; at < unique.length; at += 500) {
    chunks.push(unique.slice(at, at + 500))
  }

  yield* Effect.forEach(
    chunks,
    (chunk) =>
      Effect.map(
        store.find(objectTable(objectKey), {
          filter: oneOf('id', chunk),
          select: ['id', obj.titleField],
        }),
        (rows) => {
          for (const r of rows) {
            titles.set(r.id, valueText(r[obj.titleField] ?? 'Untitled'))
          }
        },
      ),
    { concurrency: 'unbounded', discard: true },
  )

  return titles
})

export const getRecord = Effect.fn('records.getRecord')(function* (objectKey: string, id: string) {
  const store = yield* Store

  const record = yield* store.first(objectTable(objectKey), {
    where: { id },
    include: related(getObject(objectKey)),
  })

  return record ? yield* withItsLinks(objectKey, record) : null
})

// ── Many-to-many relations ──────────────────────────────────────────────────
//
// A `relations` field has no column: what it holds are rows of its links table
// (store/objects.ts), read and written here through the store like any other
// table, with ordinary conditions. Nothing else reaches a links table.

type LinkField = { key: string; label: string; side: LinkSide }

/** An object's relations fields, each with the links it reads and writes. */
function linkFields(objectKey: string, only?: readonly string[]): LinkField[] {
  const obj = getObject(objectKey)

  return Object.entries(obj.fields).flatMap(([key, field]) => {
    const side =
      field.type === 'relations' && (!only || only.includes(key))
        ? linkSide(crmConfig(), objectKey, key)
        : undefined

    return side ? [{ key, label: fieldLabel(key, field), side }] : []
  })
}

const chunked = <T>(items: readonly T[], size = 500): T[][] => {
  const chunks: T[][] = []

  for (let at = 0; at < items.length; at += size) {
    chunks.push(items.slice(at, at + size))
  }

  return chunks
}

/** Titles in the order people read them, whatever their case; the id settles ties. */
const byTitle = (a: TitleOption, b: TitleOption) => {
  const [x, y] = [a.title.toLowerCase(), b.title.toLowerCase()]
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Rows with what their relations fields hold: under `<field>` the related
 * records (id and title, in title order), under `<field>Ids` their ids, and
 * under `<field>Count` how many there are. A row brings back at most `links`
 * of them (the ones linked first), so a tag on ten thousand contacts costs a
 * list no more than a tag on a hundred: the count says when there are more.
 *
 * Three ordinary reads per field for the rows that hold no more than that: how
 * many links each row has, the links, and the titles of the records they lead
 * to (from the related object's own table). A row that holds more is read on
 * its own, with the limit, so it costs one read more: the store has no way to
 * ask for the first few rows of each of several groups in one read.
 */
const withLinks = Effect.fn('records.withLinks')(function* (
  objectKey: string,
  rows: CrmRecord[],
  options: { only?: readonly string[] | undefined; links?: number | undefined } = {},
) {
  const fields = linkFields(objectKey, options.only)

  if (rows.length === 0 || fields.length === 0) {
    return rows
  }

  const limit = Math.max(1, options.links ?? LINKS_READ)
  const store = yield* Store
  const ids = rows.map((row) => row.id)

  yield* Effect.forEach(
    fields,
    ({ key, side }) =>
      Effect.gen(function* () {
        const { table } = side.link
        const counts = new Map<string, number>()

        for (const chunk of chunked(ids)) {
          const found = yield* store.countValues(table, side.near, {
            filter: oneOf(side.near, chunk),
            atLeast: 1,
          })

          for (const { value, count } of found) {
            counts.set(value, count)
          }
        }

        // Rows with few links are read together; one with more than it may bring back is read alone, with a limit.
        const few = ids.filter((id) => (counts.get(id) ?? 0) <= limit && counts.has(id))
        const many = ids.filter((id) => (counts.get(id) ?? 0) > limit)
        const held = new Map<string, string[]>()

        const keep = (found: readonly { sourceId: string; targetId: string }[]) => {
          for (const link of found) {
            const sofar = held.get(link[side.near])

            if (sofar) {
              sofar.push(link[side.far])
            } else {
              held.set(link[side.near], [link[side.far]])
            }
          }
        }

        for (const chunk of chunked(few)) {
          keep(yield* store.find(table, { filter: oneOf(side.near, chunk) }))
        }

        for (const id of many) {
          keep(
            yield* store.find(table, {
              filter: eq(side.near, id),
              order: [asc('createdAt'), asc('id')],
              limit,
            }),
          )
        }

        const titles = yield* recordTitlesOf(side.to, [...held.values()].flat())
        const titleField = getObject(side.to).titleField

        for (const row of rows) {
          const shown = (held.get(row.id) ?? [])
            .flatMap((id): TitleOption[] => {
              const title = titles.get(id)
              return title === undefined ? [] : [{ id, title }]
            })
            .toSorted(byTitle)

          row[key] = shown.map(({ id, title }) => ({ id, [titleField]: title }))
          row[idsKey(key)] = shown.map(({ id }) => id)
          row[countKey(key)] = counts.get(row.id) ?? 0
        }
      }),
    { discard: true },
  )

  return rows
})

/** One row with what its relations fields hold (`withLinks`). */
const withItsLinks = (objectKey: string, record: CrmRecord) =>
  Effect.as(withLinks(objectKey, [record]), record)

/**
 * Which of these records a record holds in one of its relations fields. A read
 * brings back the first of its links only (`LINKS_READ`), so a picker over a
 * record that holds more asks here about the ones it lists.
 */
export const linkedAmong = Effect.fn('records.linkedAmong')(function* (
  objectKey: string,
  id: string,
  fieldKey: string,
  ids: readonly string[],
) {
  const [field] = linkFields(objectKey, [fieldKey])

  if (!field || ids.length === 0) {
    return []
  }

  const { side } = field
  const store = yield* Store

  const found = yield* store.find(side.link.table, {
    filter: and(eq(side.near, id), oneOf(side.far, ids)),
  })

  return found.map((link) => link[side.far])
})

/** What a write did to one relations field: the records it linked and the ones it let go. */
export type LinksChanged = { field: string; added: TitleOption[]; removed: TitleOption[] }

/** The changes to relations fields among checked values, and the values that are columns. */
function splitLinks(objectKey: string, input: RecordValues) {
  const values: RecordValues = { ...input }
  const changes: { field: LinkField; change: LinksChange }[] = []

  for (const field of linkFields(objectKey)) {
    const change = linksChangeSchema.safeParse(values[idsKey(field.key)]).data
    delete values[idsKey(field.key)]

    if (change) {
      changes.push({ field, change })
    }
  }

  return { values, changes }
}

/**
 * Change the records one relations field of a record holds. Only the links
 * that differ are written: rows are added for records newly held and removed
 * for ones let go. Call it in a transaction, with the record and the records
 * the change names held (`holdRecord`, given the same values): two changes
 * that link the same pair then happen one after the other, and the second
 * finds the link already there. The links table holds each pair once, and on
 * Postgres a statement that breaks that rule ends its whole transaction, so the
 * duplicate is kept from being written, not caught afterwards.
 *
 * A record is never linked to itself: a person is not their own mentor.
 *
 * A set that replaces is refused when the record holds more than a read
 * brings back: whoever sent it can't have seen what they would be removing.
 */
const writeLinks = Effect.fn('records.writeLinks')(function* (
  objectKey: string,
  id: string,
  { key, label, side }: LinkField,
  change: LinksChange,
) {
  const store = yield* Store
  const { table } = side.link
  const name = idsKey(key)
  const mine = eq(side.near, id)
  let add: string[]
  let remove: string[]

  // Only a relation to the record's own object can name the record itself.
  if (side.to === objectKey && ('set' in change ? change.set : change.add).includes(id)) {
    return yield* new Invalid({
      message: `${name}: a ${getObject(objectKey).label.toLowerCase()} can't be linked to itself under ${label}. Take its own id (${id}) out of the list.`,
    })
  }

  if ('set' in change) {
    const count = yield* store.count(table, { filter: mine })

    if (count > LINKS_READ) {
      return yield* new Invalid({
        message: `${name}: ${label} holds ${count} records here, more than one write can replace. Send { "add": [...], "remove": [...] } to change some of them.`,
      })
    }

    const held = (yield* store.find(table, { filter: mine })).map((link) => link[side.far])
    const [has, wants] = [new Set(held), new Set(change.set)]
    add = change.set.filter((other) => !has.has(other))
    remove = held.filter((other) => !wants.has(other))
  } else {
    const leaving = new Set(change.remove)
    const wanted = change.add.filter((other) => !leaving.has(other))
    const named = [...new Set([...wanted, ...change.remove])]

    const held = new Set(
      named.length === 0
        ? []
        : (yield* store.find(table, { filter: and(mine, oneOf(side.far, named)) })).map(
            (link) => link[side.far],
          ),
    )

    add = wanted.filter((other) => !held.has(other))
    remove = change.remove.filter((other) => held.has(other))
  }

  // Looked up in the related object's own table: an id that names none of its records is refused here.
  const titles = yield* recordTitlesOf(side.to, [...add, ...remove])
  const unknown = add.filter((other) => !titles.has(other))

  if (unknown.length > 0) {
    return yield* new Invalid({
      message: `${name}: no ${getObject(side.to).label.toLowerCase()} with id ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ` (and ${unknown.length - 3} more)` : ''}`,
    })
  }

  if (remove.length > 0) {
    yield* store.remove(table, { filter: and(mine, oneOf(side.far, remove)) })
  }

  for (const other of add) {
    yield* store.insert(
      table,
      side.near === 'sourceId'
        ? { sourceId: id, targetId: other }
        : { sourceId: other, targetId: id },
    )
  }

  const titled = (others: string[]) =>
    others
      .map((other): TitleOption => ({ id: other, title: titles.get(other) ?? '' }))
      .toSorted(byTitle)

  const changed: LinksChanged = { field: key, added: titled(add), removed: titled(remove) }
  return changed
})

/** Remove every link to or from a record, on each links table it has an end in. */
const removeLinks = Effect.fn('records.removeLinks')(function* (objectKey: string, id: string) {
  const store = yield* Store

  for (const link of linkTables(crmConfig())) {
    if (link.source.objectKey === objectKey) {
      yield* store.remove(link.table, { where: { sourceId: id } })
    }

    if (link.target.objectKey === objectKey) {
      yield* store.remove(link.table, { where: { targetId: id } })
    }
  }
})

/** Apply `dependsOn` rules to parsed input, turning a mismatch into `Invalid`. */
function withDependents(
  obj: CrmObject,
  input: RecordValues,
  previous?: CrmRecord,
): Effect.Effect<RecordValues, Invalid> {
  // Values are only compared and copied there, so a stored record and checked input mix.
  const { values, issues } = reconcileDependents<unknown>(obj.fields, input, previous)
  return issues.length > 0
    ? Effect.fail(
        new Invalid({
          message: issuesMessage(issues.map((i) => ({ path: [i.field], message: i.message }))),
        }),
      )
    : Effect.succeed(values)
}

export const createRecord = Effect.fn('records.createRecord')(function* (
  objectKey: string,
  data: RecordInput,
  actorId: string,
) {
  const obj = getObject(objectKey)
  const input = yield* parseInput(objectKey, data)

  // Apply config defaults for fields the caller left empty. Selects that depend on
  // another field are settled afterwards, once that field has its value.
  for (const [key, field] of Object.entries(obj.fields)) {
    if (field.type === 'select' && field.dependsOn) {
      continue
    }

    if (
      'default' in field &&
      field.default !== undefined &&
      (input[key] === null || input[key] === undefined)
    ) {
      input[key] = field.default
    }
  }

  const { values: columns, changes } = splitLinks(objectKey, input)
  const values = yield* withDependents(obj, columns)
  const store = yield* Store

  const insert = store.insert(objectTable(objectKey), { ...values, createdBy: actorId })
  const linked = changes.filter(({ change }) => !('set' in change) || change.set.length > 0)

  if (linked.length === 0) {
    return yield* withItsLinks(objectKey, yield* insert)
  }

  // The record and its links: all of it is kept, or none.
  const record = yield* store.transaction(
    Effect.gen(function* () {
      const made = yield* insert

      for (const { field, change } of linked) {
        yield* writeLinks(objectKey, made.id, field, change)
      }

      return made
    }),
  )

  return yield* withItsLinks(objectKey, record)
})

/**
 * Change a record, and say what became of its relations fields: `links` has an
 * entry for each one the change named, with the records it linked and let go
 * (for the timeline). Null when there is no such record.
 */
export const changeRecord = Effect.fn('records.changeRecord')(function* (
  objectKey: string,
  id: string,
  data: RecordInput,
) {
  const obj = getObject(objectKey)
  const table = objectTable(objectKey)
  const store = yield* Store
  const parsed = splitLinks(objectKey, yield* parseInput(objectKey, data, true))
  let input = parsed.values

  const change = Effect.gen(function* () {
    if (touchesDependents(obj.fields, Object.keys(input))) {
      const previous = yield* store.first(table, { where: { id } })

      if (!previous) {
        return null
      }

      input = yield* withDependents(obj, input, previous)
    }

    // A change to its links is a change to the record: `updatedAt` moves either way.
    if ((yield* store.update(table, { where: { id } }, input)) === 0) {
      return null
    }

    const links: LinksChanged[] = []

    for (const { field, change: wanted } of parsed.changes) {
      links.push(yield* writeLinks(objectKey, id, field, wanted))
    }

    const [record] = yield* withLinks(
      objectKey,
      yield* store.find(table, { where: { id }, limit: 1 }),
    )

    return record ? { record, links } : null
  })

  // The columns and the links: all of the change is kept, or none.
  return yield* parsed.changes.length > 0 ? store.transaction(change) : change
})

export const updateRecord = Effect.fn('records.updateRecord')(function* (
  objectKey: string,
  id: string,
  data: RecordInput,
) {
  return (yield* changeRecord(objectKey, id, data))?.record ?? null
})

/**
 * Holds a record until the transaction this is called in ends, and says whether
 * it exists. Two changes to one record then happen one after the other.
 *
 * Given the values about to be written (`data`), it also holds every record
 * their relations fields name, at the other end of each link. All of them are
 * taken in one order, whichever record the change is to: object by object in
 * the order of their tables' names, and within a table by id. A tag added to a
 * person and that person added to the tag, at the same moment, then wait for
 * each other in turn. Held any other way (each change its own record first)
 * they would each wait for the other for ever, and the database would end one.
 */
export const holdRecord = Effect.fn('records.holdRecord')(function* (
  objectKey: string,
  id: string,
  data: RecordInput = {},
) {
  const store = yield* Store
  const wanted = new Map<string, Set<string>>([[objectKey, new Set([id])]])

  for (const { key, side } of linkFields(objectKey)) {
    const field = getObject(objectKey).fields[key]
    const sent = data[idsKey(key)]

    // What can't be read is refused when the change is checked (`changeRecord`); nothing is held for it.
    const change =
      field && sent !== undefined
        ? linksChangeSchema.safeParse(fieldInputSchema(field).safeParse(sent).data).data
        : undefined

    if (change) {
      const ids = wanted.get(side.to) ?? new Set<string>()
      wanted.set(side.to, ids)

      for (const other of 'set' in change ? change.set : [...change.add, ...change.remove]) {
        ids.add(other)
      }
    }
  }

  const tables = [...wanted]
    .map(([key, ids]) => ({ table: objectTable(key), ids: [...ids] }))
    .toSorted((a, b) => (a.table.name < b.table.name ? -1 : a.table.name > b.table.name ? 1 : 0))

  for (const { table, ids } of tables) {
    // One statement holds a table's rows in the order of their ids (`lock`).
    yield* store.lock(table, { filter: oneOf('id', ids) })
  }

  // Held already, if it is there: this only asks whether it is.
  return (yield* store.lock(objectTable(objectKey), { where: { id } })) > 0
})

export const deleteRecord = Effect.fn('records.deleteRecord')(function* (
  objectKey: string,
  id: string,
) {
  const store = yield* Store
  // Its links first, on every links table it has an end in. (The foreign keys would delete them too.)
  yield* removeLinks(objectKey, id)
  yield* store.remove(objectTable(objectKey), { where: { id } })
  // Activities aren't foreign-keyed (they span every object), so clear them explicitly.
  yield* store.remove(Activity, { where: { objectKey, recordId: id } })
  // Forget which folder was the record's. The folder and its files stay in the file store (see files.ts).
  yield* store.remove(RecordFolder, { where: { objectKey, recordId: id } })
})

export type TitleOption = { id: string; title: string }

/** How many titles a relation picker is given at a time. */
export const TITLE_PAGE = 50

/**
 * One page of an object's records for a relation picker: id and title, in title
 * order. `q` narrows it the way the list search does (every `searchable` field),
 * and always by the title itself. `more` says the page is not everything that
 * matches, so the picker can ask for a narrower search instead of pretending
 * the list is complete.
 */
export const searchTitles = Effect.fn('records.searchTitles')(function* (
  objectKey: string,
  q = '',
  limit = TITLE_PAGE,
) {
  const obj = getObject(objectKey)
  const title = obj.fields[obj.titleField]
  const fields = new Set(searchableFields(obj))

  if (title && isTextLike(title.type)) {
    fields.add(obj.titleField)
  }

  const size = Math.max(1, Math.min(limit, 100))
  const store = yield* Store

  const rows = yield* store.find(objectTable(objectKey), {
    filter: matchingText(obj, [...fields], q),
    select: ['id', obj.titleField],
    order: [asc(obj.titleField)],
    limit: size + 1,
  })

  return {
    options: rows
      .slice(0, size)
      .map((r): TitleOption => ({ id: r.id, title: valueText(r[obj.titleField] ?? 'Untitled') })),
    more: rows.length > size,
  }
})

/**
 * The records of an object that a CSV import's relation cells name: by id, or by
 * title the way `titleKey` compares them (case, spaces and punctuation ignored).
 * Reads every title of the object, a page at a time, so a record is found
 * however many there are.
 */
export const matchTitles = Effect.fn('records.matchTitles')(function* (
  objectKey: string,
  values: string[],
  page = 1000,
) {
  const obj = getObject(objectKey)
  const store = yield* Store
  const ids = new Set(values)
  const keys = new Set(values.map(titleKey))
  const found: TitleOption[] = []

  for (let offset = 0; ; offset += page) {
    const rows = yield* store.find(objectTable(objectKey), {
      select: ['id', obj.titleField],
      order: [asc('id')],
      limit: page,
      offset,
    })

    for (const r of rows) {
      const title = valueText(r[obj.titleField] ?? '')

      if (ids.has(r.id) || keys.has(titleKey(title))) {
        found.push({ id: r.id, title })
      }
    }

    if (rows.length < page) {
      return found
    }
  }
})

export const countRecords = Effect.fn('records.countRecords')(function* () {
  const store = yield* Store

  const entries = yield* Effect.forEach(
    Object.keys(crmConfig().objects),
    (key) => Effect.map(store.count(objectTable(key)), (n) => [key, n] as const),
    { concurrency: 'unbounded' },
  )

  return Object.fromEntries(entries)
})

// ── Activities ──────────────────────────────────────────────────────────────

export type ActivityInput = {
  objectKey: string
  recordId: string
  kind: string
  summary: string
  body?: string | null
  /** The name shown on the timeline. */
  actor?: string | null
  /** The teammate behind it, when a person did this. Per-person reports group by it. */
  actorId?: string | null
  /** When it happened, if not now (a call logged afterwards). */
  occurredAt?: Date | null
  outcome?: string | null
  /** Where a synced activity came from (an email's Message-ID, a calendar event). */
  externalId?: string | null
}

export const addActivity = Effect.fn('records.addActivity')(function* (a: ActivityInput) {
  const store = yield* Store
  const activity = yield* store.insert(Activity, a)

  if (ACTIVITY_KINDS.some((kind) => kind === a.kind)) {
    yield* refreshStats(a.objectKey, a.recordId)
  }

  return activity
})

/**
 * Work out a record's "last activity", "last contacted" and "next task due"
 * from its activities and open tasks, and store them on the record so lists
 * can filter and sort by them. Runs after an activity or task is written;
 * without `recordId` it does every record of the object (a backfill).
 * It doesn't count as a change to the record: `updatedAt` stays as it was.
 */
export const refreshStats = Effect.fn('records.refreshStats')(function* (
  objectKey: string,
  recordId?: string,
) {
  if (!Object.hasOwn(crmConfig().objects, objectKey)) {
    return
  }

  const store = yield* Store
  const kinds = { activity: ACTIVITY_KINDS, contact: CONTACT_KINDS }
  const run = store.refreshDates(objectTable(objectKey), objectKey, kinds, recordId)

  // Refreshing every record is a job someone ran on purpose: it must be seen to fail.
  if (recordId === undefined) {
    yield* run
    return
  }

  // For one record, the activity or task is already saved; a stale date is better than losing it.
  yield* run.pipe(
    Effect.catchTag('DatabaseError', (error) =>
      Effect.logError(`[records] could not refresh stats for ${objectKey}`, error.message),
    ),
  )
})

/**
 * Add an activity that came from somewhere else, unless this record already has
 * it. Returns false when it was already there, so a sync can run any number of
 * times, from any number of mailboxes, and log each email once.
 */
export const addActivityOnce = Effect.fn('records.addActivityOnce')(function* (
  a: ActivityInput & { externalId: string },
) {
  const { objectKey, recordId, externalId } = a
  const store = yield* Store
  const existing = store.first(Activity, { where: { objectKey, recordId, externalId } })

  if (yield* existing) {
    return false
  }

  return yield* addActivity(a).pipe(
    Effect.as(true),
    // Two syncs raced; the unique index kept one copy.
    Effect.catchTag('DatabaseError', (error) =>
      Effect.flatMap(existing, (found) => (found ? Effect.succeed(false) : Effect.fail(error))),
    ),
  )
})

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** The timeline line for an email. One wording, so the CRM's own entry and the mailbox's copy match. */
export const emailSummary = (direction: 'sent' | 'received', subject: string) =>
  `${direction} an email: ${clip(subject.trim() || '(no subject)', 200)}`

/** How close a mailbox's copy of an email must be to the CRM's own entry to count as the same one. */
const ADOPT_WINDOW_MS = 15 * 60 * 1000

/**
 * An email sent from the CRM through a teammate's mailbox is logged at once,
 * before the mailbox has given it an id. When the sync later meets that same
 * message in the mailbox, give the existing entry its id instead of logging the
 * email twice. Returns true when an entry was claimed.
 */
export const adoptSentEmail = Effect.fn('records.adoptSentEmail')(function* (a: {
  objectKey: string
  recordId: string
  actorId: string
  summary: string
  at: Date
  externalId: string
}) {
  const { objectKey, recordId, externalId } = a
  const store = yield* Store

  // Already claimed or logged on an earlier run.
  if (yield* store.first(Activity, { where: { objectKey, recordId, externalId } })) {
    return true
  }

  const candidates = yield* store.find(Activity, {
    where: {
      objectKey: a.objectKey,
      recordId: a.recordId,
      kind: 'email',
      actorId: a.actorId,
      outcome: 'sent',
      externalId: null,
    },
    order: [desc('createdAt')],
    limit: 20,
  })

  const match = candidates.find(
    (c) =>
      c.summary === a.summary &&
      Math.abs((c.occurredAt ?? c.createdAt).getTime() - a.at.getTime()) <= ADOPT_WINDOW_MS,
  )

  if (!match) {
    return false
  }

  yield* store.update(Activity, { where: { id: match.id } }, { externalId: a.externalId })
  return true
})

export const listActivities = Effect.fn('records.listActivities')(function* (
  objectKey: string,
  recordId: string,
) {
  const store = yield* Store
  return yield* store.find(Activity, {
    where: { objectKey, recordId },
    order: [desc('createdAt')],
    limit: 100,
  })
})

export const recentActivities = Effect.fn('records.recentActivities')(function* (limit = 20) {
  const store = yield* Store
  return yield* store.find(Activity, { order: [desc('createdAt')], limit })
})
