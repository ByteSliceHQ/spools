import { describe, expect, test } from 'bun:test'

import { toPublicConfig } from '../../src/crm/config'
import { mapCsv, parseCsv, relationCells } from '../../src/crm/csv'
import type { Hooks } from '../../src/crm/extensions'
import * as records from '../../src/server/records'
import { Invalid } from '../../src/server/runtime/errors'
import { deepSearch, quickIndex } from '../../src/server/search'
import * as service from '../../src/server/service'
import { crmConfig } from '../../src/server/spool'
import { runTool } from '../../src/server/tools'
import { exportCsv } from '../../src/server/workspace'
import { failure, run } from '../../src/testing/run'
import { useRelationsSpool } from '../support/relations-spool'

// Many-to-many relations end to end, on a Spool of its own (PGlite): people
// have tags (which list their people back), are on several teams, and have
// mentors among the other people.

const actor = { id: 'user_test', email: 'tester@example.com', name: 'Test User' }
const seen: { hook: string; ids: unknown; previous?: unknown }[] = []

const hooks: Hooks = {
  afterCreate: ({ objectKey, record }) => {
    if (objectKey === 'people') {
      seen.push({ hook: 'afterCreate', ids: record['tagsIds'] })
    }
  },
  afterUpdate: ({ objectKey, record, previous }) => {
    if (objectKey === 'people') {
      seen.push({ hook: 'afterUpdate', ids: record['tagsIds'], previous: previous['tagsIds'] })
    }
  },
}

useRelationsSpool({ hooks })

const make = async (objectKey: string, values: Record<string, unknown>) =>
  await run(service.createRecord(objectKey, values, actor))

const named = async (objectKey: string, name: string) => (await make(objectKey, { name })).id

const get = async (objectKey: string, id: string) => {
  const record = await run(records.getRecord(objectKey, id))

  if (!record) {
    throw new Error(`No ${objectKey} ${id}`)
  }

  return record
}

const change = async (objectKey: string, id: string, values: Record<string, unknown>) =>
  await run(service.updateRecord(objectKey, id, values, actor))

const timeline = async (objectKey: string, id: string) =>
  (await run(records.listActivities(objectKey, id))).map((a) => a.summary)

const names = async (query: records.ListQuery) =>
  (await run(records.listRecords({ ...query, sort: { field: 'name', dir: 'asc' } }))).map(
    (r) => r['name'],
  )

