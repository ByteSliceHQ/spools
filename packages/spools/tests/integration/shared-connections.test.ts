import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'

import extensions from '../../../../apps/starter/src/app/extensions'
import * as api from '../../src/server/extension-api'
import {
  completeAuth,
  connectionsOverview,
  createAuthRequest,
  disconnect,
  findConnections,
  getAccessToken,
  IntegrationError,
  type IntegrationProvider,
  listConnections,
  ownerOf,
} from '../../src/server/integrations'
import { Auth } from '../../src/server/runtime/auth'
import { Vault } from '../../src/server/runtime/vault'
import { Integration } from '../../src/server/store/tables'
import type { CrmUser } from '../../src/server/users'
import { bodyText, db, installLiveServices, installStandIns, run } from '../../src/testing/run'

/**
 * Connections that belong to the team, not one person.
 *
 * The design these tests pin:
 *
 * - A provider says whose its connections are. Left alone, a connection is its
 *   teammate's, as it always was. `shared: 'team'` makes it everyone's;
 *   `shared: 'group'` makes it one group's (a branch, a region), chosen when it
 *   is connected from the groups the provider lists.
 * - The row says the same (`shared`, `groupKey`), and its tokens are sealed for
 *   that: a row turned into a shared one in the database, or moved to another
 *   group, no longer opens. `userId` is who connected it, which for a shared
 *   connection is a fact about its past and nothing more: the connection is
 *   used, shown and managed without asking whether that person is still here.
 * - Anyone on the access list may use a shared connection. Who may connect,
 *   replace and disconnect one is the provider's `canManage` (a list of
 *   addresses or a function), and everyone on the access list without it.
 * - The OAuth `state` carries whose the connection will be. The callback takes
 *   it from there and nowhere else, and checks it against what the provider
 *   says now.
 * - Server code with no person behind it (a schedule, the mailbox sync) is
 *   trusted as before, and says so by naming nobody at all. Code acting for a
 *   person says so (`usableBy`, `as`) and is refused what that person may not
 *   use; when the person it names turns out to be nobody, it is refused.
 * - Which account was connected is the provider's answer to the new token. The
 *   callback's query went through the browser, so a shared connection whose
 *   account the provider was not asked about is refused.
 * - A shared connection is one row for its account and owner (`ownerKey`),
 *   whoever connects it and however many do at once.
 *
 * Against a real database, with the provider's HTTP API and the cipher stubbed.
 */

const tag = `shr${Date.now()}`
const ada: CrmUser = { id: `ada_${tag}`, email: 'ada@example.com', name: 'Ada' }
const bob: CrmUser = { id: `bob_${tag}`, email: 'bob@example.com', name: 'Bob' }
// Signs in, but is not on the access list (crm.config.json lets example.com in).
const mallory: CrmUser = { id: `mal_${tag}`, email: 'mallory@elsewhere.test', name: 'Mallory' }

const SECRET = 's'.repeat(40)
const saved = extensions.integrations
const calls: { url: string; body: string }[] = []
let exchanges = 0
let refresh: 'ok' | 'refused' = 'ok'
/** Which company each access token was issued for: what the ledger knows and the browser can't change. */
const grants = new Map<string, string>()
/** Set by a test to keep a refresh waiting at the provider: called when it arrives, awaited before it is answered. */
let heldRefresh: (() => Promise<void>) | null = null
const COMPANIES = 'https://ledger.example.com/api/companies/'

const base = (label: string): IntegrationProvider => ({
  label,
  description: 'Create invoices',
  clientId: 'LEDGER_CLIENT_ID',
  clientSecret: 'LEDGER_CLIENT_SECRET',
  authUrl: 'https://ledger.example.com/oauth/authorize',
  tokenUrl: 'https://ledger.example.com/oauth/token',
  scopes: ['invoices.write'],
  // The callback names the company, and the ledger is asked whether the new token is for it.
  account: async ({ query, get }) => {
    const named = query.get('companyId')
    return named
      ? (await get<{ id: string }>(`${COMPANIES}${encodeURIComponent(named)}`)).id
      : undefined
  },
})

/** Who may manage the ledger. Changed by a test to play someone losing the right mid-flow. */
let managers = [ada.email]

/** The provider objects, so a test can change what one says between the two halves of a flow. */
const offered: Record<string, IntegrationProvider> = {
  // The whole company's books: only Ada may connect or remove them.
  [`ledger_${tag}`]: {
    ...base('Acme Books'),
    shared: 'team',
    canManage: (user) => managers.includes(user.email),
  },
  // Open: anyone on the access list manages it.
  [`open_${tag}`]: { ...base('Acme Open'), shared: 'team' },
  // One connection per branch. Ada manages every branch, Bob only the south.
  [`branch_${tag}`]: {
    ...base('Acme Branch Books'),
    shared: 'group',
    groups: () => [
      { key: 'north', label: 'North branch' },
      { key: 'south', label: 'South branch' },
    ],
    canManage: (user, { group }) => user.email === ada.email || group === 'south',
  },
  // A list of addresses, in any case.
  [`listed_${tag}`]: { ...base('Acme Listed'), shared: 'team', canManage: ['ADA@example.com'] },
  // Each person's own, as providers always were.
  [`own_${tag}`]: base('Acme Phone'),
  // Shared from now on; what was connected before stays its teammate's.
  [`turned_${tag}`]: { ...base('Acme Turned'), shared: 'team' },
  // Always used by everyone, like a marketing account: what was connected before is the team's.
  [`always_${tag}`]: { ...base('Acme Always'), shared: 'team', adoptExisting: true },
  // Shared, and takes the account's name from the callback's address without asking the ledger.
  [`unasked_${tag}`]: {
    ...base('Acme Unasked'),
    shared: 'team',
    account: async ({ query }) => query.get('companyId') ?? undefined,
  },
  // Each person's own, at a provider that revokes tokens.
  [`revoking_${tag}`]: {
    ...base('Acme Revoking'),
    revokeUrl: 'https://ledger.example.com/oauth/revoke',
  },
}

