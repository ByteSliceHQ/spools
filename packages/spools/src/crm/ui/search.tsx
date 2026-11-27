import { type NavigateOptions, useNavigate, useRouter } from '@tanstack/react-router'
import {
  BarChart3,
  Calendar,
  CheckSquare,
  Clock,
  CornerDownLeft,
  File,
  FileText,
  FolderOpen,
  Home,
  type LucideIcon,
  Mail,
  MessageCircle,
  Phone,
  Plug,
  Plus,
  Search,
  Star,
  Table2,
  Workflow,
  X,
} from 'lucide-react'
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { z } from 'zod'

import { searchDeepFn } from '../../server/crm.functions'
import { searchFilesFn } from '../../server/files.functions'
import type { PublicCrmConfig } from '../config'
import { fieldLabel } from '../naming'
import {
  type DeepHit,
  fold,
  highlight,
  type QuickIndex,
  type Recent,
  recentKey,
  recentsKey,
  searchIndex as searchRecords,
  withRecent,
} from '../search'
import { ObjectIcon } from './icons'
import { cx, Kbd, relativeTime } from './kit'
import { currentScope, searchIndex } from './session'
import { useWriteReach } from './write-reach'

/**
 * The search box over the whole CRM (Cmd+K). Records are matched in the
 * browser as each key is pressed (src/crm/search.ts); notes, emails, calls,
 * tasks and file names come from the server a moment after typing pauses and
 * are added below, so nothing already on screen moves.
 */

type Favorite = { objectKey: string; recordId: string; title: string }

// ── Recently opened records, kept in this browser ───────────────────────────

/** What this browser saved under RECENT_KEY, checked as it is read back: storage is anyone's to change. */
const savedRecents = z.array(
  z.object({
    objectKey: z.string(),
    id: z.string(),
    title: z.string(),
  }) satisfies z.ZodType<Recent>,
)

/** How long typing must pause before the server is asked about notes, emails and tasks. */
const DEEP_DEBOUNCE_MS = 250

export function readRecents(): Recent[] {
  try {
    const saved = savedRecents.safeParse(
      JSON.parse(window.localStorage.getItem(recentsKey(currentScope())) ?? '[]'),
    )

    return saved.success ? saved.data : []
  } catch {
    return []
  }
}

/** Note that a record was opened, so search can offer it first next time. */
export function rememberOpened(item: Recent): void {
  try {
    window.localStorage.setItem(
      recentsKey(currentScope()),
      JSON.stringify(withRecent(readRecents(), item)),
    )
  } catch {
    // Private browsing can block storage; search just won't know what was opened.
  }
}

/** The search index the tab holds, fetched (or brought up to date) when something first needs it. */
export function useSearchIndex(): QuickIndex | undefined {
  const index = useSyncExternalStore(
    (listener) => searchIndex.subscribe(listener),
    () => searchIndex.get(),
    () => undefined,
  )

  useEffect(() => {
    void searchIndex.refresh().catch(() => undefined)
  }, [])

  return index
}

// ── The palette ─────────────────────────────────────────────────────────────

type Item = {
  id: string
  section: string
  icon: ReactNode
  title: ReactNode
  /** A second line: what tells this result from its neighbours, or where the match was. */
  detail?: ReactNode
  hint?: string
  run: (newTab: boolean) => void
  /** The object this row belongs to, for Tab to narrow the search to. */
  objectKey?: string
}

const Marked = ({ text, q }: { text: string; q: string }) => (
  <>
    {highlight(text, q).map((part, i) =>
      part.hit ? (
        // The pieces of one string, in order.
        <mark key={i} className="bg-c-accent/15 rounded-xs text-inherit">
          {part.text}
        </mark>
      ) : (
        part.text
      ),
    )}
  </>
)

const DEEP_ICONS: Record<DeepHit['kind'], LucideIcon> = {
  record: Table2,
  note: FileText,
  email: Mail,
  call: Phone,
  meeting: Calendar,
  task: CheckSquare,
}

