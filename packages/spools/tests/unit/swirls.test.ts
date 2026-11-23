import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { z } from 'zod'

import { swirls } from '../../src/adapters/agents/swirls/server'
import { Agents, type AgentsAdapter, type AssistantChat } from '../../src/server/runtime/agents'
import type { Session } from '../../src/server/runtime/auth'
import { httpLayer } from '../../src/server/runtime/http'
import { CurrentRequest } from '../../src/server/runtime/request'
import { makeStore, Store } from '../../src/server/store/store'
import { testRuntime, withEnv } from '../support/run'

// The Swirls adapter against a stand-in Swirls on this machine: its API (the
// SDK's RPC endpoints and the web chat) and its token exchange. The SDK posts
// the exchange to a fixed address, so `fetch` is replaced for this file: it
// sends that one address to the stand-in and refuses anything else that isn't
// the stand-in, so nothing here can reach the real Swirls.

const TOKEN_URL = 'https://auth.swirls.ai/oauth2/token'

type Call = { method: string; path: string; authorization: string | null; text: string }

const rpcBody = z.object({ json: z.record(z.string(), z.unknown()) })

const listInput = z.object({
  projectId: z.string(),
  pagination: z.object({ first: z.number(), after: z.string().nullish() }),
})

/** What the stand-in was asked, in order. */
let calls: Call[] = []
/** Endpoints (by the end of their path) that answer 500, and how many more times. */
let failing = new Map<string, number>()
/** When set, listing workflows never answers; the function is called when the request arrives. */
let stalled: (() => void) | null = null
/** What the stand-in says when a conversation is deleted. */
let deleted = true

const workflow = (id: string, name: string, isActiveDeployment = true) => ({
  workflow: { id, name, projectId: 'proj_1' },
  isActiveDeployment,
})

const rpc = (json: unknown) => Response.json({ json, meta: [] })

const answer = async (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url)
  const text = await request.text()

  calls.push({
    method: request.method,
    path: pathname,
    authorization: request.headers.get('authorization'),
    text,
  })

  for (const [end, times] of failing) {
    if (pathname.endsWith(end) && times > 0) {
      failing.set(end, times - 1)
      return Response.json({ json: { message: 'Swirls is having a moment' } }, { status: 500 })
    }
  }

  if (pathname === '/oauth2/token') {
    const subject = new URLSearchParams(text).get('subject_token')
    return Response.json({ access_token: `swirls-token-for-${subject}`, expires_in: 900 })
  }

  if (pathname === '/api/rpc/workflows/listWorkflows') {
    if (stalled) {
      stalled()
      return new Promise<Response>(() => {})
    }

    const { pagination } = listInput.parse(rpcBody.parse(JSON.parse(text)).json)

    return pagination.after === 'cursor_1'
      ? rpc({
          results: [workflow('wf_2', 'follow_up')],
          pagination: { hasNextPage: false, endCursor: null },
        })
      : rpc({
          results: [workflow('wf_1', 'new_contact'), workflow('wf_0', 'retired', false)],
          pagination: { hasNextPage: true, endCursor: 'cursor_1' },
        })
  }

  if (pathname === '/api/rpc/workflows/executeWorkflow') {
    return rpc({ executionId: 'exec_1' })
  }

  if (pathname === '/api/rpc/agents/listWebSessions') {
    return rpc({ sessions: [{ sessionId: 's1', title: 'Renewals', updatedAt: '2026-01-02' }] })
  }

  if (pathname === '/api/rpc/agents/createWebSession') {
    return rpc({ sessionId: 's2' })
  }

  if (pathname === '/api/rpc/agents/getWebChatMessages') {
    return rpc({ messages: [{ id: 'm1', role: 'user' }] })
  }

  if (pathname === '/api/rpc/agents/deleteSession') {
    return rpc({ deleted })
  }

  if (pathname.startsWith('/chat/web/')) {
    return new Response('a reply, as it comes')
  }

  return new Response('the stand-in has no such endpoint', { status: 404 })
}

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: answer })
const origin = `http://127.0.0.1:${server.port}`
const realFetch = globalThis.fetch

