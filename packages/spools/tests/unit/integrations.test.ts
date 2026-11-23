import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { Effect } from 'effect'
import { z } from 'zod'

import extensions from '../../../../apps/starter/src/app/extensions'
import { cipherStashConfigured } from '../../src/adapters/vault/cipherstash/server'
import {
  createAuthRequest,
  IntegrationError,
  isProvider,
  problemsIn,
  providerConfigured,
  providers,
  redirectUri,
  setupProblems,
  validateIntegrations,
  verifyState,
} from '../../src/server/integrations'
import { type AppServices, appLayer } from '../../src/server/runtime/app'
import { Auth } from '../../src/server/runtime/auth'
import { Vault, VaultError } from '../../src/server/runtime/vault'
import { testRuntime } from '../support/run'

const vars = {
  APP_URL: 'https://crm.example.com/',
  APP_SECRET: 's'.repeat(40),
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  MICROSOFT_CLIENT_ID: 'ms-client',
  MICROSOFT_CLIENT_SECRET: 'ms-secret',
}

const saved: Record<string, string | undefined> = {}

const cs = [
  'CS_WORKSPACE_CRN',
  'CS_CLIENT_ID',
  'CS_CLIENT_KEY',
  'CS_CLIENT_ACCESS_KEY',
  'MICROSOFT_TENANT_ID',
]

// A reversible stand-in for CipherStash, so these tests need no credentials.
const fakeCipher = {
  encrypt: async (plaintext: string) =>
    JSON.stringify({ c: Buffer.from(plaintext).toString('base64') }),
  decrypt: async (ciphertext: string) => Buffer.from(JSON.parse(ciphertext).c, 'base64').toString(),
}

// The app with the stand-in cipher, and the app as deployed without CipherStash credentials.
const withCipher = testRuntime(
  appLayer({ vault: Vault.layerTest(fakeCipher), auth: Auth.layerTest([]) }),
)

const withoutCipher = testRuntime(appLayer({ auth: Auth.layerTest([]) }))
const run = <A, E>(program: Effect.Effect<A, E, AppServices>) => withCipher.runPromise(program)
const bare = <A, E>(program: Effect.Effect<A, E, AppServices>) => withoutCipher.runPromise(program)
const env = () => process.env

beforeAll(() => {
  for (const key of [...Object.keys(vars), ...cs]) {
    saved[key] = process.env[key]
  }

  Object.assign(process.env, vars)

  for (const key of cs) {
    delete process.env[key]
  }
})

