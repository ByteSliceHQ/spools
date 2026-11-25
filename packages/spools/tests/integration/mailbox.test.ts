import { afterAll, beforeAll, expect } from 'bun:test'

import { type MailboxAccount, MailboxError, sendFromMailbox } from '../../src/server/mailbox'
import * as records from '../../src/server/records'
import { SignIns } from '../../src/server/sign-ins'
import { MailboxSync } from '../../src/server/store/tables'
import { mailboxStatus, syncAll, syncMailbox } from '../../src/server/sync'
import * as workspace from '../../src/server/workspace'
import {
  bodyText,
  db,
  run as go,
  installLiveServices,
  installStandIns,
} from '../../src/testing/run'
import { exampleTest, isExampleApp } from './example-app'

// Mail and calendar ingestion and sending against a real database, with Clerk
// (accounts and tokens), Google and Microsoft stubbed. Uses the example app's
// contacts (they have an email field).
const tag = `mbx${Date.now()}`
const ada = `user_ada_${tag}`
const ben = `user_ben_${tag}`
const cyd = `user_cyd_${tag}`
const client = `sam.${tag}@example.com`
const stranger = `stranger.${tag}@example.com`
const requested: string[] = []
const posted: { url: string; body: any }[] = []
const tokensAsked: string[] = []
let contactId = ''
let gmailDenied = false
let sharedCredentials = false

