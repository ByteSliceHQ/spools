import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The lint rules that keep server code on Effect (.oxlintrc.json, packages/spools/src/oxlint).
// Each probe below is code written the old way, linted with this repository's own
// rules in a scratch folder, so they are shown to fire, not assumed to.

const root = join(import.meta.dir, '../../../..')
const oxlint = join(root, 'node_modules/.bin/oxlint')

type Rules = Record<string, unknown>
type Override = { files: string[]; excludeFiles?: string[]; rules: Rules }

const config: { rules: Rules; overrides: Override[] } = JSON.parse(
  readFileSync(join(root, '.oxlintrc.json'), 'utf8'),
)

/** Only the rules about how Spools is put together: the rest need types, or aren't being tested. */
const ours = (rules: Rules): Rules =>
  Object.fromEntries(
    Object.entries(rules).filter(
      ([name]) => name.startsWith('spools/') || name.startsWith('no-restricted-'),
    ),
  )

const probes: Record<string, string> = {
  // A new server module written with promises, throw, fetch, process.env and the raw client.
  'packages/spools/src/server/new-module.ts': `
    import postgres from '@prisma/orm-postgres/runtime'
    import { Resend } from 'resend'
    export async function load(id: string) {
      const res = await fetch('https://example.com/' + id + process.env['KEY'])
      if (!res.ok) throw new Error('nope')
      return [postgres, Resend]
    }`,
  // A server module that reaches for an adapter, the app, or the request.
  'packages/spools/src/server/reaching.ts': `
    import { getRequest } from '@tanstack/react-start/server'
    import { clerk } from '../adapters/auth/clerk/server'
    import spool from '../../../../apps/starter/src/spool.server'
    export const used = [getRequest, clerk, spool]`,
  // A new server function whose handler skips the boundary.
  'packages/spools/src/server/new.functions.ts': `
    import { createServerFn } from '@tanstack/react-start'
    export const newFn = createServerFn({ method: 'GET' }).handler(async () => ({ ok: true }))`,
  // A functions file that also exports something else: it would be bundled for the browser.
  'packages/spools/src/server/mixed.functions.ts': `
    import { createServerFn } from '@tanstack/react-start'
    import { crmHandler } from './runtime/boundary'
    export type Fine = string
    export const okFn = createServerFn({ method: 'GET' }).handler(crmHandler('ok', () => okEffect))
    export const helper = () => 1
    export function another() {}`,
  // A handler of the framework's without a route adapter.
  'packages/spools/src/api/new.ts': `
    import { apiRoute } from '../server/runtime/boundary'
    export const newHandlers = { GET: apiRoute('new', () => ok), POST: async () => new Response('ok') }`,
  // The same in an app's route.
  'apps/starter/src/routes/api/new.ts': `
    import { createFileRoute } from '@tanstack/react-router'
    export const Route = createFileRoute('/api/new')({
      server: { handlers: { GET: async () => new Response('ok') } },
    })`,
  // Server functions that skip the boundary without looking like it: another name for
  // createServerFn, a namespace, a builder kept in a const, and a function of the file's own
  // that only has the boundary's name.
  'apps/starter/src/app/sly.functions.ts': `
    import { createServerFn as make } from '@tanstack/react-start'
    import * as start from '@tanstack/react-start'
    import { createServerFn } from '@tanstack/react-start'
    const crmHandler = (name, program) => program
    const builder = createServerFn({ method: 'GET' })
    export const one = make({ method: 'GET' }).handler(async () => 1)
    export const two = start.createServerFn().handler(async () => 2)
    export const three = builder.handler(async () => 3)
    export const four = createServerFn().handler(crmHandler('four', async () => 4))`,
  // The boundary under another name is still the boundary.
  'apps/starter/src/app/renamed.functions.ts': `
    import { createServerFn } from '@tanstack/react-start'
    import { crmHandler as staff } from '@swirls/spools/handlers'
    export const fine = createServerFn().handler(staff('fine', () => program))`,
  // Route handlers the rule has to follow to see: a const in the file, handlers from a
  // module of the app's own, a function that makes them, and a route outside /api.
  'apps/starter/src/routes/api/sly.ts': `
    import { createFileRoute } from '@tanstack/react-router'
    const open = { GET: async () => new Response('ok') }
    export const Route = createFileRoute('/api/sly')({ server: { handlers: open } })`,
  'apps/starter/src/routes/api/borrowed.ts': `
    import { createFileRoute } from '@tanstack/react-router'
    import { openHandlers } from '../../app/open'
    export const Route = createFileRoute('/api/borrowed')({ server: { handlers: openHandlers } })`,
  'apps/starter/src/routes/api/made.ts': `
    import { createFileRoute } from '@tanstack/react-router'
    export const Route = createFileRoute('/api/made')({
      server: { handlers: ({ createHandlers }) => createHandlers({ GET: async () => new Response('ok') }) },
    })`,
  'apps/starter/src/routes/export.csv.ts': `
    import { createFileRoute } from '@tanstack/react-router'
    const apiRoute = (name, program) => program
    export const Route = createFileRoute('/export.csv')({
      server: { handlers: { GET: apiRoute('export', async () => new Response('a,b')) } },
    })`,
  // The ways a route's handlers are meant to be written.
  'apps/starter/src/routes/api/fine.ts': `
    import { createFileRoute } from '@tanstack/react-router'
    import { fileHandlers } from '@swirls/spools/api/file'
    import { apiRoute, publicRoute as open } from '@swirls/spools/handlers'
    const ping = open('ping', () => program)
    const mine = { PUT: apiRoute('put', () => program) }
    export const Route = createFileRoute('/api/fine')({
      server: { handlers: { ...fileHandlers, ...mine, POST: ping, DELETE: apiRoute('del', () => program) } },
    })`,
  'apps/starter/src/routes/fine.tsx': `
    import { createFileRoute } from '@tanstack/react-router'
    import { unsubscribeHandlers } from '@swirls/spools/api/unsubscribe'
    export const Route = createFileRoute('/fine')({ server: { handlers: unsubscribeHandlers } })`,
  // An app's hook importing a framework module (Effects) instead of the promise API.
  'apps/starter/src/app/new-hook.ts': `
    import { listRecords } from '@swirls/spools/extensions'
    import { getRecord } from '@swirls/spools/server/records'
    export const used = [getRecord, listRecords]`,
  // Browser code importing Effect, and an adapter.
  'packages/spools/src/crm/ui/new-thing.ts': `
    import { Effect } from 'effect'
    import { postgres } from '../../adapters/database/postgres/server'
    export const one = [Effect.succeed(1), postgres]`,
  // The same as the first probe, in a file that stays plain TypeScript by design (pure query building).
  'packages/spools/src/server/store/sql.ts': `
    export async function load() {
      throw new Error()
    }`,
  // Something else's .handler(...), which is none of these rules' business.
  'packages/spools/src/adapters/auth/new/server.ts': `
    export const answer = (auth, request) => auth.handler(request)`,
  // Written the Effect way: nothing to report.
  'packages/spools/src/server/good.ts': `
    import { Effect } from 'effect'
    import { Invalid } from './runtime/errors'
    import { Store } from './store/store'
    import { SavedView } from './store/tables'
    export const load = Effect.fn('good.load')(function* (id: string) {
      if (!id) return yield* new Invalid({ message: 'No id' })
      const store = yield* Store
      return yield* store.first(SavedView, { where: { id } })
    })`,
}

