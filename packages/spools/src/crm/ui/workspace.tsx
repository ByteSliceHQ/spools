import { Link, useRouter } from '@tanstack/react-router'
import {
  CalendarCheck,
  CheckSquare,
  Clock,
  FileText,
  type LucideIcon,
  Mail,
  Paperclip,
  PencilLine,
  Phone,
  Send,
  Sparkles,
  Trash2,
  Workflow,
  Zap,
} from 'lucide-react'
import { useContext, useEffect, useState } from 'react'

import { mailboxStatusFn } from '../../server/mailbox.functions'
import {
  createTaskFn,
  deleteNoteFn,
  deleteTaskFn,
  logActivityFn,
  saveNoteFn,
  sendEmailFn,
  updateTaskFn,
} from '../../server/workspace.functions'
import { LOGGABLE, type LoggableKind } from '../activity'
import { CrmUsersContext } from './fields'
import {
  Avatar,
  Button,
  CheckCircle,
  cx,
  Dialog,
  IconButton,
  inputClass,
  relativeTime,
} from './kit'

/** Shared pieces for tasks, notes, email and the activity timeline. */

// ── Activity ────────────────────────────────────────────────────────────────

export type ActivityItem = {
  id: string
  kind: string
  summary: string
  body: string | null
  actor: string | null
  createdAt: Date | string
  /** When a logged call or meeting took place, if it was entered afterwards. */
  occurredAt?: Date | string | null
}

const activityIcons = new Map<string, LucideIcon>([
  ['call', Phone],
  ['meeting', CalendarCheck],
  ['note', FileText],
  ['task', CheckSquare],
  ['email', Mail],
  ['campaign', Send],
  ['workflow', Workflow],
  ['agent', Sparkles],
  ['form', FileText],
  ['file', Paperclip],
  ['system', Zap],
  ['change', PencilLine],
])

/** A text field's value from a form. A missing field, or a file (these forms have none), reads as empty. */
function formText(data: FormData, name: string): string {
  const value = data.get(name)
  return value === null || value instanceof File ? '' : value
}

