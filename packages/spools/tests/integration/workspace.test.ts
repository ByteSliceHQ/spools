import { afterAll, beforeAll, expect } from 'bun:test'

import * as records from '../../src/server/records'
import { Favorite, Note, SavedView, Task } from '../../src/server/store/tables'
import { runTool } from '../../src/server/tools'
import * as views from '../../src/server/views'
import * as workspace from '../../src/server/workspace'
import { db, run as go } from '../../src/testing/run'
import { exampleTest, isExampleApp } from './example-app'

// Saved views, tasks, notes, favourites, reports and CSV export against a real database.
const tag = `ws${Date.now()}`
const userId = `user_${tag}`
let companyId = ''
const dealIds: string[] = []

beforeAll(async () => {
  if (!isExampleApp) {
    return
  }

  companyId = (await go(records.createRecord('companies', { name: `Co ${tag}` }, userId))).id

  for (const [title, value, stage] of [
    [`=SUM(A1) ${tag}`, '100.50', 'won'],
    [`Second, deal ${tag}`, '200', 'won'],
    [`Third ${tag}`, null, 'lost'],
  ] as const) {
    dealIds.push(
      (await go(records.createRecord('deals', { title, value, stage, companyId }, userId))).id,
    )
  }
})

afterAll(async () => {
  if (!isExampleApp) {
    return
  }

  for (const id of dealIds) {
    await go(records.deleteRecord('deals', id))
  }

  await go(records.deleteRecord('companies', companyId))
  await db.remove(SavedView, { where: { createdBy: userId } })
  await db.remove(Task, { where: { createdBy: userId } })
  await db.remove(Note, { where: { objectKey: 'deals', recordId: dealIds[0]! } })
  await db.remove(Favorite, { where: { userId } })
})

exampleTest('config views resolve, can be customised, and reset to the config', async () => {
  const before = (await go(views.resolveViews('contacts'))).find((v) => v.id === 'all')!
  expect(before.source).toBe('config')
  expect(before.settings.columns).toEqual(['name', 'email', 'company', 'status', 'createdAt'])

  await go(
    views.saveView(
      'contacts',
      'all',
      {
        columns: ['name', 'status', 'noSuchField'],
        // The older form, a map of exact values, is still read: views saved before filters had operators hold it.
        filters: { status: 'lead', email: 'x@example.com', nope: '1' } as never,
        calculations: { status: 'filled', nope: 'sum' },
      },
      userId,
    ),
  )

  const after = (await go(views.resolveViews('contacts'))).find((v) => v.id === 'all')!
  expect(after.customised).toBe(true)
  expect(after.settings.columns).toEqual(['name', 'status']) // unknown columns dropped
  // Unknown fields are dropped, and so is "email is one of": a text field has no such operator.
  expect(after.settings.filters).toEqual([[{ field: 'status', op: 'in', value: ['lead'] }]])
  expect(after.settings.calculations).toEqual({ status: 'filled' })

  await go(views.deleteView('contacts', 'all', userId))
  const reset = (await go(views.resolveViews('contacts'))).find((v) => v.id === 'all')!
  expect(reset.customised).toBe(false)
  expect(reset.settings.columns).toEqual(before.settings.columns)
})

exampleTest('a new view copies another, and deleting it leaves config views alone', async () => {
  const id = await go(
    views.createView('deals', { label: `Won ${tag}`, type: 'table', copyFrom: 'all' }, userId),
  )

  const won = [[{ field: 'stage', op: 'in' as const, value: ['won'] }]]
  await go(views.saveView('deals', id, { filters: won, label: `Won deals ${tag}` }, userId))
  const view = (await go(views.resolveViews('deals'))).find((v) => v.id === id)!
  expect(view).toMatchObject({ source: 'saved', label: `Won deals ${tag}`, type: 'table' })
  expect(view.settings.columns).toEqual(['title', 'value', 'stage', 'company', 'closeDate'])
  expect(view.settings.filters).toEqual(won)

  await expect(go(views.saveView('deals', 'no-such-view', {}, userId))).rejects.toThrow(
    'View not found',
  )

  await go(views.deleteView('deals', id, userId))
  const ids = (await go(views.resolveViews('deals'))).map((v) => v.id)
  expect(ids).toEqual(['pipeline', 'all'])
})

