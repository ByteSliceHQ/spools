import { and, not, or } from '@prisma/orm-postgres/orm-client'
import postgresClient from '@prisma/orm-postgres/runtime'
import { contractFromJson } from '@prisma/orm-postgres/static'
import { tsquery, websearchToTsquery } from '@prisma/orm-postgres/target/full-text'
import { Effect } from 'effect'
import { isBoolean, isNumber, isObject, isString } from 'effect/Predicate'

import * as config from '../../../server/runtime/config'
import { DatabaseError } from '../../../server/runtime/errors'
import type { Order, Predicate, Scalar } from '../../../server/store/query'
import {
  lockSql,
  type Param,
  refreshDatesSql,
  relatedOrderText,
  removeSql,
  type Sql,
  updateSql,
} from '../../../server/store/sql'
import {
  type Backend,
  callbackTransaction,
  type RawQuery,
  type RawRow,
  type RawValues,
  type StoreAdapter,
  storeLayer,
} from '../../../server/store/store'
import type { AnyTable, Kind } from '../../../server/store/table'
import { DATABASE_URL, databaseUrl } from '../postgres/server'

/**
 * Postgres through the Prisma 8 client. Reads and inserts go through the ORM;
 * changes and deletes are one SQL statement each, because the ORM's
 * `where(...).update()` reads and then writes, and the store promises that a
 * check and a change are one step. A transaction is the client's own, and
 * everything a program runs inside one goes through it.
 *
 *   DATABASE_URL (or POSTGRES_URL)   the connection string
 *
 * `contract` is the app's generated prisma/schema.json.
 */

// ── The slice of the Prisma 8 client this adapter uses ──────────────────────
// Models are reached by name at run time, so the generated types don't help here.

declare const made: unique symbol
/** Something Prisma makes that this adapter only hands back to it: an order, a count, a statement. */
type Made<Name extends string> = { readonly [made]?: Name }

type PrismaPredicate = Parameters<typeof or>[number]
type TextQuery = ReturnType<typeof websearchToTsquery>
type Direction = (options?: { nulls: 'first' | 'last' }) => Made<'order'>
type DynColumn = Record<
  'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte',
  (value: Param) => PrismaPredicate
> & {
  ilike(pattern: string): PrismaPredicate
  in(values: readonly Param[]): PrismaPredicate
  isNull(): PrismaPredicate
  isNotNull(): PrismaPredicate
  asc: Direction
  desc: Direction
}
type DynRelation = Record<
  'some' | 'none',
  (test?: (related: DynModel, extra: Extra) => PrismaPredicate) => PrismaPredicate
> &
  Record<string, DynColumn>
type DynModel = Record<string, DynColumn & DynRelation>
type Extra = {
  fns: {
    ilike(value: DynColumn, pattern: string): PrismaPredicate
    fullTextMatches(index: Made<'index'> | undefined, query: TextQuery): PrismaPredicate
    raw(
      strings: TemplateStringsArray,
      ...values: DynColumn[]
    ): { returns(codec: string): DynColumn }
  }
  indexes: Record<string, Made<'index'>>
}
type Counts = (a: { count(): Made<'count'> }) => Readonly<Record<string, Made<'count'>>>
/** Rows are objects until they are checked (`rowsRead`): Prisma doesn't say what is in them here. */
type Collection = {
  where(filter: (model: DynModel, extra: Extra) => PrismaPredicate): Collection
  include(relation: string, refine?: (related: Collection) => Collection): Collection
  select(...fields: string[]): Collection
  orderBy(order: ((model: DynModel, extra: Extra) => Made<'order'>)[]): Collection
  groupBy(field: string): {
    having(test: (h: { count(): { gte(n: number): Made<'having'> } }) => Made<'having'>): {
      aggregate(spec: Counts): Promise<readonly object[]>
    }
  }
  limit(n: number): Collection
  offset(n: number): Collection
  all(): PromiseLike<readonly object[]>
  create(data: RawValues): Promise<object>
  aggregate(spec: Counts): Promise<object>
}
/** What runs statements: the client, or a transaction of its. */
type Queries = {
  orm: { public?: Record<string, Collection | undefined> }
  raw: {
    sql(
      strings: TemplateStringsArray,
      ...values: Param[]
    ): { affectedCount(): { build(): Made<'statement'> } }
  }
  execute(plan: Made<'statement'>): Promise<{ readonly affectedRows?: number }>
}
type Client = Queries & {
  transaction<A>(work: (tx: Queries) => PromiseLike<A>): Promise<A>
  close(): Promise<void>
}

const template = (parts: readonly string[]): TemplateStringsArray =>
  Object.assign([...parts], { raw: [...parts] })

function collection(client: Queries, table: AnyTable): Collection {
  const found = client.orm.public?.[table.model]

  if (!found) {
    throw new Error(`No Prisma model "${table.model}". Run \`bun run crm:gen\`.`)
  }

  return found
}