const addressOf = (input: string | URL | Request) =>
  input instanceof Request ? input.url : String(input)

beforeAll(() => {
  const onlyTheStandIn: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const address = addressOf(input)

      if (address === TOKEN_URL) {
        return realFetch(`${origin}/oauth2/token`, init)
      }

      if (!address.startsWith(origin)) {
        throw new Error(`a Swirls test tried to reach ${address}`)
      }

      return realFetch(input, init)
    },
    { preconnect: realFetch.preconnect },
  )

  globalThis.fetch = onlyTheStandIn
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await server.stop(true)
})

beforeEach(() => {
  calls = []
  failing = new Map()
  stalled = null
  deleted = true
})

const PROJECT = { SWIRLS_PROJECT_ID: 'proj_1', SWIRLS_API_URL: `${origin}/api` }
const WITH_KEY = { ...PROJECT, SWIRLS_API_KEY: 'sk_project_key' }

/** A signed-in person whose auth provider mints `jwt-of-<them>`, and the templates it was asked for. */
const signedIn = (userId: string, token: string | null = `jwt-of-${userId}`) => {
  const templates: string[] = []

  const session: Session = {
    userId,
    getToken: async ({ template }) => {
      templates.push(template)
      return token
    },
  }

  return { session, templates }
}

/** Every adapter may ask for the store and the HTTP client. This one must use neither: the store here fails if it is touched. */
const untouched = Effect.die('the Swirls adapter does not read or write the database')

const noStore = makeStore({
  find: () => untouched,
  count: () => untouched,
  countValues: () => untouched,
  insert: () => untouched,
  update: () => untouched,
  remove: () => untouched,
  lock: () => untouched,
  transaction: (program) => program,
  refreshDates: () => untouched,
  ping: untouched,
})

const outside = Layer.mergeAll(Layer.succeed(Store, Store.of(noStore)), httpLayer())

const layerOf = (adapter: AgentsAdapter) => adapter.layer.pipe(Layer.provide(outside))

/** Runs a program on the adapter's own layer, with these variables, for a request from this session. */
const withSwirls = <A, E>(
  env: Record<string, string>,
  session: Session | null,
  program: Effect.Effect<A, E, Agents>,
  adapter = swirls(),
) => {
  const rt = testRuntime(Layer.mergeAll(layerOf(adapter), withEnv(env)))

  return rt
    .runPromise(
      Effect.result(program).pipe(
        Effect.provideService(CurrentRequest, {
          headers: new Headers(),
          signal: undefined,
          session,
        }),
      ),
    )
    .finally(() => rt.dispose())
}

const start = (name: string, input: Record<string, unknown> = {}) =>
  Agents.use((agents) => agents.executeWorkflow(name, input))

const to = (end: string) => calls.filter((call) => call.path.endsWith(end))
const inputOf = (call: Call | undefined) => rpcBody.parse(JSON.parse(call?.text ?? '{}')).json

const messageOf = (result: { _tag: string; failure?: { message: string } }) =>
  result._tag === 'Failure' ? result.failure?.message : `not a failure: ${result._tag}`

/** The assistant's chat for a request, or a failed test when there is none. */
const chatFor = async (
  env: Record<string, string>,
  session: Session | null,
  adapter = swirls(),
): Promise<AssistantChat> => {
  const result = await withSwirls(
    env,
    session,
    Agents.use((agents) => agents.chat),
    adapter,
  )

  if (result._tag !== 'Success' || result.success === null) {
    throw new Error('expected a chat')
  }

  return result.success
}

