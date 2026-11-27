import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { Effect } from 'effect'

import extensions from '../../../../apps/starter/src/app/extensions'
import { crmConfigSchema } from '../../src/crm/config-schema'
import {
  createAuthRequest,
  IntegrationError,
  type IntegrationProvider,
  providers,
  readState,
  validateIntegrations,
  verifyState,
} from '../../src/server/integrations'
import { providersFor } from '../../src/server/marketing-providers'
import { type AppServices, appLayer } from '../../src/server/runtime/app'
import { Auth } from '../../src/server/runtime/auth'
import { Vault } from '../../src/server/runtime/vault'
import { spool } from '../../src/server/spool'
import { testRuntime } from '../../src/testing/run'

// What a provider may say about whose its connections are, and what the signed
// `state` of a connection in progress carries. No database: see
// tests/integration/shared-connections.test.ts for connections themselves.

const vars = {
  APP_URL: 'https://crm.example.com',
  APP_SECRET: 's'.repeat(40),
  BOOKS_CLIENT_ID: 'books-client',
  BOOKS_CLIENT_SECRET: 'books-secret',
}

const before: Record<string, string | undefined> = {}

const cipher = {
  encrypt: async (plaintext: string) => Buffer.from(plaintext).toString('base64'),
  decrypt: async (ciphertext: string) => Buffer.from(ciphertext, 'base64').toString(),
}

const runtime = testRuntime(appLayer({ vault: Vault.layerTest(cipher), auth: Auth.layerTest([]) }))
const run = <A, E>(program: Effect.Effect<A, E, AppServices>) => runtime.runPromise(program)
const ada = { id: 'user_ada', email: 'ada@example.com', name: 'Ada' }

const books: IntegrationProvider = {
  label: 'Acme Books',
  description: 'Create invoices',
  clientId: 'BOOKS_CLIENT_ID',
  clientSecret: 'BOOKS_CLIENT_SECRET',
  authUrl: 'https://books.example.com/oauth/authorize',
  tokenUrl: 'https://books.example.com/oauth/token',
  scopes: ['invoices.write'],
  account: async () => 'company-1',
}

const groups = [
  { key: 'north', label: 'North branch' },
  { key: 'south', label: 'South branch' },
]

const withIntegrations = async <A>(
  integrations: Record<string, IntegrationProvider>,
  body: () => A | Promise<A>,
): Promise<A> => {
  const saved = extensions.integrations
  extensions.integrations = integrations

  try {
    return await body()
  } finally {
    if (saved === undefined) {
      delete extensions.integrations
    } else {
      extensions.integrations = saved
    }
  }
}

beforeAll(() => {
  for (const [key, value] of Object.entries(vars)) {
    before[key] = process.env[key]
    process.env[key] = value
  }
})

