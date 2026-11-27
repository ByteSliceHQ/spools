import { Effect, Predicate as Is } from 'effect'

import { EVERY_SCOPE, type ScopeAccess } from '../../crm/scopes'
import { CurrentAccess } from '../runtime/access'
import { DatabaseError, type Timeout } from '../runtime/errors'
import { objectTables } from './objects'
import {
  and,
  oneOf,
  type Order,
  type OrderBy,
  type Predicate,
  type Query,
  type Scalar,
} from './query'
import type { DateKinds, RawChanges, RawRow, StoreShape, ValueCount } from './store'
import type { AnyTable, TableScope } from './table'
import { systemTables } from './tables'

/**
 * Record scopes, where they are enforced: between every caller and every
 * database (src/crm/scopes.ts says what a scope is). `makeStore` puts each
 * store it makes behind `guard`, so the rule holds for every adapter, and for
 * code that reaches the store without going through records.ts or service.ts
 * (views, workspace, search, campaigns, files, an adapter's own tables).
 *
 * In a Spool whose config has `scopes`:
 *
 * - a table that says it is scoped (`scope` in table.ts: an object named in
 *   `scopes.objects`, and the system tables that hang off a record) only shows,
 *   counts, changes, deletes and holds the rows `CurrentAccess` can read or write;
 * - a condition that reaches another table (`some`, `none`) is narrowed on that
 *   table too, a related record `include` brings back is left out when it is
 *   out of reach, and a list sorted by a relation sorts such a row as one with
 *   no related record;
 * - a new row takes the active scope, a row that hangs off a record takes that
 *   record's, and a scope that isn't held is refused whoever sends it;
 * - a relation between two scoped objects must stay inside one scope, and a
 *   record can't move to another scope while scoped records point at it;
 * - with no access set, a scoped table refuses the call: work with nobody
 *   signed in must say it is the system's (`asSystem` in src/server/scopes.ts).
 *
 * In a Spool without `scopes` every call goes through as it was given.
 *
 * A refusal is a `DatabaseError` whose message is written for staff, so the
 * store's own types are as they were.
 */

export { CurrentAccess } from '../runtime/access'

type Read<A> = Effect.Effect<A, DatabaseError | Timeout>
type Write<A> = Effect.Effect<A, DatabaseError>

/** Which rows, with the types gone. */
export type AnyWhich = {
  readonly where?: Readonly<Record<string, Scalar | undefined>>
  readonly filter?: Predicate
}

export type AnyQuery = AnyWhich &
  Pick<Query<unknown>, 'order' | 'limit' | 'offset' | 'include'> & {
    readonly select?: readonly string[]
  }

/** Each store method on rows with their types gone, which is what `makeStore` builds and the guard wraps. */
type RawMethods = {
  readonly find: (table: AnyTable, query?: AnyQuery) => Read<RawRow[]>
  readonly first: (table: AnyTable, query: AnyQuery) => Read<RawRow | null>
  readonly count: (table: AnyTable, which?: AnyWhich) => Read<number>
  readonly countValues: (
    table: AnyTable,
    column: string,
    which: AnyWhich & { atLeast: number },
  ) => Read<ValueCount[]>
  readonly insert: (table: AnyTable, values: RawChanges) => Write<RawRow>
  readonly update: (table: AnyTable, which: AnyWhich, changes: RawChanges) => Write<number>
  readonly remove: (table: AnyTable, which: AnyWhich) => Write<number>
  readonly refreshDates: (
    table: AnyTable,
    objectKey: string,
    kinds: DateKinds,
    recordId?: string,
  ) => Write<void>
  readonly transaction: StoreShape['transaction']
  readonly lock: (table: AnyTable, which: AnyWhich) => Write<number>
  readonly ping: StoreShape['ping']
}

/**
 * The store with its types gone. Mapped over `StoreShape`, so a method added
 * to the store doesn't build until it is given a raw form here, a line in
 * `SCOPE_DECISIONS` and a body in `guard`.
 */
export type RawStore = { readonly [Method in keyof StoreShape]: RawMethods[Method] }

