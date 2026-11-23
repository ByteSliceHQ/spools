import { APIError } from 'better-auth/api'
import { betterAuth as createAuth } from 'better-auth/minimal'
import { magicLink } from 'better-auth/plugins/magic-link'
import { Effect, Layer, Option, Schema } from 'effect'

import { isProvider, PROVIDERS, type ProviderId, splitScopes } from '../../../crm/mailbox'
import { Auth, type AuthAdapter, type AuthUser as Person } from '../../../server/runtime/auth'
import {
  AuthError,
  type DatabaseError,
  messageOf,
  type Timeout,
} from '../../../server/runtime/errors'
import { policies, withPolicy } from '../../../server/runtime/policies'
import { asc, desc, oneOf } from '../../../server/store/query'
import { Store } from '../../../server/store/store'
import { isAllowed } from '../../../server/users'
import { storeDatabase } from './database'
import { sendLink } from './links'
import { type Renewal, renewal, socialProviders } from './providers'
import { features, google, microsoft, requirements, type Settings, settings } from './settings'
import { API, LINK_MINUTES, REFUSED, SIGN_IN } from './shared'
import { AuthAccount, AuthUser, authTables } from './tables'

/**
 * Sign-in with Better Auth (https://better-auth.com), run by this server and
 * kept in the Spool's own database: no outside sign-in service. The only code
 * that uses Better Auth is in this folder; the browser half is client.tsx.
 *
 * People sign in with a link sent to their address, or with Google or Microsoft
 * when those are set up (settings.ts names the variables). There are no
 * passwords. Only someone on the config's access list is sent a link or gets an
 * account, and the list is checked again on every request (src/server/users.ts).
 */

const THIRTY_DAYS = 30 * 24 * 60 * 60

export type BetterAuthAdapterOptions = {
  /**
   * How long asking for a link takes to answer, in milliseconds. Every answer
   * takes the same time, so it doesn't tell whether a link was sent. Default 800.
   */
  answerAfter?: number
}

/**
 * Whether someone may have an account. Refused before anything is stored, for
 * every way of signing in. Unverified comes first: the answer to somebody who
 * hasn't shown that an address is theirs says nothing about the access list.
 */
export function admit(user: { email: string; emailVerified: boolean }): void {
  if (!user.emailVerified) {
    throw new APIError('FORBIDDEN', {
      code: REFUSED.unverified,
      message: "That address hasn't been verified.",
    })
  }

  if (!isAllowed(user.email)) {
    throw new APIError('FORBIDDEN', {
      code: REFUSED.notAllowed,
      message: 'That address may not use this CRM.',
    })
  }
}

const build = (current: Settings, answerAfter: number) =>
  createAuth({
    secret: current.secret,
    baseURL: current.origin,
    basePath: API,
    trustedOrigins: [current.origin],
    database: storeDatabase,
    plugins: [
      magicLink({
        expiresIn: LINK_MINUTES * 60,
        // The database holds a hash: reading it doesn't give anyone a link that works.
        storeToken: 'hashed',
        sendMagicLink: async ({ email, token }) => {
          // Not waited for: the answer takes the same time whether there is an email to send or not,
          // and is the same if sending it fails.
          void sendLink(email, token, current.origin)
          await new Promise((resolve) => setTimeout(resolve, answerAfter))
        },
      }),
    ],
    socialProviders: socialProviders(current),
    session: {
      // Thirty days from signing in, however much they are used: `session` below can't set a cookie to extend one.
      expiresIn: THIRTY_DAYS,
      disableSessionRefresh: true,
      // Every request reads the session from the database, so signing out takes effect at once.
      cookieCache: { enabled: false },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // An account is matched with a person by address only when both sides have verified it.
        trustedProviders: [],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        // Someone who started with links by email gets their name when they add Google or Microsoft.
        updateUserInfoOnLink: true,
      },
      additionalFields: { email: { type: 'string', required: false } },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            admit(user)

            // Anyone may ask for a link to someone else's address, so the name sent along isn't theirs.
            if (context?.path === '/magic-link/verify') {
              return { data: { name: '' } }
            }

            return undefined
          },
        },
      },
      account: {
        // Identity tokens aren't kept: they are read once and nothing needs them again.
        create: { before: async () => ({ data: { idToken: undefined } }) },
        update: { before: async () => ({ data: { idToken: undefined } }) },
      },
    },
    // Kept in this process's memory, so each server counts for itself and a restart forgets. That is enough
    // to slow someone down; what protects an account is that a link's token can't be guessed.
    rateLimit: {
      enabled: true,
      storage: 'memory',
      customRules: {
        '/sign-in/magic-link': { window: 60, max: 5 },
        '/magic-link/verify': { window: 60, max: 10 },
        '/sign-in/social': { window: 60, max: 10 },
        '/link-social': { window: 60, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: 'spools',
      useSecureCookies: current.origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      // Said out loud, because Better Auth leaves the first out when it thinks it is being tested.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      database: { generateId: 'uuid' },
    },
    onAPIError: { errorURL: `${current.origin}${SIGN_IN}` },
    telemetry: { enabled: false },
  })

