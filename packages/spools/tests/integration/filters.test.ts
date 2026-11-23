import { afterAll, beforeAll, expect } from 'bun:test'

import {
  addDays,
  type Condition,
  type Filters,
  ME,
  type Sort,
  todayIn,
} from '../../src/crm/filters'
import { compileFilters } from '../../src/server/filter-query'
import * as records from '../../src/server/records'
import { crmConfig, objectTable } from '../../src/server/spool'
import { and, contains } from '../../src/server/store/query'
import { SavedView, Task } from '../../src/server/store/tables'
import { runTool } from '../../src/server/tools'
import * as views from '../../src/server/views'
import * as workspace from '../../src/server/workspace'
import { db, run as go } from '../support/run'
import { exampleTest, isExampleApp } from './example-app'

// Every filter operator, sorting and the activity dates, against a real database.
const tag = `flt${Date.now()}`
const userA = `user_a_${tag}`
const userB = `user_b_${tag}`
// The example app keeps the default time zone, UTC.
const today = todayIn('UTC')
const day = (n: number) => addDays(today, n)

const id: Record<string, string> = {}

beforeAll(async () => {
  if (!isExampleApp) {
    return
  }

  const make = async (key: string, objectKey: string, values: Record<string, unknown>) => {
    id[key] = (await go(records.createRecord(objectKey, values, userA))).id
  }

  const shared = `https://shared-${tag}.test`

  await make('alpha', 'companies', {
    name: `Alpha ${tag}`,
    industry: 'software',
    employees: 10,
    domain: shared,
  })

  await make('beta', 'companies', {
    name: `Beta ${tag}`,
    industry: 'finance',
    employees: 250,
    domain: shared,
  })

  await make('gamma', 'companies', { name: `Gamma ${tag}` })

  await make('ann', 'contacts', {
    name: `Ann Lee ${tag}`,
    email: `ann.${tag}@alpha.test`,
    companyId: id.alpha,
    status: 'lead',
    owner: userA,
  })

  await make('bob', 'contacts', {
    name: `Bob Stone ${tag}`,
    email: `Bob.${tag}@Beta.test`,
    companyId: id.beta,
    status: 'customer',
    owner: userB,
  })

  await make('cy', 'contacts', {
    name: `Cy Young ${tag}`,
    status: 'qualified',
    notes: `Prefers quartz ${tag}`,
  })

  await make('kitchen', 'deals', {
    title: `Kitchen ${tag}`,
    value: 1000,
    stage: 'won',
    companyId: id.alpha,
    contactId: id.ann,
    closeDate: day(-10),
    owner: userA,
  })

  await make('bath', 'deals', {
    title: `Bath ${tag}`,
    value: 5000,
    stage: 'proposal',
    companyId: id.beta,
    contactId: id.bob,
    closeDate: day(5),
    owner: userB,
  })

  await make('deck', 'deals', { title: `Deck ${tag}`, stage: 'discovery' })

  await make('kitchen2', 'deals', {
    title: `Kitchen two ${tag}`,
    value: 9000.5,
    stage: 'lost',
    companyId: id.alpha,
    contactId: id.ann,
    closeDate: today,
  })

  const ago = (days: number) => new Date(Date.now() - days * 86_400_000)
  const on = (key: string) => ({ objectKey: 'deals', recordId: id[key] as string })

  // An email 40 days ago, a call just now, an edit (not activity) and an email that never went out (not contact).
  await go(
    records.addActivity({
      ...on('kitchen'),
      kind: 'email',
      summary: `sent an email: Samples ${tag}`,
      occurredAt: ago(40),
      outcome: 'sent',
    }),
  )

  await go(
    records.addActivity({
      ...on('bath'),
      kind: 'call',
      summary: 'logged a call: Connected',
      outcome: 'connected',
    }),
  )

  await go(
    records.addActivity({ ...on('deck'), kind: 'change', summary: 'changed Stage to Discovery' }),
  )

  await go(
    records.addActivity({
      ...on('kitchen2'),
      kind: 'email',
      summary: `drafted an email: Hello ${tag}`,
      outcome: 'not_sent',
    }),
  )

  await go(
    records.addActivity({
      ...on('kitchen2'),
      kind: 'note',
      summary: 'added a note: Site visit',
      occurredAt: ago(3),
    }),
  )

  const due = await go(
    workspace.createTask({ title: `Send proposal ${tag}`, dueDate: day(3), ...on('bath') }, userA),
  )

  id.task = due.id

  const done = await go(
    workspace.createTask({ title: `Measure ${tag}`, dueDate: day(-1), ...on('kitchen') }, userA),
  )

  await go(workspace.updateTask(done.id, { completed: true }, userA))
})

