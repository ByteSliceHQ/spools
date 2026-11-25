import { afterAll, beforeAll, expect } from 'bun:test'

import {
  completeAuth,
  createAuthRequest,
  disconnect,
  listConnections,
  ownerOf,
} from '../../src/server/integrations'
import {
  listMailboxAccounts,
  type MailboxAccount,
  MailboxError,
  mailboxAccountsOf,
  sendFromMailbox,
} from '../../src/server/mailbox'
import * as records from '../../src/server/records'
import { Vault } from '../../src/server/runtime/vault'
import { SignIns } from '../../src/server/sign-ins'
import { Integration, MailboxSync } from '../../src/server/store/tables'
import { mailboxStatus, syncAll } from '../../src/server/sync'
import type { CrmUser } from '../../src/server/users'
import {
  bodyText,
  db,
  run as go,
  installLiveServices,
  installStandIns,
} from '../../src/testing/run'
import { exampleTest, isExampleApp } from './example-app'

// Mailboxes connected on the Integrations page, next to the sign-in ones: the
// same sync and the same sending, with tokens from the vault instead of Clerk.
// Clerk, the vault's cipher, the OAuth endpoints and the mail APIs are stubbed.
const tag = `cmb${Date.now()}`
const ada: CrmUser = { id: `user_ada_${tag}`, name: 'Ada', email: `ada.${tag}@acme.example.com` }
// Dee signs in with an email and password: no Google or Microsoft account in Clerk.
const dee: CrmUser = { id: `user_dee_${tag}`, name: 'Dee', email: `dee.${tag}@acme.example.com` }
// Gus connected a mailbox and was then taken off the allowlist.
const gus: CrmUser = { id: `user_gus_${tag}`, name: 'Gus', email: `gus.${tag}@acme.example.com` }
const client = `sam.${tag}@example.com`
const sales = `sales.${tag}@acme.example.com`

const GOOGLE_FULL = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

let signIn: MailboxAccount[] = []
let profile = ''
let refused = false
const mailCalls: { url: string; token: string; body?: any }[] = []
let contactId = ''

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const now = new Date()

beforeAll(async () => {
  if (!isExampleApp) {
    return
  }

  process.env['APP_URL'] = 'https://crm.example.com'
  process.env['APP_SECRET'] = 's'.repeat(40)

  for (const name of ['GOOGLE', 'MICROSOFT']) {
    process.env[`${name}_CLIENT_ID`] = 'client'
    process.env[`${name}_CLIENT_SECRET`] = 'secret'
  }

  const vault = Vault.layerTest({
    encrypt: async (plaintext) => JSON.stringify({ c: Buffer.from(plaintext).toString('base64') }),
    decrypt: async (ciphertext) => Buffer.from(JSON.parse(ciphertext).c, 'base64').toString(),
  })

  const signIns = SignIns.layerTest({
    all: async () => signIn,
    of: async (u) => signIn.filter((a) => a.userId === u.id),
    people: async () => [ada, dee],
    token: async (userId) => `clerk-${userId}`,
  })

  // The OAuth endpoints: the token carries the account, so each mailbox's calls can be told apart.
  const oauth = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/token')) {
      const form = new URLSearchParams(bodyText(init))

      if (form.get('grant_type') === 'refresh_token') {
        return refused
          ? json({ error: 'invalid_grant' }, 400)
          : json({ access_token: 'fresh', expires_in: 3600 })
      }

      return json({ access_token: `vault-${profile}`, refresh_token: 'refresh', expires_in: 3600 })
    }

    if (url.includes('userinfo')) {
      return json({ email: profile })
    }

    if (url.includes('graph.microsoft.com/v1.0/me?')) {
      return json({ mail: profile })
    }

    return json({})
  }

  const mail = async (url: string, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? ''
    const u = new URL(url)

    if (init?.method === 'POST') {
      mailCalls.push({ url, token, body: JSON.parse(bodyText(init)) })
      return u.hostname === 'graph.microsoft.com'
        ? new Response(null, { status: 202 })
        : json({ id: 'sent' })
    }

    mailCalls.push({ url, token })

    if (u.hostname === 'graph.microsoft.com' && u.pathname.endsWith('/messages')) {
      // Each mailbox holds one message from the client, named after the mailbox.
      const mailbox = token.replace('vault-', '')
      return json({
        value: [
          {
            id: 'g1',
            internetMessageId: `<hello.${mailbox}>`,
            subject: `Hello ${mailbox}`,
            bodyPreview: 'Hi',
            receivedDateTime: new Date(now.getTime() - 3_600_000).toISOString(),
            from: { emailAddress: { address: client } },
            toRecipients: [{ emailAddress: { address: mailbox } }],
          },
        ],
      })
    }

    if (u.hostname === 'gmail.googleapis.com') {
      return json({ messages: [] })
    }

    return json({ value: [], items: [] })
  }

  // One stand-in for every outside call: sign-in and token endpoints first, then the mail APIs.
  const isOAuth = (url: string) =>
    url.endsWith('/token') ||
    url.includes('userinfo') ||
    url.includes('graph.microsoft.com/v1.0/me?')

  await installStandIns({
    vault,
    signIns,
    fetch: (url, init) => (isOAuth(url) ? oauth(url, init) : mail(url, init)),
  })

  contactId = (
    await go(records.createRecord('contacts', { name: `Sam ${tag}`, email: client }, 'seed'))
  ).id
})

