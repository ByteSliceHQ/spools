import { expect, test } from 'bun:test'

import { Effect } from 'effect'

import { enroll } from '../../src/server/campaigns'
import * as records from '../../src/server/records'
import { asUser } from '../../src/server/scopes'
import * as service from '../../src/server/service'
import { objectTable } from '../../src/server/spool'
import { asc } from '../../src/server/store/query'
import { Store } from '../../src/server/store/store'
import { SequenceRun } from '../../src/server/store/tables'
import { failure } from '../../src/testing/run'
import {
  as,
  branches,
  grants,
  ids,
  people,
  scopedWorld,
  sys,
  unattended,
  type Who,
} from './scopes-world'

// What the guard refuses that the database would otherwise do for a caller, or
// take from one: a delete that clears other scopes' relations, a scope that is
// no scope, and a refusal that must not be taken for a database failure.

scopedWorld()

const { nora, ned, sam, hana } = people

/** The typed error a program fails with, run as one of the world's people. */
const refusal = <A, E>(who: Who, program: Parameters<typeof as<A, E>>[1], wanted?: string | null) =>
  failure(asUser(people[who], wanted)(program))

const make = async (objectKey: string, values: Record<string, unknown>) =>
  (await sys(records.createRecord(objectKey, values, 'seed'))).id

const productOf = async (dealId: string) =>
  (await sys(records.getRecord('deals', dealId)))?.productId

const remove = (objectKey: string, id: string) =>
  Store.use((store) => store.remove(objectTable(objectKey), { where: { id } }))

test('deleting a shared record is refused while records of a scope the caller can’t write point at it', async () => {
  // The world's one product is on a North deal and a South one. Deleting it clears both.
  const product = await make('products', { name: 'Pallet', sku: 'PL-1' })

  const northDeal = await make('deals', {
    title: 'Alder pallets',
    branch: 'north',
    productId: product,
  })

  const southDeal = await make('deals', {
    title: 'Birch pallets',
    branch: 'south',
    productId: product,
  })

  try {
    // Sam writes South. The delete would write a North deal for him.
    const refused = await refusal('sam', service.deleteRecord('products', product, sam))
    expect(refused._tag).toBe('ScopeRefused')
    expect(refused.message).toContain("deals of a branch you can't change point at it")

    // The store itself refuses, whoever calls it and however.
    expect((await refusal('sam', remove('products', product)))._tag).toBe('ScopeRefused')
    expect((await refusal('nora', remove('products', product)))._tag).toBe('ScopeRefused')
    // With nobody said, a scoped table would be written: refused as any scoped write is.
    await expect(unattended(remove('products', product))).rejects.toThrow('asSystem')

    expect(await sys(records.getRecord('products', product))).not.toBeNull()
    expect([await productOf(northDeal), await productOf(southDeal)]).toEqual([product, product])

    // Once nothing out of his reach points at it, it is his to delete, and his own deal is cleared.
    await as('nora', service.updateRecord('deals', northDeal, { productId: null }, nora))
    expect(await as('sam', service.deleteRecord('products', product, sam))).toBe(true)
    expect(await productOf(southDeal)).toBeNull()
  } finally {
    await sys(records.deleteRecord('deals', northDeal))
    await sys(records.deleteRecord('deals', southDeal))
    await sys(remove('products', product))
  }
})

test('whoever writes every scope may delete a shared record that several scopes point at', async () => {
  const product = await make('products', { name: 'Skid', sku: 'SK-1' })

  const northDeal = await make('deals', {
    title: 'Alder skids',
    branch: 'north',
    productId: product,
  })

  const southDeal = await make('deals', {
    title: 'Birch skids',
    branch: 'south',
    productId: product,
  })

  try {
    // Bo writes both branches, and so every deal that points at it.
    expect(await as('bo', service.deleteRecord('products', product, people.bo), null)).toBe(true)
    expect([await productOf(northDeal), await productOf(southDeal)]).toEqual([null, null])
  } finally {
    await sys(records.deleteRecord('deals', northDeal))
    await sys(records.deleteRecord('deals', southDeal))
    await sys(remove('products', product))
  }
})

