import { afterAll, describe, expect, spyOn, test } from 'bun:test'

import { Effect, Layer } from 'effect'

import { appLayer, type CurrentRequest } from '../../src/server/runtime/app'
import { Auth, type AuthUser } from '../../src/server/runtime/auth'
import { cronAuthorized, forStrangers, serve, signedIn } from '../../src/server/runtime/boundary'
import {
  AuthError,
  DatabaseError,
  Invalid,
  NotFound,
  Timeout,
} from '../../src/server/runtime/errors'
import { withPolicy } from '../../src/server/runtime/policies'
import { crmConfig } from '../../src/server/spool'
import { Users } from '../../src/server/users'
import { runWithEnv, testRuntime } from '../support/run'

// The boundary between TanStack Start and Effect programs, run on a runtime
// built from fake layers: no auth provider, no database.

const { allowedEmails, allowedDomains } = crmConfig().access

const allowedEmail =
  allowedEmails[0] ?? (allowedDomains[0] ? `ana@${allowedDomains[0]}` : undefined)

// An adapter gives an address only when its provider has verified it.
const person = (id: string, email: string | null): AuthUser => ({
  id,
  name: 'Ana Ortiz',
  email,
  accounts: [],
})

const people: AuthUser[] = [
  ...(allowedEmail ? [person('user_ana', allowedEmail)] : []),
  person('user_unverified', null),
  person('user_outsider', 'someone@not-on-the-list.invalid'),
]

let authCalls = 0

const countingAuth = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const inner = yield* Auth
    return Auth.of({
      getUser: (id) => Effect.sync(() => authCalls++).pipe(Effect.andThen(inner.getUser(id))),
      listUsers: Effect.sync(() => authCalls++).pipe(Effect.andThen(inner.listUsers)),
      accountToken: inner.accountToken,
    })
  }),
).pipe(Layer.provide(Auth.layerTest(people)))

// The real app layer with the auth provider and HTTP replaced: no network. Nothing here reads the database.
const rt = testRuntime(
  appLayer({
    auth: countingAuth,
    fetch: async () => {
      throw new Error('no network in unit tests')
    },
  }),
)

afterAll(() => rt.dispose())

const request = (signal?: AbortSignal): CurrentRequest['Service'] => ({
  headers: new Headers(),
  signal,
  session: null,
})

const quietly = () => [
  spyOn(console, 'warn').mockImplementation(() => {}),
  spyOn(console, 'error').mockImplementation(() => {}),
]

describe('serve', () => {
  test('returns what the program succeeds with', async () => {
    expect(await serve(rt, 'test.ok', request(), Effect.succeed({ ok: true }))).toEqual({
      ok: true,
    })
  })

  test('a typed error reaches the browser as an Error with the staff message', async () => {
    const [warn, error] = quietly()

    const thrown = await serve(
      rt,
      'test.invalid',
      request(),
      Effect.fail(new Invalid({ message: 'Unknown guide' })),
    ).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('Unknown guide')
    expect(warn!.mock.calls[0]?.[0]).toContain('test.invalid failed')
    expect(warn!.mock.calls[0]?.[0]).toContain('Invalid: Unknown guide')
    warn!.mockRestore()
    error!.mockRestore()
  })

  test("messages staff read keep today's wording", () => {
    expect(new NotFound({ what: 'Record' }).message).toBe('Record not found')

    expect(new Timeout({ service: 'FlashDrive' }).message).toBe(
      'FlashDrive did not answer in time. Try again.',
    )

    expect(new AuthError({ message: 'Clerk said no', kind: 'answer' }).message).toBe(
      'Clerk said no',
    )
  })

  test('a bug is logged once with a reference and rethrown as it was', async () => {
    const [warn, error] = quietly()
    const bug = new TypeError('cannot read properties of undefined')

    const thrown = await serve(rt, 'test.bug', request(), Effect.die(bug)).catch(
      (err: unknown) => err,
    )

    expect(thrown).toBe(bug)
    expect(error!.mock.calls).toHaveLength(1)

    expect(error!.mock.calls[0]?.[0]).toMatch(
      /test\.bug failed after \d+ ms \(reference [0-9a-f]{8}\)/,
    )

    warn!.mockRestore()
    error!.mockRestore()
  })

  test('when the browser goes away the program is interrupted and its cleanup runs', async () => {
    const controller = new AbortController()
    let cleanedUp = false
    const slow = Effect.never.pipe(Effect.ensuring(Effect.sync(() => (cleanedUp = true))))

    const pending = serve(rt, 'test.slow', request(controller.signal), slow).catch(
      (err: unknown) => err,
    )

    setTimeout(() => controller.abort(), 10)
    const thrown = (await pending) as DOMException
    // src/server.ts turns an AbortError on an aborted request into a 499.
    expect(thrown.name).toBe('AbortError')
    expect(cleanedUp).toBe(true)
  })
})

