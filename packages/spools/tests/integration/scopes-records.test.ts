import { expect, test } from 'bun:test'

import type { Filters } from '../../src/crm/filters'
import * as records from '../../src/server/records'
import * as service from '../../src/server/service'
import { objectTable } from '../../src/server/spool'
import { Store } from '../../src/server/store/store'
import { Note, Task } from '../../src/server/store/tables'
import * as workspace from '../../src/server/workspace'
import {
  as,
  column,
  ids,
  northIn,
  people,
  scopedWorld,
  southIn,
  sys,
  unattended,
} from './scopes-world'

// Record scopes at the data layer and the store: what a person can list, count,
// open, make, change and delete, and what a relation may show of another scope.

scopedWorld()

const { nora, ned, bo, hana, otto } = people

const contacts = (filters?: Filters) => records.listRecords({ objectKey: 'contacts', filters })

/** A record put in place by the server itself, and taken away again whatever the test did. */
async function withRecord<A>(
  objectKey: string,
  values: Record<string, unknown>,
  work: (id: string) => Promise<A>,
): Promise<A> {
  const { id } = await sys(records.createRecord(objectKey, values, 'seed'))

  try {
    return await work(id)
  } finally {
    // Deleting a record leaves its notes and tasks behind: they would turn up in another test's lists.
    const on = { where: { objectKey, recordId: id } }
    await sys(Store.use((store) => store.remove(Note, on)))
    await sys(Store.use((store) => store.remove(Task, on)))
    await sys(records.deleteRecord(objectKey, id))
  }
}

/** Takes away whatever a test managed to make under these names. */
const sweep = async (objectKey: string, q: string) => {
  for (const row of await sys(records.listRecords({ objectKey, q, limit: 500 }))) {
    await sys(records.deleteRecord(objectKey, row.id))
  }
}

test('the world holds both branches, as the server itself sees it', async () => {
  expect(column(await sys(contacts()), 'name')).toEqual([
    'Nell Crossing',
    'Nina Alder',
    'Sofia Birch',
  ])

  expect(await sys(records.countRecords())).toEqual({
    companies: 4,
    contacts: 3,
    deals: 3,
    products: 1,
  })
})

test('list: each person is given the records of the scope they are working in', async () => {
  expect(column(await as('nora', contacts()), 'name')).toEqual(['Nell Crossing', 'Nina Alder'])
  expect(column(await as('ned', contacts()), 'name')).toEqual(['Nell Crossing', 'Nina Alder'])
  expect(column(await as('sam', contacts()), 'name')).toEqual(['Sofia Birch'])
  expect(await as('otto', contacts())).toEqual([])

  // Someone who holds both works in one at a time, or in all of theirs.
  expect(column(await as('bo', contacts(), 'north'), 'name')).toEqual([
    'Nell Crossing',
    'Nina Alder',
  ])

  expect(column(await as('bo', contacts(), 'south'), 'name')).toEqual(['Sofia Birch'])
  expect(await as('bo', contacts(), null)).toHaveLength(3)

  // Head office reaches every branch, and can narrow to one.
  expect(await as('hana', contacts(), null)).toHaveLength(3)
  expect(column(await as('hana', contacts(), 'south'), 'name')).toEqual(['Sofia Birch'])

  // An object with no scope field is everyone's.
  const products = records.listRecords({ objectKey: 'products' })
  expect(column(await as('otto', products), 'name')).toEqual(['Crate'])
})

test('list: a scope that is not held is never taken on the asker’s word', async () => {
  // Nora asks to work in South. She is given North.
  expect(column(await as('nora', contacts(), 'south'), 'name')).toEqual([
    'Nell Crossing',
    'Nina Alder',
  ])

  expect(await as('otto', contacts(), 'north')).toEqual([])
})