test('a scoped record that a record of another scope points at is not deleted from under it', async () => {
  // Nell is a North contact whose company is a South one, from before scopes were on.
  const refused = await refusal('sam', service.deleteRecord('companies', ids.south.company, sam))
  expect(refused._tag).toBe('ScopeRefused')

  expect((await sys(records.getRecord('contacts', ids.north.cross)))?.companyId).toBe(
    ids.south.company,
  )
})

test('a record that others take their scope from is deleted by nobody while they do, and its id is nobody’s to change', async () => {
  // A depot's scope field is a relation: its scope is its region's id.
  const region = await make('regions', { name: 'Alder region' })
  branches.push({ key: region, label: 'Alder region' })
  grants[nora.id]?.push({ scope: region, role: 'member' })
  let depot = ''

  try {
    depot = (
      await as(
        'nora',
        service.createRecord('depots', { name: 'Alder depot', regionId: region }, nora),
        region,
      )
    ).id

    // Nora writes that region's depots, every one of them. Deleting the region would still
    // leave them with no scope at all.
    for (const [who, wanted] of [
      ['nora', region],
      ['hana', null],
    ] as const) {
      const refused = await refusal(
        who,
        service.deleteRecord('regions', region, people[who]),
        wanted,
      )

      expect(refused._tag).toBe('ScopeRefused')
      expect(refused.message).toContain('depots have it as their branch')
    }

    await expect(sys(remove('regions', region))).rejects.toThrow('depots have it as their branch')
    expect((await sys(records.getRecord('depots', depot)))?.regionId).toBe(region)

    // Nor can its key be changed from under them.
    const rekeyed = await refusal(
      'hana',
      Store.use((store) =>
        store.update(
          objectTable('regions'),
          { where: { id: region } },
          { id: crypto.randomUUID() },
        ),
      ),
      null,
    )

    expect(rekeyed.message).toBe("A record's id can't be changed.")

    // And a depot isn't left without one.
    await expect(
      as('nora', service.updateRecord('depots', depot, { regionId: null }, nora), region),
    ).rejects.toThrow('without a branch')

    // A scope the resolver doesn't list is no scope, even for head office.
    const unknown = await refusal(
      'hana',
      service.createRecord(
        'depots',
        { name: 'Alder nowhere', regionId: crypto.randomUUID() },
        hana,
      ),
      null,
    )

    expect(unknown._tag).toBe('Invalid')
    expect(unknown.message).toContain('There is no branch')

    // With no depot left in it, the region goes.
    await sys(records.deleteRecord('depots', depot))
    depot = ''
    expect(await as('nora', service.deleteRecord('regions', region, nora), region)).toBe(true)
  } finally {
    if (depot) {
      await sys(records.deleteRecord('depots', depot))
    }

    await sys(remove('regions', region))

    branches.splice(
      branches.findIndex((branch) => branch.key === region),
      1,
    )

    grants[nora.id]?.splice(grants[nora.id]?.findIndex((grant) => grant.scope === region) ?? -1, 1)
  }
})

test('"*" and a value the scope field doesn’t offer are no scope for a record, whoever writes it', async () => {
  const contacts = objectTable('contacts')

  const insert = (branch: string) =>
    Store.use((store) => store.insert(contacts, { name: 'Alder starred', branch }))

  const move = (branch: string) =>
    Store.use((store) => store.update(contacts, { where: { id: ids.north.contact } }, { branch }))

  try {
    // "*" is what a row on a shared record carries: a record that held it would hand its
    // notes and tasks to every branch.
    const everyBranch = [
      await refusal('hana', insert('*'), null),
      await refusal('hana', move('*'), null),
    ]

    expect(everyBranch.map((refused) => refused._tag)).toEqual(['ScopeRefused', 'ScopeRefused'])

    for (const refused of everyBranch) {
      expect(refused.message).toContain('stands for every branch')
    }

    await expect(sys(insert('*'))).rejects.toThrow('stands for every branch')

    // The field is a select: its options are the branches there are.
    expect((await refusal('hana', insert('west'), null)).message).toBe('There is no branch "west".')
    expect((await refusal('hana', move('west'), null)).message).toBe('There is no branch "west".')

    expect((await sys(records.getRecord('contacts', ids.north.contact)))?.branch).toBe('north')
    expect(await sys(records.listRecords({ objectKey: 'contacts', q: 'starred' }))).toEqual([])
  } finally {
    for (const row of await sys(records.listRecords({ objectKey: 'contacts', q: 'starred' }))) {
      await sys(records.deleteRecord('contacts', row.id))
    }
  }
})

