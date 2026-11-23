import { describe, expect, test } from 'bun:test'

import type { CrmField } from '../../src/crm/field-types'
import { ME, type Objects } from '../../src/crm/filters'
import { parseAmount, parseDates, type SuggestContext, suggest } from '../../src/crm/suggest'

const field = (f: Partial<CrmField> & { type: CrmField['type'] }): CrmField =>
  ({ required: false, searchable: false, ...f }) as CrmField

const objects: Objects = {
  clients: {
    label: 'Client',
    labelPlural: 'Clients',
    titleField: 'name',
    fields: {
      name: field({ type: 'text' }),
      phone: field({ type: 'phone', encrypted: 'storage' }),
    },
  },
  deals: {
    label: 'Deal',
    labelPlural: 'Deals',
    titleField: 'name',
    fields: {
      name: field({ type: 'text' }),
      client: field({ type: 'relation', to: 'clients' }),
      stage: field({
        type: 'select',
        options: [
          { value: 'won', label: 'Won' },
          { value: 'wonPending', label: 'Won, pending deposit' },
          { value: 'lost', label: 'Lost' },
        ],
      }),
      amount: field({ type: 'currency', currency: 'USD' }),
      sqft: field({ type: 'number' }),
      closeDate: field({ type: 'date' }),
      projectTown: field({ type: 'text' }),
      owner: field({ type: 'user' }),
      signed: field({ type: 'boolean' }),
    },
  },
}

const ctx: SuggestContext = {
  objects,
  objectKey: 'deals',
  users: [
    { id: 'u1', name: 'Dana Whitfield' },
    { id: 'u2', name: 'Marcus Oyelaran' },
  ],
}

/** The conditions offered, as "field op value", in order; fields and the search row are named by kind. */
const offered = (text: string, extra: Partial<SuggestContext> = {}, objectKey = 'deals') =>
  suggest(text, { ...ctx, objectKey, ...extra }).map((s) =>
    s.kind === 'condition'
      ? [s.condition.field, s.condition.op, JSON.stringify(s.condition.value ?? null)].join(' ')
      : s.kind === 'field'
        ? `field ${s.path}`
        : `search ${s.q}`,
  )

const sure = (text: string) =>
  suggest(text, ctx)
    .filter((s) => s.kind === 'condition' && s.sure)
    .map((s) => (s.kind === 'condition' ? `${s.condition.field} ${s.condition.op}` : ''))

describe('reading amounts and dates', () => {
  test('amounts with or without a comparison, in thousands, or as a range', () => {
    expect(parseAmount('5000')).toEqual({ op: 'eq', value: 5000 })
    expect(parseAmount('> 5,000')).toEqual({ op: 'gt', value: 5000 })
    expect(parseAmount('over $5k')).toEqual({ op: 'gt', value: 5000 })
    expect(parseAmount('at least 1.5m')).toEqual({ op: 'gte', value: 1_500_000 })
    expect(parseAmount('<=250')).toEqual({ op: 'lte', value: 250 })
    expect(parseAmount('under 100')).toEqual({ op: 'lt', value: 100 })
    expect(parseAmount('10k-5k')).toEqual({ op: 'between', value: [5000, 10000] })
    expect(parseAmount('between 5000 and 10000')).toEqual({ op: 'between', value: [5000, 10000] })
    expect(parseAmount('about 5000')).toBeUndefined()
    expect(parseAmount('smith')).toBeUndefined()
  })

  test('periods, spans of days and plain dates', () => {
    expect(parseDates('this month')).toEqual([{ op: 'on', value: 'thisMonth' }])

    expect(parseDates('this')).toEqual([
      { op: 'on', value: 'thisWeek' },
      { op: 'on', value: 'thisMonth' },
      { op: 'on', value: 'thisQuarter' },
      { op: 'on', value: 'thisYear' },
    ])

    expect(parseDates('last 30 days')).toEqual([{ op: 'inLast', value: 30 }])
    expect(parseDates('in the next 7 days')).toEqual([{ op: 'inNext', value: 7 }])
    expect(parseDates('over 30 days ago')).toEqual([{ op: 'olderThan', value: 30 }])
    expect(parseDates('90d ago')).toEqual([{ op: 'olderThan', value: 90 }])
    expect(parseDates('before 3/9/2026')).toEqual([{ op: 'before', value: '2026-03-09' }])
    expect(parseDates('after last month')).toEqual([{ op: 'after', value: 'lastMonth' }])
    expect(parseDates('2026-13-40')).toEqual([])
    expect(parseDates('to')).toEqual([])
  })
})

