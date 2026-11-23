import { describe, expect, test } from 'bun:test'

import type { CrmField } from '../../src/crm/field-types'
import {
  addDays,
  backRelations,
  cleanFilters,
  cleanSort,
  countConditions,
  dayRange,
  describe as describeCondition,
  isDay,
  MAX_CONDITIONS,
  MAX_GROUPS,
  MAX_INNER,
  MAX_TOTAL,
  ME,
  type Objects,
  operatorsFor,
  periodRange,
  pinnedValues,
  relationIds,
  resolveTarget,
  startOfDay,
  todayIn,
} from '../../src/crm/filters'

const field = (f: Partial<CrmField> & { type: CrmField['type'] }): CrmField =>
  ({ required: false, searchable: false, ...f }) as CrmField

const objects: Objects = {
  clients: {
    label: 'Client',
    labelPlural: 'Clients',
    titleField: 'name',
    fields: {
      name: field({ type: 'text', encrypted: 'match' }),
      email: field({ type: 'email', encrypted: 'search' }),
      phone: field({ type: 'phone', encrypted: 'storage' }),
      taxId: field({ type: 'text', encrypted: 'eq' }),
      town: field({ type: 'text' }),
      designer: field({ type: 'user' }),
    },
  },
  deals: {
    label: 'Deal',
    labelPlural: 'Deals',
    titleField: 'name',
    fields: {
      name: field({ type: 'text' }),
      client: field({ type: 'relation', to: 'clients' }),
      referrer: field({ type: 'relation', to: 'clients' }),
      stage: field({
        type: 'select',
        options: [
          { value: 'won', label: 'Closed won' },
          { value: 'lost', label: 'Closed lost' },
        ],
      }),
      amount: field({ type: 'currency', currency: 'USD' }),
      closeDate: field({ type: 'date' }),
      signed: field({ type: 'boolean' }),
    },
  },
}

describe("what a condition's field names", () => {
  test('a field, a system column, a field through a relation, and records that point here', () => {
    expect(resolveTarget(objects, 'deals', 'amount')).toMatchObject({
      kind: 'field',
      key: 'amount',
      label: 'Amount',
    })

    expect(resolveTarget(objects, 'deals', 'lastContactedAt')).toMatchObject({
      label: 'Last contacted',
    })

    expect(resolveTarget(objects, 'deals', 'client.town')).toMatchObject({
      kind: 'field',
      objectKey: 'clients',
      key: 'town',
      via: { key: 'client' },
      label: 'Client › Town',
    })

    expect(resolveTarget(objects, 'clients', '~deals.client')).toMatchObject({
      kind: 'back',
      objectKey: 'deals',
    })
  })

  test('nothing when the config has no such thing, or it is more than one step away', () => {
    for (const path of [
      'nope',
      'amount.x',
      'client.nope',
      'client.town.x',
      '~deals.stage',
      '~nope.client',
      '',
    ]) {
      expect(resolveTarget(objects, 'deals', path)).toBeUndefined()
    }

    expect(resolveTarget(objects, 'nope', 'name')).toBeUndefined()
  })

  test('an object reached by two relations says which one', () => {
    expect(backRelations(objects, 'clients')).toEqual(['~deals.client', '~deals.referrer'])

    expect(resolveTarget(objects, 'clients', '~deals.referrer')).toMatchObject({
      label: 'Deals (as referrer)',
    })

    expect(backRelations(objects, 'deals')).toEqual([])
  })
})