afterAll(async () => {
  await withCipher.dispose()
  await withoutCipher.dispose()

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('vault', () => {
  test('round-trips a value, and what is stored is not the plaintext', async () => {
    const sealed = await run(
      Vault.use((v) => v.seal({ accessToken: 'ya29.secret', refreshToken: '1//refresh' }, 'row')),
    )

    expect(sealed).not.toContain('ya29.secret')
    expect(sealed).not.toContain('1//refresh')

    const Tokens = z.object({ accessToken: z.string(), refreshToken: z.string() })

    expect(await run(Vault.use((v) => v.open(sealed, 'row', Tokens)))).toEqual({
      value: { accessToken: 'ya29.secret', refreshToken: '1//refresh' },
      bound: true,
    })
  })

  test("refuses to store anything when encryption isn't configured: no plaintext fallback", async () => {
    expect(cipherStashConfigured(process.env)).toBe(false)

    await expect(
      bare(Vault.use((v) => v.seal({ accessToken: 'x' }, 'row'))),
    ).rejects.toBeInstanceOf(VaultError)

    await expect(bare(Vault.use((v) => v.open('{}', 'row', z.unknown())))).rejects.toThrow(
      "Encryption isn't set up",
    )

    expect(await bare(setupProblems)).toContain(
      'CipherStash encryption is not set up (CS_* variables)',
    )
  })

  test('is configured only when every CipherStash variable is set', () => {
    const three = { CS_WORKSPACE_CRN: 'crn', CS_CLIENT_ID: 'id', CS_CLIENT_KEY: 'key' }
    expect(cipherStashConfigured(three)).toBe(false)
    expect(cipherStashConfigured({ ...three, CS_CLIENT_ACCESS_KEY: 'access' })).toBe(true)
  })
})

describe('provider setup', () => {
  test('a provider is offered once its client id and secret are set', () => {
    expect(providerConfigured('google', env())).toBe(true)
    expect(providerConfigured('google', { GOOGLE_CLIENT_ID: 'only-id' })).toBe(false)
    expect(providerConfigured('microsoft', {})).toBe(false)
  })

  test('the redirect URI comes from APP_URL without a doubled slash', () => {
    expect(redirectUri('google', env())).toBe(
      'https://crm.example.com/api/integrations/google/callback',
    )

    expect(redirectUri('microsoft', env())).toBe(
      'https://crm.example.com/api/integrations/microsoft/callback',
    )
  })

  test('setup problems name what is missing', async () => {
    expect(await run(setupProblems)).toEqual([])

    expect(problemsIn({}, 'No vault')).toEqual([
      'APP_URL is not set',
      'APP_SECRET must be set (32+ characters)',
      'No vault',
    ])
  })

  test('a mailbox is asked for reading and sending, and nothing broader', () => {
    const { google, microsoft } = providers()
    const scopes = [...google!.scopes, ...microsoft!.scopes]

    for (const scope of [
      'gmail.readonly',
      'calendar.readonly',
      'gmail.send',
      'Mail.Read',
      'Calendars.Read',
      'Mail.Send',
    ]) {
      expect(scopes.some((s) => s.endsWith(scope))).toBe(true)
    }

    expect(scopes.join(' ')).not.toMatch(
      /Mail\.ReadWrite|Calendars\.ReadWrite|gmail\.modify|mail\.google\.com/i,
    )

    expect(google?.mailbox).toBe('google')
    expect(microsoft?.mailbox).toBe('microsoft')
  })
})

describe('providers the app adds', () => {
  const books = {
    label: 'Acme Books',
    description: 'Read invoices',
    clientId: 'BOOKS_CLIENT_ID',
    clientSecret: 'BOOKS_CLIENT_SECRET',
    authUrl: 'https://books.example.com/oauth/authorize',
    tokenUrl: 'https://books.example.com/oauth/token',
    scopes: ['invoices.read'],
    account: async () => 'company-1',
  }

  const withIntegrations = (integrations: typeof extensions.integrations, run: () => void) => {
    const before = extensions.integrations
    extensions.integrations = integrations

    try {
      run()
    } finally {
      if (before === undefined) {
        delete extensions.integrations
      } else {
        extensions.integrations = before
      }
    }
  }

  test('are offered next to the built-in mailboxes, and are not mailboxes', () => {
    expect(isProvider('books')).toBe(false)

    withIntegrations({ books }, () => {
      expect(Object.keys(providers())).toEqual(['google', 'microsoft', 'books'])
      expect(providers()['books']?.mailbox).toBeUndefined()

      expect(
        providerConfigured('books', { BOOKS_CLIENT_ID: 'id', BOOKS_CLIENT_SECRET: 'secret' }),
      ).toBe(true)

      expect(redirectUri('books', env())).toBe(
        'https://crm.example.com/api/integrations/books/callback',
      )

      expect(validateIntegrations()).toEqual([])
    })
  })

  test("can't replace a built-in provider or use an id that isn't a plain path segment", () => {
    withIntegrations({ google: books, 'Bad Id': books, '../x': books }, () => {
      expect(providers()['google']?.label).toBe('Google')
      expect(Object.keys(providers())).toEqual(['google', 'microsoft'])
      expect(validateIntegrations()).toHaveLength(3)
    })
  })
})

describe('starting a connection', () => {
  test('Google: consent URL asks for offline access with PKCE and a signed state', async () => {
    const { url, cookie } = await run(createAuthRequest('google', 'user_1'))
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('client_id')).toBe('google-client')

    expect(u.searchParams.get('redirect_uri')).toBe(
      'https://crm.example.com/api/integrations/google/callback',
    )

    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(url).not.toContain('google-secret')
    expect(cookie.split('.')).toHaveLength(2)
  })

  test('Microsoft: uses the tenant when one is set, and never puts the verifier in the URL', async () => {
    expect(new URL((await run(createAuthRequest('microsoft', 'user_1'))).url).pathname).toBe(
      '/common/oauth2/v2.0/authorize',
    )

    process.env['MICROSOFT_TENANT_ID'] = 'contoso-tenant'

    try {
      const { url, cookie } = await run(createAuthRequest('microsoft', 'user_1'))
      expect(new URL(url).pathname).toBe('/contoso-tenant/oauth2/v2.0/authorize')
      expect(url).not.toContain(cookie.split('.')[1]!)
    } finally {
      delete process.env['MICROSOFT_TENANT_ID']
    }
  })

  test("refuses when the provider or the deployment isn't set up", async () => {
    const id = process.env['GOOGLE_CLIENT_ID']
    delete process.env['GOOGLE_CLIENT_ID']

    try {
      await expect(run(createAuthRequest('google', 'user_1'))).rejects.toThrow(
        "Google isn't set up on this CRM yet",
      )
    } finally {
      process.env['GOOGLE_CLIENT_ID'] = id
    }

    await expect(bare(createAuthRequest('google', 'user_1'))).rejects.toThrow(
      'CipherStash encryption is not set up',
    )
  })
})

describe("the callback's state", () => {
  const start = async (userId = 'user_1', now = Date.now()) => {
    const { url, cookie } = await run(createAuthRequest('google', userId, now))
    return { state: new URL(url).searchParams.get('state'), cookie }
  }

  const verify = (...args: Parameters<typeof verifyState>) => run(verifyState(...args))

  const refused = (...args: Parameters<typeof verifyState>) =>
    expect(verify(...args)).rejects.toBeInstanceOf(IntegrationError)

  test('is accepted for the same user and browser, and yields the PKCE verifier', async () => {
    const { state, cookie } = await start()
    expect(await verify('google', state, cookie, 'user_1')).toBe(cookie.split('.')[1]!)
  })

  test('is refused for another user, provider or browser', async () => {
    const { state, cookie } = await start()
    await refused('google', state, cookie, 'user_2')
    await refused('microsoft', state, cookie, 'user_1')
    await refused('google', state, (await start()).cookie, 'user_1')
    await refused('google', state, undefined, 'user_1')
  })

  test('is refused once tampered with or expired', async () => {
    const { state, cookie } = await start()
    const [payload, signature] = state!.split('.')

    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), u: 'user_2' }),
    ).toString('base64url')

    await refused('google', `${forged}.${signature}`, cookie, 'user_2')
    await refused('google', null, cookie, 'user_1')
    await refused('google', 'garbage', cookie, 'user_1')

    const old = await start('user_1', Date.now() - 11 * 60 * 1000)
    await expect(verify('google', old.state, old.cookie, 'user_1')).rejects.toThrow('expired')
  })
})
