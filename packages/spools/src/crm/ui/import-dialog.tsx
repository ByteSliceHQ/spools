import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { importRecordsFn, matchRelationTitlesFn } from '../../server/workspace.functions'
import type { PublicCrmConfig } from '../config'
import { mapCsv, parseCsv, relationCells } from '../csv'
import type { RelationTitles } from './fields'
import { Button, Dialog } from './kit'

type Obj = PublicCrmConfig['objects'][string]

/** Longer than any title: such a cell can't name a record, so it isn't asked about. */
const MAX_CELL = 2000
/** How many names the server is asked about at a time. */
const ASK = 1000

/** Ask the server which records the file's relation cells name. It looks through every record, not a first page. */
async function namedRecords(obj: Obj, table: string[][]): Promise<RelationTitles> {
  const titles: RelationTitles = {}

  for (const [to, cells] of Object.entries(relationCells(obj, table))) {
    const values = cells.filter((c) => c.length <= MAX_CELL)

    for (let at = 0; at < values.length; at += ASK) {
      const found = await matchRelationTitlesFn({
        data: { objectKey: to, values: values.slice(at, at + ASK) },
      })

      titles[to] = [...(titles[to] ?? []), ...found]
    }
  }

  return titles
}

export function ImportDialog({
  open,
  onClose,
  objectKey,
  obj,
}: {
  open: boolean
  onClose: () => void
  objectKey: string
  obj: Obj
}) {
  const router = useRouter()
  const [mapped, setMapped] = useState<ReturnType<typeof mapCsv> | null>(null)
  const [busy, setBusy] = useState(false)

  const [result, setResult] = useState<{
    created: number
    failed: number
    errors: { row: number; message: string }[]
  } | null>(null)

  const [error, setError] = useState<string>()

  const close = () => {
    setMapped(null)
    setResult(null)
    setError(undefined)
    onClose()
  }

  async function run() {
    if (!mapped) {
      return
    }

    setBusy(true)
    setError(undefined)

    try {
      setResult(await importRecordsFn({ data: { objectKey, rows: mapped.rows.slice(0, 1000) } }))
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={close} title={`Import ${obj.labelPlural.toLowerCase()} from CSV`}>
      {result ? (
        <div className="space-y-3">
          <p>
            Imported <strong>{result.created}</strong>{' '}
            {result.created === 1 ? obj.label.toLowerCase() : obj.labelPlural.toLowerCase()}.
            {result.failed > 0 && ` ${result.failed} could not be imported.`}
          </p>
          {result.errors.length > 0 && (
            <ul className="border-c-line text-c-fg2 max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs">
              {result.errors.map((e) => (
                <li key={e.row}>
                  Row {e.row}: {e.message}
                </li>
              ))}
            </ul>
          )}
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-c-fg2">
            The first row must be column names. Columns are matched to fields by name; relations
            match by the related record's name. Up to 1,000 rows per import.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="CSV file"
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0]
              setMapped(null)
              setError(undefined)

              if (!file) {
                return
              }

              setBusy(true)

              try {
                const table = parseCsv(await file.text())
                setMapped(mapCsv(obj, await namedRecords(obj, table), table))
              } catch {
                setError('The file could not be read. Choose it again.')
              } finally {
                setBusy(false)
              }
            }}
            className="file:border-c-line2 file:bg-c-raised file:text-c-fg block w-full text-[13px] file:mr-3 file:h-7 file:rounded-lg file:border file:px-2.5 file:text-[13px] file:font-medium"
          />
          {mapped && (
            <div className="border-c-line space-y-1 rounded-lg border p-3 text-xs">
              <div>
                <span className="font-medium">{mapped.rows.length.toLocaleString()}</span> rows to
                import
                {mapped.rows.length > 1000 && ' (only the first 1,000 will be imported)'}
              </div>
              <div className="text-c-fg2">Matched: {mapped.matched.join(', ') || 'none'}</div>
              {mapped.ignored.length > 0 && (
                <div className="text-c-fg3">Ignored columns: {mapped.ignored.join(', ')}</div>
              )}
            </div>
          )}
          {error && <p className="text-c-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!mapped || mapped.rows.length === 0 || busy}
              onClick={run}
            >
              {busy ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