describe('suggesting filters for typed text', () => {
  test("an option's name offers that option; its whole name is certain and goes first", () => {
    expect(offered('wo')).toEqual(['stage in ["won"]', 'stage in ["wonPending"]', 'search wo'])
    expect(offered('pend')).toEqual(['stage in ["wonPending"]', 'search pend'])
    expect(sure('won')).toEqual(['stage in'])
    expect(sure('wo')).toEqual([])
  })

  test("a teammate's name offers their records; 'me' stands for whoever is looking", () => {
    expect(offered('dana')).toEqual(['owner in ["u1"]', 'createdBy in ["u1"]', 'search dana'])
    expect(offered('mine')).toEqual([`owner in ["${ME}"]`, `createdBy in ["${ME}"]`, 'search mine'])
  })

  test('an amount goes to money first, then other numbers; a comparison makes it certain', () => {
    expect(offered('>5000')).toEqual(['amount gt 5000', 'sqft gt 5000', 'search >5000'])
    expect(sure('>5000')).toEqual(['amount gt', 'sqft gt'])
    expect(sure('5000')).toEqual([]) // could be an order number
  })

  test("a date phrase is offered on every date, the object's own first", () => {
    expect(offered('this month').slice(0, 3)).toEqual([
      'closeDate on "thisMonth"',
      'createdAt on "thisMonth"',
      'updatedAt on "thisMonth"',
    ])

    expect(offered('over 30 days ago')).toContain('lastContactedAt olderThan 30')
  })

  test("a field's name followed by something reads the rest as its value", () => {
    expect(offered('stage lost')[0]).toBe('stage in ["lost"]')
    expect(offered('amount > 5000')[0]).toBe('amount gt 5000')
    expect(offered('project town West Haven')[0]).toBe('projectTown contains "West Haven"')
    expect(offered('close date next week')[0]).toBe('closeDate on "nextWeek"')
    expect(offered('last contacted over 30 days ago')[0]).toBe('lastContactedAt olderThan 30')
    expect(offered('owner: me')[0]).toBe(`owner in ["${ME}"]`)
    expect(offered('signed no')[0]).toBe('signed no null')
    expect(offered('client is empty')[0]).toBe('client empty null')
  })

  test('emptiness, for fields and for records that point here', () => {
    expect(offered('no client')[0]).toBe('client empty null')
    expect(offered('has owner')[0]).toBe('owner notEmpty null')
    expect(offered('no deals', {}, 'clients')[0]).toBe('~deals.client hasNone null')
    expect(offered('has deals', {}, 'clients')[0]).toBe('~deals.client has null')
    // Encrypted for storage: emptiness is the one thing it can be asked.
    expect(offered('no phone', {}, 'clients')[0]).toBe('phone empty null')
  })

  test('records and values that were looked up are offered as filters', () => {
    const out = suggest('west', {
      ...ctx,
      records: [{ field: 'client', id: 'c1', title: 'Westfield Homes' }],
      values: [{ field: 'projectTown', value: 'Westport', count: 142 }],
    })

    expect(
      out.map((s) =>
        s.kind === 'condition' ? [s.condition.field, s.condition.op, s.count] : s.kind,
      ),
    ).toEqual([['projectTown', 'is', 142], ['client', 'in', undefined], 'search'])
  })

  test("a field's name offers the field; plain text always ends with a search", () => {
    expect(offered('clo')).toEqual(['field closeDate', 'search clo'])
    expect(offered('sig')).toEqual(['signed yes null', 'field signed', 'search sig'])
    expect(offered('zzz')).toEqual(['search zzz'])
    expect(offered('   ')).toEqual([])
  })
})