/** What the guard does with each store method. Every method has to say. */
export const SCOPE_DECISIONS = {
  find: 'rows are narrowed to what can be read; so are conditions through relations, related records brought back, and the related records an order sorts by',
  first: 'as find',
  count: 'narrowed to what can be read',
  countValues: 'narrowed to what can be read',
  insert:
    'takes the active scope (or its record’s); a scope that is not held and a relation out of the scope are refused',
  update:
    'narrowed to what can be written; a move to a scope that is not held, and a relation out of the scope, are refused',
  remove: 'narrowed to what can be written',
  refreshDates: 'one record: only when it can be read; every record: only as the system',
  transaction: 'passes: the access set outside it is still set inside it',
  lock: 'narrowed to what can be written',
  ping: 'passes: it reads no table',
} as const satisfies { readonly [Method in keyof StoreShape]: string }

/** Why the guard refused a call. Its message is what staff read. */
export class ScopeRefusal extends Error {
  readonly _tag = 'ScopeRefusal'
}

const refuse = (message: string) =>
  Effect.fail(new DatabaseError({ cause: new ScopeRefusal(message) }))

/** A read the guard makes on a write's way in: giving up on it is the write failing. */
const within = <A>(read: Read<A>): Write<A> =>
  Effect.catchTag(read, 'Timeout', (timeout) => Effect.fail(new DatabaseError({ cause: timeout })))

/** The `scopes` of this process's Spool, if it has any. A store made where no Spool is defined has none. */
const scopesOf = () => globalThis.spoolsSpool?.config.scopes

const label = () => (scopesOf()?.label ?? 'scope').toLowerCase()

/** How a table is scoped, in a Spool with scopes. */
const markerOf = (table: AnyTable): TableScope | undefined => (scopesOf() ? table.scope : undefined)

const NOBODY = (table: AnyTable) =>
  `Nothing said whose work this is, so ${table.name} can't be reached. Work with nobody signed in runs inside asSystem(...), or carries a grant.`

const NOT_FOUND = 'Record not found'

/** A scope's value as text, or null for an empty one. Scopes are text or keys: nothing else is one. */
function scopeText(value: Scalar | RawRow | undefined): string | null {
  if (Is.isString(value)) {
    return value === '' ? null : value
  }

  return Is.isNumber(value) ? String(value) : null
}

const holds = (held: ScopeAccess['read'], scope: string | null): boolean =>
  held === 'all' || (scope !== null && held.includes(scope))

const writesNothing = (access: ScopeAccess) => access.write !== 'all' && access.write.length === 0

/** The rows of a table an access reaches, as a condition. Undefined when it reaches them all. */
function reach(table: AnyTable, held: ScopeAccess['read']): Predicate | undefined {
  const marker = markerOf(table)

  if (!marker || held === 'all') {
    return undefined
  }

  // A row that hangs off a shared object's record is everyone's.
  return oneOf(marker.column, marker.kind === 'owner' ? [...held, EVERY_SCOPE] : [...held])
}

/** A condition with every table it reaches through a relation narrowed to what can be read. */
function narrowed(table: AnyTable, p: Predicate, access: ScopeAccess): Predicate {
  switch (p.op) {
    case 'and':
    case 'or':
      return { op: p.op, of: p.of.map((part) => narrowed(table, part, access)) }
    case 'not':
      return { op: 'not', of: narrowed(table, p.of, access) }

    case 'related': {
      const target = table.relations[p.relation]?.table()

      if (!target) {
        return p
      }

      const inner = p.where && narrowed(target, p.where, access)
      const rule = reach(target, access.read)
      const where = inner && rule ? and(inner, rule) : (inner ?? rule)
      return where ? { ...p, where } : p
    }

    default:
      return p
  }
}

/** Whether a condition reaches a scoped table through a relation. */
function reaches(table: AnyTable, p: Predicate | undefined): boolean {
  if (!p) {
    return false
  }

  switch (p.op) {
    case 'and':
    case 'or':
      return p.of.some((part) => reaches(table, part))
    case 'not':
      return reaches(table, p.of)

    case 'related': {
      const target = table.relations[p.relation]?.table()
      return !!target && (markerOf(target) !== undefined || reaches(target, p.where))
    }

    default:
      return false
  }
}