export function SearchPalette({
  config,
  favorites,
  onClose,
}: {
  config: PublicCrmConfig
  favorites: Favorite[]
  onClose: () => void
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const index = useSearchIndex()
  const canAdd = useWriteReach().any
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  /** An object the search is narrowed to. */
  const [scope, setScope] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [recents] = useState(readRecents)
  const [deep, setDeep] = useState<{ q: string; hits: DeepHit[]; failed?: boolean }>()

  const [files, setFiles] = useState<{
    q: string
    found: { id: string; name: string; path: string; folderId: string | null }[]
  }>()

  const answers = useRef(new Map<string, DeepHit[]>())
  const q = query.trim()

  // Ask the server once typing pauses: one request for "jones", not one each for "jo", "jon" and "jone".
  // A request still on its way when more is typed is abandoned. Answers are kept, so deleting a letter
  // shows the earlier one at once.
  useEffect(() => {
    if (q.length < 2) {
      return undefined
    }

    const kept = answers.current.get(q)

    if (kept) {
      setDeep({ q, hits: kept })
      return undefined
    }

    const abandon = new AbortController()

    const timer = setTimeout(() => {
      searchDeepFn({ data: { q }, signal: abandon.signal }).then(
        (hits) => {
          answers.current.set(q, hits)

          if (!abandon.signal.aborted) {
            setDeep({ q, hits })
          }
        },
        () => {
          // Say so rather than leave "Searching…" up for good. What the browser found itself still shows.
          if (!abandon.signal.aborted) {
            setDeep({ q, hits: [], failed: true })
          }
        },
      )
    }, DEEP_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      abandon.abort()
    }
  }, [q])

  // File names live in the file store, which answers in its own time: asked separately so it holds nothing up.
  useEffect(() => {
    if (q.length < 3 || scope) {
      return undefined
    }

    let stale = false

    const timer = setTimeout(() => {
      searchFilesFn({ data: { q } }).then(
        (res) => {
          if (!stale && res.ok) {
            setFiles({ q, found: res.value.files.slice(0, 5) })
          }
        },
        () => undefined,
      )
    }, 250)

    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [q, scope])

  const items = useMemo<Item[]>(() => {
    const go = (target: NavigateOptions) => (newTab: boolean) => {
      onClose()

      if (newTab) {
        window.open(router.buildLocation(target).href, '_blank', 'noopener')
      } else {
        void navigate(target)
      }
    }

    const record = (objectKey: string, id: string) =>
      go({ to: '/$object/$id', params: { object: objectKey, id } })

    const icon = (objectKey: string) => (
      <ObjectIcon
        icon={config.objects[objectKey]?.icon}
        index={Math.max(0, Object.keys(config.objects).indexOf(objectKey))}
        size="sm"
      />
    )

    const label = (objectKey: string) => config.objects[objectKey]?.label ?? objectKey
    const out: Item[] = []

    const page = (id: string, text: string, Icon: LucideIcon, to: NavigateOptions['to']): Item => ({
      id,
      section: 'Go to',
      icon: <Icon className="size-3.5" />,
      title: text,
      run: go({ to }),
    })

    const commands: (Item & { text: string })[] = [
      { ...page('home', 'Home', Home, '/'), text: 'Home' },
      { ...page('tasks', 'Tasks', CheckSquare, '/tasks'), text: 'Tasks' },
      { ...page('notes', 'Notes', FileText, '/notes'), text: 'Notes' },
      { ...page('files', 'Files', FolderOpen, '/files'), text: 'Files' },
      { ...page('reports', 'Reports', BarChart3, '/reports'), text: 'Reports' },
      { ...page('workflows', 'Workflows', Workflow, '/workflows'), text: 'Workflows' },
      { ...page('integrations', 'Integrations', Plug, '/integrations'), text: 'Integrations' },
      {
        ...page('assistant', 'Ask the assistant', MessageCircle, '/assistant'),
        text: 'Ask the assistant',
      },
      ...Object.entries(config.objects).flatMap(([key, obj]) => [
        {
          id: `list:${key}`,
          section: 'Go to',
          icon: icon(key),
          title: obj.labelPlural,
          text: obj.labelPlural,
          run: go({ to: '/$object', params: { object: key } }),
        },
        ...obj.views.map((v) => ({
          id: `view:${key}:${v.id}`,
          section: 'Go to',
          icon: icon(key),
          title: `${obj.labelPlural} › ${v.label}`,
          text: `${obj.labelPlural} ${v.label}`,
          hint: 'View',
          run: go({ to: '/$object', params: { object: key }, search: { view: v.id } }),
        })),
      ]),
      ...(index?.views ?? []).map((v) => ({
        id: `view:${v.objectKey}:${v.id}`,
        section: 'Go to',
        icon: icon(v.objectKey),
        title: `${config.objects[v.objectKey]?.labelPlural ?? v.objectKey} › ${v.label}`,
        text: `${config.objects[v.objectKey]?.labelPlural ?? ''} ${v.label}`,
        hint: 'View',
        run: go({ to: '/$object', params: { object: v.objectKey }, search: { view: v.id } }),
      })),
      // Nothing to create for someone who can't add records.
      ...(canAdd ? Object.entries(config.objects) : []).map(([key, obj]) => ({
        id: `new:${key}`,
        section: 'Create',
        icon: <Plus className="size-3.5" />,
        title: `New ${obj.label.toLowerCase()}`,
        text: `New ${obj.label}`,
        run: go({ to: '/$object', params: { object: key }, search: { new: true } }),
      })),
    ]

    if (!q) {
      if (scope) {
        return out
      }

      for (const r of recents.slice(0, 8)) {
        if (!config.objects[r.objectKey]) {
          continue
        }

        out.push({
          id: `recent:${r.objectKey}:${r.id}`,
          section: 'Recently opened',
          icon: <Clock className="size-3.5" />,
          title: r.title,
          hint: label(r.objectKey),
          objectKey: r.objectKey,
          run: record(r.objectKey, r.id),
        })
      }

      for (const f of favorites) {
        out.push({
          id: `favorite:${f.objectKey}:${f.recordId}`,
          section: 'Favorites',
          icon: <Star className="size-3.5 text-amber-500" fill="currentColor" strokeWidth={0} />,
          title: f.title,
          hint: label(f.objectKey),
          objectKey: f.objectKey,
          run: record(f.objectKey, f.recordId),
        })
      }

      // Views are found by typing; with nothing typed the list stays short.
      return [...out, ...commands.filter((c) => !c.id.startsWith('view:'))]
    }

    const found = index
      ? searchRecords(index, q, {
          recent: recents.map((r) => recentKey(r.objectKey, r.id)),
          only: scope ?? undefined,
          per: scope ? 12 : 5,
        })
      : undefined

    const hitItem =
      (section: string) =>
      (h: NonNullable<typeof found>['best'][number]): Item => {
        const obj = config.objects[h.objectKey]

        const where =
          h.field && h.value ? (
            <>
              {fieldLabel(h.field, obj?.fields[h.field])}: <Marked text={h.value} q={q} />
            </>
          ) : (
            h.summary
          )

        return {
          id: `${section}:${h.objectKey}:${h.id}`,
          section,
          icon: icon(h.objectKey),
          title: <Marked text={h.title} q={q} />,
          detail: where || undefined,
          hint: label(h.objectKey),
          objectKey: h.objectKey,
          run: record(h.objectKey, h.id),
        }
      }

    const showAll = (objectKey: string, total: number): Item => ({
      id: `all:${objectKey}`,
      section: config.objects[objectKey]?.labelPlural ?? objectKey,
      icon: <Search className="size-3.5" />,
      title: `Show all ${total.toLocaleString()} in ${config.objects[objectKey]?.labelPlural ?? objectKey}`,
      objectKey,
      run: go({ to: '/$object', params: { object: objectKey }, search: { q } }),
    })

    if (found) {
      out.push(...found.best.map(hitItem('Best matches')))

      for (const group of found.groups) {
        const section = config.objects[group.objectKey]?.labelPlural ?? group.objectKey
        out.push(...group.hits.map(hitItem(section)))

        if (group.total > group.hits.length) {
          out.push(showAll(group.objectKey, group.total))
        }
      }
    }

    const answered = deep?.q === q ? deep.hits : []

    // What the server found that the browser didn't: matches in fields it isn't given, or records newer than its index.
    const more = answered.flatMap((h) =>
      h.kind === 'record' &&
      h.objectKey &&
      (!scope || scope === h.objectKey) &&
      !found?.matched.has(recentKey(h.objectKey, h.id))
        ? [{ h, objectKey: h.objectKey }]
        : [],
    )

    for (const { h, objectKey } of more) {
      const obj = config.objects[objectKey]

      out.push({
        id: `more:${objectKey}:${h.id}`,
        section: found && found.groups.length > 0 ? 'More records' : 'Records',
        icon: icon(objectKey),
        title: <Marked text={h.title} q={q} />,
        detail:
          h.field && h.snippet ? (
            <>
              {fieldLabel(h.field, obj?.fields[h.field])}: <Marked text={h.snippet} q={q} />
            </>
          ) : undefined,
        hint: label(objectKey),
        objectKey,
        run: record(objectKey, h.id),
      })
    }

    if (!scope) {
      const attached = (
        h: { objectKey: string | null; recordId: string | null },
        fallback: NavigateOptions['to'],
      ) =>
        h.objectKey && h.recordId && config.objects[h.objectKey]
          ? record(h.objectKey, h.recordId)
          : go({ to: fallback })

      const noteIds = new Set(found?.notes.hits.map((n) => n.id))

      for (const n of found?.notes.hits ?? []) {
        out.push({
          id: `note:${n.id}`,
          section: 'Notes',
          icon: <FileText className="size-3.5" />,
          title: <Marked text={n.title} q={q} />,
          hint: 'Note',
          run: attached(n, '/notes'),
        })
      }

      const sections = new Map([
        ['note', 'Notes'],
        ['email', 'Emails and calls'],
        ['call', 'Emails and calls'],
        ['meeting', 'Emails and calls'],
        ['task', 'Tasks'],
      ])

      const order = ['note', 'email', 'call', 'meeting', 'task']

      const rest = answered.filter(
        (h) => h.kind !== 'record' && !(h.kind === 'note' && noteIds.has(h.id)),
      )

      rest.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))

      // Emails, calls and meetings share a section: keep the server's order (title matches, then newest) within it.
      for (const h of [
        ...rest.filter((r) => r.kind === 'note'),
        ...answered.filter((r) => ['email', 'call', 'meeting'].includes(r.kind)),
        ...rest.filter((r) => r.kind === 'task'),
      ]) {
        const Icon = DEEP_ICONS[h.kind]
        const on = h.recordTitle ? h.recordTitle : undefined

        out.push({
          id: `${h.kind}:${h.id}`,
          section: sections.get(h.kind) ?? 'More',
          icon: <Icon className="size-3.5" />,
          title: <Marked text={h.title} q={q} />,
          detail: h.snippet ? <Marked text={h.snippet} q={q} /> : undefined,
          hint:
            [on, h.at ? relativeTime(h.at) : undefined].filter(Boolean).join(' · ') || undefined,
          run: attached(h, h.kind === 'task' ? '/tasks' : '/notes'),
        })
      }

      for (const f of files?.q === q ? files.found : []) {
        out.push({
          id: `file:${f.id}`,
          section: 'Files',
          icon: <File className="size-3.5" />,
          title: <Marked text={f.name} q={q} />,
          detail: f.path,
          hint: 'File',
          run: go({ to: '/files', search: f.folderId ? { folder: f.folderId } : {} }),
        })
      }

      const typed = fold(q)
      out.push(...commands.filter((c) => fold(c.text).includes(typed)))
    }

    return out
  }, [q, scope, index, deep, files, recents, favorites, config, navigate, router, onClose, canAdd])

  const current = Math.min(active, Math.max(0, items.length - 1))
  const activeId = items[current] ? `${listId}-${current}` : undefined
  const waiting = q.length >= 2 && deep?.q !== q

  useEffect(() => {
    if (activeId) {
      document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeId])

  /** Tab: narrow to the object whose name is typed, or the one the highlighted result belongs to. */
  function narrow(): boolean {
    const typed = fold(q)

    const named =
      typed.length >= 2
        ? Object.entries(config.objects).find(
            ([, o]) => fold(o.labelPlural).startsWith(typed) || fold(o.label).startsWith(typed),
          )?.[0]
        : undefined

    const target = named ?? items[current]?.objectKey

    if (!target || target === scope) {
      return false
    }

    setScope(target)

    if (named) {
      setQuery('')
    }

    setActive(0)
    return true
  }

  let section = ''
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 sm:pt-[12vh]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-label="Search"
        className="border-c-line2 bg-c-raised text-c-fg flex h-full w-full flex-col overflow-hidden shadow-2xl sm:h-auto sm:max-h-[70vh] sm:max-w-2xl sm:rounded-2xl sm:border"
      >
        <div
          data-guide="search-box"
          className="border-c-line flex shrink-0 items-center gap-2 border-b px-3.5"
        >
          <Search className="text-c-fg3 size-4 shrink-0" />
          {scope && (
            <span className="bg-c-hov flex shrink-0 items-center gap-1 rounded-md py-0.5 pr-1 pl-1.5 text-xs font-medium">
              {config.objects[scope]?.labelPlural ?? scope}
              <button
                type="button"
                aria-label="Search everything"
                onClick={() => setScope(null)}
                className="text-c-fg3 hover:text-c-fg rounded p-0.5"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          <input
            // The palette opens on an explicit shortcut or click.
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-label="Search the CRM"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onClose()
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setActive(Math.max(0, Math.min(items.length - 1, current + step)))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                items[current]?.run(e.metaKey || e.ctrlKey)
              } else if (e.key === 'Tab' && !e.shiftKey) {
                if (narrow()) {
                  e.preventDefault()
                }
              } else if (e.key === 'Backspace' && query === '' && scope) {
                setScope(null)
              }
            }}
            placeholder={scope ? 'Search…' : 'Search records, notes, emails, files…'}
            className="placeholder:text-c-fg3 h-12 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="text-c-fg3 hover:bg-c-hov hover:text-c-fg rounded-lg p-1.5 sm:hidden"
          >
            <X className="size-4" />
          </button>
        </div>
        <div
          ref={listRef}
          data-guide="search-results"
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          <div id={listId} role="listbox" aria-label="Results">
            {items.map((item, i) => {
              const heading = item.section !== section ? item.section : null
              section = item.section
              return (
                <div key={item.id}>
                  {heading && (
                    <div
                      role="presentation"
                      className="text-c-fg3 px-2.5 pt-2 pb-1 text-[11px] font-medium"
                    >
                      {heading}
                    </div>
                  )}
                  {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- Focus stays in the search box, which handles the keys. */}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === current}
                    tabIndex={-1}
                    onPointerMove={() => setActive(i)}
                    onClick={(e) => item.run(e.metaKey || e.ctrlKey)}
                    className={cx(
                      'flex min-h-11 w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left sm:min-h-0',
                      i === current && 'bg-c-hov',
                    )}
                  >
                    <span className="text-c-fg2 flex w-4 shrink-0 justify-center">{item.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.title}</span>
                      {item.detail && (
                        <span className="text-c-fg3 block truncate text-xs">{item.detail}</span>
                      )}
                    </span>
                    {item.hint && (
                      <span className="text-c-fg3 max-w-[40%] shrink-0 truncate text-xs">
                        {item.hint}
                      </span>
                    )}
                    {i === current && (
                      <CornerDownLeft className="text-c-fg3 hidden size-3 shrink-0 sm:block" />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div role="status" className="text-c-fg3">
            {q && !index && <div className="px-2.5 py-2">Loading records…</div>}
            {waiting && (
              <div className="px-2.5 py-2 text-xs">Searching notes, emails and tasks…</div>
            )}
            {!waiting && q.length >= 2 && deep?.failed && (
              <div className="px-2.5 py-2 text-xs">
                Could not search notes, emails and tasks. Check your connection and type again.
              </div>
            )}
            {q && index && !waiting && !deep?.failed && items.length === 0 && (
              <div className="px-3 py-6 text-center">No results</div>
            )}
          </div>
        </div>
        <div
          data-guide="search-keys"
          className="border-c-line text-c-fg3 hidden shrink-0 items-center gap-3 border-t px-3.5 py-1.5 text-[11px] sm:flex"
        >
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>⌘↵</Kbd> new tab
          </span>
          <span>
            <Kbd>Tab</Kbd> narrow to one kind of record
          </span>
        </div>
      </div>
    </div>
  )
}
