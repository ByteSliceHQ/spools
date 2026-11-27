import { Predicate } from 'effect'

import type { CrmConfig } from '../../crm/config-schema'
import { objectTables } from './objects'
import { searchDocument } from './sql'
import { type AnyTable, type Column, columnName, type Kind } from './table'
import { systemTables } from './tables'

/**
 * The SQL that makes a database hold a Spool's tables. It adds the tables,
 * columns and indexes that are missing, and never drops, renames or retypes a
 * table or a column, so running it again (or against a newer config) loses no
 * data. The one thing it takes away is an index a table no longer declares
 * (`retireIndexes`): an index holds no data, and a unique one left behind goes
 * on refusing rows the tables now allow.
 *
 * This is how an in-process database (PGlite) keeps up with the config, and how
 * tests make theirs. A production database is migrated with Prisma
 * (`bun run db:plan`, `bun run db:migrate`), which produces the same tables.
 */

const TYPE: Record<Kind, string> = {
  text: 'text',
  integer: 'int4',
  float: 'float8',
  decimal: 'numeric(14,2)',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamptz(3)',
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`
const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`
const tableRef = (table: AnyTable) => `"public".${ident(table.name)}`
const isText = Predicate.isString

function defaultOf(c: Column): string {
  if (c.auto === 'created') {
    return ' DEFAULT now()'
  }

  if (c.default === undefined) {
    return ''
  }

  return ` DEFAULT ${isText(c.default) ? quoted(c.default) : String(c.default)}`
}

/** Index and constraint names are cut at Postgres's 63 bytes, with a hash so two never meet. */
function named(...words: string[]): string {
  const full = words.join('_')

  if (full.length <= 63) {
    return full
  }

  let hash = 5381

  for (const ch of full) {
    hash = (hash * 33 + ch.charCodeAt(0)) >>> 0
  }

  return `${full.slice(0, 54)}_${hash.toString(36)}`
}

function createTable(table: AnyTable): string[] {
  const columns = Object.entries(table.columns).map(
    ([key, c]) =>
      `${ident(columnName(key))} ${TYPE[c.kind]}${c.nullable ? '' : ' NOT NULL'}${defaultOf(c)}${key === table.primary ? ' PRIMARY KEY' : ''}`,
  )

  return [
    `CREATE TABLE IF NOT EXISTS ${tableRef(table)} (${columns.join(', ')})`,
    // For a table that was already there. A required column is added without NOT NULL: rows already stored have no value for it.
    ...Object.entries(table.columns).map(
      ([key, c]) =>
        `ALTER TABLE ${tableRef(table)} ADD COLUMN IF NOT EXISTS ${ident(columnName(key))} ${TYPE[c.kind]}${defaultOf(c)}`,
    ),
    // As in production: nothing but the app's own (privileged) role may read the table.
    `ALTER TABLE ${tableRef(table)} ENABLE ROW LEVEL SECURITY`,
  ]
}

/** Columns, as an index lists them. */
const list = (keys: readonly string[]) => keys.map((key) => ident(columnName(key))).join(', ')
/** Columns, as an index's name has them. */
const names = (keys: readonly string[]) => keys.map(columnName).join('_')

/** A table's indexes as it declares them now: each one's name and the statement that makes it. */
function indexesOf(table: AnyTable): { name: string; create: string }[] {
  const foreign = Object.values(table.relations).flatMap((r) =>
    r.kind === 'one' ? [[r.column]] : [],
  )

  const index = (name: string, kind: string, on: string) => ({
    name,
    create: `CREATE ${kind} IF NOT EXISTS ${ident(name)} ON ${tableRef(table)} ${on}`,
  })

  return [
    ...table.unique.map((keys) =>
      index(named(table.name, names(keys), 'key'), 'UNIQUE INDEX', `(${list(keys)})`),
    ),
    ...[...table.indexes, ...foreign].map((keys) =>
      index(named(table.name, names(keys), 'idx'), 'INDEX', `(${list(keys)})`),
    ),
    ...(table.search
      ? [index(named(table.search.name, 'gin'), 'INDEX', `USING gin (${searchDocument(table)})`)]
      : []),
  ]
}

const createIndexes = (table: AnyTable): string[] => indexesOf(table).map((index) => index.create)

/**
 * Drops the indexes a table has in the database and no longer declares: a
 * unique set that changed, an index or a search that was taken out. Decided by
 * name, which is made from the table and its columns, so an index is kept
 * exactly while the table still describes it. The primary key and anything
 * else a constraint stands on are not this step's and are left alone.
 *
 * A database migrated with Prisma never runs this: its migrations drop what
 * the schema no longer has.
 */
function retireIndexes(table: AnyTable): string[] {
  const declared = indexesOf(table).map((index) => quoted(index.name))

  return [
    `DO $$ DECLARE stale record; BEGIN
  FOR stale IN
    SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = ${quoted(tableRef(table))}::regclass
      AND NOT i.indisprimary
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
      AND c.relname <> ALL (ARRAY[${declared.join(', ')}]::text[])
  LOOP
    EXECUTE format('DROP INDEX "public".%I', stale.name);
  END LOOP;
END $$`,
  ]
}

function createForeignKeys(table: AnyTable): string[] {
  return Object.values(table.relations).flatMap((relation) => {
    if (relation.kind !== 'one') {
      return []
    }

    const target = relation.table()
    const name = named(table.name, columnName(relation.column), 'fkey')
    const rule = relation.onDelete === 'restrict' ? 'RESTRICT' : 'SET NULL'
    return [
      `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${quoted(name)} AND conrelid = ${quoted(tableRef(table))}::regclass) THEN
    ALTER TABLE ${tableRef(table)} ADD CONSTRAINT ${ident(name)} FOREIGN KEY (${ident(columnName(relation.column))})
      REFERENCES ${tableRef(target)} (${ident(columnName(target.primary))}) ON DELETE ${rule};
  END IF;
END $$`,
    ]
  })
}

/** Statements that bring a database up to these tables, in order. */
export function schemaSql(tables: readonly AnyTable[]): string[] {
  return [
    ...tables.flatMap(createTable),
    // Before the new ones are made: a retired unique index may refuse what its replacement allows.
    ...tables.flatMap(retireIndexes),
    ...tables.flatMap(createIndexes),
    // Last, when every table they point at exists.
    ...tables.flatMap(createForeignKeys),
  ]
}

/** Every table a Spool with this config has, and any its adapters keep. */
export const allTables = (
  cfg: CrmConfig,
  adapters: readonly { tables?: readonly AnyTable[] }[] = [],
): AnyTable[] => [
  ...Object.values(objectTables(cfg)),
  ...systemTables,
  ...adapters.flatMap((a) => a.tables ?? []),
]
