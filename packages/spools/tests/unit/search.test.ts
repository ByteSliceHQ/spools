import { describe, expect, test } from 'bun:test'

import {
  createIndexStore,
  fold,
  highlight,
  type IndexRow,
  mergeIndex,
  near,
  phoneDigits,
  type QuickIndex,
  searchIndex,
  snippet,
  TIER,
  withRecent,
} from '../../src/crm/search'

const row = (id: string, title: string, summary = '', ...values: (string | null)[]): IndexRow => [
  id,
  title,
  summary,
  ...values,
]

function index(over: Partial<QuickIndex> = {}): QuickIndex {
  return {
    at: '2026-11-21T00:00:00.000Z',
    objects: {
      clients: {
        fields: ['town', 'mobilePhone'],
        total: 6,
        rows: [
          row('c1', 'Dana Whitfield', 'Easton', 'Easton', '(410) 555-0101'),
          row('c2', 'Whitfield Dana Jr', 'Salisbury', 'Salisbury', null),
          row('c3', 'Marcus Oyelaran', 'Westport', 'Westport', '410.555.0199'),
          row('c4', 'José Álvarez', 'Easton', 'Easton', null),
          row('c5', 'Dana', 'Westport', 'Westport', null),
          row('c6', 'Adana Kebab House', 'Easton', 'Easton', null),
        ],
      },
      deals: {
        fields: [],
        total: 2,
        rows: [
          row('d1', 'Whitfield kitchen remodel', 'Dana Whitfield · Won'),
          row('d2', 'Easton bath', 'Lost'),
        ],
      },
    },
    notes: { rows: [['n1', 'Whitfield measurements', 'clients', 'c1']], total: 1 },
    views: [],
    ...over,
  }
}

const ids = (hits: { id: string }[]) => hits.map((h) => h.id)

describe('text', () => {
  test('folding ignores case and accents and keeps every position', () => {
    expect(fold('José ÁLVAREZ')).toBe('jose alvarez')
    expect(fold('Größe').length).toBe(5)
  })

  test('one slip is forgiven: a wrong, missing, extra or swapped letter', () => {
    expect(near('kitchen', 'kitchen')).toBe(true)
    expect(near('kitchen', 'kitchin')).toBe(true)
    expect(near('kichen', 'kitchen')).toBe(true)
    expect(near('kittchen', 'kitchen')).toBe(true)
    expect(near('kitcehn', 'kitchen')).toBe(true)
    expect(near('kitchen', 'kitten')).toBe(false)
    expect(near('ktichne', 'kitchen')).toBe(false)
  })

  test('digits with the usual punctuation read as a phone number', () => {
    expect(phoneDigits('(410) 555-01')).toBe('41055501')
    expect(phoneDigits('410')).toBe('410')
    expect(phoneDigits('41')).toBeUndefined()
    expect(phoneDigits('suite 410')).toBeUndefined()
  })
})

