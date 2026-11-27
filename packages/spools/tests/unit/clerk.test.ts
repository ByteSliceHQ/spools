import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { Effect, Layer } from 'effect'

import { clerk } from '../../src/adapters/auth/clerk/server'
import { Auth } from '../../src/server/runtime/auth'
import { httpLayer } from '../../src/server/runtime/http'
import { Scopes } from '../../src/server/scopes'
import { makeStore, Store } from '../../src/server/store/store'
import { testRuntime } from '../../src/testing/run'

// Clerk's directory against a stand-in Clerk Backend API on this machine. The
// Clerk SDK reads CLERK_API_URL each time it makes a client, so the adapter is
// pointed at the stand-in through the environment. `fetch` refuses any other
// address while this file runs, so nothing here can reach the real Clerk. The
// adapter's pure functions are tested in auth-adapters.test.ts.

const VARIABLES = [
  'NODE_ENV',
  'CLERK_API_URL',
  'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY',
  'VITE_CLERK_PUBLISHABLE_KEY',
  'CLERK_TELEMETRY_DISABLED',
] as const

const saved = new Map<string, string | undefined>()

type Call = { method: string; path: string; query: URLSearchParams; authorization: string | null }

/** What the stand-in was asked, in order. */
let calls: Call[] = []
/** Answers given instead of the usual ones, first come first served, for the path they name. */
let instead: { path: string; response: () => Response }[] = []

const clerkUser = (id: string, email: string, change: Record<string, unknown> = {}) => ({
  object: 'user',
  id,
  first_name: 'Ana',
  last_name: 'Ortiz',
  primary_email_address_id: 'idn_1',
  email_addresses: [
    {
      object: 'email_address',
      id: 'idn_1',
      email_address: email,
      verification: { status: 'verified', strategy: 'email_code' },
      linked_to: [],
    },
  ],
  phone_numbers: [],
  web3_wallets: [],
  external_accounts: [],
  ...change,
})

/** Clerk's SDK reads a body as JSON only when the content type is exactly this. */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ORGANIZATIONS = Array.from({ length: 230 }, (_, n) => ({
  object: 'organization',
  id: `org_${n}`,
  name: `Branch ${n}`,
  slug: `branch-${n}`,
}))

const refusal = (status: number, code: string, message = code) =>
  json({ errors: [{ code, message, long_message: message }] }, status)

const answer = (request: Request): Response => {
  const url = new URL(request.url)

  calls.push({
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    authorization: request.headers.get('authorization'),
  })

  const at = instead.findIndex((planned) => planned.path === url.pathname)

  if (at !== -1) {
    const [planned] = instead.splice(at, 1)

    if (planned) {
      return planned.response()
    }
  }

  if (url.pathname === '/v1/users/count') {
    return json({ object: 'total_count', total_count: 2 })
  }

  if (url.pathname === '/v1/users') {
    return json([
      clerkUser('user_1', 'ana@acme.test'),
      clerkUser('user_2', 'ben@acme.test', { first_name: 'Ben', last_name: null }),
    ])
  }

  if (url.pathname === '/v1/users/user_1') {
    return json(
      clerkUser('user_1', 'ana@acme.test', {
        external_accounts: [
          {
            object: 'external_account',
            id: 'eac_1',
            provider: 'oauth_google',
            email_address: 'ana@gmail.test',
            approved_scopes: 'email profile',
            verification: { status: 'verified', strategy: 'oauth_google' },
          },
        ],
      }),
    )
  }

  if (url.pathname === '/v1/users/user_test') {
    return json(clerkUser('user_test', 'mallory+clerk_test@acme.test'))
  }

  if (url.pathname === '/v1/users/user_1/oauth_access_tokens/oauth_google') {
    return json({
      data: [
        { object: 'oauth_access_token', provider: 'oauth_google', token: 'ya29.first', scopes: [] },
        {
          object: 'oauth_access_token',
          provider: 'oauth_google',
          token: 'ya29.second',
          scopes: [],
        },
      ],
      total_count: 2,
    })
  }

  // More organizations than one page holds: 230 in all, and user_1 is a member of each.
  if (
    url.pathname === '/v1/users/user_1/organization_memberships' ||
    url.pathname === '/v1/organizations'
  ) {
    const limit = Number(url.searchParams.get('limit') ?? 10)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const page = ORGANIZATIONS.slice(offset, offset + limit)

    return json({
      data:
        url.pathname === '/v1/organizations'
          ? page
          : page.map((organization, i) => ({
              object: 'organization_membership',
              id: `orgmem_${offset + i}`,
              role: organization.id === 'org_0' ? 'org:headOffice' : 'org:member',
              organization,
              public_user_data: {
                user_id: 'user_1',
                identifier: 'ana@acme.test',
                first_name: 'Ana',
                last_name: 'Ortiz',
                image_url: '',
                has_image: false,
              },
            })),
      total_count: ORGANIZATIONS.length,
    })
  }

  if (url.pathname.includes('/oauth_access_tokens/')) {
    return json({ data: [], total_count: 0 })
  }

  return refusal(404, 'resource_not_found', 'Not Found')
}

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: answer })
const origin = `http://127.0.0.1:${server.port}`
const realFetch = globalThis.fetch

