import { expect, test } from 'bun:test'

import type { Filters } from '../../src/crm/filters'
import * as records from '../../src/server/records'
import { backfillScopes } from '../../src/server/scope-backfill'
import * as service from '../../src/server/service'
import { Store } from '../../src/server/store/store'
import { Activity, Favorite, Note, Task } from '../../src/server/store/tables'
import * as views from '../../src/server/views'
import * as workspace from '../../src/server/workspace'
import {
  as,
  column,
  ids,
  northIn,
  pending,
  people,
  scopedWorld,
  southIn,
  sys,
} from './scopes-world'

// Record scopes in what sits beside records (src/server/views.ts and
// workspace.ts). None of it goes through service.ts, and most of it reaches the
// store directly, which is why the scope is kept in the store.

scopedWorld()

const { nora, sam, bo } = people

const southContact = () => ({ objectKey: 'contacts', recordId: ids.south.contact })

const sweep = async (objectKey: string, q: string) => {
  for (const row of await sys(records.listRecords({ objectKey, q, limit: 500 }))) {
    await sys(records.deleteRecord(objectKey, row.id))
  }
}

test('CSV export holds the scope, and no title of a related record outside it', async () => {
  const csv = await as('nora', workspace.exportCsv('contacts', {}))
  expect(csv).toContain('Nina Alder')
  // Nell's company is a South one: its cell is empty, not "Birch Supply".
  expect(csv).toContain('Nell Crossing')
  expect(southIn(csv)).toEqual([])

  const deals = await as('sam', workspace.exportCsv('deals', {}))
  expect(deals).toContain('Birch rebate')
  // The rebate is on a North contact.
  expect(northIn(deals)).toEqual([])
})

test('CSV import: rows take the active scope, and a row for another scope is refused', async () => {
  try {
    const result = await as(
      'nora',
      service.importRecords(
        'contacts',
        [
          { name: 'Alder import one' },
          // A scope column in the file.
          { name: 'Alder import two', branch: 'south' },
          // A relation cell that was matched to a South company.
          { name: 'Alder import three', companyId: ids.south.company },
        ],
        nora,
      ),
    )

    expect(result.created).toBe(1)
    expect(result.failed).toBe(2)
    expect(result.errors.map((e) => e.row)).toEqual([3, 4])

    const made = await sys(records.listRecords({ objectKey: 'contacts', q: 'Alder import' }))
    expect(made.map((r) => [r.name, r.branch])).toEqual([['Alder import one', 'north']])
  } finally {
    await sweep('contacts', 'Alder import')
  }
})

test('reports break down the scope alone', async () => {
  const stages = async (who: 'nora' | 'hana', wanted?: null) => {
    const { breakdowns } = await as(who, workspace.buildReports(), wanted)
    const stage = breakdowns.find((b) => b.objectKey === 'deals' && b.field === 'stage')
    return Object.fromEntries((stage?.rows ?? []).map((r) => [r.value, [r.count, r.total]]))
  }

  expect(await stages('hana', null)).toEqual({ open: [1, 1000], won: [2, 14_999], lost: [0, 0] })
  expect(await stages('nora')).toEqual({ open: [1, 1000], won: [0, 0], lost: [0, 0] })

  const { created } = await as('nora', workspace.buildReports())
  const weeks = created.find((c) => c.objectKey === 'contacts')?.weeks ?? []
  expect(weeks.reduce((sum, w) => sum + w.count, 0)).toBe(2)
})

test('the team activity report counts the scope alone', async () => {
  const hour = 3_600_000
  const range = { from: new Date(Date.now() - hour), to: new Date(Date.now() + hour) }
  const team = [nora, sam]

  const report = await as('nora', workspace.activityReport(range, team))
  const row = (id: string) => report.rows.find((r) => r.id === id)
  expect(row(nora.id)).toMatchObject({ calls: 1, notes: 1 })
  // Sam's call and note are on a South record.
  expect(row(sam.id)).toMatchObject({ calls: 0, notes: 0, total: 0 })
})

test('boards and footer calculations read the scope alone', async () => {
  // A board asks for the card's fields only, and a related record by its title.
  const board = { objectKey: 'deals', fields: ['value', 'contact'], relations: 'titles' as const }
  const north = await as('nora', records.listRecords({ ...board, limit: 500 }))
  expect(north.map((r) => r.value)).toEqual(['1000.00'])

  const south = await as('sam', records.listRecords({ ...board, limit: 500 }))
  expect(south.map((r) => r.value).toSorted()).toEqual(['5000.00', '9999.00'])
  // The rebate's card must not name the North contact it is on.
  expect(northIn(south)).toEqual([])

  const sum = { value: 'sum' as const }
  expect(await as('nora', views.calculate('deals', {}, sum))).toEqual({ value: 1000 })
  expect(await as('sam', views.calculate('deals', {}, sum))).toEqual({ value: 14_999 })
  expect(await as('hana', views.calculate('deals', {}, sum), null)).toEqual({ value: 15_999 })
})