const GOOGLE = [
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

const MICROSOFT = ['openid', 'offline_access', 'Mail.Read', 'Calendars.Read', 'Mail.Send']

const accounts: MailboxAccount[] = [
  {
    userId: ada,
    name: 'Ada',
    provider: 'google',
    accountEmail: 'ada@acme.example.com',
    scopes: GOOGLE,
  },
  {
    userId: ben,
    name: 'Ben',
    provider: 'microsoft',
    accountEmail: 'Ben@acme.example.com',
    scopes: MICROSOFT,
  },
  // Signed in with Google but never granted mail access: must be left alone.
  {
    userId: cyd,
    name: 'Cyd',
    provider: 'google',
    accountEmail: 'cyd@acme.example.com',
    scopes: ['email', 'profile'],
  },
]

const user = (id: string) => {
  const a = accounts.find((x) => x.userId === id)!
  return { id, name: a.name, email: a.accountEmail.toLowerCase() }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const h = (headers: Record<string, string>) =>
  Object.entries(headers).map(([name, value]) => ({ name, value }))

const hour = 3_600_000
const now = new Date()
const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * hour)

// Ada's Gmail: one sent to the client, one received from the client, one from a
// stranger, and one from a colleague that copies the client. Gmail's own label, not the
// From header, says which Ada sent.
const gmail: Record<string, unknown> = {
  m1: {
    id: 'm1',
    labelIds: ['SENT'],
    internalDate: String(at(5).getTime()),
    snippet: 'Here&#39;s the revised quote',
    payload: {
      headers: h({
        From: 'Ada <ada@acme.example.com>',
        To: client,
        Subject: 'Revised quote',
        'Message-ID': `<m1.${tag}>`,
      }),
    },
  },
  m2: {
    id: 'm2',
    labelIds: ['INBOX'],
    internalDate: String(at(4).getTime()),
    snippet: 'Looks good',
    payload: {
      headers: h({
        From: `Sam <${client}>`,
        To: 'ada@acme.example.com',
        Subject: 'Re: Revised quote',
        'Message-ID': `<m2.${tag}>`,
      }),
    },
  },
  m3: {
    id: 'm3',
    labelIds: ['INBOX'],
    internalDate: String(at(3).getTime()),
    snippet: 'Private',
    payload: {
      headers: h({
        From: stranger,
        To: 'ada@acme.example.com',
        Subject: 'Dinner?',
        'Message-ID': `<m3.${tag}>`,
      }),
    },
  },
  m4: {
    id: 'm4',
    labelIds: ['INBOX'],
    internalDate: String(at(2).getTime()),
    snippet: 'Samples are in',
    payload: {
      headers: h({
        From: 'ben@acme.example.com',
        To: client,
        Cc: 'ada@acme.example.com',
        Subject: 'Samples',
        'Message-ID': `<m4.${tag}>`,
      }),
    },
  },
}

beforeAll(async () => {
  if (!isExampleApp) {
    return
  }

  const signIns = SignIns.layerTest({
    all: async () => accounts,
    of: async (u) => accounts.filter((a) => a.userId === u.id),
    people: async () => accounts.map((a) => user(a.userId)),
    token: async (userId, provider) => {
      tokensAsked.push(`${userId}:${provider}`)

      if (sharedCredentials) {
        throw new MailboxError({
          message: 'Clerk is using its shared development credentials.',
          kind: 'setup',
        })
      }

      return `token-${userId}`
    },
  })

  await installStandIns({
    signIns,
    fetch: async (url, init) => {
      requested.push(url)
      const u = new URL(url)

      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(bodyText(init)) })
        return u.hostname === 'graph.microsoft.com'
          ? new Response(null, { status: 202 })
          : json({ id: 'sent1' })
      }

      if (u.hostname === 'gmail.googleapis.com') {
        if (gmailDenied) {
          return json({ error: { code: 403 } }, 403)
        }

        if (u.pathname.endsWith('/messages')) {
          return json({ messages: Object.keys(gmail).map((id) => ({ id })) })
        }

        return json(gmail[u.pathname.split('/').pop() ?? ''] ?? {}, 200)
      }

      if (u.hostname === 'www.googleapis.com') {
        return json({
          items: [
            {
              id: 'e1',
              iCalUID: `meet.${tag}`,
              summary: 'Field measure',
              start: { dateTime: at(30).toISOString() },
              end: { dateTime: at(29).toISOString() },
              attendees: [
                { email: 'ada@acme.example.com', self: true },
                { email: client },
                { email: 'ben@acme.example.com' },
              ],
            },
            // Not finished yet: must not be logged.
            {
              id: 'e2',
              summary: 'Later',
              start: { dateTime: at(1).toISOString() },
              end: { dateTime: at(-1).toISOString() },
              attendees: [{ email: client }],
            },
          ],
        })
      }

      // Graph's well-known folders: what Ben sent, and what is read past.
      if (u.hostname === 'graph.microsoft.com' && u.pathname.includes('/mailFolders/')) {
        return json({ id: `folder-${u.pathname.split('/').pop()}` })
      }

      if (u.hostname === 'graph.microsoft.com' && u.pathname.endsWith('/messages')) {
        return json({
          value: [
            // Ben's copy of his own message to the client, in Sent Items: his to log, as sent.
            {
              id: 'g1',
              parentFolderId: 'folder-sentitems',
              internetMessageId: `<m4.${tag}>`,
              subject: 'Samples',
              bodyPreview: 'Samples are in',
              receivedDateTime: at(2).toISOString(),
              from: { emailAddress: { address: 'ben@acme.example.com' } },
              toRecipients: [{ emailAddress: { address: client } }],
            },
          ],
          // A page link that leaves Graph must never be followed with the token.
          '@odata.nextLink': 'https://evil.example.com/steal',
        })
      }

      if (u.hostname === 'graph.microsoft.com' && u.pathname.endsWith('/calendarView')) {
        return json({
          value: [
            {
              id: 'ge1',
              iCalUId: `meet.${tag}`,
              subject: 'Field measure',
              start: { dateTime: at(30).toISOString().replace('Z', '0000') },
              end: { dateTime: at(29).toISOString().replace('Z', '0000') },
              attendees: [{ emailAddress: { address: client } }],
            },
          ],
        })
      }

      return json({})
    },
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

  for (const userId of [ada, ben, cyd]) {
    await db.remove(MailboxSync, { where: { userId } })
  }

  if (contactId) {
    await go(records.deleteRecord('contacts', contactId))
  }
})

const account = (userId: string) => accounts.find((a) => a.userId === userId)!

const timeline = async () =>
  (await go(records.listActivities('contacts', contactId))).filter((a) => a.externalId)

