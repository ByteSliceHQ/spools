import { useRouter } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'
import { useContext, useRef, useState } from 'react'
import { z } from 'zod'

import { updateRecordFn } from '../../server/crm.functions'
import type { CrmField } from '../field-types'
import { allowedOptions } from '../options'
import {
  Badge,
  CrmUsersContext,
  type FieldData,
  FieldValue,
  inputName,
  type RecordData,
  relatedListSchema,
  relatedSchema,
  textOf,
  toMoment,
} from './fields'
import { cx, useDismiss } from './kit'
import { RelationPopover } from './relation-picker'

/**
 * A field value that edits in place: click to edit, Enter or blur to save,
 * Escape to cancel. Select and user fields open a picker of their options; a
 * relation opens a search over the related object's records, and a relations
 * field the same search, where each record ticked or unticked is saved at once.
 * Used by table cells and the record details panel.
 */

type Option = { value: string; label: string; color?: string }

type Props = {
  objectKey: string
  record: RecordData
  fieldKey: string
  field: CrmField
  titleFieldOf: (objectKey: string) => string
  /** `cell` fills a table cell; `detail` is a row in the record panel. */
  variant?: 'cell' | 'detail'
}

const nativeType: Partial<Record<CrmField['type'], string>> = {
  text: 'text',
  email: 'email',
  url: 'url',
  phone: 'tel',
  number: 'number',
  currency: 'number',
  date: 'date',
  datetime: 'datetime-local',
}

/** Text a value is compared and picked by: ids and option values are strings. */
const textSchema = z.string()

function toInputValue(field: CrmField, value: FieldData): string {
  if (value === null || value === undefined) {
    return ''
  }

  if (field.type === 'datetime') {
    return toMoment(value)?.toISOString().slice(0, 16) ?? ''
  }

  // A nested record or a list has no text to edit.
  return textOf(value)
}

export function InlineField({
  objectKey,
  record,
  fieldKey,
  field,
  titleFieldOf,
  variant = 'cell',
}: Props) {
  const router = useRouter()
  const users = useContext(CrmUsersContext)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const name = inputName(fieldKey, field)
  const current = record[name]

  /** Links or lets go of one record of a relations field, at once. The picker stays open for the next. */
  async function toggleLink(otherId: string, held: boolean) {
    setSaving(true)
    setError(undefined)

    try {
      await updateRecordFn({
        data: {
          objectKey,
          id: textOf(record.id),
          values: { [name]: held ? { remove: [otherId] } : { add: [otherId] } },
        },
      })

      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  async function save(value: string | boolean) {
    setEditing(false)

    if (value === current || (value === '' && (current === null || current === undefined))) {
      return
    }

    setSaving(true)
    setError(undefined)

    try {
      await updateRecordFn({
        data: { objectKey, id: textOf(record.id), values: { [name]: value } },
      })

      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const options: Option[] | null =
    field.type === 'select'
      ? allowedOptions(field, field.dependsOn ? record[field.dependsOn] : undefined).map((o) => ({
          value: o.value,
          label: o.label ?? o.value,
          color: o.color,
        }))
      : field.type === 'user'
        ? users.map((u) => ({ value: u.id, label: u.name }))
        : null

  const shell = cx(
    'group/field relative flex w-full items-center text-left',
    variant === 'cell' ? 'h-full min-h-[29px]' : 'min-h-7',
    variant === 'cell' ? 'px-2.5' : 'rounded-lg px-2 hover:bg-c-hov',
    saving && 'opacity-50',
  )

  // Booleans toggle on click; there is nothing to type.
  if (field.type === 'boolean') {
    return (
      <button
        type="button"
        className={shell}
        onClick={() => save(!(current === true))}
        title={error}
      >
        <span
          className={cx(
            'flex size-4 items-center justify-center rounded border',
            current === true
              ? 'border-c-accent bg-c-accent text-white'
              : 'border-c-line2 bg-c-raised',
          )}
        >
          {current === true && <Check className="size-3" strokeWidth={3} />}
        </span>
      </button>
    )
  }

  if (editing && field.type === 'relation') {
    const related = relatedSchema.safeParse(record[fieldKey]).data
    const relatedTitle = textSchema.safeParse(related?.[titleFieldOf(field.to)]).data
    return (
      <div className={shell}>
        <span className="min-w-0 truncate">
          <FieldValue
            field={field}
            fieldKey={fieldKey}
            record={record}
            titleFieldOf={titleFieldOf}
          />
        </span>
        <RelationPopover
          objectKey={field.to}
          selected={textSchema.safeParse(current).data}
          selectedTitle={relatedTitle}
          clearable={!field.required}
          align={variant === 'detail' ? 'right' : 'left'}
          onPick={(picked) => save(picked?.id ?? '')}
          onClose={() => setEditing(false)}
        />
      </div>
    )
  }

  if (editing && field.type === 'relations') {
    const held = (relatedListSchema.safeParse(record[fieldKey]).data ?? []).map((r) => String(r.id))

    return (
      <div className={shell} title={error}>
        <span className="min-w-0 truncate">
          <FieldValue
            field={field}
            fieldKey={fieldKey}
            record={record}
            titleFieldOf={titleFieldOf}
          />
        </span>
        {error && <span className="text-c-danger ml-2 shrink-0 text-xs">!</span>}
        <RelationPopover
          objectKey={field.to}
          selectedIds={held}
          align={variant === 'detail' ? 'right' : 'left'}
          onPick={(picked) => {
            if (picked && !saving) {
              void toggleLink(picked.id, held.includes(picked.id))
            }
          }}
          onClose={() => setEditing(false)}
        />
      </div>
    )
  }

  if (editing && options) {
    return (
      <div className={shell}>
        <span className="min-w-0 truncate">
          <FieldValue
            field={field}
            fieldKey={fieldKey}
            record={record}
            titleFieldOf={titleFieldOf}
          />
        </span>
        <OptionPicker
          options={options}
          selected={textSchema.safeParse(current).data ?? ''}
          clearable={!field.required}
          align={variant === 'detail' ? 'right' : 'left'}
          onPick={save}
          onClose={() => setEditing(false)}
        />
      </div>
    )
  }

  if (editing) {
    const common = {
      autoFocus: true,
      defaultValue: toInputValue(field, current),
      className:
        'w-full rounded-md border border-c-accent bg-c-raised px-1.5 py-0.5 text-[13px] text-c-fg ring-2 ring-c-accent/20 outline-none',
      onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        save(e.currentTarget.value),
    }

    return (
      <div className={cx(shell, 'px-1')}>
        {field.type === 'longtext' ? (
          <textarea
            {...common}
            rows={4}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false)
              }

              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.currentTarget.blur()
              }
            }}
          />
        ) : (
          <input
            {...common}
            type={nativeType[field.type] ?? 'text'}
            step={field.type === 'currency' ? '0.01' : 'any'}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false)
              }

              if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
            }}
          />
        )}
      </div>
    )
  }

  return (
    // A real <button> can't contain the links some values render.
    <div
      role="button"
      tabIndex={0}
      className={cx(shell, 'cursor-text')}
      title={error}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setEditing(true)
        }
      }}
    >
      <span
        className={cx(
          'min-w-0',
          (field.type === 'longtext' || field.type === 'relations') && variant === 'detail'
            ? 'py-1'
            : 'truncate',
        )}
      >
        <FieldValue field={field} fieldKey={fieldKey} record={record} titleFieldOf={titleFieldOf} />
      </span>
      {error && <span className="text-c-danger ml-2 shrink-0 text-xs">!</span>}
    </div>
  )
}

