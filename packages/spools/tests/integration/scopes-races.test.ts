import { expect, test } from 'bun:test'

import type { Transaction } from '@electric-sql/pglite'
import { Effect, Layer } from 'effect'

import * as records from '../../src/server/records'
import { DatabaseError } from '../../src/server/runtime/errors'
import { objectTable } from '../../src/server/spool'
import { placeholders } from '../../src/server/store/sql'
import { type DriverRow, sqlBackend } from '../../src/server/store/sql-store'
import { callbackTransaction, makeStore, Store } from '../../src/server/store/store'
import { Note, Task } from '../../src/server/store/tables'
import * as workspace from '../../src/server/workspace'
import { as, database, installWorld, people, scopedWorld, sys } from './scopes-world'

// A row that hangs off a record takes that record's scope, and a record that
// moves takes its rows with it. The two must not pass each other: a note
// stamped with the scope its record is just leaving would stay behind, where
// the people of the old scope still read it.
//
// PGlite has one connection, so two transactions never run at once here: what
// these tests hold is that each side does its work as one transaction with the
// record held, which is what keeps them apart on a database with many.

scopedWorld()

const { bo } = people

/**
 * The world's database behind a store of the test's own: every statement is
 * noted in `said`, with where transactions begin and end, and one that
 * `breaks` matches fails as a database that went away would.
 */
function watchedStore(said: string[], breaks: () => RegExp | null) {
  const client = database()
  const transaction = callbackTransaction<Transaction>((work) => client.transaction(work))

  const transact: typeof transaction.transact = (program) =>
    Effect.suspend(() => {
      said.push('BEGIN')
      return transaction.transact(program)
    }).pipe(Effect.ensuring(Effect.sync(() => said.push('END'))))

  return Layer.succeed(
    Store,
    Store.of(
      makeStore(
        sqlBackend((query) => {
          const { text, params } = placeholders(query)
          said.push(text)

          if (breaks()?.test(text)) {
            return Effect.fail(new DatabaseError({ cause: 'The database went away' }))
          }

          return Effect.flatMap(transaction.current, (tx) =>
            Effect.tryPromise({
              try: async () => (await (tx ?? client).query<DriverRow>(text, [...params])).rows,
              catch: (cause) => new DatabaseError({ cause }),
            }),
          )
        }, transact),
      ),
    ),
  )
}

/** A North contact of the test's own, with a note and a task on it. */
const contactWithRows = async (name: string) => {
  const { id } = await sys(records.createRecord('contacts', { name, branch: 'north' }, 'seed'))
  const on = { objectKey: 'contacts', recordId: id }
  await as('bo', workspace.createNote({ title: `${name} note`, body: 'terms', ...on }, bo), null)
  await as('bo', workspace.createTask({ title: `${name} task`, ...on }, bo.id), null)
  return id
}

const scopesOf = async (id: string) => ({
  record: (await sys(records.getRecord('contacts', id)))?.branch,
  notes: (await sys(Store.use((store) => store.find(Note, { where: { recordId: id } })))).map(
    (row) => row.scope,
  ),
  tasks: (await sys(Store.use((store) => store.find(Task, { where: { recordId: id } })))).map(
    (row) => row.scope,
  ),
})

const tidy = async (id: string) => {
  const on = { where: { objectKey: 'contacts', recordId: id } }
  await sys(Store.use((store) => store.remove(Note, on)))
  await sys(Store.use((store) => store.remove(Task, on)))
  await sys(records.deleteRecord('contacts', id))
}

