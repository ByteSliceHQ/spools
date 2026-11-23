import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'

import { LOGGABLE, loggableKinds } from '../crm/activity'
import { cleanFilters, relationIds } from '../crm/filters'
import { activeRuns, sequencesTick } from './campaigns'
import { textToHtml } from './email'
import { sendFromMailbox } from './mailbox'
import * as records from './records'
import { crmHandler } from './runtime/boundary'
import * as config from './runtime/config'
import { Email } from './runtime/email'
import { Invalid, NotFound } from './runtime/errors'
import * as service from './service'
import { crmConfig, getObject } from './spool'
import { Users } from './users'
import * as views from './views'
import * as workspace from './workspace'

/**
 * Server functions for everything beside plain record CRUD: views, tasks, notes,
 * favourites, reports, CSV and one-to-one email. Each checks the CRM session first.
 */

const objectKey = z.string().refine((k) => Object.hasOwn(crmConfig().objects, k), 'Unknown object')
const id = z.string().uuid()
const recordLink = { objectKey: objectKey.nullish(), recordId: id.nullish() }

// ── Lists and views ─────────────────────────────────────────────────────────

const filterValue = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])

const plainCondition = z.object({
  field: z.string(),
  op: z.string(),
  value: filterValue.optional(),
})

const condition = plainCondition.extend({ where: z.array(plainCondition).optional() })
/**
 * Filters and sort as the browser sends them: the shape only. What they may
 * be, and how many, is decided by `cleanFilters` and `cleanSort`, which trim
 * and drop rather than refuse, so an address someone edited by hand shows a
 * list instead of an error. The page address is what bounds their size.
 */
const filtersInput = z.array(z.array(condition))
const sortInput = z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }))
/** Search text, cut to a length worth searching for. */
const searchText = z.string().transform((q) => q.slice(0, 200))

/** What an email field must at least hold to be written to. */
const emailAddress = z.string()

/**
 * Everything a list page needs: the object's views, the active one, a page of
 * rows, counts and footer calculations. `filters` and `sort` are what the page
 * address carries when they differ from the saved view; without them the
 * view's own are used.
 */
export const getListFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      objectKey,
      viewId: z.string().optional(),
      q: searchText.optional(),
      // A page number nobody could mean is the first page, not an error.
      page: z.number().int().positive().max(10_000).catch(1).default(1),
      filters: filtersInput.optional(),
      sort: sortInput.optional(),
    }),
  )
  .handler(
    crmHandler('workspace.getList', ({ data, user }) =>
      Effect.gen(function* () {
        const all = yield* views.resolveViews(data.objectKey, user.id)
        const view = all.find((v) => v.id === data.viewId) ?? all[0]

        if (!view) {
          return yield* new NotFound({ what: 'View' })
        }

        const board = view.type === 'board'
        const pageSize = board ? 500 : 50
        const page = board ? 1 : data.page
        const { filters, sort } = views.activeSettings(data.objectKey, view, data)
        const query = { objectKey: data.objectKey, q: data.q, filters, viewerId: user.id }
        // A board puts up to 500 cards on the page and shows a few fields on each: fetch those and no more.
        const obj = getObject(data.objectKey)
        const totalled = Object.keys(obj.fields).find((k) => obj.fields[k]?.type === 'currency')

        const cardFields = board
          ? [obj.titleField, view.settings.groupBy, ...view.settings.cardFields, totalled].filter(
              (f) => f !== undefined,
            )
          : undefined

        // A filter on a relation holds the related records' ids; the page shows their titles.
        const named = Object.entries(relationIds(crmConfig().objects, data.objectKey, filters))

        const [rows, total, calculations, filterTitles] = yield* Effect.all(
          [
            records.listRecords({
              ...query,
              sort,
              limit: pageSize,
              offset: (page - 1) * pageSize,
              // A list shows a related record's title and links to it; it needs no more of it.
              relations: 'titles',
              fields: cardFields,
            }),
            records.countMatching(query),
            views.calculate(data.objectKey, query, view.settings.calculations),
            Effect.forEach(
              named,
              ([to, ids]) =>
                Effect.map(records.recordTitlesOf(to, ids), (found) => [to, found] as const),
              {
                concurrency: 'unbounded',
              },
            ),
          ],
          { concurrency: 'unbounded' },
        )

        const titles: Record<string, records.TitleOption[]> = {}

        for (const [to, found] of filterTitles) {
          titles[to] = [...found].map(([recordId, title]) => ({ id: recordId, title }))
        }

        return {
          views: all,
          view,
          /** The filters and sort in force: the view's, or the ones the page address carries. */
          active: { filters, sort },
          rows,
          total,
          hasMore: page * pageSize < total,
          calculations,
          titles,
        }
      }),
    ),
  )

