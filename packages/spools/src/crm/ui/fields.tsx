import { Link } from '@tanstack/react-router'
import { createContext, type ReactNode, useContext } from 'react'
import { z } from 'zod'

import type { CrmField, FieldType } from '../field-types'
import { countKey, idsKey } from '../links'
import { type LinksFormChange, readLinksChange } from '../links-form'
import { allowedOptions } from '../options'
import { inputClass } from './kit'
import { RelationInput, RelationsInput, type RelationTitles } from './relation-picker'
import { useCrmConfig } from './use-crm'

export type { RelationTitles }

/**
 * How each field type is displayed and edited. Both maps are checked for
 * completeness: add a type in src/crm/field-types.ts and TypeScript will point
 * here until it has a display and an input.
 */

type FieldOf<T extends FieldType> = Extract<CrmField, { type: T }>

/**
 * A value of a record as the browser holds it: what the store sends
 * (`CrmValue` in src/server/store/objects.ts), with relations nested as records.
 */
export type FieldData =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | readonly FieldData[]
  | { readonly [key: string]: FieldData }

/** A record's values, keyed by field. */
export type RecordData = { readonly [key: string]: FieldData }

/** What one column holds: the value a display shows. */
export const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.date()])
type Scalar = z.output<typeof scalarSchema>

/** A related record, nested under its relation field: its id and whatever fields came with it. */
export const relatedSchema = z.looseObject({ id: scalarSchema })
type Related = z.output<typeof relatedSchema>
/** The related records nested under a `relations` field. */
export const relatedListSchema = z.array(relatedSchema)

/** What `new Date()` can read: a Date as sent, the ISO text it was written as, or a timestamp. */
const momentSchema = z.union([z.string(), z.number(), z.date()])
/** A day with no time ("2026-03-09"). */
const daySchema = z.string().length(10)

/** A value as plain text, or `fallback` when it has none: absent, or a nested record or list. */
export function textOf(value: FieldData, fallback = ''): string {
  const scalar = scalarSchema.safeParse(value)
  return scalar.success ? String(scalar.data) : fallback
}

/** A stored moment as a Date, or undefined when the value is not one. */
export function toMoment(value: FieldData): Date | undefined {
  const moment = momentSchema.safeParse(value)
  return moment.success ? new Date(moment.data) : undefined
}

