/**
 * What can be asked of a store: conditions, order and which columns to bring
 * back, as plain data. A store turns it into whatever its database speaks.
 * Everything here is meant to be answerable by any database a CRM would run on,
 * so a condition only exists when the CRM needs it.
 */

/** A value in a condition. Days are strings, moments are `Date`s, money is a string (table.ts). */
export type Scalar = string | number | boolean | Date | null

type Compare = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
type TextMatch = 'contains' | 'starts' | 'ends' | 'exact'

export type Predicate =
  | { readonly op: 'and' | 'or'; readonly of: readonly Predicate[] }
  | { readonly op: 'not'; readonly of: Predicate }
  /** Compares with a value. Like SQL, a comparison with an empty column is neither true nor false. */
  | { readonly op: Compare; readonly column: string; readonly value: Exclude<Scalar, null> }
  | {
      readonly op: 'in'
      readonly column: string
      readonly values: readonly Exclude<Scalar, null>[]
    }
  | { readonly op: 'null' | 'notNull'; readonly column: string }
  /** Text compared without regard to case. `text` is literal: there are no wildcards in it. */
  | {
      readonly op: 'text'
      readonly column: string
      readonly match: TextMatch
      readonly text: string
    }
  /** The digits of a text column, and nothing else in it, contain these digits (phone numbers). */
  | { readonly op: 'digits'; readonly column: string; readonly digits: string }
  /** At least one (or, with `some: false`, not one) row the relation leads to meets the condition. */
  | {
      readonly op: 'related'
      readonly relation: string
      readonly some: boolean
      readonly where?: Predicate
    }
  /**
   * The table's search columns contain every word, stemmed ("cabinets" finds
   * "cabinet"), with the last word allowed to be unfinished.
   */
  | { readonly op: 'search'; readonly text: string }

const compare =
  (op: Compare) =>
  (column: string, value: Exclude<Scalar, null>): Predicate => ({ op, column, value })

export const eq = compare('eq')
export const neq = compare('neq')
export const gt = compare('gt')
export const gte = compare('gte')
export const lt = compare('lt')
export const lte = compare('lte')
export const and = (...of: readonly Predicate[]): Predicate => ({ op: 'and', of })
export const or = (...of: readonly Predicate[]): Predicate => ({ op: 'or', of })
export const not = (of: Predicate): Predicate => ({ op: 'not', of })
export const oneOf = (column: string, values: readonly Exclude<Scalar, null>[]): Predicate => ({
  op: 'in',
  column,
  values,
})
export const isNull = (column: string): Predicate => ({ op: 'null', column })
export const notNull = (column: string): Predicate => ({ op: 'notNull', column })

const textual =
  (match: TextMatch) =>
  (column: string, text: string): Predicate => ({ op: 'text', column, match, text })

export const contains = textual('contains')
export const startsWith = textual('starts')
export const endsWith = textual('ends')
/** The whole text, without regard to case. */
export const sameText = textual('exact')
export const digitsContain = (column: string, digits: string): Predicate => ({
  op: 'digits',
  column,
  digits,
})
export const some = (relation: string, where?: Predicate): Predicate => ({
  op: 'related',
  relation,
  some: true,
  where,
})
export const none = (relation: string, where?: Predicate): Predicate => ({
  op: 'related',
  relation,
  some: false,
  where,
})
export const search = (text: string): Predicate => ({ op: 'search', text })

/** What to sort by: a column, a column of the record a relation leads to, or the first of several columns that isn't empty. */
export type OrderBy =
  | string
  | readonly [relation: string, column: string]
  | { readonly firstOf: readonly string[] }
export type Order = {
  readonly by: OrderBy
  readonly dir: 'asc' | 'desc'
  readonly nulls?: 'first' | 'last'
}

export const asc = (by: OrderBy, nulls?: 'first' | 'last'): Order => ({ by, dir: 'asc', nulls })
export const desc = (by: OrderBy, nulls?: 'first' | 'last'): Order => ({ by, dir: 'desc', nulls })

/** Columns that must equal these values. `null` means empty. */
export type Match<Row> = { readonly [K in keyof Row]?: Row[K] }

/** Which rows: every condition of `where`, and `filter` as well. */
export type Which<Row> = { readonly where?: Match<Row>; readonly filter?: Predicate }

export type Query<Row, Selected extends keyof Row = keyof Row> = Which<Row> & {
  readonly order?: readonly Order[]
  readonly limit?: number
  readonly offset?: number
  /** Bring back only these columns. */
  readonly select?: readonly Selected[]
  /** Records that relations lead to, by relation: the whole record, or some of its columns (and its id). */
  readonly include?: Readonly<Record<string, 'all' | readonly string[]>>
}
