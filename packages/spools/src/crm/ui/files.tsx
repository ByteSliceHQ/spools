import { Link } from '@tanstack/react-router'
import {
  ChevronRight,
  CornerLeftUp,
  ExternalLink,
  File as FileIcon,
  FileText,
  Folder,
  FolderPlus,
  Image,
  LayoutGrid,
  Link2,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { z } from 'zod'

import {
  createFolderFn,
  deleteItemFn,
  finishUploadFn,
  listFolderFn,
  moveItemFn,
  renameItemFn,
  searchFilesFn,
  startUploadFn,
} from '../../server/files.functions'
import { formatBytes, MAX_FILES_PER_UPLOAD, MAX_UPLOAD_BYTES, uploadProblem } from '../files'
import { Button, cx, IconButton, MenuDivider, MenuItem, relativeTime, useDismiss } from './kit'

/**
 * The file browser: folders and files in the drive, with the things a file
 * manager does. Right-click for a menu, drag files in to upload, drag an item
 * onto a folder to move it. The Files page shows the whole drive; a record's
 * Files tab shows that record's folder.
 */

type Listing = NonNullable<Awaited<ReturnType<typeof listFolderFn>>['listing']>
type FolderItem = Listing['folders'][number]
type FileItem = Listing['files'][number]

/**
 * The address that opens a file. It names the folder the file is in: in a
 * Spool with record scopes a file is only opened from a folder within reach.
 */
const fileHref = (id: string, folderId: string | null) =>
  `/api/files/${id}?folder=${encodeURIComponent(folderId ?? '')}`

type Item = { kind: 'folder'; item: FolderItem } | { kind: 'file'; item: FileItem }
type Ref = { kind: 'folder' | 'file'; id: string }
type RecordRef = { objectKey: string; recordId: string }

/** One file on its way up. */
type Sending = {
  key: string
  folderId: string | null
  name: string
  /** 0 to 1 while the bytes are going; `null` before and after. */
  progress: number | null
  step: 'Reading' | 'Uploading' | 'Saving'
  error?: string
}

const DRAG_TYPE = 'application/x-crm-file-item'

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** An item of ours being dragged, as `itemProps` wrote it; checked because any page can drop data of this type. */
const refSchema = z.object({
  kind: z.enum(['folder', 'file']),
  id: z.string(),
}) satisfies z.ZodType<Ref>

/** Something being dragged over a folder (or the open one): files from the computer, or an item of ours. */
const accepts = (e: DragEvent) =>
  e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DRAG_TYPE)

const sameRef = (a: Ref | null, b: Ref) => a?.kind === b.kind && a.id === b.id

/** Send the bytes to the transfer URL, reporting progress. Rejects with a sentence the teammate can read. */
function put(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (done: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)

    for (const [name, value] of Object.entries(headers)) {
      // The browser sets the length itself and refuses to have it set.
      if (name.toLowerCase() !== 'content-length') {
        xhr.setRequestHeader(name, value)
      }
    }

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(e.loaded / e.total)
      }
    })

    xhr.addEventListener('load', () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(
            new Error(
              xhr.status === 413
                ? 'That file is too large to add here.'
                : 'The upload was refused.',
            ),
          ),
    )

    xhr.addEventListener('error', () =>
      reject(
        new Error('The upload was interrupted. Check your connection and add the file again.'),
      ),
    )

    xhr.addEventListener('abort', () => reject(new Error('The upload was cancelled.')))
    xhr.send(file)
  })
}

const iconFor = (name: string) => {
  if (/\.(png|jpe?g|gif|webp|heic|svg|tiff?)$/i.test(name)) {
    return Image
  }

  if (/\.(pdf|docx?|txt|md|rtf|xlsx?|csv|pptx?)$/i.test(name)) {
    return FileText
  }

  return FileIcon
}