describe('reading and writing', () => {
  test('a record is created with its related records, and brings back their ids and titles', async () => {
    const vip = await named('tags', 'VIP')
    const partner = await named('tags', 'Partner')

    const ada = await make('people', { name: 'Ada', tagsIds: [vip, partner, vip] })

    // In title order, each once.
    expect(ada['tags']).toEqual([
      { id: partner, name: 'Partner' },
      { id: vip, name: 'VIP' },
    ])

    expect(ada['tagsIds']).toEqual([partner, vip])
    expect(ada['tagsCount']).toBe(2)
    expect(ada['teams']).toEqual([])
    expect(ada['teamsIds']).toEqual([])
    expect(ada['teamsCount']).toBe(0)

    const read = await get('people', ada.id)
    expect(read['tagsIds']).toEqual([partner, vip])

    // The inverse field shows the same links from the other side.
    const tag = await get('tags', vip)
    expect(tag['people']).toEqual([{ id: ada.id, name: 'Ada' }])
    expect(tag['peopleIds']).toEqual([ada.id])

    expect(seen.at(-1)).toEqual({ hook: 'afterCreate', ids: [partner, vip] })
    expect(await timeline('people', ada.id)).toEqual(['created this person'])
  })

  test('an update replaces the set, or adds to it and takes from it', async () => {
    const [a, b, c] = [
      await named('tags', 'Alpha'),
      await named('tags', 'Beta'),
      await named('tags', 'Gamma'),
    ]

    const person = await make('people', { name: 'Grace', tagsIds: [a] })

    const replaced = await change('people', person.id, { tagsIds: [b, c] })
    expect(replaced?.['tagsIds']).toEqual([b, c])
    expect(seen.at(-1)).toEqual({ hook: 'afterUpdate', ids: [b, c], previous: [a] })

    const added = await change('people', person.id, { tagsIds: { add: [a, b], remove: [c] } })
    expect(added?.['tagsIds']).toEqual([a, b])

    // As a form or a CSV row sends it: ids in one string.
    const text = await change('people', person.id, { tagsIds: `${c}, ${a}` })
    expect(text?.['tagsIds']).toEqual([a, c])

    // Fields that aren't mentioned keep their links.
    const renamed = await change('people', person.id, { name: 'Grace H.' })
    expect(renamed?.['tagsIds']).toEqual([a, c])

    const cleared = await change('people', person.id, { tagsIds: '' })
    expect(cleared?.['tagsIds']).toEqual([])
    expect(cleared?.['tags']).toEqual([])

    expect(await timeline('people', person.id)).toEqual(
      expect.arrayContaining([
        'added Tags: Beta, Gamma',
        'removed Tags: Alpha',
        'added Tags: Alpha',
        'removed Tags: Gamma',
        'changed Name to Grace H.',
        'removed Tags: Alpha, Gamma',
      ]),
    )
  })

  test('the inverse field writes the same links', async () => {
    const tag = await named('tags', 'Inverse')
    const person = await named('people', 'Hedy')
    const other = await named('people', 'Joan')

    const changed = await change('tags', tag, { peopleIds: [person, other] })

    expect(changed?.['people']).toEqual([
      { id: person, name: 'Hedy' },
      { id: other, name: 'Joan' },
    ])

    expect((await get('people', person))['tagsIds']).toEqual([tag])

    await change('people', person, { tagsIds: [] })
    expect((await get('tags', tag))['peopleIds']).toEqual([other])
  })

  test('a relation to the same object keeps its direction', async () => {
    const mentor = await named('people', 'Katherine')
    const student = await make('people', { name: 'Mary', mentorsIds: [mentor] })

    expect(student['mentors']).toEqual([{ id: mentor, name: 'Katherine' }])
    expect((await get('people', mentor))['mentorsIds']).toEqual([])

    expect(
      await names({
        objectKey: 'people',
        filters: [[{ field: 'mentors', op: 'anyOf', value: [mentor] }]],
      }),
    ).toEqual(['Mary'])
  })

  test('ids that name nothing are refused, and nothing of the change is kept', async () => {
    const tag = await named('tags', 'Kept')
    const person = await make('people', { name: 'Radia', tagsIds: [tag] })
    const nothing = '99999999-9999-4999-8999-999999999999'

    const refused = await failure(
      service.updateRecord('people', person.id, { name: 'Renamed', tagsIds: [nothing] }, actor),
    )

    expect(refused).toBeInstanceOf(Invalid)
    expect(refused.message).toContain('tagsIds')

    const after = await get('people', person.id)
    expect(after['name']).toBe('Radia')
    expect(after['tagsIds']).toEqual([tag])

    const malformed = await failure(
      service.createRecord('people', { name: 'Nobody', tagsIds: ['not-an-id'] }, actor),
    )

    expect(malformed).toBeInstanceOf(Invalid)
    expect(await names({ objectKey: 'people', q: 'Nobody' })).toEqual([])
  })

  test('a record brings back at most 100, says how many there are, and refuses to replace a set it did not show in full', async () => {
    const tag = await named('tags', 'Crowded')
    const people: string[] = []

    for (let i = 0; i < 101; i++) {
      people.push((await run(records.createRecord('people', { name: `Crowd ${i}` }, 'test'))).id)
    }

    await change('tags', tag, { peopleIds: { add: people.slice(0, 100) } })
    await change('tags', tag, { peopleIds: { add: people.slice(100) } })

    const read = await get('tags', tag)
    expect(read['peopleCount']).toBe(101)
    expect(read['peopleIds']).toHaveLength(100)

    const refused = await failure(
      service.updateRecord('tags', tag, { peopleIds: people.slice(0, 2) }, actor),
    )

    expect(refused).toBeInstanceOf(Invalid)
    expect(refused.message).toContain('peopleIds')

    await change('tags', tag, { peopleIds: { remove: people.slice(0, 100) } })
    expect((await get('tags', tag))['peopleIds']).toEqual([people[100]])

    const tooMany = await failure(
      service.updateRecord('tags', tag, { peopleIds: [...people, ...people] }, actor),
    )

    expect(tooMany).toBeInstanceOf(Invalid)
  })
})