/** What an order sorts by when it sorts by a related record's column: the relation, the column and the table it is in. */
function relatedOrder(table: AnyTable, by: OrderBy) {
  if (Is.isString(by) || 'firstOf' in by) {
    return undefined
  }

  const [name, column] = 'related' in by ? by.related : by
  const target = Object.hasOwn(table.relations, name) ? table.relations[name]?.table() : undefined
  return target && { name, column, target, where: 'related' in by ? by.where : undefined }
}

/**
 * An order with every related record it sorts by narrowed to what can be read:
 * a row whose related record is out of reach sorts as one that has none.
 * Without this a list sorted by a relation would be in the order of titles its
 * reader is never shown, and could be read back from where a row lands.
 */
function orderInReach(
  table: AnyTable,
  order: AnyQuery['order'],
  access: ScopeAccess,
): AnyQuery['order'] {
  return order?.map((each): Order => {
    const found = relatedOrder(table, each.by)

    if (!found) {
      return each
    }

    const asked = found.where && narrowed(found.target, found.where, access)
    const rule = reach(found.target, access.read)
    const where = asked && rule ? and(asked, rule) : (asked ?? rule)
    return where ? { ...each, by: { related: [found.name, found.column], where } } : each
  })
}

/** The relations of a table that lead to a scoped object's record, by the column that holds the key. */
const scopedRelations = (table: AnyTable) =>
  Object.entries(table.relations).flatMap(([name, relation]) => {
    const marker = relation.kind === 'one' ? markerOf(relation.table()) : undefined
    return marker?.kind === 'own' ? [{ name, relation, target: relation.table(), marker }] : []
  })

/** Whether a table is an object's (scoped or shared), not one of the CRM's own. */
const isObjectTable = (table: AnyTable): boolean => Object.values(objectTablesNow()).includes(table)

/** Whether a query touches a scoped table at all: its own, one a condition reaches, or one it brings records of. */
const touches = (table: AnyTable, query: AnyQuery, mode: 'read' | 'write' = 'read'): boolean =>
  markerOf(table) !== undefined ||
  // A change to a shared object's record is checked too: whoever writes nothing may not make it.
  (mode === 'write' && isObjectTable(table)) ||
  reaches(table, query.filter) ||
  Object.keys(query.include ?? {}).some((name) => {
    const target = table.relations[name]?.table()
    return !!target && markerOf(target) !== undefined
  }) ||
  (query.order ?? []).some(({ by }) => {
    const found = relatedOrder(table, by)
    return !!found && (markerOf(found.target) !== undefined || reaches(found.target, found.where))
  })

/**
 * Which rows, narrowed to what the access can read or write. Fails when nobody
 * said whose work this is, and for a write by someone who can write nothing.
 */
const scoped = (table: AnyTable, which: AnyQuery, mode: 'read' | 'write') =>
  Effect.flatMap(CurrentAccess, (access): Effect.Effect<AnyWhich, DatabaseError> => {
    if (!scopesOf() || !touches(table, which, mode)) {
      return Effect.succeed(which)
    }

    if (!access) {
      // Work with nobody signed in may still change a shared object's records.
      return markerOf(table) || touches(table, which)
        ? refuse(NOBODY(table))
        : Effect.succeed(which)
    }

    const marker = markerOf(table)
    // A person's own rows (a favourite) are theirs to make and remove wherever they can read.
    const held = mode === 'read' || (marker?.kind === 'owner' && marker.personal) ? 'read' : 'write'

    // Whoever can write nothing changes nothing: a shared object's records included.
    if ((marker || isObjectTable(table)) && held === 'write' && writesNothing(access)) {
      return refuse('You can look at these records, but not change them.')
    }

    const rule = reach(table, access[held])
    const filter = which.filter && narrowed(table, which.filter, access)
    return Effect.succeed({
      where: which.where,
      filter: filter && rule ? and(filter, rule) : (filter ?? rule),
    })
  })

/**
 * The related records a query brings back, with what is out of reach left out.
 * The scope column is asked for with each, to tell, and taken off again when
 * the caller didn't ask for it.
 */
