import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { z } from 'zod'

// The `spools` command, run the way a person runs it: `bun src/cli/main.ts
// <command>` in an app's folder. Each test gets a folder of its own under the
// system's temporary folder, filled from apps/starter, with no DATABASE_URL and
// no NODE_ENV. Nothing here reaches a database server or the network: the
// proxy variables point at a closed port, so a command that tried would fail.

const REPO = join(import.meta.dir, '../../../..')
const STARTER = join(REPO, 'apps/starter')
const MAIN = join(import.meta.dir, '../../src/cli/main.ts')

const ENV: Record<string, string> = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  NO_COLOR: '1',
}

/** The parts of crm.config.json these tests read and change; everything else passes through. */
const configShape = z.looseObject({
  app: z.looseObject({ name: z.string() }),
  access: z.object({ allowedDomains: z.array(z.string()), allowedEmails: z.array(z.string()) }),
  objects: z.record(
    z.string(),
    z.looseObject({
      views: z.array(z.looseObject({ columns: z.array(z.string()).optional() })),
      actions: z.array(z.looseObject({ id: z.string(), run: z.string() })).optional(),
    }),
  ),
})

type Config = z.infer<typeof configShape>

let scratch = ''
let folders = 0

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spools-cli-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const readConfig = async (folder: string): Promise<Config> =>
  configShape.parse(JSON.parse(await readFile(join(folder, 'crm.config.json'), 'utf8')))

/** An empty folder for one test. */
const emptyFolder = async () => {
  const folder = join(scratch, `app-${++folders}`)
  await mkdir(folder, { recursive: true })
  return folder
}

/** A folder with what `init` reads: the starter's config (changed if asked), .env.example and Supabase config. */
const initFolder = async (change: (config: Config) => void = () => {}) => {
  const folder = await emptyFolder()
  const config = await readConfig(STARTER)
  change(config)
  await writeFile(join(folder, 'crm.config.json'), `${JSON.stringify(config, null, 2)}\n`)
  await cp(join(STARTER, '.env.example'), join(folder, '.env.example'))
  await cp(join(STARTER, 'supabase/config.toml'), join(folder, 'supabase/config.toml'))
  return folder
}

/**
 * A folder with what `gen` and `stats` read as well: the app's Spool
 * (src/spool.server.ts and what it imports) and the packages it is built on.
 */
const appFolder = async (change: (config: Config) => void = () => {}) => {
  const folder = await initFolder(change)

  for (const file of ['src/spool.server.ts', 'src/app/extensions.ts', 'prisma/schema.json']) {
    await mkdir(dirname(join(folder, file)), { recursive: true })
    await cp(join(STARTER, file), join(folder, file))
  }

  await cp(join(STARTER, 'prisma.config.ts'), join(folder, 'prisma.config.ts'))
  await symlink(join(REPO, 'node_modules'), join(folder, 'node_modules'))
  return folder
}