afterAll(async () => {
  if (!isExampleApp) {
    return
  }

  await db.remove(Task, { where: { createdBy: userA } })
  await db.remove(SavedView, { where: { createdBy: userA } })
  await db.remove(SavedView, { where: { createdBy: userB } })

  for (const key of ['kitchen', 'bath', 'deck', 'kitchen2']) {
    await go(records.deleteRecord('deals', id[key] as string))
  }

  for (const key of ['ann', 'bob', 'cy']) {
    await go(records.deleteRecord('contacts', id[key] as string))
  }

  for (const key of ['alpha', 'beta', 'gamma']) {
    await go(records.deleteRecord('companies', id[key] as string))
  }
})

const TITLE: Record<string, string> = { deals: 'title', contacts: 'name', companies: 'name' }

/** The first word of each matching record's title, among this run's records, in a stable order. */
async function find(
  objectKey: string,
  conditions: Condition[] | Filters,
  extra: { sort?: Sort[]; viewerId?: string; q?: string } = {},
): Promise<string[]> {
  const title = TITLE[objectKey] as string
  const mine: Condition = { field: title, op: 'contains', value: tag }

  const groups = (
    Array.isArray(conditions[0]) ? (conditions as Filters) : [conditions as Condition[]]
  ).map((g) => [...g, mine])

  const rows = await go(
    records.listRecords({ objectKey, filters: groups, relations: 'none', limit: 100, ...extra }),
  )

  const names = rows.map((r) => String(r[title]).replace(` ${tag}`, ''))
  return extra.sort ? names : names.sort()
}

exampleTest(
  'text: contains, is, starts and ends with, their negatives, and emptiness',
  async () => {
    const email = (op: Condition['op'], value?: string) =>
      find('contacts', [{ field: 'email', op, value }])

    expect(await email('contains', 'ALPHA')).toEqual(['Ann Lee']) // any case
    expect(await email('notContains', 'alpha')).toEqual(['Bob Stone', 'Cy Young']) // someone with no email isn't at alpha either
    expect(await email('is', `bob.${tag}@beta.test`)).toEqual(['Bob Stone']) // stored as Bob.…@Beta.test
    expect(await email('is', 'bob')).toEqual([])
    expect(await email('isNot', `ann.${tag}@alpha.test`)).toEqual(['Bob Stone', 'Cy Young'])
    expect(await email('startsWith', 'ann.')).toEqual(['Ann Lee'])
    expect(await email('endsWith', '@beta.test')).toEqual(['Bob Stone'])
    expect(await email('empty')).toEqual(['Cy Young'])
    expect(await email('notEmpty')).toEqual(['Ann Lee', 'Bob Stone'])
    // % and _ are text to look for, not wildcards.
    expect(await email('contains', '%')).toEqual([])

    expect(await find('contacts', [{ field: 'notes', op: 'contains', value: 'quartz' }])).toEqual([
      'Cy Young',
    ])
  },
)

exampleTest('numbers and money: comparisons, a range, and emptiness', async () => {
  const value = (op: Condition['op'], v?: number | number[]) =>
    find('deals', [{ field: 'value', op, value: v }])

  expect(await value('eq', 5000)).toEqual(['Bath'])
  expect(await value('neq', 5000)).toEqual(['Deck', 'Kitchen', 'Kitchen two']) // no value isn't 5,000 either
  expect(await value('gt', 5000)).toEqual(['Kitchen two'])
  expect(await value('gte', 5000)).toEqual(['Bath', 'Kitchen two'])
  expect(await value('lt', 5000)).toEqual(['Kitchen'])
  expect(await value('lte', 5000)).toEqual(['Bath', 'Kitchen'])
  expect(await value('between', [1000, 5000])).toEqual(['Bath', 'Kitchen'])
  expect(await value('eq', 9000.5)).toEqual(['Kitchen two']) // cents compare exactly
  expect(await value('empty')).toEqual(['Deck'])
  expect(await value('notEmpty')).toEqual(['Bath', 'Kitchen', 'Kitchen two'])
  // A plain number column, not money.
  expect(await find('companies', [{ field: 'employees', op: 'gt', value: 100 }])).toEqual(['Beta'])

  expect(await find('companies', [{ field: 'employees', op: 'between', value: [5, 20] }])).toEqual([
    'Alpha',
  ])

  expect(await find('companies', [{ field: 'employees', op: 'empty' }])).toEqual(['Gamma'])
})