test('a record moves scope with its rows or not at all', async () => {
  const id = await contactWithRows('Alder mover')
  const said: string[] = []
  let breaks: RegExp | null = null
  await installWorld({ store: watchedStore(said, () => breaks) })

  const move = () =>
    as(
      'bo',
      // The store itself, with no transaction of the caller's around it.
      Store.use((store) =>
        store.update(objectTable('contacts'), { where: { id } }, { branch: 'south' }),
      ),
      null,
    )

  try {
    // The database fails as the rows are given the new scope: the record must not have moved.
    breaks = /^UPDATE "public"\."tasks"/
    await expect(move()).rejects.toThrow('went away')
    breaks = null

    expect(await scopesOf(id)).toEqual({ record: 'north', notes: ['north'], tasks: ['north'] })

    said.length = 0
    expect(await move()).toBe(1)
    expect(await scopesOf(id)).toEqual({ record: 'south', notes: ['south'], tasks: ['south'] })

    // One transaction, which holds the record from before it is looked at until its rows have moved.
    const moved = said.slice(said.indexOf('BEGIN'), said.indexOf('END') + 1)
    const at = (pattern: RegExp) => moved.findIndex((text) => pattern.test(text))
    const held = at(/FROM "public"\."contacts".* FOR UPDATE/)
    expect(held).toBeGreaterThan(0)
    expect(at(/^UPDATE "public"\."contacts"/)).toBeGreaterThan(held)
    expect(at(/^UPDATE "public"\."notes"/)).toBeGreaterThan(held)
    expect(at(/^UPDATE "public"\."tasks"/)).toBeGreaterThan(held)
  } finally {
    await installWorld()
    await tidy(id)
  }
})

test('a row is hung on a record with the record held, so the record can’t move from under it', async () => {
  const id = await contactWithRows('Alder holder')
  const other = await contactWithRows('Alder other')
  const said: string[] = []
  await installWorld({ store: watchedStore(said, () => null) })

  /** What the store did from the start of the transaction that holds the record to its end. */
  const heldWork = () => {
    const from = said.findIndex(
      (text, i) => text === 'BEGIN' && /FOR UPDATE/.test(said[i + 1] ?? ''),
    )

    return from < 0 ? [] : said.slice(from, said.indexOf('END', from) + 1)
  }

  const inOrder = (work: string[], ...patterns: RegExp[]) =>
    patterns.map((pattern) => work.findIndex((text) => pattern.test(text)))

  try {
    // A new note: the record is held, its scope read, and the note written, in one transaction.
    said.length = 0

    const note = await as(
      'bo',
      Store.use((store) =>
        store.insert(Note, { title: 'Held', body: '', objectKey: 'contacts', recordId: id }),
      ),
      null,
    )

    expect(note.scope).toBe('north')

    const [held, read, written] = inOrder(
      heldWork(),
      /^SELECT 1 AS "n" FROM "public"\."contacts".* FOR UPDATE/,
      /^SELECT .*"branch".* FROM "public"\."contacts"/,
      /^INSERT INTO "public"\."notes"/,
    )

    expect(held).toBe(1)
    expect(read).toBeGreaterThan(held ?? 0)
    expect(written).toBeGreaterThan(read ?? 0)

    // A note put onto another record: the same, for the record it is going to.
    said.length = 0

    await as(
      'bo',
      Store.use((store) =>
        store.update(Note, { where: { id: note.id } }, { objectKey: 'contacts', recordId: other }),
      ),
      null,
    )

    const [heldOnto, , rewritten] = inOrder(
      heldWork(),
      /^SELECT 1 AS "n" FROM "public"\."contacts".* FOR UPDATE/,
      /^SELECT .*"branch".* FROM "public"\."contacts"/,
      /^UPDATE "public"\."notes"/,
    )

    expect(heldOnto).toBe(1)
    expect(rewritten).toBeGreaterThan(heldOnto ?? 0)

    // A row on a shared object's record, or on none, has nothing to hold: no transaction of its own.
    said.length = 0

    const loose = await as(
      'bo',
      Store.use((store) => store.insert(Note, { title: 'Loose', body: '' })),
      'north',
    )

    expect(said.filter((text) => text === 'BEGIN' || /FOR UPDATE/.test(text))).toEqual([])
    await sys(Store.use((store) => store.remove(Note, { where: { id: loose.id } })))
  } finally {
    await installWorld()
    await tidy(id)
    await tidy(other)
  }
})