type Instance = ReturnType<typeof build>

// ── The directory ───────────────────────────────────────────────────────────

type UserRow = NonNullable<(typeof AuthUser)['row']>
type AccountRow = NonNullable<(typeof AuthAccount)['row']>

/** A person as the CRM reads them. Pure, so it can be tested without Better Auth. */
export function toPerson(
  user: Pick<UserRow, 'id' | 'name' | 'email' | 'emailVerified'>,
  accounts: readonly Pick<AccountRow, 'providerId' | 'email' | 'scope'>[],
): Person {
  return {
    id: user.id,
    name: user.name || null,
    // The access list trusts this address, so one that hasn't been verified is no address.
    email: user.emailVerified ? user.email : null,
    accounts: accounts.map((a) => ({
      provider: a.providerId,
      email: a.email ?? '',
      scopes: splitScopes(a.scope),
    })),
  }
}

const unavailable = (error: DatabaseError | Timeout): AuthError =>
  new AuthError({ message: error.message, kind: 'unavailable' })

const labelOf = (provider: string) => (isProvider(provider) ? PROVIDERS[provider].label : provider)

/** Whether a provider's client id and secret are set. */
const isSetUp = { google: () => !!google(), microsoft: () => !!microsoft() } satisfies Record<
  ProviderId,
  () => boolean
>

/** The HTTP status a provider answered with; a request that got no answer has none. */
const AnsweredStatus = Schema.Struct({ status: Schema.Finite })

/** OAuth's words for a client id or secret that is wrong, or isn't allowed to renew tokens. */
const ClientError = Schema.Struct({
  error: Schema.Literals(['invalid_client', 'unauthorized_client']),
})

const statusOf = (cause: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(AnsweredStatus)(cause))?.status

/** Why there is no token, in words a teammate can act on. `refused` is what the provider said, if it was asked. */
export function tokenRefusal(provider: string, refused?: { cause: unknown }): AuthError {
  const label = labelOf(provider)
  const status = statusOf(refused?.cause)

  // Not reached, busy or broken: tried again, and not this account's fault.
  if (refused && (status === undefined || status === 429 || status >= 500)) {
    return new AuthError({
      message: `${label} could not be reached. Try again in a moment.`,
      kind: 'unavailable',
    })
  }

  if (Schema.is(ClientError)(refused?.cause)) {
    return new AuthError({
      message: `${label} doesn't accept this CRM's client id and secret.`,
      kind: 'setup',
    })
  }

  return new AuthError({
    message: `The CRM's access to this ${label} account has run out. Reconnect it from your mailbox panel.`,
    kind: 'account',
  })
}

