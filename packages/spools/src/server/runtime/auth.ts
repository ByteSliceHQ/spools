import type { AnyRequestMiddleware } from '@tanstack/react-start'
import { Context, Effect, Layer } from 'effect'

import type { Scopes } from '../scopes'
import type { Adapter } from './adapter'
import { AuthError, type Timeout } from './errors'

/**
 * Who signs people in. An auth provider (Clerk, the app's own sign-in, the
 * development stand-in) is an adapter with three parts:
 *
 * - the request half: middleware and `session`, which run in the request's own
 *   async context, before any Effect (runtime/boundary.ts);
 * - the directory: `Auth`, an Effect service that reads people and, when the
 *   provider keeps them, access tokens for the accounts they sign in with;
 * - the browser half: the sign-in page, the account button, signing out
 *   (src/crm/ui/auth.tsx). It is passed to the app separately, so the server
 *   half never reaches the browser.
 *
 * Who may use the CRM is not the provider's decision: it is the config's access
 * list, checked in src/server/users.ts against the verified email given here.
 */

/** An account a person signs in with (Google, Microsoft, ...) and what it has granted. */
export type SignInAccount = {
  /** "google", "microsoft", or another provider's own name. */
  provider: string
  email: string
  scopes: string[]
}

/** A person, as the CRM reads them from the auth provider. */
export type AuthUser = {
  id: string
  name: string | null
  /**
   * Their primary address, and only when the provider has verified that it is
   * theirs. The access list trusts it, so an adapter must never put an
   * unverified address here.
   */
  email: string | null
  accounts: SignInAccount[]
}

/** Who is signed in to a request. */
export type Session = {
  readonly userId: string
  /**
   * A signed token that says who this person is, for a service that trusts the
   * auth provider (Swirls federation). `template` names a shape set up with the
   * provider. Null when the provider can't make one.
   */
  readonly getToken: (options: { template: string }) => Promise<string | null>
  /**
   * The record scope this session is working in, when the provider keeps one
   * (Clerk's active organization). Like the scope cookie it is a preference:
   * it is checked against what the person holds. Undefined when it doesn't say.
   */
  readonly scope?: string | null | undefined
}

/** The auth provider's directory: its people, and tokens for the accounts they sign in with. */
export class Auth extends Context.Service<
  Auth,
  {
    readonly getUser: (id: string) => Effect.Effect<AuthUser, AuthError | Timeout>
    /** Up to 200 people, oldest first: the team of a small business. */
    readonly listUsers: Effect.Effect<AuthUser[], AuthError | Timeout>
    /**
     * A current OAuth access token for a person's sign-in account at `provider`,
     * or null when the auth provider keeps none.
     */
    readonly accountToken: (
      userId: string,
      provider: string,
    ) => Effect.Effect<string | null, AuthError | Timeout>
  }
>()('spools/Auth') {
  /** A directory with these people (and, if given, these tokens) and nothing else, for tests. */
  static readonly layerTest = (
    users: AuthUser[],
    tokens: (userId: string, provider: string) => string | null = () => null,
  ) =>
    Layer.succeed(
      Auth,
      Auth.of({
        getUser: (id) => {
          const user = users.find((u) => u.id === id)
          return user
            ? Effect.succeed(user)
            : Effect.fail(new AuthError({ message: 'Not Found', kind: 'answer' }))
        },
        listUsers: Effect.sync(() => [...users]),
        accountToken: (userId, provider) => Effect.sync(() => tokens(userId, provider)),
      }),
    )
}

/** An auth provider behind the `Auth` port, with the half of it that belongs to a request. */
export type AuthAdapter = Adapter<Auth> & {
  /** Middleware the provider needs on every request, if any. */
  readonly middleware?: AnyRequestMiddleware
  /**
   * The session of the request being served, or null. Called in the request's
   * own async context, after the middleware, and never from inside an Effect.
   */
  readonly session: (request: Request) => Promise<Session | null>
  /**
   * Answers requests to `/api/auth/*`, for a provider that runs its sign-in
   * from this server. It checks what it is sent itself: nobody is signed in yet.
   */
  readonly handle?: (request: Request) => Promise<Response>
  /**
   * Who holds which record scope, for a provider that keeps groups of people
   * (Clerk organizations). Used in a Spool with `scopes` in its config, unless
   * the app has a resolver of its own (`scopes` in src/app/extensions.ts).
   */
  readonly scopes?: Layer.Layer<Scopes>
}