/** A timeline of "Actor did something" lines, newest first. */
export function ActivityList({
  items,
  empty = 'No activity yet.',
}: {
  items: ActivityItem[]
  empty?: string
}) {
  if (items.length === 0) {
    return <p className="text-c-fg3 px-3 py-6 text-center">{empty}</p>
  }

  return (
    <ol>
      {items.map((a) => {
        const Icon = activityIcons.get(a.kind) ?? Clock
        return (
          <li key={a.id} className="px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="bg-c-hov text-c-fg2 flex size-[18px] shrink-0 items-center justify-center rounded-full">
                <Icon className="size-2.5" strokeWidth={2.5} />
              </span>
              <p className="min-w-0 flex-1 truncate">
                <span className="font-medium">{a.actor ?? 'System'}</span>{' '}
                <span className="text-c-fg2">{a.summary}</span>
              </p>
              <time
                className="text-c-fg3 shrink-0 text-xs"
                title={new Date(a.occurredAt ?? a.createdAt).toLocaleString()}
              >
                {relativeTime(a.occurredAt ?? a.createdAt)}
              </time>
            </div>
            {a.body && (
              <p className="border-c-line bg-c-raised text-c-fg2 mt-1.5 ml-[26px] rounded-lg border px-2.5 py-2 whitespace-pre-wrap">
                {a.body}
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export type TaskItem = {
  id: string
  title: string
  dueDate: string | null
  completedAt: Date | string | null
  assigneeId: string | null
  objectKey: string | null
  recordId: string | null
  recordTitle: string | null
}

const today = () => new Date().toISOString().slice(0, 10)

export function dueLabel(dueDate: string | null): { text: string; overdue: boolean } | null {
  if (!dueDate) {
    return null
  }

  const date = new Date(`${dueDate}T00:00:00`)
  const overdue = dueDate < today()

  const text =
    dueDate === today()
      ? 'Due today'
      : `Due ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`

  return { text, overdue: overdue || dueDate === today() }
}

/** One task line: check, title, due date, linked record, assignee. */
export function TaskRow({ task, showRecord = true }: { task: TaskItem; showRecord?: boolean }) {
  const router = useRouter()
  const users = useContext(CrmUsersContext)
  const done = !!task.completedAt
  const due = dueLabel(task.dueDate)
  const assignee = users.find((u) => u.id === task.assigneeId)

  const toggle = async () => {
    await updateTaskFn({ data: { id: task.id, completed: !done } })
    await router.invalidate()
  }

  const remove = async () => {
    await deleteTaskFn({ data: { id: task.id } })
    await router.invalidate()
  }

  return (
    <div className="group/task border-c-line hover:bg-c-hov flex h-9 items-center gap-2.5 border-b px-3">
      <CheckCircle
        checked={done}
        onChange={toggle}
        label={done ? 'Mark as not done' : 'Mark as done'}
      />
      <span className={cx('min-w-0 flex-1 truncate', done && 'text-c-fg3 line-through')}>
        {task.title}
      </span>
      {due && (
        <span
          className={cx(
            'w-32 shrink-0 text-xs',
            due.overdue && !done ? 'text-c-danger' : 'text-c-fg3',
          )}
        >
          {due.text}
        </span>
      )}
      {showRecord && (
        <span className="hidden w-44 shrink-0 md:block">
          {task.objectKey && task.recordId && task.recordTitle && (
            <Link
              to="/$object/$id"
              params={{ object: task.objectKey, id: task.recordId }}
              className="hover:bg-c-line inline-flex max-w-full items-center gap-1.5 rounded-md px-1"
            >
              <Avatar name={task.recordTitle} size="xs" />
              <span className="truncate">{task.recordTitle}</span>
            </Link>
          )}
        </span>
      )}
      <span className="text-c-fg2 hidden w-36 shrink-0 items-center gap-1.5 lg:flex">
        {assignee && (
          <>
            <Avatar name={assignee.name} size="xs" round />
            <span className="truncate">{assignee.name}</span>
          </>
        )}
      </span>
      <IconButton
        label="Delete task"
        className="size-6 opacity-0 group-hover/task:opacity-100 focus:opacity-100"
        onClick={remove}
      >
        <Trash2 className="size-3.5" />
      </IconButton>
    </div>
  )
}

/** Create a task, optionally linked to a record. */
export function TaskDialog({
  open,
  onClose,
  link,
}: {
  open: boolean
  onClose: () => void
  link?: { objectKey: string; recordId: string; title: string }
}) {
  const router = useRouter()
  const users = useContext(CrmUsersContext)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  return (
    <Dialog open={open} onClose={onClose} title={link ? `New task for ${link.title}` : 'New task'}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          setBusy(true)
          setError(undefined)

          try {
            await createTaskFn({
              data: {
                title: formText(data, 'title'),
                dueDate: formText(data, 'dueDate') || null,
                assigneeId: formText(data, 'assigneeId') || null,
                objectKey: link?.objectKey,
                recordId: link?.recordId,
              },
            })

            await router.invalidate()
            onClose()
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not create the task')
          } finally {
            setBusy(false)
          }
        }}
      >
        <input
          name="title"
          required
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- The form opens in response to a click.
          autoFocus
          placeholder="What needs doing?"
          aria-label="Task"
          className={inputClass}
        />
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-c-fg2 text-xs font-medium">Due date</span>
            <input type="date" name="dueDate" className={inputClass} />
          </label>
          <label className="space-y-1">
            <span className="text-c-fg2 text-xs font-medium">Assigned to</span>
            <select name="assigneeId" className={inputClass}>
              <option value="">Me</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="text-c-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Create task'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// ── Logged calls and meetings ───────────────────────────────────────────────

/** `datetime-local` wants local time without a zone: "2026-01-31T14:05". */
const localDateTime = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

/** Log a call or meeting that already happened, credited to the signed-in teammate. */
export function LogActivityDialog({
  kind,
  onClose,
  link,
}: {
  /** Which activity to log; the dialog is closed while this is null. */
  kind: LoggableKind | null
  onClose: () => void
  link: { objectKey: string; recordId: string; title: string }
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const def = kind ? LOGGABLE[kind] : undefined
  const noun = def?.label.toLowerCase() ?? 'activity'

  return (
    <Dialog open={kind !== null} onClose={onClose} title={`Log a ${noun} with ${link.title}`}>
      <form
        // Remount per kind and per opening, so the time defaults to now each time.
        key={kind ?? 'closed'}
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault()

          if (!kind) {
            return
          }

          const data = new FormData(e.currentTarget)
          const when = formText(data, 'occurredAt')
          setBusy(true)
          setError(undefined)

          try {
            await logActivityFn({
              data: {
                objectKey: link.objectKey,
                recordId: link.recordId,
                kind,
                outcome: formText(data, 'outcome') || null,
                occurredAt: when ? new Date(when) : null,
                notes: formText(data, 'notes') || null,
              },
            })

            await router.invalidate()
            onClose()
          } catch (err) {
            setError(err instanceof Error ? err.message : `Could not log the ${noun}`)
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-c-fg2 text-xs font-medium">Outcome</span>
            <select
              name="outcome"
              className={inputClass}
              defaultValue={def?.outcomes[0]?.value ?? ''}
            >
              <option value="">—</option>
              {def?.outcomes.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-c-fg2 text-xs font-medium">When</span>
            <input
              type="datetime-local"
              name="occurredAt"
              defaultValue={localDateTime(new Date())}
              max={localDateTime(new Date(Date.now() + 86_400_000))}
              className={inputClass}
            />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-c-fg2 text-xs font-medium">Notes</span>
          <textarea
            name="notes"
            rows={5}
            placeholder={`What was said in the ${noun}?`}
            className={cx(inputClass, 'h-auto py-2')}
          />
        </label>
        {error && <p className="text-c-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : `Log ${noun}`}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// ── Notes ───────────────────────────────────────────────────────────────────

export type NoteItem = {
  id: string
  title: string
  body: string
  authorName: string | null
  updatedAt: Date | string
  objectKey: string | null
  recordId: string | null
  recordTitle: string | null
}

export function NoteCard({
  note,
  onOpen,
  showRecord = true,
}: {
  note: NoteItem
  onOpen: () => void
  showRecord?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="border-c-line bg-c-raised hover:border-c-line2 flex h-40 flex-col rounded-xl border p-3 text-left"
    >
      <div className="truncate font-semibold">{note.title}</div>
      <p className="text-c-fg2 mt-1 line-clamp-4 flex-1 whitespace-pre-wrap">
        {note.body || 'Empty note'}
      </p>
      <div className="text-c-fg3 mt-2 flex items-center gap-2 text-xs">
        {showRecord && note.recordTitle && (
          <span className="text-c-fg2 flex min-w-0 items-center gap-1.5">
            <Avatar name={note.recordTitle} size="xs" />
            <span className="truncate">{note.recordTitle}</span>
          </span>
        )}
        <span className="ml-auto shrink-0">
          {note.authorName ? `${note.authorName} · ` : ''}
          {relativeTime(note.updatedAt)}
        </span>
      </div>
    </button>
  )
}

/** Write or edit a note. Pass `note` to edit; `link` attaches a new note to a record. */
export function NoteDialog({
  open,
  onClose,
  note,
  link,
}: {
  open: boolean
  onClose: () => void
  note?: NoteItem
  link?: { objectKey: string; recordId: string; title: string }
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const remove = async () => {
    if (!note || !window.confirm('Delete this note?')) {
      return
    }

    await deleteNoteFn({ data: { id: note.id } })
    await router.invalidate()
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={note ? 'Note' : link ? `New note on ${link.title}` : 'New note'}
      width="max-w-2xl"
    >
      <form
        key={note?.id ?? 'new'}
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          setBusy(true)
          setError(undefined)

          try {
            await saveNoteFn({
              data: {
                id: note?.id,
                title: formText(data, 'title'),
                body: formText(data, 'body'),
                objectKey: link?.objectKey,
                recordId: link?.recordId,
              },
            })

            await router.invalidate()
            onClose()
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save the note')
          } finally {
            setBusy(false)
          }
        }}
      >
        <input
          name="title"
          defaultValue={note?.title ?? ''}
          placeholder="Untitled note"
          aria-label="Title"
          className="placeholder:text-c-fg3 w-full bg-transparent text-lg font-semibold outline-none"
        />
        <textarea
          name="body"
          defaultValue={note?.body ?? ''}
          rows={12}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- The note opens in response to a click.
          autoFocus={!note}
          placeholder="Start writing…"
          aria-label="Note"
          className="placeholder:text-c-fg3 w-full resize-none bg-transparent leading-relaxed outline-none"
        />
        {error && <p className="text-c-danger">{error}</p>}
        <div className="border-c-line flex items-center gap-2 border-t pt-3">
          {note && (
            <Button variant="danger" onClick={remove}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save note'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

// ── Email ───────────────────────────────────────────────────────────────────

/**
 * Write a one-to-one email to a record. It goes out from one of the teammate's own
 * mailboxes when one may send (they pick which when there are several), otherwise
 * through the app's email provider, and is kept on the timeline either way.
 */
export function ComposeEmailDialog({
  open,
  onClose,
  objectKey,
  recordId,
  field,
  to,
}: {
  open: boolean
  onClose: () => void
  objectKey: string
  recordId: string
  field: string
  to: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  // The teammate's mailboxes that may send. The From row only shows when there is a choice.
  const [senders, setSenders] = useState<
    { provider: 'google' | 'microsoft'; accountEmail: string }[]
  >([])

  useEffect(() => {
    if (!open) {
      return undefined
    }

    let live = true

    mailboxStatusFn()
      .then((r) => live && setSenders(r.accounts.filter((a) => a.canSend)))
      // Not knowing is fine: the server picks a mailbox, or the shared address.
      .catch(() => live && setSenders([]))

    return () => {
      live = false
    }
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} title="New email" width="max-w-2xl">
      {notice ? (
        <div className="space-y-3">
          <p>{notice}</p>
          <Button
            variant="primary"
            onClick={() => {
              setNotice(undefined)
              onClose()
            }}
          >
            Done
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            const data = new FormData(e.currentTarget)
            setBusy(true)
            setError(undefined)

            try {
              const from = senders.length > 1 ? senders[Number(data.get('from') ?? 0)] : undefined

              const { sent, fallback } = await sendEmailFn({
                data: {
                  objectKey,
                  recordId,
                  field,
                  subject: formText(data, 'subject'),
                  body: formText(data, 'body'),
                  // Left out when there is only one mailbox to send from: the server picks it.
                  from: from && { provider: from.provider, accountEmail: from.accountEmail },
                },
              })

              await router.invalidate()

              if (sent && fallback) {
                setNotice(`Sent from the shared address, not your mailbox. ${fallback}`)
              } else if (sent) {
                onClose()
              } else {
                setNotice(
                  "Email isn't configured (RESEND_API_KEY and EMAIL_FROM), so this was saved to the timeline as a draft and not sent.",
                )
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not send the email')
            } finally {
              setBusy(false)
            }
          }}
        >
          {senders.length > 1 && (
            <div className="border-c-line flex items-center gap-2 border-b pb-2">
              <label htmlFor="email-from" className="text-c-fg3 w-14">
                From
              </label>
              <select
                id="email-from"
                name="from"
                className="min-w-0 flex-1 bg-transparent outline-none"
              >
                {senders.map((s, i) => (
                  <option key={`${s.provider}:${s.accountEmail}`} value={i}>
                    {s.accountEmail}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="border-c-line flex items-center gap-2 border-b pb-2">
            <span className="text-c-fg3 w-14">To</span>
            <span className="bg-c-hov rounded-md px-1.5 py-0.5">{to}</span>
          </div>
          <div className="border-c-line flex items-center gap-2 border-b pb-2">
            <label htmlFor="email-subject" className="text-c-fg3 w-14">
              Subject
            </label>
            <input
              id="email-subject"
              name="subject"
              required
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- The composer opens in response to a click.
              autoFocus
              className="flex-1 bg-transparent outline-none"
            />
          </div>
          <textarea
            name="body"
            required
            rows={10}
            aria-label="Message"
            placeholder="Write your message…"
            className="placeholder:text-c-fg3 w-full resize-none bg-transparent leading-relaxed outline-none"
          />
          {error && <p className="text-c-danger">{error}</p>}
          <div className="border-c-line flex justify-end gap-2 border-t pt-3">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              <Send className="size-3.5" /> {busy ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