describe('operators', () => {
  const ops = (objectKey: string, key: string) =>
    operatorsFor(objects[objectKey]?.fields[key] as CrmField)

  test('each kind of field has its own', () => {
    expect(ops('clients', 'town')).toEqual([
      'contains',
      'notContains',
      'is',
      'isNot',
      'startsWith',
      'endsWith',
      'empty',
      'notEmpty',
    ])

    expect(ops('deals', 'amount')).toContain('between')

    expect(ops('deals', 'closeDate')).toEqual([
      'on',
      'before',
      'after',
      'between',
      'inLast',
      'inNext',
      'olderThan',
      'empty',
      'notEmpty',
    ])

    expect(ops('deals', 'stage')).toEqual(['in', 'notIn', 'empty', 'notEmpty'])
    expect(ops('deals', 'signed')).toEqual(['yes', 'no'])
  })

  test('an encrypted field is asked only what its mode can answer', () => {
    expect(ops('clients', 'phone')).toEqual(['empty', 'notEmpty']) // storage
    expect(ops('clients', 'taxId')).toEqual(['is', 'isNot', 'empty', 'notEmpty']) // eq
    expect(ops('clients', 'name')).toEqual(['contains', 'notContains', 'empty', 'notEmpty']) // match
    expect(ops('clients', 'email')).toHaveLength(8) // search: everything
  })
})

