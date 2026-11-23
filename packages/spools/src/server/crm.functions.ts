import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'

import { toPublicConfig } from '../crm/config'
import { runTarget } from './actions'
import * as guides from './guides'
import * as records from './records'
import { CurrentRequest } from './runtime/app'
import { crmHandler, publicHandler, signedInUser } from './runtime/boundary'
import { Invalid, NotFound } from './runtime/errors'
import * as search from './search'
import * as service from './service'
import { crmConfig, getObject, spool } from './spool'
import { Users } from './users'
import * as workspace from './workspace'

/**
 * The only bridge between the browser and CRM data. Every function here
 * re-checks the session and the config access allowlist.
 */

const objectKey = z.string().refine((k) => Object.hasOwn(crmConfig().objects, k), 'Unknown object')
const recordRef = z.object({ objectKey, id: z.string().uuid() })

export const getCrmSession = createServerFn({ method: 'GET' }).handler(
  publicHandler('crm.getCrmSession', () =>
    Effect.gen(function* () {
      const user = yield* signedInUser

      // The team list feeds owner/assignee pickers; skip asking for it when no object has a `user` field.
      const hasUserFields = Object.values(crmConfig().objects).some((o) =>
        Object.values(o.fields).some((f) => f.type === 'user'),
      )

      const users = user && hasUserFields ? yield* (yield* Users).team : []

      // What this person has seen of the guides rides along, so no page asks for it separately.
      const nothingSeen: string[] = []

      const [favorites, dueTasks, seen] = user
        ? yield* Effect.all(
            [
              workspace.listFavorites(user.id),
              workspace.dueTaskCount(user.id),
              guides.seenGuides(user.id),
            ],
            { concurrency: 'unbounded' },
          )
        : [[], 0, nothingSeen]

      return {
        signedIn: user !== null || (yield* signedInSession),
        user,
        config: user ? toPublicConfig(crmConfig()) : null,
        users,
        favorites,
        dueTasks,
        guides: { seen, offers: yield* guides.guidesOffered },
      }
    }),
  ),
)

/** Whether anyone is signed in, allowed in or not. */
const signedInSession = Effect.map(
  Effect.serviceOption(CurrentRequest),
  (request) => request._tag === 'Some' && request.value.session !== null,
)

/** What every page needs, signed in or not: the business's name, and which auth provider signs people in. */
export const getBrandFn = createServerFn({ method: 'GET' }).handler(
  publicHandler('crm.getBrand', () =>
    Effect.sync(() => ({ name: crmConfig().app.name, auth: spool().auth.id })),
  ),
)

/** These answers hold people's names and messages: no browser, proxy or CDN may keep a copy. */
const neverStore = { headers: { 'Cache-Control': 'private, no-store' } }

/**
 * What the search box matches in the browser: every record's title, summary
 * line and unencrypted searchable fields. With `since`, only what changed after it.
 */
export const searchIndexFn = createServerFn({ method: 'GET' })
  .validator(z.object({ since: z.string().datetime().optional() }))
  .handler(
    crmHandler(
      'crm.searchIndex',
      ({ data, user }) =>
        Effect.gen(function* () {
          // As one JSON string: thousands of small arrays cost far more to carry as a structured value.
          return JSON.stringify(
            yield* search.quickIndex(data.since ? new Date(data.since) : undefined, user.id),
          )
        }),
      neverStore,
    ),
  )

/** Matches the browser can't find itself: other fields, and the text of notes, emails, calls and tasks. */
export const searchDeepFn = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string().trim().min(1).max(200) }))
  .handler(crmHandler('crm.searchDeep', ({ data }) => search.deepSearch(data.q), neverStore))

/** Values of an object's text fields that contain what was typed, to offer as filters. */
export const suggestValuesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ objectKey, q: z.string().trim().min(1).max(100) }))
  .handler(
    crmHandler(
      'crm.suggestValues',
      ({ data }) => search.suggestValues(data.objectKey, data.q),
      neverStore,
    ),
  )

export const deleteRecordsFn = createServerFn({ method: 'POST' })
  .validator(z.object({ objectKey, ids: z.array(z.string().uuid()).min(1).max(200) }))
  .handler(
    crmHandler('crm.deleteRecords', ({ data, user }) =>
      Effect.gen(function* () {
        let deleted = 0

        for (const id of data.ids) {
          if (yield* service.deleteRecord(data.objectKey, id, user)) {
            deleted++
          }
        }

        return { deleted }
      }),
    ),
  )