exampleTest('a Gmail sync logs mail with a known contact and nothing else', async () => {
  const counts = await go(syncMailbox(account(ada), { now }))
  expect(counts).toEqual({ emails: 2, meetings: 1 })
  expect(tokensAsked).toContain(`${ada}:google`)

  const logged = await timeline()
  const sent = logged.find((a) => a.externalId === `email:<m1.${tag}>`)

  expect(sent).toMatchObject({
    kind: 'email',
    summary: 'sent an email: Revised quote',
    body: "Here's the revised quote",
    outcome: 'sent',
    actorId: ada,
  })

  expect(sent?.occurredAt?.getTime()).toBe(at(5).getTime())

  expect(logged.find((a) => a.externalId === `email:<m2.${tag}>`)).toMatchObject({
    summary: 'received an email: Re: Revised quote',
    outcome: 'received',
    actorId: ada,
  })

  // A stranger's mail and a colleague's mail that copies the client are not Ada's to log.
  expect(logged.some((a) => a.summary.includes('Dinner'))).toBe(false)
  expect(logged.some((a) => a.externalId === `email:<m4.${tag}>`)).toBe(false)

  expect(logged.find((a) => a.kind === 'meeting')).toMatchObject({
    summary: 'had a meeting: Field measure',
    outcome: 'completed',
    actorId: ada,
  })

  expect(logged.some((a) => a.summary.includes('Later'))).toBe(false)

  // Only headers were asked for: message bodies never leave Gmail.
  const gets = requested.filter((u) => /gmail.*\/messages\/m\d/.test(u))
  expect(gets.length).toBe(4)
  expect(gets.every((u) => u.includes('format=metadata'))).toBe(true)

  const [status] = await go(mailboxStatus(user(ada)))

  expect(status).toMatchObject({
    provider: 'google',
    canRead: true,
    canSend: true,
    lastError: null,
  })

  expect(new Date(status!.lastSyncedAt!).getTime()).toBe(now.getTime())
})

exampleTest('syncing again logs nothing twice', async () => {
  const before = (await timeline()).length

  expect(await go(syncMailbox(account(ada), { now: new Date(now.getTime() + 60_000) }))).toEqual({
    emails: 0,
    meetings: 0,
  })

  expect((await timeline()).length).toBe(before)
})

exampleTest(
  'a run covers every account that granted access, and leaves the rest alone',
  async () => {
    tokensAsked.length = 0
    const run = await go(syncAll({ now: new Date(now.getTime() + 90_000) }))
    // Ada was done above; Ben's Outlook is new; Cyd never granted mail access.
    expect(run).toMatchObject({ accounts: 2, synced: 2, emails: 1, meetings: 1, deferred: 0 })
    expect(run.problem).toBeUndefined()
    expect(tokensAsked.some((t) => t.startsWith(cyd))).toBe(false)
    expect(await db.first(MailboxSync, { where: { userId: cyd } })).toBeNull()

    const logged = await timeline()

    expect(logged.find((a) => a.externalId === `email:<m4.${tag}>`)).toMatchObject({
      summary: 'sent an email: Samples',
      actorId: ben,
      outcome: 'sent',
    })

    expect(
      logged
        .filter((a) => a.kind === 'meeting')
        .map((a) => a.actorId)
        .sort(),
    ).toEqual([ada, ben].sort())

    expect(requested.some((u) => u.includes('evil.example.com'))).toBe(false)
  },
)

exampleTest('a run that is out of time leaves accounts for the next one', async () => {
  const run = await go(syncAll({ budgetMs: -1, now: new Date(now.getTime() + 100_000) }))
  expect(run).toMatchObject({ accounts: 2, synced: 0, deferred: 2 })
})

exampleTest('synced mail and meetings reach the team activity report', async () => {
  const report = await go(
    workspace.activityReport({ from: at(48), to: at(-1) }, [
      { id: ada, name: 'Ada' },
      { id: ben, name: 'Ben' },
    ]),
  )

  // Received mail is on the timeline but is not something Ada did.
  expect(report.rows.find((r) => r.id === ada)).toMatchObject({ emails: 1, meetings: 1 })
  expect(report.rows.find((r) => r.id === ben)).toMatchObject({ emails: 1, meetings: 1 })
})

