import { afterAll, beforeAll, test } from 'bun:test'

import { PGlite } from '@electric-sql/pglite'
import type { Effect } from 'effect'

import { pglite } from '../../src/adapters/database/pglite/server'
import { postgres } from '../../src/adapters/database/postgres/server'
import { prisma } from '../../src/adapters/database/prisma/server'
import { flashdrive } from '../../src/adapters/files/flashdrive/server'
import { crmConfigSchema } from '../../src/crm/config-schema'
import { defineExtensions } from '../../src/crm/extensions'
import type { ScopeGrant, ScopeInfo } from '../../src/crm/scopes'
import * as api from '../../src/server/extension-api'
import * as records from '../../src/server/records'
import { type AppServices, disposeRuntime } from '../../src/server/runtime/app'
import { Auth, type AuthAdapter, type AuthUser } from '../../src/server/runtime/auth'
import { Email, type OutboundEmail } from '../../src/server/runtime/email'
import { asSystem, asUser, Scopes } from '../../src/server/scopes'
import { defineSpool, type Spool, spool } from '../../src/server/spool'
import { allTables } from '../../src/server/store/schema-sql'
import type { StoreAdapter } from '../../src/server/store/store'
import type { CrmUser } from '../../src/server/users'
import * as workspace from '../../src/server/workspace'
import { createFakeStore } from '../../src/testing/fake-file-store'
import { installStandIns, run } from '../../src/testing/run'
import fixture from '../fixtures/scoped.config.json' with { type: 'json' }
import contract from '../fixtures/scoped/prisma/schema.json' with { type: 'json' }
import { prepareScopedDatabase } from '../support/scoped-database'

/**
 * A Spool with record scopes, for the tests in scopes-*.test.ts: a business
 * with two branches, North and South, on a database of its own, so nothing here
 * touches the Spool the other integration tests use. The database is on the
 * store TEST_STORE names, as theirs is (tests/support/preload.ts): PGlite in
 * this process, or a Postgres beside the one at DATABASE_URL, through Effect SQL
 * or Prisma (tests/support/scoped-database.ts).
 *
 *   Nora   holds North, and may write
 *   Ned    holds North, read-only
 *   Sam    holds South, and may write
 *   Bo     holds both, and may write in both
 *   Hana   head office: every branch
 *   Otto   on the access list, and holds nothing
 *
 * Companies, contacts and deals belong to a branch; products, kits and regions
 * are shared. A depot belongs to a region: its scope field is a relation, so
 * its scope is a region's id, which a test grants as it makes one. Every
 * North record has "Alder" in its name and every South one "Birch", so a leak
 * is a South word in something a North person was given (`southIn`).
 *
 * Two records cross on purpose, as data that was there before scopes were
 * turned on could: Nell Crossing is a North contact whose company is a South
 * one, and "Birch rebate" is a South deal on a North contact.
 */

const person = (id: string, name: string): CrmUser => ({
  id,
  name,
  email: `${id.replace('user_', '')}@example.com`,
})

export const people = {
  nora: person('user_nora', 'Nora North'),
  ned: person('user_ned', 'Ned Northview'),
  sam: person('user_sam', 'Sam South'),
  bo: person('user_bo', 'Bo Both'),
  hana: person('user_hana', 'Hana Office'),
  otto: person('user_otto', 'Otto Outside'),
} as const

export type Who = keyof typeof people

export const grants: Record<string, ScopeGrant[]> = {
  user_nora: [{ scope: 'north', role: 'member' }],
  user_ned: [{ scope: 'north', role: 'viewer' }],
  user_sam: [{ scope: 'south', role: 'member' }],
  user_bo: [
    { scope: 'north', role: 'member' },
    { scope: 'south', role: 'member' },
  ],
  user_hana: [{ scope: '*', role: 'headOffice' }],
  user_otto: [],
}

export const branches: ScopeInfo[] = [
  { key: 'north', label: 'North' },
  { key: 'south', label: 'South' },
]

const authUsers: AuthUser[] = Object.values(people).map((p) => ({
  id: p.id,
  name: p.name,
  email: p.email,
  accounts: [],
}))

