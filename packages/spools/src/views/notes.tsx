import { getRouteApi } from '@tanstack/react-router'
import { FileText, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Button } from '../crm/ui/kit'
import { TopBar } from '../crm/ui/shell'
import { NoteCard, NoteDialog, type NoteItem } from '../crm/ui/workspace'

const route = getRouteApi('/_crm/notes')

export function Notes(): ReactNode {
  const notes = route.useLoaderData()
  const [editing, setEditing] = useState<NoteItem | 'new' | null>(null)

  return (
    <>
      <TopBar icon={<FileText className="text-c-fg2 size-3.5" />} title="Notes" />
      <div className="border-c-line flex h-11 shrink-0 items-center border-b px-3">
        <span className="text-c-fg2">{notes.length.toLocaleString()} notes</span>
        <Button
          variant="primary"
          className="ml-auto"
          data-guide="new-note"
          onClick={() => setEditing('new')}
        >
          <Plus className="size-3.5" /> New note
        </Button>
      </div>
      <div data-guide="notes-list" className="min-h-0 flex-1 overflow-y-auto p-3">
        {notes.length === 0 ? (
          <div className="text-c-fg3 py-20 text-center">
            <p>No notes yet. Write one here, or from any record.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {notes.map((n) => (
              <NoteCard key={n.id} note={n} onOpen={() => setEditing(n)} />
            ))}
          </div>
        )}
      </div>
      <NoteDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        note={editing && editing !== 'new' ? editing : undefined}
      />
    </>
  )
}