function relatedInReach(table: AnyTable, include: AnyQuery['include'], access: ScopeAccess) {
  const asked: Record<string, 'all' | readonly string[]> = {}
  const checks: { name: string; column: string; added: boolean }[] = []

  for (const [name, wanted] of Object.entries(include ?? {})) {
    const target = table.relations[name]?.table()
    const marker = target && access.read !== 'all' ? markerOf(target) : undefined

    if (!marker) {
      asked[name] = wanted
      continue
    }

    const added = wanted !== 'all' && !wanted.includes(marker.column)
    asked[name] = added ? [...wanted, marker.column] : wanted
    checks.push({ name, column: marker.column, added })
  }

  const hide = (rows: RawRow[]): RawRow[] => {
    for (const row of rows) {
      for (const { name, column, added } of checks) {
        const related = row[name]

        // Anything but a record: nothing was brought back for this row.
        if (
          related === null ||
          related === undefined ||
          related instanceof Date ||
          Is.isString(related) ||
          Is.isNumber(related) ||
          Is.isBoolean(related)
        ) {
          continue
        }

        if (!holds(access.read, scopeText(related[column]))) {
          row[name] = null
        } else if (added) {
          delete related[column]
        }
      }
    }

    return rows
  }

  return { include: include && asked, hide }
}

/** Every object's table in this process's Spool, by the object's key. */
const objectTablesNow = (): Record<string, AnyTable> => {
  const config = globalThis.spoolsSpool?.config
  return config ? objectTables(config) : {}
}

/** The object table a hanging row's record is in, by the object's key. */
const tableOf = (objectKey: string): AnyTable | undefined => {
  const tables = objectTablesNow()
  return Object.hasOwn(tables, objectKey) ? tables[objectKey] : undefined
}

