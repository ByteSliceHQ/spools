import { auth, clerkClient, clerkMiddleware } from '@clerk/tanstack-react-start/server'
import { Effect, Layer, Option, Schema } from 'effect'

import { isProvider, PROVIDERS, splitScopes } from '../../../crm/mailbox'
import type { ScopeGrant, ScopeInfo } from '../../../crm/scopes'
import type { Env } from '../../../server/runtime/adapter'
import { Auth, type AuthAdapter, type AuthUser } from '../../../server/runtime/auth'
import { AuthError, messageOf } from '../../../server/runtime/errors'
import { policies, withPolicy } from '../../../server/runtime/policies'
import { Scopes } from '../../../server/scopes'
import { spool } from '../../../server/spool'

/**
 * Sign-in with Clerk (https://clerk.com). The only server code that uses the
 * Clerk SDK; the browser half is client.tsx.
 *
 *   CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY   from the Clerk dashboard (API keys)
 *
 * Clerk keeps the Google and Microsoft tokens of the accounts people sign in
 * with, so the CRM stores none of its own for them (docs/mailbox.md).
 */

/** The parts of a Clerk user the CRM reads. */
export type ClerkUser = {
  id: string
  firstName: string | null
  lastName: string | null
  primaryEmailAddressId: string | null
  emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[]
  externalAccounts?:
    | { provider: string; emailAddress: string; approvedScopes?: string | null }[]
    | null
}

/**
 * Whether an address is one of Clerk's test addresses (`ada+clerk_test@acme.com`).
 * With test mode on, which it is in every development instance, Clerk marks one
 * verified for anybody who types the code 424242, and sends no email
 * (https://clerk.com/docs/testing/test-emails-and-phones). So it proves nothing
 * about who holds the address.
 */
export const isTestAddress = (email: string) =>
  email.slice(0, email.lastIndexOf('@')).toLowerCase().includes('+clerk_test')

/**
 * A Clerk user as the CRM reads people. Pure, so it can be tested without Clerk.
 * `testAddresses` says whether one of Clerk's test addresses counts as verified:
 * only on a developer's own machine.
 */
export function toAuthUser(u: ClerkUser, testAddresses = false): AuthUser {
  // Only trust verified addresses: an unverified primary email would let anyone claim an allowed domain.
  const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)

  const verified =
    primary?.verification?.status === 'verified' &&
    (testAddresses || !isTestAddress(primary.emailAddress))

  return {
    id: u.id,
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
    email: primary && verified ? primary.emailAddress : null,
    accounts: (u.externalAccounts ?? []).map((a) => ({
      // Clerk names a sign-in method "oauth_google"; its token API calls it "google".
      provider: a.provider.replace(/^oauth_/, ''),
      email: a.emailAddress,
      scopes: splitScopes(a.approvedScopes),
    })),
  }
}

/** The HTTP status of an error Clerk answered with; anything else (a network failure) has none. */
const ClerkStatus = Schema.Struct({ status: Schema.Finite })

/** The codes of an error Clerk answered with, first one first. */
const ClerkCodes = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ code: Schema.optional(Schema.String) })),
})

const statusOf = (cause: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ClerkStatus)(cause))?.status

/** A 4xx (other than 429) is Clerk's answer, not a hiccup: asking again won't change it. */
const transient = (cause: unknown) => {
  const status = statusOf(cause)
  return status === undefined || status === 429 || status >= 500
}

const asAuthError = (cause: unknown) =>
  new AuthError({ message: messageOf(cause), kind: transient(cause) ? 'unavailable' : 'answer' })

/** What Clerk says when it can't hand out a token, in words a teammate can act on. */
export function tokenRefusal(provider: string, cause: unknown): AuthError {
  const code =
    Option.getOrUndefined(Schema.decodeUnknownOption(ClerkCodes)(cause))?.errors[0]?.code ?? ''

  const label = Object.entries(PROVIDERS).find(([id]) => id === provider)?.[1].label ?? provider

  if (code.startsWith('oauth_shared_credentials')) {
    return new AuthError({
      message: `Clerk is using its shared development credentials for ${label}, which can't give the CRM mailbox access. Set up custom credentials for ${label} in Clerk.`,
      kind: 'setup',
    })
  }

  return new AuthError({
    message: `Clerk could not provide a ${label} token${code ? ` (${code})` : ''}. Reconnect the account from your profile.`,
    // A moment's trouble at Clerk is tried again (below); a refusal is this account's.
    kind: transient(cause) ? 'unavailable' : 'account',
  })
}

const call = <A>(
  name: string,
  request: () => Promise<A>,
  refusal: (cause: unknown) => AuthError = asAuthError,
) =>
  Effect.tryPromise({ try: request, catch: refusal }).pipe(
    withPolicy(
      { ...policies.authUsers, service: 'Clerk' },
      (error) => error.kind === 'unavailable',
    ),
    Effect.withSpan(name),
  )