/** Uploads into folders of the drive. `onAdded` runs once a batch has added something. */
function useUploads(record: RecordRef | undefined, onAdded: () => void | Promise<void>) {
  const [sending, setSending] = useState<Sending[]>([])

  const patch = (key: string, change: Partial<Sending>) =>
    setSending((all) => all.map((s) => (s.key === key ? { ...s, ...change } : s)))

  async function send(file: File, folderId: string | null, key: string) {
    try {
      const sha256 = hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))

      const started = await startUploadFn({
        data: { folderId, name: file.name, sizeBytes: file.size, sha256, record: record ?? null },
      })

      if (!started.ok) {
        throw new Error(started.error)
      }

      patch(key, { step: 'Uploading', progress: 0 })

      await put(started.value.url, started.value.headers, file, (progress) =>
        patch(key, { progress }),
      )

      patch(key, { step: 'Saving', progress: null })

      // The store may still be checking the file: ask again a few times before giving up.
      for (let attempt = 0; attempt < 6; attempt++) {
        const finished = await finishUploadFn({ data: { id: started.value.id } })

        if (!finished.ok) {
          throw new Error(finished.error)
        }

        if (finished.value) {
          setSending((all) => all.filter((s) => s.key !== key))
          return true
        }
      }

      throw new Error(
        'The file store is still working on this file. It will appear here once it is done.',
      )
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Something went wrong.'
      patch(key, { error: message, progress: null })
      return false
    }
  }

  /** Returns a sentence when nothing was started. */
  async function add(
    list: FileList | File[],
    folderId: string | null,
  ): Promise<string | undefined> {
    const files = [...list]

    if (files.length === 0) {
      return undefined
    }

    if (files.length > MAX_FILES_PER_UPLOAD) {
      return `Add up to ${MAX_FILES_PER_UPLOAD} files at a time.`
    }

    const queue = files.map((file, i) => ({
      file,
      key: `${Date.now()}-${i}-${file.name}`,
      problem: uploadProblem(file),
    }))

    setSending((all) => [
      // Keep earlier failures visible until they are dismissed.
      ...all,
      ...queue.map(({ file, key, problem }) => {
        const entry: Sending = { key, folderId, name: file.name, progress: null, step: 'Reading' }

        if (problem) {
          entry.error = problem
        }

        return entry
      }),
    ])

    let added = 0

    // One at a time: steady progress, and no burst of requests at the store.
    for (const { file, key, problem } of queue) {
      if (!problem && (await send(file, folderId, key))) {
        added++
      }
    }

    if (added > 0) {
      await onAdded()
    }

    return undefined
  }

  const dismiss = (key: string) => setSending((all) => all.filter((s) => s.key !== key))
  return { sending, add, dismiss }
}

type View = 'list' | 'grid'
const VIEW_KEY = 'crm-files-view'

/** Folders already opened in this tab, as they were last seen, so going back to one doesn't wait. */
const listings = new Map<string, Awaited<ReturnType<typeof listFolderFn>>>()