const directory = Auth.layerTest(authUsers)

/** The header a test request carries the signed-in person's id in. */
export const SIGNED_IN_AS = 'x-test-user'

/** A request to the server from one of the people above (or from nobody), with the scope cookie if given. */
export const requestFrom = (who: Who | null, path: string, scopeCookie?: string): Request => {
  const headers = new Headers()

  if (who) {
    headers.set(SIGNED_IN_AS, people[who].id)
  }

  if (scopeCookie !== undefined) {
    headers.set('cookie', `theme=dark; spools-scope=${scopeCookie}`)
  }

  return new Request(`http://crm.test${path}`, { headers })
}

const auth: AuthAdapter = {
  id: 'test',
  label: 'The test sign-in',
  // A request says who it is from in a header, as a session cookie would.
  session: async (request) => {
    const userId = request.headers.get(SIGNED_IN_AS)
    return userId ? { userId, getToken: async () => null } : null
  },
  layer: directory,
}

/** What the app's own code was handed, and what it could read, each time the framework called it. */
export type Sighting = {
  where: string
  actor: string | null
  /** The names of the contacts the app's code could list through `@swirls/spools/extensions`. */
  contacts: string[]
}

export const sightings: Sighting[] = []

/** Each `before` hook the framework called: the app's code ran, whatever came of the change. */
export const befores: string[] = []

const sight = async (where: string, actor: { id: string } | null) => {
  const contacts = await api.listRecords({ objectKey: 'contacts', limit: 500, relations: 'none' })
  sightings.push({ where, actor: actor?.id ?? null, contacts: contacts.map((c) => String(c.name)) })
}

/** The app's own code. Each piece notes what it could see, as an app's hook that lists records would. */
const extensions = defineExtensions({
  handlers: {
    async probe(ctx) {
      await sight(`handler:${ctx.trigger}`, ctx.actor)
      return { message: 'Looked' }
    },
  },
  runTargets: {
    look: {
      async run(name, ctx) {
        await sight(`target:${name}`, ctx.actor)
        return { message: 'Looked' }
      },
    },
  },
  hooks: {
    beforeCreate({ objectKey, actor }) {
      befores.push(`create ${objectKey} by ${actor?.id ?? 'nobody'}`)
    },
    beforeUpdate({ objectKey, actor }) {
      befores.push(`update ${objectKey} by ${actor?.id ?? 'nobody'}`)
    },
    async afterCreate({ objectKey, actor }) {
      if (objectKey === 'contacts') {
        await sight('afterCreate', actor)
      }
    },
  },
})

/** Emails the sequences sent. */
export const sent: OutboundEmail[] = []

/** The file store, held in memory. */
export const drive = createFakeStore()

/** Ids of the records the tests look for. Filled in when the world is first made. */
export const ids = {
  product: '',
  north: { company: '', annex: '', contact: '', cross: '', deal: '' },
  south: { company: '', depot: '', contact: '', deal: '', rebate: '' },
}

/** Runs a program as the server itself: every branch. For putting records in place and checking what is really there. */
export const sys = <A, E>(program: Effect.Effect<A, E, AppServices>) => run(asSystem(program))

/**
 * Runs a program as one of the people above, working in `wanted`: a branch, or
 * null for every branch they hold. Left out, it is the first branch they hold.
 */
export const as = <A, E>(
  who: Who,
  program: Effect.Effect<A, E, AppServices>,
  wanted?: string | null,
) => run(asUser(people[who], wanted)(program))

/** Runs a program with nobody signed in and nothing said about scopes: a cron route, a schedule, a webhook. */
export const unattended = run

/** Every South word in something, however deep. A North person's answer must hold none. */
export const southIn = (value: unknown): string[] => [
  ...new Set(JSON.stringify(value ?? null).match(/Birch|Sofia|Southport|southsecret/gi)),
]

/** Every North word in something. */
export const northIn = (value: unknown): string[] => [
  ...new Set(JSON.stringify(value ?? null).match(/Alder|Nina|Nell|Northgate|northsecret/gi)),
]