const directory = (instance: () => Instance) => {
  /** One try at a token. Better Auth renews it first when it has run out. */
  const token = (provider: string, body: { accountId: string; userId: string }) =>
    Effect.gen(function* () {
      const auth = yield* Effect.try({
        try: instance,
        catch: (cause) => new AuthError({ message: messageOf(cause), kind: 'setup' }),
      })

      const box: Renewal = {}

      const found = yield* Effect.tryPromise({
        try: () => renewal.run(box, () => auth.api.getAccessToken({ body })),
        catch: () =>
          tokenRefusal(
            provider,
            Object.hasOwn(box, 'refused') ? { cause: box.refused } : undefined,
          ),
      })

      // Run out, and there was nothing to renew it with.
      const ends = found.accessTokenExpiresAt?.getTime()

      if (ends !== undefined && ends <= Date.now()) {
        return yield* tokenRefusal(provider)
      }

      return found.accessToken || null
    })

  return Layer.effect(
    Auth,
    Effect.gen(function* () {
      const store = yield* Store

      const accountsOf = (userIds: readonly string[]) =>
        store
          .find(AuthAccount, {
            filter: oneOf('userId', userIds),
            select: ['userId', 'providerId', 'email', 'scope'],
            order: [asc('createdAt')],
          })
          .pipe(Effect.mapError(unavailable))

      return Auth.of({
        getUser: Effect.fn('BetterAuth.getUser')(function* (id) {
          const user = yield* store
            .first(AuthUser, { where: { id } })
            .pipe(Effect.mapError(unavailable))

          if (!user) {
            return yield* new AuthError({ message: "That person doesn't exist", kind: 'answer' })
          }

          return toPerson(user, yield* accountsOf([id]))
        }),

        listUsers: Effect.gen(function* () {
          const users = yield* store
            .find(AuthUser, { order: [asc('createdAt'), asc('id')], limit: 200 })
            .pipe(Effect.mapError(unavailable))

          const accounts = yield* accountsOf(users.map((u) => u.id))
          return users.map((u) =>
            toPerson(
              u,
              accounts.filter((a) => a.userId === u.id),
            ),
          )
        }).pipe(Effect.withSpan('BetterAuth.listUsers')),

        accountToken: Effect.fn('BetterAuth.accountToken')(function* (userId, provider) {
          const account = yield* store
            .first(AuthAccount, {
              where: { userId, providerId: provider },
              order: [desc('updatedAt')],
              select: ['id'],
            })
            .pipe(Effect.mapError(unavailable))

          if (!account) {
            return null
          }

          if (!isProvider(provider) || !isSetUp[provider]()) {
            return yield* new AuthError({
              message: `Signing in with ${labelOf(provider)} is no longer set up on this CRM.`,
              kind: 'setup',
            })
          }

          return yield* token(provider, { accountId: account.id, userId }).pipe(
            withPolicy(
              { ...policies.oauth, service: labelOf(provider) },
              (error) => error.kind === 'unavailable',
            ),
          )
        }),
      })
    }),
  )
}

// ── Requests ────────────────────────────────────────────────────────────────

/**
 * What is answered under /api/auth. The rest of what Better Auth can do there
 * is for things this adapter doesn't offer (passwords, changing an address), or
 * would hand a script on the page what it has no need of: the session's token,
 * an access token to someone's mailbox.
 */
const ANSWERED = new Set([
  'POST /sign-in/magic-link',
  'GET /magic-link/verify',
  'POST /sign-in/social',
  'GET /callback/google',
  'GET /callback/microsoft',
  'POST /link-social',
  'GET /list-accounts',
  'POST /sign-out',
])

/** Sign-in with Better Auth, kept in the Spool's own database. */
export function betterAuth({ answerAfter = 800 }: BetterAuthAdapterOptions = {}): AuthAdapter {
  let built: { key: string; auth: Instance } | undefined

  // Made on first use, and again if the settings change: a build reads no variables, and a value fixed
  // while the server runs takes effect at once.
  const instance = (): Instance => {
    const current = settings()
    const key = JSON.stringify(current)

    if (built?.key !== key) {
      built = { key, auth: build(current, answerAfter) }
    }

    return built.auth
  }

  return {
    id: 'better-auth',
    label: 'Better Auth',
    tables: authTables,
    requires: requirements(),
    features,
    layer: directory(instance),
    session: async (request) => {
      const found = await instance().api.getSession({
        headers: request.headers,
        query: { disableRefresh: true },
      })

      // No identity token: nothing outside this server would know who signed it.
      return found ? { userId: found.user.id, getToken: async () => null } : null
    },
    handle: async (request) => {
      const { pathname } = new URL(request.url)
      const path = pathname.startsWith(`${API}/`) ? pathname.slice(API.length) : ''

      if (request.method === 'GET' && path === '/methods') {
        const methods = { link: true, google: isSetUp.google(), microsoft: isSetUp.microsoft() }
        return Response.json(methods, { headers: { 'Cache-Control': 'no-store' } })
      }

      if (!ANSWERED.has(`${request.method} ${path}`)) {
        return new Response('Not found', { status: 404 })
      }

      return instance().fetch(request)
    },
  }
}
