import { Effect } from 'effect'

import type { CrmObject } from '../crm/config-schema'
import type { CrmField } from '../crm/field-types'
import {
  type DeepHit,
  fold,
  INDEX_LIMIT,
  type IndexRow,
  type NoteRow,
  type QuickIndex,
  snippet,
  terms,
} from '../crm/search'
import { type CrmRecord, matchingText, relatedField, searchableFields, valueText } from './records'
import { crmConfig, getObject, objectTable } from './spool'
import { and, contains, desc, gt, oneOf, search as searchText } from './store/query'
import { Store } from './store/store'
import { Activity, Note, SavedView, Task } from './store/tables'
import { recordTitles } from './workspace'

/**
 * Search across the whole CRM. Two halves:
 *
 * - `quickIndex`: every record's title and searchable fields, sent to the
 *   browser once so it can match as each key is pressed (src/crm/search.ts).
 * - `deepSearch`: what the browser can't do from that: fields it isn't given,
 *   and the text of notes, emails, calls, meetings and tasks.
 */

// ── The browser's index ─────────────────────────────────────────────────────

/**
 * Fields whose values are sent to the browser to be matched there. Encrypted
 * ones never are, and nor is long text, which would make the index as large as
 * the notes people write; the server searches both.
 */
const indexedFields = (obj: CrmObject): string[] =>
  searchableFields(obj).filter((k) => {
    const field = obj.fields[k]
    return k !== obj.titleField && !field?.encrypted && field?.type !== 'longtext'
  })

/** A field short enough to show on a result's second line. */
const isShort = (f: CrmField | undefined) =>
  f && !f.encrypted && (f.type === 'select' || f.type === 'relation' || f.type === 'text')

/**
 * The fields that make up a record's second line in results, which tells two
 * records of the same name apart: the first few short columns of its table view.
 */
function summaryFields(obj: CrmObject): string[] {
  const view = obj.views.find((v) => v.type === 'table') ?? obj.views[0]
  const shown = view?.type === 'table' ? view.columns : (view?.cardFields ?? [])
  return shown.filter((k) => k !== obj.titleField && isShort(obj.fields[k])).slice(0, 2)
}

function summaryOf(obj: CrmObject, row: CrmRecord, fields: string[]): string {
  const parts = fields.map((key) => {
    const field = obj.fields[key]
    const value = row[key]

    if (value === null || value === undefined || value === '') {
      return ''
    }

    if (field?.type === 'select') {
      return field.options.find((o) => o.value === value)?.label ?? valueText(value)
    }

    if (field?.type === 'relation') {
      return valueText(relatedField(value, getObject(field.to).titleField) ?? '')
    }

    return valueText(value)
  })

  return parts.filter(Boolean).join(' · ')
}

const indexObject = Effect.fn('search.indexObject')(function* (
  objectKey: string,
  since: Date | undefined,
) {
  const obj = getObject(objectKey)
  const fields = indexedFields(obj)
  const summary = summaryFields(obj)
  const own = summary.flatMap((k) => (obj.fields[k]?.type === 'relation' ? [`${k}Id`] : [k]))
  const store = yield* Store
  const table = objectTable(objectKey)

  const [rows, total] = yield* Effect.all(
    [
      store.find(table, {
        select: [...new Set(['id', obj.titleField, ...fields, ...own])],
        include: Object.fromEntries(
          summary.flatMap((key) => {
            const field = obj.fields[key]
            return field?.type === 'relation' ? [[key, [getObject(field.to).titleField]]] : []
          }),
        ),
        filter: since && gt('updatedAt', since),
        order: [desc('updatedAt')],
        limit: INDEX_LIMIT,
      }),
      store.count(table),
    ],
    { concurrency: 2 },
  )

  const entry: QuickIndex['objects'][string] = {
    fields,
    total,
    rows: rows.map((r): IndexRow => [
      r.id,
      valueText(r[obj.titleField] ?? 'Untitled'),
      summaryOf(obj, r, summary),
      ...fields.map((f) => {
        const value = r[f]
        return value === null || value === undefined ? null : valueText(value)
      }),
    ]),
  }

  return entry
})

/**
 * What the browser searches without asking: each record's id, title, summary
 * line and unencrypted searchable fields, and each note's title. With `since`,
 * only what changed after that moment (and every object's count, so the
 * browser can tell when something was deleted).
 */