exampleTest(
  'dates: a day, before and after, a range, spans of days counted from today',
  async () => {
    const close = (op: Condition['op'], v?: string | number | string[]) =>
      find('deals', [{ field: 'closeDate', op, value: v }])

    expect(await close('on', today)).toEqual(['Kitchen two'])
    expect(await close('on', 'today')).toEqual(['Kitchen two'])
    expect(await close('before', today)).toEqual(['Kitchen'])
    expect(await close('after', 'today')).toEqual(['Bath'])
    expect(await close('between', [day(-10), today])).toEqual(['Kitchen', 'Kitchen two'])
    expect(await close('inLast', 15)).toEqual(['Kitchen', 'Kitchen two'])
    expect(await close('inNext', 7)).toEqual(['Bath', 'Kitchen two'])
    expect(await close('olderThan', 5)).toEqual(['Kitchen'])
    expect(await close('olderThan', 10)).toEqual([]) // ten days ago is not more than ten days ago
    expect(await close('empty')).toEqual(['Deck'])
    expect(await close('notEmpty')).toEqual(['Bath', 'Kitchen', 'Kitchen two'])
  },
)

exampleTest('moments (created, last contacted) are matched by the day they fall on', async () => {
  expect(await find('deals', [{ field: 'createdAt', op: 'on', value: 'today' }])).toHaveLength(4)
  expect(await find('deals', [{ field: 'createdAt', op: 'before', value: 'today' }])).toEqual([])
  expect(await find('deals', [{ field: 'createdAt', op: 'inLast', value: 1 }])).toHaveLength(4)
  expect(await find('deals', [{ field: 'createdAt', op: 'olderThan', value: 0 }])).toEqual([])
})

exampleTest(
  'activity dates: last contacted, last activity and next task due are kept on the record',
  async () => {
    const deal = async (key: string) =>
      (await go(records.getRecord('deals', id[key] as string))) as Record<string, unknown>

    const kitchen = await deal('kitchen')

    expect(
      Math.round((Date.now() - (kitchen.lastContactedAt as Date).getTime()) / 86_400_000),
    ).toBe(40)

    expect(kitchen.nextTaskDue).toBeNull() // its only task is done
    expect((await deal('bath')).nextTaskDue).toBe(day(3))
    expect((await deal('deck')).lastActivityAt).toBeNull() // an edit isn't activity
    const two = await deal('kitchen2')
    expect(two.lastContactedAt).toBeNull() // a draft that never went out isn't contact
    expect(two.lastActivityAt).not.toBeNull() // the note is activity
    // Refreshing them is not a change to the record.
    expect((two.updatedAt as Date).getTime()).toBe((two.createdAt as Date).getTime())

    expect(await find('deals', [{ field: 'lastContactedAt', op: 'olderThan', value: 30 }])).toEqual(
      ['Kitchen'],
    )

    expect(await find('deals', [{ field: 'lastContactedAt', op: 'inLast', value: 7 }])).toEqual([
      'Bath',
    ])

    expect(await find('deals', [{ field: 'lastContactedAt', op: 'empty' }])).toEqual([
      'Deck',
      'Kitchen two',
    ])

    expect(await find('deals', [{ field: 'lastActivityAt', op: 'inLast', value: 7 }])).toEqual([
      'Bath',
      'Kitchen two',
    ])

    expect(await find('deals', [{ field: 'nextTaskDue', op: 'inNext', value: 7 }])).toEqual([
      'Bath',
    ])

    expect(await find('deals', [{ field: 'nextTaskDue', op: 'empty' }])).toEqual([
      'Deck',
      'Kitchen',
      'Kitchen two',
    ])

    // Completing, reopening and deleting a task moves the date with it.
    await go(workspace.updateTask(id.task as string, { completed: true }, userA))
    expect((await deal('bath')).nextTaskDue).toBeNull()
    await go(workspace.updateTask(id.task as string, { completed: false, dueDate: day(9) }, userA))
    expect((await deal('bath')).nextTaskDue).toBe(day(9))

    const sooner = await go(
      workspace.createTask(
        { title: `Call ${tag}`, dueDate: day(1), objectKey: 'deals', recordId: id.bath },
        userA,
      ),
    )

    expect((await deal('bath')).nextTaskDue).toBe(day(1))
    await go(workspace.deleteTask(sooner.id))
    expect((await deal('bath')).nextTaskDue).toBe(day(9))
  },
)

