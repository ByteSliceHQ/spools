import { afterAll, describe, expect, test } from 'bun:test'

import { PGlite } from '@electric-sql/pglite'
import { Effect, Exit, Layer } from 'effect'

import { pglite } from '../../src/adapters/database/pglite/server'
import { generatePrisma } from '../../src/crm/codegen'
import { toPublicConfig } from '../../src/crm/config'
import { crmConfigSchema } from '../../src/crm/config-schema'
import { mapCsv, relationCells } from '../../src/crm/csv'
import {
  arityOf,
  cleanFilters,
  cleanSort,
  describe as describeCondition,
  type Op,
  operatorsFor,
  relationIds,
} from '../../src/crm/filters'
import { compileFilters } from '../../src/server/filter-query'
import { httpLayer } from '../../src/server/runtime/http'
import { linkSide, linkTables, objectTables } from '../../src/server/store/objects'
import { and, asc, eq, none, oneOf, or, some } from '../../src/server/store/query'
import { allTables, schemaSql } from '../../src/server/store/schema-sql'
import { Store, type StoreShape } from '../../src/server/store/store'
import { testRuntime } from '../../src/testing/run'
import example from '../fixtures/example.config.json' with { type: 'json' }
import { relationsConfig, useRelationsSpool } from '../support/relations-spool'

// Many-to-many relations (`"type": "relations"`): what the config accepts, what
// is generated from it, and how its filters become store conditions.

const baseline = (name: string) =>
  Bun.file(new URL(`../fixtures/baseline/${name}`, import.meta.url)).text()

type Json = Record<string, any>

/** The fixture, with one change made to a copy of it. */
function changed(change: (config: Json) => void) {
  const copy: Json = structuredClone(relationsConfig)
  change(copy)
  return crmConfigSchema.safeParse(copy)
}

/** Every problem found, as "path: message". */
const problems = (result: ReturnType<typeof changed>) =>
  result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('a config without many-to-many relations', () => {
  const config = crmConfigSchema.parse(example)

  test('generates the Prisma schema it did before', async () => {
    expect(generatePrisma(config).schema).toBe(await baseline('example.schema.prisma'))
  })

  test('makes the tables it did before', async () => {
    expect(`${schemaSql(allTables(config)).join(';\n')};\n`).toBe(
      await baseline('example.schema.sql'),
    )
  })
})

describe('the config', () => {
  test('accepts relations to another object, to the same object, and an inverse', () => {
    expect(problems(changed(() => undefined))).toEqual([])
  })

  test('refuses a target that is not an object', () => {
    const result = changed((c) => {
      c['objects'].people.fields.teams.to = 'nowhere'
    })

    expect(problems(result)).toEqual(['objects.people.fields.teams.to: unknown object "nowhere"'])
  })

  test('refuses an inverse that is not a relations field pointing back', () => {
    const missing = changed((c) => {
      c['objects'].tags.fields.people.inverse = 'labels'
    })

    expect(problems(missing)).toEqual([
      'objects.tags.fields.people.inverse: people has no relations field "labels"',
    ])

    const elsewhere = changed((c) => {
      c['objects'].teams.fields.members = { type: 'relations', to: 'people', inverse: 'tags' }
    })

    expect(problems(elsewhere)).toContain(
      'objects.teams.fields.members.inverse: people.tags leads to tags, not teams',
    )

    const single = changed((c) => {
      c['objects'].tags.fields.people.inverse = 'company'
    })

    expect(problems(single)).toEqual([
      'objects.tags.fields.people.inverse: people has no relations field "company"',
    ])
  })

  test('refuses two fields that each name the other, and two inverses of one field', () => {
    const both = changed((c) => {
      c['objects'].people.fields.tags.inverse = 'people'
    })

    expect(problems(both).join('\n')).toContain(
      'name each other: set "inverse" on one of them only',
    )

    const twice = changed((c) => {
      c['objects'].tags.fields.everyone = { type: 'relations', to: 'people', inverse: 'tags' }
    })

    expect(problems(twice).join('\n')).toContain('people.tags already has an inverse')
  })

  test('refuses names the field needs for itself', () => {
    const ids = changed((c) => {
      c['objects'].people.fields.tagsIds = { type: 'text' }
    })

    expect(problems(ids).join('\n')).toContain(
      '"tagsIds" is reserved by the relations field "tags"',
    )

    const count = changed((c) => {
      c['objects'].people.fields.tagsCount = { type: 'number' }
    })

    expect(problems(count).join('\n')).toContain(
      '"tagsCount" is reserved by the relations field "tags"',
    )
  })

  test("refuses a links table that would be another table's", () => {
    const result = changed((c) => {
      c['objects'].peopleTags = structuredClone(c['objects'].teams)
    })

    expect(problems(result).join('\n')).toContain('"people_tags"')
  })

  test('refuses what a field with no column of its own cannot do', () => {
    const sorted = changed((c) => {
      c['objects'].people.views[0].sort = { field: 'tags', dir: 'asc' }
    })

    expect(problems(sorted).join('\n')).toContain('can\'t sort by "tags"')

    const title = changed((c) => {
      c['objects'].people.titleField = 'tags'
    })

    expect(problems(title).join('\n')).toContain('titleField')

    const searchable = changed((c) => {
      c['objects'].people.fields.tags.searchable = true
    })

    expect(problems(searchable).join('\n')).toContain('only text-like fields can be searchable')

    const grouped = changed((c) => {
      c['objects'].people.views[2].groupBy = 'tags'
    })

    expect(problems(grouped).join('\n')).toContain('board views must group by a select field')
  })

  test('checks a view filter on a relations field like any other', () => {
    const wrong = changed((c) => {
      c['objects'].people.views[1].filters = [{ field: 'tags', op: 'contains', value: 'vip' }]
    })

    expect(problems(wrong).join('\n')).toContain('can\'t filter by "tags" this way')
  })
})

