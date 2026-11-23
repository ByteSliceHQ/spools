#!/usr/bin/env bun
/**
 * Does what someone starting a Spool does, with the packages as they would be
 * published: builds and packs them, looks inside, makes a new Spool from the
 * tarballs in a folder of its own, then checks its types, builds it, seeds it
 * and asks it for a page. It never publishes.
 *
 *   bun run check:package            needs nothing but Bun
 *   bun run check:package --image    builds its Docker image too, and starts it
 *   bun run check:package --keep     leaves the new Spool where it is
 */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { $ } from 'bun'

const root = resolve(import.meta.dirname, '..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'spools-package-'))
const app = join(temporaryRoot, 'my-crm')

// Nothing from the environment this is run in: a new Spool has no keys.
const env = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  CI: '1',
}

function step(what: string) {
  console.log(`\n── ${what}`)
}

/** Packs a package and lists the files in it. */
async function pack(directory: string, name: string) {
  await $`bun pm pack --destination ${temporaryRoot} --quiet`.cwd(join(root, directory)).quiet()
  const [tarball] = [...new Bun.Glob(`*${name}-[0-9]*.tgz`).scanSync({ cwd: temporaryRoot })]

  if (!tarball) {
    throw new Error(`${directory} was not packed`)
  }

  const listing = await $`tar -tzf ${join(temporaryRoot, tarball)}`.text()
  const paths = listing.split('\n').flatMap((path) => path.replace(/^package\//, '') || [])
  return { tarball, paths }
}

function checkContents(
  name: string,
  paths: readonly string[],
  { required, forbidden }: { required: readonly string[]; forbidden: (path: string) => boolean },
) {
  const missing = required.filter((path) => !paths.includes(path))
  const unwanted = paths.filter(forbidden)

  if (missing.length > 0) {
    throw new Error(`${name} is missing:\n${missing.join('\n')}`)
  }

  if (unwanted.length > 0) {
    throw new Error(`${name} contains:\n${unwanted.join('\n')}`)
  }

  console.log(`✓ ${name}: ${paths.length} files`)
}

/** What an agent might add: a page with a server function behind it. */
function ownPage(handler: string) {
  return `import { crmHandler } from '@swirls/spools/handlers'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

const helloFn = createServerFn({ method: 'GET' }).handler(${handler})

export const Route = createFileRoute('/_crm/hello')({
  loader: () => helloFn(),
  component: () => <p>{Route.useLoaderData().hello}</p>,
})

export const used = crmHandler
`
}

let server: Bun.Subprocess | undefined

try {
  step('Build and pack')
  await $`bun run build`.cwd(join(root, 'packages/spools')).quiet()
  const spools = await pack('packages/spools/dist', 'spools')

  checkContents('@swirls/spools', spools.paths, {
    required: [
      'index.js',
      'index.d.ts',
      'adapter.js',
      'extensions.js',
      'cli/main.js',
      'server/entry.js',
      'crm/ui/theme.css',
      'package.json',
      'README.md',
      'LICENSE',
      'NOTICE',
    ],
    forbidden: (path) =>
      (/\.tsx?$/.test(path) && !path.endsWith('.d.ts')) || /\.(test|map)\b|(^|\/)\.env/.test(path),
  })

  const create = await pack('packages/create-spools', 'create-spools')

  checkContents('@swirls/create-spools', create.paths, {
    required: [
      'src/main.ts',
      'template/package.json',
      'template/_gitignore',
      'template/src/spool.server.ts',
    ],
    forbidden: (path) =>
      /(^|\/)\.env$|\.data\/|node_modules\/|routeTree\.gen\.ts\.|e2e\//.test(path),
  })

  step('Create')
  await $`tar -xzf ${create.tarball}`.cwd(temporaryRoot)

  await $`bun ${join(temporaryRoot, 'package/src/main.ts')} ${app} --no-install --yes`
    .cwd(temporaryRoot)
    .env(env)

  const manifestFile = Bun.file(join(app, 'package.json'))
  const manifest = await manifestFile.json()
  manifest.dependencies['@swirls/spools'] = `file:./${spools.tarball}`
  await cp(join(temporaryRoot, spools.tarball), join(app, spools.tarball))
  await Bun.write(manifestFile, JSON.stringify(manifest, null, 2))
  await $`bun install`.cwd(app).env(env).quiet()
  await $`bunx spools init --name Scaffold --domain example.com --yes`.cwd(app).env(env).quiet()

  step('Lint, with a page of its own')
  const page = join(app, 'src/routes/_crm/hello.tsx')

  await Bun.write(page, ownPage("async () => ({ hello: 'anyone' })"))
  const unchecked = await $`bun run lint`.cwd(app).env(env).nothrow().quiet()

  if (unchecked.exitCode === 0 || !unchecked.stdout.toString().includes('checks who is asking')) {
    throw new Error(
      `Lint let an unchecked server function through:\n${unchecked.stdout.toString()}`,
    )
  }

  await Bun.write(
    page,
    ownPage("crmHandler('hello', ({ user }) => ({ hello: `Hello ${user.email}` }))"),
  )

  await $`bun run lint`.cwd(app).env(env).quiet()

  console.log(
    '✓ refuses a server function that skips the session check, and accepts one that has it',
  )

  step('Generate, build, check types')
  await $`bun run crm:gen --no-emit`.cwd(app).env(env).quiet()
  // The build writes the route tree, which the new page is typed by.
  await $`bun run build`.cwd(app).env(env).quiet()
  await $`bun run check-types`.cwd(app).env(env)

  step('The check an agent is told to run')
  // Types, lint, config and tests, with nothing installed but what the Spool depends on.
  await $`bun run check`.cwd(app).env(env).quiet()

  step('A production server without keys refuses to start')
  const refused = await $`bun run start`.cwd(app).env(env).nothrow().quiet()

  if (refused.exitCode === 0) {
    throw new Error('It started')
  }

  if (!refused.stderr.toString().includes('CLERK_SECRET_KEY is not set')) {
    throw new Error(`It failed otherwise:\n${refused.stderr.toString()}`)
  }

  if (process.argv.includes('--image')) {
    step('Docker image')
    await $`docker build --quiet --tag spools-check .`.cwd(app).env(env).quiet()

    const bare = await $`docker run --rm spools-check`.nothrow().quiet()

    if (bare.exitCode === 0) {
      throw new Error("The image started with nobody's keys")
    }

    // Not a real Clerk instance: enough to start, and to send a signed-out visitor to sign in.
    const keys = [
      'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres',
      'CLERK_PUBLISHABLE_KEY=pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk',
      'CLERK_SECRET_KEY=sk_test_placeholder',
    ].flatMap((variable) => ['--env', variable])

    const container = (
      await $`docker run --detach --rm --publish 127.0.0.1::3000 ${keys} spools-check`.text()
    ).trim()

    try {
      const address = (await $`docker port ${container} 3000`.text()).trim().split('\n')[0]
      const ask = (path: string) => fetch(`http://${address}${path}`, { redirect: 'manual' })
      let healthy = false

      for (let tries = 0; tries < 60 && !healthy; tries++) {
        healthy = await ask('/healthz').then(
          (response) => response.ok,
          () => false,
        )

        await Bun.sleep(500)
      }

      const home = await ask('/')
      const signIn = await ask('/sign-in')

      if (!healthy || home.status !== 307 || signIn.status !== 200) {
        throw new Error(
          `Expected / to redirect to /sign-in; got ${home.status}, and ${signIn.status} from /sign-in`,
        )
      }
    } finally {
      await $`docker stop ${container}`.nothrow().quiet()
    }
  }

  step('Seed and serve')
  await $`bun run db:seed`.cwd(app).env(env)
  const port = 3900 + Math.floor(Math.random() * 90)

  server = Bun.spawn(['bunx', '--bun', 'vite', 'dev', '--port', String(port)], {
    cwd: app,
    env,
    stdout: 'ignore',
    stderr: 'inherit',
  })

  async function get(path: string) {
    for (let tries = 0; tries < 60; tries++) {
      const response = await fetch(`http://localhost:${port}${path}`).catch(() => null)

      if (response) {
        return { status: response.status, body: await response.text(), headers: response.headers }
      }

      await Bun.sleep(500)
    }

    throw new Error('The dev server never answered')
  }

  for (const { path, holds } of [
    { path: '/contacts', holds: 'Ada Lovelace' },
    { path: '/deals', holds: 'Globex' },
    { path: '/reports', holds: 'Reports' },
    { path: '/hello', holds: 'Hello dev@example.com' },
  ]) {
    const { status, body, headers } = await get(path)

    if (status !== 200 || !body.includes(holds)) {
      throw new Error(`${path} answered ${status} without "${holds}"`)
    }

    // A page of the CRM may not be put in another site's frame (server/headers.ts).
    if (headers.get('x-frame-options') !== 'SAMEORIGIN') {
      throw new Error(`${path} answered without the headers every answer carries`)
    }

    console.log(`✓ ${path}`)
  }

  console.log('\nValidated the packed @swirls/spools and @swirls/create-spools')
} finally {
  server?.kill()
  await server?.exited

  if (process.argv.includes('--keep')) {
    console.log(`Kept: ${app}`)
  } else {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
