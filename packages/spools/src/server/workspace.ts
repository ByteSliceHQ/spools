import { Effect } from 'effect'

import {
  activityTable,
  type DateRange,
  type LoggableKind,
  logSummary,
  type PersonActivity,
  summariseActivity,
} from '../crm/activity'
import type { Filters, Sort } from '../crm/filters'
import { hasProbabilities, weighted } from '../crm/options'
import {
  addActivity,
  type CrmValue,
  listRecords,
  recordTitlesOf,
  refreshStats,
  relatedRecord,
  valueText,
} from './records'
import type { DatabaseError, ScopeRefused, Timeout } from './runtime/errors'
import { crmConfig, getObject } from './spool'
import { and, asc, desc, gte, isNull, lt, oneOf, or } from './store/query'
import { Store } from './store/store'
import { Activity, Favorite, Note, Task } from './store/tables'

/**
 * Workspace features that sit beside records: tasks, notes, favourites, reports
 * and CSV import/export. All server-only; exposed through workspace.functions.ts.
 */

type RecordRef = { objectKey: string | null; recordId: string | null }

/** Look up titles for a set of record references: one query per object, however many records. */
export const recordTitles = Effect.fn('workspace.recordTitles')(function* (refs: RecordRef[]) {
  const byObject = new Map<string, string[]>()

  for (const r of refs) {
    if (r.objectKey && r.recordId && Object.hasOwn(crmConfig().objects, r.objectKey)) {
      const ids = byObject.get(r.objectKey) ?? []
      ids.push(r.recordId)
      byObject.set(r.objectKey, ids)
    }
  }

  const titles: Record<string, string> = {}

  yield* Effect.forEach(
    [...byObject.entries()],
    ([objectKey, ids]) =>
      Effect.map(recordTitlesOf(objectKey, ids), (found) => {
        for (const [id, title] of found) {
          titles[`${objectKey}:${id}`] = title
        }
      }),
    { concurrency: 'unbounded', discard: true },
  )

  return titles
})

// ── Tasks ───────────────────────────────────────────────────────────────────

export type TaskInput = {
  title: string
  dueDate?: string | null
  assigneeId?: string | null
  objectKey?: string | null
  recordId?: string | null
}

export const listTasks = Effect.fn('workspace.listTasks')(function* (
  filter: { assigneeId?: string; objectKey?: string; recordId?: string } = {},
) {
  const store = yield* Store
  const onRecord = Boolean(filter.objectKey && filter.recordId)

  const tasks = yield* store.find(Task, {
    // A column left undefined is not a condition.
    where: {
      assigneeId: filter.assigneeId || undefined,
      objectKey: onRecord ? filter.objectKey : undefined,
      recordId: onRecord ? filter.recordId : undefined,
    },
    order: [desc('createdAt')],
    limit: 500,
  })

  const titles = yield* recordTitles(tasks)
  return tasks.map((t) => ({
    ...t,
    recordTitle:
      t.objectKey && t.recordId ? (titles[`${t.objectKey}:${t.recordId}`] ?? null) : null,
  }))
})

/** A task changed: the record it is on shows a different "next task due". */
const taskChanged = (
  task: { objectKey?: string | null; recordId?: string | null } | null | undefined,
) => (task?.objectKey && task.recordId ? refreshStats(task.objectKey, task.recordId) : Effect.void)

export const createTask = Effect.fn('workspace.createTask')(function* (
  input: TaskInput,
  userId: string,
) {
  const store = yield* Store

  const task = yield* store.insert(Task, {
    title: input.title,
    dueDate: input.dueDate ?? null,
    assigneeId: input.assigneeId ?? userId,
    objectKey: input.objectKey ?? null,
    recordId: input.recordId ?? null,
    createdBy: userId,
  })

  yield* taskChanged(task)
  return task
})

