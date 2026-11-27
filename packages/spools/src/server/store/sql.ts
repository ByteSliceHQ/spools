import { Schema } from 'effect'

import type { Order, OrderBy, Predicate, Scalar } from './query'
import type { DateKinds, RawQuery, RawValues } from './store'
import { type AnyTable, type Column, columnName, type Kind } from './table'
import { Activity, Task } from './tables'

/**
 * Queries as Postgres SQL. Pure: text and parameters in, nothing run. Every
 * value is a parameter; the only names in the text come from table
 * descriptions, never from anything a person typed, and they are quoted.
 */

/** A parameter's value. An empty one is never a parameter: it is written out (`Writer.param`). */
export type Param = Exclude<Scalar, null>

/** SQL in pieces, with a parameter between each piece and the next. */
export type Sql = { readonly parts: readonly string[]; readonly params: readonly Param[] }

/** SQL as one string with `$1`-style placeholders, and its parameters in order. */
export type Placeholders = { text: string; params: readonly Param[] }

/** As one string with `$1`-style placeholders. */
export const placeholders = ({ parts, params }: Sql): Placeholders => ({
  text: parts.map((part, i) => (i === 0 ? part : `$${i}${part}`)).join(''),
  params,
})

const isText = Schema.is(Schema.String)

const SQL_TYPE: Record<Kind, string> = {
  text: 'text',
  integer: 'int4',
  float: 'float8',
  decimal: 'numeric',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamptz',
}

/** A value as a parameter for a column of this kind: what every driver can send. */
export function encode(kind: Kind, value: Scalar | undefined): Scalar {
  if (value === null || value === undefined) {
    return null
  }

  if (kind === 'timestamp') {
    return value instanceof Date ? value.toISOString() : value
  }

  if (kind === 'decimal') {
    return String(value)
  }

  if (kind === 'date') {
    return value instanceof Date ? value.toISOString().slice(0, 10) : value
  }

  return value
}

/**
 * What a driver gave back for a column of this kind, as the table describes it.
 * Drivers give some values back their own way (a moment as text, a yes/no as
 * "t"), so each is read whichever way it came.
 */
