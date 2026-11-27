import { type Effect, Predicate } from 'effect'

import type { RunContext, RunResult } from './actions'
import * as actions from './actions'
import * as files from './files'
import * as integrations from './integrations'
import * as records from './records'
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
export type { Connection, ConnectionGroup } from './integrations'
export type { ActivityInput, CrmRecord, ListQuery } from './records'
export { runServer } from './runtime/app'
export type { CrmUser } from './users'

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

/** A person some code is acting for: `ctx.actor` in a handler, or their id. `null` is nobody (a script, an automation that ran by itself). */
type For = string | { id: string } | null

/** The person's id, or null for nobody. A value that is missing where a person was asked for is nobody too. */
const idOf = (person: For | undefined) =>
  person === undefined || person === null ? null : Predicate.isString(person) ? person : person.id

/**
 * A current access token for an account connected on the Integrations page
 * (refreshed when it is about to expire). For an app's handlers that call the
 * provider's API.
 *
 *   getAccessToken(id, { as: ctx.actor })   for whoever pressed the button
 *   getAccessToken(id)                      for code nobody is behind: a schedule, a webhook
 *
 * With `as`, the token is only given if that person is on the access list and
 * the connection is theirs or is shared. If `as` turns out to be nobody
 * (`ctx.actor` is `null` when an automation or a script ran the handler), the
 * call is refused: it is never taken to mean "trusted". To act with no person
 * behind the call, say so by leaving the second argument out.
 */
export const getAccessToken = (connectionId: string, options?: { as: For }): Promise<string> =>
  runServer(
    options === undefined
      ? integrations.getAccessToken(connectionId)
      : integrations.getAccessToken(connectionId, undefined, idOf(options.as)),
  )

/**
 * Connections, to find which account to act with. Never return these to a browser.
 *
 *   findConnections({ provider: 'books', shared: 'team' })     the company's
 *   findConnections({ provider: 'books', group: 'north' })     one branch's
 *   findConnections({ provider: 'phone', userId })             a teammate's own
 *
 * `usableBy` keeps only what that person may use. When it is there and names
 * nobody (`usableBy: ctx.actor` with no actor), nothing is found. Leave it out
 * in code nobody is behind.
 */
export const findConnections = (
  filter: Omit<integrations.ConnectionFilter, 'usableBy'> & { usableBy?: For } = {},
) => {
  const { usableBy, ...rest } = filter

  return runServer(
    integrations.findConnections(
      Object.hasOwn(filter, 'usableBy') ? { ...rest, usableBy: idOf(usableBy) } : rest,
    ),
  )
}

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
