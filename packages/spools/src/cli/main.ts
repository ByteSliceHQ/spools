#!/usr/bin/env bun
/**
 * The `spools` command, run in an app's folder:
 *
 *   spools gen           check crm.config.json and regenerate what is made from it
 *   spools init          first run: name, access list, secrets in .env
 *   spools stats         refill last activity / last contacted / next task due
 *   spools harden        lock the tables away from Supabase's Data API roles
 *   spools check-client  fail if server code reached the browser bundle
 */
const commands = {
  gen: () => import('./gen'),
  init: () => import('./init'),
  stats: () => import('./stats'),
  harden: () => import('./harden'),
  'check-client': () => import('./check-client'),
}

const isCommand = (name: string): name is keyof typeof commands => Object.hasOwn(commands, name)

const [name = '', ...rest] = process.argv.slice(2)
const command = isCommand(name) ? commands[name] : undefined

if (!command) {
  console.error(`Usage: spools <${Object.keys(commands).join(' | ')}>`)
  process.exit(1)
}

// The command reads its own arguments as if it had been run directly.
process.argv.splice(2, process.argv.length - 2, ...rest)
await command()
