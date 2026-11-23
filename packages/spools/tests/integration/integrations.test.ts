import { afterAll, beforeAll, expect, test } from 'bun:test'

import extensions from '../../../../apps/starter/src/app/extensions'
import {
  completeAuth,
  createAuthRequest,
  disconnect,
  findConnections,
  getAccessToken,
  IntegrationError,
  listConnections,
} from '../../src/server/integrations'
import { Vault } from '../../src/server/runtime/vault'
import { Integration } from '../../src/server/store/tables'
import { bodyText, db, installLiveServices, installStandIns, run } from '../support/run'

// Connecting, refreshing and disconnecting accounts against a real database,
// with the providers' HTTP APIs and CipherStash both stubbed. Integrations are a
// system table, so these run whatever objects crm.config.json defines.
const tag = `int${Date.now()}`
const userId = `user_${tag}`
const otherUser = `other_${tag}`
const calls: { url: string; body: string; authorization: string | null }[] = []
let refresh: 'ok' | 'refused' | 'down' = 'ok'
let profileEmail = 'Ada@Example.com'
const savedIntegrations = extensions.integrations

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeAll(async () => {
  process.env['APP_URL'] = 'https://crm.example.com'
  process.env['APP_SECRET'] = 's'.repeat(40)
  process.env['GOOGLE_CLIENT_ID'] = 'google-client'
  process.env['GOOGLE_CLIENT_SECRET'] = 'google-secret'
  process.env['BOOKS_CLIENT_ID'] = 'books-client'
  process.env['BOOKS_CLIENT_SECRET'] = 'books-secret'

  // A provider the app adds: client auth by HTTP Basic, and the account named on the callback.
  extensions.integrations = {
    books: {
      label: 'Acme Books',
      description: 'Read invoices',
      clientId: 'BOOKS_CLIENT_ID',
      clientSecret: 'BOOKS_CLIENT_SECRET',
      authUrl: 'https://books.example.com/oauth/authorize',
      tokenUrl: 'https://books.example.com/oauth/token',
      tokenAuth: 'basic',
      scopes: ['invoices.read'],
      account: async ({ query }) => query.get('companyId') ?? undefined,
    },
  }

  const vault = Vault.layerTest({
    encrypt: async (plaintext) => JSON.stringify({ c: Buffer.from(plaintext).toString('base64') }),
    decrypt: async (ciphertext) => Buffer.from(JSON.parse(ciphertext).c, 'base64').toString(),
  })

  await installStandIns({
    vault,
    fetch: async (url, init) => {
      const body = bodyText(init)
      calls.push({ url, body, authorization: new Headers(init?.headers).get('authorization') })

      if (url.endsWith('/token')) {
        const form = new URLSearchParams(body)

        if (form.get('grant_type') === 'refresh_token') {
          if (refresh === 'refused') {
            return json({ error: 'invalid_grant', error_description: 'Token was revoked' }, 400)
          }

          if (refresh === 'down') {
            return json({ error: 'temporarily_unavailable' }, 503)
          }

          return json({ access_token: 'access-2', expires_in: 3600 })
        }

        return json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: 'openid email',
        })
      }

      if (url.includes('userinfo')) {
        return json({ email: profileEmail })
      }

      return json({})
    },
  })
})

afterAll(async () => {
  await installLiveServices()

  if (savedIntegrations === undefined) {
    delete extensions.integrations
  } else {
    extensions.integrations = savedIntegrations
  }

  await db.remove(Integration, { where: { userId } })
  await db.remove(Integration, { where: { userId: otherUser } })
})

async function connect(user: string, provider = 'google', query = new URLSearchParams()) {
  const { url, cookie } = await run(createAuthRequest(provider, user))
  const state = new URL(url).searchParams.get('state')
  return run(completeAuth(provider, { code: 'auth-code', state, cookie, query }, user))
}