const viewPatch = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  columns: z.array(z.string()).max(60).optional(),
  sort: sortInput.optional(),
  filters: filtersInput.optional(),
  groupBy: z.string().optional(),
  cardFields: z.array(z.string()).max(12).optional(),
  calculations: z
    .record(z.string(), z.enum(['sum', 'avg', 'min', 'max', 'filled', 'empty']))
    .optional(),
})

export const saveViewFn = createServerFn({ method: 'POST' })
  .validator(z.object({ objectKey, viewId: z.string(), patch: viewPatch }))
  .handler(
    crmHandler('workspace.saveView', ({ data, user }) =>
      Effect.gen(function* () {
        const { filters, ...rest } = data.patch
        // Filters left out of the patch keep the view's own.
        const patch: views.ViewPatch = { ...rest }

        if (filters) {
          patch.filters = cleanFilters(crmConfig().objects, data.objectKey, filters)
        }

        yield* views.saveView(data.objectKey, data.viewId, patch, user.id)

        return { ok: true }
      }),
    ),
  )

export const createViewFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      objectKey,
      label: z.string().trim().min(1).max(80),
      type: z.enum(['table', 'board']),
      copyFrom: z.string().optional(),
      /** The filters and sort on screen, to save with the new view. */
      filters: filtersInput.optional(),
      sort: sortInput.optional(),
      /** Only the person creating it will see it. */
      private: z.boolean().optional(),
    }),
  )
  .handler(
    crmHandler('workspace.createView', ({ data, user }) =>
      Effect.gen(function* () {
        const { filters, sort: sorted, ...input } = data

        // What isn't given is copied from the view it starts from.
        const settings: Partial<Pick<views.ViewSettings, 'filters' | 'sort'>> = {}

        if (filters) {
          settings.filters = cleanFilters(crmConfig().objects, data.objectKey, filters)
        }

        if (sorted) {
          settings.sort = sorted
        }

        return { id: yield* views.createView(data.objectKey, { ...input, settings }, user.id) }
      }),
    ),
  )

export const deleteViewFn = createServerFn({ method: 'POST' })
  .validator(z.object({ objectKey, viewId: z.string() }))
  .handler(
    crmHandler('workspace.deleteView', ({ data, user }) =>
      Effect.gen(function* () {
        yield* views.deleteView(data.objectKey, data.viewId, user.id)
        return { ok: true }
      }),
    ),
  )

// ── Import / export ─────────────────────────────────────────────────────────

export const exportCsvFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      objectKey,
      viewId: z.string().optional(),
      q: searchText.optional(),
      filters: filtersInput.optional(),
      sort: sortInput.optional(),
    }),
  )
  .handler(
    crmHandler('workspace.exportCsv', ({ data, user }) =>
      Effect.gen(function* () {
        const all = yield* views.resolveViews(data.objectKey, user.id)
        const view = all.find((v) => v.id === data.viewId) ?? all[0]

        if (!view) {
          return yield* new NotFound({ what: 'View' })
        }

        // What is on screen: the filters and sort in the page address when it carries them, else the view's.
        const { filters, sort: sorted } = views.activeSettings(data.objectKey, view, data)
        return {
          csv: yield* workspace.exportCsv(data.objectKey, {
            q: data.q,
            filters,
            sort: sorted,
            viewerId: user.id,
          }),
        }
      }),
    ),
  )

