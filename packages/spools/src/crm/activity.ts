/**
 * Logged activities (calls and meetings) and the per-person activity report.
 * Pure and shared by server and client: no Zod, no database.
 */

type Outcome = { value: string; label: string }

/** What a teammate can log on a record by hand, with the outcomes offered for each. */
export const LOGGABLE = {
  call: {
    label: 'Call',
    outcomes: [
      { value: 'connected', label: 'Connected' },
      { value: 'left_voicemail', label: 'Left voicemail' },
      { value: 'left_message', label: 'Left live message' },
      { value: 'no_answer', label: 'No answer' },
      { value: 'busy', label: 'Busy' },
      { value: 'wrong_number', label: 'Wrong number' },
    ],
  },
  meeting: {
    label: 'Meeting',
    outcomes: [
      { value: 'completed', label: 'Completed' },
      { value: 'rescheduled', label: 'Rescheduled' },
      { value: 'no_show', label: 'No show' },
      { value: 'canceled', label: 'Canceled' },
    ],
  },
} as const satisfies Record<string, { label: string; outcomes: readonly Outcome[] }>

export type LoggableKind = keyof typeof LOGGABLE

const isLoggableKind = (key: string): key is LoggableKind => Object.hasOwn(LOGGABLE, key)
export const loggableKinds = Object.keys(LOGGABLE).filter(isLoggableKind)

export const outcomeLabel = (
  kind: LoggableKind,
  outcome: string | null | undefined,
): string | undefined => LOGGABLE[kind].outcomes.find((o) => o.value === outcome)?.label

/** The timeline fragment for a logged activity: "logged a call: Connected". */
export function logSummary(kind: LoggableKind, outcome?: string | null): string {
  const label = outcomeLabel(kind, outcome)
  return `logged a ${LOGGABLE[kind].label.toLowerCase()}${label ? `: ${label}` : ''}`
}

// ── Date ranges ─────────────────────────────────────────────────────────────

export const RANGE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'thisWeek', label: 'This week' },
  { id: 'lastWeek', label: 'Last week' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'last90', label: 'Last 90 days' },
  { id: 'thisYear', label: 'This year' },
] as const

export type RangePreset = (typeof RANGE_PRESETS)[number]['id']
/** `from` is inclusive, `to` is exclusive. */
export type DateRange = { from: Date; to: Date }

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** A preset as dates in the local time zone. Weeks start on Monday. */
export function presetRange(preset: RangePreset, now = new Date()): DateRange {
  const today = startOfDay(now)
  const tomorrow = addDays(today, 1)
  const monday = addDays(today, -((today.getDay() + 6) % 7))

  switch (preset) {
    case 'today':
      return { from: today, to: tomorrow }
    case 'thisWeek':
      return { from: monday, to: tomorrow }
    case 'lastWeek':
      return { from: addDays(monday, -7), to: monday }
    case 'thisMonth':
      return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: tomorrow }
    case 'lastMonth':
      return {
        from: new Date(today.getFullYear(), today.getMonth() - 1, 1),
        to: new Date(today.getFullYear(), today.getMonth(), 1),
      }
    case 'last30':
      return { from: addDays(today, -29), to: tomorrow }
    case 'last90':
      return { from: addDays(today, -89), to: tomorrow }
    case 'thisYear':
      return { from: new Date(today.getFullYear(), 0, 1), to: tomorrow }

    default: {
      const unknown: never = preset
      throw new Error(`There is no date range preset "${String(unknown)}"`)
    }
  }
}

/** A YYYY-MM-DD date as the start of that day in the local time zone, or null when it isn't one. */
const localDay = (s: string | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '')
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/** A custom range from two YYYY-MM-DD dates, both inclusive. Null when either is missing or out of order. */
export function customRange(from: string | undefined, to: string | undefined): DateRange | null {
  const start = localDay(from)
  const end = localDay(to)

  if (!start || !end || end < start) {
    return null
  }

  return { from: start, to: addDays(end, 1) }
}

// ── Per-person report ───────────────────────────────────────────────────────

export type ReportActivity = {
  kind: string
  actorId: string | null
  actor: string | null
  outcome: string | null
  summary: string
}
export type ReportTask = { completedBy: string | null; assigneeId: string | null }
export type ReportNote = { authorId: string | null; authorName: string | null }

export type PersonActivity = {
  /** A user id, or `name:<label>` for activity that can't be tied to a teammate. */
  id: string
  name: string
  calls: number
  /** Calls with the outcome "Connected". */
  callsConnected: number
  emails: number
  meetings: number
  tasksCompleted: number
  notes: number
  total: number
}

