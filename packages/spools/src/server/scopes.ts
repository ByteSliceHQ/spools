import { Context, Effect, Layer } from 'effect'

import {
  type ScopeAccess,
  type ScopeGrant,
  type ScopeInfo,
  type ScopeSession,
  SYSTEM_ACCESS,
} from '../crm/scopes'
import {
  type AuthError,
  type ExtensionError,
  fromHook,
  type Invalid,
  type Timeout,
} from './runtime/errors'
import { crmConfig, spool } from './spool'
import { CurrentAccess } from './store/scope'
import type { CrmUser } from './users'

/**
 * Record scopes on the server: who holds which scope (`Scopes`), and running a
 * program as someone (`asUser`), as the server itself (`asSystem`) or with an
 * access worked out some other way (`withAccess`). What a scope is, is in
 * src/crm/scopes.ts; where it is enforced, in src/server/store/scope.ts.
 *
 * STATUS: design checkpoint. The signatures are the proposed ones; `asUser`
 * and `mintGrant` do nothing yet. tests/integration/scopes-*.test.ts say what
 * they have to do.
 */

type Failure = AuthError | Timeout | ExtensionError

/**
 * Who holds which scope, and every scope there is. Answered by `scopes` in the
 * app's src/app/extensions.ts when it has one, else by the auth adapter (Clerk
 * organizations), else nobody holds anything. Tests use `Scopes.layerTest`.
 */
export class Scopes extends Context.Service<
  Scopes,
  {
    /** The scopes a person holds, each with a role from `scopes.roles` in the config. */
    readonly grants: (user: CrmUser) => Effect.Effect<ScopeGrant[], Failure>
    /** Every scope, for the switcher of someone whose role reaches all of them. */
    readonly list: Effect.Effect<ScopeInfo[], Failure>
  }
>()('spools/Scopes') {
  /** The app's own resolver (`scopes` in src/app/extensions.ts), read each time it is asked. */
  static readonly layer = Layer.succeed(
    Scopes,
    Scopes.of({
      grants: (user) => {
        const own = spool().extensions.scopes
        return own ? fromHook('scopes.grants', () => own.grants(user)) : Effect.succeed([])
      },
      list: Effect.suspend(() => {
        const own = spool().extensions.scopes?.list
        return own ? fromHook('scopes.list', () => own()) : Effect.succeed([])
      }),
    }),
  )

  /** These people hold these scopes, by user id, and nobody else holds any (tests, the development sign-in). */
  static readonly layerTest = (
    held: Readonly<Record<string, readonly ScopeGrant[]>>,
    scopes: readonly ScopeInfo[] = [],
  ) =>
    Layer.succeed(
      Scopes,
      Scopes.of({
        grants: (user) =>
          Effect.sync(() => [...(Object.hasOwn(held, user.id) ? (held[user.id] ?? []) : [])]),
        list: Effect.sync(() => [...scopes]),
      }),
    )
}

/** Whether this Spool has scopes at all (`scopes` in crm.config.json). */
export const scopesOn = (): boolean => crmConfig().scopes !== undefined

/** Runs a program with this access, whatever was set outside it. */
export const withAccess =
  (access: ScopeAccess) =>
  <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(program, CurrentAccess, access)

/**
 * Runs a program as the server itself: every scope, read and write. For work
 * nobody is signed in for (finding the sequence emails that are due, a
 * backfill, a seed script). Each use is a place where scopes don't apply, so
 * there should be few, and each should say why.
 */
export const asSystem = withAccess(SYSTEM_ACCESS)

/**
 * Runs a program as a person: with what `Scopes` says they hold, narrowed to
 * the scope they asked to work in (`wanted`: a scope key, or null for all of
 * theirs). A scope they don't hold is never taken on their word: they get the
 * first one they do hold. The boundary does this for every signed-in request.
 *
 * Not enforced yet: this is the program it was given.
 */
export const asUser =
  (_user: CrmUser, _wanted?: string | null) =>
  <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E | Failure, R | Scopes> =>
    program

/** The cookie that says which scope a person asked to work in. A preference, never proof: `asUser` checks it against what they hold. */
export const SCOPE_COOKIE = 'spools-scope'

/**
 * The scope a request asks to work in, from its `SCOPE_COOKIE`: a scope's key,
 * null for "all of mine" (`*`), undefined when it doesn't say. An auth adapter
 * whose sessions carry one (Clerk's active organization) answers first.
 *
 * Not read yet: no request says.
 */
export const wantedScope = (_headers: Headers): string | null | undefined => undefined

/**
 * What the browser is told about a person's scopes, with the session: the ones
 * they may switch between, the one that is active, and whether they can write.
 * Null in a Spool without scopes.
 *
 * Not worked out yet.
 */
export const scopeSession = (
  _user: CrmUser,
  _wanted?: string | null,
): Effect.Effect<ScopeSession | null, Failure, Scopes> => Effect.succeed(null)

/** The header a call to the tool API carries its grant in. */
export const GRANT_HEADER = 'x-spools-grant'

/**
 * A signed, short-lived statement of an access, for a call that has nobody
 * signed in: the tool API. The server makes one when it starts a workflow or
 * passes a chat message on, and the tool route reads it back from
 * `GRANT_HEADER`. Signed with `APP_SECRET`, like an unsubscribe link, so
 * neither a workflow nor the model can widen it.
 *
 * Not made yet: this is an empty grant, which the tool route must refuse.
 */
export const mintGrant = (
  _access: ScopeAccess,
  _options: { userId?: string; ttlMs?: number } = {},
): Effect.Effect<string, Invalid> => Effect.succeed('')