test('count: totals are of the scope, on every path that counts', async () => {
  expect(await as('nora', records.countMatching({ objectKey: 'contacts' }))).toBe(2)
  expect(await as('sam', records.countMatching({ objectKey: 'contacts' }))).toBe(1)
  expect(await as('nora', records.countMatching({ objectKey: 'contacts', q: 'birch' }))).toBe(0)

  // Home's counts read each table with no condition at all.
  expect(await as('nora', records.countRecords())).toEqual({
    companies: 2,
    contacts: 2,
    deals: 1,
    products: 1,
  })

  expect(await as('otto', records.countRecords())).toEqual({
    companies: 0,
    contacts: 0,
    deals: 0,
    products: 1,
  })
})

test('get: a record of another scope is not found, and neither is what hangs off it', async () => {
  expect(await as('nora', records.getRecord('contacts', ids.south.contact))).toBeNull()
  expect(await as('otto', records.getRecord('contacts', ids.north.contact))).toBeNull()

  expect((await as('ned', records.getRecord('contacts', ids.north.contact)))?.name).toBe(
    'Nina Alder',
  )

  // The record page also lists what points at the record. A South deal points at Nina.
  const related = await as('nora', records.relatedRecords('contacts', ids.north.contact))
  expect(southIn(related)).toEqual([])

  expect(column(related.find((g) => g.objectKey === 'deals')?.rows ?? [], 'title')).toEqual([
    'Alder order',
  ])
})

test('relations: a related record of another scope does not come back with the row', async () => {
  // Nell is a North contact whose company is a South one.
  const listed = await as('nora', contacts())
  expect(northIn(listed)).toContain('Nell')
  expect(southIn(listed)).toEqual([])

  const nell = await as('nora', records.getRecord('contacts', ids.north.cross))
  expect(nell?.name).toBe('Nell Crossing')
  expect(nell?.company ?? null).toBeNull()

  // Titles only, as lists and exports ask for them.
  const titled = await as(
    'nora',
    records.listRecords({ objectKey: 'contacts', relations: 'titles' }),
  )

  expect(southIn(titled)).toEqual([])

  // A shared object's record still comes back.
  const deal = await as('nora', records.getRecord('deals', ids.north.deal))
  expect(records.relatedField(deal?.product, 'name')).toBe('Crate')
})

test('create: a new record takes the scope its maker is working in', async () => {
  try {
    const north = await as(
      'nora',
      service.createRecord('contacts', { name: 'Alder newcomer' }, nora),
    )

    expect(north.branch).toBe('north')

    const south = await as(
      'bo',
      service.createRecord('contacts', { name: 'Birch newcomer' }, bo),
      'south',
    )

    expect(south.branch).toBe('south')

    // Working in every branch at once, the record has to say which it is for.
    const named = await as(
      'hana',
      service.createRecord('contacts', { name: 'Birch by office', branch: 'south' }, hana),
      null,
    )

    expect(named.branch).toBe('south')

    await expect(
      as('hana', service.createRecord('contacts', { name: 'Alder nowhere' }, hana), null),
    ).rejects.toThrow()
  } finally {
    await sweep('contacts', 'newcomer')
    await sweep('contacts', 'by office')
    await sweep('contacts', 'nowhere')
  }
})

test('create: a scope that is not held is refused, whoever sends it', async () => {
  try {
    // A form field, a request body: the value arrives as any other.
    await expect(
      as('nora', service.createRecord('contacts', { name: 'Alder stray', branch: 'south' }, nora)),
    ).rejects.toThrow()

    // The data layer under the service, which scripts and imports reach directly.
    await expect(
      as(
        'nora',
        records.createRecord('contacts', { name: 'Alder stray', branch: 'south' }, nora.id),
      ),
    ).rejects.toThrow()

    // Read-only, and holding nothing.
    await expect(
      as('ned', service.createRecord('contacts', { name: 'Alder stray' }, ned)),
    ).rejects.toThrow()

    await expect(
      as('otto', service.createRecord('contacts', { name: 'Alder stray' }, otto)),
    ).rejects.toThrow()

    // A relation to a record that is not there for this person points at nothing.
    await expect(
      as(
        'nora',
        service.createRecord(
          'contacts',
          { name: 'Alder stray', companyId: ids.south.company },
          nora,
        ),
      ),
    ).rejects.toThrow()

    expect(await sys(records.listRecords({ objectKey: 'contacts', q: 'stray' }))).toEqual([])
  } finally {
    await sweep('contacts', 'stray')
  }
})

