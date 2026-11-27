import { createContext, useContext } from 'react'
import { z } from 'zod'

import { scopeColumnOf, type ScopedObjects, type ScopeSession, writeReach } from '../scopes'
import type { RecordData } from './fields'

/**
 * What the signed-in person may change, for showing and hiding the controls
 * that change things. The rules are `writeReach` in src/crm/scopes.ts; this
 * reads them for what a page holds. It is a convenience: the server refuses
 * what can't be done, whatever is shown.
 */
export type PageReach = {
  /** Whether anything at all can be changed: adding a record, a task or note on no record, a shared folder. */
  readonly any: boolean
  /**
   * Whether this record can be changed or deleted, and things hung on it
   * (tasks, notes, logged calls, emails, sequences). A shared object's record
   * is anyone's who changes anything; so is one the page doesn't hold yet.
   */
  readonly record: (objectKey: string, record: RecordData | null | undefined) => boolean
  /** Whether a task or note can be changed, by the scope it carries. */
  readonly hanging: (scope: string | null | undefined) => boolean
}

/** A record's scope as the page holds it: text, or nothing. Anything else is a scope the page wasn't given. */
const heldScope = z.string().nullable()

/** What this person may change, from the session's scopes and the config's scoped objects. */
export function pageReach(
  session: Pick<ScopeSession, 'canWrite' | 'writes'> | null | undefined,
  config: ScopedObjects,
): PageReach {
  const reach = writeReach(session)

  return {
    any: reach.any,
    record: (objectKey, record) => {
      const column = scopeColumnOf(config, objectKey)

      if (column === undefined || !record) {
        return reach.any
      }

      return reach.scoped(heldScope.safeParse(record[column]).data)
    },
    hanging: reach.hanging,
  }
}

/** The layout provides it from the session. Without it, and in a Spool without record scopes, every control is shown. */
export const WriteReachContext = createContext<PageReach>(pageReach(null, { objects: {} }))

export const useWriteReach = (): PageReach => useContext(WriteReachContext)