export function FileBrowser({
  rootId,
  rootLabel,
  folderId,
  onNavigate,
  record,
  onChange,
}: {
  /** The folder this browser starts at and can't go above; `null` is the drive's top level. */
  rootId: string | null
  rootLabel: string
  /** The folder being shown; `null` means the root. */
  folderId: string | null
  onNavigate: (folderId: string | null) => void
  /** The record whose folder this is, so files added here show on its timeline. */
  record?: RecordRef
  /** Runs after files are added, so a page can refresh what depends on them. */
  onChange?: () => void
}) {
  const current = folderId ?? rootId
  const [data, setData] = useState<Awaited<ReturnType<typeof listFolderFn>>>()
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState<string>()
  const [view, setView] = useState<View>('list')
  const [selected, setSelected] = useState<Ref | null>(null)
  const [renaming, setRenaming] = useState<Ref | 'new' | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; target: Item | null } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ files: FileItem[]; truncated: boolean } | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  // Where the next picked files go; `undefined` means the folder being shown.
  const uploadTo = useRef<string | null | undefined>(undefined)

  // Only the latest request may fill the page: a slow answer for a folder already left is dropped.
  const asked = useRef(0)

  const load = useCallback(async () => {
    const turn = ++asked.current
    const key = current ?? ''
    // A folder seen before is shown as it was, at once, and brought up to date behind.
    const seen = listings.get(key)

    if (seen) {
      setData(seen)
    }

    setLoading(true)

    try {
      const next = await listFolderFn({ data: { folderId: current } })

      if (next.listing) {
        listings.set(key, next)
      } else {
        listings.delete(key)
      }

      if (turn === asked.current) {
        setData(next)
      }
    } catch {
      if (turn === asked.current && !seen) {
        setData({
          problems: [],
          listing: null,
          error: 'The files could not be loaded. Reload the page.',
        })
      }
    } finally {
      if (turn === asked.current) {
        setLoading(false)
      }
    }
  }, [current])

  useEffect(() => {
    setSelected(null)
    setRenaming(null)
    void load()
  }, [load])

  useEffect(() => {
    try {
      if (window.localStorage.getItem(VIEW_KEY) === 'grid') {
        setView('grid')
      }
    } catch {
      // No storage: the list view it is.
    }
  }, [])

  const chooseView = (next: View) => {
    setView(next)

    try {
      window.localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Not remembered, which is fine.
    }
  }

  // Search file names across the drive as you type.
  useEffect(() => {
    const q = query.trim()

    if (!q) {
      setFound(null)
      return undefined
    }

    let stale = false

    const timer = setTimeout(async () => {
      const res = await searchFilesFn({ data: { q } })

      if (stale) {
        return
      }

      if (res.ok) {
        setFound(res.value)
      } else {
        setNote(res.error)
      }
    }, 300)

    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query])

  const uploads = useUploads(record, async () => {
    await load()
    onChange?.()
  })

  const listing = data?.listing ?? null
  const ready = !!data && data.problems.length === 0
  // The trail from this browser's root down: a record's tab doesn't show the folders above its own.
  const fullTrail = listing?.trail ?? []
  const cut = rootId ? fullTrail.findIndex((c) => c.id === rootId) + 1 : 0
  const trail = fullTrail.slice(cut)

  const parentId =
    trail.length > 1 ? (trail.at(-2)?.id ?? null) : trail.length === 1 ? rootId : null

  const atRoot = trail.length === 0

  const run = async (action: Promise<{ ok: true } | { ok: false; error: string }>) => {
    setNote(undefined)
    const res = await action

    if (!res.ok) {
      setNote(res.error)
    }

    await load()
    return res.ok
  }

  const open = (it: Item) => {
    if (it.kind === 'folder') {
      onNavigate(it.item.id === rootId ? null : it.item.id)
    } else {
      window.open(fileHref(it.item.id, current), '_blank', 'noopener')
    }
  }

  const remove = async (it: Item) => {
    const what =
      it.kind === 'folder'
        ? `Delete the folder "${it.item.name}" and everything in it?`
        : `Delete ${it.item.name}?`

    const own =
      it.kind === 'folder' && it.item.record
        ? " This is a record's own folder: the record gets a new, empty one the next time it is opened."
        : ''

    // Some stores have a trash and some don't; none can be emptied or restored from here.
    if (!window.confirm(`${what}${own} This can't be undone here.`)) {
      return
    }

    setSelected(null)
    await run(deleteItemFn({ data: { kind: it.kind, id: it.item.id, from: current } }))
    onChange?.()
  }

  const rename = async (ref: Ref, name: string, before: string) => {
    setRenaming(null)
    const next = name.trim()

    if (!next || next === before) {
      return
    }

    await run(renameItemFn({ data: { ...ref, name: next, from: current } }))
  }

  const newFolder = async (name: string) => {
    setRenaming(null)
    const next = name.trim()

    if (!next) {
      return
    }

    await run(createFolderFn({ data: { parentId: current, name: next } }))
  }

  const move = async (ref: Ref, to: string | null) => {
    if (ref.kind === 'folder' && ref.id === to) {
      return
    }

    await run(moveItemFn({ data: { ...ref, to, from: current } }))
  }

  const pick = (to: string | null) => {
    uploadTo.current = to
    picker.current?.click()
  }

  const addFiles = async (files: FileList | File[], to: string | null) => {
    setNote(undefined)
    const refused = await uploads.add(files, to)

    if (refused) {
      setNote(refused)
    }
  }

  const items: Item[] = listing
    ? [
        ...listing.folders.map((item) => ({ kind: 'folder' as const, item })),
        ...listing.files.map((item) => ({ kind: 'file' as const, item })),
      ]
    : []

  const selectedItem = items.find((it) => sameRef(selected, { kind: it.kind, id: it.item.id }))
  // Held in a constant so the menu's callbacks still know it is set.
  const menuTarget = menu?.target ?? null

  const onKey = (e: KeyboardEvent) => {
    if (renaming || (e.target instanceof HTMLElement && e.target.tagName === 'INPUT')) {
      return
    }

    if (e.key === 'Escape') {
      setSelected(null)
    }

    if (!selectedItem) {
      return
    }

    if (e.key === 'Enter') {
      open(selectedItem)
    }

    if (e.key === 'F2') {
      setRenaming({ kind: selectedItem.kind, id: selectedItem.item.id })
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      void remove(selectedItem)
    }
  }

  const dropOn = (to: string | null) => (e: DragEvent) => {
    if (!ready || !accepts(e)) {
      return
    }

    e.preventDefault()
    e.stopPropagation()
    setOver(null)
    const dragged = e.dataTransfer.getData(DRAG_TYPE)

    if (dragged) {
      const ref = refSchema.safeParse(JSON.parse(dragged))

      if (ref.success) {
        void move(ref.data, to)
      }
    } else if (e.dataTransfer.files.length > 0) {
      void addFiles(e.dataTransfer.files, to)
    }
  }

  const dragOver = (target: string) => (e: DragEvent) => {
    if (!ready || !accepts(e)) {
      return
    }

    e.preventDefault()
    e.stopPropagation()
    setOver(target)
  }

  const context = (target: Item | null) => (e: MouseEvent) => {
    if (!ready) {
      return
    }

    e.preventDefault()
    e.stopPropagation()

    if (target) {
      setSelected({ kind: target.kind, id: target.item.id })
    }

    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  const itemProps = (it: Item) => {
    const ref: Ref = { kind: it.kind, id: it.item.id }

    const props = {
      draggable: !renaming,
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ref))
        e.dataTransfer.effectAllowed = 'move'
      },
      onClick: (e: MouseEvent) => {
        e.stopPropagation()
        setSelected(ref)
      },
      onDoubleClick: () => open(it),
      onContextMenu: context(it),
    }

    // Only a folder takes things dropped on it.
    if (it.kind !== 'folder') {
      return props
    }

    return {
      ...props,
      onDragOver: dragOver(it.item.id),
      onDragLeave: () => setOver(null),
      onDrop: dropOn(it.item.id),
    }
  }

  /** The menu and Delete, on the item itself: not everyone right-clicks. */
  const actions = (it: Item) => {
    const ref: Ref = { kind: it.kind, id: it.item.id }

    const shown = sameRef(selected, ref)
      ? 'opacity-100'
      : 'opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100'

    return (
      <span className="flex shrink-0 items-center">
        <IconButton
          label={`More for ${it.item.name}`}
          className={cx('size-6', shown)}
          onClick={(e) => {
            e.stopPropagation()
            const box = e.currentTarget.getBoundingClientRect()
            setSelected(ref)
            setMenu({ x: box.left, y: box.bottom + 4, target: it })
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" />
        </IconButton>
        <IconButton
          label={`Delete ${it.item.name}`}
          className={cx('size-6 hover:text-c-danger', shown)}
          onClick={(e) => {
            e.stopPropagation()
            void remove(it)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      </span>
    )
  }

  /** "Ada, 5 minutes ago": who added a file through the CRM, and when. */
  const addedLine = (file: FileItem) =>
    [file.addedBy, file.addedAt ? relativeTime(file.addedAt) : null].filter(Boolean).join(', ')

  const nameOf = (it: Item) =>
    renaming !== 'new' && renaming && sameRef(renaming, { kind: it.kind, id: it.item.id }) ? (
      <NameInput
        initial={it.item.name}
        // Select the name without its extension, as a file manager does.
        stem={it.kind === 'file'}
        onDone={(name) => rename({ kind: it.kind, id: it.item.id }, name, it.item.name)}
        onCancel={() => setRenaming(null)}
      />
    ) : it.kind === 'folder' ? (
      <button
        type="button"
        className="min-w-0 truncate text-left hover:underline"
        onClick={() => open(it)}
      >
        {it.item.name}
      </button>
    ) : (
      <a
        href={fileHref(it.item.id, current)}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 truncate hover:underline"
        title={it.item.name}
        draggable={false}
      >
        {it.item.name}
      </a>
    )

  // Shown wherever you are: a file going into another folder is still yours to watch.
  const sendingHere = uploads.sending
  const empty = !!listing && items.length === 0 && renaming !== 'new' && sendingHere.length === 0

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="border-c-line flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <nav
          aria-label="Folders"
          data-guide="files-path"
          className="flex min-w-40 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          <Crumb
            label={rootLabel}
            current={atRoot}
            over={over === 'crumb-root'}
            onOpen={() => onNavigate(null)}
            onDragOver={atRoot ? undefined : dragOver('crumb-root')}
            onDrop={atRoot ? undefined : dropOn(rootId)}
            onLeave={() => setOver(null)}
          />
          {trail.map((c, i) => {
            const last = i === trail.length - 1
            return (
              <span key={c.id} className="flex min-w-0 items-center gap-0.5">
                <ChevronRight className="text-c-fg3 size-3.5 shrink-0" />
                <Crumb
                  label={c.name}
                  current={last}
                  over={over === `crumb-${c.id}`}
                  onOpen={() => onNavigate(c.id)}
                  onDragOver={last ? undefined : dragOver(`crumb-${c.id}`)}
                  onDrop={last ? undefined : dropOn(c.id)}
                  onLeave={() => setOver(null)}
                />
              </span>
            )
          })}
          {loading && <Loader2 className="text-c-fg3 ml-1 size-3.5 shrink-0 animate-spin" />}
        </nav>

        <label
          data-guide="files-search"
          className={cx(
            'h-7 w-48 items-center gap-1.5 rounded-lg border border-c-line2 bg-c-raised px-2 focus-within:border-c-accent',
            rootId ? 'hidden' : 'flex',
          )}
        >
          <Search className="text-c-fg3 size-3.5 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all files"
            aria-label="Search all files by name"
            disabled={!ready}
            className="placeholder:text-c-fg3 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
        </label>
        <div className="border-c-line2 flex items-center rounded-lg border p-0.5">
          <IconButton
            label="List view"
            aria-pressed={view === 'list'}
            onClick={() => chooseView('list')}
            className={cx('size-6', view === 'list' && 'bg-c-hov text-c-fg')}
          >
            <List className="size-3.5" />
          </IconButton>
          <IconButton
            label="Grid view"
            aria-pressed={view === 'grid'}
            onClick={() => chooseView('grid')}
            className={cx('size-6', view === 'grid' && 'bg-c-hov text-c-fg')}
          >
            <LayoutGrid className="size-3.5" />
          </IconButton>
        </div>
        <Button
          onClick={() => setRenaming('new')}
          disabled={!ready || !!found}
          aria-label="New folder"
          title="New folder"
        >
          <FolderPlus className="size-3.5" /> <span className="hidden @lg:inline">New folder</span>
        </Button>
        <Button
          variant="primary"
          data-guide="files-add"
          onClick={() => pick(current)}
          disabled={!ready}
          aria-label="Upload files"
          title="Upload files"
        >
          <Upload className="size-3.5" /> <span className="hidden @lg:inline">Upload</span>
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="Upload files"
          onChange={(e) => {
            const to = uploadTo.current === undefined ? current : uploadTo.current
            uploadTo.current = undefined

            if (e.target.files) {
              void addFiles([...e.target.files], to)
            }

            // Let the same file be picked again after a failure.
            e.target.value = ''
          }}
        />
      </div>

      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- The folder's own surface: right-click, drop and keys act on it, and every action is also a button above. */}
      <div
        className={cx(
          'min-h-0 flex-1 overflow-y-auto p-3 outline-none',
          over === 'here' && 'bg-c-accent/5',
        )}
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Focusable so the keyboard shortcuts work on the selection.
        tabIndex={0}
        onKeyDown={onKey}
        onClick={() => setSelected(null)}
        onContextMenu={found ? undefined : context(null)}
        onDragOver={found ? undefined : dragOver('here')}
        onDragLeave={() => setOver(null)}
        onDrop={found ? undefined : dropOn(current)}
      >
        <div className="mx-auto max-w-5xl space-y-3">
          {data && data.problems.length > 0 && (
            <div className="border-c-line bg-c-raised rounded-xl border p-3">
              <p className="font-medium">Files aren't set up yet</p>
              <ul className="text-c-fg2 mt-1 list-disc pl-5">
                {data.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <p className="text-c-fg3 mt-1">
                Whoever runs this CRM can fix these in its environment settings.
              </p>
            </div>
          )}
          {(note || data?.error) && (
            <p
              className="border-c-line bg-c-raised text-c-danger rounded-xl border p-3"
              role="alert"
            >
              {note ?? data?.error}
            </p>
          )}
          {listing?.record && !record && (
            <p className="text-c-fg2 flex items-center gap-1.5 px-1">
              This is the folder of the {listing.record.label.toLowerCase()}
              <Link
                to="/$object/$id"
                params={{ object: listing.record.objectKey, id: listing.record.recordId }}
                className="text-c-fg inline-flex items-center gap-1 font-medium hover:underline"
              >
                {listing.record.title} <ExternalLink className="size-3" />
              </Link>
            </p>
          )}

          {found ? (
            <SearchResults
              found={found}
              onReveal={(file) => {
                setQuery('')
                onNavigate(file.folderId)
              }}
            />
          ) : (
            listing &&
            (view === 'list' ? (
              <div
                className={cx(
                  'overflow-hidden rounded-xl border border-c-line bg-c-panel',
                  empty && 'border-dashed bg-transparent',
                )}
              >
                {!atRoot && (
                  <button
                    type="button"
                    onClick={() => onNavigate(parentId)}
                    onDragOver={dragOver('up')}
                    onDragLeave={() => setOver(null)}
                    onDrop={dropOn(parentId ?? rootId)}
                    className={cx(
                      'flex h-9 w-full items-center gap-2.5 border-b border-c-line px-3 text-left text-c-fg2 hover:bg-c-hov',
                      over === 'up' && 'bg-c-accent/10',
                    )}
                  >
                    <CornerLeftUp className="text-c-fg3 size-4 shrink-0" /> Up one folder
                  </button>
                )}
                {renaming === 'new' && (
                  <div className="border-c-line flex h-9 items-center gap-2.5 border-b px-3">
                    <Folder className="text-c-accent size-4 shrink-0" />
                    <NameInput
                      initial="New folder"
                      onDone={newFolder}
                      onCancel={() => setRenaming(null)}
                    />
                  </div>
                )}
                {items.map((it) => {
                  const Icon = it.kind === 'folder' ? Folder : iconFor(it.item.name)
                  const ref = { kind: it.kind, id: it.item.id }
                  return (
                    <div
                      key={`${it.kind}:${it.item.id}`}
                      role="option"
                      aria-selected={sameRef(selected, ref)}
                      tabIndex={-1}
                      {...itemProps(it)}
                      className={cx(
                        'group/item flex h-9 cursor-default items-center gap-2.5 border-b border-c-line px-3 last:border-b-0',
                        sameRef(selected, ref) ? 'bg-c-accent/10' : 'hover:bg-c-hov',
                        over === it.item.id && 'bg-c-accent/15 ring-1 ring-c-accent ring-inset',
                      )}
                    >
                      <Icon
                        className={cx(
                          'size-4 shrink-0',
                          it.kind === 'folder' ? 'text-c-accent' : 'text-c-fg3',
                        )}
                      />
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {nameOf(it)}
                        {it.kind === 'folder' && it.item.record && <RecordBadge />}
                      </span>
                      <span className="text-c-fg3 hidden w-52 shrink-0 truncate text-xs @2xl:block">
                        {it.kind === 'file' ? addedLine(it.item) : ''}
                      </span>
                      <span className="text-c-fg3 hidden w-24 shrink-0 text-right text-xs tabular-nums @md:block">
                        {it.kind === 'folder'
                          ? it.item.items === null
                            ? ''
                            : it.item.items === 1
                              ? '1 item'
                              : `${it.item.items} items`
                          : it.item.sizeBytes === null
                            ? ''
                            : formatBytes(it.item.sizeBytes)}
                      </span>
                      {actions(it)}
                    </div>
                  )
                })}
                {sendingHere.map((s) => (
                  <SendingRow key={s.key} sending={s} onDismiss={() => uploads.dismiss(s.key)} />
                ))}
                {empty && <EmptyFolder ready={ready} />}
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-2 gap-2 @md:grid-cols-3 @2xl:grid-cols-4 @4xl:grid-cols-5">
                  {!atRoot && (
                    <button
                      type="button"
                      onClick={() => onNavigate(parentId)}
                      onDragOver={dragOver('up')}
                      onDragLeave={() => setOver(null)}
                      onDrop={dropOn(parentId ?? rootId)}
                      className={cx(
                        'flex h-28 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-c-line text-xs text-c-fg2 hover:bg-c-hov',
                        over === 'up' && 'bg-c-accent/10',
                      )}
                    >
                      <CornerLeftUp className="text-c-fg3 size-6" /> Up one folder
                    </button>
                  )}
                  {renaming === 'new' && (
                    <div className="border-c-accent bg-c-panel flex h-28 flex-col items-center justify-center gap-1.5 rounded-xl border px-2">
                      <Folder className="text-c-accent size-7" />
                      <NameInput
                        initial="New folder"
                        onDone={newFolder}
                        onCancel={() => setRenaming(null)}
                      />
                    </div>
                  )}
                  {items.map((it) => {
                    const Icon = it.kind === 'folder' ? Folder : iconFor(it.item.name)
                    const ref = { kind: it.kind, id: it.item.id }
                    return (
                      <div
                        key={`${it.kind}:${it.item.id}`}
                        role="option"
                        aria-selected={sameRef(selected, ref)}
                        tabIndex={-1}
                        {...itemProps(it)}
                        className={cx(
                          'group/item relative flex h-28 cursor-default flex-col items-center justify-center gap-1 rounded-xl border bg-c-panel px-2 text-center text-xs',
                          sameRef(selected, ref)
                            ? 'border-c-accent bg-c-accent/10'
                            : 'border-c-line hover:bg-c-hov',
                          over === it.item.id && 'border-c-accent bg-c-accent/15',
                        )}
                      >
                        <Icon
                          className={cx(
                            'size-7 shrink-0',
                            it.kind === 'folder' ? 'text-c-accent' : 'text-c-fg3',
                          )}
                        />
                        <span className="absolute top-1 right-1">{actions(it)}</span>
                        <span className="flex w-full min-w-0 items-center justify-center gap-1">
                          {nameOf(it)}
                        </span>
                        {it.kind === 'file' && it.item.addedBy && (
                          <span className="text-c-fg3 w-full truncate text-[11px]">
                            {addedLine(it.item)}
                          </span>
                        )}
                        <span className="text-c-fg3 text-[11px] tabular-nums">
                          {it.kind === 'folder'
                            ? it.item.record
                              ? 'Record'
                              : it.item.items === null
                                ? ''
                                : `${it.item.items} ${it.item.items === 1 ? 'item' : 'items'}`
                            : it.item.sizeBytes === null
                              ? ''
                              : formatBytes(it.item.sizeBytes)}
                        </span>
                      </div>
                    )
                  })}
                </div>
                {sendingHere.length > 0 && (
                  <div className="border-c-line bg-c-panel mt-2 overflow-hidden rounded-xl border">
                    {sendingHere.map((s) => (
                      <SendingRow
                        key={s.key}
                        sending={s}
                        onDismiss={() => uploads.dismiss(s.key)}
                      />
                    ))}
                  </div>
                )}
                {empty && (
                  <div className="border-c-line rounded-xl border border-dashed">
                    <EmptyFolder ready={ready} />
                  </div>
                )}
              </div>
            ))
          )}

          {listing && !found && (
            <p className="text-c-fg3 px-1 text-xs">
              {listing.folders.length} {listing.folders.length === 1 ? 'folder' : 'folders'},{' '}
              {listing.files.length} {listing.files.length === 1 ? 'file' : 'files'}
              {listing.truncated ? ' shown; this folder holds more' : ''}. Right-click, or use the
              buttons on a row, to rename, move or delete. Drop files to upload them, up to{' '}
              {formatBytes(MAX_UPLOAD_BYTES)} each.
            </p>
          )}
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menuTarget ? (
            <ItemMenu
              it={menuTarget}
              canMoveUp={!atRoot}
              onOpen={() => open(menuTarget)}
              onRename={() => setRenaming({ kind: menuTarget.kind, id: menuTarget.item.id })}
              onUploadInto={() => pick(menuTarget.item.id)}
              onMoveUp={() =>
                move({ kind: menuTarget.kind, id: menuTarget.item.id }, parentId ?? rootId)
              }
              onCopyLink={() =>
                navigator.clipboard?.writeText(
                  `${window.location.origin}${fileHref(menuTarget.item.id, current)}`,
                )
              }
              onDelete={() => remove(menuTarget)}
              close={() => setMenu(null)}
            />
          ) : (
            <>
              <MenuItem
                onSelect={() => {
                  setMenu(null)
                  setRenaming('new')
                }}
              >
                <FolderPlus className="text-c-fg2 size-3.5" /> New folder
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  setMenu(null)
                  pick(current)
                }}
              >
                <Upload className="text-c-fg2 size-3.5" /> Upload files
              </MenuItem>
            </>
          )}
        </ContextMenu>
      )}
    </div>
  )
}