test('update: a record of another scope is not found, and stays as it was', async () => {
  try {
    const changed = await as(
      'nora',
      service.updateRecord('contacts', ids.south.contact, { status: 'customer' }, nora),
    )

    expect(changed).toBeNull()

    // The data layer too.
    expect(
      await as('nora', records.updateRecord('contacts', ids.south.contact, { status: 'customer' })),
    ).toBeNull()

    expect((await sys(records.getRecord('contacts', ids.south.contact)))?.status).toBe('lead')
  } finally {
    await sys(records.updateRecord('contacts', ids.south.contact, { status: 'lead' }))
  }
})

test('update: read-only people change nothing, and nobody moves a record out of reach', async () => {
  try {
    await expect(
      as('ned', service.updateRecord('contacts', ids.north.contact, { status: 'customer' }, ned)),
    ).rejects.toThrow()

    // Nora holds North alone: she can't hand a record to South, or point it at a South company.
    await expect(
      as('nora', service.updateRecord('contacts', ids.north.contact, { branch: 'south' }, nora)),
    ).rejects.toThrow()

    await expect(
      as(
        'nora',
        service.updateRecord('contacts', ids.north.contact, { companyId: ids.south.depot }, nora),
      ),
    ).rejects.toThrow()

    const nina = await sys(records.getRecord('contacts', ids.north.contact))
    expect(nina?.status).toBe('lead')
    expect(nina?.branch).toBe('north')
    expect(nina?.companyId).toBe(ids.north.company)
  } finally {
    await sys(
      records.updateRecord('contacts', ids.north.contact, {
        status: 'lead',
        branch: 'north',
        companyId: ids.north.company,
      }),
    )
  }
})

test('update: moving a record to another held scope takes its notes, tasks and timeline along', async () => {
  await withRecord('contacts', { name: 'Alder mover', branch: 'north' }, async (id) => {
    const on = { objectKey: 'contacts', recordId: id }

    await as(
      'nora',
      workspace.createNote({ title: 'Alder mover note', body: 'moves', ...on }, nora),
    )

    await as('nora', workspace.createTask({ title: 'Alder mover task', ...on }, nora.id))

    const moved = await as(
      'bo',
      service.updateRecord('contacts', id, { branch: 'south' }, bo),
      null,
    )

    expect(moved?.branch).toBe('south')

    // South has it now, with what was written on it.
    expect(column(await as('sam', workspace.listNotes(on)), 'title')).toEqual(['Alder mover note'])

    expect(column(await as('sam', workspace.listTasks(on)), 'title')).toEqual(['Alder mover task'])

    expect(await as('sam', records.listActivities('contacts', id))).not.toEqual([])

    // And North no longer does.
    expect(await as('nora', records.getRecord('contacts', id))).toBeNull()
    expect(await as('nora', workspace.listNotes(on))).toEqual([])
    expect(await as('nora', workspace.listTasks(on))).toEqual([])
    expect(await as('nora', records.listActivities('contacts', id))).toEqual([])
    expect(JSON.stringify(await as('nora', workspace.listNotes()))).not.toContain('Alder mover')
  })
})

