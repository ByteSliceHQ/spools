import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { PGlite } from '@electric-sql/pglite'
import { Effect, Layer } from 'effect'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { betterAuthClient, explain } from '../../src/adapters/auth/better-auth/client'
import { storeDatabase } from '../../src/adapters/auth/better-auth/database'
import { microsoftVouches } from '../../src/adapters/auth/better-auth/providers'
import {
  admit,
  betterAuth,
  tokenRefusal,
  toPerson,
} from '../../src/adapters/auth/better-auth/server'
import {
  AuthAccount,
  AuthSession,
  AuthUser,
  AuthVerification,
  authTables,
} from '../../src/adapters/auth/better-auth/tables'
import { pglite } from '../../src/adapters/database/pglite/server'
import { PROVIDERS } from '../../src/crm/mailbox'
import { environmentProblems } from '../../src/server/env'
import { disposeRuntime } from '../../src/server/runtime/app'
import { Auth } from '../../src/server/runtime/auth'
import { Email, type OutboundEmail } from '../../src/server/runtime/email'
import { DatabaseError } from '../../src/server/runtime/errors'
import { httpLayer } from '../../src/server/runtime/http'
import { defineSpool, type Spool, spool } from '../../src/server/spool'
import { allTables, schemaSql } from '../../src/server/store/schema-sql'
import { makeStore, Store } from '../../src/server/store/store'
import { isAllowed, Users } from '../../src/server/users'
import example from '../fixtures/example.config.json' with { type: 'json' }
import { db, failure, installStandIns, run, testRuntime } from '../support/run'

// Sign-in kept in the Spool's own database, on Postgres in this process. Google
// and Microsoft are stand-ins for `fetch`; nothing here reaches the network.

const ORIGIN = 'https://crm.acme.test'

const crm = {
  ...example,
  access: { allowedDomains: ['acme.test'], allowedEmails: ['guest@elsewhere.test'] },
}

const VARIABLES = [
  'NODE_ENV',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_SECRETS',
  'BETTER_AUTH_TRUSTED_ORIGINS',
  'APP_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
]

const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]))

const setEnv = (values: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
}

const usualEnv = () =>
  setEnv({
    ...Object.fromEntries(VARIABLES.map((name) => [name, undefined])),
    NODE_ENV: saved['NODE_ENV'],
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
    APP_URL: ORIGIN,
  })

const withProviders = (tenant?: string) =>
  setEnv({
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    MICROSOFT_CLIENT_ID: 'microsoft-id',
    MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
    MICROSOFT_TENANT_ID: tenant,
  })

const adapter = betterAuth({ answerAfter: 20 })
const realFetch = globalThis.fetch

let before: Spool
let client: PGlite
let outbox: OutboundEmail[] = []
/** What the stand-in email provider does with an email. */
let deliver: (email: OutboundEmail) => Promise<{ id: string | null; sent: boolean }>

beforeAll(async () => {
  before = spool()
  usualEnv()
  client = await PGlite.create()
  const auth = adapter
  const made = defineSpool({ crm, auth, database: pglite({ client }) })

  for (const statement of schemaSql(allTables(made.config, [auth]))) {
    await client.exec(statement)
  }

  await installStandIns({ email: Email.layerTest((email) => deliver(email)) })
})

afterAll(async () => {
  globalThis.fetch = realFetch
  setEnv(saved)
  // The other test files in this process go on with the Spool and the services they had.
  const back = defineSpool({ ...before, crm: before.config })
  await disposeRuntime()
  await client.close()
  expect(back.config).toEqual(before.config)
})