describe('signed in', () => {
  const who = (userId: string | null) => rt.runPromise(Effect.flip(signedIn(userId)))

  test('no session means sign in', async () => {
    expect((await who(null)).message).toBe('Sign in required')
  })

  test('an account off the access list, or with an unverified email, is refused', async () => {
    expect((await who('user_outsider')).message).toBe('Your account is not allowed to use this CRM')

    expect((await who('user_unverified')).message).toBe(
      'Your account is not allowed to use this CRM',
    )
  })

  test.if(!!allowedEmail)(
    'an allowed account is the CRM user, asked of the provider once a minute',
    async () => {
      const before = authCalls
      const user = await rt.runPromise(signedIn('user_ana'))
      expect(user).toEqual({ id: 'user_ana', email: allowedEmail!, name: 'Ana Ortiz' })
      await rt.runPromise(signedIn('user_ana'))
      await rt.runPromise(signedIn('user_ana'))
      expect(authCalls - before).toBe(1)
    },
  )

  test('the team is everyone allowed in, by name', async () => {
    const team = await rt.runPromise(Users.use((users) => users.team))
    expect(team.map((u) => u.id)).toEqual(allowedEmail ? ['user_ana'] : [])
  })
})

describe('cron secret', () => {
  const headers = (token?: string) => new Headers(token ? { authorization: `Bearer ${token}` } : {})
  const secret = 'a-cron-secret-of-24-chars'

  test("the scheduler's bearer token is accepted; anything else is refused", async () => {
    expect(await runWithEnv({ CRON_SECRET: secret }, cronAuthorized(headers(secret)))).toBe(true)
    expect(await runWithEnv({ CRON_SECRET: secret }, cronAuthorized(headers('wrong')))).toBe(false)
    expect(await runWithEnv({ CRON_SECRET: secret }, cronAuthorized(headers()))).toBe(false)
  })

  test('without a secret, or with a short one, the cron routes refuse everyone', async () => {
    expect(await runWithEnv({}, cronAuthorized(headers('')))).toBe(false)
    expect(await runWithEnv({ CRON_SECRET: 'short' }, cronAuthorized(headers('short')))).toBe(false)
  })
})

describe('policies', () => {
  const policy = { service: 'FlashDrive', timeout: '100 millis', retries: 2 } as const

  const flaky = (failures: number) => {
    let calls = 0

    const effect = Effect.suspend(() =>
      ++calls <= failures
        ? Effect.fail(new AuthError({ message: `attempt ${calls}`, kind: 'unavailable' }))
        : Effect.succeed(calls),
    )

    return { effect, calls: () => calls }
  }

  test('a failure the policy allows is tried again', async () => {
    const call = flaky(2)

    expect(
      await Effect.runPromise(call.effect.pipe(withPolicy({ ...policy, timeout: '5 seconds' }))),
    ).toBe(3)
  })

  test('the time limit covers the retries too, not each attempt', async () => {
    // The first retry waits about 200 ms, longer than this limit.
    const error = await Effect.runPromise(Effect.flip(flaky(5).effect.pipe(withPolicy(policy))))
    expect(error).toBeInstanceOf(Timeout)
  })

  test("retries stop at the policy's count", async () => {
    const call = flaky(5)

    const error = await Effect.runPromise(
      Effect.flip(call.effect.pipe(withPolicy({ ...policy, timeout: '5 seconds' }))),
    )

    expect(error.message).toBe('attempt 3')
    expect(call.calls()).toBe(3)
  })

  test('a failure the policy says is final is not tried again', async () => {
    const call = flaky(5)
    await Effect.runPromise(Effect.flip(call.effect.pipe(withPolicy(policy, () => false))))
    expect(call.calls()).toBe(1)
  })

  test('a call that hangs fails with Timeout, naming the service', async () => {
    const error = await Effect.runPromise(Effect.flip(Effect.never.pipe(withPolicy(policy))))
    expect(error).toBeInstanceOf(Timeout)
    expect(error.message).toBe('FlashDrive did not answer in time. Try again.')
  })
})

describe('what someone who is not signed in hears', () => {
  const driver =
    'connect ECONNREFUSED db.internal:5432, relation "Suppression" violates "email_key"'

  test("nothing of the database's own words, which name the host and the tables", async () => {
    const failed = Effect.fail(new DatabaseError({ cause: new Error(driver) }))
    const error = await Effect.runPromise(Effect.flip(forStrangers('email.unsubscribe', failed)))

    expect(error).toBeInstanceOf(Invalid)
    expect(error.message).not.toContain('db.internal')
    expect(error.message).not.toContain('Suppression')
  })

  test('any other failure is told as it is', async () => {
    const failed = Effect.fail(new NotFound({ what: 'Link' }))
    const error = await Effect.runPromise(Effect.flip(forStrangers('email.unsubscribe', failed)))

    expect(error.message).toBe('Link not found')
  })
})
