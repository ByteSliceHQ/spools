import { afterAll, expect } from 'bun:test'

import {
  addActivity,
  countRecords,
  createRecord,
  deleteRecord,
  getRecord,
  listActivities,
  listRecords,
  matchTitles,
  searchTitles,
  TITLE_PAGE,
  updateRecord,
} from '../../src/server/records'
import { run as go } from '../support/run'
import { exampleTest, isExampleApp } from './example-app'

// Integration test against the local Supabase database (`bun run db:start`).
const tag = `t${Date.now()}`
const created: { objectKey: string; id: string }[] = []

afterAll(async () => {
  if (!isExampleApp) {
    return
  }

  for (const r of created.reverse()) {
    await go(deleteRecord(r.objectKey, r.id))
  }
})

exampleTest('create, search, include relation, update, delete', async () => {
  const company = await go(
    createRecord(
      'companies',
      { name: `Acme ${tag}`, domain: 'https://acme.test', employees: '42' },
      'user_test',
    ),
  )

  created.push({ objectKey: 'companies', id: company.id })
  expect(company.employees).toBe(42)

  const contact = await go(
    createRecord(
      'contacts',
      { name: `Ada ${tag}`, email: `ada+${tag}@acme.test`, companyId: company.id },
      'user_test',
    ),
  )

  created.push({ objectKey: 'contacts', id: contact.id })
  expect(contact.status).toBe('lead') // config default
  expect(contact.source).toBeNull() // only the website form sets source

  const found = await go(listRecords({ objectKey: 'contacts', q: tag.toUpperCase() }))
  expect(found.map((r) => r.id)).toContain(contact.id)
  const withCompany = found.find((r) => r.id === contact.id) as Record<string, any>
  expect(withCompany.company?.name).toBe(`Acme ${tag}`)

  const deal = await go(
    createRecord(
      'deals',
      { title: `Deal ${tag}`, value: '1234.5', closeDate: '2026-12-01', contactId: contact.id },
      'user_test',
    ),
  )

  created.push({ objectKey: 'deals', id: deal.id })
  expect(deal.value).toBe('1234.50')
  expect(deal.closeDate).toBe('2026-12-01')

  const updated = await go(updateRecord('contacts', contact.id, { status: 'qualified' }))
  expect(updated?.status).toBe('qualified')

  await expect(go(updateRecord('contacts', contact.id, { status: 'bogus' }))).rejects.toThrow()

  await expect(
    go(createRecord('contacts', { email: 'no-name@acme.test' }, 'user_test')),
  ).rejects.toThrow()

  const opts = await go(searchTitles('companies', `acme ${tag}`))
  expect(opts.options).toEqual([{ id: company.id, title: `Acme ${tag}` }])

  const counts = await go(countRecords())
  expect(counts.contacts).toBeGreaterThan(0)

  await go(
    addActivity({ objectKey: 'contacts', recordId: contact.id, kind: 'note', summary: 'hello' }),
  )

  const acts = await go(listActivities('contacts', contact.id))
  expect(acts[0]?.summary).toBe('hello')

  expect((await go(getRecord('contacts', contact.id)))?.id).toBe(contact.id)
})