/** `userId` is whoever made the change; it is recorded as the person who completed the task. */
export const updateTask = Effect.fn('workspace.updateTask')(function* (
  id: string,
  patch: Partial<TaskInput> & { completed?: boolean },
  userId?: string,
) {
  const { completed, ...fields } = patch
  const store = yield* Store
  const before = yield* store.first(Task, { where: { id } })

  // Only a change to `completed` touches when the task was completed, and by whom.
  const changes =
    completed === undefined
      ? fields
      : {
          ...fields,
          completedAt: completed ? new Date() : null,
          completedBy: completed ? (userId ?? null) : null,
        }

  yield* store.update(Task, { where: { id } }, changes)

  const task = yield* store.first(Task, { where: { id } })
  yield* taskChanged(task)

  // Moved to another record: the one it left has a different "next task due" too.
  if (before && (before.recordId !== task?.recordId || before.objectKey !== task?.objectKey)) {
    yield* taskChanged(before)
  }

  return task
})

export const deleteTask = Effect.fn('workspace.deleteTask')(function* (id: string) {
  const store = yield* Store
  const task = yield* store.first(Task, { where: { id } })
  yield* store.remove(Task, { where: { id } })
  yield* taskChanged(task)
})

/** Open tasks assigned to a user that are due today or overdue (the sidebar badge). */
export const dueTaskCount = Effect.fn('workspace.dueTaskCount')(function* (userId: string) {
  const today = new Date().toISOString().slice(0, 10)
  const store = yield* Store

  const open = yield* store.find(Task, {
    where: { assigneeId: userId, completedAt: null },
    limit: 500,
  })

  return open.filter((t) => t.dueDate && t.dueDate <= today).length
})

// ── Notes ───────────────────────────────────────────────────────────────────

export type NoteInput = {
  title: string
  body: string
  objectKey?: string | null
  recordId?: string | null
}

export const listNotes = Effect.fn('workspace.listNotes')(function* (
  filter: { objectKey?: string; recordId?: string } = {},
) {
  const store = yield* Store

  const notes = yield* store.find(Note, {
    where:
      filter.objectKey && filter.recordId
        ? { objectKey: filter.objectKey, recordId: filter.recordId }
        : undefined,
    order: [desc('updatedAt')],
    limit: 200,
  })

  const titles = yield* recordTitles(notes)
  return notes.map((n) => ({
    ...n,
    recordTitle:
      n.objectKey && n.recordId ? (titles[`${n.objectKey}:${n.recordId}`] ?? null) : null,
  }))
})

export const createNote = Effect.fn('workspace.createNote')(function* (
  input: NoteInput,
  author: { id: string; name: string },
) {
  const store = yield* Store
  return yield* store.insert(Note, {
    title: input.title || 'Untitled note',
    body: input.body,
    objectKey: input.objectKey ?? null,
    recordId: input.recordId ?? null,
    authorId: author.id,
    authorName: author.name,
  })
})

export const updateNote = Effect.fn('workspace.updateNote')(function* (
  id: string,
  patch: { title?: string; body?: string },
) {
  const store = yield* Store
  yield* store.update(Note, { where: { id } }, patch)
  return yield* store.first(Note, { where: { id } })
})

export const deleteNote = Effect.fn('workspace.deleteNote')(function* (id: string) {
  const store = yield* Store
  yield* store.remove(Note, { where: { id } })
})

// ── Favourites ──────────────────────────────────────────────────────────────

export const listFavorites = Effect.fn('workspace.listFavorites')(function* (userId: string) {
  const store = yield* Store

  const rows = yield* store.find(Favorite, {
    where: { userId },
    order: [asc('createdAt')],
    limit: 50,
  })

  const titles = yield* recordTitles(rows)
  return rows.flatMap((f) => {
    const title = titles[`${f.objectKey}:${f.recordId}`]
    return title ? [{ objectKey: f.objectKey, recordId: f.recordId, title }] : []
  })
})

export const isFavorite = Effect.fn('workspace.isFavorite')(function* (
  userId: string,
  objectKey: string,
  recordId: string,
) {
  const store = yield* Store
  return (yield* store.count(Favorite, { where: { userId, objectKey, recordId } })) > 0
})