function ItemMenu({
  it,
  canMoveUp,
  onOpen,
  onRename,
  onUploadInto,
  onMoveUp,
  onCopyLink,
  onDelete,
  close,
}: {
  it: Item
  canMoveUp: boolean
  onOpen: () => void
  onRename: () => void
  onUploadInto: () => void
  onMoveUp: () => void
  onCopyLink: () => void
  onDelete: () => void
  close: () => void
}) {
  const then = (act: () => void) => () => {
    close()
    act()
  }

  const record = it.kind === 'folder' ? it.item.record : null
  return (
    <>
      <MenuItem onSelect={then(onOpen)}>
        <ExternalLink className="text-c-fg2 size-3.5" />{' '}
        {it.kind === 'folder' ? 'Open' : 'Open in a new tab'}
      </MenuItem>
      {record && (
        <Link
          to="/$object/$id"
          params={{ object: record.objectKey, id: record.recordId }}
          onClick={close}
          className="hover:bg-c-hov flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]"
        >
          <ChevronRight className="text-c-fg2 size-3.5" /> Go to the record
        </Link>
      )}
      {it.kind === 'folder' ? (
        <MenuItem onSelect={then(onUploadInto)}>
          <Upload className="text-c-fg2 size-3.5" /> Upload into this folder
        </MenuItem>
      ) : (
        <MenuItem onSelect={then(onCopyLink)}>
          <Link2 className="text-c-fg2 size-3.5" /> Copy link
        </MenuItem>
      )}
      <MenuDivider />
      <MenuItem onSelect={then(onRename)}>
        <Pencil className="text-c-fg2 size-3.5" /> Rename
      </MenuItem>
      {canMoveUp && (
        <MenuItem onSelect={then(onMoveUp)}>
          <CornerLeftUp className="text-c-fg2 size-3.5" /> Move up one folder
        </MenuItem>
      )}
      <MenuDivider />
      <MenuItem danger onSelect={then(onDelete)}>
        <Trash2 className="size-3.5" /> Delete
      </MenuItem>
    </>
  )
}