test('a saved view shared by another scope gives away no titles', async () => {
  const filters: Filters = [[{ field: 'company', op: 'in', value: [ids.south.company] }]]

  const viewId = await as(
    'sam',
    views.createView(
      'contacts',
      { label: 'Key accounts', type: 'table', settings: { filters } },
      sam.id,
    ),
  )

  try {
    // Views are shared by everyone who uses the object, so Nora has this one.
    const shared = (await as('nora', views.resolveViews('contacts', nora.id))).find(
      (v) => v.id === viewId,
    )

    expect(shared?.label).toBe('Key accounts')

    // The list page looks up the titles of the records a view's filters name, for its chips.
    const named = (shared?.settings.filters ?? []).flat().flatMap((c) => c.value ?? [])
    expect(named).toEqual([ids.south.company])

    expect([...(await as('nora', records.recordTitlesOf('companies', named.map(String))))]).toEqual(
      [],
    )

    // And the picker in the chip's editor offers none of them.
    expect((await as('nora', records.searchTitles('companies', 'Birch'))).options).toEqual([])
  } finally {
    await sys(views.deleteView('contacts', viewId, sam.id))
  }
})

test('favourites: only those of the scope are listed, and none is made outside it', async () => {
  const mine = workspace.listFavorites(bo.id)
  expect(column(await as('bo', mine, 'north'), 'title')).toEqual(['Nina Alder'])
  expect(column(await as('bo', mine, 'south'), 'title')).toEqual(['Sofia Birch'])
  expect(await as('bo', mine, null)).toHaveLength(2)

  const starred = { userId: nora.id, objectKey: 'contacts', recordId: ids.south.contact }

  try {
    // A favourite left from before scopes were turned on.
    await sys(Store.use((store) => store.insert(Favorite, starred)))
    expect(await as('nora', workspace.listFavorites(nora.id))).toEqual([])

    expect(await as('nora', workspace.isFavorite(nora.id, 'contacts', ids.south.contact))).toBe(
      false,
    )

    await sys(Store.use((store) => store.remove(Favorite, { where: starred })))

    // Starring a record that is not there for her.
    await expect(
      as('nora', workspace.toggleFavorite(nora.id, 'contacts', ids.south.contact)),
    ).rejects.toThrow()

    expect(await sys(Store.use((store) => store.count(Favorite, { where: starred })))).toBe(0)
  } finally {
    await sys(Store.use((store) => store.remove(Favorite, { where: starred })))
  }
})

test('tasks: listed, counted, changed and deleted within the scope only', async () => {
  expect(column(await as('nora', workspace.listTasks()), 'title')).toEqual([
    'Ring Alder',
    'Visit Alder',
  ])

  expect(await as('nora', workspace.listTasks(southContact()))).toEqual([])

  // What Bo is due depends on where Bo is working.
  const due = workspace.dueTaskCount(bo.id)
  expect(await as('bo', due, 'north')).toBe(1)
  expect(await as('bo', due, null)).toBe(2)

  expect(
    column(await as('bo', workspace.listTasks({ assigneeId: bo.id }), 'south'), 'title'),
  ).toEqual(['Visit Birch'])

  const [theirs] = await sys(
    Store.use((store) => store.find(Task, { where: { title: 'Ring Birch' } })),
  )

  const id = theirs?.id ?? ''

  try {
    expect(await as('nora', workspace.updateTask(id, { completed: true }, nora.id))).toBeNull()
    await as('nora', workspace.deleteTask(id))
    const kept = await sys(Store.use((store) => store.first(Task, { where: { id } })))
    expect(kept?.title).toBe('Ring Birch')
    expect(kept?.completedAt).toBeNull()

    // A task on a record of another scope can't be made.
    await expect(
      as('nora', workspace.createTask({ title: 'Alder plant', ...southContact() }, nora.id)),
    ).rejects.toThrow()

    // A task on no record belongs to the scope it was made in.
    await as('nora', workspace.createTask({ title: 'Alder errand' }, nora.id))

    expect(column(await as('sam', workspace.listTasks()), 'title')).toEqual([
      'Ring Birch',
      'Visit Birch',
    ])
  } finally {
    await sys(Store.use((store) => store.update(Task, { where: { id } }, { completedAt: null })))

    for (const title of ['Alder plant', 'Alder errand']) {
      await sys(Store.use((store) => store.remove(Task, { where: { title } })))
    }
  }
})

