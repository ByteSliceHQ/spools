import { getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router'
import {
  CalendarCheck,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  FileText,
  Mail,
  MoreHorizontal,
  Phone,
  Plus,
  Star,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { z } from 'zod'

import type { LoggableKind } from '../crm/activity'
import { fieldLabel } from '../crm/naming'
import { FieldValue } from '../crm/ui/fields'
import { FileBrowser } from '../crm/ui/files'
import { fieldTypeIcons } from '../crm/ui/icons'
import { InlineField } from '../crm/ui/inline-field'
import { Avatar, Button, Count, cx, IconButton, MenuItem, MenuLabel, Popover } from '../crm/ui/kit'
import { NewRecordDialog } from '../crm/ui/new-record-dialog'
import { rememberOpened } from '../crm/ui/search'
import { TopBar } from '../crm/ui/shell'
import { useCrmConfig, useCrmObject } from '../crm/ui/use-crm'
import {
  ActivityList,
  ComposeEmailDialog,
  LogActivityDialog,
  NoteCard,
  NoteDialog,
  type NoteItem,
  TaskDialog,
  TaskRow,
} from '../crm/ui/workspace'
import { listSearch } from '../pages/list'
import { deleteRecordFn, runActionFn } from '../server/crm.functions'
import { recordFolderFn } from '../server/files.functions'
import type { RelatedGroup } from '../server/records'
import type { CrmValue } from '../server/store/objects'
import { toggleFavoriteFn } from '../server/workspace.functions'

const route = getRouteApi('/_crm/$object/$id')

/** The list the user came from, as the list page saves it: kept in session storage, so read with care. */
const listContext = z.object({
  objectKey: z.string(),
  label: z.string(),
  total: z.number(),
  ids: z.array(z.string()),
  search: listSearch,
})

type ListContext = z.infer<typeof listContext>

/** The kinds of value a title field holds as text. A related record nested in it has none. */
const titleValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.date(),
  z.array(z.union([z.string(), z.number()])),
])

/** A record's title as it is shown, or `fallback` when its title field holds no text. */
function titleOf(value: CrmValue, fallback: string): string {
  const title = titleValue.safeParse(value)
  return title.success ? String(title.data) : fallback
}

const emailAddress = z.string().min(1)

/** The list the user came from (saved by the list page), for previous/next. */
function useListContext(objectKey: string, id: string) {
  const [ctx, setCtx] = useState<ListContext | null>(null)

  useEffect(() => {
    try {
      const parsed = listContext.safeParse(
        JSON.parse(window.sessionStorage.getItem('crm-list') ?? 'null'),
      )

      const saved = parsed.success ? parsed.data : null
      setCtx(saved && saved.objectKey === objectKey && saved.ids.includes(id) ? saved : null)
    } catch {
      setCtx(null)
    }
  }, [objectKey, id])

  return ctx
}

