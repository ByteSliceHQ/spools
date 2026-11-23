import { afterAll, expect, test } from 'bun:test'

import { SQL } from 'bun'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { Store, table, type StoreShape } from '@swirls/spools/adapter'

import { bunPostgres } from './bun-postgres'

const url = process.env['EXAMPLES_DATABASE_URL']
const when = test.skipIf(!url)

const Receipt = table.defineTable({
  model: 'ExampleReceipt',
  name: 'example_receipts',
  columns: {
    id: table.id(),
    createdAt: table.createdAt(),
    total: table.float(),
    note: table.optional(table.text()),
  },
  indexes: [],
})

// The connection is made when it is first used, so a skipped test needs none.
const runtime = ManagedRuntime.make(
  bunPostgres(url ?? 'postgresql://localhost/none').layer.pipe(
    Layer.provide(FetchHttpClient.layer),
  ),
)

const use = <A, E>(work: (store: StoreShape) => Effect.Effect<A, E>) =>
  runtime.runPromise(Store.use(work))

afterAll(() => runtime.dispose())

when('keeps rows in Postgres', async () => {
  const admin = new SQL(url ?? '')

  try {
    await admin.unsafe(`drop table if exists example_receipts`)

    await admin.unsafe(
      `create table example_receipts (id text primary key, created_at timestamptz not null, total double precision not null, note text)`,
    )

    const made = await use((store) => store.insert(Receipt, { total: 12.5 }))
    expect(made.createdAt).toBeInstanceOf(Date)

    expect(
      await use((store) => store.update(Receipt, { where: { id: made.id } }, { note: 'paid' })),
    ).toBe(1)

    expect(await use((store) => store.first(Receipt, { where: { note: 'paid' } }))).toMatchObject({
      id: made.id,
      total: 12.5,
    })

    expect(await use((store) => store.remove(Receipt, { where: { id: made.id } }))).toBe(1)
    expect(await use((store) => store.count(Receipt))).toBe(0)

    // A transaction that fails keeps nothing, and one that finishes keeps everything.
    const refused = await runtime.runPromise(
      Effect.flip(
        Store.use((store) =>
          store.transaction(
            Effect.andThen(store.insert(Receipt, { total: 1 }), Effect.fail('refused' as const)),
          ),
        ),
      ),
    )

    expect(refused).toBe('refused')
    expect(await use((store) => store.count(Receipt))).toBe(0)

    await use((store) =>
      store.transaction(
        Effect.all([store.insert(Receipt, { total: 1 }), store.insert(Receipt, { total: 2 })]),
      ),
    )

    expect(await use((store) => store.count(Receipt))).toBe(2)
  } finally {
    await admin.unsafe(`drop table if exists example_receipts`)
    await admin.close()
  }
})