exampleTest("choices: any of, none of, emptiness; 'Me' is whoever is looking", async () => {
  expect(await find('deals', [{ field: 'stage', op: 'in', value: ['won', 'lost'] }])).toEqual([
    'Kitchen',
    'Kitchen two',
  ])

  expect(await find('deals', [{ field: 'stage', op: 'notIn', value: ['won', 'lost'] }])).toEqual([
    'Bath',
    'Deck',
  ])

  expect(
    await find('deals', [{ field: 'company', op: 'in', value: [id.alpha as string] }]),
  ).toEqual(['Kitchen', 'Kitchen two'])

  expect(
    await find('deals', [{ field: 'company', op: 'notIn', value: [id.alpha as string] }]),
  ).toEqual(['Bath', 'Deck'])

  expect(await find('deals', [{ field: 'company', op: 'empty' }])).toEqual(['Deck'])
  expect(await find('deals', [{ field: 'company', op: 'notEmpty' }])).toHaveLength(3)
  expect(await find('companies', [{ field: 'industry', op: 'empty' }])).toEqual(['Gamma'])
  expect(await find('deals', [{ field: 'owner', op: 'in', value: [userB] }])).toEqual(['Bath'])

  expect(
    await find('deals', [{ field: 'owner', op: 'in', value: [ME] }], { viewerId: userA }),
  ).toEqual(['Kitchen'])

  expect(
    await find('deals', [{ field: 'owner', op: 'in', value: [ME] }], { viewerId: userB }),
  ).toEqual(['Bath'])

  expect(await find('deals', [{ field: 'owner', op: 'in', value: [ME] }])).toEqual([]) // nobody is looking
  expect(await find('deals', [{ field: 'owner', op: 'empty' }])).toEqual(['Deck', 'Kitchen two'])

  expect(
    await find('deals', [{ field: 'createdBy', op: 'in', value: [ME] }], { viewerId: userA }),
  ).toHaveLength(4)
})

exampleTest('through a relation: a field of the record it points to', async () => {
  expect(
    await find('deals', [{ field: 'company.industry', op: 'in', value: ['software'] }]),
  ).toEqual(['Kitchen', 'Kitchen two'])

  expect(await find('deals', [{ field: 'company.employees', op: 'gt', value: 100 }])).toEqual([
    'Bath',
  ])

  expect(
    await find('deals', [{ field: 'contact.email', op: 'endsWith', value: 'beta.test' }]),
  ).toEqual(['Bath'])

  expect(
    await find('contacts', [{ field: 'company.name', op: 'startsWith', value: 'Alpha' }]),
  ).toEqual(['Ann Lee'])

  expect(await find('deals', [{ field: 'company.industry', op: 'notEmpty' }])).toEqual([
    'Bath',
    'Kitchen',
    'Kitchen two',
  ])

  // A date kept on the related record works the same way.
  expect(
    await find('contacts', [{ field: 'company.createdAt', op: 'on', value: 'today' }]),
  ).toEqual(['Ann Lee', 'Bob Stone'])
})

exampleTest(
  'through a relation, what is true of an empty field is true of a record that points to nothing',
  async () => {
    // Deck has no company and no contact. On a field of its own, "is empty" and "is not X" would include it;
    // through a relation they must too.
    const via = (field: string, op: Condition['op'], value?: Condition['value']) =>
      find('deals', [{ field, op, value }])

    expect(await via('company.industry', 'empty')).toEqual(['Deck'])
    expect(await via('company.industry', 'notIn', ['software'])).toEqual(['Bath', 'Deck'])
    expect(await via('contact.status', 'notIn', ['lead'])).toEqual(['Bath', 'Deck'])
    expect(await via('company.name', 'notContains', 'alpha')).toEqual(['Bath', 'Deck'])
    expect(await via('company.name', 'isNot', `alpha ${tag}`)).toEqual(['Bath', 'Deck'])
    expect(await via('company.employees', 'neq', 10)).toEqual(['Bath', 'Deck'])
    expect(await via('contact.email', 'empty')).toEqual(['Deck'])
    // A company with no industry of its own is found the same way, alongside records with no company.
    const noIndustry = await find('contacts', [{ field: 'company.industry', op: 'empty' }])
    expect(noIndustry).toEqual(['Cy Young'])
    // The positive forms still need the related record.
    expect(await via('company.industry', 'in', ['software'])).toEqual(['Kitchen', 'Kitchen two'])
    expect(await via('company.name', 'contains', 'a')).toHaveLength(3)
  },
)

exampleTest('records that point here: has any, has none, optionally narrowed', async () => {
  const deals = (op: 'has' | 'hasNone', where?: Condition[]) =>
    find('companies', [{ field: '~deals.company', op, ...(where ? { where } : {}) }])

  expect(await deals('has')).toEqual(['Alpha', 'Beta'])
  expect(await deals('hasNone')).toEqual(['Gamma'])
  expect(await deals('has', [{ field: 'stage', op: 'in', value: ['won'] }])).toEqual(['Alpha'])

  expect(await deals('hasNone', [{ field: 'stage', op: 'in', value: ['won'] }])).toEqual([
    'Beta',
    'Gamma',
  ])

  expect(
    await deals('has', [
      { field: 'value', op: 'gte', value: 5000 },
      { field: 'closeDate', op: 'inNext', value: 30 },
    ]),
  ).toEqual(['Alpha', 'Beta'])

  expect(await find('contacts', [{ field: '~deals.contact', op: 'hasNone' }])).toEqual(['Cy Young'])
})