describe('cleaning filters', () => {
  const clean = (raw: unknown, objectKey = 'deals') => cleanFilters(objects, objectKey, raw)

  test('the older map of exact values becomes one group of conditions', () => {
    expect(clean({ stage: 'won', signed: true })).toEqual([
      [
        { field: 'stage', op: 'in', value: ['won'] },
        { field: 'signed', op: 'yes' },
      ],
    ])
  })

  test('a flat list is one group; a list of lists is several', () => {
    const amount = { field: 'amount', op: 'gt' as const, value: 5000 }
    expect(clean([amount])).toEqual([[amount]])
    expect(clean([[amount], [{ field: 'signed', op: 'no' }]])).toHaveLength(2)
  })

  test("drops what the config doesn't allow, and groups left empty", () => {
    expect(
      clean([
        [
          { field: 'nope', op: 'is', value: 'x' },
          { field: 'amount', op: 'contains', value: '5' }, // not a number operator
          { field: 'amount', op: 'gt', value: 'lots' },
          { field: 'closeDate', op: 'on', value: 'someday' },
          { field: 'closeDate', op: 'between', value: ['2026-01-01'] },
          { field: 'name', op: 'contains', value: '  ' },
        ],
        [{ field: 'client.phone', op: 'contains', value: '555' }], // encrypted for storage
      ]),
    ).toEqual([])

    expect(clean('stage=won')).toEqual([])
    expect(clean(null)).toEqual([])
  })

  test('an option the config no longer has is kept, so the filter matches nothing rather than everything', () => {
    expect(clean({ stage: 'gone' })).toEqual([[{ field: 'stage', op: 'in', value: ['gone'] }]])

    expect(clean([{ field: 'stage', op: 'notIn', value: ['gone', 'won'] }])).toEqual([
      [{ field: 'stage', op: 'notIn', value: ['gone', 'won'] }],
    ])
  })

  test("a day that isn't on the calendar is not a day", () => {
    for (const day of [
      '2026-04-31',
      '2026-02-30',
      '2027-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-1-5',
      'soon',
    ]) {
      expect(isDay(day)).toBe(false)
    }

    expect(isDay('2028-02-29')).toBe(true)
    expect(clean([{ field: 'closeDate', op: 'on', value: '2026-04-31' }])).toEqual([])

    expect(
      clean([{ field: 'closeDate', op: 'between', value: ['2026-04-01', '2026-04-31'] }]),
    ).toEqual([])

    expect(clean([{ field: 'nextTaskDue', op: 'before', value: '2026-02-30' }])).toEqual([])
  })

  test('names that only look like keys are not fields, objects or relations', () => {
    const hostile = [
      '~__proto__.x',
      '~constructor.x',
      '~toString.name',
      '__proto__',
      'constructor',
      'client.__proto__',
      'client.constructor',
      '__proto__.name',
      `client.${'x'.repeat(500)}`,
    ]

    for (const field of hostile) {
      for (const op of ['has', 'is', 'empty', 'in']) {
        expect(clean([{ field, op, value: 'x' }])).toEqual([])
        expect(clean([{ field, op, value: 'x' }], 'clients')).toEqual([])
      }
    }

    expect(cleanFilters(objects, 'constructor', [{ field: 'name', op: 'empty' }])).toEqual([])

    expect(
      cleanSort(objects, 'deals', [{ field: '__proto__', dir: 'asc' }, { field: 'constructor' }]),
    ).toEqual([])
  })

  test("what a link may ask for is bounded: groups, conditions, conditions inside 'has', and all together", () => {
    const one = { field: 'amount', op: 'gt', value: 1 }

    // More of everything than is allowed, with rubbish mixed in.
    const group = Array.from({ length: 30 }, (_, i) =>
      i % 5 === 4 ? { field: 'nope', op: 'is', value: 'x' } : one,
    )

    const cleaned = clean(Array.from({ length: 12 }, () => group))
    expect(cleaned).toHaveLength(MAX_GROUPS)
    expect(cleaned.every((g) => g.length === MAX_CONDITIONS)).toBe(true)

    const inner = Array.from({ length: 30 }, () => ({ field: 'stage', op: 'in', value: ['won'] }))
    const has = { field: '~deals.client', op: 'has', where: inner }
    const nested = clean([[has]], 'clients')
    expect(nested[0]?.[0]?.where).toHaveLength(MAX_INNER)

    // Ten "has" conditions of five each would be sixty tests in one group; forty is the limit for the whole filter.
    const heavy = clean(
      Array.from({ length: 4 }, () => Array.from({ length: 10 }, () => has)),
      'clients',
    )

    expect(countConditions(heavy)).toBe(MAX_TOTAL)
    expect(MAX_TOTAL).toBeLessThanOrEqual(40)

    // Long values and long lists are cut, not refused.
    const long = clean([{ field: 'name', op: 'contains', value: 'x'.repeat(5000) }])[0]?.[0]?.value
    expect(String(long)).toHaveLength(500)

    const many = clean([
      { field: 'client', op: 'in', value: Array.from({ length: 900 }, (_, i) => `c${i}`) },
    ])

    expect(many[0]?.[0]?.value).toHaveLength(100)
  })

  test("values are brought to the field's type", () => {
    expect(clean([{ field: 'amount', op: 'gt', value: '$5,000' }])).toEqual([
      [{ field: 'amount', op: 'gt', value: 5000 }],
    ])

    expect(clean([{ field: 'amount', op: 'between', value: [900, '100'] }])).toEqual([
      [{ field: 'amount', op: 'between', value: [100, 900] }],
    ])

    expect(clean([{ field: 'closeDate', op: 'inLast', value: '30' }])).toEqual([
      [{ field: 'closeDate', op: 'inLast', value: 30 }],
    ])

    expect(clean([{ field: 'stage', op: 'in', value: 'won' }])).toEqual([
      [{ field: 'stage', op: 'in', value: ['won'] }],
    ])

    expect(clean([{ field: 'signed', op: 'yes', value: 'ignored' }])).toEqual([
      [{ field: 'signed', op: 'yes' }],
    ])
  })

  test('records that point here may carry conditions of their own, one step deep', () => {
    const raw = [
      {
        field: '~deals.client',
        op: 'has',
        where: [
          { field: 'stage', op: 'in', value: ['won'] },
          { field: 'client.town', op: 'is', value: 'x' }, // back through a relation: dropped
          { field: 'nope', op: 'is', value: 'x' },
        ],
      },
    ]

    expect(clean(raw, 'clients')).toEqual([
      [
        {
          field: '~deals.client',
          op: 'has',
          where: [{ field: 'stage', op: 'in', value: ['won'] }],
        },
      ],
    ])

    expect(clean([{ field: '~deals.client', op: 'contains', value: 'x' }], 'clients')).toEqual([])
  })

  test('sort keeps real columns, each once, at most three', () => {
    expect(cleanSort(objects, 'deals', { field: 'amount', dir: 'desc' })).toEqual([
      { field: 'amount', dir: 'desc' },
    ])

    expect(
      cleanSort(objects, 'deals', [
        { field: 'client' },
        { field: 'nope', dir: 'asc' },
        { field: 'client', dir: 'desc' },
        { field: 'createdAt', dir: 'desc' },
        { field: 'stage', dir: 'asc' },
        { field: 'name', dir: 'asc' },
      ]),
    ).toEqual([
      { field: 'client', dir: 'asc' },
      { field: 'createdAt', dir: 'desc' },
      { field: 'stage', dir: 'asc' },
    ])

    expect(cleanSort(objects, 'deals', undefined)).toEqual([])
  })
})