beforeEach(async () => {
  usualEnv()
  outbox = []

  deliver = async (email) => {
    outbox.push(email)
    return { id: 'mail', sent: true }
  }

  await client.exec('TRUNCATE auth_users, auth_sessions, auth_accounts, auth_verifications')
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ── Asking the server things, as a browser would ────────────────────────────

/** An address nobody else in these tests comes from: the limits count by it, and outlast a file that is run again. */
const newIp = () => `10.${crypto.getRandomValues(new Uint8Array(3)).join('.')}`

type Cookies = Map<string, string>

const cookieHeader = (cookies: Cookies) =>
  [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')

/** A browser: it keeps cookies, and says where a request came from. */
function browser(auth = adapter) {
  const cookies: Cookies = new Map()
  const ip = newIp()

  const send = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await (auth.handle?.(
      new Request(`${process.env['APP_URL'] ?? 'http://localhost:3000'}/api/auth${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }),
          'x-forwarded-for': ip,
          ...(cookies.size > 0 ? { cookie: cookieHeader(cookies) } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    ) ?? Promise.reject(new Error('The adapter answers no requests')))

    for (const line of response.headers.getSetCookie()) {
      const [pair = ''] = line.split(';')
      const at = pair.indexOf('=')

      if (/max-age=0/i.test(line)) {
        cookies.delete(pair.slice(0, at))
      } else {
        cookies.set(pair.slice(0, at), pair.slice(at + 1))
      }
    }

    return response
  }

  const session = () =>
    auth.session(
      new Request(ORIGIN, { headers: cookies.size > 0 ? { cookie: cookieHeader(cookies) } : {} }),
    )

  return { cookies, send, session }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The emails sent, once there are this many: the answer doesn't wait for them. */
async function emails(count: number): Promise<OutboundEmail[]> {
  for (let i = 0; i < 100 && outbox.length < count; i++) {
    await sleep(10)
  }

  expect(outbox.length).toBe(count)
  return outbox
}

const tokenIn = (email: OutboundEmail | undefined): string => {
  const found = email?.text.match(/\/sign-in#link=([A-Za-z]+)/)?.[1]

  if (!found) {
    throw new Error(`No link in: ${email?.text}`)
  }

  return found
}

const ask = (from: ReturnType<typeof browser>, email: string, more: Record<string, unknown> = {}) =>
  from.send('/sign-in/magic-link', { email, callbackURL: '/', ...more })

const open = (from: ReturnType<typeof browser>, token: string) =>
  from.send(
    `/magic-link/verify?${new URLSearchParams({ token, callbackURL: '/', errorCallbackURL: '/sign-in' })}`,
  )

/** Where a response sends the browser, without the origin. */
const goesTo = (response: Response) => response.headers.get('location')?.replace(ORIGIN, '')

/** Signs someone in with a link, in a browser of their own. */
async function signIn(email: string) {
  const person = browser()
  const already = outbox.length
  await ask(person, email)
  const sent = await emails(already + 1)
  await open(person, tokenIn(sent[already]))
  return person
}

const directory = <A, E>(program: Effect.Effect<A, E, Auth>) => run(program)

// ── The database adapter ────────────────────────────────────────────────────

describe('the database Better Auth keeps in the store', () => {
  const database = storeDatabase({ advanced: { database: { generateId: 'uuid' } } })
  type Row = { id: string; name: string; email: string; image: string | null }
  const names = (rows: Row[]) => rows.map((r) => r.name).sort()

  const find = (where: Parameters<typeof database.findMany>[0]['where']) =>
    database.findMany<Row>({ model: 'user', where })

  const day = (n: number) => new Date(Date.UTC(2026, 0, n))

  beforeEach(async () => {
    for (const [i, [name, email, image]] of [
      ['Ana', 'ana@acme.test', null],
      ['Bo', 'bo@acme.test', 'https://img.test/bo.png'],
      ['Cy', 'CY@Other.test', null],
      ['Di_100%', 'di@other.test', 'https://img.test/di.png'],
    ].entries()) {
      await database.create({
        model: 'user',
        data: {
          name,
          email,
          image,
          emailVerified: i % 2 === 0,
          createdAt: day(i + 1),
          updatedAt: day(i + 1),
        },
      })
    }
  })

  test('a row comes back as it was put in, with an id and what was left out', async () => {
    const made = await database.create({
      model: 'user',
      data: { name: 'Eve', email: 'eve@acme.test', createdAt: day(9), updatedAt: day(9) },
    })

    expect(made).toMatchObject({
      name: 'Eve',
      emailVerified: false,
      image: null,
      createdAt: day(9),
    })

    expect(made['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/)

    expect(
      await database.findOne<Row>({ model: 'user', where: [{ field: 'id', value: made['id'] }] }),
    ).toEqual(expect.objectContaining({ email: 'eve@acme.test' }))

    expect(
      await database.findOne({ model: 'user', where: [{ field: 'id', value: 'nobody' }] }),
    ).toBeNull()
  })

  test('every comparison', async () => {
    expect(names(await find([{ field: 'name', value: 'Ana' }]))).toEqual(['Ana'])

    expect(names(await find([{ field: 'name', operator: 'ne', value: 'Ana' }]))).toEqual([
      'Bo',
      'Cy',
      'Di_100%',
    ])

    expect(names(await find([{ field: 'createdAt', operator: 'lt', value: day(2) }]))).toEqual([
      'Ana',
    ])

    expect(names(await find([{ field: 'createdAt', operator: 'lte', value: day(2) }]))).toEqual([
      'Ana',
      'Bo',
    ])

    expect(names(await find([{ field: 'createdAt', operator: 'gt', value: day(3) }]))).toEqual([
      'Di_100%',
    ])

    expect(names(await find([{ field: 'createdAt', operator: 'gte', value: day(3) }]))).toEqual([
      'Cy',
      'Di_100%',
    ])

    expect(names(await find([{ field: 'emailVerified', value: true }]))).toEqual(['Ana', 'Cy'])

    expect(
      names(await find([{ field: 'name', operator: 'in', value: ['Ana', 'Cy', 'Zed'] }])),
    ).toEqual(['Ana', 'Cy'])

    expect(
      names(await find([{ field: 'name', operator: 'not_in', value: ['Ana', 'Cy'] }])),
    ).toEqual(['Bo', 'Di_100%'])

    expect(await find([{ field: 'name', operator: 'in', value: [] }])).toEqual([])
  })

  test('empty columns: equal to null, not equal to null, and neither more nor less than anything', async () => {
    expect(names(await find([{ field: 'image', value: null }]))).toEqual(['Ana', 'Cy'])

    expect(names(await find([{ field: 'image', operator: 'ne', value: null }]))).toEqual([
      'Bo',
      'Di_100%',
    ])

    // As in SQL, a column that holds nothing is not "not equal" to something.
    expect(
      names(await find([{ field: 'image', operator: 'ne', value: 'https://img.test/bo.png' }])),
    ).toEqual(['Di_100%'])

    expect(await find([{ field: 'createdAt', operator: 'gt', value: null }])).toEqual([])
  })

  test('parts of a text: without regard to case, and with no wildcards in it', async () => {
    expect(names(await find([{ field: 'email', operator: 'contains', value: 'OTHER' }]))).toEqual([
      'Cy',
      'Di_100%',
    ])

    expect(names(await find([{ field: 'email', operator: 'starts_with', value: 'cy@' }]))).toEqual([
      'Cy',
    ])

    expect(
      names(await find([{ field: 'email', operator: 'ends_with', value: 'acme.test' }])),
    ).toEqual(['Ana', 'Bo'])

    expect(names(await find([{ field: 'name', operator: 'contains', value: '_100%' }]))).toEqual([
      'Di_100%',
    ])

    expect(await find([{ field: 'name', operator: 'contains', value: '%n%' }])).toEqual([])
  })

  test('equality is exact, unless it is asked to ignore case', async () => {
    expect(await find([{ field: 'email', value: 'cy@other.test' }])).toEqual([])
    expect(await find([{ field: 'email', operator: 'in', value: ['cy@other.test'] }])).toEqual([])

    expect(
      names(await find([{ field: 'email', value: 'cy@other.test', mode: 'insensitive' }])),
    ).toEqual(['Cy'])

    expect(
      names(
        await find([
          { field: 'email', operator: 'in', value: ['cy@other.test'], mode: 'insensitive' },
        ]),
      ),
    ).toEqual(['Cy'])

    expect(
      names(await find([{ field: 'name', operator: 'ne', value: 'ANA', mode: 'insensitive' }])),
    ).toEqual(['Bo', 'Cy', 'Di_100%'])

    expect(
      names(
        await find([
          { field: 'name', operator: 'not_in', value: ['ANA', 'BO'], mode: 'insensitive' },
        ]),
      ),
    ).toEqual(['Cy', 'Di_100%'])
  })

  test('conditions joined with AND must all hold, and one of those joined with OR', async () => {
    expect(
      names(
        await find([
          { field: 'emailVerified', value: true },
          { field: 'email', operator: 'ends_with', value: 'acme.test' },
        ]),
      ),
    ).toEqual(['Ana'])

    expect(
      names(
        await find([
          { field: 'name', value: 'Ana', connector: 'OR' },
          { field: 'name', value: 'Bo', connector: 'OR' },
        ]),
      ),
    ).toEqual(['Ana', 'Bo'])

    expect(
      names(
        await find([
          { field: 'emailVerified', value: true },
          { field: 'name', value: 'Ana', connector: 'OR' },
          { field: 'name', value: 'Bo', connector: 'OR' },
        ]),
      ),
    ).toEqual(['Ana'])
  })

  test('order, pages and some of the columns', async () => {
    const page = (offset: number) =>
      database.findMany<Row>({
        model: 'user',
        sortBy: { field: 'createdAt', direction: 'desc' },
        limit: 2,
        offset,
      })

    expect((await page(0)).map((r) => r.name)).toEqual(['Di_100%', 'Cy'])
    expect((await page(2)).map((r) => r.name)).toEqual(['Bo', 'Ana'])

    expect(
      await database.findOne<Row>({
        model: 'user',
        where: [{ field: 'name', value: 'Bo' }],
        select: ['email'],
      }),
    ).toEqual(expect.objectContaining({ email: 'bo@acme.test' }))

    expect(await database.count({ model: 'user' })).toBe(4)

    expect(
      await database.count({ model: 'user', where: [{ field: 'emailVerified', value: true }] }),
    ).toBe(2)
  })

  test('changes: one row, many rows, and none', async () => {
    const changed = await database.update<Row>({
      model: 'user',
      where: [{ field: 'email', value: 'bo@acme.test' }],
      update: { name: 'Bob' },
    })

    expect(changed).toMatchObject({ name: 'Bob', email: 'bo@acme.test' })

    expect(
      await database.update({
        model: 'user',
        where: [{ field: 'name', value: 'Bo' }],
        update: { name: 'x' },
      }),
    ).toBeNull()

    expect(
      await database.updateMany({
        model: 'user',
        where: [{ field: 'emailVerified', value: true }],
        update: { image: 'https://img.test/new.png' },
      }),
    ).toBe(2)
  })

  test('deletes: one row, many rows, and none', async () => {
    await database.delete({ model: 'user', where: [{ field: 'name', value: 'Ana' }] })
    expect(await database.count({ model: 'user' })).toBe(3)

    expect(
      await database.deleteMany({
        model: 'user',
        where: [{ field: 'name', operator: 'in', value: ['Bo', 'Cy', 'Zed'] }],
      }),
    ).toBe(2)

    expect(
      await database.deleteMany({ model: 'user', where: [{ field: 'name', value: 'Ana' }] }),
    ).toBe(0)
  })

  test('of several callers using up one row, exactly one gets it', async () => {
    const taken = await Promise.all(
      [1, 2, 3, 4].map(() =>
        database.consumeOne<Row>({ model: 'user', where: [{ field: 'name', value: 'Ana' }] }),
      ),
    )

    expect(taken.filter((row) => row !== null).map((row) => row?.name)).toEqual(['Ana'])
    expect(await database.count({ model: 'user' })).toBe(3)
  })

  test('a change or a delete that could reach too much is refused', async () => {
    await expect(database.deleteMany({ model: 'user', where: [] })).rejects.toThrow(
      'Refusing to delete every row',
    )

    await expect(
      database.updateMany({ model: 'user', where: [], update: { name: 'x' } }),
    ).rejects.toThrow('Refusing to change every row')

    // It would reach rows that differ only in case, which nobody asked for.
    const loose = { field: 'email', operator: 'ends_with', value: 'acme.test' } as const

    await expect(database.deleteMany({ model: 'user', where: [loose] })).rejects.toThrow(
      'ignores case',
    )

    expect(
      await database.deleteMany({ model: 'user', where: [{ ...loose, mode: 'insensitive' }] }),
    ).toBe(2)
  })

  test("a field the tables don't have is refused, not dropped", async () => {
    const grown = storeDatabase({
      user: { additionalFields: { role: { type: 'string', required: false } } },
    })

    await expect(
      grown.create({ model: 'user', data: { name: 'Eve', email: 'eve@acme.test', role: 'admin' } }),
    ).rejects.toThrow('"role", which auth_users has no column for')
  })

  test('a person comes back with their session', async () => {
    const user = await database.findOne<Row>({
      model: 'user',
      where: [{ field: 'name', value: 'Ana' }],
    })

    await database.create({
      model: 'session',
      data: {
        userId: user?.id,
        token: 't1',
        expiresAt: day(40),
        createdAt: day(1),
        updatedAt: day(1),
      },
    })

    expect(
      await database.findOne<Record<string, unknown>>({
        model: 'session',
        where: [{ field: 'token', value: 't1' }],
        join: { user: true },
      }),
    ).toMatchObject({ token: 't1', user: { name: 'Ana' } })
  })
})

describe('the tables', () => {
  test("come with the adapter, and are made with the Spool's own", async () => {
    expect(adapter.tables).toEqual(authTables)

    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'auth_%' ORDER BY 1",
    )

    expect(rows.map((r) => r.tablename)).toEqual([
      'auth_accounts',
      'auth_sessions',
      'auth_users',
      'auth_verifications',
    ])

    expect(schemaSql(allTables(spool().config)).some((sql) => sql.includes('auth_users'))).toBe(
      false,
    )
  })

  test('hold no passwords and no identity tokens', () => {
    for (const table of authTables) {
      expect(Object.keys(table.columns)).not.toContain('password')
      expect(Object.keys(table.columns)).not.toContain('idToken')
    }
  })

  test('one address is one person, one token one session, one account one row', async () => {
    const expiresAt = new Date()

    const twice = async (insert: () => Promise<unknown>) => {
      await insert()
      await expect(insert()).rejects.toThrow('duplicate key')
    }

    await twice(() => db.insert(AuthUser, { name: '', email: 'one@acme.test' }))
    await twice(() => db.insert(AuthSession, { userId: 'u', token: 't', expiresAt }))
    await twice(() => db.insert(AuthAccount, { userId: 'u', providerId: 'google', accountId: '1' }))
    // The same account id at another provider is another account.
    await db.insert(AuthAccount, { userId: 'u', providerId: 'microsoft', accountId: '1' })
  })
})

// ── Links by email ──────────────────────────────────────────────────────────

describe('signing in with a link by email', () => {
  test('an address on the list gets a link, and the link signs them in', async () => {
    const ana = browser()
    const asked = await ask(ana, 'Ana@Acme.test')
    expect(asked.status).toBe(200)
    expect(await asked.json()).toEqual({ status: true })
    expect(await ana.session()).toBeNull()

    const [email] = await emails(1)
    expect(email?.to).toBe('Ana@Acme.test')
    expect(email?.subject).toBe('Sign in to Acme')
    expect(email?.subject).not.toContain('link=')
    const token = tokenIn(email)
    const link = `${ORIGIN}/sign-in#link=${token}`
    expect(email?.text).toContain(link)
    expect(email?.html).toContain(`<a href="${link}">`)
    expect(email?.idempotencyKey).toBeTruthy()

    const opened = await open(ana, token)
    expect(opened.status).toBe(302)
    expect(goesTo(opened)).toBe('/')
    const session = await ana.session()
    const [user] = await db.find(AuthUser)
    expect(user).toMatchObject({ email: 'ana@acme.test', emailVerified: true })
    expect(session?.userId).toBe(user!.id)
    expect(await session?.getToken({ template: 'swirls' })).toBeNull()

    // And the CRM lets them in.
    expect(await run(Users.use((u) => u.crmUser(user!.id)))).toEqual({
      id: user!.id,
      email: 'ana@acme.test',
      name: 'ana@acme.test',
    })
  })

  test('coming back is the same person, and one person on the list by address alone gets in too', async () => {
    const first = await (await signIn('ana@acme.test')).session()
    const second = await (await signIn('ana@acme.test')).session()
    expect(second?.userId).toBe(first!.userId)
    expect(await (await signIn('guest@elsewhere.test')).session()).not.toBeNull()
    expect((await db.find(AuthUser)).length).toBe(2)
  })

  test('an address off the list gets the same answer, and no email', async () => {
    const answer = async (email: string) => {
      const response = await ask(browser(), email)
      return {
        status: response.status,
        body: await response.text(),
        headers: [...response.headers],
      }
    }

    const allowed = await answer('ana@acme.test')
    await emails(1)

    for (const email of ['someone@elsewhere.test', 'ana@acme.test.evil.test', 'x@notacme.test']) {
      expect(await answer(email)).toEqual(allowed)
    }

    await sleep(100)
    expect(outbox.length).toBe(1)
  })

  test('asking takes as long whether or not there is an email to send', async () => {
    const slow = betterAuth({ answerAfter: 150 })

    deliver = async (email) => {
      await sleep(600)
      outbox.push(email)
      return { id: 'mail', sent: true }
    }

    const timed = async (email: string) => {
      const started = performance.now()
      await ask(browser(slow), email)
      return performance.now() - started
    }

    for (const took of [await timed('ana@acme.test'), await timed('someone@elsewhere.test')]) {
      expect(took).toBeGreaterThan(140)
      expect(took).toBeLessThan(550)
    }

    await emails(1)
  })

  test('a link works once', async () => {
    const ana = browser()
    await ask(ana, 'ana@acme.test')
    const token = tokenIn((await emails(1))[0])
    await open(ana, token)
    const again = browser()
    const refused = await open(again, token)
    expect(goesTo(refused)).toBe('/sign-in?error=INVALID_TOKEN')
    expect(await again.session()).toBeNull()
  })

  test('opened twice at once, a link signs in one of the two', async () => {
    await ask(browser(), 'ana@acme.test')
    const token = tokenIn((await emails(1))[0])
    const two = [browser(), browser()]
    await Promise.all(two.map((b) => open(b, token)))
    const sessions = await Promise.all(two.map((b) => b.session()))
    expect(sessions.filter((s) => s !== null).length).toBe(1)
  })

  test('a link works for ten minutes', async () => {
    await ask(browser(), 'ana@acme.test')
    const token = tokenIn((await emails(1))[0])
    const [waiting] = await db.find(AuthVerification)
    const minutes = (waiting!.expiresAt.getTime() - Date.now()) / 60_000
    expect(minutes).toBeGreaterThan(9)
    expect(minutes).toBeLessThanOrEqual(10)

    await db.update(
      AuthVerification,
      { where: { id: waiting!.id } },
      { expiresAt: new Date(Date.now() - 1000) },
    )

    const late = browser()
    expect(goesTo(await open(late, token))).toBe('/sign-in?error=INVALID_TOKEN')
    expect(await late.session()).toBeNull()
    expect(await db.find(AuthUser)).toEqual([])
  })

  test('a made-up link does not work, and neither does what the database holds', async () => {
    await ask(browser(), 'ana@acme.test')
    const token = tokenIn((await emails(1))[0])
    const [waiting] = await db.find(AuthVerification)
    expect(JSON.stringify(waiting)).not.toContain(token)
    const held = waiting!.identifier.replace('magic-link:', '')

    for (const forged of [
      'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf',
      held,
      `${token}x`,
      token.slice(0, -1),
      '',
    ]) {
      const who = browser()
      await open(who, forged)
      expect(await who.session()).toBeNull()
    }

    expect(await db.find(AuthUser)).toEqual([])
  })

  test('taken off the list between asking and opening, someone new gets no account', async () => {
    await ask(browser(), 'ana@acme.test')
    const token = tokenIn((await emails(1))[0])
    const { access } = spool().config
    const domains = access.allowedDomains.splice(0)
    const ana = browser()
    const refused = await open(ana, token)
    access.allowedDomains.push(...domains)
    expect(goesTo(refused)).toStartWith('/sign-in?error=not_allowed')
    expect(await ana.session()).toBeNull()
    expect(await db.find(AuthUser)).toEqual([])
  })

  test("whoever asks doesn't get to name the person", async () => {
    const mallory = browser()
    await ask(mallory, 'ana@acme.test', { name: 'The boss', metadata: { html: '<b>' } })
    const [email] = await emails(1)
    expect(email?.text).not.toContain('The boss')
    await open(browser(), tokenIn(email))
    expect((await db.find(AuthUser))[0]?.name).toBe('')
  })

  test("nobody's inbox can be filled: five links at most are waiting at an address", async () => {
    for (let i = 0; i < 7; i++) {
      expect((await ask(browser(), i % 2 ? 'ana@acme.test' : 'ANA@acme.test')).status).toBe(200)
    }

    await emails(5)
    await sleep(100)
    expect(outbox.length).toBe(5)
    // Someone else's are not affected.
    await ask(browser(), 'bo@acme.test')
    await emails(6)
  })

  test("one visitor can't ask over and over", async () => {
    const eager = browser()
    const statuses: number[] = []

    for (let i = 0; i < 6; i++) {
      statuses.push((await ask(eager, `p${i}@elsewhere.test`)).status)
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
  })

  test("an email provider that fails changes nothing in the answer, and the link isn't logged", async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    let link = ''

    deliver = async (email) => {
      link = email.text
      throw new Error('The provider is down')
    }

    const response = await ask(browser(), 'ana@acme.test')
    expect([response.status, await response.json()]).toEqual([200, { status: true }])

    for (let i = 0; i < 100 && errors.mock.calls.length === 0; i++) {
      await sleep(10)
    }

    const logged = JSON.stringify(errors.mock.calls)
    errors.mockRestore()
    expect(logged).toContain('The provider is down')
    expect(logged).not.toContain(tokenIn({ to: '', subject: '', html: '', text: link }))
  })

  test('without an email provider the link is written to the log in development, and never in production', async () => {
    const lines: string[] = []

    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(`${level}: ${args.map(String).join(' ')}`)
      }),
    )

    deliver = async (email) => {
      outbox.push(email)
      return { id: null, sent: false }
    }

    try {
      await ask(browser(), 'ana@acme.test')
      const developed = tokenIn((await emails(1))[0])

      for (let i = 0; i < 100 && lines.length === 0; i++) {
        await sleep(10)
      }

      expect(lines.filter((l) => l.includes(developed)).map((l) => l.slice(0, 5))).toEqual([
        'info:',
      ])

      lines.length = 0
      process.env['NODE_ENV'] = 'production'
      await ask(browser(), 'bo@acme.test')
      const kept = tokenIn((await emails(2))[1])

      for (let i = 0; i < 100 && lines.length === 0; i++) {
        await sleep(10)
      }

      expect(lines.join('\n')).toContain('No email provider is set up')
      expect(lines.join('\n')).not.toContain(kept)
      expect(lines.join('\n')).not.toContain('#link=')
    } finally {
      for (const spy of spies) {
        spy.mockRestore()
      }
    }
  })

  test("a link can't be made to lead anywhere else", async () => {
    const noise = spyOn(console, 'error').mockImplementation(() => {})
    const asked = await ask(browser(), 'ana@acme.test', { callbackURL: 'https://evil.test/' })
    expect(asked.status).toBe(403)
    await ask(browser(), 'ana@acme.test')
    const token = tokenIn((await emails(1))[0])

    for (const elsewhere of ['https://evil.test/', '//evil.test', '/\\evil.test']) {
      const query = new URLSearchParams({ token, callbackURL: elsewhere })
      expect((await browser().send(`/magic-link/verify?${query}`)).status).toBe(403)
    }

    noise.mockRestore()
  })

  test("another site can't ask in someone's browser", async () => {
    const noise = spyOn(console, 'error').mockImplementation(() => {})
    const ana = await signIn('ana@acme.test')

    for (const path of ['/sign-in/magic-link', '/sign-out']) {
      const body = { email: 'ana@acme.test' }
      expect((await ana.send(path, body, { origin: 'https://evil.test' })).status).toBe(403)
    }

    // Before there is any cookie, too, when the browser says it is another site asking.
    const first = await browser().send(
      '/sign-in/magic-link',
      { email: 'ana@acme.test' },
      { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
    )

    expect(first.status).toBe(403)
    noise.mockRestore()
    expect(await ana.session()).not.toBeNull()
    expect(outbox.length).toBe(1)
  })
})

describe('the access list', () => {
  test('goes by the whole address or what follows the last @, in any case', () => {
    expect(isAllowed('Ana@ACME.test')).toBe(true)
    expect(isAllowed('GUEST@elsewhere.test')).toBe(true)
    expect(isAllowed('other@elsewhere.test')).toBe(false)
    expect(isAllowed('ana@sub.acme.test')).toBe(false)
    expect(isAllowed('"a@acme.test"@evil.test')).toBe(false)
    expect(isAllowed('a@acme.test@evil.test')).toBe(false)
    expect(isAllowed('acme.test')).toBe(false)
    expect(isAllowed('')).toBe(false)
  })
})

// ── Sessions ────────────────────────────────────────────────────────────────

describe('a session', () => {
  const COOKIE = '__Secure-spools.session_token'

  test("is a cookie scripts can't read, sent to this site only, over https", async () => {
    const ana = browser()
    await ask(ana, 'ana@acme.test')
    const opened = await open(ana, tokenIn((await emails(1))[0]))
    const cookie = opened.headers.getSetCookie().find((line) => line.startsWith(COOKIE)) ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`)
  })

  test("over plain http the cookie isn't marked secure, or nobody could sign in", async () => {
    process.env['APP_URL'] = 'http://crm.local:3000'
    const ana = browser()

    await ana.send(
      '/sign-in/magic-link',
      { email: 'ana@acme.test' },
      { origin: 'http://crm.local:3000' },
    )

    await open(ana, tokenIn({ to: '', subject: '', html: '', text: (await emails(1))[0]!.text }))
    expect([...ana.cookies.keys()]).toEqual(['spools.session_token'])
    expect(await ana.session()).not.toBeNull()
  })

  test("missing, made up or changed, it is nobody's", async () => {
    const ana = await signIn('ana@acme.test')
    expect(await browser().session()).toBeNull()
    const value = ana.cookies.get(COOKIE) ?? ''
    expect(value).toBeTruthy()
    const at = value.indexOf('.')

    for (const tampered of [
      'nonsense',
      value.slice(0, at), // no signature
      `${value.startsWith('x') ? 'y' : 'x'}${value.slice(1)}`, // another token, the same signature
      `${value.slice(0, -4)}AAAA`,
      '',
    ]) {
      const other = browser()
      other.cookies.set(COOKIE, tampered)
      expect(await other.session()).toBeNull()
    }

    // The token alone, as the database holds it, isn't enough.
    const [row] = await db.find(AuthSession)
    const thief = browser()
    thief.cookies.set(COOKIE, row!.token)
    expect(await thief.session()).toBeNull()
  })

  test("signed with another secret, it is nobody's", async () => {
    const ana = await signIn('ana@acme.test')
    process.env['BETTER_AUTH_SECRET'] = 'another-secret-another-secret-another-1'
    expect(await ana.session()).toBeNull()
  })

  test('ends when the person signs out, also for a copy of the cookie', async () => {
    const ana = await signIn('ana@acme.test')
    const copy = browser()

    for (const [name, value] of ana.cookies) {
      copy.cookies.set(name, value)
    }

    expect(await copy.session()).not.toBeNull()
    expect((await ana.send('/sign-out', {})).status).toBe(200)
    expect(await ana.session()).toBeNull()
    expect(await copy.session()).toBeNull()
    expect(await db.find(AuthSession)).toEqual([])
  })

  test("lasts thirty days from signing in, and using it doesn't extend it", async () => {
    const ana = await signIn('ana@acme.test')
    const [row] = await db.find(AuthSession)
    const days = (row!.expiresAt.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThanOrEqual(30)

    const soon = new Date(Date.now() + 60_000)
    await db.update(AuthSession, { where: { id: row!.id } }, { expiresAt: soon })
    expect(await ana.session()).not.toBeNull()
    expect((await ana.send('/list-accounts')).status).toBe(200)
    expect((await db.find(AuthSession))[0]?.expiresAt).toEqual(soon)

    await db.update(
      AuthSession,
      { where: { id: row!.id } },
      { expiresAt: new Date(Date.now() - 1000) },
    )

    expect(await ana.session()).toBeNull()
  })
})

// ── Google and Microsoft ────────────────────────────────────────────────────

/** An identity token as a provider sends it. Nothing checks its signature: it comes straight from the provider. */
const identity = (claims: Record<string, unknown>) =>
  [{ alg: 'RS256', typ: 'JWT' }, claims, {}]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.')

type TokenRequest = { url: string; body: URLSearchParams }

/** Stands in for the providers' token endpoints. Anything else that is fetched fails the test. */
function provider(answer: (request: TokenRequest) => Response | Promise<Response>): TokenRequest[] {
  const requests: TokenRequest[] = []

  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { url: String(input), body: new URLSearchParams(String(init?.body ?? '')) }

      if (
        !/^https:\/\/(oauth2\.googleapis\.com\/token|login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token)$/.test(
          request.url,
        )
      ) {
        throw new Error(`Unexpected request to ${request.url}`)
      }

      requests.push(request)
      return answer(request)
    },
    { preconnect: realFetch.preconnect },
  )

  return requests
}

const GOOGLE_SCOPE = 'openid email profile'

const tokens = (claims: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  Response.json({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: GOOGLE_SCOPE,
    id_token: identity(claims),
    ...more,
  })

/** Starts at the provider and comes back with a code. */
async function through(
  person: ReturnType<typeof browser>,
  id: 'google' | 'microsoft',
  start: { path: string; body: Record<string, unknown> } = { path: '/sign-in/social', body: {} },
) {
  const started = await person.send(start.path, {
    provider: id,
    callbackURL: '/',
    errorCallbackURL: '/sign-in',
    ...start.body,
  })

  const answer: { url?: string } = await started.json()

  if (!answer.url) {
    return { started, url: null, back: started }
  }

  const url = new URL(answer.url)
  const state = url.searchParams.get('state') ?? ''

  const back = await person.send(
    `/callback/${id}?${new URLSearchParams({ code: 'code-1', state })}`,
  )

  return { started, url, back }
}

const ana = { sub: 'g-ana', email: 'ana@acme.test', email_verified: true, name: 'Ana Ortiz' }

describe('signing in with Google', () => {
  beforeEach(() => withProviders())

  test('someone on the list gets an account and a session', async () => {
    provider(() => tokens(ana))
    const person = browser()
    const { url, back } = await through(person, 'google')
    expect(url?.origin).toBe('https://accounts.google.com')
    expect(url?.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`)
    expect(url?.searchParams.get('access_type')).toBe('offline')
    expect(url?.searchParams.get('code_challenge_method')).toBe('S256')
    expect(goesTo(back)).toBe('/')

    const session = await person.session()

    expect(await directory(Auth.use((a) => a.getUser(session!.userId)))).toEqual({
      id: session!.userId,
      name: 'Ana Ortiz',
      email: 'ana@acme.test',
      accounts: [
        { provider: 'google', email: 'ana@acme.test', scopes: ['openid', 'email', 'profile'] },
      ],
    })
  })

  test("the tokens are stored encrypted, and the identity token isn't stored", async () => {
    provider(() => tokens(ana))
    await through(browser(), 'google')
    const { rows } = await client.query('SELECT * FROM auth_accounts')
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain('access-1')
    expect(stored).not.toContain('refresh-1')
    expect(stored).not.toContain(identity(ana))
    const [account] = await db.find(AuthAccount)
    expect(account?.accessToken).toBeTruthy()
    expect(account?.refreshToken).toBeTruthy()
  })

  test('someone off the list gets neither', async () => {
    provider(() => tokens({ ...ana, email: 'ana@gmail.test' }))
    const person = browser()
    const { back } = await through(person, 'google')
    expect(goesTo(back)).toStartWith('/sign-in?error=not_allowed')
    expect(await person.session()).toBeNull()

    expect([
      await db.find(AuthUser),
      await db.find(AuthAccount),
      await db.find(AuthSession),
    ]).toEqual([[], [], []])
  })

  test("an address Google hasn't verified is no address, whoever it would be", async () => {
    const noise = spyOn(console, 'error').mockImplementation(() => {})
    await signIn('ana@acme.test')

    // Someone here already, someone on the list, someone off it: the answer is the same for each.
    for (const email of ['ana@acme.test', 'bo@acme.test', 'x@elsewhere.test']) {
      for (const email_verified of [false, 'true', undefined]) {
        provider(() => tokens({ ...ana, email, email_verified }))
        const person = browser()

        expect(goesTo((await through(person, 'google')).back)).toBe(
          '/sign-in?error=email_not_found',
        )

        expect(await person.session()).toBeNull()
      }
    }

    noise.mockRestore()
    expect((await db.find(AuthUser)).map((u) => u.email)).toEqual(['ana@acme.test'])
    expect(await db.find(AuthAccount)).toEqual([])
  })

  test('an address that is here already is the same person, once both sides have verified it', async () => {
    const first = await (await signIn('ana@acme.test')).session()
    provider(() => tokens(ana))
    const person = browser()
    await through(person, 'google')
    expect((await person.session())?.userId).toBe(first!.userId)
    // And now has a name.
    expect((await db.find(AuthUser)).map((u) => u.name)).toEqual(['Ana Ortiz'])
  })

  test('a person whose own address was never verified is not matched with an account', async () => {
    const noise = spyOn(console, 'error').mockImplementation(() => {})

    const planted = await db.insert(AuthUser, {
      name: '',
      email: 'ana@acme.test',
      emailVerified: false,
    })

    provider(() => tokens(ana))
    const person = browser()
    expect(goesTo((await through(person, 'google')).back)).toBe('/sign-in?error=account_not_linked')
    expect(await person.session()).toBeNull()
    noise.mockRestore()
    expect(await db.find(AuthAccount)).toEqual([])

    // The owner of the mailbox gets it with a link, and nothing anyone did to it before is left.
    await db.insert(AuthSession, {
      userId: planted.id,
      token: 'planted',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const owner = await (await signIn('ana@acme.test')).session()
    expect(owner?.userId).toBe(planted.id)
    expect((await db.find(AuthSession)).map((s) => s.token)).not.toContain('planted')
  })

  test('what comes back must be what was asked for, in the same browser', async () => {
    const noise = spyOn(console, 'error').mockImplementation(() => {})
    provider(() => tokens(ana))

    const started = await browser().send('/sign-in/social', {
      provider: 'google',
      callbackURL: '/',
    })

    const answer: { url: string } = await started.json()
    const state = new URL(answer.url).searchParams.get('state') ?? ''
    const other = browser()
    const back = await other.send(`/callback/google?${new URLSearchParams({ code: 'c', state })}`)
    expect(goesTo(back)).toStartWith('/sign-in?error=state_mismatch')

    expect(goesTo(await other.send('/callback/google?code=c&state=made-up'))).toStartWith(
      '/sign-in?error=',
    )

    expect(await other.session()).toBeNull()
    noise.mockRestore()
  })

  test('a token handed to the server is not a sign-in', async () => {
    const noise = spyOn(console, 'error').mockImplementation(() => {})
    const person = browser()

    const response = await person.send('/sign-in/social', {
      provider: 'google',
      idToken: {
        token: identity({ ...ana, aud: 'google-id', iss: 'https://accounts.google.com' }),
      },
    })

    expect(response.status).toBe(404)
    expect(await person.session()).toBeNull()
    noise.mockRestore()
  })

  test('more access can be granted to the account later, and what was granted is kept', async () => {
    provider(() => tokens(ana))
    const person = browser()
    await through(person, 'google')
    const scopes = [...PROVIDERS.google.read, ...PROVIDERS.google.send]

    provider(() =>
      tokens(ana, { access_token: 'access-2', scope: `${GOOGLE_SCOPE} ${scopes.join(' ')}` }),
    )

    const { url, back } = await through(person, 'google', {
      path: '/link-social',
      body: {
        scopes,
        additionalParams: { prompt: 'consent' },
        errorCallbackURL: '/sign-in?for=account',
      },
    })

    expect(url?.searchParams.get('prompt')).toBe('consent')
    expect(url?.searchParams.get('scope')).toContain('gmail.readonly')
    expect(goesTo(back)).toBe('/')

    const listed: { providerId: string; scopes: string[] }[] = await (
      await person.send('/list-accounts')
    ).json()

    expect(listed.map((a) => a.providerId)).toEqual(['google'])
    expect(listed[0]?.scopes).toEqual([...GOOGLE_SCOPE.split(' '), ...scopes])
    expect(JSON.stringify(listed)).not.toContain('access-2')

    // Signing in again, for sign-in scopes only, doesn't take the rest away.
    provider(() => tokens(ana))
    await through(browser(), 'google')
    const [user] = await directory(Auth.use((a) => a.listUsers))
    expect(user?.accounts[0]?.scopes).toEqual([...GOOGLE_SCOPE.split(' '), ...scopes])
  })

  test("an account with another address, or someone else's, can't be added", async () => {
    const noise = spyOn(console, 'error').mockImplementation(() => {})
    const add = { path: '/link-social', body: { errorCallbackURL: '/sign-in?for=account' } }
    const bo = await signIn('bo@acme.test')
    provider(() => tokens(ana))

    expect(goesTo((await through(bo, 'google', add)).back)).toBe(
      '/sign-in?for=account&error=email_does_not_match',
    )

    // Nobody who isn't signed in can add one at all.
    expect((await through(browser(), 'google', add)).started.status).toBe(401)
    expect(await db.find(AuthAccount)).toEqual([])
    noise.mockRestore()
  })
})

describe('signing in with Microsoft', () => {
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47'
  const bo = { oid: 'm-bo', sub: 's', tid: TENANT, email: 'bo@acme.test', name: 'Bo Berg' }

  const attempt = async (claims: Record<string, unknown>) => {
    const requests = provider(() => tokens(claims))
    const person = browser()
    const { back, url } = await through(person, 'microsoft')
    return { where: goesTo(back), session: await person.session(), requests, url }
  }

  let noise: ReturnType<typeof spyOn>

  beforeEach(() => {
    noise = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => noise.mockRestore())

  test('open to any organization, an address counts only when Microsoft says who owns it', async () => {
    withProviders()

    for (const claims of [
      bo,
      { ...bo, xms_edov: false },
      { ...bo, email_verified: true },
      { ...bo, email: undefined },
    ]) {
      expect(await attempt(claims)).toMatchObject({
        where: '/sign-in?error=email_not_found',
        session: null,
      })
    }

    expect(await db.find(AuthUser)).toEqual([])
    const owned = await attempt({ ...bo, xms_edov: true })
    expect(owned.where).toBe('/')
    expect(owned.url?.pathname).toBe('/common/oauth2/v2.0/authorize')

    expect((await db.find(AuthUser))[0]).toMatchObject({
      email: 'bo@acme.test',
      emailVerified: true,
      name: 'Bo Berg',
    })
  })

  test('with one organization set, its own word about its people is taken', async () => {
    withProviders(TENANT)
    const signedIn = await attempt(bo)
    expect(signedIn.where).toBe('/')
    expect(signedIn.session).not.toBeNull()

    expect(signedIn.requests.map((r) => r.url)).toEqual([
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    ])
  })

  test("but not another organization's", async () => {
    withProviders(TENANT)
    const other = { ...bo, tid: '11111111-2222-3333-4444-555555555555' }

    expect(await attempt(other)).toMatchObject({
      where: '/sign-in?error=email_not_found',
      session: null,
    })
  })

  test('the access list still decides', async () => {
    withProviders(TENANT)
    const { where, session } = await attempt({ ...bo, email: 'bo@elsewhere.test' })
    expect(where).toStartWith('/sign-in?error=not_allowed')
    expect(session).toBeNull()
  })

  test('which claims vouch for an address', () => {
    const email = 'bo@acme.test'

    expect(microsoftVouches({ email, verified_primary_email: ['BO@acme.test'] }, 'common')).toBe(
      true,
    )

    expect(microsoftVouches({ email, verified_secondary_email: [email] }, 'organizations')).toBe(
      true,
    )

    expect(microsoftVouches({ email, verified_primary_email: ['xbo@acme.test'] }, 'common')).toBe(
      false,
    )

    // A text that contains it is not a list that has it.
    expect(microsoftVouches({ email, verified_primary_email: 'xbo@acme.test' }, 'common')).toBe(
      false,
    )

    expect(microsoftVouches({ email, xms_edov: '1' }, 'consumers')).toBe(true)
    expect(microsoftVouches({ email, xms_edov: '0' }, 'Common')).toBe(false)
    expect(microsoftVouches({ xms_edov: true }, 'common')).toBe(false)
    // An organization may be named by its domain. Microsoft signs in its people only, so there is no id to compare.
    expect(microsoftVouches({ email, tid: TENANT }, 'acme.test')).toBe(true)
    expect(microsoftVouches({ email, tid: TENANT }, TENANT.toUpperCase())).toBe(true)
    expect(microsoftVouches({ email }, TENANT)).toBe(false)
  })
})

describe('who may have an account', () => {
  test('is checked in one place, whatever way they come', () => {
    expect(() => admit({ email: 'ana@acme.test', emailVerified: true })).not.toThrow()

    expect(() => admit({ email: 'ana@elsewhere.test', emailVerified: true })).toThrow(
      'may not use this CRM',
    )

    expect(() => admit({ email: 'ana@acme.test', emailVerified: false })).toThrow(
      "hasn't been verified",
    )

    // Unverified, the answer says nothing about the list.
    expect(() => admit({ email: 'ana@elsewhere.test', emailVerified: false })).toThrow(
      "hasn't been verified",
    )
  })
})

// ── What is answered ────────────────────────────────────────────────────────

describe('what is answered under /api/auth', () => {
  const methods = async () => {
    const response = await browser().send('/methods')
    expect(response.headers.get('cache-control')).toBe('no-store')
    return response.json()
  }

  test('which ways of signing in there are', async () => {
    expect(await methods()).toEqual({ link: true, google: false, microsoft: false })
    setEnv({ GOOGLE_CLIENT_ID: 'id' })
    expect(await methods()).toEqual({ link: true, google: false, microsoft: false })
    withProviders()
    expect(await methods()).toEqual({ link: true, google: true, microsoft: true })
  })

  test("a way that isn't set up can't be used", async () => {
    const noise = spyOn(console, 'error').mockImplementation(() => {})

    const response = await browser().send('/sign-in/social', {
      provider: 'google',
      callbackURL: '/',
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'PROVIDER_NOT_FOUND' })

    // One this adapter doesn't offer, whatever the environment holds.
    expect(
      (await browser().send('/sign-in/social', { provider: 'github', callbackURL: '/' })).status,
    ).toBe(404)

    noise.mockRestore()
  })

  test("nothing this adapter doesn't offer, signed in or not", async () => {
    const person = await signIn('ana@acme.test')

    const get =
      '/get-session /list-sessions /account-info /ok /error /verify-email /delete-user/callback /'

    const post = `/get-session /get-access-token /refresh-token /sign-up/email /sign-in/email /request-password-reset
      /reset-password /change-password /change-email /update-user /update-session /delete-user /unlink-account
      /revoke-sessions /send-verification-email /magic-link/verify /callback/google`

    const paths = (list: string) => list.split(/\s+/)

    for (const path of paths(get)) {
      expect([path, (await person.send(path)).status]).toEqual([path, 404])
    }

    for (const path of ['', ...paths(post)]) {
      expect([path, (await person.send(path, {})).status]).toEqual([path, 404])
    }

    expect((await person.send('/sign-out/')).status).toBe(404)
    expect(await person.session()).not.toBeNull()
  })
})

// ── The directory ───────────────────────────────────────────────────────────

describe('the directory', () => {
  test('lists people oldest first, with their accounts and what each has granted', async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 0, n))

    const person = (name: string, n: number, emailVerified = true) =>
      db.insert(AuthUser, { name, email: `${name}@acme.test`, emailVerified, createdAt: at(n) })

    const late = await person('late', 3)
    const early = await person('early', 1)
    const unproven = await person('unproven', 2, false)

    await db.insert(AuthAccount, {
      userId: early.id,
      providerId: 'microsoft',
      accountId: 'm',
      email: 'early@acme.test',
      scope: 'openid,Mail.Read, Calendars.Read',
      createdAt: at(2),
    })

    await db.insert(AuthAccount, {
      userId: early.id,
      providerId: 'google',
      accountId: 'g',
      createdAt: at(1),
    })

    expect(await directory(Auth.use((a) => a.listUsers))).toEqual([
      {
        id: early.id,
        name: 'early',
        email: 'early@acme.test',
        accounts: [
          { provider: 'google', email: '', scopes: [] },
          {
            provider: 'microsoft',
            email: 'early@acme.test',
            scopes: ['openid', 'Mail.Read', 'Calendars.Read'],
          },
        ],
      },
      { id: unproven.id, name: 'unproven', email: null, accounts: [] },
      { id: late.id, name: 'late', email: 'late@acme.test', accounts: [] },
    ])
  })

  test('stops at two hundred', async () => {
    await client.exec(
      `INSERT INTO auth_users (id, name, email, created_at, updated_at)
       SELECT 'u' || lpad(n::text, 3, '0'), '', n || '@acme.test', now(), now() FROM generate_series(1, 205) n`,
    )

    const everyone = await directory(Auth.use((a) => a.listUsers))
    expect([everyone.length, everyone[0]?.id, everyone.at(-1)?.id]).toEqual([200, 'u001', 'u200'])
  })

  test("an address that isn't verified never reaches the CRM, though it is on the list", async () => {
    const user = await db.insert(AuthUser, {
      name: 'Mallory',
      email: 'boss@acme.test',
      emailVerified: false,
    })

    expect((await directory(Auth.use((a) => a.getUser(user.id)))).email).toBeNull()
    expect(await run(Users.use((u) => u.crmUser(user.id)))).toBeNull()

    expect(
      toPerson({ id: '1', name: '', email: 'boss@acme.test', emailVerified: false }, []),
    ).toEqual({
      id: '1',
      name: null,
      email: null,
      accounts: [],
    })
  })

  test("someone who isn't there is an answer; a database that fails is a bad moment", async () => {
    expect(await failure(Auth.use((a) => a.getUser('nobody')))).toMatchObject({
      _tag: 'AuthError',
      kind: 'answer',
    })

    const down = Effect.fail(new DatabaseError({ cause: new Error('The database is down') }))

    const broken = makeStore({
      find: () => down,
      count: () => down,
      countValues: () => down,
      insert: () => down,
      update: () => down,
      remove: () => down,
      refreshDates: () => down,
      lock: () => down,
      transaction: (program) => program,
      ping: down,
    })

    const rt = testRuntime(
      adapter.layer.pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(Store, Store.of(broken)), httpLayer())),
      ),
    )

    for (const program of [
      Auth.use((a) => a.getUser('x')).pipe(Effect.asVoid),
      Auth.use((a) => a.listUsers).pipe(Effect.asVoid),
      Auth.use((a) => a.accountToken('x', 'google')).pipe(Effect.asVoid),
    ]) {
      expect(await rt.runPromise(Effect.flip(program))).toMatchObject({
        kind: 'unavailable',
        message: 'The database is down',
      })
    }

    await rt.dispose()
  })
})