exampleTest(
  'conditions in a group all hold; groups are alternatives; filters add to search and `where`',
  async () => {
    expect(
      await find('deals', [
        { field: 'stage', op: 'in', value: ['won', 'lost'] },
        { field: 'value', op: 'gt', value: 5000 },
      ]),
    ).toEqual(['Kitchen two'])

    expect(
      await find('deals', [
        [{ field: 'stage', op: 'in', value: ['won'] }],
        [{ field: 'value', op: 'gte', value: 5000 }],
      ]),
    ).toEqual(['Bath', 'Kitchen', 'Kitchen two'])

    expect(await find('deals', [{ field: 'value', op: 'notEmpty' }], { q: 'kitchen two' })).toEqual(
      ['Kitchen two'],
    )

    // Every word must be found, in any order, in any searchable field.
    expect(await find('deals', [], { q: `two ${tag} kitchen` })).toEqual(['Kitchen two'])
    expect(await find('deals', [], { q: 'kitchen bath' })).toEqual([])

    const won: Filters = [[{ field: 'stage', op: 'in', value: ['won'] }]]

    expect(
      await go(
        records.countMatching({
          objectKey: 'deals',
          filters: won,
          where: { company: id.alpha as string },
        }),
      ),
    ).toBe(1)

    expect(
      await go(
        records.countMatching({
          objectKey: 'deals',
          filters: won,
          where: { company: id.beta as string },
        }),
      ),
    ).toBe(0)

    // What the config doesn't allow is dropped, not applied: a phone number encrypted for storage can't be matched.
    expect(await find('contacts', [{ field: 'phone', op: 'contains', value: '555' }])).toHaveLength(
      3,
    )

    expect(await find('contacts', [{ field: 'phone', op: 'empty' }])).toHaveLength(3)
  },
)

exampleTest(
  "sorting: several levels, by a related record's title, empty values last either way",
  async () => {
    const sorted = (sort: Sort[]) => find('deals', [], { sort })

    expect(await sorted([{ field: 'value', dir: 'desc' }])).toEqual([
      'Kitchen two',
      'Bath',
      'Kitchen',
      'Deck',
    ])

    expect(await sorted([{ field: 'value', dir: 'asc' }])).toEqual([
      'Kitchen',
      'Bath',
      'Kitchen two',
      'Deck',
    ])

    expect(
      await sorted([
        { field: 'company', dir: 'asc' },
        { field: 'value', dir: 'desc' },
      ]),
    ).toEqual(['Kitchen two', 'Kitchen', 'Bath', 'Deck'])

    expect(
      await sorted([
        { field: 'company', dir: 'desc' },
        { field: 'value', dir: 'asc' },
      ]),
    ).toEqual(['Bath', 'Kitchen', 'Kitchen two', 'Deck'])

    // Never contacted goes last, after the longest ago.
    expect((await sorted([{ field: 'lastContactedAt', dir: 'asc' }])).slice(0, 2)).toEqual([
      'Kitchen',
      'Bath',
    ])

    expect((await sorted([{ field: 'lastContactedAt', dir: 'desc' }])).slice(0, 2)).toEqual([
      'Bath',
      'Kitchen',
    ])

    // Paging through a sort with ties never repeats or skips a record.
    const pages = await Promise.all(
      [0, 2].map((offset) =>
        go(
          records.listRecords({
            objectKey: 'deals',
            filters: [[{ field: 'title', op: 'contains', value: tag }]],
            sort: [{ field: 'stage', dir: 'asc' }],
            limit: 2,
            offset,
            relations: 'none',
          }),
        ),
      ),
    )

    expect(new Set(pages.flat().map((r) => r.id)).size).toBe(4)
  },
)