/**
 * The records of one object that an import's relation cells name, by title or
 * id. Matching happens here, against every record of the object, so the browser
 * needn't hold (and be limited to) a list of titles.
 */
export const matchRelationTitlesFn = createServerFn({ method: 'POST' })
  .validator(z.object({ objectKey, values: z.array(z.string().max(2000)).min(1).max(1000) }))
  .handler(
    crmHandler('workspace.matchRelationTitles', ({ data }) =>
      records.matchTitles(data.objectKey, data.values),
    ),
  )

/** Create records from parsed CSV rows: `service.importRecords`. */
export const importRecordsFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      objectKey,
      rows: z
        .array(z.record(z.string().max(60), z.string().max(20_000)))
        .min(1)
        .max(1000),
    }),
  )
  .handler(
    crmHandler('workspace.importRecords', ({ data, user }) =>
      service.importRecords(data.objectKey, data.rows, user),
    ),
  )

// ── Tasks ───────────────────────────────────────────────────────────────────

const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()

export const listTasksFn = createServerFn({ method: 'GET' })
  .validator(z.object({ scope: z.enum(['mine', 'all']).default('mine'), ...recordLink }))
  .handler(
    crmHandler('workspace.listTasks', ({ data, user }) =>
      workspace.listTasks({
        assigneeId: data.scope === 'mine' && !data.recordId ? user.id : undefined,
        objectKey: data.objectKey ?? undefined,
        recordId: data.recordId ?? undefined,
      }),
    ),
  )

export const createTaskFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      title: z.string().trim().min(1).max(500),
      dueDate,
      assigneeId: z.string().max(200).nullish(),
      ...recordLink,
    }),
  )
  .handler(
    crmHandler('workspace.createTask', ({ data, user }) =>
      Effect.gen(function* () {
        const task = yield* workspace.createTask(data, user.id)

        if (data.objectKey && data.recordId) {
          yield* records.addActivity({
            objectKey: data.objectKey,
            recordId: data.recordId,
            kind: 'task',
            summary: `added a task: ${data.title}`,
            actor: user.name,
            actorId: user.id,
          })
        }

        return { id: task.id }
      }),
    ),
  )

export const updateTaskFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id,
      title: z.string().trim().min(1).max(500).optional(),
      dueDate,
      assigneeId: z.string().max(200).nullish(),
      completed: z.boolean().optional(),
    }),
  )
  .handler(
    crmHandler('workspace.updateTask', ({ data, user }) =>
      Effect.gen(function* () {
        const { id: taskId, ...patch } = data
        const task = yield* workspace.updateTask(taskId, patch, user.id)

        if (task && data.completed && task.objectKey && task.recordId) {
          yield* records.addActivity({
            objectKey: task.objectKey,
            recordId: task.recordId,
            kind: 'task',
            summary: `completed a task: ${task.title}`,
            actor: user.name,
            actorId: user.id,
          })
        }

        return { ok: true }
      }),
    ),
  )

export const deleteTaskFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id }))
  .handler(
    crmHandler('workspace.deleteTask', ({ data }) =>
      Effect.gen(function* () {
        yield* workspace.deleteTask(data.id)
        return { ok: true }
      }),
    ),
  )

// ── Notes ───────────────────────────────────────────────────────────────────

export const listNotesFn = createServerFn({ method: 'GET' })
  .validator(z.object(recordLink))
  .handler(
    crmHandler('workspace.listNotes', ({ data }) =>
      workspace.listNotes({
        objectKey: data.objectKey ?? undefined,
        recordId: data.recordId ?? undefined,
      }),
    ),
  )

