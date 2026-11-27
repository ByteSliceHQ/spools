import { expect, test } from 'bun:test'

import type { Transaction } from '@electric-sql/pglite'
import { Deferred, Effect, Exit, Layer } from 'effect'

import * as records from '../../src/server/records'
import { DatabaseError } from '../../src/server/runtime/errors'
import { objectTable } from '../../src/server/spool'
import { placeholders } from '../../src/server/store/sql'
import { type DriverRow, sqlBackend } from '../../src/server/store/sql-store'
import { callbackTransaction, makeStore, Store } from '../../src/server/store/store'
import { Note, Task } from '../../src/server/store/tables'
import * as workspace from '../../src/server/workspace'
import {
  as,
  database,
  installWorld,
  MANY_CONNECTIONS,
  people,
  scopedWorld,
  STORE,
  sys,
} from './scopes-world'

// A row that hangs off a record takes that record's scope, and a record that
// moves takes its rows with it. The two must not pass each other: a note
// stamped with the scope its record is just leaving would stay behind, where
// the people of the old scope still read it.
//
// PGlite has one connection, so two transactions never run at once there: what
// the first two tests hold, on PGlite, is that each side does its work as one
// transaction with the record held, by reading the statements it sends. The
// tests after them run two programs at once on whichever store this is: on a
// Postgres those are two connections, and the holds are the database's own.

/** The tests that read the statements a store sends put a store of their own over the world's PGlite. */
const onPglite = test.skipIf(STORE !== 'pglite')

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