/** A menu at the pointer, kept inside the window. */
function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: x, top: y })
  useDismiss(ref, onClose)

  useEffect(() => {
    const box = ref.current?.getBoundingClientRect()

    if (!box) {
      return undefined
    }

    setAt({
      left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)),
    })

    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [x, y, onClose])

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      style={at}
      className="border-c-line bg-c-raised fixed z-50 w-56 rounded-xl border p-1 shadow-lg"
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  )
}

function Crumb({
  label,
  current,
  over,
  onOpen,
  onDragOver,
  onDrop,
  onLeave,
}: {
  label: string
  current: boolean
  over: boolean
  onOpen: () => void
  onDragOver?: (e: DragEvent) => void
  onDrop?: (e: DragEvent) => void
  onLeave: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      onDragOver={onDragOver}
      onDragLeave={onLeave}
      onDrop={onDrop}
      aria-current={current ? 'page' : undefined}
      className={cx(
        'max-w-48 shrink-0 truncate rounded-md px-1.5 py-0.5',
        current ? 'font-medium' : 'text-c-fg2 hover:bg-c-hov hover:text-c-fg',
        over && 'bg-c-accent/15 ring-1 ring-c-accent',
      )}
    >
      {label}
    </button>
  )
}

/** A name being typed: Enter keeps it, Escape or clicking away drops it. */
function NameInput({
  initial,
  stem,
  onDone,
  onCancel,
}: {
  initial: string
  stem?: boolean
  onDone: (name: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const settled = useRef(false)

  useEffect(() => {
    const el = ref.current

    if (!el) {
      return
    }

    el.focus()
    const dot = stem ? initial.lastIndexOf('.') : -1
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial, stem])

  const finish = (keep: boolean) => {
    if (settled.current) {
      return
    }

    settled.current = true

    if (keep) {
      onDone(ref.current?.value ?? '')
    } else {
      onCancel()
    }
  }

  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label="Name"
      maxLength={120}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()

        if (e.key === 'Enter') {
          finish(true)
        }

        if (e.key === 'Escape') {
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
      className="border-c-accent bg-c-raised h-6 min-w-0 flex-1 rounded-md border px-1.5 text-[13px] outline-none"
    />
  )
}

function RecordBadge() {
  return (
    <span
      className="bg-c-hov text-c-fg2 shrink-0 rounded-md px-1.5 py-0.5 text-[11px]"
      title="A record's own folder"
    >
      Record
    </span>
  )
}

function EmptyFolder({ ready }: { ready: boolean }) {
  return (
    <div className="text-c-fg3 px-3 py-14 text-center">
      <Folder className="mx-auto mb-2 size-7" />
      <p>This folder is empty.</p>
      {ready && (
        <p className="mt-0.5 text-xs">Drop files here, or right-click to add a folder or upload.</p>
      )}
    </div>
  )
}

function SearchResults({
  found,
  onReveal,
}: {
  found: { files: FileItem[]; truncated: boolean }
  onReveal: (file: FileItem) => void
}) {
  if (found.files.length === 0) {
    return <p className="text-c-fg3 py-14 text-center">No file names match.</p>
  }

  return (
    <>
      <div className="border-c-line bg-c-panel overflow-hidden rounded-xl border">
        {found.files.map((file) => {
          const Icon = iconFor(file.name)

          const folder = file.path.includes('/')
            ? file.path.slice(0, file.path.lastIndexOf('/'))
            : ''

          return (
            <div
              key={file.id}
              className="border-c-line hover:bg-c-hov flex h-9 items-center gap-2.5 border-b px-3 last:border-b-0"
            >
              <Icon className="text-c-fg3 size-4 shrink-0" />
              <a
                href={fileHref(file.id, file.folderId)}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate hover:underline"
                title={file.name}
              >
                {file.name}
              </a>
              <button
                type="button"
                onClick={() => onReveal(file)}
                className="text-c-fg2 hover:text-c-fg hidden max-w-72 shrink-0 truncate text-xs hover:underline md:block"
                title="Show in its folder"
              >
                {folder || 'Top level'}
              </button>
              <span className="text-c-fg3 hidden w-20 shrink-0 text-right text-xs tabular-nums sm:block">
                {file.sizeBytes === null ? '' : formatBytes(file.sizeBytes)}
              </span>
            </div>
          )
        })}
      </div>
      <p className="text-c-fg3 px-1 text-xs">
        {found.files.length} {found.files.length === 1 ? 'file' : 'files'}
        {found.truncated ? ', and more: narrow the search' : ''}. Click a folder to show the file
        where it is.
      </p>
    </>
  )
}

/** A file on its way up, or one that failed and says why. */
function SendingRow({ sending: s, onDismiss }: { sending: Sending; onDismiss: () => void }) {
  return (
    <div className="border-c-line flex min-h-9 items-center gap-2.5 border-b px-3 py-1.5 last:border-b-0">
      {s.error ? (
        <FileIcon className="text-c-danger size-4 shrink-0" />
      ) : (
        <Loader2 className="text-c-fg3 size-4 shrink-0 animate-spin" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{s.name}</span>
        {s.error && <span className="text-c-danger block text-xs">{s.error}</span>}
      </span>
      {s.error ? (
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : (
        <span
          className="text-c-fg3 w-28 shrink-0 text-right text-xs tabular-nums"
          aria-live="polite"
        >
          {s.step}
          {s.progress !== null ? ` ${Math.round(s.progress * 100)}%` : '…'}
        </span>
      )}
    </div>
  )
}
