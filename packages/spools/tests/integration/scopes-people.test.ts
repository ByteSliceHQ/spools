import { expect, test } from 'bun:test'

import { scopeSession } from '../../src/server/scopes'
import { Users } from '../../src/server/users'
import { as, branches, column, pending, people, scopedWorld, sys } from './scopes-world'

// Record scopes and people: who is offered as an owner or assignee, and what a
// person is told about their own scopes (the switcher).

scopedWorld()

const { nora, ned, bo, hana, otto } = people
const team = Users.use((users) => users.team)

test('the directory lists everyone on the access list, as the server itself sees it', async () => {
  expect(await sys(team)).toHaveLength(6)
})

pending('the team list and the user picker offer only people who share the scope', async () => {
  // Head office reaches every branch, so it is on every branch's list.
  expect(column(await as('nora', team), 'name')).toEqual([
    'Bo Both',
    'Hana Office',
    'Ned Northview',
    'Nora North',
  ])

  expect(column(await as('sam', team), 'name')).toEqual(['Bo Both', 'Hana Office', 'Sam South'])

  expect(column(await as('bo', team, 'south'), 'name')).toEqual([
    'Bo Both',
    'Hana Office',
    'Sam South',
  ])

  expect(await as('bo', team, null)).toHaveLength(5)
  expect(await as('hana', team, null)).toHaveLength(6)
  // Someone who holds nothing is told of nobody.
  expect(await as('otto', team)).toEqual([])
})

pending('a person is told the scopes they may switch between, and which is active', async () => {
  const north = { key: 'north', label: 'North' }
  const south = { key: 'south', label: 'South' }
  expect(branches).toEqual([north, south])

  expect(await sys(scopeSession(nora))).toEqual({
    held: [north],
    active: 'north',
    key: 'north',
    canWrite: true,
  })

  // Read-only people get no edit controls.
  expect(await sys(scopeSession(ned))).toMatchObject({ active: 'north', canWrite: false })

  // Bo switches, or works in both at once.
  expect(await sys(scopeSession(bo))).toMatchObject({ held: [north, south], active: 'north' })
  expect(await sys(scopeSession(bo, 'south'))).toMatchObject({ active: 'south', key: 'south' })
  expect(await sys(scopeSession(bo, null))).toMatchObject({ active: null, key: 'north+south' })

  // Asking for a scope that isn't held changes nothing.
  expect(await sys(scopeSession(nora, 'south'))).toMatchObject({ active: 'north', key: 'north' })

  // Head office is offered every scope there is.
  expect(await sys(scopeSession(hana, null))).toMatchObject({
    held: [north, south],
    active: null,
    key: '*',
  })

  expect(await sys(scopeSession(otto))).toEqual({
    held: [],
    active: null,
    key: '',
    canWrite: false,
  })
})