const ada = async () =>
  (await run(listConnections(userId))).find((c) => c.account === 'ada@example.com')!

const refreshes = () => calls.filter((c) => c.body.includes('grant_type=refresh_token')).length

test('connecting stores the account with its tokens encrypted', async () => {
  const connection = await connect(userId)

  expect(connection).toMatchObject({
    provider: 'google',
    account: 'ada@example.com',
    status: 'connected',
    userId,
  })

  const exchange = new URLSearchParams(calls.find((c) => c.url.endsWith('/token'))?.body)
  expect(exchange.get('grant_type')).toBe('authorization_code')
  expect(exchange.get('code')).toBe('auth-code')
  expect(exchange.get('client_secret')).toBe('google-secret')
  expect(exchange.get('code_verifier')).toMatch(/^[\w-]{43}$/)

  expect(exchange.get('redirect_uri')).toBe(
    'https://crm.example.com/api/integrations/google/callback',
  )

  const row = await db.first(Integration, { where: { id: connection.id } })
  expect(row?.credentials).not.toContain('access-1')
  expect(row?.credentials).not.toContain('refresh-1')
})

test('each teammate only sees their own connections', async () => {
  expect((await run(listConnections(userId))).map((c) => c.account)).toEqual(['ada@example.com'])
  expect(await run(listConnections(otherUser))).toEqual([])
})

test('a callback meant for someone else is refused and stores nothing', async () => {
  const { url, cookie } = await run(createAuthRequest('google', userId))
  const state = new URL(url).searchParams.get('state')

  await expect(
    run(completeAuth('google', { code: 'auth-code', state, cookie }, otherUser)),
  ).rejects.toBeInstanceOf(IntegrationError)

  expect(await run(listConnections(otherUser))).toEqual([])
})

test('connecting the same account again replaces its tokens; another account is a second connection', async () => {
  const first = await ada()
  expect((await connect(userId)).id).toBe(first.id)
  expect(await run(listConnections(userId))).toHaveLength(1)

  profileEmail = 'sales@example.com'

  try {
    const second = await connect(userId)
    expect(second.id).not.toBe(first.id)

    expect((await run(listConnections(userId))).map((c) => c.account)).toEqual([
      'ada@example.com',
      'sales@example.com',
    ])

    expect(await run(disconnect(userId, second.id))).toBe(true)
  } finally {
    profileEmail = 'Ada@Example.com'
  }
})

test('the access token is reused until it nears expiry, then refreshed and re-encrypted', async () => {
  const { id } = await ada()
  expect(await run(getAccessToken(id))).toBe('access-1')
  expect(refreshes()).toBe(0)

  const later = Date.now() + 2 * 3_600_000
  expect(await run(getAccessToken(id, later))).toBe('access-2')
  expect(refreshes()).toBe(1)
  // Google sends no new refresh token; the stored one is kept for next time.
  expect(await run(getAccessToken(id, later + 2 * 3_600_000))).toBe('access-2')
  expect(refreshes()).toBe(2)
  expect(calls.at(-1)?.body).toContain('refresh_token=refresh-1')
})

test('two callers that both find the token expired share one refresh', async () => {
  const { id } = await ada()
  const before = refreshes()
  const later = Date.now() + 8 * 3_600_000

  expect(
    await Promise.all([run(getAccessToken(id, later)), run(getAccessToken(id, later))]),
  ).toEqual(['access-2', 'access-2'])

  expect(refreshes()).toBe(before + 1)
})

test('a provider that is down leaves the connection as it was', async () => {
  const { id } = await ada()
  refresh = 'down'

  try {
    await expect(run(getAccessToken(id, Date.now() + 20 * 3_600_000))).rejects.toThrow(
      'Google refused the request',
    )
  } finally {
    refresh = 'ok'
  }

  expect(await ada()).toMatchObject({ status: 'connected', lastError: null })
})