describe('what is generated', () => {
  const config = () => crmConfigSchema.parse(relationsConfig)

  test('a links table for each field that owns one, and none for an inverse', () => {
    const names = allTables(config()).map((t) => t.name)

    expect(names).toEqual(
      expect.arrayContaining(['people_tags', 'people_teams', 'people_mentors', 'companies_tags']),
    )

    expect(names).not.toContain('tags_people')
  })

  test('the Prisma schema: both foreign keys, one row per pair, rows that go with either record', () => {
    const { schema } = generatePrisma(config())
    const model = schema.slice(schema.indexOf('model PeopleTags {'))
    const body = model.slice(0, model.indexOf('\n}'))

    expect(body).toContain('sourceId String @map("source_id")')
    expect(body).toContain('targetId String @map("target_id")')

    expect(body).toContain(
      'source People @relation("PeopleTags_source", fields: [sourceId], references: [id], onDelete: Cascade)',
    )

    expect(body).toContain(
      'target Tag @relation("PeopleTags_target", fields: [targetId], references: [id], onDelete: Cascade)',
    )

    expect(body).toContain('@@unique([sourceId, targetId])')
    expect(body).toContain('@@map("people_tags")')
    expect(body).toContain('@@rls')
    // Each object's model names its side of the links table.
    expect(schema).toContain('tagsLinks PeopleTags[] @relation("PeopleTags_source")')
    expect(schema).toContain('peopleLinks PeopleTags[] @relation("PeopleTags_target")')
    expect(schema).not.toContain('undefined')
  })

  test('the SQL: the table, its unique pair and foreign keys that delete its rows', () => {
    const sql = schemaSql(allTables(config())).join('\n')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "public"."people_tags"')

    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "people_tags_source_id_target_id_key" ON "public"."people_tags" \("source_id", "target_id"\)/,
    )

    expect(sql).toMatch(
      /FOREIGN KEY \("source_id"\)\s+REFERENCES "public"."people" \("id"\) ON DELETE CASCADE/,
    )

    expect(sql).toMatch(
      /FOREIGN KEY \("target_id"\)\s+REFERENCES "public"."tags" \("id"\) ON DELETE CASCADE/,
    )

    // The other end is looked up too ("which people have this tag").
    expect(sql).toContain('"people_tags_target_id_idx"')
  })
})

