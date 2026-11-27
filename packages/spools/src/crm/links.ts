import { tableName } from './naming'

/**
 * Many-to-many relations (`"type": "relations"`): the names a field goes by,
 * which side owns the links, and the limits on reading and writing them. Pure
 * and shared by server and client: no Zod, no database.
 *
 * A relations field has no column. Its links are rows of a table of their own
 * (src/server/store/objects.ts): one row per pair of records. The field that
 * owns the table is the one without `inverse`; a field with `inverse` is the
 * same links seen from the other object, so both sides show and change them.
 */

/** How many related records a record brings back for one field. `<field>Count` says how many there are. */
export const LINKS_READ = 100
/** How many ids one write may name: in a set that replaces, or in each of `add` and `remove`. */
export const LINKS_WRITE = 100
/** How many titles a cell of a CSV export holds. */
export const LINKS_EXPORT = 1000
/** What separates titles in one cell of a CSV file. */
export const LINKS_SEPARATOR = ';'

/** The key a relations field's ids are read and written under: `tags` is `tagsIds`. */
export const idsKey = (fieldKey: string): string => `${fieldKey}Ids`
/** The key under which a record says how many related records a field has. */
export const countKey = (fieldKey: string): string => `${fieldKey}Count`
/** The relation, on an object's table, to its rows of a field's links table. */
export const linksRelation = (fieldKey: string): string => `${fieldKey}Links`

/** Names a relations field needs on its object beside its own key, so no other field may have them. */
export const reservedBy = (fieldKey: string): string[] => [
  idsKey(fieldKey),
  countKey(fieldKey),
  linksRelation(fieldKey),
]

/** The links table's name in the database: the owning object's table, then the field. */
export const linksTableName = (objectKey: string, fieldKey: string): string =>
  `${tableName(objectKey)}_${tableName(fieldKey)}`

type FieldLike = { type: string; to?: string; inverse?: string | undefined }
type ObjectsLike = Record<string, { fields: Record<string, FieldLike> }>

/** The field of an object, if it is one of its own and a relations field. */
function relationsField(
  objects: ObjectsLike,
  objectKey: string,
  fieldKey: string,
): (FieldLike & { to: string }) | undefined {
  const obj = Object.hasOwn(objects, objectKey) ? objects[objectKey] : undefined
  const field = obj && Object.hasOwn(obj.fields, fieldKey) ? obj.fields[fieldKey] : undefined
  return field?.type === 'relations' && field.to !== undefined
    ? { ...field, to: field.to }
    : undefined
}

/** Where a relations field's links are kept, and which end of each link this field's record is. */
export type LinkEnds = {
  /** The field that owns the links table, and its object. */
  owner: { objectKey: string; field: string }
  /** Whether this field is the owner (`source`) or its inverse (`target`). */
  side: 'source' | 'target'
  /** The object at the other end. */
  to: string
}

/**
 * Which links a relations field reads and writes. Undefined when the field is
 * not a relations field, or names an inverse the config doesn't have (which
 * the config's schema refuses).
 */
export function linkEnds(
  objects: ObjectsLike,
  objectKey: string,
  fieldKey: string,
): LinkEnds | undefined {
  const field = relationsField(objects, objectKey, fieldKey)

  if (!field) {
    return undefined
  }

  if (field.inverse === undefined) {
    return { owner: { objectKey, field: fieldKey }, side: 'source', to: field.to }
  }

  const owner = relationsField(objects, field.to, field.inverse)

  return owner && owner.to === objectKey && owner.inverse === undefined
    ? { owner: { objectKey: field.to, field: field.inverse }, side: 'target', to: field.to }
    : undefined
}

/** The inverse of an owning relations field: the field on its target object that names it, if any. */
export function inverseOf(
  objects: ObjectsLike,
  objectKey: string,
  fieldKey: string,
): string | undefined {
  const field = relationsField(objects, objectKey, fieldKey)
  const target = field && Object.hasOwn(objects, field.to) ? objects[field.to] : undefined

  if (!field || !target || field.inverse !== undefined) {
    return undefined
  }

  return Object.entries(target.fields).find(
    ([, other]) =>
      other.type === 'relations' && other.to === objectKey && other.inverse === fieldKey,
  )?.[0]
}

/** The titles (or ids) one cell of a CSV file names for a relations field. */
export const splitCell = (cell: string): string[] => [
  ...new Set(
    cell
      .split(LINKS_SEPARATOR)
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  ),
]
