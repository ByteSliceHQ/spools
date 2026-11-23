import { afterAll, beforeAll, expect } from 'bun:test'

import * as records from '../../src/server/records'
import { deepSearch, quickIndex, suggestValues } from '../../src/server/search'
import { Note, SavedView, Task } from '../../src/server/store/tables'
import * as views from '../../src/server/views'
import * as workspace from '../../src/server/workspace'
import { db, run as go } from '../support/run'
import { exampleTest, isExampleApp } from './example-app'

// Search across records, notes, emails, calls and tasks, and the index the browser is sent.
const tag = `srch${Date.now()}`
const user = { id: `user_${tag}`, name: 'Search Tester' }
const id: Record<string, string> = {}

beforeAll(async () => {
  if (!isExampleApp) {
    return
  }

  const domain = `https://shared-${tag}.test`

  id.company = (
    await go(
      records.createRecord(
        'companies',
        { name: `Harbor ${tag}`, industry: 'finance', domain },
        user.id,
      ),
    )
  ).id

  id.other = (
    await go(records.createRecord('companies', { name: `Quay ${tag}`, domain }, user.id))
  ).id

  id.contact = (
    await go(
      records.createRecord(
        'contacts',
        {
          name: `Priya Raman ${tag}`,
          email: `priya.${tag}@harbor.test`,
          companyId: id.company,
          status: 'qualified',
        },
        user.id,
      ),
    )
  ).id

  id.deal = (
    await go(
      records.createRecord(
        'deals',
        { title: `Galley refit ${tag}`, stage: 'proposal', companyId: id.company },
        user.id,
      ),
    )
  ).id

  const on = { objectKey: 'deals', recordId: id.deal }

  await go(
    records.addActivity({
      ...on,
      kind: 'email',
      summary: `received an email: Countertop samples ${tag}`,
      body: `The quartz backsplash tiles arrive on Tuesday. Reference ${tag}.`,
      outcome: 'received',
    }),
  )

  await go(
    records.addActivity({
      ...on,
      kind: 'meeting',
      summary: 'logged a meeting: Completed',
      body: `Walked the site with the plumber ${tag}`,
    }),
  )

  await go(
    records.addActivity({
      ...on,
      kind: 'change',
      summary: `changed Stage to Proposal ${tag} plumber`,
    }),
  )

  id.note = (
    await go(
      workspace.createNote(
        { title: `Measurements ${tag}`, body: 'Ceiling height is ninety-six inches.', ...on },
        user,
      ),
    )
  ).id

  id.loose = (
    await go(
      workspace.createNote(
        { title: `Supplier terms ${tag}`, body: 'Net thirty, deposits refundable.' },
        user,
      ),
    )
  ).id

  id.task = (await go(workspace.createTask({ title: `Order hinges ${tag}`, ...on }, user.id))).id
})

afterAll(async () => {
  if (!isExampleApp) {
    return
  }

  await db.remove(Task, { where: { createdBy: user.id } })
  await db.remove(Note, { where: { authorId: user.id } })
  await db.remove(SavedView, { where: { createdBy: user.id } })
  await go(records.deleteRecord('deals', id.deal as string))
  await go(records.deleteRecord('contacts', id.contact as string))
  await go(records.deleteRecord('companies', id.company as string))
  await go(records.deleteRecord('companies', id.other as string))
})

const kinds = (hits: { kind: string; title: string }[]) =>
  hits.map((h) => `${h.kind}: ${h.title.replace(` ${tag}`, '')}`)

exampleTest('one search finds records of every object, by any searchable field', async () => {
  const byName = await go(deepSearch(tag))

  expect(new Set(byName.filter((h) => h.kind === 'record').map((h) => h.objectKey))).toEqual(
    new Set(['companies', 'contacts', 'deals']),
  )

  // A field the browser's index is never given (the email address is marked encrypted) is found here, and says where.
  const byEmail = await go(deepSearch(`priya.${tag}@harbor`))

  expect(byEmail.filter((h) => h.kind === 'record')).toEqual([
    {
      kind: 'record',
      id: id.contact as string,
      title: `Priya Raman ${tag}`,
      objectKey: 'contacts',
      recordId: id.contact as string,
      field: 'email',
      snippet: `priya.${tag}@harbor.test`,
    },
  ])

  expect(await go(deepSearch(`nothing-${tag}-matches`))).toEqual([])
  expect(await go(deepSearch('   '))).toEqual([])
})

exampleTest(
  'notes are found by title or body, with word endings and an unfinished last word',
  async () => {
    expect(kinds(await go(deepSearch(`measurements ${tag}`)))).toEqual(['note: Measurements'])
    // "heights" for "height", and "ninety-s" for "ninety-six".
    const body = (await go(deepSearch('ceiling heights'))).filter((h) => h.id === id.note)
    expect(body).toHaveLength(1)

    expect(body[0]).toMatchObject({
      kind: 'note',
      objectKey: 'deals',
      recordId: id.deal,
      recordTitle: `Galley refit ${tag}`,
    })

    expect(body[0]?.snippet).toContain('Ceiling height')
    expect((await go(deepSearch('ceiling ninety-s'))).some((h) => h.id === id.note)).toBe(true)
    // A note that belongs to no record is found too.
    const loose = (await go(deepSearch(`supplier ${tag}`))).find((h) => h.id === id.loose)

    expect(loose).toMatchObject({
      kind: 'note',
      objectKey: null,
      recordId: null,
      recordTitle: null,
    })
  },
)

