/**
 * Record scopes: one Spool whose records belong to groups of the business
 * (branches, regions, teams), where a person only sees and changes the records
 * of the groups they hold. Pure and shared by server and browser: what a scope
 * is, what a person holds, and what that lets them read and write.
 *
 * Off unless crm.config.json has `scopes`. A Spool without it behaves as it
 * always has: every allowed user reads and writes every record.
 *
 * They are enforced in one place, under every caller: `guard` in
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

/** How many minutes a signed grant for the tool API lasts unless `scopes.grantMinutes` says (docs/swirls.md). */
export const DEFAULT_GRANT_MINUTES = 15

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
  /** Only on `SYSTEM_ACCESS`: the server's own work. No person's access has it, whatever their role. */
  readonly system?: true
}

/** Work the server does for itself, with nobody signed in: migrations, backfills, finding what is due. */
export const SYSTEM_ACCESS: ScopeAccess = { read: 'all', write: 'all', active: null, system: true }

/** Reaches nothing. What a signed-in person with no grant has. */
export const NO_ACCESS: ScopeAccess = { read: [], write: [], active: null }

/** The roles of `scopes.roles` in crm.config.json. */
export type ScopeRoles = Readonly<Record<string, { write: boolean; all: boolean }>>

/**
 * What a person may reach, from what they hold and the scope they asked to
 * work in. `wanted` is a scope's key, null for every scope they hold at once,
 * or undefined when they haven't said (they get the first scope they hold, or
 * every scope when their role reaches them all). Asking for a scope that isn't
 * held is the same as not saying. A grant whose role the config doesn't have
 * gives nothing, and someone who holds nothing reaches nothing. It never gives
 * the system's own access.
 */
export function accessFrom(
  roles: ScopeRoles,
  grants: readonly ScopeGrant[],
  wanted?: string | null,
): ScopeAccess {
  const everywhere = { reads: false, writes: false }
  /** Each scope held, in the order granted, and whether it may be written. */
  const held = new Map<string, boolean>()

  for (const grant of grants) {
    const role = Object.hasOwn(roles, grant.role) ? roles[grant.role] : undefined

    if (!role) {
      continue
    }

    if (role.all) {
      everywhere.reads = true
      everywhere.writes ||= role.write
    } else if (grant.scope !== EVERY_SCOPE && grant.scope !== '') {
      held.set(grant.scope, (held.get(grant.scope) ?? false) || role.write)
    }
  }

  const writable = [...held].filter(([, writes]) => writes).map(([scope]) => scope)

  const one = (scope: string): ScopeAccess => ({
    read: [scope],
    write: everywhere.writes || held.get(scope) ? [scope] : [],
    active: scope,
  })

  if (everywhere.reads) {
    return wanted === null || wanted === undefined || wanted === ''
      ? { read: 'all', write: everywhere.writes ? 'all' : writable, active: null }
      : one(wanted)
  }

  const [first] = held.keys()

  if (first === undefined) {
    return NO_ACCESS
  }

  if (wanted === null) {
    return { read: [...held.keys()], write: writable, active: null }
  }

  return one(wanted !== undefined && held.has(wanted) ? wanted : first)
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