beforeAll(() => {
  for (const name of VARIABLES) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }

  process.env['CLERK_API_URL'] = origin
  process.env['CLERK_SECRET_KEY'] = 'sk_test_stand_in'
  process.env['CLERK_TELEMETRY_DISABLED'] = '1'

  const onlyTheStandIn: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const address = input instanceof Request ? input.url : String(input)

      if (!address.startsWith(origin)) {
        throw new Error(`a Clerk test tried to reach ${address}`)
      }

      return realFetch(input, init)
    },
    { preconnect: realFetch.preconnect },
  )

  globalThis.fetch = onlyTheStandIn
})

afterAll(async () => {
  globalThis.fetch = realFetch

  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }

  await server.stop(true)
})

beforeEach(() => {
  calls = []
  instead = []
})

/** Every adapter may ask for the store and the HTTP client. This one must use neither: the store here fails if it is touched. */
const untouched = Effect.die('the Clerk adapter does not read or write the database')

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

/** Runs a program on the Clerk adapter's own layer and returns how it ended. */
const withClerk = <A, E>(program: Effect.Effect<A, E, Auth>) => {
  const rt = testRuntime(clerk().layer.pipe(Layer.provide(outside)))

  return rt.runPromise(Effect.result(program)).finally(() => rt.dispose())
}

const getUser = (id: string) => withClerk(Auth.use((auth) => auth.getUser(id)))

const accountToken = (userId: string, provider: string) =>
  withClerk(Auth.use((auth) => auth.accountToken(userId, provider)))

const to = (path: string) => calls.filter((call) => call.path === path)

describe("Clerk's directory", () => {
  test('a person is read by id, with their verified primary address and sign-in accounts', async () => {
    expect(await getUser('user_1')).toMatchObject({
      _tag: 'Success',
      success: {
        id: 'user_1',
        name: 'Ana Ortiz',
        email: 'ana@acme.test',
        accounts: [{ provider: 'google', email: 'ana@gmail.test', scopes: ['email', 'profile'] }],
      },
    })

    expect(calls).toHaveLength(1)

    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/v1/users/user_1',
      authorization: 'Bearer sk_test_stand_in',
    })
  })

  test("one of Clerk's test addresses counts on a developer's machine and never in a deployment", async () => {
    expect(await getUser('user_test')).toMatchObject({
      _tag: 'Success',
      success: { email: 'mallory+clerk_test@acme.test' },
    })

    process.env['NODE_ENV'] = 'production'

    try {
      expect(await getUser('user_test')).toMatchObject({
        _tag: 'Success',
        success: { email: null },
      })
    } finally {
      delete process.env['NODE_ENV']
    }
  })

  test('the team is the first 200 people, oldest first', async () => {
    const result = await withClerk(Auth.use((auth) => auth.listUsers))

    expect(result).toMatchObject({
      _tag: 'Success',
      success: [
        { id: 'user_1', name: 'Ana Ortiz', email: 'ana@acme.test' },
        { id: 'user_2', name: 'Ben', email: 'ben@acme.test' },
      ],
    })

    const [listed] = to('/v1/users')
    expect(listed?.query.get('limit')).toBe('200')
    expect(listed?.query.get('order_by')).toBe('+created_at')
    expect(to('/v1/users')).toHaveLength(1)
  })

  test("a sign-in account's token is the first one Clerk holds, or null when it holds none", async () => {
    expect(await accountToken('user_1', 'google')).toMatchObject({
      _tag: 'Success',
      success: 'ya29.first',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/v1/users/user_1/oauth_access_tokens/oauth_google')

    expect(await accountToken('user_1', 'microsoft')).toMatchObject({
      _tag: 'Success',
      success: null,
    })
  })
})

