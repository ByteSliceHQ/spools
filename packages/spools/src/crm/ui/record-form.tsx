import { useState } from 'react'

import type { PublicCrmConfig } from '../config'
import { fieldLabel } from '../naming'
import { controllingFields } from '../options'
import {
  type FieldData,
  FieldInput,
  type FormValue,
  formValues,
  inputName,
  type RecordData,
  type RelationTitles,
} from './fields'

type Obj = PublicCrmConfig['objects'][string]

export function RecordForm({
  obj,
  record,
  titles,
  onSubmit,
  submitLabel,
  error,
  className = '',
}: {
  obj: Obj
  record?: RecordData
  /** Titles the page already holds for related records named in `record`. */
  titles?: RelationTitles
  onSubmit: (values: Record<string, FormValue>) => Promise<void>
  submitLabel: string
  error?: string
  className?: string
}) {
  const [pending, setPending] = useState(false)
  const [unread, setUnread] = useState<string>()
  // Fields other selects depend on (e.g. pipeline) are tracked, so their
  // dependents can offer the options that apply as the form is filled in.
  const controllers = controllingFields(obj.fields)

  const [controlling, setControlling] = useState(() =>
    Object.fromEntries(
      [...controllers].map((key): [string, FieldData] => {
        const field = obj.fields[key]
        return [key, record?.[key] ?? (field && 'default' in field ? field.default : undefined)]
      }),
    ),
  )

  return (
    <form
      className={`space-y-3.5 ${className}`}
      onChange={(e) => {
        const target = e.target

        if (target instanceof HTMLSelectElement && controllers.has(target.name)) {
          setControlling((c) => ({ ...c, [target.name]: target.value }))
        }
      }}
      onSubmit={async (e) => {
        e.preventDefault()
        const { values, unreadable } = formValues(new FormData(e.currentTarget), obj.fields)

        // Nothing is sent: saving the rest would look as if these fields had been left alone.
        if (unreadable.length > 0) {
          const labels = unreadable.map((key) => fieldLabel(key, obj.fields[key])).join(', ')

          setUnread(
            `Could not read ${labels} from this form, so nothing was saved. Reload the page and try again.`,
          )

          return
        }

        setUnread(undefined)
        setPending(true)

        try {
          await onSubmit(values)
        } finally {
          setPending(false)
        }
      }}
    >
      {Object.entries(obj.fields).map(([key, field]) => (
        <div key={key} className="space-y-1.5">
          <label htmlFor={inputName(key, field)} className="text-c-fg2 block text-xs font-medium">
            {fieldLabel(key, field)}
            {field.required && <span className="text-c-danger"> *</span>}
            {field.encrypted && (
              <span
                className="ml-2 text-[11px] font-normal text-amber-600 dark:text-amber-400"
                title="Encryption is pending Prisma 8 support in @cipherstash/stack-prisma"
              >
                encryption pending
              </span>
            )}
          </label>
          <FieldInput
            field={field}
            fieldKey={key}
            record={record}
            titles={titles}
            controlling={
              field.type === 'select' && field.dependsOn ? controlling[field.dependsOn] : undefined
            }
          />
          {field.description && <p className="text-c-fg3 text-xs">{field.description}</p>}
        </div>
      ))}
      {(unread ?? error) && (
        <p className="text-c-danger rounded-lg bg-red-500/10 p-3 text-[13px] whitespace-pre-wrap">
          {unread ?? error}
        </p>
      )}
      {/* Stays in view at the bottom of a scrolling dialog. */}
      <div className="bg-c-raised/95 sticky bottom-0 -mx-1 px-1 pt-3 pb-1 backdrop-blur">
        <button
          type="submit"
          disabled={pending}
          className="bg-c-accent hover:bg-c-accent-hov h-7 rounded-lg px-3 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