describe('dates', () => {
  // A Wednesday.
  const today = '2026-11-18'

  test('periods are whole weeks (from Monday), months, quarters and years', () => {
    expect(periodRange('today', today)).toEqual(['2026-11-18', '2026-11-18'])
    expect(periodRange('thisWeek', today)).toEqual(['2026-11-16', '2026-11-22'])
    expect(periodRange('lastWeek', today)).toEqual(['2026-11-09', '2026-11-15'])
    expect(periodRange('nextWeek', today)).toEqual(['2026-11-23', '2026-11-29'])
    expect(periodRange('thisMonth', today)).toEqual(['2026-11-01', '2026-11-30'])
    expect(periodRange('nextMonth', today)).toEqual(['2026-12-01', '2026-12-31'])
    expect(periodRange('thisQuarter', today)).toEqual(['2026-10-01', '2026-12-31'])
    expect(periodRange('nextQuarter', today)).toEqual(['2027-01-01', '2027-03-31'])
    expect(periodRange('lastQuarter', today)).toEqual(['2026-07-01', '2026-09-30'])
    expect(periodRange('thisYear', today)).toEqual(['2026-01-01', '2026-12-31'])
    expect(periodRange('lastYear', today)).toEqual(['2025-01-01', '2025-12-31'])
    expect(periodRange('lastMonth', '2026-01-15')).toEqual(['2025-12-01', '2025-12-31'])
    expect(periodRange('thisMonth', '2028-02-10')).toEqual(['2028-02-01', '2028-02-29']) // a leap year
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  test('each date operator covers a span of days', () => {
    expect(dayRange({ op: 'on', value: '2026-03-09' }, today)).toEqual(['2026-03-09', '2026-03-09'])
    expect(dayRange({ op: 'on', value: 'thisMonth' }, today)).toEqual(['2026-11-01', '2026-11-30'])
    expect(dayRange({ op: 'before', value: 'thisMonth' }, today)).toEqual([undefined, '2026-10-31'])
    expect(dayRange({ op: 'after', value: 'today' }, today)).toEqual(['2026-11-19', undefined])

    expect(dayRange({ op: 'between', value: ['2026-01-01', '2026-01-31'] }, today)).toEqual([
      '2026-01-01',
      '2026-01-31',
    ])

    // The ends in either order mean the same span, for days and for periods.
    expect(dayRange({ op: 'between', value: ['2026-01-31', '2026-01-01'] }, today)).toEqual([
      '2026-01-01',
      '2026-01-31',
    ])

    expect(dayRange({ op: 'between', value: ['thisMonth', 'lastMonth'] }, today)).toEqual([
      '2026-10-01',
      '2026-11-30',
    ])

    expect(dayRange({ op: 'inLast', value: 30 }, today)).toEqual(['2026-10-19', '2026-11-18'])
    expect(dayRange({ op: 'inNext', value: 7 }, today)).toEqual(['2026-11-18', '2026-11-25'])
    // "More than 30 days ago": the 30th day back is not yet more than 30.
    expect(dayRange({ op: 'olderThan', value: 30 }, today)).toEqual([undefined, '2026-10-18'])
    expect(dayRange({ op: 'on', value: 'whenever' }, today)).toBeUndefined()
    expect(dayRange({ op: 'empty' }, today)).toBeUndefined()
  })

  test("today and midnight are the business's, not the server's", () => {
    // 03:30 UTC on the 18th is still the 17th in New York, and already the 18th in Sydney.
    const now = new Date('2026-11-18T03:30:00Z')
    expect(todayIn('America/New_York', now)).toBe('2026-11-17')
    expect(todayIn('Australia/Sydney', now)).toBe('2026-11-18')
    expect(todayIn('UTC', now)).toBe('2026-11-18')

    expect(startOfDay('2026-11-18', 'America/New_York').toISOString()).toBe(
      '2026-11-18T05:00:00.000Z',
    )

    expect(startOfDay('2026-07-01', 'America/New_York').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    )

    expect(startOfDay('2026-11-18', 'UTC').toISOString()).toBe('2026-11-18T00:00:00.000Z')

    // The day the clocks go back in New York still starts at its own midnight.
    expect(startOfDay('2026-11-01', 'America/New_York').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    )

    expect(startOfDay('2026-11-02', 'America/New_York').toISOString()).toBe(
      '2026-11-02T05:00:00.000Z',
    )
  })
})

describe('what filters tell the rest of the page', () => {
  test("values pinned by a single group; none once there is an 'or'", () => {
    const pinned = [
      { field: 'stage', op: 'in' as const, value: ['won'] },
      { field: 'signed', op: 'no' as const },
      { field: 'amount', op: 'gt' as const, value: 1 },
      { field: 'client.town', op: 'in' as const, value: ['x'] },
      { field: 'client', op: 'in' as const, value: ['a', 'b'] },
    ]

    expect(pinnedValues([pinned])).toEqual({ stage: 'won', signed: false })
    expect(pinnedValues([pinned, pinned])).toEqual({})
    expect(pinnedValues([[{ field: 'designer', op: 'in', value: [ME] }]])).toEqual({})
  })

  test('the related records they name, to look up titles for', () => {
    expect(
      relationIds(objects, 'deals', [
        [{ field: 'client', op: 'in', value: ['c1', 'c2'] }],
        [
          { field: 'referrer', op: 'notIn', value: ['c2', 'c3'] },
          { field: 'stage', op: 'in', value: ['won'] },
        ],
      ]),
    ).toEqual({ clients: ['c1', 'c2', 'c3'] })

    expect(
      relationIds(objects, 'clients', [
        [
          {
            field: '~deals.client',
            op: 'has',
            where: [{ field: 'referrer', op: 'in', value: ['c9'] }],
          },
        ],
      ]),
    ).toEqual({ clients: ['c9'] })
  })

  test('a condition reads as label, operator and value', () => {
    const ctx = {
      users: [{ id: 'u1', name: 'Dana' }],
      title: (_o: string, id: string) => (id === 'c1' ? 'Ada Lovelace' : undefined),
    }

    const say = (cond: Parameters<typeof describeCondition>[2], objectKey = 'deals') => {
      const d = describeCondition(objects, objectKey, cond, ctx)
      return `${d.label} ${d.op} ${d.value}`.trim()
    }

    expect(say({ field: 'stage', op: 'in', value: ['won', 'lost'] })).toBe(
      'Stage is Closed won or Closed lost',
    )

    expect(say({ field: 'client', op: 'in', value: ['c1', 'c2'] })).toBe(
      'Client is Ada Lovelace or …',
    )

    expect(say({ field: 'client.town', op: 'contains', value: 'west' })).toBe(
      'Client › Town contains “west”',
    )

    expect(say({ field: 'closeDate', op: 'on', value: 'thisMonth' })).toBe(
      'Close Date is this month',
    )

    expect(say({ field: 'lastContactedAt', op: 'olderThan', value: 30 })).toBe(
      'Last contacted more than 30 days ago',
    )

    expect(say({ field: 'closeDate', op: 'inNext', value: 1 })).toBe('Close Date in the next 1 day')
    expect(say({ field: 'signed', op: 'no' })).toBe('Signed is no')

    expect(say({ field: 'designer', op: 'in', value: [ME, 'u1', 'gone'] }, 'clients')).toBe(
      'Designer is Me or Dana or Someone',
    )

    expect(say({ field: '~deals.client', op: 'hasNone' }, 'clients')).toBe(
      'Client has no deals (as client)',
    )

    expect(
      say(
        {
          field: '~deals.client',
          op: 'has',
          where: [{ field: 'stage', op: 'in', value: ['won'] }],
        },
        'clients',
      ),
    ).toBe('Client has deals (as client) where Stage is Closed won')
  })
})