exampleTest("an email written in the CRM goes out from the teammate's own mailbox", async () => {
  posted.length = 0

  const message = {
    to: client,
    subject: 'Next steps',
    text: 'Shall we book it?',
    html: '<p>Shall we book it?</p>',
  }

  expect(await go(sendFromMailbox(user(ada), message))).toEqual({
    provider: 'google',
    accountEmail: 'ada@acme.example.com',
  })

  expect(posted[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
  const mime = Buffer.from(posted[0]?.body.raw, 'base64url').toString('utf8')
  expect(mime).toContain(`To: <${client}>`)
  expect(mime).toContain('Subject: Next steps')

  expect(await go(sendFromMailbox(user(ben), message))).toEqual({
    provider: 'microsoft',
    accountEmail: 'Ben@acme.example.com',
  })

  expect(posted[1]?.url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')

  expect(posted[1]?.body).toMatchObject({
    saveToSentItems: true,
    message: { subject: 'Next steps', toRecipients: [{ emailAddress: { address: client } }] },
  })

  // No mail scopes: nothing is sent, and the caller falls back to the app's provider.
  expect(await go(sendFromMailbox(user(cyd), message))).toBeNull()
  expect(posted.length).toBe(2)

  await expect(
    go(sendFromMailbox(user(ada), { ...message, to: 'sam@example.com, evil@example.com' })),
  ).rejects.toThrow(MailboxError)
})

exampleTest("the mailbox's copy of an email the CRM sent is not logged a second time", async () => {
  const sentAt = at(0.1)

  const mine = await go(
    records.addActivity({
      objectKey: 'contacts',
      recordId: contactId,
      kind: 'email',
      summary: records.emailSummary('sent', 'Next steps'),
      body: 'Shall we book it?',
      actor: 'Ada',
      actorId: ada,
      outcome: 'sent',
    }),
  )

  gmail['m5'] = {
    id: 'm5',
    labelIds: ['SENT'],
    internalDate: String(sentAt.getTime()),
    snippet: 'Shall we book it?',
    payload: {
      headers: h({
        From: 'ada@acme.example.com',
        To: client,
        Subject: 'Next steps',
        'Message-ID': `<m5.${tag}>`,
      }),
    },
  }

  try {
    const later = new Date(now.getTime() + 200_000)
    expect(await go(syncMailbox(account(ada), { now: later }))).toEqual({ emails: 0, meetings: 0 })

    const all = (await go(records.listActivities('contacts', contactId))).filter((a) =>
      a.summary.includes('Next steps'),
    )

    expect(all.length).toBe(1)

    // The CRM's own entry, with the full body it was written with, now carries the mailbox's id.
    expect(all[0]).toMatchObject({
      id: mine.id,
      body: 'Shall we book it?',
      externalId: `email:<m5.${tag}>`,
    })

    // And a further run still leaves one.
    await go(syncMailbox(account(ada), { now: new Date(later.getTime() + 60_000) }))

    expect(
      (await go(records.listActivities('contacts', contactId))).filter((a) =>
        a.summary.includes('Next steps'),
      ).length,
    ).toBe(1)
  } finally {
    delete gmail['m5']
  }
})

exampleTest('a provider that denies access is recorded on the account', async () => {
  gmailDenied = true

  try {
    expect(
      await go(syncMailbox(account(ada), { now: new Date(now.getTime() + 300_000) })),
    ).toBeNull()
  } finally {
    gmailDenied = false
  }

  const [status] = await go(mailboxStatus(user(ada)))
  expect(status?.lastError).toBe('gmail.googleapis.com denied access (403). Reconnect the account.')
})

exampleTest("when Clerk can't hand out tokens the run stops and says why", async () => {
  sharedCredentials = true
  tokensAsked.length = 0

  try {
    const run = await go(syncAll({ now: new Date(now.getTime() + 400_000) }))
    expect(run.synced).toBe(0)
    expect(run.problem).toContain('shared development credentials')
    // One account was tried, not every one.
    expect(tokensAsked.length).toBe(1)
  } finally {
    sharedCredentials = false
  }
})
