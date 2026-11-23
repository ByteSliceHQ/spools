import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `bun create @swirls/spools <folder>`, run the way a person runs it, with
// --no-install so nothing is fetched. It copies `template/`, which is build
// output (`bun run template` makes it from apps/starter), so the template is
// built before these tests and removed after them unless it was already there.

const PACKAGE = join(import.meta.dir, '..')
const MAIN = join(PACKAGE, 'src/main.ts')
const TEMPLATE = join(PACKAGE, 'template')

const ENV: Record<string, string> = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  NO_COLOR: '1',
}

const run = async (command: string[], cwd: string) => {
  const child = Bun.spawn([process.execPath, ...command], {
    cwd,
    env: ENV,
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

/** Runs the scaffolder with these arguments, in this folder. */
const create = (cwd: string, args: string[]) => run([MAIN, ...args], cwd)

/** The name a folder's package.json gives its package. */
const nameOf = async (folder: string) =>
  /^ {2}"name": "([^"]*)",?$/m.exec(await readFile(join(folder, 'package.json'), 'utf8'))?.[1]

const templateWasThere = existsSync(TEMPLATE)
let scratch = ''
let places = 0

/** An empty folder to run the scaffolder in. */
const place = async () => {
  const folder = join(scratch, `place-${++places}`)
  await mkdir(folder, { recursive: true })
  return folder
}

beforeAll(async () => {
  // The scaffolder prints the folder's real path, which on macOS is not the one tmpdir() gives.
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'create-spools-')))
  const built = await run(['scripts/template.ts'], PACKAGE)

  if (built.exitCode !== 0) {
    throw new Error(`the template could not be built: ${built.stderr}`)
  }
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })

  if (!templateWasThere) {
    await rm(TEMPLATE, { recursive: true, force: true })
  }
})

describe('create-spools', () => {
  test('makes the folder from the template, puts the dots back on its dotfiles and names the package after it', async () => {
    const cwd = await place()
    const result = await create(cwd, ['my-shop', '--no-install', '--yes'])
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)

    const target = join(cwd, 'my-shop')
    const made = await readdir(target)
    expect(made).toEqual(expect.arrayContaining(['.gitignore', '.env.example', 'crm.config.json']))
    expect(made.filter((entry) => entry.startsWith('_'))).toEqual([])
    // Every file the template holds without its dot is there with it.
    const held = (await readdir(TEMPLATE)).filter((entry) => entry.startsWith('_'))
    expect(held.length).toBeGreaterThanOrEqual(2)
    expect(made).toEqual(expect.arrayContaining(held.map((entry) => `.${entry.slice(1)}`)))

    expect(await readFile(join(target, '.env.example'), 'utf8')).toBe(
      await readFile(join(TEMPLATE, '_env.example'), 'utf8'),
    )

    expect(await nameOf(target)).toBe('my-shop')
    // Nothing was installed or set up: it says what is left to do.
    expect(existsSync(join(target, 'node_modules'))).toBe(false)
    expect(existsSync(join(target, '.env'))).toBe(false)
    expect(result.stdout).toContain('cd my-shop')
    expect(result.stdout).toContain('bun install')
    expect(result.stdout).toContain('bun run init')
  })

  test('with --yes and no folder it makes my-crm, and an empty folder that is already there is used', async () => {
    const cwd = await place()
    const result = await create(cwd, ['--no-install', '--yes'])
    expect(result.exitCode).toBe(0)
    expect(await nameOf(join(cwd, 'my-crm'))).toBe('my-crm')

    await mkdir(join(cwd, 'empty'))
    const second = await create(cwd, ['empty', '--no-install', '--yes'])
    expect(second.exitCode).toBe(0)
    expect(existsSync(join(cwd, 'empty/crm.config.json'))).toBe(true)
  })

  test('a folder name that is no package name is made into one', async () => {
    const cwd = await place()
    const result = await create(cwd, ['Birch & Co', '--no-install', '--yes'])
    expect(result.exitCode).toBe(0)
    expect(await nameOf(join(cwd, 'Birch & Co'))).toBe('birch-co')
    // The folder is quoted where it is to be typed.
    expect(result.stdout).toContain('cd "Birch & Co"')
  })

  test('refuses a folder that has something in it, and leaves it as it was', async () => {
    const cwd = await place()
    await mkdir(join(cwd, 'taken'))
    await writeFile(join(cwd, 'taken/notes.txt'), 'mine')

    const result = await create(cwd, ['taken', '--no-install', '--yes'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.trim()).toBe(`${join(cwd, 'taken')} isn't empty. Choose another folder.`)
    expect(await readdir(join(cwd, 'taken'))).toEqual(['notes.txt'])
  })

  test('refuses a path that is a file, in plain words', async () => {
    const cwd = await place()
    await writeFile(join(cwd, 'notes.txt'), 'mine')

    const result = await create(cwd, ['notes.txt', '--no-install', '--yes'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.trim()).toBe(`${join(cwd, 'notes.txt')} is a file. Choose a folder.`)
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('mine')
  })

  test('--help says how it is used; two folders is a mistake and says the same', async () => {
    const cwd = await place()
    const help = await create(cwd, ['--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('Usage: bun create @swirls/spools <folder> [options]')

    const two = await create(cwd, ['one', 'two', '--no-install', '--yes'])
    expect(two.exitCode).toBe(1)
    expect(two.stdout).toContain('Usage: bun create @swirls/spools <folder> [options]')
    expect(await readdir(cwd)).toEqual([])
  })
})