const ledger = `ledger_${tag}`
const open = `open_${tag}`
const branch = `branch_${tag}`
const listed = `listed_${tag}`
const own = `own_${tag}`
const turned = `turned_${tag}`
const always = `always_${tag}`
const unasked = `unasked_${tag}`
const revoking = `revoking_${tag}`

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const vault = Vault.layerTest({
  encrypt: async (plaintext) => JSON.stringify({ c: Buffer.from(plaintext).toString('base64') }),
  decrypt: async (ciphertext) => Buffer.from(JSON.parse(ciphertext).c, 'base64').toString(),
})

const person = (u: CrmUser) => ({ id: u.id, name: u.name, email: u.email, accounts: [] })

const standIns = (directory: CrmUser[]) =>
  installStandIns({
    vault,
    auth: Auth.layerTest(directory.map(person)),
    fetch: async (url, init) => {
      const body = bodyText(init)
      calls.push({ url, body })

      if (url.startsWith(COMPANIES)) {
        // The ledger answers for the company the token was issued for, and no other.
        const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? ''
        const asked = decodeURIComponent(url.slice(COMPANIES.length))
        return grants.get(token) === asked ? json({ id: asked }) : json({ error: 'forbidden' }, 403)
      }

      if (!url.endsWith('/token')) {
        return json({})
      }

      const form = new URLSearchParams(body)

      if (form.get('grant_type') === 'refresh_token') {
        await heldRefresh?.()

        return refresh === 'refused'
          ? json({ error: 'invalid_grant' }, 400)
          : json({ access_token: 'access-refreshed', expires_in: 3600 })
      }

      exchanges += 1
      // The code stands for what was authorized at the ledger: `auth-code:<company>`.
      grants.set(`access-${exchanges}`, form.get('code')?.split(':')[1] ?? '')

      return json({
        access_token: `access-${exchanges}`,
        refresh_token: `refresh-${exchanges}`,
        expires_in: 3600,
      })
    },
  })

beforeAll(async () => {
  process.env['APP_URL'] = 'https://crm.example.com'
  process.env['APP_SECRET'] = SECRET
  process.env['LEDGER_CLIENT_ID'] = 'ledger-client'
  process.env['LEDGER_CLIENT_SECRET'] = 'ledger-secret'
  extensions.integrations = { ...saved, ...offered }
  await standIns([ada, bob, mallory])
})

afterAll(async () => {
  for (const provider of Object.keys(offered)) {
    await db.remove(Integration, { where: { provider } })
  }

  await installLiveServices()

  if (saved === undefined) {
    delete extensions.integrations
  } else {
    extensions.integrations = saved
  }

  delete process.env['LEDGER_CLIENT_ID']
  delete process.env['LEDGER_CLIENT_SECRET']
})

type Flow = { group?: string; company?: string }

const start = async (who: CrmUser | string, provider: string, flow: Flow = {}) => {
  const { url, cookie } = await run(
    createAuthRequest(
      provider,
      who,
      undefined,
      flow.group === undefined ? {} : { group: flow.group },
    ),
  )

  return { state: new URL(url).searchParams.get('state'), cookie }
}

const finish = (
  who: CrmUser | string,
  provider: string,
  flow: Flow,
  started: { state: string | null; cookie: string },
  query: Record<string, string> = {},
) =>
  run(
    completeAuth(
      provider,
      {
        // What was authorized at the ledger. The query is what the browser brought back, which
        // says the same unless a test changes it.
        code: `auth-code:${flow.company ?? 'Company-1'}`,
        ...started,
        query: new URLSearchParams({ companyId: flow.company ?? 'Company-1', ...query }),
      },
      who,
    ),
  )

const connect = async (who: CrmUser | string, provider: string, flow: Flow = {}) =>
  finish(who, provider, flow, await start(who, provider, flow))

const rows = (provider: string) => db.find(Integration, { where: { provider } })

const refused = (promise: Promise<unknown>) =>
  expect(promise).rejects.toBeInstanceOf(IntegrationError)