let scratch = ''
let found: { filename: string; code: string; message: string; help?: string }[] = []

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'spools-guardrails-'))

  writeFileSync(
    join(scratch, '.oxlintrc.json'),
    JSON.stringify({
      categories: { correctness: 'off' },
      jsPlugins: [{ name: 'spools', specifier: join(root, 'packages/spools/src/oxlint/index.ts') }],
      rules: ours(config.rules),
      overrides: config.overrides.map((override) => ({
        ...override,
        rules: ours(override.rules),
      })),
    }),
  )

  for (const [path, source] of Object.entries(probes)) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true })
    writeFileSync(join(scratch, path), `${source}\n`)
  }

  const out = Bun.spawnSync([oxlint, '--format=json', '.'], { cwd: scratch })
  found = JSON.parse(out.stdout.toString()).diagnostics
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** What was said about a probe, whichever part of the report it is in. */
const at = (path: string) =>
  found
    .filter((diagnostic) => diagnostic.filename === path)
    .map(({ code, message, help }) => `${code} ${message} ${help ?? ''}`)

const saysAll = (path: string, ...expected: string[]) => {
  const said = at(path)

  for (const text of expected) {
    expect(said).toContainEqual(expect.stringContaining(text))
  }

  expect(said).toHaveLength(expected.length)
}