afterAll(async () => {
  await runtime.dispose()

  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('what a provider says about whose its connections are', () => {
  test('nothing, the team or a group with its groups are all offered', async () => {
    await withIntegrations(
      {
        own: books,
        team: { ...books, shared: 'team', canManage: ['ada@example.com'] },
        branch: { ...books, shared: 'group', groups, canManage: () => true },
        listed: { ...books, shared: 'group', groups: ['north', 'south'] },
      },
      () => {
        expect(validateIntegrations()).toEqual([])

        expect(Object.keys(providers())).toEqual([
          'google',
          'microsoft',
          'own',
          'team',
          'branch',
          'listed',
        ])
      },
    )
  })

  test('a declaration that contradicts itself is left out and named at start-up', async () => {
    await withIntegrations(
      {
        nogroups: { ...books, shared: 'group' },
        stray: { ...books, groups },
        // SAFETY: what an app written in JavaScript, or with a cast, could hand over.
        other: { ...books, shared: 'everyone' as 'team' },
        teamgroups: { ...books, shared: 'team', groups },
        managed: { ...books, canManage: ['ada@example.com'] },
        adopts: { ...books, shared: 'group', groups, adoptExisting: true },
      },
      () => {
        expect(Object.keys(providers())).toEqual(['google', 'microsoft'])

        expect(validateIntegrations()).toEqual([
          'integration "nogroups" is shared by group and needs `groups`',
          'integration "stray" lists `groups` but is not `shared: "group"`',
          'integration "other" has `shared: "everyone"`; use "team" or "group", or leave it out',
          'integration "teamgroups" lists `groups` but is not `shared: "group"`',
          'integration "managed" has `canManage` but is not shared: each person manages their own connection',
          'integration "adopts" has `adoptExisting`, which is only for `shared: "team"`',
        ])
      },
    )
  })

  test("the built-in mailboxes are each person's own", () => {
    expect(providers()['google']?.shared).toBeUndefined()
    expect(providers()['microsoft']?.shared).toBeUndefined()
  })

  test("the accounts marketing posts through are the team's, as they always were", () => {
    const offered = providersFor(
      crmConfigSchema.shape.marketing.unwrap().parse({
        website: 'https://acme.com',
        channels: {
          page: { label: 'Page', network: 'linkedin', account: 'urn:li:person:abc' },
          x: { label: 'X', network: 'x', account: 'acme' },
        },
        ads: { search: { label: 'Search', network: 'google', account: '1234567890' } },
      }),
    )

    for (const id of ['linkedin', 'x', 'google_ads']) {
      expect(offered[id]).toMatchObject({ shared: 'team', adoptExisting: true })
      expect(offered[id]?.canManage).toBeUndefined()
    }
  })

  test('an app says who may manage the marketing accounts, as a provider of its own would', async () => {
    const marketing = crmConfigSchema.shape.marketing.unwrap().parse({
      website: 'https://acme.com',
      channels: { x: { label: 'X', network: 'x', account: 'acme' } },
      ads: { search: { label: 'Search', network: 'google', account: '1234567890' } },
    })

    const rule = ['marketing@example.com']
    const limited = providersFor(marketing, rule)
    expect(limited['x']).toMatchObject({ shared: 'team', adoptExisting: true, canManage: rule })
    expect(limited['google_ads']?.canManage).toBe(rule)

    // Through the app's extensions, where it is set: Ada may not connect X, the marketing lead may.
    const savedConfig = spool().config.marketing
    const savedMarketing = extensions.marketing
    const lead = { id: 'user_lead', email: 'Marketing@example.com', name: 'Lead' }
    spool().config.marketing = marketing
    extensions.marketing = { ...savedMarketing, canManage: rule }

    try {
      process.env['X_CLIENT_ID'] = 'x-client'
      process.env['X_CLIENT_SECRET'] = 'x-secret'
      expect(providers()['x']?.canManage).toBe(rule)
      await expect(run(createAuthRequest('x', ada))).rejects.toBeInstanceOf(IntegrationError)
      expect((await run(createAuthRequest('x', lead))).url).toContain('x.com')

      // Left out, anyone on the access list may, as before.
      extensions.marketing = {}
      expect(providers()['x']?.canManage).toBeUndefined()
      expect((await run(createAuthRequest('x', ada))).url).toContain('x.com')
    } finally {
      delete process.env['X_CLIENT_ID']
      delete process.env['X_CLIENT_SECRET']
      spool().config.marketing = savedConfig

      if (savedMarketing === undefined) {
        delete extensions.marketing
      } else {
        extensions.marketing = savedMarketing
      }
    }
  })
})

describe('the state of a connection in progress', () => {
  const app = {
    own: books,
    team: { ...books, shared: 'team' as const },
    branch: { ...books, shared: 'group' as const, groups },
  }

  const start = async (provider: string, group?: string) => {
    const { url, cookie } = await run(
      createAuthRequest(provider, ada, undefined, group === undefined ? {} : { group }),
    )

    return { url: new URL(url), state: new URL(url).searchParams.get('state'), cookie }
  }

  test("names the team or the group, and nothing for a connection of one's own", async () => {
    await withIntegrations(app, async () => {
      const own = await start('own')

      expect(await run(readState('own', own.state, own.cookie, ada.id))).toEqual({
        verifier: own.cookie.split('.')[1]!,
        shared: null,
        group: null,
      })

      const team = await start('team')

      expect(await run(readState('team', team.state, team.cookie, ada.id))).toMatchObject({
        shared: 'team',
        group: null,
      })

      const north = await start('branch', 'north')

      expect(await run(readState('branch', north.state, north.cookie, ada.id))).toMatchObject({
        shared: 'group',
        group: 'north',
      })

      // The group is in the signed state and nowhere else in the address the browser is sent to.
      expect([...north.url.searchParams.keys()]).not.toContain('group')

      // The older check still answers with the verifier alone.
      expect(await run(verifyState('branch', north.state, north.cookie, ada.id))).toBe(
        north.cookie.split('.')[1]!,
      )
    })
  })

  test('is refused for another person, provider or browser, whoever it is for', async () => {
    await withIntegrations(app, async () => {
      const north = await start('branch', 'north')
      const other = await start('branch', 'south')

      const read = (...args: Parameters<typeof readState>) =>
        expect(run(readState(...args))).rejects.toBeInstanceOf(IntegrationError)

      await read('branch', north.state, north.cookie, 'user_bob')
      await read('team', north.state, north.cookie, ada.id)
      await read('branch', north.state, other.cookie, ada.id)
      await read('branch', other.state, north.cookie, ada.id)
    })
  })

  test('a group key that could not be one is refused before anything is signed', async () => {
    await withIntegrations(app, async () => {
      for (const group of ['', ' ', 'west', 'north\n', 'n'.repeat(200)]) {
        await expect(start('branch', group)).rejects.toBeInstanceOf(IntegrationError)
      }
    })
  })
})
