import type { CrmConfig } from '../../crm/config-schema'
import { fieldTypes } from '../../crm/field-types'
import { modelName, tableName } from '../../crm/naming'
import {
  type Column,
  createdAt,
  date,
  id,
  optional,
  type Relation,
  type Table,
  type TableScope,
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

function build(cfg: CrmConfig): Record<string, ObjectTable> {
  const building = new Map<string, Building>()

  for (const [objectKey, obj] of Object.entries(cfg.objects)) {
    const columns = new Map<string, Column>(Object.entries(systemColumns()))

    for (const [key, field] of Object.entries(obj.fields)) {
      if (field.type === 'relation') {
        columns.set(`${key}Id`, { kind: 'text', nullable: !field.required })
        continue
      }

      const column: Column = { kind: fieldTypes[field.type].column, nullable: !field.required }

      columns.set(
        key,
        'default' in field && field.default !== undefined
          ? { ...column, default: field.default }
          : column,
      )
    }

    const relations: MutableRelations = {}
    const scopeField = cfg.scopes?.objects[objectKey]

    // The scope is compared as the column holds it: a relation's key, or the value itself.
    const scope: TableScope | undefined =
      scopeField === undefined
        ? undefined
        : {
            kind: 'own',
            column: obj.fields[scopeField]?.type === 'relation' ? `${scopeField}Id` : scopeField,
          }

    building.set(objectKey, {
      object: obj,
      table: {
        model: modelName(objectKey, obj),
        name: tableName(objectKey),
        primary: 'id',
        columns: Object.fromEntries(columns),
        relations,
        unique: [],
        // Every read of a scoped object asks for its scope.
        indexes: scope ? [[scope.column]] : [],
        scope,
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
        // So does the relation a scoped object keeps its scope in, required or not: clearing it
        // would leave every record of that scope with none (the guard says so first: scope.ts).
        onDelete:
          field.required || cfg.scopes?.objects[objectKey] === key ? 'restrict' : 'set null',
      }

      target.relations[backRelation(objectKey, key)] = {
        kind: 'many',
        table: () => self.table,
        column,
      }
    }
  }

  return Object.fromEntries([...building].map(([objectKey, { table }]) => [objectKey, table]))
}

const built = new WeakMap<CrmConfig, Record<string, ObjectTable>>()

/** Every object's table, by object key. Worked out once per config. */
export function objectTables(cfg: CrmConfig): Record<string, ObjectTable> {
  const known = built.get(cfg)

  if (known) {
    return known
  }

  const tables = build(cfg)
  built.set(cfg, tables)
  return tables
}