/**
 * Emails that aren't something the teammate sent: ones that never left because
 * email wasn't configured, and ones they received (synced from their mailbox).
 */
const unsent = (a: ReportActivity) =>
  a.outcome === 'not_sent' ||
  a.outcome === 'received' ||
  a.summary.startsWith('drafted an email (') ||
  a.summary.startsWith('logged (email not configured)')

/** A person's row before anything is counted. */
const emptyRow = (id: string, name: string): PersonActivity => ({
  id,
  name,
  calls: 0,
  callsConnected: 0,
  emails: 0,
  meetings: 0,
  tasksCompleted: 0,
  notes: 0,
  total: 0,
})

/**
 * Count calls, emails, meetings, completed tasks and notes per person.
 *
 * Everyone in `users` gets a row, even with nothing logged, so a quiet week is
 * visible. Activity recorded before activities carried a user id is matched to
 * a teammate by name; anything that still can't be matched (an email sequence,
 * someone who has left) is listed under the name it was recorded with.
 */
export function summariseActivity(input: {
  users: { id: string; name: string }[]
  activities: ReportActivity[]
  tasks: ReportTask[]
  notes: ReportNote[]
}): PersonActivity[] {
  const rows = new Map<string, PersonActivity>()

  for (const u of input.users) {
    rows.set(u.id, emptyRow(u.id, u.name))
  }

  const byName = new Map<string, string | null>()

  for (const u of input.users) {
    byName.set(u.name, byName.has(u.name) ? null : u.id)
  } // null: ambiguous name

  const person = (id: string | null, name: string | null): PersonActivity | null => {
    const key = id ?? (name ? (byName.get(name) ?? `name:${name}`) : null)

    if (!key) {
      return null
    }

    let row = rows.get(key)

    if (!row) {
      row = emptyRow(key, name ?? 'Former teammate')
      rows.set(key, row)
    }

    return row
  }

  for (const a of input.activities) {
    const row = person(a.actorId, a.actor)

    if (!row) {
      continue
    }

    if (a.kind === 'call') {
      row.calls++

      if (a.outcome === 'connected') {
        row.callsConnected++
      }
    } else if (a.kind === 'meeting') {
      row.meetings++
    } else if (a.kind === 'email' && !unsent(a)) {
      row.emails++
    }
  }

  for (const t of input.tasks) {
    const row = person(
      t.completedBy ?? t.assigneeId,
      t.completedBy || t.assigneeId ? null : 'Unassigned',
    )

    if (row) {
      row.tasksCompleted++
    }
  }

  for (const n of input.notes) {
    const row = person(n.authorId, n.authorName)

    if (row) {
      row.notes++
    }
  }

  const team = new Set(input.users.map((u) => u.id))
  return [...rows.values()]
    .map((r) => ({ ...r, total: r.calls + r.emails + r.meetings + r.tasksCompleted + r.notes }))
    .toSorted(
      (a, b) =>
        Number(team.has(b.id)) - Number(team.has(a.id)) ||
        b.total - a.total ||
        a.name.localeCompare(b.name),
    )
}

export const ACTIVITY_COLUMNS = [
  { key: 'calls', label: 'Calls' },
  { key: 'emails', label: 'Emails' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'tasksCompleted', label: 'Tasks completed' },
  { key: 'notes', label: 'Notes' },
  { key: 'total', label: 'Total' },
] as const satisfies readonly { key: keyof PersonActivity; label: string }[]

/** Column totals across every row. */
export function activityTotals(rows: PersonActivity[]): PersonActivity {
  const sum = (key: Exclude<keyof PersonActivity, 'id' | 'name'>) =>
    rows.reduce((n, r) => n + r[key], 0)

  return {
    id: 'total',
    name: 'Total',
    calls: sum('calls'),
    callsConnected: sum('callsConnected'),
    emails: sum('emails'),
    meetings: sum('meetings'),
    tasksCompleted: sum('tasksCompleted'),
    notes: sum('notes'),
    total: sum('total'),
  }
}

/** The report as a table of cells for CSV: a header, one row per person, then totals. */
export function activityTable(rows: PersonActivity[]): (string | number)[][] {
  const line = (r: PersonActivity) => [
    r.name,
    r.calls,
    r.callsConnected,
    r.emails,
    r.meetings,
    r.tasksCompleted,
    r.notes,
    r.total,
  ]

  return [
    [
      'Person',
      'Calls',
      'Calls connected',
      'Emails',
      'Meetings',
      'Tasks completed',
      'Notes',
      'Total',
    ],
    ...rows.map(line),
    line(activityTotals(rows)),
  ]
}