test('a refusal is its own failure: code that expects a database failure doesn’t take it for one', async () => {
  const insert = Store.use((store) =>
    store.insert(objectTable('contacts'), { name: 'Alder refused', branch: 'north' }),
  )

  // Ned reads North and writes nothing.
  const refused = await refusal('ned', insert)
  expect(refused._tag).toBe('ScopeRefused')
  expect(refused.message).toBe('You can look at these records, but not add to them.')

  // What a caller writes for a unique index keeping one row doesn't run for a refusal.
  let taken = false

  const expecting = insert.pipe(
    Effect.catchTag('DatabaseError', () => Effect.sync(() => (taken = true))),
  )

  expect((await refusal('ned', expecting))._tag).toBe('ScopeRefused')
  expect(taken).toBe(false)

  // Enrolling is such a caller: a read-only person is told why, never "Already enrolled".
  const id = await make('contacts', {
    name: 'Alder unenrolled',
    email: 'un@alder.test',
    branch: 'north',
  })

  try {
    const record = await sys(records.getRecord('contacts', id))

    if (!record) {
      throw new Error('The contact was not made')
    }

    const enrolling = await refusal('ned', enroll('welcome', 'contacts', record, ned))
    expect(enrolling._tag).toBe('ScopeRefused')

    expect(
      await sys(Store.use((store) => store.count(SequenceRun, { where: { recordId: id } }))),
    ).toBe(0)
  } finally {
    await sys(records.deleteRecord('contacts', id))
  }
})

test('a list sorted by a related record’s column sorts by it whatever kind of column it is, and never by one out of reach', async () => {
  const companies = objectTable('companies')

  const set = (id: string, values: Record<string, unknown>) =>
    sys(Store.use((store) => store.update(companies, { where: { id } }, values)))

  const blank = { founded: null, staff: null, revenue: null, listed: null }

  const annexed = await make('contacts', {
    name: 'Alder annexed',
    branch: 'north',
    companyId: ids.north.annex,
  })

  try {
    await set(ids.north.company, {
      founded: '2001-05-01',
      staff: 50,
      revenue: '300.00',
      listed: true,
    })

    await set(ids.north.annex, {
      founded: '1990-01-01',
      staff: 5,
      revenue: '900.50',
      listed: false,
    })

    // Nell's company is a South one. Were it sorted by, she would come first every time.
    await set(ids.south.company, {
      founded: '1900-01-01',
      staff: 1,
      revenue: '1.00',
      listed: false,
    })

    const sorted = async (column: string) =>
      (
        await as(
          'nora',
          Store.use((store) =>
            store.find(objectTable('contacts'), {
              order: [asc(['company', column], 'last'), asc('name')],
              select: ['name'],
            }),
          ),
        )
      ).map((row) => row.name)

    const annexFirst = ['Alder annexed', 'Nina Alder', 'Nell Crossing']
    const companyFirst = ['Nina Alder', 'Alder annexed', 'Nell Crossing']

    // A day, a number, money, yes or no, a moment and text: every kind a title can be.
    expect(await sorted('founded')).toEqual(annexFirst)
    expect(await sorted('staff')).toEqual(annexFirst)
    expect(await sorted('revenue')).toEqual(companyFirst)
    expect(await sorted('listed')).toEqual(annexFirst)
    expect(await sorted('createdAt')).toEqual(companyFirst)
    expect(await sorted('name')).toEqual(annexFirst)
  } finally {
    await sys(records.deleteRecord('contacts', annexed))

    for (const id of [ids.north.company, ids.north.annex, ids.south.company]) {
      await set(id, blank)
    }
  }
})