export function RecordPage(): ReactNode {
  const { object, id } = route.useParams()
  const { tab = 'overview' } = route.useSearch()
  const { record, activities, related, tasks, notes, favorite } = route.useLoaderData()
  const { obj, titleFieldOf } = useCrmObject(object)
  const config = useCrmConfig()
  const router = useRouter()
  const navigate = useNavigate()
  const list = useListContext(object, id)
  // Search offers what was opened lately first.
  const opened = titleOf(record[obj.titleField], 'Untitled')
  useEffect(() => rememberOpened({ objectKey: object, id, title: opened }), [object, id, opened])
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string }>()

  const [files, setFiles] = useState<{ folderId?: string; at: string | null; note?: string }>({
    at: null,
  })

  const takesFiles = !!obj.files

  // A record that takes files has its own folder in the drive: make sure it exists as soon as its page is opened.
  useEffect(() => {
    setFiles({ at: null })

    if (!takesFiles) {
      return undefined
    }

    let stale = false

    recordFolderFn({ data: { objectKey: object, recordId: id } })
      .then((res) => {
        if (stale) {
          return
        }

        if (!res.ok) {
          setFiles({ at: null, note: res.error })
        } else if (res.value) {
          setFiles({ at: null, folderId: res.value.folderId })
        } else {
          setFiles({ at: null, note: "Files aren't set up for this CRM yet." })
        }
      })
      .catch(
        () =>
          !stale &&
          setFiles({
            at: null,
            note: "This record's folder could not be opened. Reload the page.",
          }),
      )

    return () => {
      stale = true
    }
  }, [object, id, takesFiles])

  const [menu, setMenu] = useState<'more' | null>(null)
  const [dialog, setDialog] = useState<'email' | 'task' | 'note' | null>(null)
  const [logging, setLogging] = useState<LoggableKind | null>(null)
  const [editingNote, setEditingNote] = useState<NoteItem | undefined>()
  const [creating, setCreating] = useState<{ objectKey: string; field: string } | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(true)

  const title = titleOf(record[obj.titleField], 'Untitled')
  const link = { objectKey: object, recordId: id, title }

  // The first email field with an address in it: where "Send email" writes to.
  const email = Object.keys(obj.fields)
    .flatMap((key) => {
      const address = obj.fields[key]?.type === 'email' ? emailAddress.safeParse(record[key]) : null
      return address?.success ? [{ field: key, to: address.data }] : []
    })
    .at(0)

  const emails = activities.filter((a) => a.kind === 'email')
  const openTasks = tasks.filter((t) => !t.completedAt)

  const position = list ? list.ids.indexOf(id) : -1

  const goTo = (offset: number) => {
    const next = list?.ids[position + offset]

    if (next) {
      void navigate({ to: '/$object/$id', params: { object, id: next } })
    }
  }

  const close = () => navigate({ to: '/$object', params: { object }, search: list?.search ?? {} })

  async function runAction(actionId: string, confirmText?: string) {
    setMenu(null)

    if (confirmText && !window.confirm(confirmText)) {
      return
    }

    try {
      const res = await runActionFn({ data: { objectKey: object, id, actionId } })
      setFlash({ kind: 'ok', text: res.message })
      await router.invalidate()
    } catch (err) {
      setFlash({ kind: 'error', text: err instanceof Error ? err.message : 'Action failed' })
    }
  }

  async function remove() {
    setMenu(null)

    if (!window.confirm(`Delete this ${obj.label.toLowerCase()}? This can't be undone.`)) {
      return
    }

    await deleteRecordFn({ data: { objectKey: object, id } })
    await close()
  }

  async function toggleFavorite() {
    await toggleFavoriteFn({ data: { objectKey: object, recordId: id } })
    await router.invalidate()
  }

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: 'Activity', count: activities.length },
    { id: 'emails', label: 'Emails', count: emails.length },
    { id: 'notes', label: 'Notes', count: notes.length },
    { id: 'tasks', label: 'Tasks', count: openTasks.length },
    // Only for objects whose records take files (`files` in crm.config.json).
    ...(obj.files ? [{ id: 'files', label: 'Files' }] : []),
    ...related.map((g) => ({
      id: `${g.objectKey}.${g.field}`,
      label: config.objects[g.objectKey]?.labelPlural ?? g.objectKey,
      count: g.rows.length,
    })),
  ]

  const activeGroup = related.find((g) => `${g.objectKey}.${g.field}` === tab)
  const creatingObj = creating ? config.objects[creating.objectKey] : undefined

  // Highlights: the first few filled-in fields that summarise a record at a glance.
  const highlights = Object.entries(obj.fields)
    .filter(
      ([key, f]) =>
        key !== obj.titleField &&
        ['select', 'currency', 'date', 'relation', 'user', 'number'].includes(f.type),
    )
    .filter(([key, f]) => {
      const value = record[f.type === 'relation' ? key : key]
      return value !== null && value !== undefined && value !== ''
    })
    .slice(0, 4)

  return (
    <>
      <TopBar
        left={
          <div className="flex min-w-0 items-center gap-1">
            <IconButton
              label={`Back to ${obj.labelPlural.toLowerCase()}`}
              data-guide="record-back"
              onClick={close}
            >
              <X className="size-3.5" />
            </IconButton>
            {list && (
              <>
                <IconButton
                  data-guide="record-nav"
                  label="Previous record"
                  disabled={position <= 0}
                  onClick={() => goTo(-1)}
                  className="border-c-line2 border"
                >
                  <ChevronUp className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Next record"
                  disabled={position >= list.ids.length - 1}
                  onClick={() => goTo(1)}
                  className="border-c-line2 border"
                >
                  <ChevronDown className="size-3.5" />
                </IconButton>
                <span className="text-c-fg2 ml-2 truncate tabular-nums">
                  {((list.search.page ?? 1) - 1) * 50 + position + 1} of{' '}
                  {list.total.toLocaleString()} in {list.label}
                </span>
              </>
            )}
            {!list && (
              <Link to="/$object" params={{ object }} className="text-c-fg2 hover:text-c-fg ml-1">
                {obj.labelPlural}
              </Link>
            )}
          </div>
        }
      />

      {flash && (
        <div
          className={cx(
            'border-b border-c-line px-4 py-2 text-xs',
            flash.kind === 'ok'
              ? 'bg-green-500/10 text-green-700 dark:text-green-300'
              : 'bg-red-500/10 text-c-danger',
          )}
        >
          {flash.text}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="border-c-line w-[352px] shrink-0 overflow-y-auto border-r">
          <div className="flex items-center gap-2.5 px-3 pt-3.5">
            <Avatar name={title} size="lg" />
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
            <IconButton
              label={favorite ? 'Remove from favorites' : 'Add to favorites'}
              data-guide="favorite"
              onClick={toggleFavorite}
            >
              <Star
                className={cx('size-3.5', favorite && 'text-amber-500')}
                fill={favorite ? 'currentColor' : 'none'}
              />
            </IconButton>
          </div>

          <div
            data-guide="record-actions"
            className="flex flex-wrap items-center gap-1.5 px-3 pt-3 pb-3.5"
          >
            {email && (
              <Button data-guide="compose-email" onClick={() => setDialog('email')}>
                <Mail className="text-c-fg2 size-3.5" /> Compose email
              </Button>
            )}
            <IconButton
              label="Log a call"
              className="border-c-line2 border"
              data-guide="log-call"
              onClick={() => setLogging('call')}
            >
              <Phone className="size-3.5" />
            </IconButton>
            <IconButton
              label="Log a meeting"
              className="border-c-line2 border"
              data-guide="log-meeting"
              onClick={() => setLogging('meeting')}
            >
              <CalendarCheck className="size-3.5" />
            </IconButton>
            <IconButton
              label="Add note"
              className="border-c-line2 border"
              data-guide="add-note"
              onClick={() => setDialog('note')}
            >
              <FileText className="size-3.5" />
            </IconButton>
            <IconButton
              label="Add task"
              className="border-c-line2 border"
              data-guide="add-task"
              onClick={() => setDialog('task')}
            >
              <CheckSquare className="size-3.5" />
            </IconButton>
            <div className="relative">
              <IconButton
                label="More actions"
                data-guide="more-actions"
                className="border-c-line2 border"
                onClick={() => setMenu(menu ? null : 'more')}
              >
                <MoreHorizontal className="size-3.5" />
              </IconButton>
              <Popover open={menu === 'more'} onClose={() => setMenu(null)}>
                {obj.actions.length > 0 && <MenuLabel>Actions</MenuLabel>}
                {obj.actions.map((a) => (
                  <MenuItem key={a.id} onSelect={() => runAction(a.id, a.confirm)}>
                    <Zap className="text-c-fg2 size-3.5" /> {a.label}
                  </MenuItem>
                ))}
                <MenuItem danger onSelect={remove}>
                  <Trash2 className="size-3.5" /> Delete {obj.label.toLowerCase()}
                </MenuItem>
              </Popover>
            </div>
          </div>

          <div data-guide="record-details" className="border-c-line border-t px-1.5 py-2">
            <button
              type="button"
              onClick={() => setDetailsOpen(!detailsOpen)}
              className="text-c-fg2 hover:text-c-fg flex h-7 items-center gap-1 px-1.5 text-xs font-medium"
            >
              Record details{' '}
              <ChevronDown
                className={cx('size-3 transition-transform', !detailsOpen && '-rotate-90')}
              />
            </button>
            {detailsOpen && (
              <dl>
                {Object.entries(obj.fields).map(([key, field]) => {
                  const Icon = fieldTypeIcons[field.type]
                  return (
                    <div
                      key={key}
                      data-guide={`field:${key}`}
                      className="grid grid-cols-[7.25rem_1fr] items-start"
                    >
                      <dt
                        className="text-c-fg2 flex h-7 items-center gap-2 px-1.5"
                        title={field.description}
                      >
                        <Icon className="text-c-fg3 size-3.5 shrink-0" strokeWidth={2} />
                        <span className="truncate">{fieldLabel(key, field)}</span>
                      </dt>
                      <dd className="min-w-0">
                        <InlineField
                          objectKey={object}
                          record={record}
                          fieldKey={key}
                          field={field}
                          titleFieldOf={titleFieldOf}
                          variant="detail"
                        />
                      </dd>
                    </div>
                  )
                })}
              </dl>
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <nav
            data-guide="record-tabs"
            className="border-c-line flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b px-2"
          >
            {tabs.map((t) => (
              <Link
                key={t.id}
                to="."
                search={{ tab: t.id === 'overview' ? undefined : t.id }}
                data-guide={`tab:${t.id}`}
                className={cx(
                  '-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2',
                  t.id === tab
                    ? 'border-c-fg font-medium'
                    : 'border-transparent text-c-fg2 hover:text-c-fg',
                )}
              >
                {t.label}
                {'count' in t && t.count !== undefined && (
                  <Count>{t.count > 99 ? '99+' : t.count}</Count>
                )}
              </Link>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {tab === 'overview' && (
              <div className="mx-auto max-w-4xl space-y-5">
                {highlights.length > 0 && (
                  <Block title="Highlights">
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                      {highlights.map(([key, field]) => (
                        <div key={key} className="border-c-line bg-c-raised rounded-xl border p-3">
                          <div className="text-c-fg2 truncate text-xs">
                            {fieldLabel(key, field)}
                          </div>
                          <div className="mt-1.5 truncate font-medium">
                            <FieldValue
                              field={field}
                              fieldKey={key}
                              record={record}
                              titleFieldOf={titleFieldOf}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </Block>
                )}
                <Block title="Activity" link={{ tab: 'activity', label: 'View all' }}>
                  <Card>
                    <ActivityList items={activities.slice(0, 5)} />
                  </Card>
                </Block>
                <Block title="Notes" count={notes.length} onAdd={() => setDialog('note')}>
                  {notes.length > 0 && (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {notes.slice(0, 2).map((n) => (
                        <NoteCard
                          key={n.id}
                          note={n}
                          onOpen={() => setEditingNote(n)}
                          showRecord={false}
                        />
                      ))}
                    </div>
                  )}
                </Block>
                <Block title="Tasks" count={openTasks.length} onAdd={() => setDialog('task')}>
                  {openTasks.length > 0 && (
                    <Card>
                      {openTasks.slice(0, 5).map((t) => (
                        <TaskRow key={t.id} task={t} showRecord={false} />
                      ))}
                    </Card>
                  )}
                </Block>
              </div>
            )}

            {tab === 'activity' && (
              <div className="mx-auto max-w-4xl space-y-3">
                <div className="flex gap-1.5">
                  <Button onClick={() => setLogging('call')}>
                    <Phone className="text-c-fg2 size-3.5" /> Log call
                  </Button>
                  <Button onClick={() => setLogging('meeting')}>
                    <CalendarCheck className="text-c-fg2 size-3.5" /> Log meeting
                  </Button>
                </div>
                <Card>
                  <ActivityList items={activities} />
                </Card>
              </div>
            )}

            {tab === 'emails' && (
              <div className="mx-auto max-w-4xl space-y-3">
                {email && (
                  <Button onClick={() => setDialog('email')}>
                    <Mail className="text-c-fg2 size-3.5" /> Compose email
                  </Button>
                )}
                <Card>
                  <ActivityList
                    items={emails}
                    empty="No emails yet. Emails you compose here and emails sent by sequences appear on this tab."
                  />
                </Card>
              </div>
            )}

            {tab === 'notes' && (
              <div className="mx-auto max-w-4xl space-y-3">
                <Button onClick={() => setDialog('note')}>
                  <Plus className="size-3.5" /> New note
                </Button>
                {notes.length === 0 ? (
                  <p className="text-c-fg3 py-10 text-center">No notes yet.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {notes.map((n) => (
                      <NoteCard
                        key={n.id}
                        note={n}
                        onOpen={() => setEditingNote(n)}
                        showRecord={false}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'tasks' && (
              <div className="mx-auto max-w-4xl space-y-3">
                <Button onClick={() => setDialog('task')}>
                  <Plus className="size-3.5" /> New task
                </Button>
                {tasks.length === 0 ? (
                  <p className="text-c-fg3 py-10 text-center">No tasks yet.</p>
                ) : (
                  <Card>
                    {[...openTasks, ...tasks.filter((t) => t.completedAt)].map((t) => (
                      <TaskRow key={t.id} task={t} showRecord={false} />
                    ))}
                  </Card>
                )}
              </div>
            )}

            {tab === 'files' && obj.files && (
              <div className="-m-3 h-[calc(100%+1.5rem)]">
                {files.folderId ? (
                  <FileBrowser
                    rootId={files.folderId}
                    rootLabel="Files"
                    folderId={files.at}
                    onNavigate={(at) => setFiles((f) => ({ ...f, at }))}
                    record={{ objectKey: object, recordId: id }}
                    onChange={() => void router.invalidate()}
                  />
                ) : (
                  <p className="text-c-fg3 py-10 text-center">
                    {files.note ?? "Opening this record's folder…"}
                  </p>
                )}
              </div>
            )}

            {activeGroup && (
              <div className="mx-auto max-w-4xl">
                <RelatedList
                  group={activeGroup}
                  titleFieldOf={titleFieldOf}
                  onCreate={() =>
                    setCreating({ objectKey: activeGroup.objectKey, field: activeGroup.field })
                  }
                />
              </div>
            )}
          </div>
        </section>
      </div>

      {email && (
        <ComposeEmailDialog
          open={dialog === 'email'}
          onClose={() => setDialog(null)}
          objectKey={object}
          recordId={id}
          field={email.field}
          to={email.to}
        />
      )}
      <TaskDialog open={dialog === 'task'} onClose={() => setDialog(null)} link={link} />
      <LogActivityDialog kind={logging} onClose={() => setLogging(null)} link={link} />
      <NoteDialog
        open={dialog === 'note' || !!editingNote}
        onClose={() => {
          setDialog(null)
          setEditingNote(undefined)
        }}
        note={editingNote}
        link={link}
      />
      {creating && creatingObj && (
        <NewRecordDialog
          open
          onClose={() => setCreating(null)}
          objectKey={creating.objectKey}
          obj={creatingObj}
          // The new record starts out linked to this one, whose title is already on the page.
          titles={{ [object]: [{ id, title }] }}
          preset={{ [`${creating.field}Id`]: id }}
        />
      )}
    </>
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="border-c-line bg-c-panel overflow-hidden rounded-xl border py-1">
      {children}
    </div>
  )
}

/** A titled section on the overview, with an optional count, add button and "view all" link. */
function Block({
  title,
  count,
  onAdd,
  link,
  children,
}: {
  title: string
  count?: number
  onAdd?: () => void
  link?: { tab: string; label: string }
  children?: ReactNode
}) {
  return (
    <section>
      <header className="mb-2 flex h-6 items-center gap-1.5 px-1">
        <h2 className="font-medium">{title}</h2>
        {count !== undefined && <Count>{count}</Count>}
        <div className="ml-auto flex items-center">
          {link && (
            <Link to="." search={{ tab: link.tab }} className="text-c-fg2 hover:text-c-fg text-xs">
              {link.label}
            </Link>
          )}
          {onAdd && (
            <IconButton label={`Add to ${title.toLowerCase()}`} className="size-6" onClick={onAdd}>
              <Plus className="size-3.5" />
            </IconButton>
          )}
        </div>
      </header>
      {children}
    </section>
  )
}

function RelatedList({
  group,
  titleFieldOf,
  onCreate,
}: {
  group: RelatedGroup
  titleFieldOf: (objectKey: string) => string
  onCreate: () => void
}) {
  const config = useCrmConfig()
  const obj = config.objects[group.objectKey]

  if (!obj) {
    return null
  }

  // Show the title plus the first few fields that aren't the link back to this record.
  const columns = Object.keys(obj.fields)
    .filter((k) => k !== obj.titleField && k !== group.field && obj.fields[k]?.type !== 'longtext')
    .slice(0, 3)

  return (
    <div className="space-y-3">
      <Button onClick={onCreate}>
        <Plus className="size-3.5" /> New {obj.label.toLowerCase()}
      </Button>
      {group.rows.length === 0 ? (
        <p className="text-c-fg3 py-10 text-center">No {obj.labelPlural.toLowerCase()} yet.</p>
      ) : (
        <Card>
          {group.rows.map((r) => (
            <Link
              key={r.id}
              to="/$object/$id"
              params={{ object: group.objectKey, id: r.id }}
              className="hover:bg-c-hov flex h-9 items-center gap-4 px-3"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 font-medium">
                <Avatar name={titleOf(r[obj.titleField], '?')} size="sm" />
                <span className="truncate">{titleOf(r[obj.titleField], 'Untitled')}</span>
              </span>
              {columns.map((c) => (
                <span key={c} className="text-c-fg2 hidden w-40 shrink-0 truncate md:block">
                  <FieldValue
                    field={obj.fields[c]}
                    fieldKey={c}
                    record={r}
                    titleFieldOf={titleFieldOf}
                    plain
                  />
                </span>
              ))}
            </Link>
          ))}
        </Card>
      )}
    </div>
  )
}