/** The values of one field across rows, sorted, to compare lists by. */
export const column = <Row extends Record<string, unknown>>(rows: readonly Row[], key: keyof Row) =>
  rows.map((r) => String(r[key])).toSorted()

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

async function seed() {
  const make = async (objectKey: string, values: Record<string, unknown>) =>
    (await sys(records.createRecord(objectKey, values, 'seed'))).id

  /**
   * A record that crosses branches. Nothing lets one be made while scopes are
   * on, so it is made as it would have been before they were turned on.
   */
  const makeCrossing = async (objectKey: string, values: Record<string, unknown>) => {
    const config = spool().config
    const { scopes } = config
    config.scopes = undefined

    try {
      return (await run(records.createRecord(objectKey, values, 'seed'))).id
    } finally {
      config.scopes = scopes
    }
  }

  ids.product = await make('products', { name: 'Crate', sku: 'CR-1' })

  ids.north.company = await make('companies', {
    name: 'Alder Works',
    city: 'Northgate',
    branch: 'north',
  })

  ids.north.annex = await make('companies', {
    name: 'Alder Annex',
    city: 'Northgate',
    branch: 'north',
  })

  ids.south.company = await make('companies', {
    name: 'Birch Supply',
    city: 'Southport',
    branch: 'south',
  })

  ids.south.depot = await make('companies', {
    name: 'Birch Depot',
    city: 'Southport',
    branch: 'south',
  })

  ids.north.contact = await make('contacts', {
    name: 'Nina Alder',
    email: 'nina@alder.test',
    companyId: ids.north.company,
    owner: people.nora.id,
    branch: 'north',
  })

  ids.south.contact = await make('contacts', {
    name: 'Sofia Birch',
    email: 'sofia@birch.test',
    companyId: ids.south.company,
    owner: people.sam.id,
    branch: 'south',
  })

  // A North contact whose company is a South one.
  ids.north.cross = await makeCrossing('contacts', {
    name: 'Nell Crossing',
    email: 'nell@alder.test',
    companyId: ids.south.company,
    branch: 'north',
  })

  ids.north.deal = await make('deals', {
    title: 'Alder order',
    value: '1000',
    stage: 'open',
    contactId: ids.north.contact,
    productId: ids.product,
    branch: 'north',
  })

  ids.south.deal = await make('deals', {
    title: 'Birch order',
    value: '5000',
    stage: 'won',
    contactId: ids.south.contact,
    productId: ids.product,
    branch: 'south',
  })

  // A South deal on a North contact.
  ids.south.rebate = await makeCrossing('deals', {
    title: 'Birch rebate',
    value: '9999',
    stage: 'won',
    contactId: ids.north.contact,
    branch: 'south',
  })

  const { nora, sam, bo } = people

  for (const [who, user, contact, word] of [
    ['nora', nora, ids.north.contact, 'Alder'],
    ['sam', sam, ids.south.contact, 'Birch'],
  ] as const) {
    const on = { objectKey: 'contacts', recordId: contact }
    const secret = who === 'nora' ? 'northsecret' : 'southsecret'

    await as(
      who,
      workspace.createTask({ title: `Ring ${word}`, dueDate: yesterday(), ...on }, user.id),
    )

    // One for Bo in each branch, so what Bo is due depends on where Bo is working.
    await as(
      who,
      workspace.createTask(
        { title: `Visit ${word}`, dueDate: yesterday(), assigneeId: bo.id, ...on },
        user.id,
      ),
    )

    await as(
      who,
      workspace.createNote({ title: `${word} pricing`, body: `${secret} terms`, ...on }, user),
    )

    await as(
      who,
      workspace.logActivity(
        { ...on, kind: 'call', outcome: 'connected', notes: `${secret} call` },
        user,
      ),
    )
  }

  await as('bo', workspace.toggleFavorite(bo.id, 'contacts', ids.north.contact), null)
  await as('bo', workspace.toggleFavorite(bo.id, 'contacts', ids.south.contact), null)
}

/** The store the world is on, as the other integration tests read it. */
export const STORE = process.env['TEST_STORE'] ?? 'pglite'