function columnOf(model: Readonly<Record<string, DynColumn>>, key: string): DynColumn {
  const column = model[key]

  if (!column) {
    throw new Error(`No column "${key}"`)
  }

  return column
}

const literalLike = (text: string) => text.replace(/[\\%_]/g, (m) => `\\${m}`)

const PATTERN = {
  contains: (text: string) => `%${literalLike(text)}%`,
  starts: (text: string) => `${literalLike(text)}%`,
  ends: (text: string) => `%${literalLike(text)}`,
  exact: literalLike,
} as const

const isScalar = (value: unknown): value is Scalar =>
  value === null || isString(value) || isNumber(value) || isBoolean(value) || value instanceof Date

/** Whether Prisma gave back a row the store can read: column values (table.ts), and the records `include` brought. */
function isRawRow(value: unknown): value is RawRow {
  return (
    isObject(value) &&
    !(value instanceof Date) &&
    Object.values(value).every((inside) => isScalar(inside) || isRawRow(inside))
  )
}

const unreadable = () =>
  new DatabaseError({ cause: new Error('Prisma gave back a row the store cannot read') })

/** Prisma's rows, checked where they come in: a value that isn't a column's is a failure. */
const rowsRead = (rows: readonly object[]): Effect.Effect<RawRow[], DatabaseError> =>
  rows.every(isRawRow) ? Effect.succeed([...rows]) : Effect.fail(unreadable())

/** Every word, with the last one allowed to be unfinished, against the index the schema declares. */
function fullText(table: AnyTable, text: string, { fns, indexes }: Extra): PrismaPredicate {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const last = words.at(-1) ?? ''
  const lead = words.length > 1 ? websearchToTsquery(words.slice(0, -1).join(' ')) : undefined
  const index = indexes[table.search?.name ?? '']
  const prefix = fns.fullTextMatches(index, tsquery`${last}:*`)
  return or(
    fns.fullTextMatches(index, websearchToTsquery(text)),
    lead ? and(fns.fullTextMatches(index, lead), prefix) : prefix,
  )
}

function compile(table: AnyTable, m: DynModel, p: Predicate, extra: Extra): PrismaPredicate {
  switch (p.op) {
    case 'and':
      return and(...p.of.map((part) => compile(table, m, part, extra)))
    case 'or':
      return or(...p.of.map((part) => compile(table, m, part, extra)))
    case 'not':
      return not(compile(table, m, p.of, extra))
    case 'null':
      return columnOf(m, p.column).isNull()
    case 'notNull':
      return columnOf(m, p.column).isNotNull()
    case 'in':
      return columnOf(m, p.column).in(p.values)
    case 'text':
      return columnOf(m, p.column).ilike(PATTERN[p.match](p.text))

    case 'digits': {
      const bare = extra.fns
        .raw`regexp_replace(${columnOf(m, p.column)}, '[^0-9]', '', 'g')`.returns('pg/text@1')

      return extra.fns.ilike(bare, `%${p.digits.replace(/\D/g, '')}%`)
    }

    case 'search':
      return fullText(table, p.text, extra)

    case 'related': {
      const relation = m[p.relation]
      const target = table.relations[p.relation]?.table()

      if (!relation || !target) {
        throw new Error(`No relation "${p.relation}" on ${table.name}`)
      }

      const { where } = p

      const inner =
        where &&
        ((related: DynModel, relatedExtra: Extra) =>
          compile(target, related, where, relatedExtra ?? extra))

      return p.some ? relation.some(inner) : relation.none(inner)
    }

    default:
      return columnOf(m, p.column)[p.op](p.value)
  }
}

/** What a raw expression gives back, by the kind of column it reads. Only the kinds a record's title is. */
const RAW_CODEC: Partial<Record<Kind, string>> = {
  text: 'pg/text@1',
  timestamp: 'pg/timestamptz@1',
}

function ordering(table: AnyTable, { by, dir, nulls }: Order) {
  const options = nulls ? ([{ nulls }] as const) : ([] as const)

  return (m: DynModel, { fns }: Extra) => {
    if (isString(by)) {
      return columnOf(m, by)[dir](...options)
    }

    if ('firstOf' in by) {
      const parts = by.firstOf.map((_, i) => (i === 0 ? 'coalesce(' : ', '))
      const columns = by.firstOf.map((key) => columnOf(m, key))
      const first = fns.raw(template([...parts, ')']), ...columns).returns('pg/timestamptz@1')
      return first[dir](...options)
    }

    // A related record's column, but only of a record that meets a condition (the scope guard's:
    // scope.ts). The ORM's own order by a relation takes no condition, so this is the subselect
    // sql.ts writes, with nothing left out: an order it can't write this way is refused.
    if ('related' in by) {
      const text = relatedOrderText(table, by)
      const codec = RAW_CODEC[text.kind]

      if (!codec) {
        throw new Error(`Can't sort by a related record's ${text.kind} column here`)
      }

      const related = fns.raw(template(text.parts), columnOf(m, text.key)).returns(codec)
      return related[dir](...options)
    }

    const [relation, key] = by
    const related = m[relation]

    if (!related) {
      throw new Error(`No relation "${relation}"`)
    }

    return columnOf(related, key)[dir](...options)
  }
}

