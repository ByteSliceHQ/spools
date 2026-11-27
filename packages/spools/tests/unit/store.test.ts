import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { PGlite } from '@electric-sql/pglite'
import { Effect, Exit, Layer } from 'effect'

import { pglite } from '../../src/adapters/database/pglite/server'
import { connection } from '../../src/adapters/database/postgres/server'
import { crmConfigSchema } from '../../src/crm/config-schema'
import { httpLayer } from '../../src/server/runtime/http'
import { objectTables } from '../../src/server/store/objects'
import {
  contains,
  desc,
  oneOf,
  or,
  type OrderBy,
  type Predicate,
  search,
  some,
} from '../../src/server/store/query'
import { allTables, schemaSql } from '../../src/server/store/schema-sql'
import { placeholders, relatedOrderText, selectSql, updateSql } from '../../src/server/store/sql'
import { Store, type StoreShape } from '../../src/server/store/store'
import { GuideProgress, Note, SequenceRun, Task } from '../../src/server/store/tables'
import { testRuntime } from '../../src/testing/run'
import example from '../fixtures/example.config.json' with { type: 'json' }

// The store's promises, on Postgres in this process. The integration tests put
// every adapter through the same server code (TEST_STORE); these are the parts
// that are easiest to get wrong in a new one.

const config = crmConfigSchema.parse(example)
const tables = objectTables(config)

const object = (key: string) => {
  const table = tables[key]

  if (!table) {
    throw new Error(`The example config has no ${key}`)
  }

  return table
}

const client = await PGlite.create()

for (const statement of schemaSql(allTables(config))) {
  await client.exec(statement)
}

const rt = testRuntime(pglite({ client }).layer.pipe(Layer.provide(httpLayer())))

const use = <A, E>(work: (store: StoreShape) => Effect.Effect<A, E>) =>
  rt.runPromise(Store.use(work))

afterAll(async () => {
  await rt.dispose()
  await client.close()
})

