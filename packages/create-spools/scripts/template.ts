#!/usr/bin/env bun
/**
 * Builds `template/`, what a new Spool starts as, from the working Spool in
 * apps/starter. Run before the package is packed (`prepack`), so what people get
 * is what is developed and tested here.
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const here = join(import.meta.dir, '..')
const starter = join(here, '../../apps/starter')
const out = join(here, 'template')

/** What is copied as it is. */
const FILES = [
  '.dockerignore',
  '.env.example',
  'Dockerfile',
  'crm.config.json',
  'crm.config.schema.json',
  'prisma.config.ts',
  'prisma',
  'scripts/seed.ts',
  'server.prod.ts',
  'src',
  'supabase/config.toml',
  'swirls',
  'tests',
  'vite.config.ts',
]

/** Scripts that are about developing the framework. */
const NOT_SCRIPTS = new Set(['dev:e2e', 'demo'])

await rm(out, { recursive: true, force: true })

for (const file of FILES) {
  if (!existsSync(join(starter, file))) {
    throw new Error(`The template needs ${file}, which isn't in apps/starter.`)
  }

  await mkdir(dirname(join(out, file)), { recursive: true })
  await cp(join(starter, file), join(out, file), { recursive: true })
}

await cp(join(here, 'overrides'), out, { recursive: true })

// npm leaves dotfiles out of a package; src/main.ts puts the dot back.
for (const file of FILES.filter((f) => f.startsWith('.'))) {
  await rename(join(out, file), join(out, `_${file.slice(1)}`))
}

const manifest = await Bun.file(join(starter, 'package.json')).json()
const { version } = await Bun.file(join(here, '../spools/package.json')).json()
const root = await Bun.file(join(here, '../../package.json')).json()

const scripts = Object.fromEntries(
  Object.entries(manifest.scripts).filter(([name]) => !NOT_SCRIPTS.has(name)),
)

await Bun.write(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'my-crm',
      version: '0.0.0',
      private: true,
      type: 'module',
      engines: manifest.engines,
      scripts: {
        ...scripts,
        lint: 'bunx --bun oxlint --deny-warnings',
        check: 'bun run check-types && bun run lint && bun run crm:gen --no-emit && bun run test',
      },
      dependencies: { ...manifest.dependencies, '@swirls/spools': `^${version}` },
      devDependencies: {
        ...manifest.devDependencies,
        '@oxlint/plugins': root.devDependencies['@oxlint/plugins'],
        oxlint: root.devDependencies.oxlint,
      },
    },
    null,
    2,
  )}\n`,
)

console.log(`✓ template (@swirls/spools ^${version})`)