afterAll(async () => {
  await installLiveServices()

  if (!isExampleApp) {
    return
  }

  for (const { id: userId } of [ada, dee, gus]) {
    await db.remove(Integration, { where: { userId } })
    await db.remove(MailboxSync, { where: { userId } })
  }

  if (contactId) {
    await go(records.deleteRecord('contacts', contactId))
  }
})

async function connect(user: CrmUser, provider: 'google' | 'microsoft', email: string) {
  profile = email
  const { url, cookie } = await go(createAuthRequest(provider, user.id))
  const state = new URL(url).searchParams.get('state')
  return go(completeAuth(provider, { code: 'code', state, cookie }, user.id))
}

const timeline = async () =>
  (await go(records.listActivities('contacts', contactId))).filter((a) => a.externalId)

const message = { to: client, subject: 'Next steps', text: 'Shall we?', html: '<p>Shall we?</p>' }

exampleTest('someone who signs in without Google or Microsoft can connect a mailbox', async () => {
  expect(await go(mailboxAccountsOf(dee))).toEqual([])
  expect(await go(sendFromMailbox(dee, message))).toBeNull()

  const connection = await connect(dee, 'microsoft', dee.email)
  const [status] = await go(mailboxStatus(dee))

  expect(status).toMatchObject({
    provider: 'microsoft',
    accountEmail: dee.email,
    connectionId: connection.id,
    needsReconnect: false,
    canRead: true,
    canSend: true,
  })
})

exampleTest(
  'a connected mailbox is read by the same run, with the token from the vault',
  async () => {
    mailCalls.length = 0
    const run = await go(syncAll({ now }))
    expect(run).toMatchObject({ accounts: 1, synced: 1, emails: 1 })
    expect(mailCalls.every((c) => c.token === `vault-${dee.email}`)).toBe(true)

    expect(
      (await timeline()).find((a) => a.externalId === `email:<hello.${dee.email}>`),
    ).toMatchObject({
      summary: `received an email: Hello ${dee.email}`,
      actorId: dee.id,
      outcome: 'received',
    })

    expect((await go(mailboxStatus(dee)))[0]?.lastSyncedAt).toBe(now.toISOString())
  },
)

exampleTest('and their emails go out from it', async () => {
  mailCalls.length = 0

  expect(await go(sendFromMailbox(dee, message))).toEqual({
    provider: 'microsoft',
    accountEmail: dee.email,
  })

  expect(mailCalls.at(-1)).toMatchObject({
    url: 'https://graph.microsoft.com/v1.0/me/sendMail',
    token: `vault-${dee.email}`,
  })
})

