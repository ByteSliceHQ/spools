import type { CrmConfig } from '../../crm/config-schema'
import { fieldTypes } from '../../crm/field-types'
import { inverseOf, linkEnds, linksRelation, linksTableName } from '../../crm/links'
import { modelName, tableName } from '../../crm/naming'
import {
  type Column,
  createdAt,
  date,
  id,
  optional,
  type Relation,
  type Table,
  text,
  timestamp,
  updatedAt,
} from './table'

/** A value as it comes back from the store (relations included as nested records). */
export type CrmValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | CrmValue[]
  | { [key: string]: CrmValue }
export type CrmRecord = { id: string; createdAt: Date; updatedAt: Date; [key: string]: CrmValue }

/** An object's table: its columns come from the config, so its rows are typed loosely. */
export type ObjectTable = Table<CrmRecord, Record<string, unknown>>

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The relation, on an object, to the records of `objectKey` that point at it through `field`. */
export const backRelation = (objectKey: string, field: string) => `${objectKey}Via${capital(field)}`

/** The columns every object's table has. */
const systemColumns = () => ({
  id: id(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  createdBy: optional(text()),
  // Kept by refreshStats (src/server/records.ts) from the record's activities and tasks, so they can be filtered and sorted.
  lastActivityAt: optional(timestamp()),
  lastContactedAt: optional(timestamp()),
  nextTaskDue: optional(date()),
})

type MutableRelations = Record<string, Relation>

/** An object's table while it is made: its relations are added once every table exists. */
type Building = {
  readonly object: CrmConfig['objects'][string]
  readonly table: ObjectTable
  readonly relations: MutableRelations
}

/** One link between two records: a row of a relations field's links table. */
export type LinkRow = { id: string; createdAt: Date; sourceId: string; targetId: string }
export type LinkTable = Table<LinkRow, { sourceId: string; targetId: string; id?: string }>

/**
 * A many-to-many relation: the table its links are rows of, and the two
 * objects it joins. The table is described like any other and reached like any
 * other, through the store with ordinary conditions. Its two relations lead to
 * the records at each end: `source` (by `sourceId`) to the record the owning
 * field is on, `target` (by `targetId`) to the record that field holds. Each
 * object's table has a relation back to its rows of it (`LinkSide.relation`),
 * so "has a tag" is a condition on an object like any other.
 */
export type Link = {
  readonly table: LinkTable
  /** The object and the field that own the links. */
  readonly source: { readonly objectKey: string; readonly field: string }
  /** The object the field holds records of, and its inverse field there, if it has one. */
  readonly target: { readonly objectKey: string; readonly field: string | undefined }
}

/** A relations field's links, as seen from that field's own record. */
export type LinkSide = {
  readonly link: Link
  /** The object at the other end. */
  readonly to: string
  /** The relation, on this object's table, to this record's rows of the links table. */
  readonly relation: string
  /** The column of the links table that holds this record's id, and the one that holds the other record's. */
  readonly near: 'sourceId' | 'targetId'
  readonly far: 'sourceId' | 'targetId'
}

type Built = { readonly tables: Record<string, ObjectTable>; readonly links: readonly Link[] }

function build(cfg: CrmConfig): Built {
  const building = new Map<string, Building>()

  for (const [objectKey, obj] of Object.entries(cfg.objects)) {
    const columns = new Map<string, Column>(Object.entries(systemColumns()))

    for (const [key, field] of Object.entries(obj.fields)) {
      if (field.type === 'relation') {
        columns.set(`${key}Id`, { kind: 'text', nullable: !field.required })
        continue
      }

      const kind = fieldTypes[field.type].column

      // No column of its own: its values are rows of a links table, made below.
      if (kind === null) {
        continue
      }

      const column: Column = { kind, nullable: !field.required }

      columns.set(
        key,
        'default' in field && field.default !== undefined
          ? { ...column, default: field.default }
          : column,
      )
    }

    const relations: MutableRelations = {}

    building.set(objectKey, {
      object: obj,
      table: {
        model: modelName(objectKey, obj),
        name: tableName(objectKey),
        primary: 'id',
        columns: Object.fromEntries(columns),
        relations,
        unique: [],
        indexes: [],
      },
      relations,
    })
  }

  // In the order the objects and their fields come, so each table's relations are in that order too.
  for (const [objectKey, self] of building) {
    for (const [key, field] of Object.entries(self.object.fields)) {
      if (field.type !== 'relation') {
        continue
      }

      const target = building.get(field.to)

      // The config's schema only lets a relation lead to one of its objects (config-schema.ts).
      if (!target) {
        continue
      }

      const column = `${key}Id`

      self.relations[key] = {
        kind: 'one',
        table: () => target.table,
        column,
        // Optional relations are cleared when the target is deleted; required ones block the delete.
        onDelete: field.required ? 'restrict' : 'set null',
      }

      target.relations[backRelation(objectKey, key)] = {
        kind: 'many',
        table: () => self.table,
        column,
      }
    }
  }

  // After every single relation, so a config with no relations fields makes the tables it always did.
  const links: Link[] = []

  for (const [objectKey, self] of building) {
    for (const [key, field] of Object.entries(self.object.fields)) {
      // An inverse owns no table: it is the other side of the field it names.
      if (field.type !== 'relations' || field.inverse !== undefined) {
        continue
      }

      const target = building.get(field.to)

      // The config's schema only lets a field lead to one of its objects.
      if (!target) {
        continue
      }

      const inverse = inverseOf(cfg.objects, objectKey, key)

      const table: LinkTable = {
        model: `${self.table.model}${capital(key)}`,
        name: linksTableName(objectKey, key),
        doc: `Which ${target.object.labelPlural.toLowerCase()} each ${self.object.label.toLowerCase()} has under "${key}": one row per pair.`,
        primary: 'id',
        columns: { id: id(), createdAt: createdAt(), sourceId: text(), targetId: text() },
        relations: {
          // A link goes when the record at either end does.
          source: {
            kind: 'one',
            table: () => self.table,
            column: 'sourceId',
            onDelete: 'cascade',
          },
          target: {
            kind: 'one',
            table: () => target.table,
            column: 'targetId',
            onDelete: 'cascade',
          },
        },
        unique: [['sourceId', 'targetId']],
        // Both ends are indexed as foreign keys are (schema-sql.ts; Prisma does the same).
        indexes: [],
      }

      self.relations[linksRelation(key)] = { kind: 'many', table: () => table, column: 'sourceId' }

      target.relations[linksRelation(inverse ?? backRelation(objectKey, key))] = {
        kind: 'many',
        table: () => table,
        column: 'targetId',
      }

      links.push({
        table,
        source: { objectKey, field: key },
        target: { objectKey: field.to, field: inverse },
      })
    }
  }

  return {
    tables: Object.fromEntries([...building].map(([objectKey, { table }]) => [objectKey, table])),
    links,
  }
}

const built = new WeakMap<CrmConfig, Built>()

/** A config's tables, worked out once per config. */
function tablesOf(cfg: CrmConfig): Built {
  const known = built.get(cfg)

  if (known) {
    return known
  }

  const made = build(cfg)
  built.set(cfg, made)
  return made
}

/** Every object's table, by object key. */
export const objectTables = (cfg: CrmConfig): Record<string, ObjectTable> => tablesOf(cfg).tables

/** Every many-to-many relation of a config, in the order their owning fields come. */
export const linkTables = (cfg: CrmConfig): readonly Link[] => tablesOf(cfg).links

/** The links a relations field reads and writes, from that field's side. Undefined for any other field. */
export function linkSide(
  cfg: CrmConfig,
  objectKey: string,
  fieldKey: string,
): LinkSide | undefined {
  const ends = linkEnds(cfg.objects, objectKey, fieldKey)

  const link =
    ends &&
    linkTables(cfg).find(
      (l) => l.source.objectKey === ends.owner.objectKey && l.source.field === ends.owner.field,
    )

  if (!ends || !link) {
    return undefined
  }

  return ends.side === 'source'
    ? { link, to: ends.to, relation: linksRelation(fieldKey), near: 'sourceId', far: 'targetId' }
    : { link, to: ends.to, relation: linksRelation(fieldKey), near: 'targetId', far: 'sourceId' }
}