describe('searching the index', () => {
  test("ranks the whole title, then its start, a word's start, anywhere in it, then other fields", () => {
    const found = searchIndex(index(), 'dana')
    const clients = found.groups.find((g) => g.objectKey === 'clients')
    expect(ids(clients?.hits ?? [])).toEqual(['c5', 'c1', 'c2', 'c6'])

    expect(clients?.hits.map((h) => h.tier)).toEqual([
      TIER.exact,
      TIER.starts,
      TIER.words,
      TIER.title,
    ])
  })

  test('every word must match somewhere; a match outside the title says where', () => {
    const found = searchIndex(index(), 'whitfield easton')
    expect(ids(found.groups.find((g) => g.objectKey === 'clients')?.hits ?? [])).toEqual(['c1'])
    const town = searchIndex(index(), 'westport').groups[0]?.hits ?? []

    expect(town.map((h) => [h.id, h.tier, h.field, h.value])).toEqual([
      ['c3', TIER.field, 'town', 'Westport'],
      ['c5', TIER.field, 'town', 'Westport'],
    ])
  })

  test("accents and typos don't hide a record, but exact matches come first", () => {
    expect(ids(searchIndex(index(), 'jose alvarez').groups[0]?.hits ?? [])).toEqual(['c4'])
    const typo = searchIndex(index(), 'whitfeild')
    expect(ids(typo.groups.flatMap((g) => g.hits))).toEqual(['c1', 'c2', 'd1'])
    expect(typo.groups[0]?.hits[0]?.tier).toBe(TIER.near)
    // Three letters are too few to guess at; four are enough.
    expect(searchIndex(index(), 'dna').groups).toEqual([])
    expect(ids(searchIndex(index(), 'dnaa').groups[0]?.hits ?? [])).toEqual(['c1', 'c2', 'c5'])
    expect(searchIndex(index(), 'dan').groups[0]?.hits.length).toBeGreaterThan(0)
  })

  test("a typo in one word doesn't loosen the others, and numbers are never guessed at", () => {
    const refs = index({
      objects: {
        clients: {
          fields: [],
          total: 3,
          rows: [
            row('a', 'Client 0941 Example'),
            row('b', 'Client 0241 Example'),
            row('c', 'Client 0241 Annex'),
          ],
        },
      },
      notes: { rows: [], total: 0 },
    })

    // "clinet" is forgiven; "0241" must be there as typed, so 0941 is not offered.
    expect(ids(searchIndex(refs, 'clinet 0241').groups[0]?.hits ?? [])).toEqual(['b', 'c'])
    expect(searchIndex(refs, '0242').groups).toEqual([])
    // Both needed a typo forgiven; the one whose other word matched exactly comes first.
    expect(ids(searchIndex(refs, 'clinet anex').groups[0]?.hits ?? [])).toEqual(['c'])
    expect(ids(searchIndex(refs, 'exampel 0241').groups[0]?.hits ?? [])).toEqual(['b'])
  })

  test('a phone number matches however it was typed or stored', () => {
    expect(ids(searchIndex(index(), '4105550101').groups[0]?.hits ?? [])).toEqual(['c1'])
    expect(ids(searchIndex(index(), '410-555-0199').groups[0]?.hits ?? [])).toEqual(['c3'])
    expect(ids(searchIndex(index(), '555 01').groups[0]?.hits ?? [])).toEqual(['c1', 'c3'])
  })

  test('ties go to what was opened most recently, then to what changed most recently', () => {
    const base = searchIndex(index(), 'easton').groups.find((g) => g.objectKey === 'clients')
    expect(ids(base?.hits ?? [])).toEqual(['c1', 'c4', 'c6'])
    const recent = searchIndex(index(), 'easton', { recent: ['clients:c6', 'clients:c4'] })

    expect(ids(recent.groups.find((g) => g.objectKey === 'clients')?.hits ?? [])).toEqual([
      'c6',
      'c4',
      'c1',
    ])
  })

  test('groups are capped and counted; the best of every kind lead; notes match on title', () => {
    const found = searchIndex(index(), 'whitfield', { per: 1 })

    expect(found.groups.map((g) => [g.objectKey, g.hits.length, g.total])).toEqual([
      ['clients', 1, 2],
      ['deals', 1, 1],
    ])

    // Two titles start with it (a deal and a client), then one that has it as a later word.
    expect(ids(found.best)).toEqual(['d1', 'c2', 'c1'])

    expect(found.notes).toEqual({
      hits: [{ id: 'n1', title: 'Whitfield measurements', objectKey: 'clients', recordId: 'c1' }],
      total: 1,
    })

    expect([...found.matched].sort()).toEqual(['clients:c1', 'clients:c2', 'deals:d1'])
  })

  test('can be narrowed to one object; nothing typed finds nothing', () => {
    const only = searchIndex(index(), 'whitfield', { only: 'deals' })
    expect(only.groups.map((g) => g.objectKey)).toEqual(['deals'])
    expect(only.best).toEqual([])
    expect(only.notes.total).toBe(0)
    expect(searchIndex(index(), '   ').groups).toEqual([])
  })
})