describe('server code written the old way fails the lint', () => {
  test('a new module: promises, throw, fetch, process.env, the raw client, a vendor SDK', () => {
    saysAll(
      'packages/spools/src/server/new-module.ts',
      'not async functions',
      'not `throw`',
      'Store service',
      "a vendor's SDK",
      'through Config',
      'policies.ts',
    )
  })

  test('a module that reaches for an adapter, the app or the request', () => {
    saysAll(
      'packages/spools/src/server/reaching.ts',
      'never imports an adapter',
      'never imports the app',
      'belongs to the boundary',
    )
  })

  test('a server function that skips the boundary', () => {
    saysAll('packages/spools/src/server/new.functions.ts', 'crmHandler(...) or publicHandler(...)')
  })

  test('a functions file that exports anything but server functions', () => {
    saysAll(
      'packages/spools/src/server/mixed.functions.ts',
      'exports only server functions',
      'exports only server functions',
    )
  })

  test('an API route without an adapter, in the framework and in an app', () => {
    saysAll('packages/spools/src/api/new.ts', 'route adapters')
    saysAll('apps/starter/src/routes/api/new.ts', 'route adapters')
  })

  test('a server function that skips the boundary under another name', () => {
    saysAll(
      'apps/starter/src/app/sly.functions.ts',
      'crmHandler(...) or publicHandler(...)',
      'crmHandler(...) or publicHandler(...)',
      'crmHandler(...) or publicHandler(...)',
      'crmHandler(...) or publicHandler(...)',
    )
  })

  test("route handlers that can't be shown to check who is calling", () => {
    saysAll('apps/starter/src/routes/api/sly.ts', 'route adapters')
    saysAll('apps/starter/src/routes/api/borrowed.ts', "in the route's own file")
    saysAll('apps/starter/src/routes/api/made.ts', "in the route's own file")
    saysAll('apps/starter/src/routes/export.csv.ts', 'route adapters')
  })

  test("an app's code importing a framework module instead of the promise API", () => {
    saysAll('apps/starter/src/app/new-hook.ts', '@swirls/spools/extensions')
  })

  test('browser code importing Effect or an adapter', () => {
    saysAll(
      'packages/spools/src/crm/ui/new-thing.ts',
      'server-only',
      'Pages never import an adapter',
    )
  })
})

describe('what passes', () => {
  test('a module written with Effect', () => {
    saysAll('packages/spools/src/server/good.ts')
  })

  test('files left out on purpose (plumbing, pure helpers)', () => {
    saysAll('packages/spools/src/server/store/sql.ts')
  })

  test('the boundary under another name', () => {
    saysAll('apps/starter/src/app/renamed.functions.ts')
  })

  test("a route's handlers: the framework's, the file's own, and the two together", () => {
    saysAll('apps/starter/src/routes/api/fine.ts')
    saysAll('apps/starter/src/routes/fine.tsx')
  })

  test('a .handler(...) that is not a server function', () => {
    saysAll('packages/spools/src/adapters/auth/new/server.ts')
  })
})

test('every file left out of the rules still exists (remove an entry when its file is gone)', () => {
  const listed = config.overrides
    .flatMap((override) => override.excludeFiles ?? [])
    .filter((path) => !path.includes('*'))

  expect(listed.length).toBeGreaterThan(0)
  expect(listed.filter((path) => !existsSync(join(root, path)))).toEqual([])
})