const badgeColors = new Map([
  ['gray', 'bg-zinc-500/12 text-zinc-700 dark:text-zinc-300'],
  ['red', 'bg-red-500/15 text-red-700 dark:text-red-300'],
  ['orange', 'bg-orange-500/15 text-orange-700 dark:text-orange-300'],
  ['amber', 'bg-amber-500/18 text-amber-800 dark:text-amber-300'],
  ['green', 'bg-green-500/15 text-green-700 dark:text-green-300'],
  ['teal', 'bg-teal-500/15 text-teal-700 dark:text-teal-300'],
  ['blue', 'bg-blue-500/15 text-blue-700 dark:text-blue-300'],
  ['indigo', 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300'],
  ['purple', 'bg-purple-500/15 text-purple-700 dark:text-purple-300'],
  ['pink', 'bg-pink-500/15 text-pink-700 dark:text-pink-300'],
])

/** A coloured tag, as used for select values. */
export function Badge({ children, color = 'gray' }: { children: ReactNode; color?: string }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-md px-1.5 text-xs font-medium whitespace-nowrap ${badgeColors.get(color) ?? badgeColors.get('gray')}`}
    >
      {children}
    </span>
  )
}

export type CrmUserOption = { id: string; name: string; email: string }
/** The CRM's users, for `user` fields. Provided by the CRM layout route. */
export const CrmUsersContext = createContext<CrmUserOption[]>([])

// ── Display ─────────────────────────────────────────────────────────────────

type DisplayProps<T extends FieldType> = {
  field: FieldOf<T>
  /** Never null, undefined or "": empty values are rendered by FieldValue. */
  value: T extends 'relation' ? Related : T extends 'relations' ? Related[] : Scalar
  /** For `relations`: how many related records there are beyond the ones in `value`. */
  more?: number
  titleFieldOf: (objectKey: string) => string
  users: CrmUserOption[]
  /** Render text only: no links. Set when the value sits inside another link (cards, rows). */
  plain: boolean
}

type FieldDisplays = { [T in FieldType]: (props: DisplayProps<T>) => ReactNode }

/**
 * Renders a value with its field type's display. Generic over the type so that
 * TypeScript can see the display and its props belong to the same field type.
 */
function showValue<T extends FieldType>(
  displays: FieldDisplays,
  type: T,
  props: DisplayProps<T>,
): ReactNode {
  return displays[type](props)
}

/** A moment to show: a day with no time is that day wherever it is read, not midnight UTC. */
function momentOf(value: Scalar): Date | undefined {
  const day = daySchema.safeParse(value)

  if (day.success) {
    return new Date(`${day.data}T00:00:00`)
  }

  return toMoment(value)
}

const stop = (e: React.MouseEvent) => e.stopPropagation()
const textOnly = ({ value }: { value: Scalar }) => <span>{String(value)}</span>

const fieldDisplay = {
  text: textOnly,
  phone: textOnly,
  // Falls back to the stored id for people who have since left the allowlist.
  user: ({ value, users }) => (
    <span>{users.find((u) => u.id === value)?.name ?? String(value)}</span>
  ),
  longtext: ({ value }) => <span className="whitespace-pre-wrap">{String(value)}</span>,
  email: ({ value, plain }) =>
    plain ? (
      <span>{String(value)}</span>
    ) : (
      <a href={`mailto:${String(value)}`} className="text-c-accent hover:underline" onClick={stop}>
        {String(value)}
      </a>
    ),
  url: ({ value, plain }) => {
    const text = String(value).replace(/^https?:\/\//, '')
    return plain ? (
      <span>{text}</span>
    ) : (
      <a
        href={String(value)}
        target="_blank"
        rel="noreferrer"
        className="text-c-accent hover:underline"
        onClick={stop}
      >
        {text}
      </a>
    )
  },
  number: ({ value }) => <span className="tabular-nums">{Number(value).toLocaleString()}</span>,
  currency: ({ field, value }) => (
    <span className="tabular-nums">
      {new Intl.NumberFormat(undefined, { style: 'currency', currency: field.currency }).format(
        Number(value),
      )}
    </span>
  ),
  boolean: ({ value }) => <span>{value ? 'Yes' : 'No'}</span>,
  date: ({ value }) => <span>{new Date(`${String(value)}T00:00:00`).toLocaleDateString()}</span>,
  datetime: ({ value }) => <span>{toMoment(value)?.toLocaleString() ?? String(value)}</span>,
  select: ({ field, value }) => {
    const opt = field.options.find((o) => o.value === value)
    return <Badge color={opt?.color}>{opt?.label ?? String(value)}</Badge>
  },
  relation: ({ field, value: rel, titleFieldOf, plain }) => {
    const named = scalarSchema.safeParse(rel[titleFieldOf(field.to)])
    const title = String(named.success ? named.data : rel.id)

    if (plain) {
      return <span>{title}</span>
    }

    return (
      <Link
        to="/$object/$id"
        params={{ object: field.to, id: String(rel.id) }}
        className="text-c-accent hover:underline"
        onClick={stop}
      >
        {title}
      </Link>
    )
  },
  relations: ({ field, value: list, titleFieldOf, plain, more = 0 }) => {
    // Inline, so a table cell keeps them on its one line and a detail panel lets them wrap.
    const chip =
      'bg-c-hov text-c-fg mr-1 inline-flex h-5 max-w-40 items-center rounded-md px-1.5 align-middle text-xs font-medium'

    return (
      <span>
        {list.map((rel) => {
          const named = scalarSchema.safeParse(rel[titleFieldOf(field.to)])
          const title = String(named.success ? named.data : rel.id)

          return plain ? (
            <span key={String(rel.id)} className={chip}>
              <span className="truncate">{title}</span>
            </span>
          ) : (
            <Link
              key={String(rel.id)}
              to="/$object/$id"
              params={{ object: field.to, id: String(rel.id) }}
              className={`${chip} hover:text-c-accent`}
              onClick={stop}
            >
              <span className="truncate">{title}</span>
            </Link>
          )
        })}
        {more > 0 && <span className="text-c-fg3 text-xs whitespace-nowrap">+{more} more</span>}
      </span>
    )
  },
} satisfies FieldDisplays

const empty = <span className="text-c-fg3">—</span>

/** Read-only rendering of a field value inside tables, cards and detail views. */
export function FieldValue({
  field,
  fieldKey,
  record,
  titleFieldOf,
  plain = false,
}: {
  /** Undefined for system fields (createdAt, updatedAt, createdBy). */
  field: CrmField | undefined
  fieldKey: string
  record: RecordData
  titleFieldOf: (objectKey: string) => string
  /** Text only, no links: for values rendered inside another link. */
  plain?: boolean
}) {
  const users = useContext(CrmUsersContext)
  const value = record[fieldKey]

  if (value === null || value === undefined || value === '') {
    return empty
  }

  if (field?.type === 'relation') {
    const related = relatedSchema.safeParse(value)
    return related.success ? (
      <>
        {showValue(fieldDisplay, 'relation', {
          field,
          value: related.data,
          titleFieldOf,
          users,
          plain,
        })}
      </>
    ) : (
      empty
    )
  }

  if (field?.type === 'relations') {
    const related = relatedListSchema.safeParse(value)

    if (!related.success || related.data.length === 0) {
      return empty
    }

    const total = z.number().safeParse(record[countKey(fieldKey)])
    return (
      <>
        {showValue(fieldDisplay, 'relations', {
          field,
          value: related.data,
          titleFieldOf,
          users,
          plain,
          more: Math.max(0, (total.success ? total.data : 0) - related.data.length),
        })}
      </>
    )
  }

  // Anything other than a relation holds one column's value. Something else (a
  // list, an object) has no display, so it is shown as empty, not as "[object Object]".
  const scalar = scalarSchema.safeParse(value)

  if (!scalar.success) {
    return empty
  }

  if (!field) {
    if (fieldKey.endsWith('At') || fieldKey === 'nextTaskDue') {
      return (
        <span className="text-c-fg2">
          {momentOf(scalar.data)?.toLocaleDateString(undefined, { dateStyle: 'medium' }) ??
            String(scalar.data)}
        </span>
      )
    }

    return <span>{String(scalar.data)}</span>
  }

  return (
    <>
      {showValue(fieldDisplay, field.type, {
        field,
        value: scalar.data,
        titleFieldOf,
        users,
        plain,
      })}
    </>
  )
}

// ── Input ───────────────────────────────────────────────────────────────────

type InputProps<T extends FieldType> = {
  field: FieldOf<T>
  /** Form control name: the field key, or `<key>Id` for relations. */
  name: string
  /** Current value, falling back to the field's default. */
  value: FieldData
  /** Titles the page already holds for related records, so a value that is set shows its name at once. */
  titles?: RelationTitles
  users: CrmUserOption[]
  /** For a select with `dependsOn`: the value its controlling field holds right now. */
  controlling?: FieldData
  /** For `relations`: the related records the record came with (under the field's key), and how many it holds. */
  related?: FieldData
  total?: FieldData
  /** For `relations`: whether `value` is what a saved record holds. False for a new record's preset, which is still to be added. */
  saved?: boolean
}

type FieldInputs = { [T in FieldType]: (props: InputProps<T>) => ReactNode }

/** Renders a field type's input; generic for the same reason as `showValue`. */
function showInput<T extends FieldType>(
  inputs: FieldInputs,
  type: T,
  props: InputProps<T>,
): ReactNode {
  return inputs[type](props)
}

/** The text an input starts with: a column's value as typed, or nothing (a nested record or a list has no text). */
const asString = (value: FieldData) => textOf(value)

/** What the shared text and number inputs need; every field's props satisfy it. */
type BasicInputProps = { field: { required: boolean }; name: string; value: FieldData }

const textInput =
  (type: 'text' | 'email' | 'url' | 'tel') =>
  ({ field, name, value }: BasicInputProps) => (
    <input
      id={name}
      type={type}
      name={name}
      defaultValue={asString(value)}
      required={field.required}
      className={inputClass}
    />
  )

const numberInput =
  (step: string) =>
  ({ field, name, value }: BasicInputProps) => (
    <input
      type="number"
      step={step}
      name={name}
      defaultValue={asString(value)}
      required={field.required}
      className={inputClass}
    />
  )

const fieldInput = {
  text: textInput('text'),
  email: textInput('email'),
  url: textInput('url'),
  phone: textInput('tel'),
  longtext: ({ field, name, value }) => (
    <textarea
      id={name}
      name={name}
      defaultValue={asString(value)}
      rows={4}
      required={field.required}
      className={inputClass}
    />
  ),
  number: numberInput('any'),
  currency: numberInput('0.01'),
  boolean: ({ name, value }) => (
    <input
      id={name}
      type="checkbox"
      name={name}
      defaultChecked={value === true}
      className="size-4 rounded accent-(--c-accent)"
    />
  ),
  date: ({ field, name, value }) => (
    <input
      id={name}
      type="date"
      name={name}
      defaultValue={asString(value)}
      required={field.required}
      className={inputClass}
    />
  ),
  datetime: ({ field, name, value }) => (
    <input
      id={name}
      type="datetime-local"
      name={name}
      defaultValue={inputMoment(value)}
      required={field.required}
      className={inputClass}
    />
  ),
  select: ({ field, name, value, controlling }) => {
    const options = allowedOptions(field, controlling)
    const current = asString(value)
    return (
      <select
        // Remount when the controlling field changes, so the choice resets to one that applies.
        key={field.dependsOn ? asString(controlling) : undefined}
        id={name}
        name={name}
        defaultValue={
          options.some((o) => o.value === current) ? current : (options[0]?.value ?? '')
        }
        required={field.required}
        className={inputClass}
      >
        {!field.required && <option value="">—</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label ?? o.value}
          </option>
        ))}
      </select>
    )
  },
  relation: ({ field, name, value, titles }) => (
    <RelationInput
      objectKey={field.to}
      name={name}
      value={asString(value)}
      required={field.required}
      titles={titles}
    />
  ),
  relations: ({ field, name, value, titles, related, total, saved = false }) => (
    <RelationsField
      objectKey={field.to}
      name={name}
      ids={value}
      related={related}
      total={total}
      titles={titles}
      saved={saved}
    />
  ),
  user: ({ field, name, value, users }) => {
    const current = asString(value)
    const known = users.some((u) => u.id === current)
    return (
      <select
        id={name}
        name={name}
        defaultValue={current}
        required={field.required}
        className={inputClass}
      >
        <option value="">—</option>
        {current && !known && <option value={current}>{current}</option>}
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
    )
  },
} satisfies FieldInputs

/** The ids a relations field starts with: a list as a record holds it, or the ids in one string. */
const idListSchema = z.union([
  z.array(z.string()),
  z.string().transform((ids) =>
    ids
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  ),
])

/** A relations field's input, given what the record (or a new record's preset) holds for it. */
function RelationsField({
  objectKey,
  name,
  ids,
  related,
  total,
  titles,
  saved,
}: {
  objectKey: string
  name: string
  ids: FieldData
  related: FieldData
  total: FieldData
  titles?: RelationTitles | undefined
  /** Whether `ids` are held by a saved record, or only chosen for one that is being made. */
  saved: boolean
}) {
  const titleField = useCrmConfig().objects[objectKey]?.titleField ?? 'id'
  const records = relatedListSchema.safeParse(related).data ?? []
  const count = z.number().safeParse(total).data

  const value = (idListSchema.safeParse(ids).data ?? []).map((id) => {
    const title = z.string().safeParse(records.find((r) => r.id === id)?.[titleField]).data
    return { id, title }
  })

  return (
    <RelationsInput
      objectKey={objectKey}
      name={name}
      value={value}
      held={saved ? value.map((v) => v.id) : []}
      total={count}
      titles={titles}
    />
  )
}

/** A datetime input's starting text ("2026-03-09T14:30"), or nothing when the value is not a moment. */
function inputMoment(value: FieldData): string {
  return (value && toMoment(value)?.toISOString().slice(0, 16)) || ''
}

/** The form control name for a field. */
export const inputName = (fieldKey: string, field: CrmField) =>
  field.type === 'relation'
    ? `${fieldKey}Id`
    : field.type === 'relations'
      ? idsKey(fieldKey)
      : fieldKey

/** Uncontrolled form control for a field; the form reads values via FormData. */
export function FieldInput({
  field,
  fieldKey,
  record,
  titles,
  controlling,
}: {
  field: CrmField
  fieldKey: string
  record?: RecordData
  /** Titles the page already holds for related records named in `record`. */
  titles?: RelationTitles
  /** For a select with `dependsOn`: the controlling field's current value in the form. */
  controlling?: FieldData
}) {
  const name = inputName(fieldKey, field)
  const value = record?.[name] ?? ('default' in field ? field.default : undefined)
  const users = useContext(CrmUsersContext)
  return (
    <>
      {showInput(fieldInput, field.type, {
        field,
        name,
        value,
        titles,
        users,
        controlling,
        related: record?.[fieldKey],
        total: record?.[countKey(fieldKey)],
        // A record that has been saved has an id. Without one, `record` is a new record's preset.
        saved: record?.id !== undefined && record.id !== null,
      })}
    </>
  )
}

/** One submitted value: an input's text, whether a checkbox is ticked, or a relations field's change. */
export type FormValue = FormDataEntryValue | boolean | LinksFormChange

/** What a form holds: its values by control name, and the keys of the fields whose value could not be read. */
export type FormRead = { values: Record<string, FormValue>; unreadable: string[] }

/**
 * Convert FormData into a plain object; unchecked checkboxes become false. A
 * relations field whose change can't be read is named in `unreadable` and left
 * out of `values`: the form says so instead of saving the record without it.
 */
export function formValues(data: FormData, fields: Record<string, CrmField>): FormRead {
  const values: Record<string, FormValue> = {}
  const unreadable: string[] = []

  for (const [key, field] of Object.entries(fields)) {
    const name = inputName(key, field)

    if (field.type === 'relations') {
      const change = readLinksChange(data.get(name))

      if (change) {
        values[name] = change
      } else {
        unreadable.push(key)
      }
    } else {
      values[name] = field.type === 'boolean' ? data.get(name) === 'on' : (data.get(name) ?? '')
    }
  }

  return { values, unreadable }
}
