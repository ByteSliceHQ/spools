import { randomBytes } from 'node:crypto'

import type { Feature, Requirement } from '../../../server/runtime/adapter'

/**
 * What the environment says about signing in.
 *
 *   BETTER_AUTH_SECRET   32+ characters: signs session cookies and encrypts stored tokens
 *   APP_URL              the app's public address, e.g. https://crm.example.com
 *
 * In development both may be missing. These switch on more ways to sign in (the
 * Integrations page uses the same ones):
 *
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
 *   MICROSOFT_TENANT_ID  the one organization whose people may sign in (default "common": any)
 */

export type Client = { readonly clientId: string; readonly clientSecret: string }

export type Settings = {
  readonly secret: string
  /** The app's own origin. */
  readonly origin: string
  readonly google: Client | undefined
  readonly microsoft: (Client & { readonly tenant: string }) | undefined
}

/** Read by a name only known when it runs, so a bundler can't replace it with the build-time value. */
export const env = (name: string): string | undefined => process.env[name]?.trim() || undefined

export const inProduction = (): boolean => env('NODE_ENV') === 'production'

const SECRET = {
  name: 'BETTER_AUTH_SECRET',
  check: (value) => (value.trim().length < 32 ? 'must be at least 32 characters' : null),
} satisfies Requirement

const ADDRESS = {
  name: 'APP_URL',
  check: (value) =>
    URL.canParse(value.trim()) && ['http:', 'https:'].includes(new URL(value.trim()).protocol)
      ? null
      : "must be the app's address, like https://crm.example.com",
} satisfies Requirement

/** What must be set. In development only what is set is looked at: there is a stand-in for the rest. */
export const requirements = (): Requirement[] =>
  [SECRET, ADDRESS].filter(({ name }) => inProduction() || env(name))

export const features: Feature[] = [
  { name: 'Sign in with Google', vars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] },
  { name: 'Sign in with Microsoft', vars: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'] },
]

/** A variable's value, or its stand-in outside production. Signing in doesn't work without one, so there is no going on. */
function required({ name, check }: typeof SECRET | typeof ADDRESS, standIn: () => string): string {
  const value = env(name)

  if (value === undefined) {
    if (inProduction()) {
      throw new Error(`${name} is not set`)
    }

    return standIn()
  }

  const problem = check(value)

  if (problem) {
    throw new Error(`${name} ${problem}`)
  }

  return value
}

const key = Symbol.for('spools.better-auth.secret')

/** The global object, with the one key this module keeps there (only `ownSecret` writes it). */
const kept: typeof globalThis & { [key]?: string } = globalThis

/** A secret for this process only. Kept on `globalThis`, so a dev-server reload doesn't sign everyone out. */
function ownSecret(): string {
  const made = kept[key]

  if (made !== undefined) {
    return made
  }

  const secret = randomBytes(32).toString('hex')
  kept[key] = secret

  console.info(
    '[auth] BETTER_AUTH_SECRET is not set, so everyone is signed out when the server restarts.',
  )

  return secret
}

const client = (idName: string, secretName: string): Client | undefined => {
  const clientId = env(idName)
  const clientSecret = env(secretName)
  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

export const google = (): Client | undefined => client('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')

export const microsoft = (): Settings['microsoft'] => {
  const found = client('MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET')
  return found && { ...found, tenant: env('MICROSOFT_TENANT_ID') ?? 'common' }
}

/** The settings now. Throws, saying which variable is wrong, when people can't be signed in with them. */
export const settings = (): Settings => ({
  secret: required(SECRET, ownSecret),
  origin: new URL(required(ADDRESS, () => 'http://localhost:3000')).origin,
  google: google(),
  microsoft: microsoft(),
})