export const toggleFavorite = Effect.fn('workspace.toggleFavorite')(function* (
  userId: string,
  objectKey: string,
  recordId: string,
) {
  const store = yield* Store
  const existing = yield* store.first(Favorite, { where: { userId, objectKey, recordId } })

  if (existing) {
    yield* store.remove(Favorite, { where: { id: existing.id } })
    return false
  }

  yield* store.insert(Favorite, { userId, objectKey, recordId })
  return true
})

// ── Logged activities ───────────────────────────────────────────────────────

export type LogActivityInput = {
  objectKey: string
  recordId: string
  kind: LoggableKind
  outcome?: string | null
  /** When the call or meeting took place. Defaults to now. */
  occurredAt?: Date | null
  notes?: string | null
}

/** Put a call or meeting on a record's timeline, credited to the teammate who logged it. */
export const logActivity = (input: LogActivityInput, user: { id: string; name: string }) =>
  addActivity({
    objectKey: input.objectKey,
    recordId: input.recordId,
    kind: input.kind,
    summary: logSummary(input.kind, input.outcome),
    body: input.notes?.trim() || null,
    actor: user.name,
    actorId: user.id,
    occurredAt: input.occurredAt ?? new Date(),
    outcome: input.outcome ?? null,
  })

const ACTIVITY_REPORT_LIMIT = 20_000

/** Every row of a query, a page at a time, up to the report limit. */
const drain = <T>(
  page: (paging: {
    limit: number
    offset: number
  }) => Effect.Effect<T[], DatabaseError | Timeout | ScopeRefused>,
) =>
  Effect.gen(function* () {
    const rows: T[] = []

    for (let offset = 0; offset < ACTIVITY_REPORT_LIMIT; offset += 1000) {
      const batch = yield* page({ limit: 1000, offset })
      rows.push(...batch)

      if (batch.length < 1000) {
        break
      }
    }

    return rows
  })

export type ActivityReport = { rows: PersonActivity[]; truncated: boolean }

/**
 * Calls, emails, meetings, completed tasks and notes per person between two
 * moments. A logged call or meeting counts on the day it took place, not the
 * day it was entered.
 */
export const activityReport = Effect.fn('workspace.activityReport')(function* (
  range: DateRange,
  users: { id: string; name: string }[],
) {
  const within = (column: string) => and(gte(column, range.from), lt(column, range.to))
  const store = yield* Store

  const [activities, tasks, notes] = yield* Effect.all(
    [
      drain((paging) =>
        store.find(Activity, {
          filter: and(
            oneOf('kind', ['call', 'meeting', 'email']),
            or(within('occurredAt'), and(isNull('occurredAt'), within('createdAt'))),
          ),
          // The id settles ties, so no row is read twice or missed between pages.
          order: [asc('createdAt'), asc('id')],
          ...paging,
        }),
      ),
      drain((paging) =>
        store.find(Task, {
          filter: within('completedAt'),
          order: [asc('createdAt'), asc('id')],
          ...paging,
        }),
      ),
      drain((paging) =>
        store.find(Note, {
          filter: within('createdAt'),
          order: [asc('createdAt'), asc('id')],
          ...paging,
        }),
      ),
    ],
    { concurrency: 'unbounded' },
  )

  const report: ActivityReport = {
    rows: summariseActivity({ users, activities, tasks, notes }),
    truncated: [activities, tasks, notes].some((list) => list.length >= ACTIVITY_REPORT_LIMIT),
  }

  return report
})

/** The activity report as CSV, one line per person and a totals line. */
export function activityReportCsv(report: ActivityReport): string {
  return activityTable(report.rows)
    .map((line) => line.map(csvCell).join(','))
    .join('\n')
}

// ── Reports ─────────────────────────────────────────────────────────────────