/** A store that keeps to `CurrentAccess`. */
export function guard(store: RawStore): RawStore {
  /**
   * The records a row's relations point at must be ones it may point at: of the
   * row's own scope when the row has one, and within reach of whoever is
   * writing when it has none. One that isn't reads as one that isn't there.
   */
  const relationsInScope = Effect.fn('scope.relationsInScope')(function* (
    table: AnyTable,
    values: RawChanges,
    scope: string | null | undefined,
    access: ScopeAccess,
  ) {
    for (const { relation, target, marker } of scopedRelations(table)) {
      const key = scopeText(values[relation.column])

      if (key === null) {
        continue
      }

      const found = yield* within(
        store.first(target, {
          where: { [target.primary]: key },
          select: [target.primary, marker.column],
        }),
      )

      const theirs = found ? scopeText(found[marker.column]) : null
      const allowed = scope === undefined ? holds(access.read, theirs) : theirs === scope

      if (!found || !allowed) {
        return yield* refuse(NOT_FOUND)
      }
    }

    return undefined
  })

  /** The scope of the record a hanging row is on: the record's own, or everyone's for a shared object's. */
  const ownerScope = Effect.fn('scope.ownerScope')(function* (
    marker: Extract<TableScope, { kind: 'owner' }>,
    values: RawChanges,
    access: ScopeAccess,
  ) {
    const objectKey = scopeText(values[marker.object])
    const recordId = scopeText(values[marker.record])

    // On no record: it belongs to the scope it is made in.
    if (objectKey === null || recordId === null) {
      return access.active
    }

    const owner = tableOf(objectKey)
    const theirs = owner && markerOf(owner)

    if (!owner || theirs?.kind !== 'own') {
      return EVERY_SCOPE
    }

    const record = yield* within(
      store.first(owner, {
        where: { [owner.primary]: recordId },
        select: [owner.primary, theirs.column],
      }),
    )

    const scope = record ? scopeText(record[theirs.column]) : null
    const held = marker.personal ? access.read : access.write

    // A record out of reach reads as one that isn't there.
    if (!record || !holds(held, scope)) {
      return yield* refuse(NOT_FOUND)
    }

    return scope
  })

  const insert: RawStore['insert'] = Effect.fn('scope.insert')(function* (table, values) {
    const marker = markerOf(table)

    if (
      !marker &&
      (!scopesOf() || (scopedRelations(table).length === 0 && !isObjectTable(table)))
    ) {
      return yield* store.insert(table, values)
    }

    const access = yield* CurrentAccess

    // A shared object's record: anyone who can write something may add one. With nobody said, as before.
    if (!marker && scopedRelations(table).length === 0) {
      return access && writesNothing(access)
        ? yield* refuse('You can look at these records, but not add to them.')
        : yield* store.insert(table, values)
    }

    if (!access) {
      return yield* refuse(NOBODY(table))
    }

    if (!marker) {
      if (writesNothing(access)) {
        return yield* refuse('You can look at these records, but not add to them.')
      }

      yield* relationsInScope(table, values, undefined, access)
      return yield* store.insert(table, values)
    }

    if (marker.kind === 'owner') {
      if (!marker.personal && writesNothing(access)) {
        return yield* refuse('You can look at these records, but not add to them.')
      }

      const scope = yield* ownerScope(marker, values, access)
      const held = marker.personal ? access.read : access.write

      if (scope !== EVERY_SCOPE && !holds(held, scope) && !(scope === null && held === 'all')) {
        return yield* refuse(
          scope === null
            ? `Choose a ${label()} to work in first.`
            : 'You can look at these records, but not change them.',
        )
      }

      return yield* store.insert(table, { ...values, [marker.column]: scope })
    }

    if (writesNothing(access)) {
      return yield* refuse('You can look at these records, but not add to them.')
    }

    const scope = scopeText(values[marker.column]) ?? access.active

    if (scope === null) {
      return yield* refuse(`Say which ${label()} this is for.`)
    }

    if (!holds(access.write, scope)) {
      return yield* refuse(`You can't add records to that ${label()}.`)
    }

    const row = { ...values, [marker.column]: scope }
    yield* relationsInScope(table, row, scope, access)
    return yield* store.insert(table, row)
  })

  /** The rows of every hanging table that are on these records, given the records' new scope. */
  const restamp = Effect.fn('scope.restamp')(function* (
    objectKey: string,
    recordIds: readonly string[],
    scope: string,
  ) {
    for (const hanging of systemTables) {
      const marker = hanging.scope

      if (marker?.kind !== 'owner' || recordIds.length === 0) {
        continue
      }

      yield* store.update(
        hanging,
        { where: { [marker.object]: objectKey }, filter: oneOf(marker.record, recordIds) },
        { [marker.column]: scope },
      )
    }
  })

  const update: RawStore['update'] = Effect.fn('scope.update')(function* (table, which, changes) {
    const marker = markerOf(table)
    const related = scopedRelations(table).filter((r) => changes[r.relation.column] !== undefined)
    const moves = marker?.kind === 'own' && changes[marker.column] !== undefined
    const rows = yield* scoped(table, which, 'write')

    if (marker?.kind === 'owner') {
      const access = yield* CurrentAccess
      const says = changes[marker.column] !== undefined
      const onto = [changes[marker.object], changes[marker.record]]

      // A hanging row's scope is its record's. Only the guard, and the system, set it.
      if (says && !access?.system) {
        return yield* refuse(`A row of ${table.name} takes its ${label()} from its record.`)
      }

      // Put onto another record, it takes that record's scope.
      if (!says && access && onto.some((value) => value !== undefined)) {
        if (onto.some((value) => value === undefined)) {
          return yield* refuse('Say both the object and the record a row is moved onto.')
        }

        const scope = yield* ownerScope(marker, changes, access)
        return yield* store.update(table, rows, { ...changes, [marker.column]: scope })
      }

      return yield* store.update(table, rows, changes)
    }

    if (!moves && related.length === 0) {
      return yield* store.update(table, rows, changes)
    }

    const access = yield* CurrentAccess

    if (!access) {
      return yield* refuse(NOBODY(table))
    }

    if (marker?.kind !== 'own') {
      yield* relationsInScope(table, changes, undefined, access)
      return yield* store.update(table, rows, changes)
    }

    const all = scopedRelations(table)

    // Each row is checked as it will be once changed. Inside the caller's transaction, when it has one.
    const matched = yield* within(
      store.find(table, {
        ...rows,
        select: [table.primary, marker.column, ...all.map((r) => r.relation.column)],
      }),
    )

    const moved: string[] = []

    for (const row of matched) {
      const current = scopeText(row[marker.column])
      const next = moves ? scopeText(changes[marker.column]) : current
      const id = scopeText(row[table.primary]) ?? ''

      if (moves && next !== current) {
        if (next === null || !holds(access.write, next)) {
          return yield* refuse(
            next === null
              ? `A record can't be left without a ${label()}.`
              : `You can't move records to that ${label()}.`,
          )
        }

        // What points at it would be left in the scope it came from.
        for (const [, back] of Object.entries(table.relations)) {
          if (back.kind !== 'many' || markerOf(back.table())?.kind !== 'own') {
            continue
          }

          const pointing = yield* within(
            store.count(back.table(), { where: { [back.column]: id } }),
          )

          if (pointing > 0) {
            return yield* refuse(
              `This record can't move to another ${label()} while ${back.table().name} point at it. Move or unlink those first.`,
            )
          }
        }

        // And what it points at, unless this change points it elsewhere.
        const kept = Object.fromEntries(
          all
            .filter((r) => changes[r.relation.column] === undefined)
            .map((r) => [r.relation.column, scopeText(row[r.relation.column])]),
        )

        yield* relationsInScope(table, kept, next, access)
        moved.push(id)
      }

      const pointed = Object.fromEntries(
        related.map((r) => [r.relation.column, changes[r.relation.column]]),
      )

      yield* relationsInScope(table, pointed, next, access)
    }

    const changed = yield* store.update(table, rows, changes)
    const objectKey = Object.entries(objectTablesNow()).find(([, t]) => t === table)?.[0]
    const to = scopeText(changes[marker.column])

    if (moved.length > 0 && objectKey && to !== null) {
      yield* restamp(objectKey, moved, to)
    }

    return changed
  })

  return {
    find: (table, query = {}) =>
      Effect.gen(function* () {
        const which = yield* scoped(table, query, 'read')
        const access = yield* CurrentAccess

        if (!access || !scopesOf()) {
          return yield* store.find(table, { ...query, ...which })
        }

        const related = relatedInReach(table, query.include, access)

        const rows = yield* store.find(table, {
          ...query,
          ...which,
          include: related.include,
          order: orderInReach(table, query.order, access),
        })

        return related.hide(rows)
      }),
    first: (table, query) =>
      Effect.gen(function* () {
        const which = yield* scoped(table, query, 'read')
        const access = yield* CurrentAccess

        if (!access || !scopesOf()) {
          return yield* store.first(table, { ...query, ...which })
        }

        const related = relatedInReach(table, query.include, access)

        const row = yield* store.first(table, {
          ...query,
          ...which,
          include: related.include,
          order: orderInReach(table, query.order, access),
        })

        return row ? (related.hide([row])[0] ?? null) : null
      }),
    count: (table, which = {}) =>
      Effect.flatMap(scoped(table, which, 'read'), (rows) => store.count(table, rows)),
    countValues: (table, column, which) =>
      Effect.flatMap(scoped(table, which, 'read'), (rows) =>
        store.countValues(table, column, { ...rows, atLeast: which.atLeast }),
      ),
    insert,
    update,
    remove: (table, which) =>
      Effect.flatMap(scoped(table, which, 'write'), (rows) => store.remove(table, rows)),
    refreshDates: (table, objectKey, kinds, recordId) =>
      Effect.gen(function* () {
        if (!markerOf(table)) {
          return yield* store.refreshDates(table, objectKey, kinds, recordId)
        }

        const access = yield* CurrentAccess

        if (!access) {
          return yield* refuse(NOBODY(table))
        }

        // Every record of an object: a backfill, which is the system's to run.
        if (recordId === undefined) {
          return access.system
            ? yield* store.refreshDates(table, objectKey, kinds)
            : yield* refuse('Only the system refreshes every record at once.')
        }

        // It is worked out by the database from a bare id, so the record is looked for first.
        const which = yield* scoped(table, { where: { [table.primary]: recordId } }, 'read')

        const there = (yield* within(store.count(table, which))) > 0
        return there ? yield* store.refreshDates(table, objectKey, kinds, recordId) : undefined
      }),
    transaction: store.transaction,
    lock: (table, which) =>
      Effect.flatMap(scoped(table, which, 'write'), (rows) => store.lock(table, rows)),
    ping: store.ping,
  }
}