test('notes: listed, changed and deleted within the scope only', async () => {
  expect(column(await as('nora', workspace.listNotes()), 'title')).toEqual(['Alder pricing'])
  expect(await as('nora', workspace.listNotes(southContact()))).toEqual([])

  const [theirs] = await sys(
    Store.use((store) => store.find(Note, { where: { title: 'Birch pricing' } })),
  )

  const id = theirs?.id ?? ''

  try {
    expect(await as('nora', workspace.updateNote(id, { body: 'rewritten' }))).toBeNull()
    await as('nora', workspace.deleteNote(id))
    const kept = await sys(Store.use((store) => store.first(Note, { where: { id } })))
    expect(kept?.body).toBe('southsecret terms')

    await expect(
      as('nora', workspace.createNote({ title: 'Alder plant', body: '', ...southContact() }, nora)),
    ).rejects.toThrow()

    // A note on no record belongs to the scope it was written in.
    await as('nora', workspace.createNote({ title: 'Alder memo', body: 'for North' }, nora))
    expect(column(await as('sam', workspace.listNotes()), 'title')).toEqual(['Birch pricing'])
  } finally {
    await sys(
      Store.use((store) => store.update(Note, { where: { id } }, { body: 'southsecret terms' })),
    )

    for (const title of ['Alder plant', 'Alder memo']) {
      await sys(Store.use((store) => store.remove(Note, { where: { title } })))
    }
  }
})

test('the timeline: nothing of another scope is read, and nothing is written onto it', async () => {
  expect(await as('nora', records.listActivities('contacts', ids.south.contact))).toEqual([])
  // Home and the Workflows page read the newest activity of the whole business.
  const recent = await as('nora', records.recentActivities(200))
  expect(northIn(recent)).toContain('northsecret')
  expect(southIn(recent)).toEqual([])
  expect(recent.every((a) => a.recordId !== ids.south.contact)).toBe(true)

  const before = await sys(records.listActivities('contacts', ids.south.contact))

  try {
    await expect(
      as(
        'nora',
        workspace.logActivity({ ...southContact(), kind: 'call', notes: 'planted' }, nora),
      ),
    ).rejects.toThrow()

    await expect(
      as(
        'nora',
        records.addActivity({
          ...southContact(),
          kind: 'note',
          summary: 'planted',
          actor: 'Nora',
        }),
      ),
    ).rejects.toThrow()

    expect(await sys(records.listActivities('contacts', ids.south.contact))).toHaveLength(
      before.length,
    )

    // Not found, not forbidden: the refusal reads the same as for a record that was never there.
    const refusal = (attempt: Promise<unknown>) =>
      attempt.then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )

    const plant = (recordId: string) =>
      as(
        'nora',
        records.addActivity({
          objectKey: 'contacts',
          recordId,
          kind: 'note',
          summary: 'planted',
          actor: 'Nora',
        }),
      )

    const hidden = await refusal(plant(ids.south.contact))
    expect(hidden).not.toBe('accepted')
    expect(hidden).toBe(await refusal(plant(crypto.randomUUID())))
  } finally {
    await sys(Store.use((store) => store.remove(Activity, { where: { body: 'planted' } })))
    await sys(Store.use((store) => store.remove(Activity, { where: { summary: 'planted' } })))
  }
})

test('backfill: rows written before scopes were turned on take their record’s scope', async () => {
  const on = { objectKey: 'contacts', recordId: ids.south.contact }
  const note = await sys(workspace.createNote({ title: 'Birch legacy', body: 'old', ...on }, sam))
  const loose = await sys(workspace.createNote({ title: 'Loose legacy', body: 'old' }, sam))

  try {
    // As rows were before the column existed: no scope.
    for (const id of [note.id, loose.id]) {
      await sys(Store.use((store) => store.update(Note, { where: { id } }, { scope: null })))
    }

    // Until the backfill runs, only a role that reaches every scope has them.
    expect(column(await as('sam', workspace.listNotes(on)), 'title')).toEqual(['Birch pricing'])

    expect(column(await as('hana', workspace.listNotes(on), null), 'title')).toContain(
      'Birch legacy',
    )

    // It is the system's to run: a person, whatever their role, is refused.
    await expect(as('hana', backfillScopes(), null)).rejects.toThrow()

    const results = await sys(backfillScopes())

    expect(results.find((r) => r.table === 'notes')).toEqual({
      table: 'notes',
      stamped: 1,
      left: 1,
    })

    expect(column(await as('sam', workspace.listNotes(on)), 'title')).toEqual([
      'Birch legacy',
      'Birch pricing',
    ])

    expect(JSON.stringify(await as('nora', workspace.listNotes()))).not.toContain('legacy')
    // A note on no record can't be told a scope: it is left for head office to see to.
    expect(JSON.stringify(await as('sam', workspace.listNotes()))).not.toContain('Loose legacy')

    // Running it again changes nothing.
    expect((await sys(backfillScopes())).find((r) => r.table === 'notes')?.stamped).toBe(0)
  } finally {
    for (const id of [note.id, loose.id]) {
      await sys(Store.use((store) => store.remove(Note, { where: { id } })))
    }
  }
})
