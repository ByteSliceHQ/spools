import { Clock, Context, Effect, Layer } from 'effect'

import { accessFrom } from '../crm/scopes'
import { CurrentAccess } from './runtime/access'
import { Auth, type AuthUser, type SignInAccount } from './runtime/auth'
import type { AuthError, ExtensionError, Timeout } from './runtime/errors'
import { Scopes } from './scopes'
import { crmConfig } from './spool'

/**
 * Who may use the CRM: people the auth provider knows whose verified primary
 * email is on the config's access list (`access.allowedEmails`,
 * `access.allowedDomains`).
 *
 * Answers are kept for a minute, so a page's dozen server calls ask the
 * provider once, and removing someone from the list or from the provider takes
 * effect quickly.
 */

export type CrmUser = { id: string; email: string; name: string }

type Failure = AuthError | Timeout

const TTL_MS = 60 * 1000

/** How many people the resolver is asked about at a time when the team is worked out. */
const ASKED_AT_ONCE = 8

/**
 * Whether an address is on the config's access list. It says nothing about who
 * holds the address: ask only about one that has been verified, or to decide
 * whether to let someone prove that it is theirs.
 */
export function isAllowed(email: string): boolean {
  const lower = email.toLowerCase()
  const { allowedEmails, allowedDomains } = crmConfig().access

  if (allowedEmails.some((e) => e.toLowerCase() === lower)) {
    return true
  }

  // The domain is what follows the last "@": the part before it may hold one too, if quoted.
  const domain = lower.slice(lower.lastIndexOf('@') + 1)
  return lower.includes('@') && allowedDomains.some((d) => d.toLowerCase() === domain)
}

/** The CRM user a person is, or null when their account isn't allowed in. */
export function toCrmUser(u: AuthUser): CrmUser | null {
  // `email` is set only when the provider has verified it (runtime/auth.ts).
  if (!u.email || !isAllowed(u.email)) {
    return null
  }

  return { id: u.id, email: u.email, name: u.name || u.email }
}

export class Users extends Context.Service<
  Users,
  {
    /** The CRM user behind an auth provider's user id, or null when that account isn't allowed in. */
    readonly crmUser: (userId: string) => Effect.Effect<CrmUser | null, Failure>
    /**
     * Everyone who may use the CRM, by name, for owner and assignee pickers. In a
     * Spool with record scopes: the people who share a scope with whoever is
     * asking, and those whose role reaches every scope. Nobody, when nobody said
     * who is asking.
     */
    readonly team: Effect.Effect<CrmUser[], Failure | ExtensionError>
    /** One user's sign-in accounts. Read fresh, so a new grant shows at once. */
    readonly signInAccounts: (userId: string) => Effect.Effect<SignInAccount[], Failure>
    /** Every CRM user with the accounts they sign in with, for the mailbox sync. */
    readonly everyoneWithAccounts: Effect.Effect<
      { user: CrmUser; accounts: SignInAccount[] }[],
      Failure
    >
  }
>()('crm/Users') {
  static readonly layer = Layer.effect(
    Users,
    Effect.gen(function* () {
      const auth = yield* Auth
      const scopes = yield* Scopes
      const people = new Map<string, { user: CrmUser | null; expires: number }>()
      /** The scopes each person holds ('all' for a role that reaches every one), kept as long as the team is. */
      const holding = new Map<string, { held: 'all' | readonly string[]; expires: number }>()

      const heldBy = Effect.fn('Users.heldBy')(function* (user: CrmUser) {
        const now = yield* Clock.currentTimeMillis
        const hit = holding.get(user.id)

        if (hit && hit.expires > now) {
          return hit.held
        }

        const grants = yield* scopes.grants(user)
        const held = accessFrom(crmConfig().scopes?.roles ?? {}, grants, null).read
        holding.set(user.id, { held, expires: now + TTL_MS })
        return held
      })

      let everyone: { users: CrmUser[]; expires: number } | null = null

      const crmUser = Effect.fn('Users.crmUser')(function* (userId: string) {
        const now = yield* Clock.currentTimeMillis
        const hit = people.get(userId)

        if (hit && hit.expires > now) {
          return hit.user
        }

        const user = toCrmUser(yield* auth.getUser(userId))
        people.set(userId, { user, expires: now + TTL_MS })
        return user
      })

      const allowed = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis

        if (everyone && everyone.expires > now) {
          return everyone.users
        }

        const users = (yield* auth.listUsers)
          .flatMap((u) => toCrmUser(u) ?? [])
          .toSorted((a, b) => a.name.localeCompare(b.name))

        everyone = { users, expires: now + TTL_MS }
        return users
      })

      const team = Effect.gen(function* () {
        const users = yield* allowed

        if (!crmConfig().scopes) {
          return users
        }

        const access = yield* CurrentAccess

        if (!access || access.read === 'all') {
          return access ? users : []
        }

        const mine = access.read

        // Whoever holds nothing shares a scope with nobody, and nobody need be asked about.
        if (mine.length === 0) {
          return []
        }

        // What each person holds is kept for a minute (`heldBy`), so the provider is asked once
        // a minute per person at most; when it is asked, it is asked about several people at a
        // time, not one after another: a team's first page doesn't wait for each in turn.
        const held = yield* Effect.forEach(users, heldBy, { concurrency: ASKED_AT_ONCE })

        return users.filter((_, i) => {
          const theirs = held[i] ?? []
          return theirs === 'all' || theirs.some((scope) => mine.includes(scope))
        })
      }).pipe(Effect.withSpan('Users.team'))

      const signInAccounts = Effect.fn('Users.signInAccounts')(function* (userId: string) {
        return (yield* auth.getUser(userId)).accounts
      })

      const everyoneWithAccounts = auth.listUsers.pipe(
        Effect.map((all) =>
          all.flatMap((u) => {
            const user = toCrmUser(u)
            return user ? [{ user, accounts: u.accounts }] : []
          }),
        ),
        Effect.withSpan('Users.everyoneWithAccounts'),
      )

      return Users.of({ crmUser, team, signInAccounts, everyoneWithAccounts })
    }),
  )
}
