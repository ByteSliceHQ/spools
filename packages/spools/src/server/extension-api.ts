import type { Effect } from 'effect'

import { SYSTEM_ACCESS } from '../crm/scopes'
import type { RunContext, RunResult } from './actions'
import * as actions from './actions'
import * as files from './files'
import * as integrations from './integrations'
import * as records from './records'
import { carrying } from './runtime/access'
import { type AppServices, filesProblems, runServer } from './runtime/app'
import * as service from './service'
import { Users } from './users'
import * as workspace from './workspace'

/**
 * The framework, as promises, for code that isn't written with Effect: an
 * app's `src/app/extensions.ts` (hooks, handlers, run targets) and scripts.
 * Each function runs the Effect version on the server's runtime. A failure
 * rejects with the typed error itself, whose `message` is written for staff.
 *
 * Import from here, not from the modules: those export Effects, and
 * `await`ing an Effect does nothing (see docs/server-code.md).
 */

export type { RecordRef } from './files'
export type { ActivityInput, CrmRecord, ListQuery } from './records'
export { runServer } from './runtime/app'
export type { CrmUser } from './users'

/**
 * Runs your code as the server itself, in a Spool with record scopes: every
 * scope, read and write. For a script (a seed, an import, a migration) and for
 * the rare hook that must reach beyond whoever caused it. Inside a hook your
 * code already works with the access of the person who caused it; anywhere
 * else nothing is assumed, and a scoped record is refused until the code says
 * whose work it is. Each use is a place where scopes don't apply: keep them few.
 *
 *   await asSystem(() => createRecord('contacts', { name: 'Ada', branch: 'north' }, null))
 */
export const asSystem = <A>(work: () => Promise<A>): Promise<A> => carrying(SYSTEM_ACCESS, work)

/** Whether the Spool has a file store and it is set up. Answers at once. */
export const filesConfigured = (): boolean => filesProblems().length === 0

/** A record's own folder in the file store, made the first time it is asked for. */
export const recordFolder = (
  objectKey: string,
  recordId: string,
): Promise<{ folderId: string; path: string }> => runServer(files.recordFolder(objectKey, recordId))

/** Give one record another record's folder (a won deal handing over to a job). */
export const shareRecordFolder = (from: files.RecordRef, to: files.RecordRef): Promise<void> =>
  runServer(files.shareRecordFolder(from, to))

/** Everyone who may use the CRM, by name. */
export const listCrmUsers = () => runServer(Users.use((users) => users.team))

/**
 * A current access token for an account a teammate connected on the
 * Integrations page (refreshed when it is about to expire). For an app's
 * handlers that call the provider's API.
 */
export const getAccessToken = (connectionId: string): Promise<string> =>
  runServer(integrations.getAccessToken(connectionId))

/** Connections across the team, to find whose account to act with. Never return these to a browser. */
export const findConnections = (filter: { provider?: string; userId?: string } = {}) =>
  runServer(integrations.findConnections(filter))

/** Run a config target (`"swirls:<name>"`, `"campaign:<name>"`, `"local:<name>"`, or an app's own kind). */
export const runTarget = (target: string, ctx: RunContext): Promise<RunResult> =>
  runServer(actions.runTarget(target, ctx))

/**
 * A framework function, as a promise. Looked up when called, not when this
 * file loads: src/app/extensions.ts imports this file, and the modules here
 * import extensions.ts, so at load time they may not be ready yet.
 */
const promised =
  <Args extends unknown[], A, E>(f: () => (...args: Args) => Effect.Effect<A, E, AppServices>) =>
  (...args: Args): Promise<A> =>
    runServer(f()(...args))

// ── Records: writes go through the service, so hooks, the timeline and automations run ──

/** Create a record as `actor`: validated against the config, with its hooks, timeline entry and automations. */
export const createRecord = promised(() => service.createRecord)
/** Change a record as `actor`. Null when it no longer exists. */
export const updateRecord = promised(() => service.updateRecord)
/** Delete a record as `actor`. False when it was already gone. */
export const deleteRecord = promised(() => service.deleteRecord)
/** One record with its related records, or null. */
export const getRecord = promised(() => records.getRecord)
/** A page of an object's records: text search, `where`, filters, sort. */
export const listRecords = promised(() => records.listRecords)
/** How many records match a query. */
export const countMatching = promised(() => records.countMatching)

// ── The timeline ────────────────────────────────────────────────────────────

/** Put an entry on a record's timeline. */
export const addActivity = promised(() => records.addActivity)
/** A record's timeline, newest first. */
export const listActivities = promised(() => records.listActivities)

// ── Tasks and notes ─────────────────────────────────────────────────────────

export const listTasks = promised(() => workspace.listTasks)
export const createTask = promised(() => workspace.createTask)
export const updateTask = promised(() => workspace.updateTask)
export const deleteTask = promised(() => workspace.deleteTask)
export const listNotes = promised(() => workspace.listNotes)
export const createNote = promised(() => workspace.createNote)