describe('a store', () => {
  test('fills in ids, times, defaults and empty columns, and gives back what the table describes', async () => {
    const task = await use((s) => s.insert(Task, { title: 'Call back', dueDate: '2026-02-28' }))
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(task.createdAt).toBeInstanceOf(Date)
    expect(task.updatedAt).toBeInstanceOf(Date)
    expect(task.completedAt).toBeNull()
    // A day stays the day it is, wherever the server is.
    expect(task.dueDate).toBe('2026-02-28')

    const run = await use((s) =>
      s.insert(SequenceRun, {
        campaignKey: 'c',
        objectKey: 'contacts',
        recordId: 'r',
        status: 'active',
      }),
    )

    expect(run.attempts).toBe(0)
  })

  test('money keeps its cents, as text', async () => {
    const deal = await use((s) =>
      s.insert(object('deals'), { title: 'Cents', value: '90071992547.10' }),
    )

    expect(deal['value']).toBe('90071992547.10')
  })

  test('a change says how many rows it made, and moves the time they changed', async () => {
    const note = await use((s) => s.insert(Note, { title: 'Before', body: '' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await use((s) => s.update(Note, { where: { id: note.id } }, { title: 'After' }))).toBe(1)
    const after = await use((s) => s.first(Note, { where: { id: note.id } }))
    expect(after?.title).toBe('After')
    expect(after?.updatedAt.getTime()).toBeGreaterThan(note.updatedAt.getTime())

    expect(await use((s) => s.update(Note, { where: { id: 'nobody' } }, { title: 'After' }))).toBe(
      0,
    )
  })

  test('of two callers making the same change to a row, exactly one is told it did', async () => {
    const dueAt = new Date('2026-05-01T12:00:00.123Z')

    const run = await use((s) =>
      s.insert(SequenceRun, {
        campaignKey: 'c2',
        objectKey: 'contacts',
        recordId: 'r',
        status: 'active',
        dueAt,
      }),
    )

    const hold = use((s) =>
      Effect.all(
        [1, 2, 3].map((n) =>
          s.update(
            SequenceRun,
            { where: { id: run.id, status: 'active', dueAt } },
            { dueAt: new Date(dueAt.getTime() + n * 1000) },
          ),
        ),
        { concurrency: 'unbounded' },
      ),
    )

    expect((await hold).sort()).toEqual([0, 0, 1])
  })

  test('breaking a uniqueness rule is a DatabaseError', async () => {
    const row = { userId: 'u', guideId: 'g', outcome: 'finished' }
    await use((s) => s.insert(GuideProgress, row))
    const error = await use((s) => Effect.flip(s.insert(GuideProgress, row)))
    expect(error._tag).toBe('DatabaseError')
    expect(error.message).toContain('duplicate key')
  })

  test('a change or a delete with no condition is refused: it would reach every row', async () => {
    const exits = await use((s) =>
      Effect.all([
        Effect.exit(s.remove(Task, {})),
        Effect.exit(s.update(Task, { where: {} }, { title: 'x' })),
      ]),
    )

    expect(exits.every(Exit.isFailure)).toBe(true)
    expect(await use((s) => s.count(Task))).toBeGreaterThan(0)
  })

  test('null in `where` means empty', async () => {
    const before = await use((s) => s.count(Task, { where: { completedAt: null } }))
    const done = await use((s) => s.insert(Task, { title: 'Done', completedAt: new Date() }))
    expect(await use((s) => s.count(Task, { where: { completedAt: null } }))).toBe(before)
    await use((s) => s.remove(Task, { where: { id: done.id } }))
  })

  test('related records come back with the rows, whole or in part, and empty when there are none', async () => {
    const company = await use((s) => s.insert(object('companies'), { name: 'Initech' }))

    const deal = await use((s) =>
      s.insert(object('deals'), { title: 'Linked', companyId: company.id }),
    )

    const alone = await use((s) => s.insert(object('deals'), { title: 'Alone' }))

    const rows = await use((s) =>
      s.find(object('deals'), {
        select: ['id', 'title'],
        include: { company: ['name'], contact: 'all' },
        filter: oneOf('id', [deal.id, alone.id]),
        order: [desc('title')],
      }),
    )

    expect(rows.map((r) => [r['title'], r['company'], r['contact']])).toEqual([
      ['Linked', { id: company.id, name: 'Initech' }, null],
      ['Alone', null, null],
    ])

    // Both ways along a relation.
    expect(
      (
        await use((s) =>
          s.find(object('companies'), {
            filter: some('dealsViaCompany', contains('title', 'LINK')),
          }),
        )
      ).length,
    ).toBe(1)
  })

  test('text is searched by stemmed words, with the last one unfinished, and never as an operator', async () => {
    await use((s) =>
      s.insert(Note, { title: 'Cabinets', body: 'The quartz backsplash arrives Tuesday' }),
    )

    const find = (text: string) => use((s) => s.count(Note, { filter: search(text) }))
    expect(await find('cabinet quartz backs')).toBe(1)
    expect(await find('quartz granite')).toBe(0)

    for (const odd of ["'", "a' | b:*", '\\', '!', '& |', "''':*", "it's (", "quartz \\'"]) {
      expect(typeof (await find(odd))).toBe('number')
    }
  })

  test('what someone typed is a value, whatever is in it', async () => {
    const typed = `'; DROP TABLE "notes"; --`
    const note = await use((s) => s.insert(Note, { title: typed, body: '' }))

    expect(
      (await use((s) => s.find(Note, { filter: contains('title', typed) }))).map((n) => n.id),
    ).toEqual([note.id])

    // % and _ are themselves, not wildcards.
    expect(await use((s) => s.count(Note, { filter: contains('title', '%') }))).toBe(0)
  })

  test('an order by a related record’s column can carry a condition: a record that fails it sorts as none', async () => {
    const deals = object('deals')

    const [zed, acme] = await Promise.all(
      ['Zed order co', 'Acme order co'].map((name) =>
        use((s) => s.insert(object('companies'), { name })),
      ),
    )

    const made = await Promise.all(
      [
        ['Order 3', zed?.id],
        ['Order 2', acme?.id],
        ['Order 1', null],
      ].map(([title, companyId]) => use((s) => s.insert(deals, { title, companyId }))),
    )

    const titles = (by: OrderBy) =>
      use((s) =>
        s.find(deals, {
          filter: oneOf(
            'id',
            made.map((deal) => deal.id),
          ),
          order: [desc(by, 'last'), desc('title')],
        }),
      ).then((rows) => rows.map((row) => row['title']))

    expect(await titles(['company', 'name'])).toEqual(['Order 3', 'Order 2', 'Order 1'])

    // Zed fails the condition, so its deal sorts with the one that has no company.
    expect(
      await titles({ related: ['company', 'name'], where: oneOf('name', ['Acme order co']) }),
    ).toEqual(['Order 2', 'Order 3', 'Order 1'])
  })
})

describe('a transaction', () => {
  const titled = (title: string) => use((s) => s.count(Note, { where: { title } }))

  test('keeps everything the program wrote, and its reads see its own writes', async () => {
    const seen = await use((s) =>
      s.transaction(
        Effect.gen(function* () {
          yield* s.insert(Note, { title: 'Kept one', body: '' })
          yield* s.insert(Note, { title: 'Kept two', body: '' })
          return yield* s.count(Note, { where: { title: 'Kept one' } })
        }),
      ),
    )

    expect(seen).toBe(1)
    expect(await titled('Kept one')).toBe(1)
    expect(await titled('Kept two')).toBe(1)
  })

  test('undoes everything when the program fails, and fails the way the program did', async () => {
    const failure = await rt.runPromise(
      Effect.flip(
        Store.use((s) =>
          s.transaction(
            Effect.gen(function* () {
              yield* s.insert(Note, { title: 'Undone by a failure', body: '' })
              return yield* Effect.fail('refused' as const)
            }),
          ),
        ),
      ),
    )

    expect(failure).toBe('refused')
    expect(await titled('Undone by a failure')).toBe(0)
  })

  test('undoes everything when the program has a bug', async () => {
    const exit = await rt.runPromiseExit(
      Store.use((s) =>
        s.transaction(
          Effect.gen(function* () {
            yield* s.insert(Note, { title: 'Undone by a bug', body: '' })
            return yield* Effect.die(new Error('a bug'))
          }),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await titled('Undone by a bug')).toBe(0)
  })

  test('one inside another is part of the outer one', async () => {
    const failure = await rt.runPromise(
      Effect.flip(
        Store.use((s) =>
          s.transaction(
            Effect.gen(function* () {
              yield* s.transaction(s.insert(Note, { title: 'Inner', body: '' }))
              return yield* Effect.fail('outer refused' as const)
            }),
          ),
        ),
      ),
    )

    expect(failure).toBe('outer refused')
    expect(await titled('Inner')).toBe(0)
  })

  test('a statement the database refuses undoes what came before it', async () => {
    const first = await use((s) =>
      s.insert(GuideProgress, { userId: 'u-tx', guideId: 'g', outcome: 'done' }),
    )

    const exit = await rt.runPromiseExit(
      Store.use((s) =>
        s.transaction(
          Effect.gen(function* () {
            yield* s.insert(Note, { title: 'Before the refusal', body: '' })
            // One row for a person and a guide: a second is refused.

            yield* s.insert(GuideProgress, {
              userId: first.userId,
              guideId: first.guideId,
              outcome: 'done',
            })
          }),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await titled('Before the refusal')).toBe(0)
  })

  test('holding rows says how many are held', async () => {
    const note = await use((s) => s.insert(Note, { title: 'Held', body: '' }))

    const held = await use((s) =>
      s.transaction(
        Effect.all([
          s.lock(Note, { where: { id: note.id } }),
          s.lock(Note, { where: { id: '00000000-0000-4000-8000-000000000000' } }),
        ]),
      ),
    )

    expect(held).toEqual([1, 0])
  })
})

describe('SQL', () => {
  const query = (predicate: Predicate) =>
    selectSql(Task, {
      predicate,
      order: undefined,
      limit: undefined,
      offset: undefined,
      select: ['id'],
      include: undefined,
    })

  test('every value is a parameter', () => {
    const { text, params } = placeholders(
      query(or(contains('title', '50%'), oneOf('id', ['a', 'b']))),
    )

    expect(text).toBe(
      'SELECT t0."id" AS "id" FROM "public"."tasks" t0 WHERE (t0."title" ILIKE $1::text OR t0."id" IN ($2::text, $3::text))',
    )

    expect(params).toEqual(['%50\\%%', 'a', 'b'])
  })

  test("a column or relation the table doesn't have is refused, not written", () => {
    expect(() => query({ op: 'eq', column: 'id" = \'\' OR "1', value: 'x' })).toThrow('No column')
    expect(() => query(some('secrets'))).toThrow('No relation')
    expect(() => updateSql(Task, { op: 'null', column: 'id' }, { nope: 1 })).toThrow('No column')
  })

  test('an empty list of values matches nothing', () => {
    expect(query(oneOf('id', [])).parts.join('')).toContain('WHERE FALSE')
  })

  test('an order by a related record under a condition keeps the condition, with or without parameters', () => {
    const by = { related: ['company', 'name'], where: oneOf('name', ["O'Hara", 'Acme']) } as const

    const { text, params } = placeholders(
      selectSql(object('deals'), {
        predicate: undefined,
        order: [desc(by)],
        limit: undefined,
        offset: undefined,
        select: ['id'],
        include: undefined,
      }),
    )

    expect(text).toBe(
      'SELECT t0."id" AS "id" FROM "public"."deals" t0 ORDER BY (SELECT t1."name" FROM "public"."companies" t1 WHERE t1."id" = t0."company_id" AND t1."name" IN ($1::text, $2::text)) DESC',
    )

    expect(params).toEqual(["O'Hara", 'Acme'])

    // For a driver whose ordering takes no parameters: the same subselect, the values written out.
    expect(relatedOrderText(object('deals'), by)).toEqual({
      parts: [
        '(SELECT spools_related."name" FROM "public"."companies" spools_related WHERE spools_related."id" = ',
        ` AND spools_related."name" IN ('O''Hara', 'Acme'))`,
      ],
      key: 'companyId',
      kind: 'text',
    })

    // A condition that can't be written out is refused, never dropped.
    expect(() =>
      relatedOrderText(object('deals'), { ...by, where: contains('name', 'a') }),
    ).toThrow('cannot be written out')

    expect(() =>
      relatedOrderText(object('deals'), { ...by, where: oneOf('name', ['a\\b']) }),
    ).toThrow('cannot be written out')

    expect(relatedOrderText(object('deals'), { ...by, where: oneOf('name', []) }).parts[1]).toBe(
      ' AND FALSE)',
    )
  })
})

describe('the schema a store makes for itself', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
  })

  afterAll(() => db.close())

  const apply = async (cfg: typeof config) => {
    for (const statement of schemaSql(allTables(cfg))) {
      await db.exec(statement)
    }
  }

  test('can be applied again, and only adds', async () => {
    await apply(config)

    await db.exec(
      `INSERT INTO companies (id, name, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Kept', now(), now())`,
    )

    await apply(config)
    const companies = config.objects['companies']

    if (!companies) {
      throw new Error('The example config has no companies')
    }

    const grown = crmConfigSchema.parse({
      ...example,
      objects: {
        ...example.objects,
        companies: {
          ...example.objects.companies,
          fields: { ...example.objects.companies.fields, tier: { type: 'text', required: true } },
        },
      },
    })

    await apply(grown)

    const { rows } = await db.query<{ name: string; tier: string | null }>(
      'SELECT name, tier FROM companies',
    )

    // A required field added later has no value for the records already there; they are kept all the same.
    expect(rows).toEqual([{ name: 'Kept', tier: null }])
  })
})

describe('reaching a Postgres', () => {
  test('a transaction pooler gets no prepared statements; TLS follows sslmode', () => {
    expect(connection('postgresql://u:p@pooler.example:6543/db?sslmode=no-verify&supa=x')).toEqual({
      url: 'postgresql://u:p@pooler.example:6543/db',
      ssl: { rejectUnauthorized: false },
      prepare: false,
    })

    expect(connection('postgresql://u:p@db.example:5432/db?sslmode=require')).toMatchObject({
      ssl: true,
      prepare: true,
    })

    expect(connection('postgresql://u:p@127.0.0.1:5432/db').ssl).toBeUndefined()
  })
})
