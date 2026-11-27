import { z } from 'zod'

import type { Kind } from '../server/store/table'
import { LINKS_WRITE } from './links'

/**
 * Field types: the single server-side definition of every `type` a field in
 * crm.config.json can have.
 *
 * To add a field type:
 *   1. Add its config shape to `fieldSchema` below.
 *   2. Add an entry to `fieldTypes` (TypeScript errors until you do).
 *   3. Add its renderers to `fieldDisplay` and `fieldInput` in src/crm/ui/fields.tsx
 *      (TypeScript errors there too).
 * Then run `bun run crm:gen`. Nothing else needs to change.
 */

export const ident = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*$/, 'use camelCase identifiers (e.g. dealValue)')

const selectOption = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
  color: z
    .enum(['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'])
    .optional(),
  /**
   * Chance of winning, 0 to 100, for a record at this option (a pipeline stage).
   * Boards and reports use it to show a weighted total beside the plain one.
   */
  probability: z.number().min(0).max(100).optional(),
  /**
   * Only offer this option when the field named by the select's `dependsOn`
   * holds one of these values. Options without `when` are always offered.
   */
  when: z.array(z.string().min(1)).min(1).optional(),
})

/**
 * Field-level encryption intent (CipherStash). Values map to EQL v3 column
 * domains once @cipherstash/stack-prisma supports Prisma 8:
 *   storage -> cipherstash.Text()       (encrypted, not queryable)
 *   eq      -> cipherstash.TextEq()     (equality)
 *   match   -> cipherstash.TextMatch()  (free-text search)
 *   search  -> cipherstash.TextSearch() (equality + range + free-text)
 * Until then these fields are stored as PLAINTEXT and crm:gen prints a warning.
 */
const encryption = z.enum(['storage', 'eq', 'match', 'search'])

const fieldBase = {
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().default(false),
  /** Include this field in the list-view search box (text-like fields only). */
  searchable: z.boolean().default(false),
  encrypted: encryption.optional(),
}

const text = <T extends 'text' | 'longtext' | 'email' | 'phone' | 'url'>(type: T) =>
  z.object({ ...fieldBase, type: z.literal(type), default: z.string().optional() })

export const fieldSchema = z.discriminatedUnion('type', [
  text('text'),
  text('longtext'),
  text('email'),
  text('phone'),
  text('url'),
  z.object({ ...fieldBase, type: z.literal('number'), default: z.number().optional() }),
  z.object({
    ...fieldBase,
    type: z.literal('currency'),
    /** ISO 4217 code used for display. */
    currency: z.string().length(3).default('USD'),
    default: z.number().optional(),
  }),
  z.object({ ...fieldBase, type: z.literal('boolean'), default: z.boolean().optional() }),
  z.object({ ...fieldBase, type: z.literal('date') }),
  z.object({ ...fieldBase, type: z.literal('datetime') }),
  z.object({
    ...fieldBase,
    type: z.literal('select'),
    options: z.array(selectOption).min(1),
    default: z.string().optional(),
    /**
     * Another select field on the same object that decides which options apply,
     * e.g. a `stage` that depends on `pipeline`. Scope options with `when`.
     */
    dependsOn: ident.optional(),
  }),
  z.object({
    ...fieldBase,
    type: z.literal('relation'),
    /** Key of the target object in `objects`. Stored as `<field>Id`. */
    to: ident,
  }),
  z.object({
    ...fieldBase,
    type: z.literal('relations'),
    /**
     * Key of the target object in `objects`: this field holds any number of
     * its records ("a contact has many tags"). Kept as rows of a links table,
     * read as `<field>` and written as `<field>Ids`.
     */
    to: ident,
    /**
     * A `relations` field on the target object that this field is the other
     * side of: both show and change the same links. Set it on one side only;
     * the side without it owns the links table.
     */
    inverse: ident.optional(),
  }),
  /** A teammate, by the auth provider's user id (record owner, assignee, ...). */
  z.object({ ...fieldBase, type: z.literal('user') }),
])

export type CrmField = z.output<typeof fieldSchema>
export type FieldType = CrmField['type']
type FieldOf<T extends FieldType> = Extract<CrmField, { type: T }>