exampleTest(
  'a list can bring back all of a related record, its title only, or none of it',
  async () => {
    const company = await go(
      createRecord('companies', { name: `Slim ${tag}`, domain: 'https://slim.test' }, 'user_test'),
    )

    const contact = await go(
      createRecord('contacts', { name: `Slim one ${tag}`, companyId: company.id }, 'user_test'),
    )

    created.push(
      { objectKey: 'companies', id: company.id },
      { objectKey: 'contacts', id: contact.id },
    )

    const find = async (relations?: 'full' | 'titles' | 'none') =>
      (
        await go(listRecords({ objectKey: 'contacts', where: { company: company.id }, relations }))
      )[0] as Record<string, any>

    const full = await find()

    expect(full.company).toMatchObject({
      id: company.id,
      name: `Slim ${tag}`,
      domain: 'https://slim.test',
    })

    // What a list shows: enough to name the related record and link to it, and no more.
    const titles = await find('titles')
    expect(titles.company).toEqual({ id: company.id, name: `Slim ${tag}` })
    expect(titles.name).toBe(`Slim one ${tag}`)
    expect(titles.companyId).toBe(company.id)

    const none = await find('none')
    expect(none.company).toBeUndefined()
    expect(none.companyId).toBe(company.id)

    // A board card: a few named fields, and the related record's title where one is among them.
    const [card] = (await go(
      listRecords({
        objectKey: 'contacts',
        where: { company: company.id },
        relations: 'titles',
        fields: ['name', 'company', 'not-a-field'],
      }),
    )) as Record<string, any>[]

    expect(Object.keys(card!).sort()).toEqual([
      'company',
      'companyId',
      'createdAt',
      'id',
      'name',
      'updatedAt',
    ])

    expect(card!.company).toEqual({ id: company.id, name: `Slim ${tag}` })

    const [bare] = (await go(
      listRecords({
        objectKey: 'contacts',
        where: { company: company.id },
        relations: 'titles',
        fields: ['name'],
        sort: { field: 'status', dir: 'asc' },
      }),
    )) as Record<string, any>[]

    expect(Object.keys(bare!).sort()).toEqual(['createdAt', 'id', 'name', 'updatedAt'])
  },
)

exampleTest(
  'titles for many records come back together, and unknown ids are left out',
  async () => {
    const { recordTitlesOf } = await import('../../src/server/records')
    const made = []

    for (let i = 0; i < 3; i++) {
      made.push(await go(createRecord('companies', { name: `Batch ${i} ${tag}` }, 'user_test')))
    }

    created.push(...made.map((c) => ({ objectKey: 'companies', id: c.id })))
    const missing = '00000000-0000-4000-8000-000000000000'

    const titles = await go(
      recordTitlesOf('companies', [...made.map((c) => c.id), made[0]!.id, missing]),
    )

    expect(Object.fromEntries(titles)).toEqual(
      Object.fromEntries(made.map((c, i) => [c.id, `Batch ${i} ${tag}`])),
    )

    expect((await go(recordTitlesOf('companies', []))).size).toBe(0)
  },
)

exampleTest('the keep-warm ping reaches the database', async () => {
  const { Store } = await import('../../src/server/store/store')
  const { run } = await import('../support/run')
  expect(await run(Store.use((store) => store.ping))).toBe(true)
})

exampleTest('deleting a record removes its timeline', async () => {
  const c = await go(createRecord('contacts', { name: `Temp ${tag}` }, 'user_test'))
  await go(addActivity({ objectKey: 'contacts', recordId: c.id, kind: 'note', summary: 'bye' }))
  await go(deleteRecord('contacts', c.id))
  expect(await go(listActivities('contacts', c.id))).toEqual([])
})

exampleTest(
  'counts honour filters; search spans objects; related records follow relations',
  async () => {
    const { countMatching, relatedRecords } = await import('../../src/server/records')
    const { deepSearch } = await import('../../src/server/search')
    const company = await go(createRecord('companies', { name: `Rel ${tag}` }, 'user_test'))

    const a = await go(
      createRecord(
        'contacts',
        { name: `Rel A ${tag}`, companyId: company.id, status: 'customer' },
        'user_test',
      ),
    )

    const b = await go(
      createRecord('contacts', { name: `Rel B ${tag}`, companyId: company.id }, 'user_test'),
    )

    const deal = await go(
      createRecord('deals', { title: `Rel deal ${tag}`, companyId: company.id }, 'user_test'),
    )

    created.push(
      { objectKey: 'companies', id: company.id },
      { objectKey: 'contacts', id: a.id },
      { objectKey: 'contacts', id: b.id },
      { objectKey: 'deals', id: deal.id },
    )

    expect(
      await go(countMatching({ objectKey: 'contacts', q: `Rel` + ` ` })),
    ).toBeGreaterThanOrEqual(2)

    expect(await go(countMatching({ objectKey: 'contacts', where: { company: company.id } }))).toBe(
      2,
    )

    expect(
      await go(
        countMatching({
          objectKey: 'contacts',
          where: { company: company.id, status: 'customer' },
        }),
      ),
    ).toBe(1)

    const hits = await go(deepSearch(`Rel ${tag}`))

    expect(new Set(hits.filter((h) => h.kind === 'record').map((h) => h.objectKey))).toEqual(
      new Set(['companies', 'contacts', 'deals']),
    )

    const related = await go(relatedRecords('companies', company.id))

    const byObject = Object.fromEntries(
      related.map((g) => [`${g.objectKey}.${g.field}`, g.rows.length]),
    )

    expect(byObject['contacts.company']).toBe(2)
    expect(byObject['deals.company']).toBe(1)
  },
)

