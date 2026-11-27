import { expect, test } from 'bun:test'

import { Effect, Layer } from 'effect'

import { assistantChat, SHARED_CHATS } from '../../src/server/assistant-chat'
import * as api from '../../src/server/extension-api'
import { apiRoute } from '../../src/server/handlers'
import * as records from '../../src/server/records'
import { Agents, type AssistantChat } from '../../src/server/runtime/agents'
import * as boundary from '../../src/server/runtime/boundary'
import { Scopes, scopeSession } from '../../src/server/scopes'
import { Users } from '../../src/server/users'
import {
  as,
  branches,
  column,
  grants,
  installWorld,
  people,
  requestFrom,
  scopedWorld,
  sys,
  type Who,
} from './scopes-world'

// Record scopes and people: who is offered as an owner or assignee, what a
// person is told about their own scopes (the switcher), and the boundary, which
// is where a signed-in request is given its scope. Every other scopes test runs
// its programs under `asUser` itself; the boundary tests are the ones that fail
// if a route forgets to.

scopedWorld()

const { nora, ned, bo, hana, otto } = people
const team = Users.use((users) => users.team)

test('the directory lists everyone on the access list, as the server itself sees it', async () => {
  expect(await sys(team)).toHaveLength(6)
})

test('the team list and the user picker offer only people who share the scope', async () => {
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

test('a person is told the scopes they may switch between, and which is active', async () => {
  const north = { key: 'north', label: 'North' }
  const south = { key: 'south', label: 'South' }
  expect(branches).toEqual([north, south])

  expect(await sys(scopeSession(nora))).toEqual({
    held: [north],
    active: 'north',
    key: 'north',
    canWrite: true,
    writes: ['north'],
  })

  // Read-only people get no edit controls.
  expect(await sys(scopeSession(ned))).toMatchObject({
    active: 'north',
    canWrite: false,
    writes: [],
  })

  // The browser is told which scopes can be written, for someone who writes some and reads others.
  expect((await sys(scopeSession(bo, null)))?.writes).toEqual(['north', 'south'])
  expect((await sys(scopeSession(hana, null)))?.writes).toBe('all')
  expect((await sys(scopeSession(hana, 'south')))?.writes).toEqual(['south'])

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
    writes: [],
  })
})

// ── The boundary ────────────────────────────────────────────────────────────

/** An endpoint of the app's own, in plain promises: it lists contacts through `@swirls/spools/extensions`. */
const appRoute = apiRoute('test.contacts', async ({ user }) => {
  const contacts = await api.listRecords({ objectKey: 'contacts', limit: 500, relations: 'none' })
  return Response.json({ user: user.id, contacts: contacts.map((c) => String(c.name)).toSorted() })
})

/** An endpoint of the framework's own, written with Effect. */
const frameworkRoute = boundary.apiRoute('test.count', () =>
  Effect.map(records.countMatching({ objectKey: 'contacts' }), (count) => Response.json({ count })),
)

const listed = async (who: Who | null, scopeCookie?: string) => {
  const request = requestFrom(who, '/api/test/contacts', scopeCookie)
  const response = await appRoute({ request, params: {} })
  return response.status === 200 ? (await response.json()).contacts : response.status
}

const counted = async (who: Who | null, scopeCookie?: string) => {
  const request = requestFrom(who, '/api/test/count', scopeCookie)
  const response = await frameworkRoute({ request, params: {} })
  return response.status === 200 ? (await response.json()).count : response.status
}

test('a route still answers nobody who is signed out', async () => {
  expect(await listed(null)).toBe(401)
  expect(await counted(null)).toBe(401)
  expect(await counted('hana')).toBe(3)
})

test('a signed-in request is given its scope by the boundary, not by the route', async () => {
  const north = ['Nell Crossing', 'Nina Alder']

  // The framework's own route did nothing to ask for a scope.
  expect(await counted('nora')).toBe(2)
  expect(await counted('sam')).toBe(1)
  expect(await counted('otto')).toBe(0)

  // The app's own code, called from the route, works as the person does.
  expect(await listed('nora')).toEqual(north)
  expect(await listed('otto')).toEqual([])
})

test('the scope a request asks for is a preference, checked against what the person holds', async () => {
  const north = ['Nell Crossing', 'Nina Alder']

  // Bo switches with the cookie.
  expect(await listed('bo')).toEqual(north)
  expect(await listed('bo', 'south')).toEqual(['Sofia Birch'])
  expect(await listed('bo', '*')).toHaveLength(3)
  expect(await counted('hana', 'south')).toBe(1)

  // Nora sets the cookie herself. It gets her nothing.
  expect(await listed('nora', 'south')).toEqual(north)
  expect(await listed('nora', '*')).toEqual(north)
  expect(await counted('nora', 'south')).toBe(2)
  expect(await counted('otto', 'north')).toBe(0)
})

// ── The assistant's chats ───────────────────────────────────────────────────

/** An agent engine whose chats are everyone's (one key for the project) or each person's own. */
const engine = (shared: boolean) => {
  const chat: AssistantChat = {
    listSessions: async () => [],
    createSession: async () => ({ sessionId: 'chat' }),
    getMessages: async () => ({ messages: [] }),
    forwardSend: async () => new Response('ok'),
    forwardResumeStream: async () => new Response('ok'),
    deleteSession: async () => true,
    regenerate: false,
    shared,
  }

  return Layer.succeed(
    Agents,
    Agents.of({
      configured: Effect.succeed(true),
      executeWorkflow: () => Effect.succeed({ skipped: true, reason: 'test' }),
      chat: Effect.succeed(chat),
    }),
  )
}

test('the assistant is refused while its chats are shared by everyone, and says what to set up', async () => {
  try {
    await installWorld({ agents: engine(true) })
    await expect(as('nora', assistantChat)).rejects.toThrow(SHARED_CHATS)
    await expect(as('hana', assistantChat, null)).rejects.toThrow('federation')

    // Each person's chats their own: the assistant is there.
    await installWorld({ agents: engine(false) })
    expect((await as('nora', assistantChat))?.shared).toBe(false)
  } finally {
    await installWorld()
  }
})

test('the team is worked out by asking about several people at a time, and each person once a minute at most', async () => {
  let asking = 0
  let most = 0
  let asked = 0

  // A resolver that takes a moment to answer, as one over the network does, and counts.
  const slow = Layer.succeed(
    Scopes,
    Scopes.of({
      grants: (user) =>
        Effect.gen(function* () {
          asked++
          asking++
          most = Math.max(most, asking)
          yield* Effect.sleep('20 millis')
          asking--
          return [...(grants[user.id] ?? [])]
        }),
      list: Effect.succeed([...branches]),
    }),
  )

  try {
    await installWorld({ scopes: slow })

    const twice = Effect.gen(function* () {
      const users = yield* Users
      asked = 0
      const first = yield* users.team
      const forTheFirst = asked
      const second = yield* users.team
      return { first, second, forTheFirst, forBoth: asked }
    })

    const { first, second, forTheFirst, forBoth } = await as('nora', twice)

    expect(column(first, 'name')).toEqual(['Bo Both', 'Hana Office', 'Ned Northview', 'Nora North'])
    expect(second).toEqual(first)
    // Everyone on the access list was asked about, together and not one after another.
    expect(forTheFirst).toBe(Object.keys(people).length)
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(8)
    // And nobody again for the second list.
    expect(forBoth).toBe(forTheFirst)
  } finally {
    await installWorld()
  }
})