exampleTest('emails, calls and meetings are found by subject or body; edits are not', async () => {
  const email = (await go(deepSearch(`backsplash tile ${tag}`))).filter((h) => h.kind !== 'record')
  expect(kinds(email)).toEqual(['email: Countertop samples']) // "tile" for "tiles"; the subject without "received an email:"

  expect(email[0]).toMatchObject({
    objectKey: 'deals',
    recordId: id.deal,
    recordTitle: `Galley refit ${tag}`,
  })

  expect(email[0]?.snippet).toContain('quartz backsplash')

  expect(
    kinds((await go(deepSearch(`countertop sampl ${tag}`))).filter((h) => h.kind === 'email')),
  ).toEqual(['email: Countertop samples'])

  // The meeting's notes mention the plumber; so does a stage change, which is not something anyone wrote.
  expect(
    kinds((await go(deepSearch(`plumber ${tag}`))).filter((h) => h.kind !== 'record')),
  ).toEqual(['meeting: logged a meeting: Completed'])

  // Words that are only filler match nothing rather than everything.
  expect(
    (await go(deepSearch('the'))).filter((h) => h.kind === 'email' || h.kind === 'note'),
  ).toEqual([])
})

exampleTest('tasks are found by title', async () => {
  expect(kinds(await go(deepSearch(`hinges order ${tag}`)))).toEqual(['task: Order hinges'])
})

exampleTest(
  "the browser's index holds titles, a telling second line and unencrypted searchable fields",
  async () => {
    const index = await go(quickIndex(undefined, user.id))
    const contacts = index.objects.contacts
    // Name and email are searchable, but both are marked encrypted: only the title (the name) is sent.
    expect(contacts?.fields).toEqual([])

    // The second line comes from the table view's first short columns: here the company and the status.
    expect(contacts?.rows.find((r) => r[0] === id.contact)).toEqual([
      id.contact as string,
      `Priya Raman ${tag}`,
      `Harbor ${tag} · Qualified`,
    ])

    expect(index.objects.companies?.fields).toEqual(['domain'])

    expect(index.objects.companies?.rows.find((r) => r[0] === id.company)).toEqual([
      id.company as string,
      `Harbor ${tag}`,
      'Finance',
      `https://shared-${tag}.test`,
    ])

    expect(index.objects.deals?.rows.find((r) => r[0] === id.deal)?.[2]).toBe(
      `Proposal · Harbor ${tag}`,
    )

    expect(index.objects.deals?.total).toBeGreaterThanOrEqual(1)

    expect(index.notes.rows.find((n) => n[0] === id.note)).toEqual([
      id.note as string,
      `Measurements ${tag}`,
      'deals',
      id.deal as string,
    ])

    expect(index.notes.rows.length).toBe(index.notes.total)
  },
)

exampleTest(
  'asked what changed since a moment, the index holds only that, with every count',
  async () => {
    const before = await go(quickIndex(undefined, user.id))
    await new Promise((resolve) => setTimeout(resolve, 2100)) // the index is stamped two seconds early, on purpose
    const quiet = await go(quickIndex(new Date(), user.id))
    expect(quiet.objects.deals?.rows).toEqual([])
    expect(quiet.objects.deals?.total).toBe(before.objects.deals?.total as number)

    // "Since" is exclusive, and an update can land in the millisecond it is asked for.
    const since = new Date(Date.now() - 5)

    await go(
      records.updateRecord('deals', id.deal as string, { title: `Galley refit renamed ${tag}` }),
    )

    await go(workspace.updateNote(id.loose as string, { title: `Supplier terms renamed ${tag}` }))
    const changed = await go(quickIndex(since, user.id))
    expect(changed.objects.deals?.rows.map((r) => r[1])).toEqual([`Galley refit renamed ${tag}`])
    expect(changed.objects.contacts?.rows).toEqual([])
    expect(changed.notes.rows.map((n) => n[1])).toEqual([`Supplier terms renamed ${tag}`])
    expect(changed.notes.total).toBe(before.notes.total)
    await go(records.updateRecord('deals', id.deal as string, { title: `Galley refit ${tag}` }))
  },
)

exampleTest(
  "the index lists views made in the app, except other people's private ones",
  async () => {
    const shared = await go(
      views.createView('deals', { label: `Shared ${tag}`, type: 'table' }, user.id),
    )

    const hidden = await go(
      views.createView('deals', { label: `Private ${tag}`, type: 'table', private: true }, user.id),
    )

    const mine = (await go(quickIndex(undefined, user.id))).views.map((v) => v.id)
    const theirs = (await go(quickIndex(undefined, 'someone_else'))).views.map((v) => v.id)
    expect(mine).toContain(shared)
    expect(mine).toContain(hidden)
    expect(theirs).toContain(shared)
    expect(theirs).not.toContain(hidden)
  },
)

exampleTest(
  'values several records share are offered as filters, with how many hold each',
  async () => {
    expect(await go(suggestValues('companies', `shared-${tag}`))).toEqual([
      { field: 'domain', value: `https://shared-${tag}.test`, count: 2 },
    ])

    // One record's own value isn't a filter worth offering; search finds it.
    expect(await go(suggestValues('contacts', `priya.${tag}`))).toEqual([])
    expect(await go(suggestValues('companies', 'x'))).toEqual([]) // too little to go on
  },
)