export const saveNoteFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: id.optional(),
      title: z.string().trim().max(200),
      body: z.string().max(50_000),
      ...recordLink,
    }),
  )
  .handler(
    crmHandler('workspace.saveNote', ({ data, user }) =>
      Effect.gen(function* () {
        if (data.id) {
          yield* workspace.updateNote(data.id, {
            title: data.title || 'Untitled note',
            body: data.body,
          })

          return { id: data.id }
        }

        const note = yield* workspace.createNote(data, user)

        if (data.objectKey && data.recordId) {
          yield* records.addActivity({
            objectKey: data.objectKey,
            recordId: data.recordId,
            kind: 'note',
            summary: `added a note: ${note.title}`,
            actor: user.name,
            actorId: user.id,
          })
        }

        return { id: note.id }
      }),
    ),
  )

export const deleteNoteFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id }))
  .handler(
    crmHandler('workspace.deleteNote', ({ data }) =>
      Effect.gen(function* () {
        yield* workspace.deleteNote(data.id)
        return { ok: true }
      }),
    ),
  )

// ── Favourites ──────────────────────────────────────────────────────────────

export const toggleFavoriteFn = createServerFn({ method: 'POST' })
  .validator(z.object({ objectKey, recordId: id }))
  .handler(
    crmHandler('workspace.toggleFavorite', ({ data, user }) =>
      Effect.gen(function* () {
        return { favorite: yield* workspace.toggleFavorite(user.id, data.objectKey, data.recordId) }
      }),
    ),
  )

// ── Reports ─────────────────────────────────────────────────────────────────

export const reportsFn = createServerFn({ method: 'GET' }).handler(
  crmHandler('workspace.reports', () => workspace.buildReports()),
)

// ── Logged activities and the activity report ───────────────────────────────

/** Log a call or meeting on a record. */
export const logActivityFn = createServerFn({ method: 'POST' })
  .validator(
    z
      .object({
        objectKey,
        recordId: id,
        kind: z.literal(loggableKinds),
        outcome: z.string().max(40).nullish(),
        /** When it took place; now if omitted. */
        occurredAt: z.coerce.date().nullish(),
        notes: z.string().max(20_000).nullish(),
      })
      .refine((d) => !d.outcome || LOGGABLE[d.kind].outcomes.some((o) => o.value === d.outcome), {
        message: 'Unknown outcome',
        path: ['outcome'],
      }),
  )
  .handler(
    crmHandler('workspace.logActivity', ({ data, user }) =>
      Effect.gen(function* () {
        if (!(yield* records.getRecord(data.objectKey, data.recordId))) {
          return yield* new NotFound({ what: 'Record' })
        }

        const activity = yield* workspace.logActivity(data, user)

        return { id: activity.id }
      }),
    ),
  )

/** A report range: `from` inclusive, `to` exclusive, at most two years apart. */
const reportRange = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine(
    (r) => r.to > r.from && r.to.getTime() - r.from.getTime() <= 732 * 86_400_000,
    'Pick a range of up to two years',
  )

/** Calls, emails, meetings, completed tasks and notes per teammate. */
export const activityReportFn = createServerFn({ method: 'GET' })
  .validator(reportRange)
  .handler(
    crmHandler('workspace.activityReport', ({ data }) =>
      Effect.gen(function* () {
        return yield* workspace.activityReport(data, yield* (yield* Users).team)
      }),
    ),
  )

export const activityReportCsvFn = createServerFn({ method: 'GET' })
  .validator(reportRange)
  .handler(
    crmHandler('workspace.activityReportCsv', ({ data }) =>
      Effect.gen(function* () {
        return {
          csv: workspace.activityReportCsv(
            yield* workspace.activityReport(data, yield* (yield* Users).team),
          ),
        }
      }),
    ),
  )

// ── Email ───────────────────────────────────────────────────────────────────

