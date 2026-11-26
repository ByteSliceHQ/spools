import { Effect, Predicate } from 'effect'

import { EVERY_SCOPE } from '../crm/scopes'
import type { DatabaseError, Timeout } from './runtime/errors'
import { crmConfig, objectTable } from './spool'
import { and, asc, gt, isNull, oneOf } from './store/query'
import { Store } from './store/store'
import {
  Activity,
  Favorite,
  FileUpload,
  Note,
  RecordFolder,
  SequenceRun,
  Task,
} from './store/tables'

/**
 * Gives the rows that hang off a record (its timeline, tasks, notes,
 * favourites, folder, uploads and sequence runs) their record's scope, where
 * they have none: rows written before `scopes` was added to crm.config.json.
 * Until it has run, those rows are only there for a role that reaches every
 * scope. `spools scopes backfill` runs it; it is safe to run again.
 *
 * A row on no record (a task or a note of its own) is left as it is: nothing
 * says which scope it was for. A row on a record that has no scope itself is
 * left too, until the record is given one.
 *
 * It reads and writes every scope, so it must be run as the system
 * (`asSystem`); as anyone else the store refuses it.
 */

/** What a hanging row needs read of it. */
type Hanging = { id: string; objectKey: string | null; recordId: string | null }

type Reads<A> = Effect.Effect<A, DatabaseError | Timeout>

/** One hanging table: a page of its rows that have no scope, and how to give rows one. */
type Source = {
  name: string
  page: (after: string) => Reads<Hanging[]>
  stamp: (ids: string[], scope: string) => Effect.Effect<number, DatabaseError>
}

const PAGE = 500

/** The next page of a table's rows that have no scope, in id order. */
const unscoped = (after: string) => ({
  filter: and(isNull('scope'), gt('id', after)),
  order: [asc('id')],
  limit: PAGE,
})

const ids = (rows: string[]) => ({ filter: oneOf('id', rows) })

export type Backfilled = { table: string; stamped: number; left: number }

export const backfillScopes = Effect.fn('scopes.backfill')(function* () {
  const store = yield* Store
  const scopes = crmConfig().scopes
  const results: Backfilled[] = []

  if (!scopes) {
    return results
  }

  const sources: Source[] = [
    {
      name: Activity.name,
      page: (after) => store.find(Activity, unscoped(after)),
      stamp: (rows, scope) => store.update(Activity, ids(rows), { scope }),
    },
    {
      name: Task.name,
      page: (after) => store.find(Task, unscoped(after)),
      stamp: (rows, scope) => store.update(Task, ids(rows), { scope }),
    },
    {
      name: Note.name,
      page: (after) => store.find(Note, unscoped(after)),
      stamp: (rows, scope) => store.update(Note, ids(rows), { scope }),
    },
    {
      name: Favorite.name,
      page: (after) => store.find(Favorite, unscoped(after)),
      stamp: (rows, scope) => store.update(Favorite, ids(rows), { scope }),
    },
    {
      name: RecordFolder.name,
      page: (after) => store.find(RecordFolder, unscoped(after)),
      stamp: (rows, scope) => store.update(RecordFolder, ids(rows), { scope }),
    },
    {
      name: FileUpload.name,
      page: (after) => store.find(FileUpload, unscoped(after)),
      stamp: (rows, scope) => store.update(FileUpload, ids(rows), { scope }),
    },
    {
      name: SequenceRun.name,
      page: (after) => store.find(SequenceRun, unscoped(after)),
      stamp: (rows, scope) => store.update(SequenceRun, ids(rows), { scope }),
    },
  ]

  /** The scope of each of these records of one object, by id. A shared object's records are everyone's. */
  const scopesOf = Effect.fn('scopes.backfill.scopesOf')(function* (
    objectKey: string,
    recordIds: string[],
  ) {
    const found = new Map<string, string>()

    if (!Object.hasOwn(crmConfig().objects, objectKey)) {
      return found
    }

    const field = Object.hasOwn(scopes.objects, objectKey) ? scopes.objects[objectKey] : undefined
    const table = objectTable(objectKey)
    const column = table.scope?.kind === 'own' ? table.scope.column : undefined

    const records = yield* store.find(table, {
      filter: oneOf('id', recordIds),
      select: column ? ['id', column] : ['id'],
    })

    for (const record of records) {
      const scope = field === undefined || column === undefined ? EVERY_SCOPE : record[column]

      // A scope is text (a value, or a related record's key). Anything else is no scope.
      if (Predicate.isString(scope) && scope !== '') {
        found.set(record.id, scope)
      }
    }

    return found
  })

  for (const source of sources) {
    const result: Backfilled = { table: source.name, stamped: 0, left: 0 }

    for (let after = ''; ;) {
      const rows = yield* source.page(after)
      const last = rows.at(-1)

      if (!last) {
        break
      }

      after = last.id
      /** The rows to stamp, by the scope they take. */
      const taking = new Map<string, string[]>()
      const byObject = new Map<string, Hanging[]>()

      for (const row of rows) {
        if (row.objectKey && row.recordId) {
          byObject.set(row.objectKey, [...(byObject.get(row.objectKey) ?? []), row])
        } else {
          result.left++
        }
      }

      for (const [objectKey, onRecords] of byObject) {
        const known = yield* scopesOf(objectKey, [
          ...new Set(onRecords.map((r) => r.recordId ?? '')),
        ])

        for (const row of onRecords) {
          const scope = known.get(row.recordId ?? '')

          if (scope === undefined) {
            result.left++
          } else {
            taking.set(scope, [...(taking.get(scope) ?? []), row.id])
          }
        }
      }

      for (const [scope, stamped] of taking) {
        result.stamped += yield* source.stamp(stamped, scope)
      }

      if (rows.length < PAGE) {
        break
      }
    }

    results.push(result)
  }

  return results
})