exampleTest(
  'a relation picker finds any record by searching, however many the object has',
  async () => {
    // More companies than a picker was ever sent at once (500), and one whose title sorts after all of them.
    const names = Array.from({ length: 520 }, (_, i) => `Bulk ${tag} ${String(i).padStart(4, '0')}`)

    for (let at = 0; at < names.length; at += 40) {
      const batch = await Promise.all(
        names
          .slice(at, at + 40)
          .map((name) => go(createRecord('companies', { name }, 'user_test'))),
      )

      created.push(...batch.map((c) => ({ objectKey: 'companies', id: c.id })))
    }

    const last = await go(
      createRecord(
        'companies',
        { name: `Zzzz 100%_Real ${tag}`, domain: `https://far-${tag}.test` },
        'user_test',
      ),
    )

    created.push({ objectKey: 'companies', id: last.id })

    // Opening the picker: one small page in title order, which says it is not everything.
    const first = await go(searchTitles('companies'))
    expect(first.options).toHaveLength(TITLE_PAGE)
    expect(first.more).toBe(true)

    expect(first.options.map((o) => o.title)).toEqual(
      first.options
        .map((o) => o.title)
        .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    )

    expect(first.options.some((o) => o.id === last.id)).toBe(false)

    // Typing finds the record far past the first 500, whatever the case.
    const found = await go(searchTitles('companies', `  zzzz 100%_real ${tag.toUpperCase()} `))

    expect(found).toEqual({
      options: [{ id: last.id, title: `Zzzz 100%_Real ${tag}` }],
      more: false,
    })

    // `%` and `_` are what was typed, not wildcards.
    expect((await go(searchTitles('companies', `Zzzz 1__%_Real ${tag}`))).options).toEqual([])

    // Other searchable fields narrow it too, as in the list search.
    expect(
      (await go(searchTitles('companies', `far-${tag}.test`))).options.map((o) => o.id),
    ).toEqual([last.id])

    // A narrower search that still matches many: a page of them, and more to come.
    const bulk = await go(searchTitles('companies', `Bulk ${tag}`, 10))
    expect(bulk.options.map((o) => o.title)).toEqual(names.slice(0, 10))
    expect(bulk.more).toBe(true)
    // Every word typed must be in the title, wherever it falls: "051" is in 0051 as well as 0510 to 0519.
    const few = await go(searchTitles('companies', `Bulk ${tag} 051`))

    // The tag is the time in digits, so now and then "051" is in it and every name matches.
    const with051 = names.filter((name) => name.slice('Bulk '.length).includes('051'))

    expect(
      [names.slice(51, 52), names.slice(510, 520)].flat().every((n) => with051.includes(n)),
    ).toBe(true)

    expect(few.options.map((o) => o.title)).toEqual(with051.slice(0, TITLE_PAGE))
    expect(few.more).toBe(with051.length > TITLE_PAGE)
  },
  60_000,
)

exampleTest(
  "an import's relation cells are matched against every record, by title or id",
  async () => {
    const made = []

    for (const name of [`Match-One, ${tag} Ltd.`, `Match Two ${tag}`, `Match Three ${tag}`]) {
      made.push(await go(createRecord('companies', { name }, 'user_test')))
    }

    created.push(...made.map((c) => ({ objectKey: 'companies', id: c.id })))
    const [one, two, three] = made as [(typeof made)[0], (typeof made)[0], (typeof made)[0]]

    // A page of 2 makes the search walk through the whole object, several pages of it.
    const found = await go(
      matchTitles('companies', [`match one ${tag} LTD`, three.id, `Nobody ${tag}`], 2),
    )

    expect(found.sort((a, b) => a.title.localeCompare(b.title))).toEqual([
      { id: three.id, title: `Match Three ${tag}` },
      { id: one.id, title: `Match-One, ${tag} Ltd.` },
    ])

    expect(found.some((o) => o.id === two.id)).toBe(false)
  },
  60_000,
)
