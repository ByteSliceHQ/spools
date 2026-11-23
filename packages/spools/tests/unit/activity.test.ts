import { describe, expect, test } from 'bun:test'

import {
  activityTable,
  activityTotals,
  customRange,
  logSummary,
  presetRange,
  summariseActivity,
} from '../../src/crm/activity'

const users = [
  { id: 'u_ada', name: 'Ada Lopez' },
  { id: 'u_ben', name: 'Ben Ortiz' },
]

const activity = (
  kind: string,
  actorId: string | null,
  extra: { actor?: string | null; outcome?: string | null; summary?: string } = {},
) => ({
  kind,
  actorId,
  actor: extra.actor ?? null,
  outcome: extra.outcome ?? null,
  summary: extra.summary ?? '',
})

describe('logged activity summaries', () => {
  test("read as a fragment after the teammate's name", () => {
    expect(logSummary('call', 'left_voicemail')).toBe('logged a call: Left voicemail')
    expect(logSummary('meeting', 'completed')).toBe('logged a meeting: Completed')
    expect(logSummary('call')).toBe('logged a call')
    expect(logSummary('call', 'made_up')).toBe('logged a call')
  })
})

describe('date ranges', () => {
  // Wednesday 18 November 2026, mid-afternoon.
  const now = new Date(2026, 10, 18, 15, 30)
  const days = (r: { from: Date; to: Date }) => [r.from.toDateString(), r.to.toDateString()]

  test('presets end tomorrow at midnight so today is included', () => {
    expect(days(presetRange('today', now))).toEqual(['Wed Nov 18 2026', 'Thu Nov 19 2026'])
    expect(days(presetRange('thisMonth', now))).toEqual(['Sun Nov 01 2026', 'Thu Nov 19 2026'])
    expect(days(presetRange('last30', now))).toEqual(['Tue Oct 20 2026', 'Thu Nov 19 2026'])
    expect(days(presetRange('thisYear', now))).toEqual(['Thu Jan 01 2026', 'Thu Nov 19 2026'])
  })

  test('weeks start on Monday, including when today is Sunday', () => {
    expect(days(presetRange('thisWeek', now))).toEqual(['Mon Nov 16 2026', 'Thu Nov 19 2026'])
    expect(days(presetRange('lastWeek', now))).toEqual(['Mon Nov 09 2026', 'Mon Nov 16 2026'])

    expect(days(presetRange('thisWeek', new Date(2026, 10, 22)))).toEqual([
      'Mon Nov 16 2026',
      'Mon Nov 23 2026',
    ])
  })

  test('last month handles January', () => {
    expect(days(presetRange('lastMonth', new Date(2027, 0, 10)))).toEqual([
      'Tue Dec 01 2026',
      'Fri Jan 01 2027',
    ])
  })

  test('a custom range includes both of its days', () => {
    expect(days(customRange('2026-11-02', '2026-11-06')!)).toEqual([
      'Mon Nov 02 2026',
      'Sat Nov 07 2026',
    ])

    expect(days(customRange('2026-11-02', '2026-11-02')!)).toEqual([
      'Mon Nov 02 2026',
      'Tue Nov 03 2026',
    ])
  })

  test('a custom range that is incomplete or backwards is refused', () => {
    expect(customRange('2026-11-06', '2026-11-02')).toBeNull()
    expect(customRange(undefined, '2026-11-02')).toBeNull()
    expect(customRange('nope', '2026-11-02')).toBeNull()
  })
})