describe('lists, filters and search', () => {
  test('lists bring titles, boards only the fields they ask for', async () => {
    const tag = await named('tags', 'Listed')
    const team = await named('teams', 'Support')
    const person = await make('people', { name: 'Listed Lin', tagsIds: [tag], teamsIds: [team] })

    const [row] = await run(
      records.listRecords({ objectKey: 'people', q: 'Listed Lin', relations: 'titles' }),
    )

    expect(row?.id).toBe(person.id)
    expect(row?.['tags']).toEqual([{ id: tag, name: 'Listed' }])
    expect(row?.['teams']).toEqual([{ id: team, name: 'Support' }])

    const [card] = await run(
      records.listRecords({
        objectKey: 'people',
        q: 'Listed Lin',
        relations: 'titles',
        fields: ['name', 'teams'],
      }),
    )

    expect(card?.['teams']).toEqual([{ id: team, name: 'Support' }])
    expect(card?.['tags']).toBeUndefined()

    const [bare] = await run(
      records.listRecords({ objectKey: 'people', q: 'Listed Lin', relations: 'none' }),
    )

    expect(bare?.['tags']).toBeUndefined()
  })

  test('has any of, has all of, has none of, is empty, is not empty', async () => {
    const [red, blue] = [await named('tags', 'Flt Red'), await named('tags', 'Flt Blue')]
    const acme = await make('companies', { name: 'Flt Acme', tagsIds: [red] })

    await make('people', { name: 'Flt both', tagsIds: [red, blue], companyId: acme.id })
    await make('people', { name: 'Flt red', tagsIds: [red] })
    await make('people', { name: 'Flt blue', tagsIds: [blue] })
    await make('people', { name: 'Flt none' })

    const list = (field: string, op: string, value?: string[]) =>
      names({
        objectKey: 'people',
        q: 'Flt',
        filters: [[{ field, op, ...(value ? { value } : {}) }]] as records.ListQuery['filters'],
      })

    expect(await list('tags', 'anyOf', [red, blue])).toEqual(['Flt blue', 'Flt both', 'Flt red'])
    expect(await list('tags', 'allOf', [red, blue])).toEqual(['Flt both'])
    expect(await list('tags', 'noneOf', [red])).toEqual(['Flt blue', 'Flt none'])
    expect(await list('tags', 'empty')).toEqual(['Flt none'])
    expect(await list('tags', 'notEmpty')).toEqual(['Flt blue', 'Flt both', 'Flt red'])
    // Through the person's company, and with no company at all.
    expect(await list('company.tags', 'anyOf', [red])).toEqual(['Flt both'])
    expect(await list('company.tags', 'noneOf', [red])).toEqual(['Flt blue', 'Flt none', 'Flt red'])

    expect(
      await run(
        records.countMatching({
          objectKey: 'people',
          q: 'Flt',
          filters: [[{ field: 'tags', op: 'anyOf', value: [red] }]],
        }),
      ),
    ).toBe(2)

    // From the inverse side, and inside "has".
    expect(
      await names({
        objectKey: 'tags',
        filters: [
          [{ field: 'people', op: 'empty' }],
          [{ field: 'name', op: 'is', value: 'Flt Red' }],
        ],
        q: 'Flt',
      }),
    ).toEqual(['Flt Red'])

    expect(
      await names({
        objectKey: 'companies',
        filters: [
          [
            {
              field: '~people.company',
              op: 'has',
              where: [{ field: 'tags', op: 'allOf', value: [red, blue] }],
            },
          ],
        ],
      }),
    ).toEqual(['Flt Acme'])
  })

  test('a relations field is not sorted by, nor matched exactly', async () => {
    const tag = await named('tags', 'Sorted')
    await make('people', { name: 'Sorted Sam', tagsIds: [tag] })

    const rows = await run(
      records.listRecords({
        objectKey: 'people',
        q: 'Sorted Sam',
        sort: { field: 'tags', dir: 'asc' },
      }),
    )

    expect(rows).toHaveLength(1)

    const refused = await failure(
      records.listRecords({ objectKey: 'people', where: { tags: tag } }),
    )

    expect(refused).toBeInstanceOf(Invalid)
    expect(refused.message).toContain('filters')
  })

  test('search and the picker go on working beside them', async () => {
    const tag = await named('tags', 'Searchable Tag')
    const person = await make('people', { name: 'Searchable Sal', tagsIds: [tag] })

    expect((await run(records.searchTitles('tags', 'searchable'))).options).toEqual([
      { id: tag, title: 'Searchable Tag' },
    ])

    const index = await run(quickIndex())
    expect(index.objects['people']?.rows.map((r) => r[0])).toContain(person.id)

    const hits = await run(deepSearch('Searchable Sal'))
    expect(hits.map((h) => h.id)).toContain(person.id)

    // Linking a record is a change to it: the index picks it up.
    const before = new Date()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await change('people', person.id, { tagsIds: [] })
    const fresh = await run(quickIndex(before))
    expect(fresh.objects['people']?.rows.map((r) => r[0])).toEqual([person.id])
  })
})

describe('a record page', () => {
  test('lists the records that hold it in a relations field with no inverse here', async () => {
    const team = await named('teams', 'Page Team')
    const tag = await named('tags', 'Page Tag')
    const member = await make('people', { name: 'Page Pat', teamsIds: [team], tagsIds: [tag] })

    const onTeam = await run(records.relatedRecords('teams', team))

    expect(onTeam.map((g) => [g.objectKey, g.field, g.rows.map((r) => r.id)])).toEqual([
      ['people', 'teams', [member.id]],
    ])

    // A tag shows its people in its own `people` field, so only the companies' side is listed here.
    expect(
      (await run(records.relatedRecords('tags', tag))).map((g) => [g.objectKey, g.field, g.rows]),
    ).toEqual([['companies', 'tags', []]])
  })
})