exampleTest(
  "views keep filters and several sorts; a private view is its maker's alone",
  async () => {
    const filters: Filters = [
      [{ field: 'value', op: 'gt', value: 2000 }],
      [{ field: 'company.industry', op: 'in', value: ['software'] }],
    ]

    const sort: Sort[] = [
      { field: 'company', dir: 'asc' },
      { field: 'value', dir: 'desc' },
    ]

    const shared = await go(
      views.createView(
        'deals',
        { label: `Big ${tag}`, type: 'table', copyFrom: 'all', settings: { filters, sort } },
        userA,
      ),
    )

    const mine = await go(
      views.createView(
        'deals',
        { label: `Mine ${tag}`, type: 'table', settings: { filters }, private: true },
        userA,
      ),
    )

    const forA = await go(views.resolveViews('deals', userA))
    const forB = await go(views.resolveViews('deals', userB))
    expect(forA.find((v) => v.id === shared)?.settings).toMatchObject({ filters, sort })
    expect(forA.some((v) => v.id === mine)).toBe(true)
    expect(forB.some((v) => v.id === shared)).toBe(true)
    expect(forB.some((v) => v.id === mine)).toBe(false)

    await expect(go(views.saveView('deals', mine, { label: 'Taken' }, userB))).rejects.toThrow(
      'View not found',
    )

    // Saving drops a condition the config doesn't allow and keeps the rest.
    await go(
      views.saveView(
        'deals',
        shared,
        {
          filters: [
            [
              { field: 'value', op: 'gt', value: 2000 },
              { field: 'nope', op: 'is', value: 'x' },
            ],
          ],
          sort: [],
        },
        userA,
      ),
    )

    const saved = (await go(views.resolveViews('deals', userA))).find((v) => v.id === shared)
    expect(saved?.settings.filters).toEqual([[{ field: 'value', op: 'gt', value: 2000 }]])
    expect(saved?.settings.sort).toEqual([])

    // Footer calculations and CSV export follow the same filters.
    const scoped: Filters = [
      [
        { field: 'value', op: 'gt', value: 2000 },
        { field: 'title', op: 'contains', value: tag },
      ],
    ]

    expect(await go(views.calculate('deals', { filters: scoped }, { value: 'sum' }))).toEqual({
      value: 14000.5,
    })

    const csv = await go(
      workspace.exportCsv('deals', { filters: scoped, sort: [{ field: 'value', dir: 'desc' }] }),
    )

    expect(
      csv
        .split('\n')
        .slice(1)
        .map((line) => line.split(',')[1]),
    ).toEqual([`Kitchen two ${tag}`, `Bath ${tag}`])
  },
)

exampleTest(
  "the assistant's search takes the same conditions, and is told when one is wrong",
  async () => {
    const found = await go(
      runTool('search', {
        objectKey: 'deals',
        query: tag,
        filters: [
          { field: 'value', op: 'gte', value: 5000 },
          { field: 'lastContactedAt', op: 'inLast', value: 7 },
        ],
        sort: { field: 'value', dir: 'desc' },
      }),
    )

    expect(found.ok && (found.data as { title: string }[]).map((r) => r.title)).toEqual([
      `Bath ${tag}`,
    ])

    const wrong = await go(
      runTool('search', {
        objectKey: 'deals',
        filters: [{ field: 'value', op: 'contains', value: '5' }],
      }),
    )

    expect(wrong).toMatchObject({
      ok: false,
      error: expect.stringContaining('A filter names an unknown field'),
    })
  },
)

exampleTest('money compares as amounts, not as text', async () => {
  // As text, "900.00" sorts after "10000.00" and "5000.00"; as amounts it is the smallest.
  const mine = `money${tag}`
  const made: string[] = []

  for (const value of [900, 5000, 10000]) {
    made.push(
      (await go(records.createRecord('deals', { title: `${value} ${mine}`, value }, userA))).id,
    )
  }

  try {
    const amounts = async (op: Condition['op'], value: number | number[], sort?: Sort[]) => {
      const rows = await go(
        records.listRecords({
          objectKey: 'deals',
          filters: [
            [
              { field: 'title', op: 'contains', value: mine },
              { field: 'value', op, value },
            ],
          ],
          sort: sort ?? [{ field: 'value', dir: 'asc' }],
          relations: 'none',
        }),
      )

      return rows.map((r) => Number(r.value))
    }

    expect(await amounts('gt', 1000)).toEqual([5000, 10000])
    expect(await amounts('lt', 5000)).toEqual([900])
    expect(await amounts('gte', 900)).toEqual([900, 5000, 10000])
    expect(await amounts('lte', 9999.99)).toEqual([900, 5000])
    expect(await amounts('between', [901, 9999])).toEqual([5000])
    expect(await amounts('gt', 0, [{ field: 'value', dir: 'desc' }])).toEqual([10000, 5000, 900])
  } finally {
    for (const dealId of made) {
      await go(records.deleteRecord('deals', dealId))
    }
  }
})