test('delete: a record of another scope is not found, and is still there afterwards', async () => {
  await withRecord('contacts', { name: 'Birch keeper', branch: 'south' }, async (id) => {
    expect(await as('nora', service.deleteRecord('contacts', id, nora))).toBe(false)
    await as('nora', records.deleteRecord('contacts', id))
    expect((await sys(records.getRecord('contacts', id)))?.name).toBe('Birch keeper')
  })

  await withRecord('contacts', { name: 'Alder keeper', branch: 'north' }, async (id) => {
    // Read-only.
    await expect(as('ned', service.deleteRecord('contacts', id, ned))).rejects.toThrow()
    expect((await sys(records.getRecord('contacts', id)))?.name).toBe('Alder keeper')
  })
})

test('relation pickers: only records of the scope are offered', async () => {
  const offered = await as('nora', records.searchTitles('companies'))
  expect(column(offered.options, 'title')).toEqual(['Alder Annex', 'Alder Works'])
  expect(offered.more).toBe(false)
  expect((await as('nora', records.searchTitles('companies', 'birch'))).options).toEqual([])
  expect((await as('otto', records.searchTitles('companies'))).options).toEqual([])
})

test('title lookups: an id of another scope has no title', async () => {
  const asked = [ids.north.company, ids.south.company, ids.south.depot]
  const titles = await as('nora', records.recordTitlesOf('companies', asked))
  expect([...titles]).toEqual([[ids.north.company, 'Alder Works']])

  // What tasks, notes, favourites and search results name their record with.
  expect(
    await as(
      'nora',
      workspace.recordTitles([{ objectKey: 'contacts', recordId: ids.south.contact }]),
    ),
  ).toEqual({})

  // A CSV import matches relation cells by title or id.
  expect(
    await as('nora', records.matchTitles('companies', ['Birch Supply', ids.south.depot])),
  ).toEqual([])
})

test('filters through a relation cannot ask about a record of another scope', async () => {
  // Nell's company is "Birch Supply", which Nora can't see. The filter must not confirm its name.
  const byName: Filters = [[{ field: 'company.name', op: 'contains', value: 'Birch' }]]
  expect(await as('nora', contacts(byName))).toEqual([])

  expect(await as('nora', records.countMatching({ objectKey: 'contacts', filters: byName }))).toBe(
    0,
  )

  const byCity: Filters = [[{ field: 'company.city', op: 'is', value: 'Southport' }]]
  expect(await as('nora', contacts(byCity))).toEqual([])

  // The same question about a company she can see still works.
  const own: Filters = [[{ field: 'company.name', op: 'contains', value: 'Alder' }]]
  expect(column(await as('nora', contacts(own)), 'name')).toEqual(['Nina Alder'])
})

test('"has ... where" only counts related records of the scope', async () => {
  // The one deal over 9,000 on Nina is a South deal.
  const big: Filters = [
    [{ field: '~deals.contact', op: 'has', where: [{ field: 'value', op: 'gt', value: 9000 }] }],
  ]

  expect(await as('nora', contacts(big))).toEqual([])
  expect(column(await as('hana', contacts(big), null), 'name')).toEqual(['Nina Alder'])

  const won: Filters = [
    [
      {
        field: '~deals.contact',
        op: 'hasNone',
        where: [{ field: 'stage', op: 'in', value: ['won'] }],
      },
    ],
  ]

  // Her only won deal is the South one, so to Nora she has none.
  expect(column(await as('nora', contacts(won)), 'name')).toEqual(['Nell Crossing', 'Nina Alder'])

  const any: Filters = [[{ field: '~deals.contact', op: 'has' }]]
  expect(column(await as('nora', contacts(any)), 'name')).toEqual(['Nina Alder'])
})