onPglite('a record moves scope with its rows or not at all', async () => {
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

onPglite(
  'a row is hung on a record with the record held, so the record can’t move from under it',
  async () => {
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
          store.update(
            Note,
            { where: { id: note.id } },
            { objectKey: 'contacts', recordId: other },
          ),
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
  },
)

/** How long the first of two programs stays in its transaction once the second has been let go. */
const HELD_FOR = '400 millis'

test('a record can’t be pointed at a record that is moving scope: the later of the two waits, and is refused', async () => {
  const companies = objectTable('companies')
  const contacts = objectTable('contacts')
  const name = MANY_CONNECTIONS ? 'Alder mover (two connections)' : 'Alder mover (one connection)'
  const { id } = await sys(records.createRecord('companies', { name, branch: 'north' }, 'seed'))

  try {
    // Bo holds both branches. One program moves the company South and stays in its transaction;
    // the other, at the same moment, makes a North contact that points at it.
    const [moved, pointed] = await as(
      'bo',
      Effect.gen(function* () {
        const store = yield* Store
        const moving = yield* Deferred.make<void>()

        const move = store.transaction(
          Effect.gen(function* () {
            const changed = yield* store.update(companies, { where: { id } }, { branch: 'south' })
            yield* Deferred.succeed(moving, undefined)
            yield* Effect.sleep(HELD_FOR)
            return changed
          }),
        )

        const point = Deferred.await(moving).pipe(
          Effect.andThen(
            store.insert(contacts, { name: 'Alder latecomer', branch: 'north', companyId: id }),
          ),
          Effect.exit,
        )

        return yield* Effect.all([move, point], { concurrency: 2 })
      }),
      null,
    )

    // The move went through, and the contact found a South company where it looked for a North one.
    expect(moved).toBe(1)
    expect(Exit.isFailure(pointed)).toBe(true)
    expect((await sys(records.getRecord('companies', id)))?.branch).toBe('south')

    expect(
      await sys(Store.use((store) => store.count(contacts, { where: { companyId: id } }))),
    ).toBe(0)
  } finally {
    await sys(
      Store.use((store) => store.remove(objectTable('contacts'), { where: { companyId: id } })),
    )

    await sys(records.deleteRecord('companies', id))
  }
})

test('a record can’t move scope while a record is being pointed at it: the move waits, and is refused', async () => {
  const companies = objectTable('companies')
  const contacts = objectTable('contacts')

  const { id } = await sys(
    records.createRecord('companies', { name: 'Alder stayer', branch: 'north' }, 'seed'),
  )

  try {
    const [pointed, moved] = await as(
      'bo',
      Effect.gen(function* () {
        const store = yield* Store
        const pointing = yield* Deferred.make<void>()

        const point = store.transaction(
          Effect.gen(function* () {
            const made = yield* store.insert(contacts, {
              name: 'Alder early',
              branch: 'north',
              companyId: id,
            })

            yield* Deferred.succeed(pointing, undefined)
            yield* Effect.sleep(HELD_FOR)
            return made
          }),
        )

        const move = Deferred.await(pointing).pipe(
          Effect.andThen(store.update(companies, { where: { id } }, { branch: 'south' })),
          Effect.exit,
        )

        return yield* Effect.all([point, move], { concurrency: 2 })
      }),
      null,
    )

    expect(pointed.companyId).toBe(id)
    expect(Exit.isFailure(moved)).toBe(true)
    expect((await sys(records.getRecord('companies', id)))?.branch).toBe('north')
  } finally {
    await sys(
      Store.use((store) => store.remove(objectTable('contacts'), { where: { companyId: id } })),
    )

    await sys(records.deleteRecord('companies', id))
  }
})

test('a shared record can’t be deleted from under a record being pointed at it from a scope the deleter can’t write', async () => {
  const products = objectTable('products')
  const deals = objectTable('deals')
  const { id } = await sys(records.createRecord('products', { name: 'Reel', sku: 'RL-1' }, 'seed'))

  try {
    // Sam, who writes South, deletes a product nothing points at, and stays in his transaction.
    // Nora, at the same moment, puts it on a North deal. The database makes her wait for him.
    const deleting = Promise.withResolvers<void>()

    const remove = as(
      'sam',
      Effect.gen(function* () {
        const store = yield* Store

        return yield* store.transaction(
          Effect.gen(function* () {
            const removed = yield* store.remove(products, { where: { id } })
            deleting.resolve()
            yield* Effect.sleep(HELD_FOR)
            return removed
          }),
        )
      }),
    )

    await deleting.promise

    const pointed = await as(
      'nora',
      Effect.exit(
        Store.use((store) =>
          store.insert(deals, { title: 'Alder reels', branch: 'north', productId: id }),
        ),
      ),
    )

    // His delete stands, and her deal was never made pointing at nothing.
    expect(await remove).toBe(1)
    expect(Exit.isFailure(pointed)).toBe(true)

    expect(await sys(Store.use((store) => store.count(deals, { where: { productId: id } })))).toBe(
      0,
    )
  } finally {
    await sys(
      Store.use((store) => store.remove(objectTable('deals'), { where: { productId: id } })),
    )

    await sys(Store.use((store) => store.remove(objectTable('products'), { where: { id } })))
  }
})

test('a shared record being pointed at from a scope the deleter can’t write is not deleted: the delete waits, and is refused', async () => {
  const products = objectTable('products')
  const deals = objectTable('deals')
  const { id } = await sys(records.createRecord('products', { name: 'Spool', sku: 'SP-1' }, 'seed'))

  try {
    // Nora puts the product on a North deal and stays in her transaction: nobody else can see
    // the deal yet. Sam deletes the product at the same moment. A count taken before her deal
    // is kept would find nothing in his way, and the delete would then clear her deal.
    const pointing = Promise.withResolvers<void>()

    const point = as(
      'nora',
      Effect.gen(function* () {
        const store = yield* Store

        return yield* store.transaction(
          Effect.gen(function* () {
            const made = yield* store.insert(deals, {
              title: 'Alder spools',
              branch: 'north',
              productId: id,
            })

            pointing.resolve()
            yield* Effect.sleep(HELD_FOR)
            return made
          }),
        )
      }),
    )

    await pointing.promise

    const removed = await as(
      'sam',
      Effect.exit(Store.use((store) => store.remove(products, { where: { id } }))),
    )

    const deal = await point
    expect(Exit.isFailure(removed)).toBe(true)
    expect((await sys(records.getRecord('deals', deal.id)))?.productId).toBe(id)
  } finally {
    await sys(
      Store.use((store) => store.remove(objectTable('deals'), { where: { productId: id } })),
    )

    await sys(Store.use((store) => store.remove(objectTable('products'), { where: { id } })))
  }
})