function backend(client: () => Client): Backend {
  const transaction = callbackTransaction<Queries>((work) => client().transaction(work))

  // Inside a transaction every statement is the transaction's; otherwise the client's.
  const attempt = <A>(work: (client: Queries) => PromiseLike<A>): Effect.Effect<A, DatabaseError> =>
    Effect.flatMap(transaction.current, (tx) =>
      Effect.tryPromise({
        try: async () => await work(tx ?? client()),
        catch: (cause) => new DatabaseError({ cause }),
      }),
    )

  const matching = (c: Queries, table: AnyTable, predicate: Predicate | undefined) => {
    const all = collection(c, table)
    return predicate ? all.where((m, extra) => compile(table, m, predicate, extra)) : all
  }

  const changed = ({ parts, params }: Sql) =>
    attempt((c) =>
      c.execute(
        c.raw
          .sql(template(parts), ...params)
          .affectedCount()
          .build(),
      ),
    ).pipe(Effect.map((result) => result.affectedRows ?? 0))

  return {
    find: (table, query: RawQuery) =>
      attempt((c) => {
        let q = matching(c, table, query.predicate)

        if (query.select) {
          const keys = Object.keys(query.include ?? {}).flatMap(
            (name) => table.relations[name]?.column ?? [],
          )

          q = q.select(...new Set([...query.select, ...keys]))
        }

        for (const [name, wanted] of Object.entries(query.include ?? {})) {
          q =
            wanted === 'all'
              ? q.include(name)
              : q.include(name, (related) => related.select('id', ...wanted))
        }

        if (query.order?.length) {
          q = q.orderBy(query.order.map((order) => ordering(table, order)))
        }

        if (query.limit !== undefined) {
          q = q.limit(query.limit)
        }

        if (query.offset) {
          q = q.offset(query.offset)
        }

        return q.all()
      }).pipe(Effect.flatMap(rowsRead)),
    count: (table, predicate) =>
      attempt((c) => matching(c, table, predicate).aggregate((a) => ({ n: a.count() }))).pipe(
        Effect.filterOrFail(isRawRow, unreadable),
        Effect.map((result) => Number(result['n'] ?? 0)),
      ),
    countValues: (table, column, predicate, atLeast) =>
      attempt((c) =>
        matching(c, table, predicate)
          .groupBy(column)
          .having((h) => h.count().gte(atLeast))
          .aggregate((a) => ({ n: a.count() })),
      ).pipe(
        Effect.flatMap(rowsRead),
        Effect.map((groups) =>
          groups.flatMap((g) => {
            const value = g[column]

            return value === null || !isScalar(value)
              ? []
              : [{ value: String(value), count: Number(g['n'] ?? 0) }]
          }),
        ),
      ),
    insert: (table, row) =>
      attempt((c) => collection(c, table).create(row)).pipe(
        Effect.filterOrFail(isRawRow, unreadable),
      ),
    update: (table, predicate, changes) => changed(updateSql(table, predicate, changes)),
    remove: (table, predicate) => changed(removeSql(table, predicate)),
    refreshDates: (table, objectKey, kinds, recordId) =>
      Effect.asVoid(changed(refreshDatesSql(table, objectKey, kinds, recordId))),
    lock: (table, predicate) => changed(lockSql(table, predicate)),
    transaction: transaction.transact,
    ping: attempt((c) =>
      c.execute(
        c.raw
          .sql(template(['SELECT 1']))
          .affectedCount()
          .build(),
      ),
    ),
  }
}

export const prisma = (options: { contract: unknown }): StoreAdapter => ({
  id: 'prisma',
  label: 'Postgres',
  requires: [DATABASE_URL],
  layer: storeLayer(
    Effect.gen(function* () {
      const env = yield* config.environment
      let client: Client | undefined

      // Connects on first use, and again after a close.
      const open = (): Client => {
        const url = databaseUrl(env)

        if (!url) {
          throw new Error(
            'DATABASE_URL is not set. Copy .env.example to .env, or run `bun run init`.',
          )
        }

        // SAFETY: `Client` is the part of Prisma's client this adapter uses, written out by hand:
        // models are reached by name at run time, and for a contract read at run time Prisma's
        // own types call the collections' methods unavailable. Each member is one the Prisma 8
        // client has at run time, with the arguments it takes; TypeScript checks that the two
        // types overlap, and the Prisma integration tests (TEST_STORE=prisma) run every member
        // against a real database. Rows aren't taken on trust: they are objects here, and
        // `isRawRow` checks them where they come in.
        client ??= postgresClient({
          contract: contractFromJson(options.contract),
          url,
        }) as Client

        return client
      }

      yield* Effect.addFinalizer(() => Effect.promise(async () => client?.close()))
      return backend(open)
    }),
  ),
})
