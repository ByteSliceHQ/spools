import { expect, test } from 'bun:test'

import * as search from '../../src/server/search'
import { as, column, northIn, people, scopedWorld, southIn } from './scopes-world'

// Record scopes in search: the index the browser is sent, what the server
// searches itself, and the values the filter box offers. What the browser keeps
// of an index after a switch of scope is in tests/unit/scopes.test.ts.

scopedWorld()

const { nora, bo } = people

test('the index sent to the browser holds the scope, and counts only the scope', async () => {
  const index = await as('nora', search.quickIndex(undefined, nora.id))
  expect(northIn(index)).toContain('Nina')
  expect(southIn(index)).toEqual([])
  // The totals say how many records an object has: they are the scope's, not the business's.
  expect(index.objects['companies']?.total).toBe(2)
  expect(index.objects['contacts']?.total).toBe(2)
  expect(index.objects['deals']?.total).toBe(1)
  expect(index.objects['products']?.total).toBe(1)
  expect(index.notes.total).toBe(1)
  // It says which scope it was read for, so the browser can tell when that changes.
  expect(index.scope).toBe('north')
})

test('the index follows a switch of scope', async () => {
  const south = await as('bo', search.quickIndex(undefined, bo.id), 'south')
  expect(northIn(south)).toEqual([])
  expect(south.scope).toBe('south')

  // "What changed since" must not hand over the other scope's records either.
  const since = new Date(Date.now() - 3_600_000)
  const changes = await as('bo', search.quickIndex(since, bo.id), 'north')
  expect(southIn(changes)).toEqual([])
  expect(changes.scope).toBe('north')

  const both = await as('bo', search.quickIndex(undefined, bo.id), null)
  expect(both.objects['contacts']?.total).toBe(3)
  expect(both.scope).toBe('north+south')
})

test('server search finds nothing in another scope: records, notes, calls or tasks', async () => {
  // The searches work at all.
  expect(northIn(await as('nora', search.deepSearch('northsecret')))).toContain('northsecret')

  // A record by a searchable field, a note and a call by their text, a task by its title.
  expect(await as('nora', search.deepSearch('birch.test'))).toEqual([])
  expect(await as('nora', search.deepSearch('southsecret'))).toEqual([])
  expect(await as('nora', search.deepSearch('Birch'))).toEqual([])
  expect(column(await as('nora', search.deepSearch('Ring')), 'title')).toEqual(['Ring Alder'])
  expect(southIn(await as('nora', search.deepSearch('pricing')))).toEqual([])
  expect(await as('otto', search.deepSearch('pricing'))).toEqual([])
})

test('value suggestions in the filter box count only the scope', async () => {
  // Two companies are in Southport, which is what makes it a value worth offering.
  expect(await as('hana', search.suggestValues('companies', 'port'), null)).toEqual([
    { field: 'city', value: 'Southport', count: 2 },
  ])

  expect(await as('nora', search.suggestValues('companies', 'port'))).toEqual([])

  expect(await as('nora', search.suggestValues('companies', 'gate'))).toEqual([
    { field: 'city', value: 'Northgate', count: 2 },
  ])
})
