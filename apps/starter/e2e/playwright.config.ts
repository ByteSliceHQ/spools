/**
 * Browser tests of the starter (`bun run test:e2e` from the repository root).
 *
 * They run against the harness build (vite.config.e2e.ts: the development
 * sign-in in place of the auth adapter), served the way a deployment is
 * (server.prod.ts). Who is signed in is decided when a server starts, so there
 * are three servers, each on a seeded database of its own (e2e/serve.ts):
 *
 *   staff         signed in as someone on the access list, assistant stubbed
 *   signed-out    nobody is signed in
 *   not-allowed   signed in as someone the access list refuses
 *
 * `E2E_PORT` moves the three ports (default 4310, 4311 and 4312). The tests are
 * named `*.e2e.ts`, not `*.spec.ts`, so that `bun test` leaves them alone.
 */
import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

const starter = fileURLToPath(new URL('..', import.meta.url))
const firstPort = Number(process.env['E2E_PORT'] || 4310)
const ci = !!process.env['CI']

const servers = [
  { name: 'staff', port: firstPort, env: { E2E_ASSISTANT: 'stub' } },
  { name: 'signed-out', port: firstPort + 1, env: { DEV_AUTH_SIGNED_OUT: '1' } },
  { name: 'not-allowed', port: firstPort + 2, env: { DEV_AUTH_EMAIL: 'otto@elsewhere.test' } },
] as const

const origin = (port: number) => `http://localhost:${port}`

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  // One at a time: the tests of one server share its database, and PGlite is one connection.
  workers: 1,
  forbidOnly: ci,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  projects: servers.map(({ name, port }) => ({
    name,
    testMatch: name === 'staff' ? /\.e2e\.ts$/ : new RegExp(`${name}\\.e2e\\.ts$`),
    testIgnore: name === 'staff' ? /(signed-out|not-allowed)\.e2e\.ts$/ : [],
    use: { baseURL: origin(port) },
  })),
  // Started one after another, so only the first has to build.
  webServer: servers.map(({ name, port, env }, i) => ({
    name,
    command:
      i === 0
        ? 'bunx --bun vite build --config vite.config.e2e.ts && bun e2e/serve.ts'
        : 'bun e2e/serve.ts',
    cwd: starter,
    url: `${origin(port)}/healthz`,
    env: { ...env, E2E_NAME: name, PORT: String(port) },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5000 },
  })),
})
