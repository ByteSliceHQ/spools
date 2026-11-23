import { afterAll, expect } from 'bun:test'

import { Effect } from 'effect'

import * as records from '../../src/server/records'
import { runServer } from '../../src/server/runtime/app'
import * as service from '../../src/server/service'
import { Store } from '../../src/server/store/store'
import { Activity, SequenceRun } from '../../src/server/store/tables'
import { db, run } from '../support/run'
import { exampleTest } from './example-app'

// What the store promises about writes that belong together, on whichever database
// TEST_STORE names. On a real Postgres these are several connections at once.

const tag = `tx${Date.now()}`
const user = { id: 'user_test', email: 'tester@example.com', name: 'Test User' }
const made: string[] = []

afterAll(async () => {
  for (const id of made) {
    await run(records.deleteRecord('contacts', id))
  }

  await db.remove(SequenceRun, { where: { campaignKey: tag } })
})

const named = (name: string) => run(records.listRecords({ objectKey: 'contacts', q: name }))

exampleTest('a change that fails part of the way leaves nothing behind', async () => {
  const failure = await runServer(
    Effect.flip(
      Store.use((store) =>
        store.transaction(
          Effect.gen(function* () {
            yield* records.createRecord('contacts', { name: `Half ${tag}` }, 'test')
            return yield* Effect.fail('stopped' as const)
          }),
        ),
      ),
    ),
  )

  expect(failure).toBe('stopped')
  expect(await named(`Half ${tag}`)).toEqual([])
})

exampleTest('a record is made with the line that says who made it, or not at all', async () => {
  const record = await run(service.createRecord('contacts', { name: `Whole ${tag}` }, user))
  made.push(record.id)

  const timeline = await run(records.listActivities('contacts', record.id))
  expect(timeline.map((a) => a.summary)).toContain('created this contact')
})

exampleTest('changes to one row that each read it first happen one after the other', async () => {
  const row = await db.insert(SequenceRun, {
    campaignKey: tag,
    objectKey: 'contacts',
    recordId: 'r',
    status: 'active',
  })

  // Read the number, then write one more. Without holding the row, some of these would read the same number.
  const once = Store.use((store) =>
    store.transaction(
      Effect.gen(function* () {
        yield* store.lock(SequenceRun, { where: { id: row.id } })
        const now = yield* store.first(SequenceRun, { where: { id: row.id } })

        yield* store.update(
          SequenceRun,
          { where: { id: row.id } },
          { attempts: (now?.attempts ?? 0) + 1 },
        )
      }),
    ),
  )

  await run(
    Effect.all(
      Array.from({ length: 8 }, () => once),
      { concurrency: 'unbounded' },
    ),
  )

  expect((await db.first(SequenceRun, { where: { id: row.id } }))?.attempts).toBe(8)
})

exampleTest(
  'two people changing one record at once both have their change kept and logged',
  async () => {
    const record = await run(service.createRecord('contacts', { name: `Both ${tag}` }, user))
    made.push(record.id)

    await run(
      Effect.all(
        [
          service.updateRecord('contacts', record.id, { status: 'customer' }, user),
          service.updateRecord('contacts', record.id, { phone: '(410) 555-0100' }, user),
        ],
        { concurrency: 'unbounded' },
      ),
    )

    const after = await run(records.getRecord('contacts', record.id))
    expect(after?.['status']).toBe('customer')
    expect(after?.['phone']).toBe('(410) 555-0100')

    const changes = (await run(records.listActivities('contacts', record.id)))
      .filter((a) => a.kind === 'change')
      .map((a) => a.summary)
      .toSorted()

    // A phone number's value is left off the timeline.
    expect(changes).toEqual(['changed Status to Customer', 'updated Phone'])
  },
)

exampleTest('deleting a record takes its timeline with it', async () => {
  const record = await run(service.createRecord('contacts', { name: `Gone ${tag}` }, user))
  expect(await run(service.deleteRecord('contacts', record.id, user))).toBe(true)
  expect(await run(records.getRecord('contacts', record.id))).toBeNull()

  expect(
    await db.find(Activity, { where: { objectKey: 'contacts', recordId: record.id } }),
  ).toEqual([])
})