exampleTest(
  'a second mailbox sits next to the sign-in one, and the teammate picks which sends',
  async () => {
    signIn = [
      {
        userId: ada.id,
        name: 'Ada',
        provider: 'google',
        accountEmail: ada.email,
        scopes: GOOGLE_FULL,
      },
    ]

    await connect(ada, 'microsoft', sales)

    expect(
      (await go(mailboxAccountsOf(ada))).map((a) => [a.accountEmail, !!a.connectionId]),
    ).toEqual([
      [ada.email, false],
      [sales, true],
    ])

    // Left to the CRM, the address it knows her by sends; the token comes from Clerk.
    mailCalls.length = 0

    expect(await go(sendFromMailbox(ada, message))).toEqual({
      provider: 'google',
      accountEmail: ada.email,
    })

    expect(mailCalls.at(-1)?.token).toBe(`clerk-${ada.id}`)

    expect(
      await go(
        sendFromMailbox(ada, message, { provider: 'microsoft', accountEmail: sales.toUpperCase() }),
      ),
    ).toEqual({
      provider: 'microsoft',
      accountEmail: sales,
    })

    expect(mailCalls.at(-1)?.token).toBe(`vault-${sales}`)

    // Somebody else's mailbox is not hers to pick.
    await expect(
      go(sendFromMailbox(ada, message, { provider: 'microsoft', accountEmail: dee.email })),
    ).rejects.toThrow(MailboxError)
  },
)

exampleTest('both of her mailboxes are read, each keeping its own place', async () => {
  const run = await go(syncAll({ now: new Date(now.getTime() + 60_000) }))
  // Ada's Gmail, Ada's shared inbox and Dee's mailbox.
  expect(run).toMatchObject({ accounts: 3, synced: 3, emails: 1 })

  expect((await timeline()).find((a) => a.externalId === `email:<hello.${sales}>`)?.actorId).toBe(
    ada.id,
  )

  const rows = await db.find(MailboxSync, { where: { userId: ada.id } })

  expect(rows.map((r) => `${r.provider}:${r.accountEmail}`).sort()).toEqual(
    [`google:${ada.email}`, `microsoft:${sales}`].sort(),
  )
})

exampleTest(
  'connecting the address you sign in with is kept once: whichever can do more',
  async () => {
    const connection = await connect(ada, 'google', ada.email)

    const mine = async () =>
      (await go(mailboxAccountsOf(ada))).filter((a) => a.provider === 'google')

    // The sign-in can already do everything, so it stays in charge.
    expect(await mine()).toMatchObject([{ accountEmail: ada.email }])
    expect((await mine())[0]?.connectionId).toBeUndefined()

    // Sign-in without the mail scopes (Clerk not set up for them): the connection takes over.
    signIn = [{ ...signIn[0]!, scopes: ['email', 'profile'] }]
    expect((await mine()).map((a) => a.connectionId)).toEqual([connection.id])

    expect(await go(sendFromMailbox(ada, message))).toEqual({
      provider: 'google',
      accountEmail: ada.email,
    })

    expect(mailCalls.at(-1)?.token).toBe(`vault-${ada.email}`)
  },
)

exampleTest('a mailbox whose owner may no longer use the CRM is not read', async () => {
  await connect(gus, 'microsoft', gus.email)
  expect((await go(listMailboxAccounts())).some((a) => a.userId === gus.id)).toBe(false)
  mailCalls.length = 0
  await go(syncAll({ now: new Date(now.getTime() + 120_000) }))
  expect(mailCalls.some((c) => c.token === `vault-${gus.email}`)).toBe(false)
})

exampleTest(
  'a connection the provider turns down stops being used until it is connected again',
  async () => {
    const [connection] = await go(listConnections(dee.id))

    // Its access token has run out, and the provider refuses to renew it.
    if (!connection) {
      throw new Error('Dee has no connection')
    }

    const stale = await go(
      Vault.use((v) =>
        v.seal(
          { accessToken: 'stale', refreshToken: 'refresh', expiresAt: Date.now() - 3_600_000 },
          ownerOf(connection),
        ),
      ),
    )

    await db.update(Integration, { where: { id: connection.id } }, { credentials: stale })
    refused = true

    try {
      const run = await go(syncAll({ now: new Date(now.getTime() + 180_000) }))
      // One mailbox failing is that mailbox's problem, not the run's.
      expect(run.problem).toBeUndefined()
    } finally {
      refused = false
    }

    const [status] = await go(mailboxStatus(dee))
    expect(status).toMatchObject({ needsReconnect: true, canRead: false, canSend: false })
    expect(status?.lastError).toContain('Reconnect')
    expect(await go(sendFromMailbox(dee, message))).toBeNull()

    expect(await go(disconnect(dee.id, connection.id))).toBe(true)
    expect(await go(mailboxStatus(dee))).toEqual([])
  },
)