describe('the links table, in a store', async () => {
  const config = crmConfigSchema.parse(relationsConfig)
  const { people, tags } = objectTables(config)
  const side = linkSide(config, 'people', 'tags')
  const inverse = linkSide(config, 'tags', 'people')

  if (!people || !tags || !side || !inverse) {
    throw new Error('The fixture has no people.tags')
  }

  const client = await PGlite.create()

  for (const statement of schemaSql(allTables(config))) {
    await client.exec(statement)
  }

  const rt = testRuntime(pglite({ client }).layer.pipe(Layer.provide(httpLayer())))

  const use = <A, E>(work: (store: StoreShape) => Effect.Effect<A, E>) =>
    rt.runPromise(Store.use(work))

  const names = async (table: typeof people, filter: ReturnType<typeof some>) =>
    (await use((s) => s.find(table, { filter, order: [asc('name')] }))).map((r) => r['name'])

  afterAll(async () => {
    await rt.dispose()
    await client.close()
  })

  test('is described once, from either side', () => {
    expect(linkTables(config).map((l) => [l.table.name, l.source, l.target])).toEqual([
      [
        'companies_tags',
        { objectKey: 'companies', field: 'tags' },
        { objectKey: 'tags', field: undefined },
      ],
      [
        'people_tags',
        { objectKey: 'people', field: 'tags' },
        { objectKey: 'tags', field: 'people' },
      ],
      [
        'people_teams',
        { objectKey: 'people', field: 'teams' },
        { objectKey: 'teams', field: undefined },
      ],
      [
        'people_mentors',
        { objectKey: 'people', field: 'mentors' },
        { objectKey: 'people', field: undefined },
      ],
    ])

    expect(inverse.link).toBe(side.link)
    expect([side.relation, side.near, side.far, side.to]).toEqual([
      'tagsLinks',
      'sourceId',
      'targetId',
      'tags',
    ])

    expect([inverse.relation, inverse.near, inverse.far, inverse.to]).toEqual([
      'peopleLinks',
      'targetId',
      'sourceId',
      'people',
    ])

    expect(linkSide(config, 'people', 'company')).toBeUndefined()
  })

  test('holds each pair once, answers conditions through its relations, and loses its rows with either record', async () => {
    const links = side.link.table
    const ada = await use((s) => s.insert(people, { name: 'Ada' }))
    const alan = await use((s) => s.insert(people, { name: 'Alan' }))
    const vip = await use((s) => s.insert(tags, { name: 'VIP' }))
    const partner = await use((s) => s.insert(tags, { name: 'Partner' }))

    await use((s) => s.insert(links, { sourceId: ada.id, targetId: vip.id }))
    await use((s) => s.insert(links, { sourceId: ada.id, targetId: partner.id }))
    await use((s) => s.insert(links, { sourceId: alan.id, targetId: vip.id }))

    const twice = await rt.runPromiseExit(
      Store.use((s) => s.insert(links, { sourceId: ada.id, targetId: vip.id })),
    )

    expect(Exit.isFailure(twice)).toBe(true)

    const dangling = await rt.runPromiseExit(
      Store.use((s) => s.insert(links, { sourceId: ada.id, targetId: crypto.randomUUID() })),
    )

    expect(Exit.isFailure(dangling)).toBe(true)

    expect(await names(people, some('tagsLinks', oneOf('targetId', [partner.id])))).toEqual(['Ada'])
    expect(await names(people, none('tagsLinks', oneOf('targetId', [partner.id])))).toEqual([
      'Alan',
    ])

    expect(await names(tags, some('peopleLinks', eq('sourceId', alan.id)))).toEqual(['VIP'])

    // A link's own relations lead to the records at its ends.
    const found = await use((s) =>
      s.find(links, { where: { sourceId: ada.id }, include: { target: ['name'] } }),
    )

    expect(
      found.map((row) => (row as unknown as { target: { name: string } }).target.name).sort(),
    ).toEqual(['Partner', 'VIP'])

    await use((s) => s.remove(tags, { where: { id: vip.id } }))
    expect(await use((s) => s.count(links))).toBe(1)
    await use((s) => s.remove(people, { where: { id: ada.id } }))
    expect(await use((s) => s.count(links))).toBe(0)
  })
})

