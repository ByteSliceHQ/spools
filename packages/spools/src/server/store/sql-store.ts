import { Effect, type Layer, Predicate } from 'effect'
import { SqlClient, SqlError } from 'effect/sql'

import { DatabaseError } from '../runtime/errors'
import type { Scalar } from './query'
import {
  countSql,
  countValuesSql,
  decode,
  insertSql,
  lockSql,
  placeholders,
  refreshDatesSql,
  removeSql,
  type Sql,
  selectSql,
  updateSql,
} from './sql'
import {
  type Backend,
  type RawQuery,
  type RawRow,
  type Store,
  storeLayer,
  type Transact,
  TransactionFailed,
} from './store'
import type { AnyTable, Relation } from './table'

/**
 * A store over any Postgres that can run SQL. `sqlStore` is the layer for
 * Effect's `SqlClient`, so any of its Postgres drivers will do (a pool, an
 * in-process PGlite). `sqlBackend` is the same for anything else that can run
 * a statement and a transaction.
 */

/**
 * A row as a driver gives it back for a statement sql.ts writes. Those only
 * read columns of the kinds a table has (table.ts), with days and money cast
 * to text and counts to numbers, so each value is text, a number, a yes/no, a
 * moment or empty. It is in the driver's own form (a moment may be text, a
 * yes/no "t") until `decode` reads it as its table describes.
 */
export type DriverRow = { readonly [column: string]: Scalar }

/** Runs one statement and answers with its rows. */
export type RunSql<E = DatabaseError> = (sql: Sql) => Effect.Effect<readonly DriverRow[], E>

/** Ids are looked up this many at a time, to keep a statement's parameters within bounds. */
const CHUNK = 500

function decodeRow(table: AnyTable, row: DriverRow): RawRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]): [string, Scalar] => {
      const column = table.columns[key]
      return [key, column ? decode(column.kind, value) : value]
    }),
  )
}

/** A key as text, as ids are: a key column holds text, or a number. Nothing for an empty one. */
function keyText(value: Scalar | RawRow | undefined): string | undefined {
  if (Predicate.isString(value) || Predicate.isNumber(value)) {
    return value ? String(value) : undefined
  }

  return undefined
}

/** A relation whose key is on this table: the only kind `include` can bring the records of. */
const heldHere = (table: AnyTable, name: string): Effect.Effect<Relation> => {
  const relation = table.relations[name]

  return relation?.kind === 'one'
    ? Effect.succeed(relation)
    : Effect.die(new Error(`Can't include "${name}" of ${table.name}`))
}

/**
 * A store's backend from two things a Postgres driver can do: run one
 * statement, and run a program as a transaction (`callbackTransaction` in
 * store.ts makes the second from a driver's `begin(async (tx) => ...)`).
 */
export function sqlBackend<E>(run: RunSql<E>, transaction: Transact): Backend<E> {
  const select = (table: AnyTable, query: RawQuery): Effect.Effect<RawRow[], E> =>
    Effect.map(run(selectSql(table, query)), (rows) => rows.map((row) => decodeRow(table, row)))

  /** The records one relation of these rows leads to, put on each row. */
  const include = Effect.fn('sqlStore.include')(function* (
    table: AnyTable,
    rows: RawRow[],
    name: string,
    wanted: 'all' | readonly string[],
  ) {
    const relation = yield* heldHere(table, name)
    const target = relation.table()

    const ids = [...new Set(rows.flatMap((row) => keyText(row[relation.column]) ?? []))]

    const chunks: string[][] = []

    for (let at = 0; at < ids.length; at += CHUNK) {
      chunks.push(ids.slice(at, at + CHUNK))
    }

    const found = yield* Effect.forEach(
      chunks,
      (values) =>
        select(target, {
          predicate: { op: 'in', column: target.primary, values },
          order: undefined,
          limit: undefined,
          offset: undefined,
          select: wanted === 'all' ? undefined : [...new Set([target.primary, ...wanted])],
          include: undefined,
        }),
      { concurrency: 'unbounded' },
    )

    const byId = new Map(found.flat().map((row) => [keyText(row[target.primary]), row]))

    for (const row of rows) {
      row[name] = byId.get(keyText(row[relation.column])) ?? null
    }
  })

  return {
    find: Effect.fn('sqlStore.find')(function* (table: AnyTable, query: RawQuery) {
      const rows = yield* select(table, query)

      yield* Effect.forEach(
        Object.entries(query.include ?? {}),
        ([name, wanted]) => include(table, rows, name, wanted),
        { concurrency: 'unbounded', discard: true },
      )

      return rows
    }),
    count: (table, predicate) =>
      Effect.map(run(countSql(table, predicate)), (rows) => Number(rows[0]?.['n'] ?? 0)),
    countValues: (table, column, predicate, atLeast) =>
      Effect.map(run(countValuesSql(table, column, predicate, atLeast)), (rows) =>
        rows.flatMap((row) =>
          row['value'] === null
            ? []
            : [{ value: String(row['value']), count: Number(row['n'] ?? 0) }],
        ),
      ),
    insert: (table, row) =>
      Effect.map(run(insertSql(table, row)), (rows) => decodeRow(table, rows[0] ?? {})),
    update: (table, predicate, changes) =>
      Effect.map(run(updateSql(table, predicate, changes)), (rows) => rows.length),
    remove: (table, predicate) =>
      Effect.map(run(removeSql(table, predicate)), (rows) => rows.length),
    refreshDates: (table, objectKey, kinds, recordId) =>
      Effect.asVoid(run(refreshDatesSql(table, objectKey, kinds, recordId))),
    lock: (table, predicate) => Effect.map(run(lockSql(table, predicate)), (rows) => rows.length),
    transaction,
    ping: run({ parts: ['SELECT 1'], params: [] }),
  }
}

/** What the database itself said, without the client's wrapping. Staff see a driver's own message. */
const driverCause = (error: SqlError.SqlError) => error.reason.cause ?? error

/** The store over whichever `SqlClient` is provided. */
export const sqlStore: Layer.Layer<Store, never, SqlClient.SqlClient> = storeLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return sqlBackend(
      (query) => {
        const { text, params } = placeholders(query)

        // The rows are what this client gives back for the statements sql.ts writes (`DriverRow`).
        return sql
          .unsafe<DriverRow>(text, params)
          .pipe(Effect.mapError((error) => new DatabaseError({ cause: driverCause(error) })))
      },
      // The client keeps the transaction's connection for everything the program runs.
      (program) =>
        sql
          .withTransaction(program)
          .pipe(
            Effect.mapError((error) =>
              error instanceof SqlError.SqlError
                ? new TransactionFailed(driverCause(error))
                : error,
            ),
          ),
    )
  }),
)