describe("a token for someone's account", () => {
  const token = (userId: string, id = 'google') => Auth.use((a) => a.accountToken(userId, id))
  let userId = ''

  beforeEach(async () => {
    withProviders('72f988bf-86f1-41af-91ab-2d7cd011db47')
    provider(() => tokens(ana))
    const person = browser()
    await through(person, 'google')
    userId = (await person.session())!.userId
  })

  const runOut = () =>
    db.update(
      AuthAccount,
      { where: { userId } },
      { accessTokenExpiresAt: new Date(Date.now() - 1000) },
    )

  test('is null when they have no account there, and the one there is while it lasts', async () => {
    expect(await directory(token(userId))).toBe('access-1')
    expect(await directory(token(userId, 'microsoft'))).toBeNull()
    expect(await directory(token('nobody'))).toBeNull()
    expect(await directory(token(userId, 'credential'))).toBeNull()
  })

  test('is renewed when it has run out, and the new one is kept, encrypted', async () => {
    await runOut()
    const requests = provider(() => Response.json({ access_token: 'access-2', expires_in: 3600 }))
    expect(await directory(token(userId))).toBe('access-2')
    expect(requests.length).toBe(1)

    expect(Object.fromEntries(requests[0]?.body ?? [])).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'google-id',
    })

    expect(await directory(token(userId))).toBe('access-2')
    expect(requests.length).toBe(1)

    expect(JSON.stringify((await client.query('SELECT * FROM auth_accounts')).rows)).not.toContain(
      'access-2',
    )
  })

  test('from Microsoft, is renewed with everything that was granted', async () => {
    provider(() =>
      tokens({
        oid: 'm',
        sub: 's',
        tid: '72f988bf-86f1-41af-91ab-2d7cd011db47',
        email: 'ana@acme.test',
        name: 'Ana',
      }),
    )

    await through(browser(), 'microsoft')
    await runOut()

    const requests = provider(() =>
      Response.json({ access_token: 'access-3', refresh_token: 'r2', expires_in: 60 }),
    )

    expect(await directory(token(userId, 'microsoft'))).toBe('access-3')

    expect(requests[0]?.url).toContain(
      'login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/',
    )

    expect(requests[0]?.body.has('scope')).toBe(false)
  })

  test("that the provider won't renew is this account's to fix", async () => {
    await runOut()
    const requests = provider(() => Response.json({ error: 'invalid_grant' }, { status: 400 }))
    const refused = await failure(token(userId))
    expect(refused).toMatchObject({ _tag: 'AuthError', kind: 'account' })
    expect(refused.message).toContain('Google account has run out')
    // It said no, and would again.
    expect(requests.length).toBe(1)
  })

  test("refused because of this CRM's own client id or secret is the deployment's to fix", async () => {
    await runOut()
    provider(() => Response.json({ error: 'invalid_client' }, { status: 401 }))
    const refused = await failure(token(userId))
    expect(refused).toMatchObject({ kind: 'setup' })
    expect(refused.message).toContain('client id and secret')
  })

  test('from a provider having a bad moment is asked for again', async () => {
    await runOut()
    let calls = 0

    provider(() => {
      calls++
      return calls === 1
        ? Response.json({}, { status: 503 })
        : Response.json({ access_token: 'access-2', expires_in: 3600 })
    })

    expect(await directory(token(userId))).toBe('access-2')

    provider(() => {
      throw new TypeError('Unable to connect')
    })

    await runOut()
    expect(await failure(token(userId))).toMatchObject({ kind: 'unavailable' })
  })

  test("that has run out with nothing to renew it is the account's to fix, not handed out", async () => {
    await runOut()
    await db.update(AuthAccount, { where: { userId } }, { refreshToken: null })
    expect(await failure(token(userId))).toMatchObject({ kind: 'account' })
  })

  test("encrypted with a secret that has changed is the account's to fix", async () => {
    process.env['BETTER_AUTH_SECRET'] = 'another-secret-another-secret-another-1'
    expect(await failure(token(userId))).toMatchObject({ kind: 'account' })
  })

  test('for a provider that is no longer set up says so', async () => {
    setEnv({ GOOGLE_CLIENT_SECRET: undefined })
    const error = await failure(token(userId))
    expect(error).toMatchObject({ kind: 'setup' })
    expect(error.message).toContain('Google is no longer set up')
  })

  test('the reasons there may be none', () => {
    expect(tokenRefusal('google')).toMatchObject({ kind: 'account' })
    expect(tokenRefusal('microsoft', { cause: { status: 400 } })).toMatchObject({ kind: 'account' })

    for (const error of ['invalid_client', 'unauthorized_client']) {
      expect(tokenRefusal('google', { cause: { status: 401, error } })).toMatchObject({
        kind: 'setup',
      })
    }

    for (const cause of [{ status: 429 }, { status: 500 }, new TypeError('no route'), undefined]) {
      expect(tokenRefusal('microsoft', { cause }).kind).toBe('unavailable')
    }

    expect(tokenRefusal('microsoft').message).toContain('Microsoft account')
  })
})