describe('summariseActivity', () => {
  test('counts each kind per person and totals them', () => {
    const rows = summariseActivity({
      users,
      activities: [
        activity('call', 'u_ada', { outcome: 'connected' }),
        activity('call', 'u_ada', { outcome: 'no_answer' }),
        activity('meeting', 'u_ada'),
        activity('email', 'u_ben', { outcome: 'sent' }),
      ],
      tasks: [{ completedBy: 'u_ben', assigneeId: 'u_ada' }],
      notes: [{ authorId: 'u_ada', authorName: 'Ada Lopez' }],
    })

    expect(rows).toEqual([
      {
        id: 'u_ada',
        name: 'Ada Lopez',
        calls: 2,
        callsConnected: 1,
        emails: 0,
        meetings: 1,
        tasksCompleted: 0,
        notes: 1,
        total: 4,
      },
      {
        id: 'u_ben',
        name: 'Ben Ortiz',
        calls: 0,
        callsConnected: 0,
        emails: 1,
        meetings: 0,
        tasksCompleted: 1,
        notes: 0,
        total: 2,
      },
    ])
  })

  test('teammates with nothing logged still get a row', () => {
    const rows = summariseActivity({ users, activities: [], tasks: [], notes: [] })

    expect(rows.map((r) => [r.name, r.total])).toEqual([
      ['Ada Lopez', 0],
      ['Ben Ortiz', 0],
    ])
  })

  test('a completed task is credited to whoever completed it, then to its assignee', () => {
    const rows = summariseActivity({
      users,
      activities: [],
      tasks: [
        { completedBy: 'u_ben', assigneeId: 'u_ada' },
        { completedBy: null, assigneeId: 'u_ada' },
        { completedBy: null, assigneeId: null },
      ],
      notes: [],
    })

    expect(rows.map((r) => [r.name, r.tasksCompleted])).toEqual([
      ['Ada Lopez', 1],
      ['Ben Ortiz', 1],
      ['Unassigned', 1],
    ])
  })

  test("emails that were never sent don't count", () => {
    const rows = summariseActivity({
      users,
      activities: [
        activity('email', 'u_ada', { outcome: 'sent' }),
        activity('email', 'u_ada', { outcome: 'not_sent' }),
        activity('email', 'u_ada', { outcome: 'received' }),
        activity('email', null, {
          actor: 'Ada Lopez',
          summary: 'drafted an email (email is not configured, so it was not sent): Hi',
        }),
        activity('email', null, { actor: 'Ada Lopez', summary: 'sent an email: Hi' }),
      ],
      tasks: [],
      notes: [],
    })

    expect(rows[0]).toMatchObject({ name: 'Ada Lopez', emails: 2 })
  })

  test('activity from before user ids were stored is matched by name; the rest keeps its own row', () => {
    const rows = summariseActivity({
      users,
      activities: [
        activity('email', null, { actor: 'Ben Ortiz', summary: 'sent an email: Quote' }),
        activity('email', null, {
          actor: 'Sequence',
          summary: 'sent "Welcome" from Onboarding',
          outcome: 'sent',
        }),
        activity('call', 'u_gone', { actor: 'Cy Young' }),
        activity('email', null),
      ],
      tasks: [],
      notes: [],
    })

    expect(rows.map((r) => [r.id, r.name, r.total])).toEqual([
      ['u_ben', 'Ben Ortiz', 1],
      ['u_ada', 'Ada Lopez', 0],
      ['u_gone', 'Cy Young', 1],
      ['name:Sequence', 'Sequence', 1],
    ])
  })

  test('two teammates with the same name are never merged by name', () => {
    const twins = [
      { id: 'u_1', name: 'Sam Lee' },
      { id: 'u_2', name: 'Sam Lee' },
    ]

    const rows = summariseActivity({
      users: twins,
      activities: [activity('call', null, { actor: 'Sam Lee' })],
      tasks: [],
      notes: [],
    })

    expect(rows.find((r) => r.id === 'name:Sam Lee')?.calls).toBe(1)
    expect(rows.filter((r) => r.id.startsWith('u_')).every((r) => r.total === 0)).toBe(true)
  })
})

describe('report table', () => {
  const rows = summariseActivity({
    users,
    activities: [activity('call', 'u_ada', { outcome: 'connected' }), activity('meeting', 'u_ben')],
    tasks: [],
    notes: [],
  })

  test('totals every column', () => {
    expect(activityTotals(rows)).toMatchObject({
      calls: 1,
      callsConnected: 1,
      meetings: 1,
      total: 2,
    })
  })

  test('has a header, a line per person and a totals line', () => {
    expect(activityTable(rows)).toEqual([
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
      ['Ada Lopez', 1, 1, 0, 0, 0, 0, 1],
      ['Ben Ortiz', 0, 0, 0, 1, 0, 0, 1],
      ['Total', 1, 1, 0, 1, 0, 0, 2],
    ])
  })
})
