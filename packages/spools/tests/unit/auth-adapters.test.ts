import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { Effect } from 'effect'

import {
  type ClerkUser,
  clerk,
  developmentInstance,
  isTestAddress,
  toAuthUser,
  tokenRefusal,
} from '../../src/adapters/auth/clerk/server'
import { devAuth } from '../../src/adapters/auth/dev/server'
import { environmentProblems } from '../../src/server/env'
import { Auth } from '../../src/server/runtime/auth'
import { testRuntime } from '../../src/testing/run'

const clerkUser = (change: Partial<ClerkUser> = {}): ClerkUser => ({
  id: 'user_1',
  firstName: 'Ana',
  lastName: 'Ortiz',
  primaryEmailAddressId: 'e1',
  emailAddresses: [
    { id: 'e1', emailAddress: 'ana@example.com', verification: { status: 'verified' } },
  ],
  ...change,
})

describe('Clerk', () => {
  test('a person is their verified primary address and name', () => {
    expect(toAuthUser(clerkUser())).toEqual({
      id: 'user_1',
      name: 'Ana Ortiz',
      email: 'ana@example.com',
      accounts: [],
    })

    expect(toAuthUser(clerkUser({ firstName: null, lastName: null })).name).toBeNull()
  })

  test("an address Clerk hasn't verified is no address: it must not open an allowed domain", () => {
    const unverified = [
      { id: 'e1', emailAddress: 'ana@example.com', verification: { status: 'unverified' } },
    ]

    expect(toAuthUser(clerkUser({ emailAddresses: unverified })).email).toBeNull()
    const none = [{ id: 'e1', emailAddress: 'ana@example.com', verification: null }]
    expect(toAuthUser(clerkUser({ emailAddresses: none })).email).toBeNull()

    // A verified address that isn't the primary one doesn't count either.
    const second = [
      { id: 'e1', emailAddress: 'ana@example.com', verification: { status: 'unverified' } },
      { id: 'e2', emailAddress: 'ana@other.test', verification: { status: 'verified' } },
    ]

    expect(toAuthUser(clerkUser({ emailAddresses: second })).email).toBeNull()
  })

  test("one of Clerk's test addresses, which anybody can verify, is no address in a deployment", () => {
    const testAddress = (emailAddress: string) =>
      clerkUser({
        emailAddresses: [{ id: 'e1', emailAddress, verification: { status: 'verified' } }],
      })

    expect(toAuthUser(testAddress('mallory+clerk_test@example.com')).email).toBeNull()
    expect(toAuthUser(testAddress('Mallory+CLERK_TEST_2@example.com')).email).toBeNull()
    // On a developer's own machine it is how Clerk's sign-in is tried out.

    expect(toAuthUser(testAddress('ana+clerk_test@example.com'), true).email).toBe(
      'ana+clerk_test@example.com',
    )

    // An ordinary plus address is somebody's own.
    expect(toAuthUser(testAddress('ana+crm@example.com')).email).toBe('ana+crm@example.com')
    expect(isTestAddress('ana@clerk_test.example.com')).toBe(false)
  })

  test("a deployment on a development instance's keys is told so at start-up", () => {
    const env = { CLERK_SECRET_KEY: 'sk_test_abc', CLERK_PUBLISHABLE_KEY: 'pk_test_abc' }

    expect(developmentInstance({ ...env, NODE_ENV: 'production' })).toContain(
      'development instance',
    )

    expect(developmentInstance({ ...env, NODE_ENV: 'development' })).toBeNull()

    expect(
      developmentInstance({ NODE_ENV: 'production', CLERK_SECRET_KEY: 'sk_live_abc' }),
    ).toBeNull()

    expect(clerk().features?.map((f) => f.check)).toEqual([developmentInstance])
  })

  test("sign-in accounts lose Clerk's prefix, and their scopes are split", () => {
    const { accounts } = toAuthUser(
      clerkUser({
        externalAccounts: [
          {
            provider: 'oauth_google',
            emailAddress: 'ana@gmail.test',
            approvedScopes: 'email  profile',
          },
          { provider: 'microsoft', emailAddress: 'ana@outlook.test' },
        ],
      }),
    )

    expect(accounts).toEqual([
      { provider: 'google', email: 'ana@gmail.test', scopes: ['email', 'profile'] },
      { provider: 'microsoft', email: 'ana@outlook.test', scopes: [] },
    ])
  })

  test('a refused token says what to do about it', () => {
    const shared = tokenRefusal('google', {
      status: 400,
      errors: [{ code: 'oauth_shared_credentials_x' }],
    })

    expect(shared.kind).toBe('setup')
    expect(shared.message).toContain('Set up custom credentials for Google in Clerk')

    const gone = tokenRefusal('microsoft', {
      status: 422,
      errors: [{ code: 'oauth_token_missing' }],
    })

    expect(gone.kind).toBe('account')
    expect(gone.message).toContain('Microsoft token (oauth_token_missing)')
    expect(tokenRefusal('google', { status: 503 }).kind).toBe('unavailable')
  })
})

describe('the development sign-in', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    delete process.env['DEV_AUTH_SIGNED_OUT']
    process.env['DEV_AUTH_EMAIL'] = 'me@example.com'
  })

  afterEach(() => {
    for (const name of ['NODE_ENV', 'DEV_AUTH_EMAIL', 'DEV_AUTH_SIGNED_OUT']) {
      if (saved[name] === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = saved[name]
      }
    }
  })

  const request = new Request('http://localhost/')

  test('every request is one person, whose address the environment says', async () => {
    const auth = devAuth({ teammates: [{ id: 't', name: 'Tess', email: 'tess@example.com' }] })
    const session = await auth.session(request)
    const rt = testRuntime(auth.layer as Parameters<typeof testRuntime<Auth>>[0])
    const me = await rt.runPromise(Auth.use((a) => a.getUser(session!.userId)))
    expect(me.email).toBe('me@example.com')

    expect((await rt.runPromise(Auth.use((a) => a.listUsers))).map((u) => u.id)).toEqual([
      session!.userId,
      't',
    ])

    expect(await rt.runPromise(Effect.flip(Auth.use((a) => a.getUser('nobody'))))).toMatchObject({
      kind: 'answer',
    })

    await rt.dispose()
  })

  test('it can show the app signed out', async () => {
    process.env['DEV_AUTH_SIGNED_OUT'] = '1'
    expect(await devAuth().session(request)).toBeNull()
  })

  test('it refuses to run in production', () => {
    process.env['NODE_ENV'] = 'production'
    expect(() => devAuth()).toThrow('does not run in production')
  })
})

describe('what adapters require of the environment', () => {
  const requirements = [
    { name: 'KEY', check: (v: string) => (v.startsWith('sk_') ? null : 'must start with "sk_"') },
    { name: 'URL_A', or: ['URL_B'] },
  ]

  test('missing and malformed variables are named; an alternative will do', () => {
    expect(environmentProblems(requirements, {})).toEqual(['KEY is not set', 'URL_A is not set'])

    expect(environmentProblems(requirements, { KEY: 'pk_1', URL_B: 'x' })).toEqual([
      'KEY must start with "sk_"',
    ])

    expect(environmentProblems(requirements, { KEY: 'sk_1', URL_A: 'x' })).toEqual([])
  })
})