/** A state signed with the app's own secret, as someone who had it (or an older version) would make one. */
const signed = (payload: Record<string, unknown>) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${createHmac('sha256', SECRET).update(`oauth:${encoded}`).digest('base64url')}`
}

const payloadOf = (state: string | null) =>
  JSON.parse(Buffer.from((state ?? '').split('.')[0] ?? '', 'base64url').toString())

describe('a connection for the team', () => {
  test("is stored as the team's, with who connected it, and its tokens sealed", async () => {
    const connection = await connect(ada, ledger)

    expect(connection).toMatchObject({
      provider: ledger,
      account: 'company-1',
      status: 'connected',
      shared: 'team',
      group: null,
      userId: ada.id,
      connectedBy: 'Ada',
    })

    const [row] = await rows(ledger)
    expect(row).toMatchObject({ shared: 'team', groupKey: '', userId: ada.id })
    expect(row?.credentials).not.toContain('access-')
    expect(row?.credentials).not.toContain('refresh-')
  })

  test('is found and used by another teammate, and by server code with nobody behind it', async () => {
    const [found] = await run(
      findConnections({ provider: ledger, shared: 'team', usableBy: bob.id }),
    )

    expect(found).toMatchObject({ account: 'company-1', connectedBy: 'Ada' })
    expect(await run(getAccessToken(found!.id, undefined, bob.id))).toMatch(/^access-/)
    // A schedule or an automation: nobody to check, as before.
    expect(await run(getAccessToken(found!.id))).toMatch(/^access-/)
    expect(await run(findConnections({ provider: ledger, shared: 'team' }))).toHaveLength(1)
  })

  test('is refused to someone who is not on the access list, or whom the directory does not know', async () => {
    const [connection] = await run(findConnections({ provider: ledger }))

    for (const stranger of [mallory.id, `nobody_${tag}`]) {
      expect(
        await run(findConnections({ provider: ledger, shared: 'team', usableBy: stranger })),
      ).toEqual([])

      await refused(run(getAccessToken(connection!.id, undefined, stranger)))
    }
  })

  test("an app's handler asks as whoever pressed the button, through the promise API", async () => {
    const [found] = await api.findConnections({ provider: ledger, shared: 'team', usableBy: bob })
    expect(found?.connectedBy).toBe('Ada')
    expect(await api.getAccessToken(found!.id, { as: bob })).toMatch(/^access-/)
    await refused(api.getAccessToken(found!.id, { as: mallory }))
    expect(await api.findConnections({ provider: ledger, usableBy: mallory.id })).toEqual([])
  })

  test('a handler run with nobody signed in is refused, not trusted; trusted code names nobody at all', async () => {
    const [found] = await api.findConnections({ provider: ledger, shared: 'team' })
    // `ctx.actor` is null when an automation or a script ran the handler.
    const actor: CrmUser | null = null
    await refused(api.getAccessToken(found!.id, { as: actor }))
    expect(await api.findConnections({ provider: ledger, usableBy: actor })).toEqual([])
    await refused(run(getAccessToken(found!.id, undefined, null)))
    expect(await run(findConnections({ provider: ledger, usableBy: null }))).toEqual([])
    // A schedule or a webhook says it acts for no one by leaving the person out.
    expect(await api.getAccessToken(found!.id)).toMatch(/^access-/)
    expect(await api.findConnections({ provider: ledger })).toHaveLength(1)
  })

  test("is not one of its connector's own connections", async () => {
    expect(await run(listConnections(ada.id))).toEqual([])
    expect(await run(findConnections({ provider: ledger, userId: ada.id }))).toEqual([])
  })
})

describe('a connection for one person', () => {
  test('is theirs alone, exactly as before', async () => {
    const mine = await connect(ada, own)
    expect(mine).toMatchObject({ shared: null, group: null, userId: ada.id })

    const [row] = await rows(own)
    expect(row).toMatchObject({ shared: '', groupKey: '' })

    expect((await run(listConnections(ada.id))).map((c) => c.id)).toEqual([mine.id])
    expect(await run(listConnections(bob.id))).toEqual([])
    expect(await run(findConnections({ provider: own, shared: 'team' }))).toEqual([])
    expect(await run(findConnections({ provider: own, usableBy: bob.id }))).toEqual([])
    expect(await run(findConnections({ provider: own, usableBy: ada.id }))).toHaveLength(1)

    // Code acting for Bob is refused Ada's account; code with nobody behind it is trusted as it was.
    await refused(run(getAccessToken(mine.id, undefined, bob.id)))
    expect(await run(getAccessToken(mine.id, undefined, ada.id))).toMatch(/^access-/)
    expect(await run(getAccessToken(mine.id))).toMatch(/^access-/)
    expect(await run(disconnect(bob, mine.id))).toBe(false)
  })

  test("can't be started for a group, and its state names no owner", async () => {
    await refused(start(ada, own, { group: 'north' }))
    const { state } = await start(ada, own)
    expect(Object.keys(payloadOf(state)).sort()).toEqual(['e', 'n', 'p', 'u'])
  })
})

describe('a connection for a group', () => {
  test('is chosen when connecting, from the groups the provider lists', async () => {
    await refused(start(ada, branch))
    await refused(start(ada, branch, { group: 'west' }))
    await refused(start(ada, ledger, { group: 'north' }))

    const north = await connect(ada, branch, { group: 'north', company: 'North-Co' })
    expect(north).toMatchObject({ shared: 'group', group: 'north', account: 'north-co' })
    expect((await rows(branch))[0]).toMatchObject({ shared: 'group', groupKey: 'north' })
  })

  test('is only returned for its group', async () => {
    const south = await connect(bob, branch, { group: 'south', company: 'South-Co' })

    const of = async (filter: Parameters<typeof findConnections>[0]) =>
      (await run(findConnections({ provider: branch, ...filter }))).map((c) => c.account)

    expect(await of({ group: 'north' })).toEqual(['north-co'])
    expect(await of({ group: 'south' })).toEqual(['south-co'])
    expect(await of({ group: 'west' })).toEqual([])
    expect(await of({ shared: 'group' })).toEqual(['north-co', 'south-co'])
    expect(await of({ shared: 'team' })).toEqual([])
    expect(await of({ userId: bob.id })).toEqual([])
    expect(await of({ group: 'south', usableBy: mallory.id })).toEqual([])
    expect(await run(getAccessToken(south.id, undefined, ada.id))).toMatch(/^access-/)
  })

  test('one account can serve two groups, as two connections', async () => {
    const again = await connect(ada, branch, { group: 'south', company: 'North-Co' })
    const all = await run(findConnections({ provider: branch, shared: 'group' }))

    expect(all.filter((c) => c.account === 'north-co').map((c) => c.group)).toEqual([
      'north',
      'south',
    ])

    expect(await run(disconnect(ada, again.id))).toBe(true)
  })
})

describe('who may connect, replace and disconnect', () => {
  test('connecting is refused to someone who does not manage it, at both ends of the flow', async () => {
    await refused(start(bob, ledger))
    await refused(start(bob, branch, { group: 'north' }))
    await refused(start(bob, listed))
    // Nobody to ask about: a bare id can't pass a rule about people.
    await refused(start(ada.id, ledger))

    // Ada starts, then loses the right before the provider sends her back.
    const started = await start(ada, ledger, { company: 'Company-2' })
    managers = []

    try {
      await refused(finish(ada, ledger, { company: 'Company-2' }, started))
    } finally {
      managers = [ada.email]
    }

    expect((await rows(ledger)).map((r) => r.account)).toEqual(['company-1'])
    expect((await connect(ada, listed)).connectedBy).toBe('Ada')
  })

  test('a rule that throws lets nobody in', async () => {
    const provider = offered[ledger]!
    const rule = provider.canManage

    provider.canManage = () => {
      throw new Error('directory is down')
    }

    try {
      await refused(start(ada, ledger))
    } finally {
      provider.canManage = rule
    }
  })

  test('replacing keeps the connection and says who did it; only a manager may', async () => {
    const kept = (await rows(ledger))[0]?.credentials

    // Bob can't put his own grant in place of the team's.
    await refused(connect(bob, ledger))
    expect((await rows(ledger))[0]?.credentials).toBe(kept)

    // Where everyone manages, Bob connecting the account Ada connected replaces her grant with his.
    const first = await connect(ada, open)
    const firstToken = await run(getAccessToken(first.id))
    const second = await connect(bob, open)
    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({ userId: bob.id, connectedBy: 'Bob', shared: 'team' })
    expect(await rows(open)).toHaveLength(1)
    expect(await run(getAccessToken(second.id, undefined, ada.id))).not.toBe(firstToken)
  })

  test('disconnecting is for those who manage it, whoever connected it', async () => {
    const [team] = await run(findConnections({ provider: ledger }))
    await refused(run(disconnect(bob, team!.id)))
    await refused(run(disconnect(bob.id, team!.id)))
    expect(await rows(ledger)).toHaveLength(1)

    const [north] = await run(findConnections({ provider: branch, group: 'north' }))
    const [south] = await run(findConnections({ provider: branch, group: 'south' }))
    await refused(run(disconnect(bob, north!.id)))
    // Ada did not connect the south branch's books, and may still remove them.
    expect(await run(disconnect(ada, south!.id))).toBe(true)
    expect(await run(findConnections({ provider: branch, group: 'south' }))).toEqual([])
  })
})

describe("the callback's state", () => {
  test('carries whose the connection will be, and the callback takes it from nowhere else', async () => {
    const started = await start(ada, branch, { group: 'north', company: 'North-Co' })
    expect(payloadOf(started.state)).toMatchObject({ o: 'group', g: 'north', u: ada.id })

    // The address the provider sends the browser back to can say what it likes.
    const connection = await finish(ada, branch, { company: 'North-Co' }, started, {
      group: 'south',
    })

    expect(connection).toMatchObject({ shared: 'group', group: 'north' })
    expect(await run(findConnections({ provider: branch, group: 'south' }))).toEqual([])
  })

  test('is refused once the group or the owner in it is changed', async () => {
    const { state, cookie } = await start(bob, branch, { group: 'south', company: 'South-Co' })
    const [, signature] = state!.split('.')

    for (const change of [{ g: 'north' }, { o: 'team' }, { o: undefined, g: undefined }]) {
      const forged = Buffer.from(JSON.stringify({ ...payloadOf(state), ...change })).toString(
        'base64url',
      )

      await refused(
        finish(bob, branch, { company: 'South-Co' }, { state: `${forged}.${signature}`, cookie }),
      )
    }

    expect(await run(findConnections({ provider: branch, group: 'south' }))).toEqual([])
  })

  test("can't be replayed for another owner: a personal state makes no shared connection, nor the reverse", async () => {
    const { state, cookie } = await start(ada, own)
    const nonce = cookie.split('.')[0]
    const e = Date.now() + 60_000
    const before = await rows(ledger)

    // A state from before states said whose (or one for a personal connection), sent to a shared provider.
    await refused(
      finish(ada, ledger, {}, { state: signed({ u: ada.id, p: ledger, n: nonce, e }), cookie }),
    )

    // A shared state, sent to a provider whose connections are each person's own.
    await refused(
      finish(
        ada,
        own,
        {},
        { state: signed({ u: ada.id, p: own, n: nonce, e, o: 'team' }), cookie },
      ),
    )

    // A team state, sent where connections are per group, and a group one where they are the team's.
    await refused(
      finish(
        ada,
        branch,
        {},
        { state: signed({ u: ada.id, p: branch, n: nonce, e, o: 'team' }), cookie },
      ),
    )

    await refused(
      finish(
        ada,
        ledger,
        {},
        { state: signed({ u: ada.id, p: ledger, n: nonce, e, o: 'group', g: 'north' }), cookie },
      ),
    )

    // A group the provider does not list.
    await refused(
      finish(
        ada,
        branch,
        {},
        { state: signed({ u: ada.id, p: branch, n: nonce, e, o: 'group', g: 'west' }), cookie },
      ),
    )

    expect(await rows(ledger)).toEqual(before)
    expect(await run(findConnections({ provider: own, shared: 'team' }))).toEqual([])
    // The untouched state still completes what it was made for.
    expect(await finish(ada, own, {}, { state, cookie })).toMatchObject({ shared: null })
  })

  test('is refused when the provider changed whose its connections are while the flow was open', async () => {
    const provider = offered[open]!
    const started = await start(ada, open, { company: 'Company-9' })
    delete provider.shared

    try {
      await refused(finish(ada, open, { company: 'Company-9' }, started))
    } finally {
      provider.shared = 'team'
    }

    expect((await rows(open)).map((r) => r.account)).toEqual(['company-1'])
  })
})

describe('sealed tokens', () => {
  test('a personal row turned into a shared one in the database no longer opens', async () => {
    const [mine] = await run(findConnections({ provider: own, userId: ada.id }))
    await db.update(Integration, { where: { id: mine!.id } }, { shared: 'team' })
    await expect(run(getAccessToken(mine!.id))).rejects.toThrow('belongs to something else')
    await db.update(Integration, { where: { id: mine!.id } }, { shared: '' })
    expect(await run(getAccessToken(mine!.id))).toMatch(/^access-/)
  })

  test("a group's row moved to another group no longer opens", async () => {
    const [north] = await run(findConnections({ provider: branch, group: 'north' }))
    await db.update(Integration, { where: { id: north!.id } }, { groupKey: 'south' })
    await expect(run(getAccessToken(north!.id))).rejects.toThrow('belongs to something else')
    await db.update(Integration, { where: { id: north!.id } }, { groupKey: 'north' })
    expect(await run(getAccessToken(north!.id))).toMatch(/^access-/)
  })

  test("the team's tokens copied onto a row of someone's own are refused", async () => {
    const [team] = await rows(ledger)

    const copy = await db.insert(Integration, {
      userId: mallory.id,
      provider: own,
      account: 'mallory-co',
      credentials: team?.credentials ?? '',
      scopes: '',
      status: 'connected',
    })

    await expect(run(getAccessToken(copy.id))).rejects.toThrow('belongs to something else')
    await db.remove(Integration, { where: { id: copy.id } })
  })

  test('tokens that name no row at all are refused on a shared row', async () => {
    const [team] = await rows(ledger)

    // What a version before tokens were tied to rows stored. A personal row may still hold such
    // tokens and is tied to them on first use; a shared row never legitimately does.
    const loose = JSON.stringify({
      c: Buffer.from(
        JSON.stringify({
          accessToken: 'loose-access',
          refreshToken: null,
          expiresAt: Date.now() + 3_600_000,
        }),
      ).toString('base64'),
    })

    await db.update(Integration, { where: { id: team!.id } }, { credentials: loose })
    await expect(run(getAccessToken(team!.id))).rejects.toThrow('belongs to something else')
    expect((await rows(ledger))[0]?.credentials).toBe(loose)

    await db.update(
      Integration,
      { where: { id: team!.id } },
      { credentials: team?.credentials ?? '' },
    )

    expect(await run(getAccessToken(team!.id))).toMatch(/^access-/)
  })

  test('the owner a shared connection is sealed for can never be a personal one', () => {
    const row = { userId: 'u', provider: 'p', account: 'a' }
    expect(ownerOf(row)).toBe(JSON.stringify(['integration', 'u', 'p', 'a']))
    expect(ownerOf({ ...row, shared: '', groupKey: '' })).toBe(ownerOf(row))
    expect(ownerOf({ ...row, shared: 'team', groupKey: '' })).not.toBe(ownerOf(row))

    // Who connected a shared connection is not part of what its tokens are sealed for.
    expect(ownerOf({ ...row, userId: 'someone else', shared: 'team', groupKey: '' })).toBe(
      ownerOf({ ...row, shared: 'team', groupKey: '' }),
    )

    expect(ownerOf({ ...row, shared: 'group', groupKey: 'north' })).not.toBe(
      ownerOf({ ...row, shared: 'group', groupKey: 'south' }),
    )
  })
})

describe('what the Integrations page is sent', () => {
  test("the team's connections, for everyone: account, group, who and when, and whether they may manage", async () => {
    const forBob = await run(connectionsOverview(bob))
    const team = forBob.shared.find((c) => c.provider === ledger)

    expect(team).toMatchObject({
      label: 'Acme Books',
      account: 'company-1',
      shared: 'team',
      group: null,
      connectedBy: 'Ada',
      status: 'connected',
      canManage: false,
    })

    expect(Date.parse(team!.connectedAt)).toBeGreaterThan(Date.now() - 60_000)

    expect(forBob.shared.find((c) => c.provider === branch)).toMatchObject({
      group: 'north',
      groupLabel: 'North branch',
      canManage: false,
    })

    const forAda = await run(connectionsOverview(ada))
    expect(forAda.shared.find((c) => c.provider === ledger)?.canManage).toBe(true)

    // Shared connections are not among anyone's own, and one's own are not among the shared.
    expect(forAda.connections.map((c) => c.provider)).toEqual([own])
    expect(forBob.connections).toEqual([])
    expect(forBob.shared.some((c) => c.provider === own)).toBe(false)

    expect(forBob.providers.find((p) => p.id === branch)).toMatchObject({
      shared: 'group',
      groups: [
        { key: 'north', label: 'North branch', canManage: false },
        { key: 'south', label: 'South branch', canManage: true },
      ],
    })

    expect(forBob.providers.find((p) => p.id === ledger)).toMatchObject({
      shared: 'team',
      canManage: false,
    })

    expect(forBob.providers.find((p) => p.id === own)).toMatchObject({ shared: null })
  })

  test('holds no token, sealed or not', async () => {
    const sent = JSON.stringify(await run(connectionsOverview(ada)))
    expect(sent).not.toMatch(/access-|refresh-/)

    for (const row of await db.find(Integration, {})) {
      expect(sent).not.toContain(row.credentials)
    }

    expect(Object.keys((await run(connectionsOverview(ada))).shared[0]!).sort()).toEqual([
      'account',
      'canManage',
      'connectedAt',
      'connectedBy',
      'group',
      'groupLabel',
      'id',
      'label',
      'lastError',
      'provider',
      'shared',
      'status',
    ])
  })

  test('says when a shared connection needs reconnecting, and a manager reconnecting clears it', async () => {
    const [team] = await run(findConnections({ provider: ledger }))
    refresh = 'refused'

    try {
      await refused(run(getAccessToken(team!.id, Date.now() + 2 * 3_600_000, bob.id)))
    } finally {
      refresh = 'ok'
    }

    const shown = (await run(connectionsOverview(bob))).shared.find((c) => c.id === team!.id)
    expect(shown).toMatchObject({ status: 'error' })
    expect(shown?.lastError).toContain('Reconnect company-1')

    expect(await connect(ada, ledger)).toMatchObject({
      id: team!.id,
      status: 'connected',
      lastError: null,
    })
  })
})

describe('connections made before a provider was shared', () => {
  /** A row as it was stored before rows said whose they are: its connector's id, and tokens sealed for that. */
  const before = async (provider: string, who: CrmUser, account: string) => {
    const row = { userId: who.id, provider, account }

    const credentials = await run(
      Vault.use((v) =>
        v.seal(
          { accessToken: `old-${account}`, refreshToken: null, expiresAt: Date.now() + 3_600_000 },
          ownerOf(row),
        ),
      ),
    )

    return db.insert(Integration, { ...row, credentials, scopes: '', status: 'connected' })
  }

  test("stay their connector's when the provider only says it is shared from now on", async () => {
    const old = await before(turned, ada, 'old-co')
    expect((await run(listConnections(ada.id))).map((c) => c.id)).toContain(old.id)
    expect(await run(findConnections({ provider: turned, shared: 'team' }))).toEqual([])
    expect((await run(connectionsOverview(bob))).shared.some((c) => c.id === old.id)).toBe(false)
    await refused(run(getAccessToken(old.id, undefined, bob.id)))
    expect(await run(disconnect(bob, old.id))).toBe(false)

    // Connecting it again is what hands it to the team: Ada's connection becomes the team's, with its id.
    const team = await connect(ada, turned, { company: 'old-co' })
    expect(team).toMatchObject({ id: old.id, shared: 'team', connectedBy: 'Ada' })
    expect(await rows(turned)).toHaveLength(1)

    expect(await run(listConnections(ada.id))).not.toContainEqual(
      expect.objectContaining({ id: old.id }),
    )

    expect(await run(getAccessToken(old.id, undefined, bob.id))).toMatch(/^access-/)
  })

  test("someone else connecting the same account for the team leaves a teammate's own alone", async () => {
    const old = await before(turned, bob, 'bobs-co')
    const team = await connect(ada, turned, { company: 'bobs-co' })
    expect(team.id).not.toBe(old.id)
    expect((await run(listConnections(bob.id))).map((c) => c.id)).toContain(old.id)
    await refused(run(getAccessToken(old.id, undefined, ada.id)))
    expect(await run(disconnect(bob, old.id))).toBe(true)
  })

  test("are the team's when the provider says its connections always were", async () => {
    const old = await before(always, ada, 'legacy-co')

    const [found] = await run(
      findConnections({ provider: always, shared: 'team', usableBy: bob.id }),
    )

    // Its connector's name was never stored. Server code is not told it: only the page looks it up.
    expect(found).toMatchObject({ id: old.id, shared: 'team', connectedBy: null, userId: ada.id })
    expect(await run(getAccessToken(old.id, undefined, bob.id))).toBe('old-legacy-co')

    expect(await run(listConnections(ada.id))).not.toContainEqual(
      expect.objectContaining({ id: old.id }),
    )

    expect((await run(connectionsOverview(bob))).shared.find((c) => c.id === old.id)).toMatchObject(
      {
        connectedBy: 'Ada',
        canManage: true,
      },
    )

    // The row itself is as it was until someone connects the account again, which makes it the team's in the database too.
    expect((await rows(always))[0]).toMatchObject({ shared: '', userId: ada.id })
    const again = await connect(bob, always, { company: 'legacy-co' })
    expect(again).toMatchObject({ id: old.id, connectedBy: 'Bob' })
    expect(await rows(always)).toHaveLength(1)
    expect((await rows(always))[0]).toMatchObject({ shared: 'team', userId: bob.id })
    expect(await run(getAccessToken(old.id, undefined, ada.id))).toMatch(/^access-/)
  })
})

describe('which account a shared connection is', () => {
  test("comes from the provider: a teammate's own company can't be sent back under the team's name", async () => {
    const [team] = await rows(ledger)
    const before = await run(getAccessToken(team!.id))

    // Ada authorizes a company of her own at the ledger, then changes `companyId` in the
    // address the browser is sent back to, so that it names the team's.
    const started = await start(ada, ledger, { company: 'Adas-Own-Co' })

    await refused(
      finish(ada, ledger, { company: 'Adas-Own-Co' }, started, { companyId: 'Company-1' }),
    )

    // The team's connection holds the tokens it held, and no other row was made.
    expect(await rows(ledger)).toEqual([team!])
    expect(await run(getAccessToken(team!.id))).toBe(before)
  })

  test("is refused when the provider was never asked, so a name from the address can't replace the team's connection", async () => {
    // The team's connection to its company, at a provider that reads the name from the address alone.
    const where = { userId: ada.id, provider: unasked, account: 'team-co', shared: 'team' }

    const team = await db.insert(Integration, {
      ...where,
      ownerKey: ownerOf(where),
      credentials: await run(
        Vault.use((v) =>
          v.seal(
            { accessToken: 'the-teams', refreshToken: null, expiresAt: Date.now() + 3_600_000 },
            ownerOf(where),
          ),
        ),
      ),
      scopes: '',
      status: 'connected',
    })

    // Bob authorizes his own company and sends the browser back naming the team's.
    const started = await start(bob, unasked, { company: 'Bobs-Co' })
    await refused(finish(bob, unasked, { company: 'Bobs-Co' }, started, { companyId: 'Team-Co' }))
    expect(await rows(unasked)).toEqual([team])
    expect(await run(getAccessToken(team.id))).toBe('the-teams')

    // Nor does an honest name pass: the ledger was not asked whose token it is.
    await refused(connect(ada, unasked, { company: 'Other-Co' }))
    expect(await rows(unasked)).toHaveLength(1)
  })
})

describe('one connection for an account and its owner', () => {
  test('two people connecting the same account at once make one connection', async () => {
    const [first, second] = await Promise.all([
      connect(ada, open, { company: 'Race-Co' }),
      connect(bob, open, { company: 'Race-Co' }),
    ])

    const stored = (await rows(open)).filter((row) => row.account === 'race-co')
    expect(stored).toHaveLength(1)
    expect(first.id).toBe(second.id)
    expect(stored[0]?.ownerKey).toBe(ownerOf(stored[0]!))
    // Whoever wrote last, the tokens open: they were sealed for the team, not for a person.
    expect(await run(getAccessToken(first.id))).toMatch(/^access-/)
    expect(await run(disconnect(ada, first.id))).toBe(true)
  })

  test('the database keeps it to one, whoever connected it; a person may hold the same account as their own', async () => {
    const [team] = await rows(ledger)

    const again = {
      provider: ledger,
      account: team!.account,
      credentials: 'sealed',
      scopes: '',
      status: 'connected',
    }

    await expect(
      db.insert(Integration, {
        ...again,
        userId: bob.id,
        shared: 'team',
        ownerKey: team!.ownerKey,
      }),
    ).rejects.toThrow()

    // A row of one's own has no key, so any number of people can each hold the account.
    for (const who of [ada, bob]) {
      const mine = await db.insert(Integration, { ...again, userId: who.id })
      expect(mine.ownerKey).toBeNull()
    }

    await db.remove(Integration, { where: { provider: ledger, shared: '' } })
    expect(await rows(ledger)).toEqual([team!])
  })

  test('connections stored twice before there was a key become one when the account is connected again', async () => {
    const sealedOld = (who: CrmUser) =>
      run(
        Vault.use((v) =>
          v.seal(
            { accessToken: 'old', refreshToken: null, expiresAt: Date.now() + 3_600_000 },
            ownerOf({ userId: who.id, provider: always, account: 'twice-co' }),
          ),
        ),
      )

    // Two teammates each connected the account while a connection was its teammate's.
    for (const who of [ada, bob]) {
      await db.insert(Integration, {
        userId: who.id,
        provider: always,
        account: 'twice-co',
        credentials: await sealedOld(who),
        scopes: '',
        status: 'connected',
      })
    }

    const twice = () =>
      run(findConnections({ provider: always, shared: 'team' })).then((all) =>
        all.filter((c) => c.account === 'twice-co'),
      )

    expect(await twice()).toHaveLength(2)
    const one = await connect(bob, always, { company: 'twice-co' })
    expect((await twice()).map((c) => c.id)).toEqual([one.id])
    expect(await run(getAccessToken(one.id, undefined, ada.id))).toMatch(/^access-/)
    expect(await run(disconnect(bob, one.id))).toBe(true)
  })

  test('disconnecting does not revoke a grant another connection to the same account stands on', async () => {
    const adas = await connect(ada, revoking, { company: 'Shared-Inbox' })
    const bobs = await connect(bob, revoking, { company: 'Shared-Inbox' })
    const revoked = () => calls.filter((call) => call.url.endsWith('/revoke')).length
    const before = revoked()

    expect(await run(disconnect(ada, adas.id))).toBe(true)
    expect(revoked()).toBe(before)
    // Bob's connection is untouched and still gets a token.
    expect(await run(getAccessToken(bobs.id, undefined, bob.id))).toMatch(/^access-/)

    // The last connection to the account is revoked as it goes.
    expect(await run(disconnect(bob, bobs.id))).toBe(true)
    expect(revoked()).toBe(before + 1)
    // Gone is gone: a second ask finds nothing to remove.
    expect(await run(disconnect(bob, bobs.id))).toBe(false)
  })
})

describe('a token renewed while its connection is handed to the team', () => {
  test("is not written over the team's: the row still opens", async () => {
    const row = { userId: ada.id, provider: turned, account: 'handover-co' }

    // Ada's own connection, from before the provider was shared, with a token that has run out.
    const old = await db.insert(Integration, {
      ...row,
      credentials: await run(
        Vault.use((v) =>
          v.seal(
            { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: Date.now() - 1000 },
            ownerOf(row),
          ),
        ),
      ),
      scopes: '',
      status: 'connected',
    })

    let release = () => {}
    let arrived = () => {}
    const atProvider = new Promise<void>((resolve) => (arrived = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))

    heldRefresh = () => {
      arrived()
      return held
    }

    try {
      // A schedule asks for a token: the renewal reaches the ledger and waits there.
      const renewing = run(getAccessToken(old.id))
      await atProvider
      heldRefresh = null

      // Meanwhile Ada connects the account for the team, which hands this row over.
      const team = await connect(ada, turned, { company: 'handover-co' })
      expect(team).toMatchObject({ id: old.id, shared: 'team' })
      const handedOver = (await rows(turned)).find((r) => r.id === old.id)

      release()
      // The renewal was the old grant's, sealed under Ada's name: the caller gets the team's token.
      expect(await renewing).toBe(await run(getAccessToken(old.id)))
      expect(await renewing).toMatch(/^access-\d+$/)
      expect((await rows(turned)).find((r) => r.id === old.id)).toEqual(handedOver)
      expect(await run(getAccessToken(old.id, undefined, bob.id))).toMatch(/^access-\d+$/)
    } finally {
      heldRefresh = null
      release()
    }
  })
})

describe('when whoever connected it is no longer on the team', () => {
  test('a shared connection is still listed, used and managed; their own connections are still only theirs', async () => {
    const [team] = await run(findConnections({ provider: listed }))
    const [mine] = await run(findConnections({ provider: own, userId: ada.id }))
    // Ada leaves: the directory no longer knows her.
    await standIns([bob, mallory])

    try {
      const shown = (await run(connectionsOverview(bob))).shared.find((c) => c.id === team!.id)
      expect(shown).toMatchObject({ connectedBy: 'Ada', status: 'connected' })
      expect(await run(getAccessToken(team!.id, undefined, bob.id))).toMatch(/^access-/)
      expect(await run(getAccessToken(team!.id))).toMatch(/^access-/)

      // Her own account is not handed to anyone, and she can no longer act as herself:
      // not through the team's connection, and not through her own.
      await refused(run(getAccessToken(mine!.id, undefined, bob.id)))
      await refused(run(getAccessToken(team!.id, undefined, ada.id)))
      await refused(run(getAccessToken(mine!.id, undefined, ada.id)))
      await refused(api.getAccessToken(mine!.id, { as: ada }))
      expect(await run(findConnections({ provider: own, usableBy: ada.id }))).toEqual([])
      // Code with nobody behind it is trusted, as before.
      expect(await run(getAccessToken(mine!.id))).toMatch(/^access-/)

      const [openOne] = await run(findConnections({ provider: open }))
      expect(await run(disconnect(bob, openOne!.id))).toBe(true)
    } finally {
      await standIns([ada, bob, mallory])
    }
  })
})