describe('Swirls, when it is not set up', () => {
  test('without a project id it is not configured, starts nothing and has no chat', async () => {
    const env = { SWIRLS_API_KEY: 'sk_project_key', SWIRLS_API_URL: `${origin}/api` }

    const result = await withSwirls(
      env,
      signedIn('user_1').session,
      Effect.gen(function* () {
        const agents = yield* Agents

        return {
          configured: yield* agents.configured,
          run: yield* agents.executeWorkflow('new_contact', {}),
          chat: yield* agents.chat,
        }
      }),
    )

    expect(result).toMatchObject({
      _tag: 'Success',
      success: {
        configured: false,
        run: { skipped: true, reason: 'Swirls is not configured' },
        chat: null,
      },
    })

    expect(calls).toEqual([])
  })

  test('with a project id it is configured', async () => {
    const result = await withSwirls(
      PROJECT,
      null,
      Agents.use((agents) => agents.configured),
    )

    expect(result).toMatchObject({ _tag: 'Success', success: true })
  })

  test('with nobody signed in and no API key a workflow is skipped, and says why', async () => {
    const result = await withSwirls(PROJECT, null, start('new_contact'))

    expect(result).toMatchObject({
      _tag: 'Success',
      success: { skipped: true, reason: 'nobody is signed in and SWIRLS_API_KEY is not set' },
    })

    const chat = await withSwirls(
      PROJECT,
      null,
      Agents.use((agents) => agents.chat),
    )

    expect(chat).toMatchObject({ _tag: 'Success', success: null })
    expect(calls).toEqual([])
  })
})

describe('Swirls workflows, with a project API key', () => {
  test('a workflow is found by its name and started with its input', async () => {
    const result = await withSwirls(WITH_KEY, null, start('new_contact', { contactId: 'c1' }))

    expect(result).toMatchObject({
      _tag: 'Success',
      success: { skipped: false, executionId: 'exec_1' },
    })

    const [started] = to('/workflows/executeWorkflow')
    expect(inputOf(started)).toEqual({ workflowId: 'wf_1', input: { contactId: 'c1' } })
    expect(started?.method).toBe('POST')

    expect(calls.map((call) => call.authorization)).toEqual(
      calls.map(() => 'Bearer sk_project_key'),
    )
  })

  test('a workflow on the second page of the list is found: every page is read, 100 at a time', async () => {
    const result = await withSwirls(WITH_KEY, null, start('follow_up'))
    expect(result).toMatchObject({ _tag: 'Success', success: { executionId: 'exec_1' } })

    const pages = to('/workflows/listWorkflows').map((call) => listInput.parse(inputOf(call)))
    expect(pages.map((page) => page.projectId)).toEqual(['proj_1', 'proj_1'])
    expect(pages.map((page) => page.pagination.first)).toEqual([100, 100])
    expect(pages[0]?.pagination.after ?? null).toBeNull()
    expect(pages[1]?.pagination.after).toBe('cursor_1')
    expect(inputOf(to('/workflows/executeWorkflow')[0])).toMatchObject({ workflowId: 'wf_2' })
  })

  test('a name that is not deployed fails and says so, and nothing is started', async () => {
    const missing = await withSwirls(WITH_KEY, null, start('no_such_workflow'))

    expect(messageOf(missing)).toBe(
      'Swirls workflow "no_such_workflow" is not deployed in project proj_1',
    )

    // A workflow whose deployment is no longer the active one is not deployed either.
    const retired = await withSwirls(WITH_KEY, null, start('retired'))
    expect(messageOf(retired)).toBe('Swirls workflow "retired" is not deployed in project proj_1')
    expect(to('/workflows/executeWorkflow')).toEqual([])
  })

  test('the list of workflows is read once and remembered for the next start', async () => {
    const result = await withSwirls(
      WITH_KEY,
      null,
      Effect.gen(function* () {
        yield* start('new_contact')
        return yield* start('follow_up')
      }),
    )

    expect(result._tag).toBe('Success')
    expect(to('/workflows/listWorkflows')).toHaveLength(2)
    expect(to('/workflows/executeWorkflow')).toHaveLength(2)
  })

  test('looking a workflow up is tried again after a failure; starting one never is', async () => {
    failing.set('/workflows/listWorkflows', 1)
    const found = await withSwirls(WITH_KEY, null, start('new_contact'))
    expect(found).toMatchObject({ _tag: 'Success', success: { executionId: 'exec_1' } })
    expect(to('/workflows/listWorkflows')).toHaveLength(3)

    calls = []
    failing.set('/workflows/executeWorkflow', 1)
    const refused = await withSwirls(WITH_KEY, null, start('new_contact'))
    expect(refused._tag).toBe('Failure')
    // A second start would be a second run.
    expect(to('/workflows/executeWorkflow')).toHaveLength(1)
  })

  test('a Swirls that never answers ends in the time limit, not a hang', async () => {
    const asked = new Promise<void>((resolve) => {
      stalled = resolve
    })

    const rt = testRuntime(Layer.mergeAll(layerOf(swirls()), withEnv(WITH_KEY), TestClock.layer()))

    try {
      const result = await rt.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.result(start('new_contact')))
          yield* Effect.promise(() => asked)
          // The limit for a lookup is 10 seconds (policies.agentsRead); the clock is the test's.
          yield* TestClock.adjust('11 seconds')
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provideService(CurrentRequest, {
            headers: new Headers(),
            signal: undefined,
            session: null,
          }),
        ),
      )

      expect(messageOf(result)).toBe('Swirls did not answer in time. Try again.')
      expect(result._tag === 'Failure' ? result.failure._tag : '').toBe('AgentsError')
      expect(to('/workflows/executeWorkflow')).toEqual([])
    } finally {
      await rt.dispose()
    }
  })
})