describe('CSV', () => {
  test('export writes the titles in one cell, and import finds them again', async () => {
    const [x, y] = [await named('tags', 'Csv Xylo'), await named('tags', 'Csv Yarn')]
    const team = await named('teams', 'Csv Team')
    await make('people', { name: 'Csv Cy', tagsIds: [y, x], teamsIds: [team] })
    await make('people', { name: 'Csv Dee' })

    const csv = await run(exportCsv('people', { q: 'Csv', sort: [{ field: 'name', dir: 'asc' }] }))
    const table = parseCsv(csv)
    const header = table[0] ?? []
    const cell = (row: number, key: string) => table[row]?.[header.indexOf(key)]

    expect(cell(1, 'name')).toBe('Csv Cy')
    expect(cell(1, 'tags')).toBe('Csv Xylo; Csv Yarn')
    expect(cell(1, 'teams')).toBe('Csv Team')
    expect(cell(2, 'tags')).toBe('')

    // Back in under other names: what the import dialog does with the file.
    const people = toPublicConfig(crmConfig()).objects['people']!

    const renamed = table.map((row, i) =>
      i === 0 ? row : row.map((c) => c.replace('Csv C', 'Csv2 C')),
    )

    const asked = relationCells(people, renamed)
    expect(asked['tags']).toEqual(['Csv Xylo', 'Csv Yarn'])

    const known = Object.fromEntries(
      await Promise.all(
        Object.entries(asked).map(
          async ([objectKey, values]) =>
            [objectKey, await run(records.matchTitles(objectKey, values))] as const,
        ),
      ),
    )

    const { rows } = mapCsv(people, known, renamed)
    const result = await run(service.importRecords('people', rows.slice(0, 1), actor))
    expect(result).toEqual({ created: 1, failed: 0, errors: [] })

    const [imported] = await run(records.listRecords({ objectKey: 'people', q: 'Csv2 Cy' }))
    expect(imported?.['tagsIds']).toEqual([x, y])
    expect(imported?.['teamsIds']).toEqual([team])
  })
})

describe('the tool API', () => {
  const data = async (name: string, body: Record<string, unknown>) => {
    const result = await run(runTool(name, body as Parameters<typeof runTool>[1]))

    if (!result.ok) {
      throw new Error(result.error)
    }

    return result.data as Record<string, any>
  }

  test('describes the field, writes <field>Ids, reads and searches', async () => {
    const tag = await named('tags', 'Tool Tag')
    const other = await named('tags', 'Tool Other')

    const described = await data('describe', { objectKey: 'people' })

    expect(described['people'].fields.tags).toEqual({
      type: 'relations',
      required: false,
      to: 'tags',
      writeAs: 'tagsIds',
    })

    const created = await data('create', {
      objectKey: 'people',
      values: { name: 'Tool Tess', tagsIds: [tag] },
    })

    expect(created['tagsIds']).toEqual([tag])

    const updated = await data('update', {
      objectKey: 'people',
      id: created['id'],
      values: { tagsIds: { add: [other] } },
    })

    expect(updated['tags']).toEqual([
      { id: other, name: 'Tool Other' },
      { id: tag, name: 'Tool Tag' },
    ])

    const got = await data('get', { objectKey: 'people', id: created['id'] })
    expect(got['record'].tagsIds).toEqual([other, tag])

    const found = (await data('search', {
      objectKey: 'people',
      filters: [{ field: 'tags', op: 'allOf', value: [tag, other] }],
    })) as unknown as Record<string, unknown>[]

    expect(found.map((r) => r['name'])).toEqual(['Tool Tess'])
    expect(await timeline('people', created['id'])).toContain('added Tags: Tool Other')

    const refused = await run(
      runTool('search', {
        objectKey: 'people',
        filters: [{ field: 'tags', op: 'contains', value: 'x' }],
      }),
    )

    expect(refused.ok).toBe(false)
  })
})

describe('deleting', () => {
  test('a deleted record leaves no links behind, on either side', async () => {
    const [keep, gone] = [await named('tags', 'Del Keep'), await named('tags', 'Del Gone')]
    const person = await make('people', { name: 'Del Dan', tagsIds: [keep, gone] })
    const other = await make('people', { name: 'Del Eve', tagsIds: [keep] })

    expect(await run(service.deleteRecord('tags', gone, actor))).toBe(true)
    expect((await get('people', person.id))['tagsIds']).toEqual([keep])

    expect(await run(service.deleteRecord('people', person.id, actor))).toBe(true)
    const tag = await get('tags', keep)
    expect(tag['peopleIds']).toEqual([other.id])
    expect(tag['peopleCount']).toBe(1)

    expect(
      await names({
        objectKey: 'tags',
        q: 'Del',
        filters: [[{ field: 'people', op: 'anyOf', value: [person.id] }]],
      }),
    ).toEqual([])
  })
})
