import { type Cause, Context, Effect, Exit, Layer } from 'effect'
import type { HttpClient } from 'effect/http'

import type { Adapter } from '../runtime/adapter'
import { DatabaseError, type Timeout } from '../runtime/errors'
import { policies, withPolicy } from '../runtime/policies'
import type { Predicate, Query, Scalar, Which } from './query'
import { guard } from './scope'
import type { AnyTable, Table } from './table'

/**
 * The store: where a Spool's records and system tables are kept. Server code
 * reaches the database only through this service, in terms of tables
 * (tables.ts, objects.ts) and conditions (query.ts):
 *
 *   const store = yield* Store;
 *   const open = yield* store.find(Task, { where: { assigneeId }, filter: isNull("completedAt") });
 *
 * Adapters are in src/adapters/database/. An adapter implements `Backend` and
 * wraps it with `makeStore`, which adds what is the same for every database:
 * reads have the time limit from policies.ts, writes have none (giving up on a
 * write leaves its outcome unknown), and a failure is a `DatabaseError`.
 *
 * Writes that belong together go in `store.transaction`: all of them are kept,
 * or none.
 */

/** What a query brings back: the columns it selected. A table whose columns aren't known until run time keeps its whole row type. */
type Found<Row, S extends keyof Row> = string extends keyof Row ? Row : Pick<Row, S>

type Read<A> = Effect.Effect<A, DatabaseError | Timeout>
type Write<A> = Effect.Effect<A, DatabaseError>

/** A value of a column and how many rows hold it. */
export type ValueCount = { value: string; count: number }

/** Which activities count towards an object's derived dates (`refreshDates`). */
export type DateKinds = {
  /** Kinds of activity that count as activity. */
  activity: readonly string[]
  /** Kinds that count as contact with the person. */
  contact: readonly string[]
}

export type StoreShape = {
  /** The rows that match, in order. Without an order, whatever order the database likes. */
  readonly find: <Row, Insert, S extends keyof Row = keyof Row>(
    table: Table<Row, Insert>,
    query?: Query<Row, S>,
  ) => Read<Found<Row, S>[]>
  /** The first row that matches, or null. */
  readonly first: <Row, Insert, S extends keyof Row = keyof Row>(
    table: Table<Row, Insert>,
    query: Query<Row, S>,
  ) => Read<Found<Row, S> | null>
  readonly count: <Row, Insert>(table: Table<Row, Insert>, which?: Which<Row>) => Read<number>
  /** How many of the rows that match hold each value of a text column, for values held by `atLeast` of them. */
  readonly countValues: <Row, Insert>(
    table: Table<Row, Insert>,
    column: keyof Row & string,
    which: Which<Row> & { atLeast: number },
  ) => Read<ValueCount[]>
  /** Add a row. Breaking a uniqueness rule is a `DatabaseError`; catch it and look for the row that won. */
  readonly insert: <Row, Insert>(table: Table<Row, Insert>, values: Insert) => Write<Row>
  /**
   * Change every row that matches, in one statement, and say how many there
   * were. The check and the change are one step: of two callers that ask for
   * the same change to a row, exactly one is told it made it.
   */
  readonly update: <Row, Insert>(
    table: Table<Row, Insert>,
    which: Which<Row>,
    changes: Partial<Insert>,
  ) => Write<number>
  /** Delete every row that matches, and say how many there were. */
  readonly remove: <Row, Insert>(table: Table<Row, Insert>, which: Which<Row>) => Write<number>
  /**
   * Work out an object's "last activity", "last contacted" and "next task due"
   * from its activities and open tasks, for one record or (without `recordId`)
   * all of them. Not a change to the record: `updatedAt` stays as it was.
   */
  readonly refreshDates: (
    table: AnyTable,
    objectKey: string,
    kinds: DateKinds,
    recordId?: string,
  ) => Write<void>
  /**
   * Runs a program so that everything it writes is kept, or none of it is: a
   * failure, a bug or the request going away undoes what it had written. Its
   * reads see its own writes. A transaction started inside another is part of
   * the outer one.
   *
   * Keep it to store calls. An app's hooks run outside it: their code reaches
   * the store on another connection, which can't see what isn't kept yet and,
   * on a database with one connection (PGlite), would wait for ever.
   */
  readonly transaction: <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DatabaseError, R>
  /**
   * Holds the rows that match until the transaction this is called in ends:
   * anyone else who wants to change or hold them waits. For reading a row and
   * then writing something that depends on what was read. Says how many rows
   * are held. Outside a transaction it holds nothing.
   */
  readonly lock: <Row, Insert>(table: Table<Row, Insert>, which: Which<Row>) => Write<number>
  /** One small read, to open (or keep open) a connection. Says whether the database answered. */
  readonly ping: Effect.Effect<boolean>
}

