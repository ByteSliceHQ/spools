import { type CleanedWhere, createAdapterFactory } from 'better-auth/adapters'
import { Effect, Option, Schema } from 'effect'

import { runServer } from '../../../server/runtime/app'
import {
  and,
  contains,
  endsWith,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  neq,
  not,
  notNull,
  oneOf,
  or,
  type Predicate,
  sameText,
  startsWith,
} from '../../../server/store/query'
import { Store, type StoreShape } from '../../../server/store/store'
import type { AnyTable } from '../../../server/store/table'
import { AuthAccount, AuthSession, AuthUser, AuthVerification } from './tables'

/**
 * Better Auth's database, kept in the Spool's own through the `Store`. It knows
 * no database of its own, so it works on whichever one the Spool uses.
 *
 * How it differs from the adapters that come with Better Auth:
 *
 * - Text matches (`contains`, `starts_with`, `ends_with`) ignore case, because
 *   the store's do. Nothing this adapter switches on uses them (they are for
 *   Better Auth's admin and organization lists). A read may then bring back
 *   rows that differ only in case; a change or a delete, which would reach
 *   them, is refused unless it asked to ignore case. `eq` and `in` are exact.
 * - A change or delete without a condition is refused, as the store refuses it.
 * - A field the tables don't have is refused, not dropped: a value Better Auth
 *   relies on must never go missing quietly.
 * - There are no transactions. Better Auth then runs its steps one by one; the
 *   one that must be a single step (using up a link) is (`consumeOne`).
 */

const tables = {
  user: AuthUser,
  session: AuthSession,
  account: AuthAccount,
  verification: AuthVerification,
} as const

/** Whether Better Auth's model is one this adapter keeps (an own key, so `toString` and the like are not). */
const isModel = (model: string): model is keyof typeof tables => Object.hasOwn(tables, model)

function tableOf(model: string): AnyTable {
  const table = isModel(model) ? tables[model] : undefined

  if (!table) {
    throw new Error(`Better Auth asked for "${model}", which this adapter keeps no table for`)
  }

  return table
}

/** Better Auth's values for a row: its fields, under their names, whatever each one holds. */
const RowValues = Schema.Record(Schema.String, Schema.Unknown)

type RowValues = typeof RowValues.Type

/** Better Auth types a change as anything at all, so what it hands over is read as fields first. */
const readValues = Schema.decodeUnknownOption(RowValues)

/** The values of a row, once every one of them has a column to go in. Something that isn't fields is none. */
function rowOf(table: AnyTable, values: Option.Option<RowValues>): RowValues {
  const row = Option.getOrElse(values, (): RowValues => ({}))

  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined && !Object.hasOwn(table.columns, key)) {
      throw new Error(`Better Auth wants to store "${key}", which ${table.name} has no column for`)
    }
  }

  return row
}

const isText = Schema.is(Schema.String)

const TEXT = { contains, starts_with: startsWith, ends_with: endsWith } as const
const ORDERED = { lt, lte, gt, gte } as const

/** Matches no row, as a comparison with nothing does in SQL. */
const nothing = (field: string): Predicate => oneOf(field, [])

function single({ field, value }: CleanedWhere) {
  if (Array.isArray(value)) {
    throw new Error(`"${field}" is compared with one value, not a list`)
  }

  return value
}

/** One value, or any of a list. */
function among({ field, value, mode }: CleanedWhere): Predicate {
  const values = Array.isArray(value) ? value : value === null ? [] : [value]

  if (mode !== 'insensitive') {
    return oneOf(field, values)
  }

  return or(...values.map((v) => (isText(v) ? sameText(field, v) : eq(field, v))))
}

function same(where: CleanedWhere): Predicate {
  const value = single(where)

  if (value === null) {
    return isNull(where.field)
  }

  return isText(value) && where.mode === 'insensitive'
    ? sameText(where.field, value)
    : eq(where.field, value)
}

function different(where: CleanedWhere): Predicate {
  const value = single(where)

  if (value === null) {
    return notNull(where.field)
  }

  return isText(value) && where.mode === 'insensitive'
    ? not(sameText(where.field, value))
    : neq(where.field, value)
}