export const quickIndex = Effect.fn('search.quickIndex')(function* (since?: Date, userId?: string) {
  // A moment earlier than the read: a change that lands while it runs is picked up next time.
  const at = new Date(Date.now() - 2000).toISOString()
  const keys = Object.keys(crmConfig().objects)
  const store = yield* Store

  const [objects, notes, noteCount, saved] = yield* Effect.all(
    [
      Effect.forEach(
        keys,
        (key) => Effect.map(indexObject(key, since), (entry) => [key, entry] as const),
        { concurrency: 'unbounded' },
      ),
      store.find(Note, {
        select: ['id', 'title', 'objectKey', 'recordId'],
        filter: since && gt('updatedAt', since),
        order: [desc('updatedAt')],
        limit: INDEX_LIMIT,
      }),
      store.count(Note),
      store.find(SavedView, { where: { key: null }, limit: 500 }),
    ],
    { concurrency: 'unbounded' },
  )

  const mine = (settings: string, createdBy: string | null) =>
    !/"private":true/.test(settings) || (userId !== undefined && createdBy === userId)

  const index: QuickIndex = {
    at,
    views: saved
      .filter(
        (v) => Object.hasOwn(crmConfig().objects, v.objectKey) && mine(v.settings, v.createdBy),
      )
      .map((v) => ({ id: v.id, label: v.label, objectKey: v.objectKey })),
    objects: Object.fromEntries(objects),
    notes: {
      rows: notes.map((n): NoteRow => [n.id, n.title, n.objectKey, n.recordId]),
      total: noteCount,
    },
  }

  return index
})

// ── What the server searches ────────────────────────────────────────────────

const PER_KIND = 6

/** Records matched on any searchable field, including the ones the browser's index leaves out. */
const searchRecords = Effect.fn('search.searchRecords')(function* (objectKey: string, q: string) {
  const obj = getObject(objectKey)

  const fields = [...new Set([obj.titleField, ...searchableFields(obj)])].filter(
    (k) => obj.fields[k] && obj.fields[k].type !== 'relation',
  )

  if (fields.length === 0) {
    const none: DeepHit[] = []
    return none
  }

  const store = yield* Store

  const rows = yield* store.find(objectTable(objectKey), {
    select: ['id', ...fields],
    filter: matchingText(obj, fields, q),
    order: [desc('updatedAt')],
    limit: PER_KIND,
  })

  const words = terms(q)
  return rows.map((r): DeepHit => {
    const title = valueText(r[obj.titleField] ?? 'Untitled')
    // Say where the match was when the title alone doesn't show it.
    const inTitle = words.every((w) => fold(title).includes(w))

    const field = inTitle
      ? undefined
      : fields.find(
          (f) => f !== obj.titleField && words.some((w) => fold(valueText(r[f] ?? '')).includes(w)),
        )

    const hit: DeepHit = { kind: 'record', id: r.id, title, objectKey, recordId: r.id }

    if (field) {
      hit.field = field
      hit.snippet = snippet(valueText(r[field] ?? ''), q)
    }

    return hit
  })
})

const CONTACT = ['email', 'call', 'meeting'] as const

const isContact = (kind: string): kind is (typeof CONTACT)[number] =>
  CONTACT.some((contact) => contact === kind)

/** "sent an email: Quartz samples" reads better in results as its subject. */
const subject = (summary: string) => summary.replace(/^(?:sent|received) an email: /, '')

/**
 * Everything that matches beyond the browser's index: records by their other
 * fields, and notes, emails, calls, meetings and tasks by their text. Notes
 * and activities are newest first, with a match in the title or subject ahead
 * of one in the body.
 */