export class Store extends Context.Service<Store, StoreShape>()('spools/Store') {}

/** A database adapter provides the `Store`, so it can't ask for one. */
export type StoreAdapter = Omit<Adapter<Store>, 'layer'> & {
  readonly layer: Layer.Layer<Store, never, HttpClient.HttpClient>
}

/** A query with its types gone: what a backend is handed. */
export type RawQuery = {
  readonly predicate: Predicate | undefined
  readonly order: Query<unknown>['order']
  readonly limit: number | undefined
  readonly offset: number | undefined
  readonly select: readonly string[] | undefined
  readonly include: Query<unknown>['include']
}

/** A row's columns with their types gone: what a backend is given to write, each value as its column holds it (table.ts). */
export type RawValues = { readonly [column: string]: Scalar }

/** Values for some of a row's columns, as a caller gives them: `undefined` says nothing about its column. */
export type RawChanges = { readonly [column: string]: Scalar | undefined }

/**
 * A row with its types gone: what a backend finds. Each column's value is as
 * its table describes it (table.ts); under the name of a relation `include`
 * asked for is the record it leads to, or null.
 */
export type RawRow = { [key: string]: Scalar | RawRow }

/** The database couldn't begin, finish or undo a transaction. `cause` is what the driver said. */
export class TransactionFailed {
  readonly _tag = 'TransactionFailed'
  constructor(readonly cause: unknown) {}
}