exampleTest(
  'a filter nobody could mean is dropped or matches nothing; it never breaks the list',
  async () => {
    const all = await find('deals', [])

    // An impossible day and names that only look like keys are dropped: the list shows as if they weren't there.
    const dropped: Condition[] = [
      { field: 'closeDate', op: 'on', value: '2026-04-31' },
      { field: 'closeDate', op: 'between', value: ['2026-02-01', '2026-02-30'] },
      { field: 'nextTaskDue', op: 'on', value: '2026-04-31' },
      { field: '~__proto__.x', op: 'has' },
      { field: '~constructor.x', op: 'has' },
      { field: '__proto__', op: 'empty' },
      { field: 'company.__proto__', op: 'empty' },
    ]

    for (const condition of dropped) {
      expect(await find('deals', [condition])).toEqual(all)
    }

    expect(
      await go(records.countMatching({ objectKey: 'deals', filters: [dropped] })),
    ).toBeGreaterThanOrEqual(4)

    // A stage that is no longer an option stays in the filter and matches nothing, as it did before it was removed.
    expect(await find('deals', [{ field: 'stage', op: 'in', value: ['gone'] }])).toEqual([])
    expect(await find('deals', [{ field: 'stage', op: 'notIn', value: ['gone'] }])).toEqual(all)

    // A real last day of the month still works.
    expect(
      await find('deals', [{ field: 'closeDate', op: 'between', value: [day(-10), day(-10)] }]),
    ).toEqual(['Kitchen'])

    // The ends of a date range in either order.
    expect(
      await find('deals', [{ field: 'closeDate', op: 'between', value: [today, day(-10)] }]),
    ).toEqual(['Kitchen', 'Kitchen two'])
  },
)

exampleTest(
  "a day is the business's day: the same moment falls on different days in different zones",
  async () => {
    // 03:30 UTC on 10 March is still 9 March in New York.
    const deal = await go(records.createRecord('deals', { title: `Zone ${tag}` }, userA))

    await go(
      records.addActivity({
        objectKey: 'deals',
        recordId: deal.id,
        kind: 'call',
        summary: 'logged a call: Connected',
        occurredAt: new Date('2026-03-10T03:30:00Z'),
      }),
    )

    try {
      const on = async (value: string, timeZone: string) => {
        const filters: Filters = [
          [
            { field: 'title', op: 'contains', value: `Zone ${tag}` },
            { field: 'lastContactedAt', op: 'on', value },
          ],
        ]

        const filter = compileFilters('deals', filters, { timeZone })

        if (!filter) {
          throw new Error('no filter')
        }

        return (await db.find(objectTable('deals'), { filter })).length
      }

      expect(await on('2026-03-09', 'America/New_York')).toBe(1)
      expect(await on('2026-03-10', 'America/New_York')).toBe(0)
      expect(await on('2026-03-10', 'UTC')).toBe(1)
      expect(await on('2026-03-09', 'UTC')).toBe(0)
      expect(await on('2026-03-10', 'Asia/Tokyo')).toBe(1)
      // Without a zone given, the config's is used (UTC in the example app).
      expect(crmConfig().app.timezone).toBe('UTC')

      const byDefault = compileFilters('deals', [
        [
          { field: 'title', op: 'contains', value: `Zone ${tag}` },
          { field: 'lastContactedAt', op: 'on', value: '2026-03-10' },
        ],
      ])

      expect(byDefault && (await db.find(objectTable('deals'), { filter: byDefault })).length).toBe(
        1,
      )
    } finally {
      await go(records.deleteRecord('deals', deal.id))
    }
  },
)

exampleTest(
  'a phone number is matched on its digits, in a row, however it is written',
  async () => {
    const mine = `phone${tag}`
    const made: string[] = []

    for (const [name, phone] of [
      ['Real', '(410) 555-0100'],
      ['Near', '410-551-0010'], // has 0, 1, 0, 0 in that order, but not together
      ['Dots', '410.555.0100 x7'],
    ] as const) {
      made.push(
        (await go(records.createRecord('contacts', { name: `${name} ${mine}`, phone }, userA))).id,
      )
    }

    try {
      const obj = crmConfig().objects.contacts

      if (!obj) {
        throw new Error('no contacts object')
      }

      const byPhone = async (typed: string) => {
        const matches = records.matchingText(obj, ['phone'], typed)

        if (!matches) {
          throw new Error('nothing to match')
        }

        const rows = await db.find(objectTable('contacts'), {
          select: ['id', 'name'],
          filter: and(contains('name', mine), matches),
        })

        return rows.map((r) => String(r.name).split(' ')[0]).sort()
      }

      expect(await byPhone('0100')).toEqual(['Dots', 'Real'])
      expect(await byPhone('5550100')).toEqual(['Dots', 'Real'])
      expect(await byPhone('410 555 0100')).toEqual(['Dots', 'Real'])
      expect(await byPhone('(410) 551')).toEqual(['Near'])
      expect(await byPhone('x7')).toEqual(['Dots']) // not digits: matched as text
      expect(await byPhone('9999')).toEqual([])
    } finally {
      for (const contactId of made) {
        await go(records.deleteRecord('contacts', contactId))
      }
    }
  },
)