/** Whether two programs can be in the database at once. PGlite has one connection: they take turns. */
export const MANY_CONNECTIONS = STORE !== 'pglite'

let client: PGlite | undefined
/** Where the world's Postgres is, once it has been made ready: the same one for every test file of a run. */
let postgresUrl: string | undefined
let seeded = false

/** The world's own PGlite, for a test that puts a store of its own over it (to watch, or to make fail). */
export const database = (): PGlite => {
  if (!client) {
    throw new Error('The world has not been made on PGlite')
  }

  return client
}

/**
 * The world's database adapter, on the store TEST_STORE names. A Postgres is
 * made ready and emptied the first time, from the environment as the run was
 * given it, and DATABASE_URL then names it for as long as the world stands.
 */
async function worldStore(): Promise<StoreAdapter> {
  if (STORE === 'pglite') {
    client ??= await PGlite.create()
    return pglite({ client })
  }

  if (STORE !== 'postgres' && STORE !== 'prisma') {
    throw new Error(`TEST_STORE is "${STORE}"; use "pglite", "postgres" or "prisma"`)
  }

  postgresUrl ??= await prepareScopedDatabase(
    process.env,
    allTables(crmConfigSchema.parse(fixture)),
  )

  process.env['DATABASE_URL'] = postgresUrl
  return STORE === 'postgres' ? postgres() : prisma({ contract })
}

const ENV = {
  APP_SECRET: 's'.repeat(40),
  APP_URL: 'https://crm.example.com',
  CRON_SECRET: 'c'.repeat(32),
  SWIRLS_APP_TOKEN: 't'.repeat(40),
  FLASHDRIVE_API_KEY: 'test-key',
  FLASHDRIVE_DRIVE_ID: '2f0c1c7e-58a1-4d0e-9a53-0f6c1f8f4b11',
}

/** The bearer token the cron routes expect in this world. */
export const CRON_TOKEN = ENV.CRON_SECRET

/** The bearer token the tool API expects in this world. */
export const TOOL_TOKEN = ENV.SWIRLS_APP_TOKEN

/** The stand-ins for outside services, with any a test replaces. `installWorld()` puts the usual ones back. */
export const installWorld = (replace: Parameters<typeof installStandIns>[0] = {}) =>
  installStandIns({
    auth: directory,
    scopes: Scopes.layerTest(grants, branches),
    email: Email.layerTest(async (email) => {
      sent.push(email)
      return { id: `sent_${sent.length}`, sent: true }
    }),
    fetch: (url, init) => drive.handle(url, init),
    ...replace,
  })

/**
 * Makes the scoped Spool this process's for the tests of one file, and puts
 * back the one the other test files use when they are done.
 */
export function scopedWorld(
  options: {
    /** Another sign-in than the test one, for a test of an auth adapter. */
    auth?: AuthAdapter
    /** Run once the world is made and seeded: a test that wants other stand-ins installs them here. */
    afterSeed?: () => Promise<void>
  } = {},
): void {
  let before: Spool
  const saved = new Map<string, string | undefined>()

  beforeAll(async () => {
    before = spool()

    for (const [name, value] of Object.entries(ENV)) {
      saved.set(name, process.env[name])
      process.env[name] = value
    }

    saved.set('FLASHDRIVE_BASE_URL', process.env['FLASHDRIVE_BASE_URL'])
    delete process.env['FLASHDRIVE_BASE_URL']

    // The world's Postgres is another database than the one the run was given: put back after.
    saved.set('DATABASE_URL', process.env['DATABASE_URL'])

    defineSpool({
      crm: fixture,
      extensions,
      auth: options.auth ?? auth,
      database: await worldStore(),
      files: flashdrive(),
    })

    // The world is always seeded as its own people, whatever sign-in the test is about.
    await installWorld()

    if (!seeded) {
      seeded = true
      await seed()
    }

    await options.afterSeed?.()
  })

  afterAll(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }

    // The other test files in this process go on with the Spool and the services they had.
    defineSpool({ ...before, crm: before.config })
    await disposeRuntime()
  })
}
