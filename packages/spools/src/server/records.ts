import { Effect } from 'effect'
import { z } from 'zod'

import type { CrmObject } from '../crm/config-schema'
import { titleKey } from '../crm/csv'
import { fieldInputSchema, isTextLike } from '../crm/field-types'
import {
  ACTIVITY_KINDS,
  CONTACT_KINDS,
  cleanSort,
  type Filters,
  fieldOf,
  type Sort,
} from '../crm/filters'
import { reconcileDependents, touchesDependents } from '../crm/options'
import { compileFilters, containsText } from './filter-query'
import { Invalid } from './runtime/errors'
import { crmConfig, getObject, objectTable } from './spool'
import type { CrmRecord, CrmValue } from './store/objects'
import {
  and,
  asc,
  desc,
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
    const k = field.type === 'relation' ? `${key}Id` : key
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
  /**
   * Bring back only these fields of each row (with its id and timestamps), for
   * views that show a few of them on many rows. Unknown keys are ignored.
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
  const own = wanted?.map((f) => (obj.fields[f]?.type === 'relation' ? `${f}Id` : f))
  const store = yield* Store
  return yield* store.find(objectTable(objectKey), {
    where: columns,
    filter: matches(objectKey, { q, filters, viewerId }),
    // Without a list of fields, every column comes back.
    select: own && [...new Set(['id', 'createdAt', 'updatedAt', ...own])],
    include: related(obj, relations, wanted),
    // The id settles ties, so paging never shows a record twice or skips one.
    order: [...order, asc('id')],
    limit: Math.min(limit, 500),
    offset,
  })
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

/** Records in other objects that point at this record through a relation field. */
export const relatedRecords = Effect.fn('records.relatedRecords')(function* (
  objectKey: string,
  id: string,
  limit = 25,
) {
  const pointers: { objectKey: string; field: string }[] = []

  for (const [otherKey, other] of Object.entries(crmConfig().objects)) {
    for (const [field, def] of Object.entries(other.fields)) {
      if (def.type === 'relation' && def.to === objectKey) {
        pointers.push({ objectKey: otherKey, field })
      }
    }
  }

  return yield* Effect.forEach(
    pointers,
    (p) =>
      Effect.map(
        listRecords({
          objectKey: p.objectKey,
          where: { [`${p.field}Id`]: id },
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
  return yield* store.first(objectTable(objectKey), {
    where: { id },
    include: related(getObject(objectKey)),
  })
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

  const values = yield* withDependents(obj, input)
  const store = yield* Store
  return yield* store.insert(objectTable(objectKey), { ...values, createdBy: actorId })
})

export const updateRecord = Effect.fn('records.updateRecord')(function* (
  objectKey: string,
  id: string,
  data: RecordInput,
) {
  const obj = getObject(objectKey)
  const table = objectTable(objectKey)
  const store = yield* Store
  let input = yield* parseInput(objectKey, data, true)

  if (touchesDependents(obj.fields, Object.keys(input))) {
    const previous = yield* store.first(table, { where: { id } })

    if (!previous) {
      return null
    }

    input = yield* withDependents(obj, input, previous)
  }

  yield* store.update(table, { where: { id } }, input)
  return yield* store.first(table, { where: { id } })
})

/**
 * Holds a record until the transaction this is called in ends, and says whether
 * it exists. Two changes to one record then happen one after the other.
 */
export const holdRecord = Effect.fn('records.holdRecord')(function* (
  objectKey: string,
  id: string,
) {
  const store = yield* Store
  return (yield* store.lock(objectTable(objectKey), { where: { id } })) > 0
})

export const deleteRecord = Effect.fn('records.deleteRecord')(function* (
  objectKey: string,
  id: string,
) {
  const store = yield* Store
  yield* store.remove(objectTable(objectKey), { where: { id } })
  // Activities aren't foreign-keyed (they span every object), so clear them explicitly.
  yield* store.remove(Activity, { where: { objectKey, recordId: id } })

  // Forget which folder was the record's. The folder and its files stay in the file store (see
  // files.ts). In a Spool with record scopes the row is kept: it is what says whose the folder
  // is, and without it the folder and its files would be everyone's.
  if (!crmConfig().scopes) {
    yield* store.remove(RecordFolder, { where: { objectKey, recordId: id } })
  }
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