/** Send a one-to-one email to a record's address and keep it on the timeline. */
export const sendEmailFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      objectKey,
      recordId: id,
      field: z.string(),
      subject: z.string().trim().min(1).max(300),
      body: z.string().trim().min(1).max(20_000),
      /** Which of their mailboxes to send from, when the teammate has more than one. */
      from: z
        .object({ provider: z.enum(['google', 'microsoft']), accountEmail: z.string().max(320) })
        .optional(),
    }),
  )
  .handler(
    crmHandler('workspace.sendEmail', ({ data, user }) =>
      Effect.gen(function* () {
        const obj = getObject(data.objectKey)

        if (obj.fields[data.field]?.type !== 'email') {
          return yield* new Invalid({ message: 'Not an email field' })
        }

        const record = yield* records.getRecord(data.objectKey, data.recordId)
        const to = emailAddress.safeParse(record?.[data.field]).data

        if (to === undefined || !to.includes('@')) {
          return yield* new Invalid({ message: 'This record has no email address' })
        }

        const message = { to, subject: data.subject, text: data.body, html: textToHtml(data.body) }
        // From one of the teammate's own mailboxes when one may send, so it sits in
        // their Sent folder; otherwise through the app's email provider.
        let fallback: string | undefined

        const from = yield* sendFromMailbox(user, message, data.from).pipe(
          Effect.catchTag('MailboxError', (error) =>
            Effect.sync(() => {
              fallback = error.message
              return null
            }),
          ),
        )

        const sent = from ? true : (yield* Email.use((email) => email.send(message))).sent

        yield* records.addActivity({
          objectKey: data.objectKey,
          recordId: data.recordId,
          kind: 'email',
          summary: sent
            ? records.emailSummary('sent', data.subject)
            : `drafted an email (email is not configured, so it was not sent): ${data.subject}`,
          body: data.body,
          actor: user.name,
          actorId: user.id,
          outcome: sent ? 'sent' : 'not_sent',
        })

        return {
          sent,
          /** The teammate's own address when it went from their mailbox. */
          from: from?.accountEmail ?? null,
          /** Why their mailbox wasn't used, when it should have been. */
          fallback: fallback ?? null,
        }
      }),
    ),
  )

// ── Workflows ───────────────────────────────────────────────────────────────

/** What runs automatically: config automations, record actions, and email sequences, with recent runs. */
export const workflowsFn = createServerFn({ method: 'GET' }).handler(
  crmHandler('workspace.workflows', () =>
    Effect.gen(function* () {
      const recent = (yield* records.recentActivities(200)).filter(
        (a) => a.kind === 'workflow' || a.kind === 'campaign' || a.kind === 'email',
      )

      const [titles, active] = yield* Effect.all([workspace.recordTitles(recent), activeRuns()], {
        concurrency: 2,
      })

      return {
        swirlsConfigured: !!(yield* config.variable('SWIRLS_PROJECT_ID')),
        emailConfigured:
          !!(yield* config.variable('RESEND_API_KEY')) && !!(yield* config.variable('EMAIL_FROM')),
        // Only worth saying when there are sequences to run.
        sequencesTick:
          Object.keys(crmConfig().campaigns).length === 0 ||
          sequencesTick(yield* config.environment),
        automations: crmConfig().automations,
        actions: Object.entries(crmConfig().objects).flatMap(([key, obj]) =>
          obj.actions.map((a) => ({ objectKey: key, label: a.label, run: a.run })),
        ),
        sequences: Object.entries(crmConfig().campaigns).map(([key, c]) => ({
          key,
          label: c.label,
          objectKey: c.object,
          steps: c.steps.map((s) => ({ id: s.id, wait: s.wait, subject: s.subject })),
          stopWhen: c.stopWhen,
          active: active[key] ?? 0,
        })),
        runs: recent
          .slice(0, 30)
          .map((a) => ({ ...a, recordTitle: titles[`${a.objectKey}:${a.recordId}`] ?? null })),
      }
    }),
  ),
)