describe('Swirls federation, with no API key', () => {
  test("the signed-in person's token is exchanged, and Swirls is called with what came back", async () => {
    const ana = signedIn('user_ana')
    const result = await withSwirls(PROJECT, ana.session, start('new_contact'))
    expect(result).toMatchObject({ _tag: 'Success', success: { executionId: 'exec_1' } })

    // The template defaults to "swirls".
    expect(new Set(ana.templates)).toEqual(new Set(['swirls']))

    const [exchange] = to('/oauth2/token')
    const form = new URLSearchParams(exchange?.text)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(form.get('subject_token')).toBe('jwt-of-user_ana')
    expect(form.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt')

    const api = calls.filter((call) => call.path.startsWith('/api/rpc/'))
    expect(api.length).toBeGreaterThan(0)

    // The person's own token never goes to the API: only the one it was exchanged for.
    expect(api.map((call) => call.authorization)).toEqual(
      api.map(() => 'Bearer swirls-token-for-jwt-of-user_ana'),
    )
  })

  test('the token template is the one SWIRLS_JWT_TEMPLATE names', async () => {
    const ana = signedIn('user_ana')

    await withSwirls(
      { ...PROJECT, SWIRLS_JWT_TEMPLATE: 'swirls-staging' },
      ana.session,
      start('new_contact'),
    )

    expect(new Set(ana.templates)).toEqual(new Set(['swirls-staging']))
  })

  test('a token is exchanged once per person and kept, and never shared between people', async () => {
    const ana = signedIn('user_ana')
    const ben = signedIn('user_ben')
    const rt = testRuntime(Layer.mergeAll(layerOf(swirls()), withEnv(PROJECT)))

    const as = (session: Session) =>
      rt.runPromise(
        start('new_contact').pipe(
          Effect.provideService(CurrentRequest, {
            headers: new Headers(),
            signal: undefined,
            session,
          }),
        ),
      )

    try {
      await as(ana.session)
      await as(ana.session)
      expect(to('/oauth2/token')).toHaveLength(1)
      expect(ana.templates).toHaveLength(1)

      calls = []
      await as(ben.session)
      expect(to('/oauth2/token')).toHaveLength(1)

      expect(to('/workflows/executeWorkflow').map((call) => call.authorization)).toEqual([
        'Bearer swirls-token-for-jwt-of-user_ben',
      ])
    } finally {
      await rt.dispose()
    }
  })

  test('when the auth provider has no token for the template, the failure says what to set up', async () => {
    const ana = signedIn('user_ana', null)
    const result = await withSwirls(PROJECT, ana.session, start('new_contact'))

    expect(messageOf(result)).toContain('returned no token for the template "swirls"')
    expect(messageOf(result)).toContain('SWIRLS_API_KEY')
    expect(calls).toEqual([])
  })

  test("the assistant's chat is the signed-in person's own", async () => {
    const ana = signedIn('user_ana')
    const chat = await chatFor(PROJECT, ana.session)
    await chat.listSessions()

    expect(to('/agents/listWebSessions').map((call) => call.authorization)).toEqual([
      'Bearer swirls-token-for-jwt-of-user_ana',
    ])
  })
})

describe("Swirls, the assistant's chat", () => {
  test('past chats are listed from the web channel, as many as asked for', async () => {
    const chat = await chatFor(WITH_KEY, null)
    const sessions = await chat.listSessions({ limit: 5 })
    expect(sessions).toMatchObject([{ sessionId: 's1', title: 'Renewals' }])

    const [listed] = to('/api/rpc/agents/listWebSessions')
    expect(inputOf(listed)).toEqual({ projectId: 'proj_1', bindingName: 'crm_web', limit: 5 })
    expect(listed?.authorization).toBe('Bearer sk_project_key')
  })

  test('a new chat is made for the assistant on its channel', async () => {
    const chat = await chatFor(WITH_KEY, null)
    expect(await chat.createSession({ title: 'Renewals' })).toEqual({ sessionId: 's2' })

    expect(inputOf(to('/api/rpc/agents/createWebSession')[0])).toEqual({
      projectId: 'proj_1',
      bindingName: 'crm_web',
      agentName: 'crm_assistant',
      title: 'Renewals',
    })
  })

  test('an app that names its own assistant and channel gets those', async () => {
    const adapter = swirls({ assistant: { agentName: 'helper', channel: 'help_web' } })
    const chat = await chatFor(WITH_KEY, null, adapter)
    await chat.createSession()

    expect(inputOf(to('/api/rpc/agents/createWebSession')[0])).toMatchObject({
      bindingName: 'help_web',
      agentName: 'helper',
    })
  })

  test("a chat's messages are read by its id", async () => {
    const chat = await chatFor(WITH_KEY, null)
    expect(await chat.getMessages('s1')).toEqual({ messages: [{ id: 'm1', role: 'user' }] })
    expect(inputOf(to('/api/rpc/agents/getWebChatMessages')[0])).toEqual({ sessionId: 's1' })
  })

  test('deleting a chat says whether there was one to delete', async () => {
    const chat = await chatFor(WITH_KEY, null)
    expect(await chat.deleteSession('s1')).toBe(true)
    expect(inputOf(to('/api/rpc/agents/deleteSession')[0])).toEqual({ sessionId: 's1' })

    deleted = false
    expect(await chat.deleteSession('gone')).toBe(false)
  })

  test("a message is passed on to the channel's chat endpoint, and a reply in progress rejoined there", async () => {
    const chat = await chatFor(WITH_KEY, null)

    const posted = new Request('https://crm.acme.test/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 's1', message: 'Who renews this month?' }),
    })

    const reply = await chat.forwardSend(posted, {
      author: { memberId: 'user_ana', displayName: 'Ana Ortiz' },
    })

    expect(await reply.text()).toBe('a reply, as it comes')

    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/chat/web/proj_1/crm_web',
      authorization: 'Bearer sk_project_key',
      text: JSON.stringify({ id: 's1', message: 'Who renews this month?' }),
    })

    await chat.forwardResumeStream('s1')
    expect(calls[1]).toMatchObject({ method: 'GET', path: '/chat/web/proj_1/crm_web/s1/stream' })
  })

  test('a reply cannot be asked for again', async () => {
    expect((await chatFor(WITH_KEY, null)).regenerate).toBe(false)
  })
})