export type FieldTypeDef<T extends FieldType> = {
  /**
   * What the column holds (src/server/store/table.ts). A relation's is its
   * record's id. `null` for a type with no column: its values are rows of
   * another table (`relations`).
   */
  column: Kind | null
  /** Text stored as a string: may be `searchable` and `encrypted`. */
  textLike?: boolean
  /** Parses one submitted value (forms send strings) into what Prisma stores, or null. */
  input: (field: FieldOf<T>) => z.ZodType
}

/** An empty form value (`''`, or a field left out) is stored as null. */
const nullable = (schema: z.ZodType) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), schema.nullable())

const plainText = {
  column: 'text',
  textLike: true,
  input: () => nullable(z.string().trim().max(20_000)),
} as const

const recordId = z.string().uuid()
const recordIds = z.array(recordId).max(LINKS_WRITE, `at most ${LINKS_WRITE} at a time`)
const unique = (ids: string[]) => [...new Set(ids)]

/**
 * A change to the records a `relations` field holds: `set` replaces them all,
 * `add` and `remove` change some and leave the rest.
 */
export type LinksChange = { set: string[] } | { add: string[]; remove: string[] }

/**
 * What a `relations` field is written with, under `<field>Ids`: a list of ids
 * or the ids in one string (a form, a CSV row), which replace the set, or
 * `{ add, remove }`. Nothing at all (`null`, `""`) is an empty set.
 */
const linksInput = z.preprocess(
  (value) => {
    if (value === null || value === undefined) {
      return { set: [] }
    }

    const typed = z.string().safeParse(value)

    if (typed.success) {
      return {
        set: typed.data
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id !== ''),
      }
    }

    return Array.isArray(value) ? { set: value } : value
  },
  z.union([
    z.strictObject({ set: recordIds.transform(unique) }),
    z.strictObject({
      add: recordIds.default([]).transform(unique),
      remove: recordIds.default([]).transform(unique),
    }),
  ]),
)

/** A checked value of a `relations` field, read back as the change it is. */
export const linksChangeSchema: z.ZodType<LinksChange> = z.union([
  z.object({ set: z.array(z.string()) }),
  z.object({ add: z.array(z.string()), remove: z.array(z.string()) }),
])

/** Every field type's definition, each typed by its own field's shape. */
type FieldTypes = { [T in FieldType]: FieldTypeDef<T> }

export const fieldTypes: FieldTypes = {
  text: plainText,
  longtext: plainText,
  phone: plainText,
  email: { column: 'text', textLike: true, input: () => nullable(z.string().trim().email()) },
  // http(s) only: a stored `javascript:` URL must never become a link.
  url: {
    column: 'text',
    textLike: true,
    input: () =>
      nullable(
        z
          .string()
          .trim()
          .url({ protocol: /^https?$/ }),
      ),
  },
  number: { column: 'float', input: () => nullable(z.coerce.number()) },
  // Two decimal places, read and written as a string to avoid float rounding.
  currency: {
    column: 'decimal',
    input: () => nullable(z.coerce.number().transform((n) => n.toFixed(2))),
  },
  boolean: {
    column: 'boolean',
    input: () => z.preprocess((v) => v === true || v === 'true' || v === 'on', z.boolean()),
  },
  date: {
    column: 'date',
    input: () => nullable(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')),
  },
  datetime: { column: 'timestamp', input: () => nullable(z.coerce.date()) },
  select: {
    column: 'text',
    input: (field) => nullable(z.enum(field.options.map((o) => o.value))),
  },
  relation: { column: 'text', input: () => nullable(recordId) },
  relations: { column: null, input: () => linksInput },
  user: { column: 'text', input: () => nullable(z.string().trim().max(200)) },
}

export const isTextLike = (type: FieldType): boolean => fieldTypes[type].textLike === true

/**
 * A field's submitted-value schema from its type's definition. Taking the type
 * as `T` lets TypeScript see that the definition and the field are of the same
 * type, which looking the definition up by `field.type` alone doesn't show it.
 */
const inputOf = <T extends FieldType>(type: T, field: FieldOf<T>): z.ZodType =>
  fieldTypes[type].input(field)

/** Zod schema for one field's submitted value, honouring `required`. */
export function fieldInputSchema(field: CrmField): z.ZodType {
  const schema = inputOf(field.type, field)
  return field.required && field.type !== 'boolean' && field.type !== 'relations'
    ? schema.refine((v) => v !== null, 'Required')
    : schema
}