/** Runs `spools <args>` in a folder and returns what it printed and how it exited. */
const spools = async (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd,
    env: { ...ENV, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return { stdout, stderr, exitCode }
}

/** The variables a .env file sets. */
const readEnv = async (folder: string, name = '.env') => {
  const values = new Map<string, string>()

  for (const line of (await readFile(join(folder, name), 'utf8')).split('\n')) {
    const found = /^([A-Z_]+)=(.*)$/.exec(line)

    if (found?.[1] !== undefined && found[2] !== undefined) {
      values.set(found[1], found[2])
    }
  }

  return values
}

const firstObject = (config: Config) => {
  const [key] = Object.keys(config.objects)
  const object = key === undefined ? undefined : config.objects[key]

  if (key === undefined || object === undefined) {
    throw new Error('the starter config has no objects')
  }

  return { key, object }
}

describe('spools', () => {
  test('an unknown command, or none, prints the commands there are and fails', async () => {
    const folder = await emptyFolder()

    for (const args of [['frobnicate'], [], ['constructor']]) {
      const result = await spools(folder, args)
      expect(result.exitCode).toBe(1)

      expect(result.stderr).toContain(
        'Usage: spools <gen | init | stats | harden | scopes | check-client>',
      )

      expect(result.stdout).toBe('')
    }
  })
})

describe('spools init', () => {
  test('names the CRM, sets who is let in, writes .env with fresh secrets and renames the Supabase project', async () => {
    const folder = await initFolder()
    const before = await readConfig(folder)

    const result = await spools(folder, [
      'init',
      '--name',
      'Birch & Co',
      '--domain',
      'birch.test',
      '--yes',
    ])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)

    const after = await readConfig(folder)
    expect(after.app.name).toBe('Birch & Co')
    // The first domain is the one the question is about: the starter's example.com is replaced.
    expect(after.access.allowedDomains[0]).toBe('birch.test')
    expect(after.access.allowedDomains).not.toContain(before.access.allowedDomains[0])
    expect(after.access.allowedEmails).toEqual(before.access.allowedEmails)
    // Nothing else in the config changes.
    expect(after.objects).toEqual(before.objects)

    const env = await readEnv(folder)
    const example = await readEnv(folder, '.env.example')
    expect(env.get('APP_SECRET')).toMatch(/^[0-9a-f]{64}$/)
    expect(env.get('SWIRLS_APP_TOKEN')).toMatch(/^[0-9a-f]{64}$/)
    expect(env.get('APP_SECRET')).not.toBe(env.get('SWIRLS_APP_TOKEN'))

    // Every other line is .env.example's.
    for (const [name, value] of example) {
      if (name !== 'APP_SECRET' && name !== 'SWIRLS_APP_TOKEN') {
        expect(env.get(name)).toBe(value)
      }
    }

    expect([...env.keys()]).toEqual([...example.keys()])

    const toml = await readFile(join(folder, 'supabase/config.toml'), 'utf8')
    expect(toml).toContain('project_id = "birch-co-crm"')
    expect(result.stdout).toContain('✓ crm.config.json: "Birch & Co", access for birch.test')
  })

  test('a name ending in "CRM" loses it, and a domain typed as @Acme.Test is tidied', async () => {
    const folder = await initFolder()
    await spools(folder, ['init', '--name', 'Acme Tools CRM', '--domain', '@Acme.Test', '-y'])
    const config = await readConfig(folder)
    expect(config.app.name).toBe('Acme Tools')
    expect(config.access.allowedDomains[0]).toBe('acme.test')
  })

  test('run again with --yes, nobody on the access list is taken off it and .env keeps its values', async () => {
    const folder = await initFolder((config) => {
      config.access = {
        allowedDomains: ['acme.test', 'partner.test'],
        allowedEmails: ['guest@elsewhere.test'],
      }
    })

    const access = {
      allowedDomains: ['acme.test', 'partner.test'],
      allowedEmails: ['guest@elsewhere.test'],
    }

    const first = await spools(folder, ['init', '--yes'])
    expect(first.exitCode).toBe(0)
    expect((await readConfig(folder)).access).toEqual(access)

    // A value somebody set by hand since.
    const envFile = join(folder, '.env')

    const written = (await readFile(envFile, 'utf8')).replace(
      /^RESEND_API_KEY=$/m,
      'RESEND_API_KEY=re_mine',
    )

    expect(written).toContain('RESEND_API_KEY=re_mine')
    await writeFile(envFile, written)

    const second = await spools(folder, ['init', '--yes'])
    expect(second.exitCode).toBe(0)
    const config = await readConfig(folder)
    expect(config.access).toEqual(access)
    expect(config.app.name).toBe((await readConfig(STARTER)).app.name)
    // The secrets made the first time are the ones still there.
    expect(await readFile(envFile, 'utf8')).toBe(written)
  })

  test('a new domain takes the place of the first; the other domains and the addresses stay, and an address is added', async () => {
    const folder = await initFolder((config) => {
      config.access = {
        allowedDomains: ['acme.test', 'partner.test'],
        allowedEmails: ['guest@elsewhere.test'],
      }
    })

    await spools(folder, ['init', '--domain', 'acme.example', '--email', 'Sam@Other.test', '--yes'])

    expect((await readConfig(folder)).access).toEqual({
      allowedDomains: ['acme.example', 'partner.test'],
      allowedEmails: ['guest@elsewhere.test', 'sam@other.test'],
    })

    // Asking for somebody already let in adds nobody twice.
    await spools(folder, ['init', '--email', 'GUEST@elsewhere.test', '--yes'])

    expect((await readConfig(folder)).access.allowedEmails).toEqual([
      'guest@elsewhere.test',
      'sam@other.test',
    ])
  })

  test('a blank secret in an existing .env is filled in, and one already there is kept', async () => {
    const folder = await initFolder()
    const example = await readFile(join(folder, '.env.example'), 'utf8')
    await writeFile(join(folder, '.env'), example.replace(/^APP_SECRET=$/m, 'APP_SECRET=mine'))
    await spools(folder, ['init', '--yes'])

    const env = await readEnv(folder)
    expect(env.get('APP_SECRET')).toBe('mine')
    expect(env.get('SWIRLS_APP_TOKEN')).toMatch(/^[0-9a-f]{64}$/)
  })

  test('with nobody allowed in it stops, says the CRM is deny-by-default, and writes nothing', async () => {
    const folder = await initFolder((config) => {
      config.access = { allowedDomains: [], allowedEmails: [] }
    })

    const before = await readFile(join(folder, 'crm.config.json'), 'utf8')
    const result = await spools(folder, ['init', '--name', 'Acme', '--yes'])
    expect(result.exitCode).toBe(1)

    expect(result.stderr).toContain(
      'You need at least one allowed domain or email: the CRM is deny-by-default.',
    )

    expect(await readFile(join(folder, 'crm.config.json'), 'utf8')).toBe(before)
    expect(existsSync(join(folder, '.env'))).toBe(false)

    // One address is enough.
    const one = await spools(folder, [
      'init',
      '--name',
      'Acme',
      '--email',
      'sam@acme.test',
      '--yes',
    ])

    expect(one.exitCode).toBe(0)

    expect((await readConfig(folder)).access).toEqual({
      allowedDomains: [],
      allowedEmails: ['sam@acme.test'],
    })
  })
})