function condition(where: CleanedWhere): Predicate {
  const { field, operator } = where

  switch (operator) {
    case 'eq':
      return same(where)
    case 'ne':
      return different(where)
    case 'in':
      return among(where)
    case 'not_in':
      return not(among(where))
    case 'lt':
    case 'lte':
    case 'gt':

    case 'gte': {
      const value = single(where)
      return value === null ? nothing(field) : ORDERED[operator](field, value)
    }

    case 'contains':
    case 'starts_with':

    case 'ends_with': {
      const value = single(where)
      return value === null ? nothing(field) : TEXT[operator](field, String(value))
    }

    default: {
      const unknown: never = operator
      throw new Error(
        `Better Auth asked for a condition this adapter doesn't know: ${String(unknown)}`,
      )
    }
  }
}

/**
 * Better Auth's conditions as one. As in its own SQL adapters, the ones joined
 * with AND must all hold, and so must at least one of those joined with OR.
 */
export function conditions(where: readonly CleanedWhere[] = []): Predicate | undefined {
  const every = where.filter((w) => w.connector !== 'OR').map(condition)
  const some = where.filter((w) => w.connector === 'OR').map(condition)
  const parts = some.length > 0 ? [...every, or(...some)] : every
  return parts.length > 1 ? and(...parts) : parts[0]
}

/** The same, for a change or a delete, which must not reach a row that differs only in case. */
function exactly(where: readonly CleanedWhere[]): Predicate | undefined {
  const loose = where.find((w) => Object.hasOwn(TEXT, w.operator) && w.mode !== 'insensitive')

  if (loose) {
    throw new Error(
      `Refusing to change rows by a text match on "${loose.field}", which ignores case`,
    )
  }

  return conditions(where)
}

/** Better Auth is promises: each operation is a program run on the app's runtime. */
const use = <A, E>(work: (store: StoreShape) => Effect.Effect<A, E>): Promise<A> =>
  runServer(Store.use(work))

export const storeDatabase = createAdapterFactory({
  config: { adapterId: 'spools', adapterName: 'Spools store', transaction: false },
  adapter: () => ({
    create: async ({ model, data }) => {
      const table = tableOf(model)
      return use((store) => store.insert(table, rowOf(table, readValues(data))))
    },

    update: async ({ model, where, update }) => {
      const table = tableOf(model)
      const filter = exactly(where)
      const changes = rowOf(table, readValues(update))
      return use((store) =>
        Effect.gen(function* () {
          const row = yield* store.first(table, { filter, select: ['id'] })

          if (!row) {
            return null
          }

          // Asked again with the change, so a row that stopped matching in between is left alone.
          const changed = yield* store.update(table, { where: { id: row.id }, filter }, changes)
          return changed === 0 ? null : yield* store.first(table, { where: { id: row.id } })
        }),
      )
    },

    updateMany: async ({ model, where, update }) => {
      const table = tableOf(model)
      const filter = exactly(where)
      return use((store) => store.update(table, { filter }, rowOf(table, readValues(update))))
    },

    delete: async ({ model, where }) => {
      const filter = exactly(where)
      await use((store) => store.remove(tableOf(model), { filter }))
    },

    deleteMany: async ({ model, where }) => {
      const filter = exactly(where)
      return use((store) => store.remove(tableOf(model), { filter }))
    },

    // Two callers may both read the row; the delete is one step, and only one of them is told it did it.
    consumeOne: async ({ model, where }) => {
      const table = tableOf(model)
      const filter = exactly(where)
      return use((store) =>
        Effect.gen(function* () {
          const row = yield* store.first(table, { filter })

          if (!row) {
            return null
          }

          const removed = yield* store.remove(table, { where: { id: row.id }, filter })
          return removed === 1 ? row : null
        }),
      )
    },

    findOne: async ({ model, where, select }) => {
      const table = tableOf(model)
      return use((store) =>
        store.first(table, { filter: conditions(where), select: columns(select) }),
      )
    },

    findMany: async ({ model, where, limit, offset, sortBy, select }) => {
      const table = tableOf(model)
      return use((store) =>
        store.find(table, {
          filter: conditions(where),
          order: sortBy ? [{ by: sortBy.field, dir: sortBy.direction }] : undefined,
          limit,
          offset,
          select: columns(select),
        }),
      )
    },

    count: async ({ model, where }) =>
      use((store) => store.count(tableOf(model), { filter: conditions(where) })),
  }),
})

/** The columns to bring back: the ones asked for and the id, or all of them. */
const columns = (select: readonly string[] | undefined) =>
  select && select.length > 0 ? [...new Set(['id', ...select])] : undefined