describe('filters', () => {
  useRelationsSpool()

  const objects = () => crmConfigSchema.parse(relationsConfig).objects
  const tags = () => objects()['people']!.fields['tags']!

  test('a relations field has its own operators, each with the values it takes', () => {
    expect(operatorsFor(tags())).toEqual(['anyOf', 'allOf', 'noneOf', 'empty', 'notEmpty'])
    expect([arityOf('anyOf'), arityOf('allOf'), arityOf('noneOf')]).toEqual([
      'many',
      'many',
      'many',
    ])
  })

  test('cleaning keeps them, drops other operators and bounds "has all of"', () => {
    const kept = cleanFilters(objects(), 'people', [
      { field: 'tags', op: 'anyOf', value: [A, B, A] },
      { field: 'tags', op: 'noneOf', value: A },
      { field: 'tags', op: 'empty', value: 'ignored' },
      { field: 'tags', op: 'in', value: [A] },
      { field: 'tags', op: 'anyOf' },
      { field: 'company.tags', op: 'allOf', value: [A] },
    ])

    expect(kept).toEqual([
      [
        { field: 'tags', op: 'anyOf', value: [A, B] },
        { field: 'tags', op: 'noneOf', value: [A] },
        { field: 'tags', op: 'empty' },
        { field: 'company.tags', op: 'allOf', value: [A] },
      ],
    ])

    const many = Array.from({ length: 40 }, (_, i) => `id-${i}`)

    const [[all] = []] = cleanFilters(objects(), 'people', [
      { field: 'tags', op: 'allOf', value: many },
    ])

    expect(all?.value).toHaveLength(10)
  })

  test('a relations field is never sorted by', () => {
    expect(cleanSort(objects(), 'people', [{ field: 'tags' }, { field: 'name' }])).toEqual([
      { field: 'name', dir: 'asc' },
    ])
  })

  test('the records a filter names are found for their titles, and read aloud', () => {
    const filters = cleanFilters(objects(), 'people', [
      { field: 'tags', op: 'allOf', value: [A, B] },
      { field: 'teams', op: 'noneOf', value: [B] },
    ])

    expect(relationIds(objects(), 'people', filters)).toEqual({ tags: [A, B], teams: [B] })

    const ctx = { users: [], title: (_: string, id: string) => (id === A ? 'VIP' : 'Partner') }
    const [first, second] = filters[0] ?? []

    expect(describeCondition(objects(), 'people', first!, ctx)).toEqual({
      label: 'Tags',
      op: 'has all of',
      value: 'VIP and Partner',
    })

    expect(describeCondition(objects(), 'people', second!, ctx)).toEqual({
      label: 'Teams',
      op: 'has none of',
      value: 'Partner',
    })
  })

  test('compile to conditions on the links table through its relation, with no new kind of condition', () => {
    const compiled = (field: string, op: Op, value?: string[]) =>
      compileFilters('people', [[{ field, op, value }]])

    expect(compiled('tags', 'anyOf', [A, B])).toEqual(some('tagsLinks', oneOf('targetId', [A, B])))

    expect(compiled('tags', 'allOf', [A, B])).toEqual(
      and(some('tagsLinks', eq('targetId', A)), some('tagsLinks', eq('targetId', B))),
    )

    expect(compiled('tags', 'noneOf', [A])).toEqual(none('tagsLinks', oneOf('targetId', [A])))
    expect(compiled('tags', 'empty')).toEqual(none('tagsLinks'))
    expect(compiled('tags', 'notEmpty')).toEqual(some('tagsLinks'))
  })

  test('compile from the inverse side, through a relation, and inside "has"', () => {
    expect(compileFilters('tags', [[{ field: 'people', op: 'anyOf', value: [A] }]])).toEqual(
      some('peopleLinks', oneOf('sourceId', [A])),
    )

    // The person's company has the tag.
    expect(
      compileFilters('people', [[{ field: 'company.tags', op: 'anyOf', value: [A] }]]),
    ).toEqual(some('company', some('tagsLinks', oneOf('targetId', [A]))))

    // No company at all has none of them either.
    expect(
      compileFilters('people', [[{ field: 'company.tags', op: 'noneOf', value: [A] }]]),
    ).toEqual(
      or(
        { op: 'null', column: 'companyId' },
        some('company', none('tagsLinks', oneOf('targetId', [A]))),
      ),
    )

    expect(
      compileFilters('companies', [
        [
          {
            field: '~people.company',
            op: 'has',
            where: [{ field: 'tags', op: 'anyOf', value: [A] }],
          },
        ],
      ]),
    ).toEqual(some('peopleViaCompany', some('tagsLinks', oneOf('targetId', [A]))))
  })
})

describe('CSV import', () => {
  const people = () => toPublicConfig(crmConfigSchema.parse(relationsConfig)).objects['people']!

  const table = [
    ['Name', 'Tags', 'Teams'],
    ['Ada', 'VIP; partner', 'Support'],
    ['Alan', 'Nobody; VIP', ''],
  ]

  test('every title in a cell is asked about', () => {
    expect(relationCells(people(), table)).toEqual({
      tags: ['VIP', 'partner', 'Nobody'],
      teams: ['Support'],
    })
  })

  test('titles become ids under <field>Ids, and ones that match nothing are left out', () => {
    const known = {
      tags: [
        { id: A, title: 'VIP' },
        { id: B, title: 'Partner' },
      ],
      teams: [{ id: A, title: 'Support' }],
    }

    expect(mapCsv(people(), known, table).rows).toEqual([
      { name: 'Ada', tagsIds: `${A},${B}`, teamsIds: A },
      { name: 'Alan', tagsIds: A },
    ])
  })
})
