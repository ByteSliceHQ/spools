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
 * What a grant made earlier still gives, now: no more than it stated, and no
 * more than the person it was made for holds today. A scope they have lost
 * since is gone from it, and a scope they may now only read is no longer
 * written. Null when the grant could read something and none of it is left:
 * it is then no grant at all. One that never read a scope (made for a shared
 * object's record) stands as it was.
 */
export function grantNow(granted: ScopeAccess, held: ScopeAccess): ScopeAccess | null {
  const both = (
    stated: ScopeAccess['read'],
    now: ScopeAccess['read'],
  ): 'all' | readonly string[] => {
    if (stated === 'all') {
      return now
    }

    return now === 'all' ? stated : stated.filter((scope) => now.includes(scope))
  }

  const read = both(granted.read, held.read)
  const write = both(granted.write, held.write)

  if (read !== 'all' && read.length === 0 && (granted.read === 'all' || granted.read.length > 0)) {
    return null
  }

  const reads = (scope: string) => read === 'all' || read.includes(scope)

  return {
    read,
    write,
    active: granted.active !== null && reads(granted.active) ? granted.active : null,
  }
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
  /**
   * The scopes whose records can be written in what is on screen. Someone
   * working in all of theirs may write some and only read others: a record's
   * edit controls follow the record's own scope (`writeReach`).
   */
  writes: 'all' | string[]
}

/**
 * What a person may change, as far as the browser can tell, for showing and
 * hiding the controls that change things. It decides nothing: the server
 * refuses what can't be done whatever a page shows (src/server/store/scope.ts).
 */
export type WriteReach = {
  /**
   * Whether anything at all can be changed. It is what adding a record, a
   * shared object's records, a task or note on no record and a shared folder
   * all need: whoever writes no scope changes none of them.
   */
  readonly any: boolean
  /**
   * Whether a record of a scoped object can be changed or deleted, and things
   * hung on it (tasks, notes, logged calls, emails, files, sequences), by the
   * scope the record holds: null for a record with none, undefined when the
   * page wasn't given it. That last is taken to be within reach, and the
   * server left to say.
   */
  readonly scoped: (scope: string | null | undefined) => boolean
  /**
   * Whether a row that hangs off a record (a task, a note) can be changed, by
   * the copy of its record's scope the row carries: "*" on a shared object's
   * record, nothing when the page wasn't given it.
   */
  readonly hanging: (scope: string | null | undefined) => boolean
}

/** Where there are no scopes, and wherever nothing says otherwise: every control is shown. */
export const WRITES_EVERYTHING: WriteReach = {
  any: true,
  scoped: () => true,
  hanging: () => true,
}

/** The parts of the config that say which objects are scoped, by which field, and what kind of field it is. */
export type ScopedObjects = {
  readonly scopes?: { readonly objects: Readonly<Record<string, string>> } | undefined
  readonly objects: Readonly<
    Record<string, { readonly fields: Readonly<Record<string, { readonly type: string }>> }>
  >
}

/**
 * The key a scoped object's records hold their scope under: a relation's is
 * its id's (`branchId`), as the store has it. Nothing for a shared object.
 */
export function scopeColumnOf(config: ScopedObjects, objectKey: string): string | undefined {
  const field = Object.hasOwn(config.scopes?.objects ?? {}, objectKey)
    ? config.scopes?.objects[objectKey]
    : undefined

  if (field === undefined) {
    return undefined
  }

  return config.objects[objectKey]?.fields[field]?.type === 'relation' ? `${field}Id` : field
}

/**
 * What the signed-in person may change, from what the session says of their
 * scopes. No session (a Spool without scopes) means everything, as it always
 * has. The rules are the guard's: whoever writes no scope changes nothing,
 * shared records included; a scoped record is changed by whoever writes its
 * scope; one with no scope only by a role that writes them all.
 */
export function writeReach(
  session: Pick<ScopeSession, 'canWrite' | 'writes'> | null | undefined,
): WriteReach {
  if (!session) {
    return WRITES_EVERYTHING
  }

  const { writes } = session
  const any = session.canWrite && (writes === 'all' || writes.length > 0)

  if (!any) {
    return { any: false, scoped: () => false, hanging: () => false }
  }

  const within = (scope: string | null): boolean =>
    writes === 'all' || (scope !== null && scope !== '' && writes.includes(scope))

  return {
    any,
    scoped: (scope) => scope === undefined || within(scope),
    hanging: (scope) =>
      scope === undefined || scope === null || scope === EVERY_SCOPE || within(scope),
  }
}