// ── What must be set ────────────────────────────────────────────────────────

describe('what must be set', () => {
  const problems = (env: Record<string, string>) =>
    environmentProblems(betterAuth().requires ?? [], env)

  test("in production, a long secret and the app's address", () => {
    process.env['NODE_ENV'] = 'production'
    expect(problems({})).toEqual(['BETTER_AUTH_SECRET is not set', 'APP_URL is not set'])

    expect(problems({ BETTER_AUTH_SECRET: 'short', APP_URL: 'crm.example.com' })).toEqual([
      'BETTER_AUTH_SECRET must be at least 32 characters',
      "APP_URL must be the app's address, like https://crm.example.com",
    ])

    expect(problems({ BETTER_AUTH_SECRET: 'x'.repeat(32), APP_URL: 'ftp://x' }).length).toBe(1)

    expect(
      problems({ BETTER_AUTH_SECRET: 'x'.repeat(32), APP_URL: 'https://crm.example.com' }),
    ).toEqual([])
  })

  test('in production nothing is answered without them, and nothing is made up', async () => {
    process.env['NODE_ENV'] = 'production'
    const request = () => new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, { method: 'POST' })
    setEnv({ BETTER_AUTH_SECRET: undefined })
    await expect(betterAuth().handle?.(request())).rejects.toThrow('BETTER_AUTH_SECRET is not set')
    await expect(betterAuth().session(request())).rejects.toThrow('BETTER_AUTH_SECRET is not set')
    setEnv({ BETTER_AUTH_SECRET: 'short' })
    await expect(betterAuth().session(request())).rejects.toThrow('at least 32 characters')
    setEnv({ BETTER_AUTH_SECRET: 'x'.repeat(40), APP_URL: undefined })
    await expect(betterAuth().session(request())).rejects.toThrow('APP_URL is not set')
  })

  test('a build, which has none of them, can still be made', () => {
    setEnv({ NODE_ENV: 'production', BETTER_AUTH_SECRET: undefined, APP_URL: undefined })
    expect(() => betterAuth()).not.toThrow()
  })

  test("in development both have a stand-in, and the log says sessions won't last", async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {})
    Reflect.deleteProperty(globalThis, Symbol.for('spools.better-auth.secret'))
    setEnv({ BETTER_AUTH_SECRET: undefined, APP_URL: undefined })
    const development = betterAuth({ answerAfter: 20 })
    expect(development.requires).toEqual([])
    const person = browser(development)
    const from = { origin: 'http://localhost:3000' }

    expect(
      (await person.send('/sign-in/magic-link', { email: 'ana@acme.test' }, from)).status,
    ).toBe(200)

    await open(person, tokenIn((await emails(1))[0]))
    expect(await person.session()).not.toBeNull()

    // One secret for the whole process: another copy of the adapter knows the session too.
    expect(
      await betterAuth().session(
        new Request(ORIGIN, { headers: { cookie: cookieHeader(person.cookies) } }),
      ),
    ).toEqual(expect.objectContaining({ userId: (await person.session())?.userId }))

    const said = info.mock.calls
      .flat()
      .filter((line) => String(line).includes('BETTER_AUTH_SECRET'))

    info.mockRestore()
    expect(said.length).toBe(1)
    expect(String(said[0])).toContain('signed out when the server restarts')
  })

  test('something set wrongly is said in development too', () => {
    setEnv({ BETTER_AUTH_SECRET: 'short', APP_URL: 'nonsense' })
    expect(problems({ BETTER_AUTH_SECRET: 'short', APP_URL: 'nonsense' }).length).toBe(2)
  })

  test('what the ways of signing in need, for the boot report', () => {
    expect(adapter.features?.map((f) => f.name)).toEqual([
      'Sign in with Google',
      'Sign in with Microsoft',
    ])
  })
})

// ── The browser half ────────────────────────────────────────────────────────

describe('the browser half', () => {
  test("is the same provider's", () => {
    expect(betterAuthClient.id).toBe(adapter.id)
  })

  test("the first page drawn is the plain form, which can't be sent before the page is running", () => {
    const html = renderToString(
      createElement(betterAuthClient.SignIn, { path: '/sign-in', redirectTo: '/' }),
    )

    expect(html).toContain('<label for="sign-in-email"')
    expect(html).toContain('Email me a link')
    expect(html).toMatch(/<button type="submit" disabled=""/)
    expect(html).not.toContain('Continue with')
  })

  test('what went wrong is said in words, also for something new', () => {
    for (const code of [
      'INVALID_TOKEN',
      'not_allowed',
      'email_not_verified',
      'account_not_linked',
      'state_mismatch',
    ]) {
      expect(explain(code)).not.toBe(explain('a_code_from_the_future'))
      expect(explain(code)).not.toContain('_')
    }

    expect(explain('<script>')).toBe('Something went wrong. Try again.')
  })
})