exampleTest('a private view can be deleted only by its maker', async () => {
  const mine = await go(
    views.createView('deals', { label: `Secret ${tag}`, type: 'table', private: true }, userA),
  )

  const shared = await go(views.createView('deals', { label: `Open ${tag}`, type: 'table' }, userA))
  await expect(go(views.deleteView('deals', mine, userB))).rejects.toThrow('View not found')
  expect((await go(views.resolveViews('deals', userA))).some((v) => v.id === mine)).toBe(true)
  // A shared view is anyone's to delete, as it is anyone's to change.
  await go(views.deleteView('deals', shared, userB))
  expect((await go(views.resolveViews('deals', userA))).some((v) => v.id === shared)).toBe(false)
  await go(views.deleteView('deals', mine, userA))
  expect((await go(views.resolveViews('deals', userA))).some((v) => v.id === mine)).toBe(false)
})

exampleTest('a view saved before filters had operators is read as it was meant', async () => {
  // The row as the app wrote it then: one sort, and a map of exact values, one of them a stage since removed.
  const old = await db.insert(SavedView, {
    objectKey: 'deals',
    key: null,
    label: `Old ${tag}`,
    type: 'table',
    settings: JSON.stringify({
      columns: ['title', 'value', 'nope'],
      sort: { field: 'value', dir: 'desc' },
      filters: { stage: 'won' },
      cardFields: [],
      calculations: {},
    }),
    createdBy: userA,
  })

  const gone = await db.insert(SavedView, {
    objectKey: 'deals',
    key: null,
    label: `Gone ${tag}`,
    type: 'table',
    settings: JSON.stringify({ columns: ['title'], filters: { stage: 'retired' } }),
    createdBy: userA,
  })

  const resolved = await go(views.resolveViews('deals', userA))
  const view = resolved.find((v) => v.id === old.id)

  expect(view?.settings).toMatchObject({
    columns: ['title', 'value'],
    sort: [{ field: 'value', dir: 'desc' }],
    filters: [[{ field: 'stage', op: 'in', value: ['won'] }]],
  })

  const scoped = (filters: Filters): Filters =>
    filters.map((g) => [...g, { field: 'title', op: 'contains', value: tag }])

  const rows = await go(
    records.listRecords({ objectKey: 'deals', filters: scoped(view?.settings.filters ?? []) }),
  )

  expect(rows.map((r) => r.title)).toEqual([`Kitchen ${tag}`])
  // It showed nothing once its stage was removed, and still does: not every deal.
  const stale = resolved.find((v) => v.id === gone.id)
  expect(stale?.settings.filters).toEqual([[{ field: 'stage', op: 'in', value: ['retired'] }]])

  expect(
    await go(records.countMatching({ objectKey: 'deals', filters: stale?.settings.filters })),
  ).toBe(0)
})

exampleTest(
  "filters in the page address replace the view's; an empty list means none, and nothing means the view's",
  async () => {
    const saved: Filters = [[{ field: 'stage', op: 'in', value: ['won'] }]]
    const sort: Sort[] = [{ field: 'value', dir: 'desc' }]

    const id2 = await go(
      views.createView(
        'deals',
        { label: `Addr ${tag}`, type: 'table', settings: { filters: saved, sort } },
        userA,
      ),
    )

    const view = (await go(views.resolveViews('deals', userA))).find((v) => v.id === id2)

    if (!view) {
      throw new Error('no view')
    }

    expect(views.activeSettings('deals', view, {})).toEqual({ filters: saved, sort })

    expect(views.activeSettings('deals', view, { filters: [], sort: [] })).toEqual({
      filters: [],
      sort: [],
    })

    expect(
      views.activeSettings('deals', view, {
        filters: [[{ field: 'value', op: 'gt', value: '5,000' }]],
      }),
    ).toEqual({
      filters: [[{ field: 'value', op: 'gt', value: 5000 }]],
      sort,
    })

    // What an edited address may carry is trimmed to what the app allows, not refused.
    const huge = Array.from({ length: 50 }, () =>
      Array.from({ length: 50 }, () => ({ field: 'value', op: 'gt', value: 1 })),
    )

    const trimmed = views.activeSettings('deals', view, {
      filters: huge,
      sort: [{ field: 'x'.repeat(900), dir: 'asc' }],
    })

    expect(trimmed.filters).toHaveLength(4)
    expect(trimmed.filters.flat()).toHaveLength(40)
    expect(trimmed.sort).toEqual([])
  },
)
