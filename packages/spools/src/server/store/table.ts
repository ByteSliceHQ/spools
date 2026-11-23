import { tableName } from '../../crm/naming'

/**
 * Tables, as the framework describes them: plain data that says what is stored
 * and in which type, with no database in it. The system tables are in
 * tables.ts, an object's in objects.ts. From a description come the rows'
 * TypeScript types, the queries a store runs (store.ts), the Prisma schema
 * (src/crm/codegen.ts) and the SQL that creates the tables (schema-sql.ts).
 */

/**
 * What a column holds, and how its values look in TypeScript whatever the
 * database: `decimal` (money) and `date` (a day) are strings, `timestamp` a `Date`.
 */
export type Kind = 'text' | 'integer' | 'float' | 'decimal' | 'boolean' | 'date' | 'timestamp'

export type Column<Value = unknown> = {
  readonly kind: Kind
  readonly nullable: boolean
  /** The value of a row that doesn't say. */
  readonly default?: string | number | boolean
  /** Filled in by the store: a new id, when the row was made, when it last changed. */
  readonly auto?: 'id' | 'created' | 'updated'
  readonly doc?: string
  /** Types only: what a row holds here. */
  readonly value?: Value
}

/** A link to another table. `one` is held here (`column` is the key on this table), `many` points back (`column` is the key on the other). */
export type Relation = {
  readonly kind: 'one' | 'many'
  readonly table: () => AnyTable
  readonly column: string
  /** For `one`: what happens to this row when the one it points to is deleted. */
  readonly onDelete?: 'restrict' | 'set null'
}

export type Table<Row = unknown, Insert = unknown> = {
  /** The name of one row, e.g. "Task". Also its Prisma model. */
  readonly model: string
  /** The table's name in the database, e.g. "tasks". */
  readonly name: string
  readonly doc?: string
  /** The column that identifies a row. */
  readonly primary: string
  readonly columns: Readonly<Record<string, Column>>
  readonly relations: Readonly<Record<string, Relation>>
  /** Sets of columns no two rows may share. */
  readonly unique: readonly (readonly string[])[]
  readonly indexes: readonly (readonly string[])[]
  /** Columns searched as text, most important first. */
  readonly search?: { readonly name: string; readonly columns: readonly string[] }
  /** Types only: what a row looks like, and what inserting one takes. */
  readonly row?: Row
  readonly insert?: Insert
}

// Any table, whatever its rows are.
export type AnyTable = Table<any, any>

/** The column's name in the database. */
export const columnName = (key: string): string => tableName(key)

// ── Columns ─────────────────────────────────────────────────────────────────

type Options = { doc?: string }

const column =
  <Value>(kind: Kind) =>
  (options: Options = {}): Column<Value> & { readonly nullable: false } => ({
    kind,
    nullable: false,
    ...options,
  })

export const text = column<string>('text')
export const integer = column<number>('integer')
export const float = column<number>('float')
export const boolean = column<boolean>('boolean')
/** A day, as "2026-11-23". */
export const date = column<string>('date')
export const timestamp = column<Date>('timestamp')

/** The same column, which may be empty. */
export const optional = <Value>(
  c: Column<Value>,
): Column<Value | null> & { readonly nullable: true } => ({ ...c, nullable: true })

/** The same column, with a value for rows that don't say. */
export const withDefault = <Value extends string | number | boolean>(
  c: Column<Value>,
  value: Value,
): Column<Value> & { readonly nullable: false; readonly default: Value } => ({
  ...c,
  nullable: false,
  default: value,
})

/** The row's id: a UUID the store makes, unless the insert gives one. */
export const id = () =>
  ({ kind: 'text', nullable: false, auto: 'id' }) as const satisfies Column<string>
/** When the row was made. */
export const createdAt = () =>
  ({ kind: 'timestamp', nullable: false, auto: 'created' }) as const satisfies Column<Date>
/** When the row last changed. */
export const updatedAt = () =>
  ({ kind: 'timestamp', nullable: false, auto: 'updated' }) as const satisfies Column<Date>

// ── Types of rows ───────────────────────────────────────────────────────────

type ValueOf<C> = C extends { readonly kind: 'timestamp'; readonly auto: string }
  ? Date
  : C extends { readonly auto: 'id' }
    ? string
    : C extends Column<infer Value>
      ? Value
      : never

type RowOf<C> = { -readonly [K in keyof C]: ValueOf<C[K]> }

/** Columns an insert may leave out: the ones that fill themselves in, have a default, or may be empty. */
type OptionalKeys<C> = {
  [K in keyof C]: C[K] extends
    | { readonly auto: string }
    | { readonly nullable: true }
    | { readonly default: unknown }
    ? K
    : never
}[keyof C]

type InsertOf<C> = { [K in Exclude<keyof C, OptionalKeys<C>>]: ValueOf<C[K]> } & {
  [K in OptionalKeys<C>]?: ValueOf<C[K]>
}

/** Describe a table. Its rows' types follow from its columns. */
export function defineTable<const C extends Record<string, Column>>(spec: {
  model: string
  name: string
  doc?: string
  /** The column that identifies a row, when it isn't `id`. */
  primary?: keyof C & string
  columns: C
  unique?: readonly (readonly (keyof C & string)[])[]
  indexes?: readonly (readonly (keyof C & string)[])[]
  search?: { name: string; columns: readonly (keyof C & string)[] }
}): Table<RowOf<C>, InsertOf<C>> {
  return { primary: 'id', unique: [], indexes: [], ...spec, relations: {} }
}
