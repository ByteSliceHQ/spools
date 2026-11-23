import { Context, Effect, Layer } from 'effect'

import { type ProviderId, providerOf } from '../crm/mailbox'
import { Auth } from './runtime/auth'
import { MailboxError, type StaffError } from './runtime/errors'
import { type CrmUser, Users } from './users'

/**
 * The mailboxes teammates sign in with, as the mail code sees them: which
 * Google and Microsoft accounts each CRM user signs in with, what each has
 * granted, and a current access token for one. The auth provider holds the
 * tokens; the CRM stores none for these accounts.
 *
 * Tests replace the whole thing with `SignIns.layerTest({ ... })`.
 */

export type MailboxAccount = {
  userId: string
  /** The teammate's name, as shown on timelines. */
  name: string
  provider: ProviderId
  accountEmail: string
  /** What the account has granted. Empty for a connected mailbox that has to be connected again. */
  scopes: string[]
  /** Set when the mailbox was connected on the Integrations page; absent for the sign-in account. */
  connectionId?: string
  /** A connected mailbox whose provider turned the stored grant down. */
  needsReconnect?: boolean
}

const toAccounts = (
  user: CrmUser,
  accounts: { provider: string; email: string; scopes: string[] }[],
) =>
  accounts.flatMap((a): MailboxAccount[] => {
    const provider = providerOf(a.provider)
    return provider && a.email
      ? [{ userId: user.id, name: user.name, provider, accountEmail: a.email, scopes: a.scopes }]
      : []
  })

type Shape = {
  /** Every CRM user's Google and Microsoft sign-in accounts. */
  readonly all: Effect.Effect<MailboxAccount[], StaffError>
  readonly of: (user: CrmUser) => Effect.Effect<MailboxAccount[], StaffError>
  /** Everyone who may use the CRM, to put a name to a connected mailbox. */
  readonly people: Effect.Effect<CrmUser[], StaffError>
  /** A current access token for a sign-in account, or null when the auth provider has none. */
  readonly token: (
    userId: string,
    provider: ProviderId,
  ) => Effect.Effect<string | null, MailboxError>
}

export class SignIns extends Context.Service<SignIns, Shape>()('crm/SignIns') {
  static readonly layer = Layer.effect(
    SignIns,
    Effect.gen(function* () {
      const users = yield* Users
      const auth = yield* Auth
      return SignIns.of({
        all: Effect.map(users.everyoneWithAccounts, (everyone) =>
          everyone.flatMap(({ user, accounts }) => toAccounts(user, accounts)),
        ),
        of: (user) =>
          Effect.map(users.signInAccounts(user.id), (accounts) => toAccounts(user, accounts)),
        people: users.team,
        token: (userId, provider) =>
          auth.accountToken(userId, provider).pipe(
            Effect.catchTags({
              // The adapter's message says what to do, in words a teammate can act on.
              AuthError: (error) =>
                Effect.fail(
                  new MailboxError({
                    message: error.message,
                    kind: error.kind === 'setup' ? 'setup' : 'account',
                  }),
                ),
              Timeout: (timeout) =>
                Effect.fail(new MailboxError({ message: timeout.message, kind: 'api' })),
            }),
          ),
      })
    }),
  )

  /** Accounts, people and tokens from plain functions (tests). A token function may throw a `MailboxError`. */
  static readonly layerTest = (source: {
    all: () => Promise<MailboxAccount[]>
    of: (user: CrmUser) => Promise<MailboxAccount[]>
    people: () => Promise<CrmUser[]>
    token: (userId: string, provider: ProviderId) => Promise<string | null>
  }) =>
    Layer.succeed(
      SignIns,
      SignIns.of({
        all: Effect.promise(source.all),
        of: (user) => Effect.promise(() => source.of(user)),
        people: Effect.promise(source.people),
        token: (userId, provider) =>
          Effect.tryPromise({
            try: () => source.token(userId, provider),
            catch: (cause) =>
              cause instanceof MailboxError
                ? cause
                : new MailboxError({ message: String(cause), kind: 'api' }),
          }),
      }),
    )
}
