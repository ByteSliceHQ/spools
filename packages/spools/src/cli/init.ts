#!/usr/bin/env bun
/**
 * First-run setup for a new business: names the CRM, sets the access allowlist,
 * and writes .env with freshly generated secrets.
 *
 *   spools init                                  # interactive
 *   spools init --name "Acme" --domain acme.com  # non-interactive
 *
 * Safe to re-run: existing .env values are kept, only blanks are filled in, and
 * nobody already on the access list is taken off it.
 */
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'

import { z } from 'zod'

const root = `${process.cwd()}/`

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    name: { type: 'string' },
    domain: { type: 'string' },
    email: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
  },
})

const ask = (question: string, fallback?: string): string => {
  if (args.yes) {
    return fallback ?? ''
  }

  const answer = prompt(`${question}${fallback ? ` (${fallback})` : ''}:`)
  return answer?.trim() || fallback || ''
}

// ── crm.config.json ─────────────────────────────────────────────────────────
const configFile = Bun.file(`${root}crm.config.json`)
const config = await configFile.json()

const name = args.name ?? ask('Business name', config.app?.name)

// Who is let in now. A list that isn't a list of strings stops the run before anything is written.
const access = z
  .object({
    allowedDomains: z.array(z.string()).nullish(),
    allowedEmails: z.array(z.string()).nullish(),
  })
  .parse(config.access ?? {})

const allowed = { domains: access.allowedDomains ?? [], emails: access.allowedEmails ?? [] }

const domain = (
  args.domain ?? ask('Team email domain allowed into the CRM (blank to skip)', allowed.domains[0])
)
  .replace(/^@/, '')
  .toLowerCase()

const email = (args.email ?? (domain ? '' : ask('Or a single allowed email address'))).toLowerCase()

config.app = { ...config.app, name: name.replace(/\s+CRM$/i, '') }

// The question is about the first domain. Run again, the other domains and the
// addresses already let in stay as they are: nobody is locked out by a second run.
const otherDomains = allowed.domains.slice(1).filter((d) => d.toLowerCase() !== domain)

config.access = {
  allowedDomains: domain ? [domain, ...otherDomains] : otherDomains,
  allowedEmails:
    email && !allowed.emails.some((e) => e.toLowerCase() === email)
      ? [...allowed.emails, email]
      : allowed.emails,
}

if (config.access.allowedDomains.length + config.access.allowedEmails.length === 0) {
  console.error('You need at least one allowed domain or email: the CRM is deny-by-default.')
  process.exit(1)
}

await Bun.write(configFile, `${JSON.stringify(config, null, 2)}\n`)

console.log(
  `✓ crm.config.json: "${config.app.name}", access for ${[...config.access.allowedDomains, ...config.access.allowedEmails].join(', ')}`,
)

// ── supabase/config.toml ────────────────────────────────────────────────────
// Give this app its own local Supabase project. With the starter's id, `supabase start`
// would reuse another clone's running stack and database.
const supabaseFile = Bun.file(`${root}supabase/config.toml`)

if (await supabaseFile.exists()) {
  const slug =
    config.app.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'crm'

  const toml = await supabaseFile.text()
  const next = toml.replace(/^project_id = ".*"$/m, `project_id = "${slug}-crm"`)

  if (next !== toml) {
    await Bun.write(supabaseFile, next)
    console.log(`✓ supabase/config.toml: local project "${slug}-crm"`)
  }
}

// ── .env ────────────────────────────────────────────────────────────────────
const envFile = Bun.file(`${root}.env`)

const existing = (await envFile.exists())
  ? await envFile.text()
  : await Bun.file(`${root}.env.example`).text()

const secret = () => randomBytes(32).toString('hex')

const generated = new Map([
  ['APP_SECRET', secret()],
  ['SWIRLS_APP_TOKEN', secret()],
])

const lines = existing.split('\n').map((line) => {
  const m = /^([A-Z_]+)=(.*)$/.exec(line)

  if (!m) {
    return line
  }

  // Both groups take part in every match.
  const [, key = '', value = ''] = m
  const fresh = generated.get(key)

  if (fresh !== undefined && value.trim() === '') {
    return `${key}=${fresh}`
  }

  return line
})

await Bun.write(envFile, lines.join('\n'))
console.log('✓ .env (generated APP_SECRET and SWIRLS_APP_TOKEN where blank)')

console.log(`
Next:
  1. bun run db:seed   # demo companies, contacts and deals
  2. bun run dev       # http://localhost:3000

This copy keeps its records in a Postgres inside the server and signs you straight in.
When you want real services, set DATABASE_URL and your sign-in provider's keys in .env
and choose the rest in src/spool.server.ts.
`)