describe('spools gen', () => {
  test("--no-emit checks the starter's config and writes the Prisma schema and the JSON Schema", async () => {
    const folder = await appFolder()
    const { key } = firstObject(await readConfig(folder))
    expect(existsSync(join(folder, 'prisma/schema.prisma'))).toBe(false)

    const result = await spools(folder, ['gen', '--no-emit'])
    expect(result.exitCode).toBe(0)
    const objects = Object.keys((await readConfig(folder)).objects).length
    expect(result.stdout).toContain(`✓ prisma/schema.prisma (${objects} objects + `)
    expect(result.stdout).toContain('✓ crm.config.schema.json')

    const schema = await readFile(join(folder, 'prisma/schema.prisma'), 'utf8')
    expect(schema).toContain(`@@map("${key}")`)
    // Row-level security is declared on every model (src/cli/harden.ts relies on it).
    expect(schema).toContain('@@rls')

    const jsonSchema = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(await readFile(join(folder, 'crm.config.schema.json'), 'utf8')))

    expect(Object.keys(jsonSchema.properties)).toEqual(
      expect.arrayContaining(['app', 'access', 'objects']),
    )
  })

  test('without --no-emit it also has Prisma emit the contract from the schema', async () => {
    const folder = await appFolder()
    const contract = () => readFileSync(join(folder, 'prisma/schema.json'), 'utf8')
    expect(existsSync(join(folder, 'prisma/schema.d.ts'))).toBe(false)

    const result = await spools(folder, ['gen'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('✓ prisma/schema.prisma')
    expect(existsSync(join(folder, 'prisma/schema.d.ts'))).toBe(true)
    // The contract is JSON the Spool can load.
    expect(() => JSON.parse(contract())).not.toThrow()
  })

  test('a view column that names no field fails, says which, and writes nothing', async () => {
    const config = await readConfig(STARTER)
    const { key } = firstObject(config)

    const folder = await appFolder((config) => {
      firstObject(config).object.views[0]?.columns?.push('noSuchField')
    })

    const result = await spools(folder, ['gen', '--no-emit'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('crm.config.json is invalid')
    expect(result.stderr).toContain('unknown field "noSuchField"')
    expect(result.stderr).toContain(`objects.${key}.views[0]`)
    expect(existsSync(join(folder, 'prisma/schema.prisma'))).toBe(false)
  })

  test("an action that runs a handler the app doesn't have fails and names the action", async () => {
    const config = await readConfig(STARTER)
    const { key } = firstObject(config)

    const folder = await appFolder((config) => {
      const { object } = firstObject(config)

      object.actions = [
        ...(object.actions ?? []),
        { id: 'ghost', label: 'Ghost', run: 'local:noSuchHandler' },
      ]
    })

    const result = await spools(folder, ['gen', '--no-emit'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('crm.config.json has unresolved run targets')

    expect(result.stderr).toContain(
      `objects.${key}.actions.ghost: no handler "noSuchHandler" in src/app/extensions.ts`,
    )
  })

  test("an object whose table would be one of the framework's own fails and names the table", async () => {
    const folder = await appFolder((config) => {
      config.objects['activities'] = structuredClone(firstObject(config).object)
    })

    const result = await spools(folder, ['gen', '--no-emit'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("an object whose table would be another table's")
    expect(result.stderr).toContain('Rename its key.')
    expect(existsSync(join(folder, 'prisma/schema.prisma'))).toBe(false)
  })
})

describe('spools check-client', () => {
  const built = async (files: Record<string, string>, into = 'dist/client') => {
    const folder = await emptyFolder()

    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(folder, into, name)), { recursive: true })
      await writeFile(join(folder, into, name), text)
    }

    return folder
  }

  test('browser files without Effect pass, and it says how many it read', async () => {
    const folder = await built({
      'assets/app-abc123.js': 'console.log("hello")',
      'assets/chunks/vendor.mjs': 'export const effect = "a word, not the library"',
      // Only scripts are read: a stylesheet or a source map is not code that runs.
      'assets/app.css': '/* ~effect/ */',
      'assets/app-abc123.js.map': '{"sources":["~effect/Effect"]}',
    })

    const result = await spools(folder, ['check-client'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('[client bundle] no Effect in 2 browser files')
  })

  test("a browser file that carries Effect's internal ids fails the build and is named", async () => {
    const folder = await built({
      'assets/app-abc123.js': 'console.log("hello")',
      'assets/chunks/server-fn.js': 'const TypeId="~effect/Effect";',
    })

    const result = await spools(folder, ['check-client'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('[client bundle] Effect reached the browser in:')
    expect(result.stderr).toContain(join('dist/client', 'assets/chunks/server-fn.js'))
    expect(result.stderr).not.toContain('app-abc123.js')
  })

  test('before a build there is nothing to check, and it says to build first', async () => {
    const result = await spools(await emptyFolder(), ['check-client'])
    expect(result.exitCode).toBe(1)

    expect(result.stderr).toContain(
      'no build found (dist/client or .vercel/output/static). Run the build first.',
    )
  })

  test('a Vercel build is checked where Vercel puts the browser files', async () => {
    const folder = await built(
      { 'assets/server-fn.js': 'const TypeId="~effect/Effect";' },
      '.vercel/output/static',
    )

    const result = await spools(folder, ['check-client'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(join('.vercel/output/static', 'assets/server-fn.js'))
  })

  test('a folder named on the command line is checked instead', async () => {
    const folder = await built({ 'app.js': 'console.log("hello")' }, 'build/public')
    await mkdir(join(folder, 'dist/client'), { recursive: true })
    await writeFile(join(folder, 'dist/client/app.js'), 'const TypeId="~effect/Effect";')

    const result = await spools(folder, ['check-client', 'build/public'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('[client bundle] no Effect in 1 browser files')

    const absent = await spools(folder, ['check-client', 'nowhere'])
    expect(absent.exitCode).toBe(1)
    expect(absent.stderr).toContain('nowhere is missing. Run the build first.')
  })
})

describe('spools harden', () => {
  test('without DATABASE_URL it stops and says which variable is not set', async () => {
    const result = await spools(await emptyFolder(), ['harden'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('DATABASE_URL is not set')
  })
})

describe('spools stats', () => {
  test('with no DATABASE_URL on a developer machine it refreshes every object in the database inside the process', async () => {
    const folder = await appFolder()
    const result = await spools(folder, ['stats'])
    expect(result.exitCode).toBe(0)

    for (const key of Object.keys((await readConfig(folder)).objects)) {
      expect(result.stdout).toContain(`✓ ${key}`)
    }

    // PGlite keeps its data in the app's own folder.
    expect(existsSync(join(folder, '.data/pglite'))).toBe(true)
  })

  test('in a deployment without DATABASE_URL every object fails, saying what to set, and it exits 1', async () => {
    const folder = await appFolder()
    const result = await spools(folder, ['stats'], { NODE_ENV: 'production' })
    expect(result.exitCode).toBe(1)
    const keys = Object.keys((await readConfig(folder)).objects)

    for (const key of keys) {
      expect(result.stderr).toContain(`✗ ${key}: DATABASE_URL is not set`)
    }

    expect(result.stderr).toContain(`${keys.length} object(s) were not refreshed`)
    expect(existsSync(join(folder, '.data'))).toBe(false)
  })
})