export function decode(kind: Kind, value: Scalar | undefined): Scalar {
  if (value === null || value === undefined) {
    return null
  }

  if (kind === 'timestamp') {
    if (value instanceof Date) {
      return value
    }

    return new Date(isText(value) ? value : Number(value))
  }

  if (kind === 'integer' || kind === 'float') {
    return Number(value)
  }

  if (kind === 'boolean') {
    return value === true || value === 't' || value === 'true'
  }

  return String(value)
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

/** Text with no wildcards in it. Postgres's default escape is the backslash. */
const literalLike = (text: string) => text.replace(/[\\%_]/g, (m) => `\\${m}`)

const PATTERN = {
  contains: (text: string) => `%${literalLike(text)}%`,
  starts: (text: string) => `${literalLike(text)}%`,
  ends: (text: string) => `%${literalLike(text)}`,
  exact: literalLike,
} as const

const COMPARE = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

/** Collects SQL piece by piece. */
class Writer {
  readonly parts: string[] = ['']
  readonly params: Param[] = []
  #aliases = 0

  text(sql: string): this {
    this.parts[this.parts.length - 1] += sql
    return this
  }
  param(value: Scalar | undefined, kind: Kind): this {
    const encoded = encode(kind, value)

    // Written out, because not every driver can send an empty parameter (Prisma's raw SQL can't).
    if (encoded === null) {
      return this.text(`NULL::${SQL_TYPE[kind]}`)
    }

    this.params.push(encoded)
    this.parts.push(`::${SQL_TYPE[kind]}`)
    return this
  }
  alias(): string {
    return `t${this.#aliases++}`
  }
  done(): Sql {
    return { parts: this.parts, params: this.params }
  }
}

function columnOf(table: AnyTable, key: string): Column {
  const column = Object.hasOwn(table.columns, key) ? table.columns[key] : undefined

  if (!column) {
    throw new Error(`No column "${key}" on ${table.name}`)
  }

  return column
}

function relationOf(table: AnyTable, key: string) {
  const relation = Object.hasOwn(table.relations, key) ? table.relations[key] : undefined

  if (!relation) {
    throw new Error(`No relation "${key}" on ${table.name}`)
  }

  return relation
}

const ref = (alias: string, key: string) => `${alias}.${ident(columnName(key))}`

/** The document full-text search reads: the same expression as the index (schema-sql.ts, and Prisma's). */
export function searchDocument(table: AnyTable, prefix = ''): string {
  const columns = table.search?.columns ?? []

  const weighted = columns.map(
    (key, i) =>
      `setweight(to_tsvector('english'::regconfig, coalesce(${prefix}${ident(columnName(key))}, ''::text)), '${i === 0 ? 'A' : 'B'}'::"char")`,
  )

  return `(${weighted.join(' || ')})`
}

/** A word that may be unfinished, as `to_tsquery` takes it. Quoted, so nothing in it is an operator. */
const unfinished = (word: string) => `'${word.replace(/\\/g, '\\\\').replace(/'/g, "''")}':*`

function writeSearch(w: Writer, table: AnyTable, alias: string, typed: string): void {
  const words = typed.trim().split(/\s+/).filter(Boolean)
  const last = words.at(-1) ?? ''
  const lead = words.slice(0, -1).join(' ')
  const document = searchDocument(table, `${alias}.`)

  w.text(`(${document} @@ websearch_to_tsquery('english'::regconfig, `)
    .param(typed, 'text')
    .text(') OR (')

  if (lead) {
    w.text(`${document} @@ websearch_to_tsquery('english'::regconfig, `)
      .param(lead, 'text')
      .text(') AND ')
  }

  w.text(`${document} @@ to_tsquery('english'::regconfig, `)
    .param(unfinished(last), 'text')
    .text(')))')
}

function writePredicate(w: Writer, table: AnyTable, alias: string, p: Predicate): void {
  switch (p.op) {
    case 'and':

    case 'or': {
      if (p.of.length === 0) {
        w.text(p.op === 'and' ? 'TRUE' : 'FALSE')
        return
      }

      w.text('(')

      p.of.forEach((part, i) => {
        if (i > 0) {
          w.text(p.op === 'and' ? ' AND ' : ' OR ')
        }

        writePredicate(w, table, alias, part)
      })

      w.text(')')
      return
    }

    case 'not':
      w.text('NOT (')
      writePredicate(w, table, alias, p.of)
      w.text(')')
      return
    case 'null':
    case 'notNull':
      columnOf(table, p.column)
      w.text(`${ref(alias, p.column)} IS ${p.op === 'null' ? 'NULL' : 'NOT NULL'}`)
      return

    case 'in': {
      const { kind } = columnOf(table, p.column)

      if (p.values.length === 0) {
        w.text('FALSE')
        return
      }

      w.text(`${ref(alias, p.column)} IN (`)

      p.values.forEach((value, i) => {
        if (i > 0) {
          w.text(', ')
        }

        w.param(value, kind)
      })

      w.text(')')
      return
    }

    case 'text':
      columnOf(table, p.column)
      w.text(`${ref(alias, p.column)} ILIKE `).param(PATTERN[p.match](p.text), 'text')
      return
    case 'digits':
      columnOf(table, p.column)

      w.text(`regexp_replace(${ref(alias, p.column)}, '[^0-9]', '', 'g') LIKE `).param(
        `%${p.digits.replace(/\D/g, '')}%`,
        'text',
      )

      return
    case 'search':
      writeSearch(w, table, alias, p.text)
      return

    case 'related': {
      const relation = relationOf(table, p.relation)
      const target = relation.table()
      const inner = w.alias()
      w.text(`${p.some ? 'EXISTS' : 'NOT EXISTS'} (SELECT 1 FROM ${from(target)} ${inner} WHERE `)

      w.text(
        relation.kind === 'one'
          ? `${ref(inner, target.primary)} = ${ref(alias, relation.column)}`
          : `${ref(inner, relation.column)} = ${ref(alias, table.primary)}`,
      )

      if (p.where) {
        w.text(' AND ')
        writePredicate(w, target, inner, p.where)
      }

      w.text(')')
      return
    }

    default: {
      const { kind } = columnOf(table, p.column)
      w.text(`${ref(alias, p.column)} ${COMPARE[p.op]} `).param(p.value satisfies Scalar, kind)
    }
  }
}

const from = (table: AnyTable) => `"public".${ident(table.name)}`

function writeOrder(w: Writer, table: AnyTable, alias: string, by: OrderBy): void {
  if (isText(by)) {
    columnOf(table, by)
    w.text(ref(alias, by))
    return
  }

  if ('firstOf' in by) {
    for (const key of by.firstOf) {
      columnOf(table, key)
    }

    w.text(`coalesce(${by.firstOf.map((key) => ref(alias, key)).join(', ')})`)
    return
  }

  const [name, key] = by
  const relation = relationOf(table, name)
  const target = relation.table()
  columnOf(target, key)
  const inner = w.alias()

  w.text(
    `(SELECT ${ref(inner, key)} FROM ${from(target)} ${inner} WHERE ${ref(inner, target.primary)} = ${ref(alias, relation.column)})`,
  )
}

function writeOrders(w: Writer, table: AnyTable, alias: string, orders: readonly Order[]): void {
  orders.forEach(({ by, dir, nulls }, i) => {
    w.text(i === 0 ? ' ORDER BY ' : ', ')
    writeOrder(w, table, alias, by)
    w.text(dir === 'asc' ? ' ASC' : ' DESC')

    if (nulls) {
      w.text(nulls === 'first' ? ' NULLS FIRST' : ' NULLS LAST')
    }
  })
}

function writeWhere(
  w: Writer,
  table: AnyTable,
  alias: string,
  predicate: Predicate | undefined,
): void {
  if (!predicate) {
    return
  }

  w.text(' WHERE ')
  writePredicate(w, table, alias, predicate)
}

/** A column in a select list, under its own key. Days and money come back as text, so no driver can round or shift them. */
function selected(table: AnyTable, alias: string, key: string): string {
  const { kind } = columnOf(table, key)
  const cast = kind === 'date' || kind === 'decimal' ? '::text' : ''
  return `${ref(alias, key)}${cast} AS ${ident(key)}`
}

/** The columns a query reads: what it selects, and the keys its included relations need. */
export function columnsRead(
  table: AnyTable,
  query: Pick<RawQuery, 'select' | 'include'>,
): string[] {
  if (!query.select) {
    return Object.keys(table.columns)
  }

  const keys = Object.entries(query.include ?? {}).flatMap(([name]) => {
    const relation = relationOf(table, name)
    return relation.kind === 'one' ? [relation.column] : []
  })

  return [...new Set([...query.select, ...keys])].filter((key) => Object.hasOwn(table.columns, key))
}

export function selectSql(table: AnyTable, query: RawQuery): Sql {
  const w = new Writer()
  const alias = w.alias()
  const columns = columnsRead(table, query).map((key) => selected(table, alias, key))
  w.text(`SELECT ${columns.join(', ')} FROM ${from(table)} ${alias}`)
  writeWhere(w, table, alias, query.predicate)
  writeOrders(w, table, alias, query.order ?? [])

  if (query.limit !== undefined) {
    w.text(` LIMIT ${Math.max(0, Math.trunc(query.limit))}`)
  }

  if (query.offset) {
    w.text(` OFFSET ${Math.max(0, Math.trunc(query.offset))}`)
  }

  return w.done()
}

export function countSql(table: AnyTable, predicate: Predicate | undefined): Sql {
  const w = new Writer()
  const alias = w.alias()
  w.text(`SELECT count(*)::float8 AS "n" FROM ${from(table)} ${alias}`)
  writeWhere(w, table, alias, predicate)
  return w.done()
}

export function countValuesSql(
  table: AnyTable,
  column: string,
  predicate: Predicate | undefined,
  atLeast: number,
): Sql {
  columnOf(table, column)
  const w = new Writer()
  const alias = w.alias()

  w.text(
    `SELECT ${ref(alias, column)} AS "value", count(*)::float8 AS "n" FROM ${from(table)} ${alias}`,
  )

  writeWhere(w, table, alias, predicate)
  w.text(` GROUP BY 1 HAVING count(*) >= ${Math.max(1, Math.trunc(atLeast))}`)
  return w.done()
}

export function insertSql(table: AnyTable, row: RawValues): Sql {
  const keys = Object.keys(row).filter((key) => Object.hasOwn(table.columns, key))
  const w = new Writer()
  const alias = w.alias()

  w.text(
    `INSERT INTO ${from(table)} AS ${alias} (${keys.map((key) => ident(columnName(key))).join(', ')}) VALUES (`,
  )

  keys.forEach((key, i) => {
    if (i > 0) {
      w.text(', ')
    }

    w.param(row[key], columnOf(table, key).kind)
  })

  w.text(
    `) RETURNING ${Object.keys(table.columns)
      .map((key) => selected(table, alias, key))
      .join(', ')}`,
  )

  return w.done()
}

/** Changes rows and returns one row for each, so the caller can count them. */
export function updateSql(table: AnyTable, predicate: Predicate, changes: RawValues): Sql {
  const w = new Writer()
  const alias = w.alias()
  w.text(`UPDATE ${from(table)} AS ${alias} SET `)

  Object.entries(changes).forEach(([key, value], i) => {
    if (i > 0) {
      w.text(', ')
    }

    w.text(`${ident(columnName(key))} = `).param(value, columnOf(table, key).kind)
  })

  writeWhere(w, table, alias, predicate)
  w.text(' RETURNING 1 AS "n"')
  return w.done()
}

/** Deletes rows and returns one row for each, so the caller can count them. */
export function removeSql(table: AnyTable, predicate: Predicate): Sql {
  const w = new Writer()
  const alias = w.alias()
  w.text(`DELETE FROM ${from(table)} AS ${alias}`)
  writeWhere(w, table, alias, predicate)
  w.text(' RETURNING 1 AS "n"')
  return w.done()
}

/**
 * Holds the matching rows for the transaction it runs in. They are taken in the
 * order of their primary keys, so two transactions that hold the same rows of a
 * table never each wait for a row the other has.
 */
export function lockSql(table: AnyTable, predicate: Predicate): Sql {
  const w = new Writer()
  const alias = w.alias()
  w.text(`SELECT 1 AS "n" FROM ${from(table)} AS ${alias}`)
  writeWhere(w, table, alias, predicate)
  w.text(` ORDER BY ${ref(alias, table.primary)} FOR UPDATE OF ${alias}`)
  return w.done()
}

export function refreshDatesSql(
  table: AnyTable,
  objectKey: string,
  kinds: DateKinds,
  recordId: string | undefined,
): Sql {
  const w = new Writer()

  // An email that was drafted but never went out isn't contact.
  const last = (which: readonly string[]) => {
    w.text(
      `(SELECT max(coalesce(a."occurred_at", a."created_at")) FROM ${from(Activity)} a WHERE a."object_key" = `,
    ).param(objectKey, 'text')

    w.text(' AND a."record_id" = r."id" AND a."kind" IN (')

    which.forEach((kind, i) => {
      if (i > 0) {
        w.text(', ')
      }

      w.param(kind, 'text')
    })

    w.text(`) AND coalesce(a."outcome", '') <> 'not_sent')`)
  }

  w.text(`UPDATE ${from(table)} AS r SET "last_activity_at" = `)
  last(kinds.activity)
  w.text(', "last_contacted_at" = ')
  last(kinds.contact)

  w.text(
    `, "next_task_due" = (SELECT min(t."due_date") FROM ${from(Task)} t WHERE t."object_key" = `,
  )

  w.param(objectKey, 'text')
  w.text(' AND t."record_id" = r."id" AND t."completed_at" IS NULL)')

  if (recordId !== undefined) {
    w.text(' WHERE r."id" = ').param(recordId, 'text')
  }

  return w.done()
}