test('the store itself keeps to the scope, for code that reaches it directly', async () => {
  const table = objectTable('contacts')

  const found = await as(
    'nora',
    Store.use((store) => store.find(table, { select: ['id', 'name'] })),
  )

  expect(column(found, 'name')).toEqual(['Nell Crossing', 'Nina Alder'])

  expect(
    await as(
      'nora',
      Store.use((store) => store.count(objectTable('deals'))),
    ),
  ).toBe(1)

  // A system table that hangs off records.
  expect(
    southIn(
      await as(
        'nora',
        Store.use((store) => store.find(Note)),
      ),
    ),
  ).toEqual([])

  expect(
    await as(
      'nora',
      Store.use((store) => store.count(Note)),
    ),
  ).toBe(1)

  // A transaction runs the program again on a context it kept: the scope must still be on it.
  const inside = await as(
    'nora',
    Store.use((store) => store.transaction(store.find(table, { select: ['id', 'name'] }))),
  )

  expect(column(inside, 'name')).toEqual(['Nell Crossing', 'Nina Alder'])

  await withRecord('deals', { title: 'Birch target', branch: 'south' }, async (id) => {
    const changed = await as(
      'nora',
      Store.use((store) =>
        store.update(objectTable('deals'), { where: { id } }, { stage: 'lost' }),
      ),
    )

    expect(changed).toBe(0)

    const removed = await as(
      'nora',
      Store.use((store) => store.remove(objectTable('deals'), { where: { id } })),
    )

    expect(removed).toBe(0)
    expect((await sys(records.getRecord('deals', id)))?.stage).toBe('open')
  })
})

test('with nobody signed in and nothing said, a scoped table refuses the call', async () => {
  // A new cron route or script that forgets to say whose work it is must not read every branch.
  await expect(unattended(contacts())).rejects.toThrow()
  await expect(unattended(records.getRecord('contacts', ids.north.contact))).rejects.toThrow()

  try {
    await expect(
      unattended(records.createRecord('contacts', { name: 'Alder orphan', branch: 'north' }, 'x')),
    ).rejects.toThrow()
  } finally {
    await sweep('contacts', 'orphan')
  }
})

test('with nobody signed in, a shared object still answers', async () => {
  expect(column(await unattended(records.listRecords({ objectKey: 'products' })), 'name')).toEqual([
    'Crate',
  ])
})

test('a record can’t move to another scope while scoped records point at it, or stay pointed at one it left', async () => {
  // Bo holds both branches. Nina's company has contacts and deals in North.
  await expect(
    as('bo', service.updateRecord('companies', ids.north.company, { branch: 'south' }, bo), null),
  ).rejects.toThrow('point at it')

  // Nina points at a North company: she can't go South and leave the link behind.
  await expect(
    as('bo', service.updateRecord('contacts', ids.north.contact, { branch: 'south' }, bo), null),
  ).rejects.toThrow()

  expect((await sys(records.getRecord('companies', ids.north.company)))?.branch).toBe('north')
  expect((await sys(records.getRecord('contacts', ids.north.contact)))?.branch).toBe('north')

  // Moved together with a link into the new scope, it goes.
  await withRecord(
    'contacts',
    { name: 'Alder leaver', branch: 'north', companyId: ids.north.annex },
    async (id) => {
      const moved = await as(
        'bo',
        service.updateRecord('contacts', id, { branch: 'south', companyId: ids.south.depot }, bo),
        null,
      )

      expect([moved?.branch, moved?.companyId]).toEqual(['south', ids.south.depot])
    },
  )
})

test('nobody links across scopes, not even a role that reaches every scope', async () => {
  try {
    await expect(
      as(
        'hana',
        service.createRecord(
          'contacts',
          { name: 'Alder crosser', branch: 'north', companyId: ids.south.company },
          hana,
        ),
        null,
      ),
    ).rejects.toThrow()

    await expect(
      as(
        'hana',
        service.updateRecord('contacts', ids.north.contact, { companyId: ids.south.depot }, hana),
        null,
      ),
    ).rejects.toThrow()

    expect((await sys(records.getRecord('contacts', ids.north.contact)))?.companyId).toBe(
      ids.north.company,
    )
  } finally {
    await sweep('contacts', 'crosser')
  }
})