export type Breakdown = {
  objectKey: string
  field: string
  /** A currency field summed per option, when the object has one. */
  valueField: string | null
  /** True when the field's options carry win probabilities, so `weighted` means something. */
  weighted: boolean
  rows: {
    value: string
    label: string
    color?: string
    count: number
    total: number
    weighted: number
  }[]
}

const REPORT_ROW_LIMIT = 5000

const allRows = Effect.fn('workspace.allRows')(function* (objectKey: string) {
  const rows = []

  for (let offset = 0; offset < REPORT_ROW_LIMIT; offset += 500) {
    // Reports read each row's own columns only.
    const page = yield* listRecords({ objectKey, limit: 500, offset, relations: 'none' })
    rows.push(...page)

    if (page.length < 500) {
      break
    }
  }

  return rows
})

/** The Monday that starts a date's week, as YYYY-MM-DD in UTC. */
const weekStart = (d: Date) => {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}

/** One breakdown per select field, plus records created per week, for every object. */
export const buildReports = Effect.fn('workspace.buildReports')(function* () {
  const breakdowns: Breakdown[] = []
  const created: { objectKey: string; weeks: { week: string; count: number }[] }[] = []

  for (const [objectKey, obj] of Object.entries(crmConfig().objects)) {
    const rows = yield* allRows(objectKey)

    const valueField =
      Object.keys(obj.fields).find((k) => obj.fields[k]?.type === 'currency') ?? null

    for (const [field, def] of Object.entries(obj.fields)) {
      if (def.type !== 'select') {
        continue
      }

      breakdowns.push({
        objectKey,
        field,
        valueField,
        weighted: valueField !== null && hasProbabilities(def),
        rows: def.options.map((o) => {
          const matching = rows.filter((r) => r[field] === o.value)

          const total = valueField
            ? matching.reduce((sum, r) => sum + (Number(r[valueField]) || 0), 0)
            : 0

          return {
            value: o.value,
            label: o.label ?? o.value,
            color: o.color,
            count: matching.length,
            total,
            weighted: weighted(total, o),
          }
        }),
      })
    }

    const weeks = new Map<string, number>()
    const now = new Date()

    for (let i = 11; i >= 0; i--) {
      weeks.set(weekStart(new Date(now.getTime() - i * 7 * 86_400_000)), 0)
    }

    for (const r of rows) {
      const week = weekStart(new Date(r.createdAt))

      if (weeks.has(week)) {
        weeks.set(week, (weeks.get(week) ?? 0) + 1)
      }
    }

    created.push({
      objectKey,
      weeks: [...weeks.entries()].map(([week, count]) => ({ week, count })),
    })
  }

  return { breakdowns, created }
})

// ── CSV ─────────────────────────────────────────────────────────────────────

function csvCell(value: CrmValue): string {
  if (value === null || value === undefined) {
    return ''
  }

  const text = value instanceof Date ? value.toISOString() : valueText(value)
  // Neutralise spreadsheet formulas, then quote anything with separators.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** CSV of every record matching a query (up to 10,000). Relations export as the related title. */
export const exportCsv = Effect.fn('workspace.exportCsv')(function* (
  objectKey: string,
  filter: { q?: string; filters?: Filters; sort?: Sort[]; viewerId?: string },
) {
  const obj = getObject(objectKey)
  const keys = Object.keys(obj.fields)
  const lines = [['id', ...keys].map(csvCell).join(',')]

  for (let offset = 0; offset < 10_000; offset += 500) {
    const page = yield* listRecords({
      objectKey,
      ...filter,
      limit: 500,
      offset,
      relations: 'titles',
    })

    for (const r of page) {
      lines.push(
        [
          r.id,
          ...keys.map((k) => {
            const field = obj.fields[k]
            const value = r[k]
            const related = field?.type === 'relation' ? relatedRecord(value) : undefined

            if (field?.type === 'relation' && related) {
              return related[getObject(field.to).titleField]
            }

            return value
          }),
        ]
          .map(csvCell)
          .join(','),
      )
    }

    if (page.length < 500) {
      break
    }
  }

  return lines.join('\n')
})