function OptionPicker({
  options,
  selected,
  clearable,
  align,
  onPick,
  onClose,
}: {
  options: Option[]
  selected: string
  clearable: boolean
  /** Which edge of the field the picker lines up with (right inside narrow panels). */
  align: 'left' | 'right'
  onPick: (value: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  useDismiss(ref, onClose)

  const shown = options
    .filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 50)

  return (
    <div
      ref={ref}
      className={cx(
        'absolute top-full z-40 mt-1 w-60 rounded-xl border border-c-line2 bg-c-raised shadow-xl shadow-black/10',
        align === 'right' ? 'right-0' : 'left-0',
      )}
    >
      <input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- The picker opens in response to a click on the field.
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown[0]) {
            onPick(shown[0].value)
          }
        }}
        placeholder="Search…"
        className="border-c-line text-c-fg placeholder:text-c-fg3 w-full border-b bg-transparent px-3 py-2 text-[13px] outline-none"
      />
      <div className="max-h-60 overflow-y-auto p-1">
        {shown.length === 0 && <div className="text-c-fg3 px-2 py-1.5 text-[13px]">No matches</div>}
        {shown.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onPick(o.value)}
            className="text-c-fg hover:bg-c-hov flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]"
          >
            {o.color ? (
              <Badge color={o.color}>{o.label}</Badge>
            ) : (
              <span className="truncate">{o.label}</span>
            )}
            {o.value === selected && <Check className="text-c-accent size-3.5 shrink-0" />}
          </button>
        ))}
      </div>
      {clearable && selected && (
        <button
          type="button"
          onClick={() => onPick('')}
          className="border-c-line text-c-fg2 hover:bg-c-hov flex w-full items-center gap-2 border-t px-3 py-2 text-left text-[13px]"
        >
          <X className="size-3.5" /> Clear
        </button>
      )}
    </div>
  )
}