test('a refused refresh marks the connection as needing to be reconnected', async () => {
  const { id } = await ada()
  refresh = 'refused'

  try {
    await expect(run(getAccessToken(id, Date.now() + 30 * 3_600_000))).rejects.toThrow(
      'Reconnect ada@example.com',
    )
  } finally {
    refresh = 'ok'
  }

  const connection = await ada()
  expect(connection.status).toBe('error')

  expect(connection.lastError).toBe(
    'Google no longer accepts this connection. Reconnect ada@example.com on the Integrations page.',
  )

  // Connecting again clears it.
  expect(await connect(userId)).toMatchObject({ id, status: 'connected', lastError: null })
})

test('a provider the app adds connects the same way, with its own client auth and account', async () => {
  const connection = await connect(
    userId,
    'books',
    new URLSearchParams({ companyId: 'Company-42' }),
  )

  expect(connection).toMatchObject({
    provider: 'books',
    account: 'company-42',
    status: 'connected',
  })

  const exchange = calls.find((c) => c.url === 'https://books.example.com/oauth/token')

  expect(exchange?.authorization).toBe(
    `Basic ${Buffer.from('books-client:books-secret').toString('base64')}`,
  )

  expect(exchange?.body).not.toContain('books-secret')

  // Server code can find whoever connected it and act with their token.
  const [found] = await run(findConnections({ provider: 'books', userId }))
  expect(found?.id).toBe(connection.id)
  expect(await run(getAccessToken(connection.id))).toBe('access-1')
})

test("one person's sealed tokens, copied onto another's row, are refused", async () => {
  const { id } = await ada()
  const theirs = await db.first(Integration, { where: { id } })

  // Someone who can write to the database, but has no key, moves Ada's tokens to a row of their own.
  const mine = await db.insert(Integration, {
    userId: otherUser,
    provider: 'google',
    account: 'mallory@example.com',
    credentials: theirs?.credentials ?? '',
    scopes: '',
    status: 'connected',
  })

  await expect(run(getAccessToken(mine.id))).rejects.toThrow('belongs to something else')
  // Ada's own row still opens.
  expect(await run(getAccessToken(id, Date.now()))).toMatch(/^access-/)
  await db.remove(Integration, { where: { id: mine.id } })
})

test('tokens sealed before they were tied to a row are tied to it the first time they are used', async () => {
  const { id } = await ada()
  const kept = await db.first(Integration, { where: { id } })

  const before = {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() + 3_600_000,
  }
  // What an earlier version stored: the tokens alone, with nothing saying whose they are.

  const unbound = JSON.stringify({ c: Buffer.from(JSON.stringify(before)).toString('base64') })
  await db.update(Integration, { where: { id } }, { credentials: unbound })

  expect(await run(getAccessToken(id))).toBe('old-access')

  const row = await db.first(Integration, { where: { id } })
  expect(row?.credentials).not.toBe(unbound)

  const stored = JSON.parse(
    Buffer.from(JSON.parse(row?.credentials ?? '{}').c, 'base64').toString(),
  )

  expect(stored.owner).toContain('ada@example.com')
  expect(stored.value).toEqual(before)
  // Ada's own tokens again, for the tests that follow.
  await db.update(Integration, { where: { id } }, { credentials: kept?.credentials ?? '' })
})

test('disconnecting revokes the token at the provider and deletes the stored copy', async () => {
  const { id } = await ada()
  // Nobody else can remove it.
  expect(await run(disconnect(otherUser, id))).toBe(false)
  expect(await run(disconnect(userId, id))).toBe(true)
  const revoke = calls.find((c) => c.url.includes('/revoke'))
  expect(revoke?.body).toBe('token=refresh-1')
  expect((await run(listConnections(userId))).map((c) => c.provider)).toEqual(['books'])
  expect(await run(disconnect(userId, id))).toBe(false)
  await expect(run(getAccessToken(id))).rejects.toThrow('no longer connected')
})