const layer = Layer.sync(Auth, () => {
  // A build is always "production", so a deployment never trusts a test address, whichever keys it has.
  const testAddresses = process.env['NODE_ENV'] !== 'production'
  const read = (user: ClerkUser) => toAuthUser(user, testAddresses)

  return Auth.of({
    getUser: (id) =>
      Effect.map(
        call('Clerk.getUser', () => clerkClient().users.getUser(id)),
        read,
      ),
    listUsers: call('Clerk.listUsers', async () => {
      const { data } = await clerkClient().users.getUserList({ limit: 200, orderBy: '+created_at' })
      return data.map(read)
    }),
    accountToken: (userId, provider) =>
      // The CRM only reads mail from the providers it knows, and those are all Clerk's names too.
      isProvider(provider)
        ? call(
            'Clerk.accountToken',
            async () => {
              const { data } = await clerkClient().users.getUserOauthAccessToken(userId, provider)
              return data[0]?.token || null
            },
            (cause) => tokenRefusal(provider, cause),
          )
        : Effect.fail(
            new AuthError({
              message: `The CRM reads no mail from ${provider} accounts.`,
              kind: 'account',
            }),
          ),
  })
})

const key = (prefix: string) => (value: string) => {
  // The template's placeholder passes a prefix check, but Clerk rejects it on every request with a long stack trace.
  if (value.endsWith('...')) {
    return 'still has the placeholder value from .env.example'
  }

  return value.startsWith(prefix) ? null : `must start with "${prefix}"`
}

/**
 * What to say when a deployment runs on a Clerk development instance. It works,
 * and a staging copy may want it, but such an instance is for testing: its
 * sign-in pages say so, and its test mode is on.
 */
export const developmentInstance = (env: Env): string | null =>
  env['NODE_ENV'] === 'production' && env['CLERK_SECRET_KEY']?.startsWith('sk_test_')
    ? "on a Clerk development instance (CLERK_SECRET_KEY starts with sk_test_). Use the production instance's keys where real people sign in"
    : null

/** The parts of a Clerk organization membership that record scopes read. */
export type ClerkMembership = {
  role: string
  organization: { id: string; slug?: string | null; name: string }
}

/** The scope a Clerk organization is: its slug, which is what a record's scope field holds, or its id without one. */
export const organizationScope = (organization: ClerkMembership['organization']): string =>
  organization.slug || organization.id

/**
 * A person's organization memberships as record scopes. The scope is the
 * organization's slug and the role is the membership's, without Clerk's `org:`
 * prefix: `org:admin` is the role `admin` in `scopes.roles`. Pure, so it can be
 * tested without Clerk.
 */
export const toGrants = (
  memberships: readonly ClerkMembership[],
  /**
   * The roles that reach every scope, and the organizations a membership must
   * be in for one of them to count. A person can be made anything in an
   * organization they created themselves, so such a role held anywhere else
   * gives nothing.
   */
  everyScope?: { roles: readonly string[]; from: readonly string[] },
): ScopeGrant[] =>
  memberships.flatMap((m) => {
    const grant = { scope: organizationScope(m.organization), role: m.role.replace(/^org:/, '') }
    const reachesAll = everyScope?.roles.includes(grant.role) ?? false
    return reachesAll && !everyScope?.from.includes(grant.scope) ? [] : [grant]
  })

/** The organizations a role that reaches every scope counts from (`everyScopeFrom`), set when the adapter is made. */
let everyScopeOrganizations: readonly string[] | undefined
const everyScopeFrom = () => everyScopeOrganizations

/** Who holds which record scope, from Clerk organizations. */
const organizations = Layer.succeed(
  Scopes,
  Scopes.of({
    grants: (user) =>
      call('Clerk.organizationMemberships', async () => {
        const { data } = await clerkClient().users.getOrganizationMembershipList({
          userId: user.id,
          limit: 100,
        })

        const from = everyScopeFrom()

        const roles = Object.entries(spool().config.scopes?.roles ?? {})
          .filter(([, role]) => role.all)
          .map(([name]) => name)

        return toGrants(data, from && { roles, from })
      }),
    list: call('Clerk.organizations', async () => {
      const { data } = await clerkClient().organizations.getOrganizationList({ limit: 100 })
      return data.map((o): ScopeInfo => ({ key: organizationScope(o), label: o.name }))
    }),
  }),
)

export type ClerkOptions = {
  /**
   * `"organizations"`: in a Spool with record scopes, a person holds the scope
   * of each Clerk organization they belong to, with their role in it, and the
   * organization active in their session is the scope they are working in.
   */
  scopes?: 'organizations'
  /**
   * The organizations (by slug) in which a role that reaches every scope
   * counts, e.g. `['head-office']`. Set it: without it such a role counts from
   * any organization, and someone who can create an organization can give
   * themselves any role in it. Turn organization creation by users off in
   * Clerk as well.
   */
  everyScopeFrom?: string[]
}

/** Sign-in with Clerk. */
export const clerk = (options: ClerkOptions = {}): AuthAdapter => {
  everyScopeOrganizations = options.everyScopeFrom
  return clerkAdapter(options)
}

const clerkAdapter = (options: ClerkOptions): AuthAdapter => ({
  id: 'clerk',
  label: 'Clerk',
  middleware: clerkMiddleware(),
  session: async () => {
    const { userId, getToken, orgSlug, orgId } = await auth()

    if (!userId) {
      return null
    }

    const session = { userId, getToken: (asked: { template: string }) => getToken(asked) }
    // With organizations as scopes, the active one is where this person is working. With none active, the cookie says.
    const active = options.scopes === 'organizations' ? (orgSlug ?? orgId) : undefined
    return active ? { ...session, scope: active } : session
  },
  scopes: options.scopes === 'organizations' ? organizations : undefined,
  layer,
  requires: [
    { name: 'CLERK_SECRET_KEY', check: key('sk_') },
    { name: 'CLERK_PUBLISHABLE_KEY', check: key('pk_') },
  ],
  features: [{ name: 'Sign-in with Clerk', vars: [], check: developmentInstance }],
})
