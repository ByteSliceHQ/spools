#!/usr/bin/env bun
/**
 * Makes a new Spool in a folder of its own:
 *
 *   bun create @swirls/spools my-crm
 *   bun create @swirls/spools my-crm --name "Acme" --domain acme.com --yes
 *
 * Nothing it makes needs an account: the new CRM keeps its records in a Postgres
 * inside the server and signs you straight in until you choose real services.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { cp, readdir, rename } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { $ } from 'bun'

const { values: args, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    domain: { type: 'string' },
    email: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    'no-install': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (args.help || positionals.length > 1) {
  console.log(`Usage: bun create @swirls/spools <folder> [options]

  --name <text>      your business, as the CRM shows it
  --domain <domain>  who may use the CRM: everyone with an address here
  --email <address>  or one person
  --yes              take the defaults instead of asking
  --no-install       don't install packages (or run the first-time setup)`)

  process.exit(args.help ? 0 : 1)
}

const folder =
  positionals[0] ??
  (args.yes ? 'my-crm' : prompt('Folder for the new CRM (my-crm):')?.trim() || 'my-crm')

const target = resolve(folder)

if (existsSync(target) && !statSync(target).isDirectory()) {
  console.error(`${target} is a file. Choose a folder.`)
  process.exit(1)
}

if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`${target} isn't empty. Choose another folder.`)
  process.exit(1)
}

const template = join(import.meta.dir, '../template')

if (!existsSync(template)) {
  console.error(
    'The template is missing. In the repository, make it with `bun run template` in packages/create-spools.',
  )

  process.exit(1)
}

await cp(template, target, { recursive: true })

// npm leaves dotfiles such as .gitignore out of a package, so the template holds them without their dot.
for (const entry of await readdir(target)) {
  if (entry.startsWith('_')) {
    await rename(join(target, entry), join(target, `.${entry.slice(1)}`))
  }
}

const manifest = Bun.file(join(target, 'package.json'))

const slug =
  basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'my-crm'

await Bun.write(
  manifest,
  `${JSON.stringify({ ...(await manifest.json()), name: slug }, null, 2)}\n`,
)

console.log(`✓ ${target}`)

const steps = [`cd ${/^[\w./-]+$/.test(folder) ? folder : JSON.stringify(folder)}`]

if (args['no-install']) {
  steps.push('bun install', 'bun run init')
} else {
  await $`bun install`.cwd(target)

  // Names the CRM, sets who may use it, and writes .env with fresh secrets.
  const setup = (['name', 'domain', 'email'] as const).flatMap((key) => {
    const value = args[key]
    return value ? [`--${key}`, value] : []
  })

  if (args.yes) {
    setup.push('--yes')
  }

  await $`bunx spools init ${setup}`.cwd(target)
}

steps.push(
  'bun run db:seed   # demo companies, contacts and deals',
  'bun run dev       # http://localhost:3000',
)

console.log(`\n${steps.map((s) => `  ${s}`).join('\n')}\n`)