exampleTest('calculations run over every record the view matches', async () => {
  const out = await go(
    views.calculate(
      'deals',
      { q: tag },
      { value: 'sum', title: 'filled', closeDate: 'empty', stage: 'avg' },
    ),
  )

  expect(out).toEqual({ value: 300.5, title: 3, closeDate: 3, stage: null })

  const won = await go(
    views.calculate(
      'deals',
      { q: tag, filters: [[{ field: 'stage', op: 'in', value: ['won'] }]] },
      { value: 'max' },
    ),
  )

  expect(won).toEqual({ value: 200 })
})

exampleTest('tasks link to records, complete, and count as due', async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

  const task = await go(
    workspace.createTask(
      { title: `Call ${tag}`, dueDate: yesterday, objectKey: 'deals', recordId: dealIds[1]! },
      userId,
    ),
  )

  await go(workspace.createTask({ title: `Someday ${tag}` }, userId))

  const mine = await go(workspace.listTasks({ assigneeId: userId }))
  expect(mine.length).toBe(2)
  expect(mine.find((t) => t.id === task.id)?.recordTitle).toBe(`Second, deal ${tag}`)

  expect(
    (await go(workspace.listTasks({ objectKey: 'deals', recordId: dealIds[1]! }))).length,
  ).toBe(1)

  expect(await go(workspace.dueTaskCount(userId))).toBe(1)

  await go(workspace.updateTask(task.id, { completed: true }))
  expect(await go(workspace.dueTaskCount(userId))).toBe(0)
  await go(workspace.updateTask(task.id, { completed: false }))
  expect(await go(workspace.dueTaskCount(userId))).toBe(1)
  await go(workspace.deleteTask(task.id))
  expect((await go(workspace.listTasks({ assigneeId: userId }))).length).toBe(1)
})

exampleTest('logged calls and meetings feed the per-person activity report', async () => {
  const user = { id: userId, name: `Tester ${tag}` }
  const hour = 3_600_000
  const now = Date.now()
  const lastHour = { from: new Date(now - hour), to: new Date(now + hour) }

  await go(
    workspace.logActivity(
      {
        objectKey: 'deals',
        recordId: dealIds[0]!,
        kind: 'call',
        outcome: 'connected',
        notes: '  Talked pricing  ',
      },
      user,
    ),
  )

  // A meeting from ten days ago, entered today: it belongs to the day it took place.
  await go(
    workspace.logActivity(
      {
        objectKey: 'deals',
        recordId: dealIds[0]!,
        kind: 'meeting',
        occurredAt: new Date(now - 240 * hour),
      },
      user,
    ),
  )

  const timeline = await go(records.listActivities('deals', dealIds[0]!))
  const call = timeline.find((a) => a.kind === 'call')

  expect(call).toMatchObject({
    summary: 'logged a call: Connected',
    body: 'Talked pricing',
    actorId: userId,
  })

  expect(timeline.find((a) => a.kind === 'meeting')?.summary).toBe('logged a meeting')

  // Someone else's task, completed by this user, is this user's completed task.
  const task = await go(workspace.createTask({ title: `Report ${tag}` }, `other_${tag}`))
  await go(workspace.updateTask(task.id, { completed: true }, userId))

  const recent = await go(workspace.activityReport(lastHour, [user]))
  expect(recent.truncated).toBe(false)

  expect(recent.rows.find((r) => r.id === userId)).toMatchObject({
    name: `Tester ${tag}`,
    calls: 1,
    callsConnected: 1,
    meetings: 0,
    tasksCompleted: 1,
  })

  const twoWeeks = await go(
    workspace.activityReport({ from: new Date(now - 336 * hour), to: lastHour.to }, [user]),
  )

  expect(twoWeeks.rows.find((r) => r.id === userId)?.meetings).toBe(1)

  // Reopening the task takes it back out of the report.
  await go(workspace.updateTask(task.id, { completed: false }, userId))
  const reopened = await go(workspace.activityReport(lastHour, [user]))
  expect(reopened.rows.find((r) => r.id === userId)?.tasksCompleted).toBe(0)
  await go(workspace.deleteTask(task.id))

  const csv = workspace.activityReportCsv(recent).split('\n')
  expect(csv[0]).toBe('Person,Calls,Calls connected,Emails,Meetings,Tasks completed,Notes,Total')
  expect(csv.some((line) => line.startsWith(`Tester ${tag},1,1,`))).toBe(true)
  expect(csv.at(-1)?.startsWith('Total,')).toBe(true)
})