export const getRecordFn = createServerFn({ method: 'GET' })
  .validator(recordRef)
  .handler(
    crmHandler('crm.getRecord', ({ data, user }) =>
      Effect.gen(function* () {
        const [record, activities, related, tasks, notes, favorite] = yield* Effect.all(
          [
            records.getRecord(data.objectKey, data.id),
            records.listActivities(data.objectKey, data.id),
            records.relatedRecords(data.objectKey, data.id),
            workspace.listTasks({ objectKey: data.objectKey, recordId: data.id }),
            workspace.listNotes({ objectKey: data.objectKey, recordId: data.id }),
            workspace.isFavorite(user.id, data.objectKey, data.id),
          ],
          { concurrency: 'unbounded' },
        )

        return { record, activities, related, tasks, notes, favorite }
      }),
    ),
  )

/** One page of an object's titles for a relation picker, narrowed by what has been typed. */
export const searchRelationFn = createServerFn({ method: 'GET' })
  .validator(z.object({ objectKey, q: z.string().max(200).default('') }))
  .handler(
    crmHandler('crm.searchRelation', ({ data }) => records.searchTitles(data.objectKey, data.q)),
  )

/** The titles of records a page holds only the ids of (a preset value, a saved filter). */
export const relationTitlesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ objectKey, ids: z.array(z.string().uuid()).min(1).max(100) }))
  .handler(
    crmHandler('crm.relationTitles', ({ data }) =>
      Effect.gen(function* () {
        const titles = yield* records.recordTitlesOf(data.objectKey, data.ids)
        return [...titles].map(([id, title]) => ({ id, title }))
      }),
    ),
  )

export const createRecordFn = createServerFn({ method: 'POST' })
  .validator(z.object({ objectKey, values: z.record(z.string(), z.unknown()) }))
  .handler(
    crmHandler('crm.createRecord', ({ data, user }) =>
      Effect.gen(function* () {
        const record = yield* service.createRecord(data.objectKey, data.values, user)
        return { id: record.id }
      }),
    ),
  )

export const updateRecordFn = createServerFn({ method: 'POST' })
  .validator(recordRef.extend({ values: z.record(z.string(), z.unknown()) }))
  .handler(
    crmHandler('crm.updateRecord', ({ data, user }) =>
      Effect.gen(function* () {
        const record = yield* service.updateRecord(data.objectKey, data.id, data.values, user)

        if (!record) {
          return yield* new NotFound({ what: 'Record' })
        }

        return { id: record.id }
      }),
    ),
  )

export const deleteRecordFn = createServerFn({ method: 'POST' })
  .validator(recordRef)
  .handler(
    crmHandler('crm.deleteRecord', ({ data, user }) =>
      Effect.gen(function* () {
        yield* service.deleteRecord(data.objectKey, data.id, user)
        return { ok: true }
      }),
    ),
  )

export const runActionFn = createServerFn({ method: 'POST' })
  .validator(recordRef.extend({ actionId: z.string() }))
  .handler(
    crmHandler('crm.runAction', ({ data, user }) =>
      Effect.gen(function* () {
        const action = getObject(data.objectKey).actions.find((a) => a.id === data.actionId)

        if (!action) {
          return yield* new Invalid({ message: 'Unknown action' })
        }

        const record = yield* records.getRecord(data.objectKey, data.id)

        if (!record) {
          return yield* new NotFound({ what: 'Record' })
        }

        return yield* runTarget(action.run, {
          objectKey: data.objectKey,
          record,
          actor: user,
          trigger: `action:${action.id}`,
        })
      }),
    ),
  )

export const dashboardFn = createServerFn({ method: 'GET' }).handler(
  crmHandler('crm.dashboard', ({ user }) =>
    Effect.gen(function* () {
      const [counts, activities, tasks] = yield* Effect.all(
        [
          records.countRecords(),
          records.recentActivities(12),
          workspace.listTasks({ assigneeId: user.id }),
        ],
        { concurrency: 'unbounded' },
      )

      return { counts, activities, tasks: tasks.filter((t) => !t.completedAt).slice(0, 8) }
    }),
  ),
)
