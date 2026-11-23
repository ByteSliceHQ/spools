import { Effect } from 'effect'

import type { Actor, Hooks } from '../crm/extensions'
import { fieldLabel } from '../crm/naming'
import { fireAutomations } from './actions'
import type { CrmRecord, CrmValue, RecordInput } from './records'
import * as records from './records'
import { fromHook } from './runtime/errors'
import { getObject, spool } from './spool'
import { Store } from './store/store'

/**
 * Record changes with everything that goes with them: extension hooks, the
 * activity timeline and config automations. The CRM UI and the assistant's tool
 * API both write through here, so behaviour is identical whoever makes the
 * change. (`records.ts` is the raw data layer underneath.)
 *
 * A change happens in three steps:
 *
 * 1. The app's `before` hook, which may rewrite the change or refuse it.
 * 2. The change and its lines on the timeline, as one transaction: all of it is
 *    kept, or none. A change to a record holds that record meanwhile, so two
 *    changes to one record happen one after the other.
 * 3. The app's `after` hook and the config's automations, once the change is
 *    kept. They are not part of the transaction: a hook reaches the store on
 *    another connection, which would not see the change yet. If a hook fails
 *    here the change stays, and staff are told it was saved and what failed.
 */

const hooks = (): Hooks => spool().extensions.hooks ?? {}

/** The name shown on the timeline for whoever made a change. */
export const actorLabel = (actor: Actor) => actor?.name ?? actor?.email ?? 'Website'

type Change = { field: string; summary: string }

/**
 * What an update changed, one sentence fragment per field ("changed Stage to Won").
 * Values of encrypted and long-text fields are left out: the timeline is not
 * encrypted, and long text is noise.
 */
function describeChanges(objectKey: string, previous: CrmRecord, next: CrmRecord): Change[] {
  const obj = getObject(objectKey)
  const changes: Change[] = []

  for (const [key, field] of Object.entries(obj.fields)) {
    const column = field.type === 'relation' ? `${key}Id` : key
    const before = previous[column] ?? null
    const after = next[column] ?? null

    if (records.valueText(before) === records.valueText(after)) {
      continue
    }

    const label = fieldLabel(key, field)

    const show = (value: CrmValue): string => {
      if (field.type === 'select') {
        return field.options.find((o) => o.value === value)?.label ?? records.valueText(value)
      }

      if (field.type === 'relation') {
        // The related record's title, when the row brought the record back with it.
        const title = records.relatedField(next[key], getObject(field.to).titleField)
        return records.valueText(title ?? value)
      }

      if (field.type === 'boolean') {
        return value ? 'yes' : 'no'
      }

      if (value instanceof Date) {
        return value.toISOString().slice(0, 16).replace('T', ' ')
      }

      return records.valueText(value)
    }

    const hideValue = field.encrypted || field.type === 'longtext' || field.type === 'user'
    const cleared = after === null || after === ''

    changes.push({
      field: key,
      summary: cleared
        ? `cleared ${label}`
        : hideValue
          ? `updated ${label}`
          : `changed ${label} to ${show(after)}`,
    })
  }

  return changes
}

export const createRecord = Effect.fn('service.createRecord')(function* (
  objectKey: string,
  values: RecordInput,
  actor: Actor,
  options: { summary?: string; automations?: boolean } = {},
) {
  const next =
    (yield* fromHook('beforeCreate', () => hooks().beforeCreate?.({ objectKey, values, actor }))) ??
    values

  const store = yield* Store

  // The record and the line that says who made it: both, or neither.
  const record = yield* store.transaction(
    Effect.gen(function* () {
      const made = yield* records.createRecord(objectKey, next, actor?.id ?? 'website')

      yield* records.addActivity({
        objectKey,
        recordId: made.id,
        kind: 'system',
        summary: options.summary ?? `created this ${getObject(objectKey).label.toLowerCase()}`,
        actor: actorLabel(actor),
        actorId: actor?.id ?? null,
      })

      return made
    }),
  )

  yield* fromHook('afterCreate', () => hooks().afterCreate?.({ objectKey, record, actor }))

  // Bulk imports pass `automations: false` so one upload can't start hundreds of workflows.
  if (options.automations !== false) {
    yield* fireAutomations('created', { objectKey, record, actor })
  }

  return record
})

/** How many rows' problems an import reports. */
const IMPORT_ERRORS = 50

/**
 * Create records from parsed CSV rows. Each row is on its own: one the CRM
 * refuses (a value of the wrong kind, a relation to nothing) is reported with
 * its line in the file, and the rest are still created. Automations don't fire
 * for imports, so one upload can't start hundreds of workflows.
 */
export const importRecords = Effect.fn('service.importRecords')(function* (
  objectKey: string,
  rows: readonly Record<string, string>[],
  actor: Actor,
) {
  const errors: { row: number; message: string }[] = []
  let created = 0

  for (const [i, row] of rows.entries()) {
    const problem = yield* Effect.match(
      createRecord(objectKey, row, actor, {
        summary: 'imported this record from CSV',
        automations: false,
      }),
      { onFailure: (error) => error.message, onSuccess: () => null },
    )

    if (problem === null) {
      created++
    } else if (errors.length < IMPORT_ERRORS) {
      // Line 1 of the file is its header.
      errors.push({ row: i + 2, message: problem })
    }
  }

  return { created, failed: rows.length - created, errors }
})

export const updateRecord = Effect.fn('service.updateRecord')(function* (
  objectKey: string,
  id: string,
  values: RecordInput,
  actor: Actor,
) {
  const before = yield* records.getRecord(objectKey, id)

  if (!before) {
    return null
  }

  const next =
    (yield* fromHook('beforeUpdate', () =>
      hooks().beforeUpdate?.({ objectKey, id, values, previous: before, actor }),
    )) ?? values

  const store = yield* Store

  const changed = yield* store.transaction(
    Effect.gen(function* () {
      // Held until the change is kept. A value that depends on another field (a stage on its
      // pipeline) is then checked against what the record really holds, not what it held a moment ago.
      if (!(yield* records.holdRecord(objectKey, id))) {
        return null
      }

      const previous = yield* records.getRecord(objectKey, id)

      if (!previous || !(yield* records.updateRecord(objectKey, id, next))) {
        return null
      }

      // Re-read so the result includes related records, like `previous` does.
      const record = yield* records.getRecord(objectKey, id)

      if (!record) {
        return null
      }

      for (const change of describeChanges(objectKey, previous, record)) {
        yield* records.addActivity({
          objectKey,
          recordId: id,
          kind: 'change',
          summary: change.summary,
          actor: actorLabel(actor),
          actorId: actor?.id ?? null,
        })
      }

      return { previous, record }
    }),
  )

  if (!changed) {
    return null
  }

  const { previous, record } = changed

  yield* fromHook('afterUpdate', () =>
    hooks().afterUpdate?.({ objectKey, record, previous, actor }),
  )

  yield* fireAutomations('updated', { objectKey, record, actor })
  return record
})

export const deleteRecord = Effect.fn('service.deleteRecord')(function* (
  objectKey: string,
  id: string,
  actor: Actor,
) {
  const record = yield* records.getRecord(objectKey, id)

  if (!record) {
    return false
  }

  const store = yield* Store
  // The record, its timeline and its folder's row go together.
  yield* store.transaction(records.deleteRecord(objectKey, id))
  yield* fromHook('afterDelete', () => hooks().afterDelete?.({ objectKey, record, actor }))
  yield* fireAutomations('deleted', { objectKey, record, actor })
  return true
})
