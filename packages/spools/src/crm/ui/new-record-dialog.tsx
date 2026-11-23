import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { createRecordFn } from '../../server/crm.functions'
import type { PublicCrmConfig } from '../config'
import type { RecordData, RelationTitles } from './fields'
import { Dialog } from './kit'
import { RecordForm } from './record-form'

/** Quick-create: a new record without leaving the list. `preset` pre-fills fields (e.g. a board column). */
export function NewRecordDialog({
  open,
  onClose,
  objectKey,
  obj,
  titles,
  preset,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  objectKey: string
  obj: PublicCrmConfig['objects'][string]
  /** Titles the page already holds for related records named in `preset`. */
  titles?: RelationTitles
  preset?: RecordData
  onCreated?: (id: string) => void
}) {
  const router = useRouter()
  const [error, setError] = useState<string>()

  return (
    <Dialog open={open} onClose={onClose} title={`New ${obj.label.toLowerCase()}`}>
      <RecordForm
        // Remount per preset so defaults apply to a fresh form.
        key={JSON.stringify(preset ?? {})}
        obj={obj}
        record={preset}
        titles={titles}
        error={error}
        submitLabel={`Create ${obj.label.toLowerCase()}`}
        onSubmit={async (values) => {
          setError(undefined)

          try {
            const { id } = await createRecordFn({ data: { objectKey, values } })
            await router.invalidate()
            onClose()
            onCreated?.(id)
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not create the record')
          }
        }}
      />
    </Dialog>
  )
}