describe('keeping the index current', () => {
  test('changed records replace their old rows and go first', () => {
    const changes = index({
      at: 'later',
      objects: {
        clients: {
          fields: ['town', 'mobilePhone'],
          total: 7,
          rows: [
            row('c3', 'Marcus O. Renamed', 'Easton', 'Easton', null),
            row('c7', 'New Client', '', null, null),
          ],
        },
        deals: { fields: [], total: 2, rows: [] },
      },
      notes: { rows: [], total: 1 },
    })

    const { index: merged, complete } = mergeIndex(index(), changes)
    expect(complete).toBe(true)
    expect(merged.at).toBe('later')

    expect(merged.objects.clients?.rows.map((r) => r[0])).toEqual([
      'c3',
      'c7',
      'c1',
      'c2',
      'c4',
      'c5',
      'c6',
    ])

    expect(merged.objects.clients?.rows[0]?.[1]).toBe('Marcus O. Renamed')
  })

  test("counts that don't add up mean something was deleted", () => {
    const changes = index({
      objects: {
        clients: { fields: ['town', 'mobilePhone'], total: 5, rows: [] },
        deals: { fields: [], total: 2, rows: [] },
      },
      notes: { rows: [], total: 1 },
    })

    expect(mergeIndex(index(), changes).complete).toBe(false)
    const noteGone = index({ objects: index().objects, notes: { rows: [], total: 0 } })

    expect(
      mergeIndex(index(), {
        ...noteGone,
        objects: {
          ...index().objects,
          clients: { ...index().objects.clients!, rows: [] },
          deals: { ...index().objects.deals!, rows: [] },
        },
      }).complete,
    ).toBe(false)
  })

  test('the store fetches everything once, then only changes, and only when due', async () => {
    const calls: (string | undefined)[] = []
    let clock = 0
    let deleted = false

    const store = createIndexStore(
      async (since) => {
        calls.push(since)

        if (!since) {
          return index({ at: `full-${calls.length}` })
        }

        const none = {
          clients: { ...index().objects.clients!, rows: [], total: deleted ? 5 : 6 },
          deals: { ...index().objects.deals!, rows: [] },
        }

        return index({ at: `delta-${calls.length}`, objects: none, notes: { rows: [], total: 1 } })
      },
      { freshMs: 1000, now: () => clock },
    )

    let told = 0
    store.subscribe(() => told++)
    expect(store.get()).toBeUndefined()
    await Promise.all([store.refresh(), store.refresh()]) // two askers, one request
    expect(calls).toEqual([undefined])
    expect(told).toBe(1)

    await store.refresh() // still fresh
    expect(calls).toHaveLength(1)

    clock = 2000 // old: ask for what changed since
    await store.refresh()
    expect(calls).toEqual([undefined, 'full-1'])
    expect(store.get()?.at).toBe('delta-2')

    store.stale() // something was changed in this tab
    await store.refresh()
    expect(calls).toHaveLength(3)

    deleted = true // the counts stop adding up: everything is fetched again
    store.stale()
    await store.refresh()
    expect(calls.slice(3)).toEqual(['delta-3', undefined])
    expect(store.get()?.at).toBe('full-5')
  })
})

describe('showing a match', () => {
  test('marks every typed word, whatever its case or accents', () => {
    expect(highlight('José Álvarez of Easton', 'alv east')).toEqual([
      { text: 'José ', hit: false },
      { text: 'Álv', hit: true },
      { text: 'arez of ', hit: false },
      { text: 'East', hit: true },
      { text: 'on', hit: false },
    ])

    expect(highlight('Nothing here', 'zzz')).toEqual([{ text: 'Nothing here', hit: false }])
  })

  test('a snippet is the stretch of a long text around the first match', () => {
    const body = `${'Lead-in sentence. '.repeat(12)}The quartz backsplash arrives Tuesday.${' Trailing words.'.repeat(12)}`
    const cut = snippet(body, 'backsplash', 60)
    expect(cut).toContain('quartz backsplash')
    expect(cut.startsWith('…') && cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(62)
    expect(snippet('Short\n  note', 'x')).toBe('Short note')
  })

  test('recently opened records are kept newest first, each once', () => {
    const a = { objectKey: 'clients', id: 'c1', title: 'A' }
    const b = { objectKey: 'clients', id: 'c2', title: 'B' }

    expect(withRecent(withRecent([a], b), { ...a, title: 'A2' }).map((r) => r.title)).toEqual([
      'A2',
      'B',
    ])

    const many = Array.from({ length: 40 }, (_, i) => ({
      objectKey: 'deals',
      id: `d${i}`,
      title: `D${i}`,
    }))

    expect(withRecent(many, a)).toHaveLength(30)
  })
})