export const deepSearch = Effect.fn('search.deepSearch')(function* (q: string) {
  const search = q.trim()

  if (!search) {
    const none: DeepHit[] = []
    return none
  }

  const words = terms(search)

  const titleFirst = <T extends { title: string }>(hits: T[]): T[] => {
    const inTitle = (h: T) => words.every((w) => fold(h.title).includes(w))
    return [...hits.filter(inTitle), ...hits.filter((h) => !inTitle(h))]
  }

  const store = yield* Store

  const [recordGroups, notes, activities, tasks] = yield* Effect.all(
    [
      Effect.forEach(Object.keys(crmConfig().objects), (key) => searchRecords(key, search), {
        concurrency: 'unbounded',
      }),
      store.find(Note, {
        select: ['id', 'title', 'body', 'objectKey', 'recordId', 'updatedAt'],
        filter: searchText(search),
        order: [desc('updatedAt')],
        limit: PER_KIND,
      }),
      store.find(Activity, {
        select: [
          'id',
          'kind',
          'summary',
          'body',
          'objectKey',
          'recordId',
          'createdAt',
          'occurredAt',
        ],
        filter: and(oneOf('kind', CONTACT), searchText(search)),
        // Newest first by when it happened. Ordering by the indexed created_at instead would
        // tempt Postgres to walk that index and test every row, rather than use the text index.
        order: [desc({ firstOf: ['occurredAt', 'createdAt'] })],
        limit: PER_KIND * 2,
      }),
      store.find(Task, {
        select: ['id', 'title', 'objectKey', 'recordId', 'completedAt', 'createdAt'],
        filter: and(...words.map((word) => contains('title', word))),
        order: [desc('createdAt')],
        limit: PER_KIND,
      }),
    ],
    { concurrency: 'unbounded' },
  )

  const titles = yield* recordTitles([...notes, ...activities, ...tasks])

  const on = (ref: { objectKey: string | null; recordId: string | null }) => ({
    objectKey: ref.objectKey,
    recordId: ref.recordId,
    recordTitle:
      ref.objectKey && ref.recordId ? (titles[`${ref.objectKey}:${ref.recordId}`] ?? null) : null,
  })

  const hits: DeepHit[] = [
    ...recordGroups.flat(),
    ...titleFirst(
      notes.map((n) => ({
        kind: 'note' as const,
        id: n.id,
        title: n.title,
        snippet: snippet(n.body, search),
        at: n.updatedAt.toISOString(),
        ...on(n),
      })),
    ),
    ...titleFirst(
      // Only contact kinds were asked for.
      activities.flatMap((a) => {
        const kind = a.kind

        if (!isContact(kind)) {
          return []
        }

        const hit: DeepHit = {
          kind,
          id: a.id,
          title: subject(a.summary),
          at: (a.occurredAt ?? a.createdAt).toISOString(),
          ...on(a),
        }

        if (a.body) {
          hit.snippet = snippet(a.body, search)
        }

        return [hit]
      }),
    ).slice(0, PER_KIND + 2),
    ...tasks.map((t) => ({
      kind: 'task' as const,
      id: t.id,
      title: t.title,
      at: t.createdAt.toISOString(),
      ...on(t),
    })),
  ]

  return hits
})

// ── Values to filter by ─────────────────────────────────────────────────────

export type ValueSuggestion = { field: string; value: string; count: number }

/**
 * Values of an object's short text fields that contain what was typed, with
 * how many records hold each: "west" → Town "Westport" (142). Only values
 * shared by several records are offered (a town, a vendor), not ones that
 * belong to a single record (an email address); search finds those. The
 * database does the counting, one grouped query per field.
 *
 * An encrypted field is left out unless its mode is `search`: finding the
 * values that contain some text is a question the other modes can't answer.
 */
export const suggestValues = Effect.fn('search.suggestValues')(function* (
  objectKey: string,
  q: string,
) {
  const obj = getObject(objectKey)
  const typed = fold(q.trim())

  if (typed.length < 2) {
    const none: ValueSuggestion[] = []
    return none
  }

  const short = new Set(['text', 'email', 'phone', 'url'])

  const fields = Object.entries(obj.fields)
    .filter(
      ([k, f]) =>
        k !== obj.titleField && short.has(f.type) && (!f.encrypted || f.encrypted === 'search'),
    )
    .map(([k]) => k)

  const store = yield* Store

  const perField = yield* Effect.forEach(
    fields,
    (field) =>
      Effect.map(
        store.countValues(objectTable(objectKey), field, {
          filter: contains(field, q.trim()),
          atLeast: 2,
        }),
        (groups) =>
          groups
            .map((g) => ({ field, ...g }))
            .filter((g) => g.value !== '')
            .toSorted((a, b) => b.count - a.count)
            .slice(0, 3),
      ),
    { concurrency: 'unbounded' },
  )

  // A value that starts with what was typed is likelier meant than one that merely contains it.
  const starts = (s: ValueSuggestion) => (fold(s.value).startsWith(typed) ? 0 : 1)
  return perField
    .flat()
    .toSorted((a, b) => starts(a) - starts(b) || b.count - a.count)
    .slice(0, 8)
})