exampleTest(
  "notes belong to a record and the assistant's add_note writes a real note",
  async () => {
    const note = await go(
      workspace.createNote(
        { title: '', body: 'First call went well', objectKey: 'deals', recordId: dealIds[0]! },
        { id: userId, name: 'Test User' },
      ),
    )

    expect(note.title).toBe('Untitled note')
    await go(workspace.updateNote(note.id, { title: 'First call' }))

    const res = await go(
      runTool('add_note', { objectKey: 'deals', id: dealIds[0]!, body: 'Summary of the thread' }),
    )

    expect(res.ok).toBe(true)

    const notes = await go(workspace.listNotes({ objectKey: 'deals', recordId: dealIds[0]! }))
    expect(notes.map((n) => n.title).sort()).toEqual(['First call', 'Note from the assistant'])
    expect(notes.find((n) => n.title === 'Note from the assistant')?.authorName).toBe('Assistant')
    const timeline = await go(records.listActivities('deals', dealIds[0]!))
    expect(timeline.map((a) => a.summary)).toContain('added a note: Note from the assistant')

    await go(workspace.deleteNote(note.id))

    expect(
      (await go(workspace.listNotes({ objectKey: 'deals', recordId: dealIds[0]! }))).length,
    ).toBe(1)
  },
)

exampleTest('favourites toggle per user and skip deleted records', async () => {
  expect(await go(workspace.toggleFavorite(userId, 'deals', dealIds[1]!))).toBe(true)

  expect(
    await go(workspace.toggleFavorite(userId, 'deals', '00000000-0000-4000-8000-000000000000')),
  ).toBe(true)

  expect(await go(workspace.listFavorites(userId))).toEqual([
    { objectKey: 'deals', recordId: dealIds[1]!, title: `Second, deal ${tag}` },
  ])

  expect(await go(workspace.listFavorites('someone-else'))).toEqual([])
  expect(await go(workspace.isFavorite(userId, 'deals', dealIds[1]!))).toBe(true)
  expect(await go(workspace.isFavorite('someone-else', 'deals', dealIds[1]!))).toBe(false)
  expect(await go(workspace.toggleFavorite(userId, 'deals', dealIds[1]!))).toBe(false)
  expect(await go(workspace.isFavorite(userId, 'deals', dealIds[1]!))).toBe(false)
  expect(await go(workspace.listFavorites(userId))).toEqual([])
})

exampleTest(
  'titles are looked up across objects in one pass, skipping what no longer exists',
  async () => {
    const titles = await go(
      workspace.recordTitles([
        { objectKey: 'deals', recordId: dealIds[0]! },
        { objectKey: 'deals', recordId: dealIds[1]! },
        { objectKey: 'deals', recordId: dealIds[1]! },
        { objectKey: 'companies', recordId: companyId },
        { objectKey: 'deals', recordId: '00000000-0000-4000-8000-000000000000' },
        { objectKey: 'not-an-object', recordId: companyId },
        { objectKey: null, recordId: null },
      ]),
    )

    expect(titles).toEqual({
      [`deals:${dealIds[0]}`]: `=SUM(A1) ${tag}`,
      [`deals:${dealIds[1]}`]: `Second, deal ${tag}`,
      [`companies:${companyId}`]: `Co ${tag}`,
    })
  },
)

exampleTest(
  "reports break every select field down and sum the object's currency field",
  async () => {
    const { breakdowns, created } = await go(workspace.buildReports())
    const byStage = breakdowns.find((b) => b.objectKey === 'deals' && b.field === 'stage')!
    expect(byStage.valueField).toBe('value')
    const won = byStage.rows.find((r) => r.value === 'won')!
    expect(won.count).toBeGreaterThanOrEqual(2)
    expect(won.total).toBeGreaterThanOrEqual(300.5)

    const deals = created.find((c) => c.objectKey === 'deals')!
    expect(deals.weeks.length).toBe(12)
    expect(deals.weeks.at(-1)!.count).toBeGreaterThanOrEqual(3) // this week
  },
)

exampleTest('CSV export quotes separators, names relations and defuses formulas', async () => {
  const csv = await go(
    workspace.exportCsv('deals', {
      q: tag,
      filters: [[{ field: 'stage', op: 'in', value: ['won'] }]],
    }),
  )

  const [header, ...lines] = csv.split('\n')
  expect(header).toBe('id,title,value,stage,company,contact,closeDate,owner')
  expect(lines.length).toBe(2)
  expect(csv).toContain(`"Second, deal ${tag}",200.00,won,Co ${tag}`)
  expect(csv).toContain(`'=SUM(A1) ${tag},100.50,won`) // a leading = would run as a formula in a spreadsheet
})
