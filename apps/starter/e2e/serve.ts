#!/usr/bin/env bun
/**
 * One server for the browser tests (e2e/playwright.config.ts starts it): the
 * harness build of the app on a database of its own.
 *
 * PGlite keeps its data in `.data/pglite` under the directory the process runs
 * in, so this runs in `e2e/.data/<E2E_NAME>`: emptied, then seeded, each time.
 * The database a developer uses (`apps/starter/.data`) and their `.env` are
 * never read. It serves what `vite build --config vite.config.e2e.ts` left in
 * `dist/`.
 *
 *   E2E_NAME   the data folder, one per server (default `staff`)
 *   PORT       where it listens, on localhost only
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const starter = join(import.meta.dir, '..')
const dir = join(import.meta.dir, '.data', process.env['E2E_NAME'] || 'staff')

rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

// Blank, not unset: a database or a sign-in key in the shell must not reach either process.
const env = {
  ...process.env,
  DATABASE_URL: '',
  POSTGRES_URL: '',
  CLERK_SECRET_KEY: '',
  HOST: 'localhost',
  CRM_GUIDES: process.env['CRM_GUIDES'] || 'off',
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
}

const seed = Bun.spawnSync(['bun', join(starter, 'scripts/seed.ts')], {
  cwd: dir,
  env,
  stdout: 'inherit',
  stderr: 'inherit',
})

if (seed.exitCode !== 0) {
  console.error('The test database could not be seeded.')
  process.exit(1)
}

const server = Bun.spawn(['bun', join(starter, 'server.prod.ts')], {
  cwd: dir,
  env,
  stdout: 'inherit',
  stderr: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal))
}

process.exit(await server.exited)
