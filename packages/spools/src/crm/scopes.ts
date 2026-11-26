/**
 * Record scopes: one Spool whose records belong to groups of the business
 * (branches, regions, teams), where a person only sees and changes the records
 * of the groups they hold. Pure and shared by server and browser: what a scope
 * is, what a person holds, and what that lets them read and write.
 *
 * Off unless crm.config.json has `scopes`. A Spool without it behaves as it
 * always has: every allowed user reads and writes every record.
 *
 * STATUS: design checkpoint. The types below are the proposed contract; nothing
 * enforces them yet. The enforcement point is `guard` in
 * src/server/store/scope.ts.
 */

/** One group of the business, by the value its records carry in their scope field. */
export type ScopeInfo = { key: string; label: string }

/**
 * What the resolver says about a person: a scope they hold, and the role they
 * hold it with. `role` names an entry of `scopes.roles` in crm.config.json. A
 * role with `all: true` reaches every scope, whichever scope it is granted in.
 */
export type ScopeGrant = { scope: string; role: string }

/** The scope key a resolver may use for a role that reaches every scope. */
export const EVERY_SCOPE = '*'

/**
 * What one request (or one piece of background work) may reach.
 *
 * - `read`: the scopes whose records are there at all. A record of any other
 *   scope answers as not found, never as forbidden.
 * - `write`: the scopes whose records may be created, changed or deleted.
 * - `active`: the scope a new record takes when it names none. Null when the
 *   person is looking at several scopes at once: a new record must then say.
 */
export type ScopeAccess = {
  readonly read: 'all' | readonly string[]
  readonly write: 'all' | readonly string[]
  readonly active: string | null
}

/** Work the server does for itself, with nobody signed in: migrations, backfills, finding what is due. */
export const SYSTEM_ACCESS: ScopeAccess = { read: 'all', write: 'all', active: null }

/** Reaches nothing. What a signed-in person with no grant has. */
export const NO_ACCESS: ScopeAccess = { read: [], write: [], active: null }

/** The roles of `scopes.roles` in crm.config.json. */
export type ScopeRoles = Readonly<Record<string, { write: boolean; all: boolean }>>

/**
 * What a person may reach, from what they hold and the scope they asked to
 * work in. `wanted` is a scope's key, null for every scope they hold at once,
 * or undefined when they haven't said (they get the first scope they hold).
 * Asking for a scope that isn't held is the same as not saying. A grant whose
 * role the config doesn't have gives nothing.
 *
 * Not decided yet: this is the server's own access, which is what everyone has
 * in a Spool without scopes. tests/unit/scopes.test.ts has the table it must
 * answer with.
 */
export function accessFrom(
  _roles: ScopeRoles,
  _grants: readonly ScopeGrant[],
  _wanted?: string | null,
): ScopeAccess {
  return SYSTEM_ACCESS
}

/**
 * A short name for what an access can read, the same for two requests that see
 * the same records. The browser keeps what it remembers (the search index,
 * relation titles, recently opened records) under it, so nothing fetched while
 * one scope was active is shown under another.
 */
export const scopeKey = (access: ScopeAccess): string =>
  access.read === 'all' ? EVERY_SCOPE : access.read.toSorted().join('+')

/** What the browser is told about the signed-in person's scopes, with the session. */
export type ScopeSession = {
  /** The scopes this person may switch between. */
  held: ScopeInfo[]
  /** The one that is active, or null for "all of mine". */
  active: string | null
  /** `scopeKey` of what this request could read. */
  key: string
  /** Whether anything can be written in what is on screen: read-only people get no edit controls. */
  canWrite: boolean
}