describe('Clerk, when it says no or has a bad moment', () => {
  test('a person Clerk does not know is its answer, and is not asked for again', async () => {
    const result = await getUser('user_nobody')

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'AuthError', kind: 'answer' },
    })

    expect(to('/v1/users/user_nobody')).toHaveLength(1)
  })

  test('a request Clerk cannot process (422) is its answer too', async () => {
    instead = [
      { path: '/v1/users/user_1', response: () => refusal(422, 'form_param_format_invalid') },
    ]

    const result = await getUser('user_1')
    expect(result).toMatchObject({ _tag: 'Failure', failure: { kind: 'answer' } })
    expect(to('/v1/users/user_1')).toHaveLength(1)
  })

  test('a server error is tried once more, and the second answer is used', async () => {
    instead = [{ path: '/v1/users/user_1', response: () => refusal(500, 'internal_error') }]
    const result = await getUser('user_1')
    expect(result).toMatchObject({ _tag: 'Success', success: { email: 'ana@acme.test' } })
    expect(to('/v1/users/user_1')).toHaveLength(2)
  })

  test('a rate limit is tried once more; when Clerk is still busy it is reported as unavailable', async () => {
    const busy = () => refusal(429, 'too_many_requests')

    instead = [
      { path: '/v1/users/user_1', response: busy },
      { path: '/v1/users/user_1', response: busy },
    ]

    const result = await getUser('user_1')
    expect(result).toMatchObject({ _tag: 'Failure', failure: { kind: 'unavailable' } })
    // One retry (policies.authUsers), never more.
    expect(to('/v1/users/user_1')).toHaveLength(2)
  })

  test("Clerk's shared development credentials are named as the reason there is no mailbox token", async () => {
    const path = '/v1/users/user_1/oauth_access_tokens/oauth_google'

    instead = [{ path, response: () => refusal(400, 'oauth_shared_credentials_token_unavailable') }]

    const result = await accountToken('user_1', 'google')

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        kind: 'setup',
        message:
          "Clerk is using its shared development credentials for Google, which can't give the CRM mailbox access. Set up custom credentials for Google in Clerk.",
      },
    })

    expect(to(path)).toHaveLength(1)
  })

  test("a token Clerk refuses is the account's to fix; one it fails to fetch is tried again", async () => {
    const path = '/v1/users/user_1/oauth_access_tokens/oauth_google'
    instead = [{ path, response: () => refusal(422, 'oauth_missing_refresh_token') }]
    const refused = await accountToken('user_1', 'google')

    expect(refused).toMatchObject({
      _tag: 'Failure',
      failure: {
        kind: 'account',
        message:
          'Clerk could not provide a Google token (oauth_missing_refresh_token). Reconnect the account from your profile.',
      },
    })

    expect(to(path)).toHaveLength(1)

    calls = []
    instead = [{ path, response: () => refusal(503, 'service_unavailable') }]
    const again = await accountToken('user_1', 'google')
    expect(again).toMatchObject({ _tag: 'Success', success: 'ya29.first' })
    expect(to(path)).toHaveLength(2)
  })
})

describe('Clerk organizations as record scopes', () => {
  const ana = { id: 'user_1', email: 'ana@acme.test', name: 'Ana Ortiz' }

  /** Runs a program on the scopes the adapter provides, as it is set up. */
  const withScopes = <A, E>(
    options: Parameters<typeof clerk>[0],
    program: Effect.Effect<A, E, Scopes>,
  ) => {
    const { scopes } = clerk(options)

    if (!scopes) {
      throw new Error('The adapter was not asked for scopes')
    }

    const rt = testRuntime(scopes)
    return rt.runPromise(program).finally(() => rt.dispose())
  }

  test('every membership is read, a page at a time, however many organizations a person is in', async () => {
    const path = '/v1/users/user_1/organization_memberships'

    const grants = await withScopes(
      { scopes: 'organizations' },
      Scopes.use((scopes) => scopes.grants(ana)),
    )

    expect(grants).toHaveLength(230)
    expect(grants.at(-1)).toEqual({ scope: 'org_229', role: 'member' })
    // The scope is the organization's id, never the slug its administrators can rename.
    expect(grants.every((grant) => grant.scope.startsWith('org_'))).toBe(true)

    expect(to(path).map((call) => [call.query.get('limit'), call.query.get('offset')])).toEqual([
      // Clerk's client leaves an offset of nothing out.
      ['100', null],
      ['100', '100'],
      ['100', '200'],
    ])
  })

  test('every organization is listed for the switcher, a page at a time', async () => {
    const listed = await withScopes(
      { scopes: 'organizations' },
      Scopes.use((scopes) => scopes.list),
    )

    expect(listed).toHaveLength(230)
    expect(listed[0]).toEqual({ key: 'org_0', label: 'Branch 0' })
    expect(listed.at(-1)).toEqual({ key: 'org_229', label: 'Branch 229' })
    expect(to('/v1/organizations')).toHaveLength(3)
  })

  test('each adapter keeps its own `everyScopeFrom`: one made later doesn’t change one made before', async () => {
    const first = clerk({ scopes: 'organizations', everyScopeFrom: ['org_0'] })
    // Another adapter, made afterwards with nothing named.
    clerk({ scopes: 'organizations' })

    const check = first.features?.find((feature) => feature.name.includes('Record scopes'))?.check
    // The first still knows its own (this Spool's config has no role that reaches every scope).
    expect(check?.({})).toBeNull()
  })
})