/** Runs a program as one transaction: everything it writes is kept, or none of it is. */
export type Transact = <A, E, R>(
  program: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | TransactionFailed, R>

/** A transaction for a driver whose own takes a callback (`callbackTransaction`). */
export type CallbackTransaction<Tx> = {
  /** Runs a program inside one of the driver's transactions. */
  readonly transact: Transact
  /** The connection a statement should use: the transaction's while the program is in one, or null. */
  readonly current: Effect.Effect<Tx | null>
}

/**
 * A transaction for a driver whose own takes a callback
 * (`sql.begin(async (tx) => ...)`, Prisma's `client.transaction`). `transact`
 * runs a program inside one, and undoes it when the program fails or is
 * interrupted. `current` is the connection a statement should use: the
 * transaction's while the program is in one, or null.
 */
export function callbackTransaction<Tx>(
  begin: <A>(work: (tx: Tx) => Promise<A>) => PromiseLike<A>,
): CallbackTransaction<Tx> {
  const current = Context.Reference<Tx | null>(`spools/Store/transaction/${crypto.randomUUID()}`, {
    defaultValue: () => null,
  })

  const transact: Transact = <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | TransactionFailed, R> =>
    Effect.flatMap(Effect.context<R>(), (context) => {
      // Why the program stopped, kept here: the driver only needs to see a throw to undo its work.
      let stopped: Cause.Cause<E> | undefined

      return Effect.tryPromise({
        try: async (signal) =>
          await begin(async (tx) => {
            const exit = await Effect.runPromiseExitWith(context)(
              Effect.provideService(program, current, tx),
              { signal },
            )

            if (Exit.isSuccess(exit)) {
              return exit.value
            }

            // The driver undoes its transaction when the work it was given rejects. What the
            // caller is told is why the program stopped, kept in `stopped`, not this.
            stopped = exit.cause
            return Promise.reject(new Error('The transaction was undone'))
          }),
        catch: (thrown) => new TransactionFailed(thrown),
      }).pipe(
        Effect.catch((failed): Effect.Effect<never, E | TransactionFailed> =>
          stopped ? Effect.failCause(stopped) : Effect.fail(failed),
        ),
      )
    })

  return { transact, current }
}

/**
 * What a database adapter implements. Rows go in and come out as the table's
 * columns say (table.ts): ids, timestamps and defaults are already filled in on
 * the way in. A failure is the backend's own `E`, a `DatabaseError` unless it
 * says otherwise; the store makes any other failure a `DatabaseError` with it
 * as the cause.
 */
export type Backend<E = DatabaseError> = {
  readonly find: (table: AnyTable, query: RawQuery) => Effect.Effect<RawRow[], E>
  readonly count: (table: AnyTable, predicate: Predicate | undefined) => Effect.Effect<number, E>
  readonly countValues: (
    table: AnyTable,
    column: string,
    predicate: Predicate | undefined,
    atLeast: number,
  ) => Effect.Effect<ValueCount[], E>
  readonly insert: (table: AnyTable, row: RawValues) => Effect.Effect<RawRow, E>
  readonly update: (
    table: AnyTable,
    predicate: Predicate,
    changes: RawValues,
  ) => Effect.Effect<number, E>
  readonly remove: (table: AnyTable, predicate: Predicate) => Effect.Effect<number, E>
  readonly refreshDates: (
    table: AnyTable,
    objectKey: string,
    kinds: DateKinds,
    recordId: string | undefined,
  ) => Effect.Effect<void, E>
  /** Hold the matching rows until the transaction ends (`SELECT ... FOR UPDATE`), and say how many. */
  readonly lock: (table: AnyTable, predicate: Predicate) => Effect.Effect<number, E>
  /** Run a program as one transaction. Never asked for one inside another. */
  readonly transaction: Transact
  /** One small read. What it answers with doesn't matter, only that it does. */
  readonly ping: Effect.Effect<unknown, E>
}

/** Whether the program running is inside `store.transaction`. */
const InTransaction = Context.Reference<boolean>('spools/Store/inTransaction', {
  defaultValue: () => false,
})

/** Which rows, with the types gone. */
type AnyWhich = {
  readonly where?: Readonly<Record<string, Scalar | undefined>>
  readonly filter?: Predicate
}
type AnyQuery = AnyWhich &
  Pick<Query<unknown>, 'order' | 'limit' | 'offset' | 'include'> & {
    readonly select?: readonly string[]
  }

/** `where` and `filter` as one condition. */
export function predicateOf(which: AnyWhich): Predicate | undefined {
  const parts = Object.entries(which.where ?? {}).flatMap(([column, value]): Predicate[] => {
    if (value === undefined) {
      return []
    }

    return [value === null ? { op: 'null', column } : { op: 'eq', column, value }]
  })

  if (which.filter) {
    parts.push(which.filter)
  }

  if (parts.length === 0) {
    return undefined
  }

  return parts.length === 1 ? parts[0] : { op: 'and', of: parts }
}

/** A new row: what was given, with ids, times, defaults and empty columns filled in. */
export function newRow(table: AnyTable, values: RawChanges, now: Date): RawValues {
  return Object.fromEntries(
    Object.entries(table.columns).map(([key, c]): [string, Scalar] => {
      const given = values[key]

      if (given !== undefined) {
        return [key, given]
      }

      if (c.auto === 'id') {
        return [key, crypto.randomUUID()]
      }

      if (c.auto === 'created' || c.auto === 'updated') {
        return [key, now]
      }

      return [key, c.default ?? null]
    }),
  )
}

/** The columns a change touches, with the time it was made. Keys that aren't columns are dropped. */
export function changedRow(table: AnyTable, changes: RawChanges, now: Date): RawValues {
  const row = new Map<string, Scalar>()

  for (const [key, value] of Object.entries(changes)) {
    if (Object.hasOwn(table.columns, key) && value !== undefined) {
      row.set(key, value)
    }
  }

  for (const [key, c] of Object.entries(table.columns)) {
    if (c.auto === 'updated' && !row.has(key)) {
      row.set(key, now)
    }
  }

  return Object.fromEntries(row)
}

/** A backend's failure as a `DatabaseError`: its own, or a new one with it as the cause. */
const asDatabaseError = (cause: unknown): DatabaseError =>
  cause instanceof DatabaseError ? cause : new DatabaseError({ cause })

/** A read: the time limit from policies.ts, a typed failure and a span. */
const read = <A, E>(name: string, work: Effect.Effect<A, E>): Read<A> =>
  work.pipe(
    Effect.mapError(asDatabaseError),
    withPolicy(policies.databaseRead),
    Effect.withSpan(`Store.${name}`),
  )

/** A write: a typed failure and a span, and no time limit (giving up on a write leaves its outcome unknown). */
const write = <A, E>(name: string, work: Effect.Effect<A, E>): Write<A> =>
  work.pipe(Effect.mapError(asDatabaseError), Effect.withSpan(`Store.${name}`))

// A write with no condition would reach every row. Nothing in the CRM means that.
const required = (which: AnyWhich, verb: string): Effect.Effect<Predicate> => {
  const predicate = predicateOf(which)
  return predicate
    ? Effect.succeed(predicate)
    : Effect.die(new Error(`Refusing to ${verb} every row of a table`))
}

/** A store over a backend: time limits, typed failures and spans, the same for every database. */
export function makeStore<BackendError>(backend: Backend<BackendError>): StoreShape {
  const find = (table: AnyTable, query: AnyQuery = {}): Read<RawRow[]> =>
    read(
      'find',
      Effect.suspend(() =>
        backend.find(table, {
          predicate: predicateOf(query),
          order: query.order,
          limit: query.limit,
          offset: query.offset,
          select: query.select,
          include: query.include,
        }),
      ),
    )

  const shape = {
    find,
    first: (table: AnyTable, query: AnyQuery): Read<RawRow | null> =>
      Effect.map(find(table, { ...query, limit: 1 }), (rows) => rows[0] ?? null),
    count: (table: AnyTable, which: AnyWhich = {}) =>
      read(
        'count',
        Effect.suspend(() => backend.count(table, predicateOf(which))),
      ),
    countValues: (table: AnyTable, column: string, which: AnyWhich & { atLeast: number }) =>
      read(
        'countValues',
        Effect.suspend(() => backend.countValues(table, column, predicateOf(which), which.atLeast)),
      ),
    insert: (table: AnyTable, values: RawChanges) =>
      write(
        'insert',
        Effect.suspend(() => backend.insert(table, newRow(table, values, new Date()))),
      ),
    update: (table: AnyTable, which: AnyWhich, changes: RawChanges) =>
      write(
        'update',
        Effect.flatMap(required(which, 'change'), (predicate) =>
          backend.update(table, predicate, changedRow(table, changes, new Date())),
        ),
      ),
    remove: (table: AnyTable, which: AnyWhich) =>
      write(
        'remove',
        Effect.flatMap(required(which, 'delete'), (predicate) => backend.remove(table, predicate)),
      ),
    refreshDates: (table: AnyTable, objectKey: string, kinds: DateKinds, recordId?: string) =>
      write('refreshDates', backend.refreshDates(table, objectKey, kinds, recordId)),
    lock: (table: AnyTable, which: AnyWhich) =>
      write(
        'lock',
        Effect.flatMap(required(which, 'hold'), (predicate) => backend.lock(table, predicate)),
      ),
    transaction: <A, E, R>(program: Effect.Effect<A, E, R>) =>
      Effect.flatMap(InTransaction, (inside) =>
        inside
          ? program
          : backend.transaction(Effect.provideService(program, InTransaction, true)).pipe(
              Effect.mapError((error) =>
                error instanceof TransactionFailed ? asDatabaseError(error.cause) : error,
              ),
              Effect.withSpan('Store.transaction'),
            ),
      ),
    ping: read('ping', backend.ping).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logError('[store] ping failed', error.message).pipe(Effect.as(false)),
      ),
    ),
  }

  // SAFETY: `shape` is the store on rows with their types gone; StoreShape is the same store
  // with each table's row and insert types on it. A table's row type is worked out from its
  // columns (`defineTable` in table.ts, `CrmRecord` for an object's table in objects.ts), and
  // every backend gives each column's value back as that column describes it: sql-store.ts
  // reads them with `decode`, the Prisma adapter checks them with `isRawRow`. What is written
  // is an insert type's values, each a column's and so a `Scalar`; an object's inserts are
  // typed loosely (`ObjectTable`) and are the values its schema checked (records.ts).
  // TypeScript can't follow this: a `Table` keeps its columns as data, not in its type.
  //
  // Every store is made here, so this is where record scopes are kept (scope.ts).
  return guard(shape as StoreShape)
}

/**
 * The `Store` over the backend a program makes: a database adapter's layer.
 * The program can ask for what the backend needs (a client) and add finalizers,
 * which run when the layer is closed.
 */
export const storeLayer = <E, Failure, R>(backend: Effect.Effect<Backend<E>, Failure, R>) =>
  Layer.effect(
    Store,
    Effect.map(backend, (made) => Store.of(makeStore(made))),
  )
