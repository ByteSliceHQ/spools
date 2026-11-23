import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { $ } from 'bun'

/**
 * Makes a Spool from what is on npm, and builds it:
 *
 *   bun run test:e2e:npm [version]
 */
const version = process.argv[2] ?? 'latest'
const directory = await mkdtemp(join(tmpdir(), 'spools-npm-e2e-'))
const app = join(directory, 'my-crm')

const env = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  CI: '1',
}

try {
  await $`bunx @swirls/create-spools@${version} ${app} --name E2E --domain example.com --yes`
    .cwd(directory)
    .env(env)

  await $`bun run check-types`.cwd(app).env(env)
  await $`bun run build`.cwd(app).env(env)
  await $`bun run db:seed`.cwd(app).env(env)
  console.log(`\nMade, built and seeded a Spool from @swirls/create-spools@${version}`)
} finally {
  await rm(directory, { force: true, recursive: true })
}
