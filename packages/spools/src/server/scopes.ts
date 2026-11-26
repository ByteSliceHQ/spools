import { createHmac, timingSafeEqual } from 'node:crypto'

import { Clock, Context, Effect, Layer, Predicate } from 'effect'
import { z } from 'zod'

import {
  accessFrom,
  EVERY_SCOPE,
  type ScopeAccess,
  type ScopeGrant,
  type ScopeInfo,
  scopeKey,
  type ScopeSession,
  SYSTEM_ACCESS,
} from '../crm/scopes'
import { CurrentAccess } from './runtime/access'
import * as config from './runtime/config'
import {
  type AuthError,
  type ExtensionError,
  fromHook,
  Invalid,
  type Timeout,
} from './runtime/errors'
import { crmConfig, objectTable, spool } from './spool'
import type { CrmRecord } from './store/objects'
import type { CrmUser } from './users'

/**
 * Record scopes on the server: who holds which scope (`Scopes`), and running a
 * program as someone (`asUser`), as the server itself (`asSystem`) or with an
 * access worked out some other way (`withAccess`). What a scope is, is in
 * src/crm/scopes.ts; where it is enforced, in src/server/store/scope.ts.
 *
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
    holding:
      | Readonly<Record<string, readonly ScopeGrant[]>>
      | (() => Readonly<Record<string, readonly ScopeGrant[]>>),
    scopes: readonly ScopeInfo[] = [],
  ) =>
    Layer.succeed(
      Scopes,
      Scopes.of({
        grants: (user) =>
          Effect.sync(() => {
            const held = Predicate.isFunction(holding) ? holding() : holding
            return [...(Object.hasOwn(held, user.id) ? (held[user.id] ?? []) : [])]
          }),
        list: Effect.sync(() => [...scopes]),
      }),
    )
}

/**
 * The access of work done for one record, with nobody signed in: a sequence's
 * next email, which reads its record and writes on its timeline. It reaches the
 * record's scope and nothing else. A row with no scope (written before scopes
 * were turned on, and not backfilled) is the system's to deal with: whatever it
 * writes is still stamped from its record.
 */
export const scopeOnly = (scope: string | null): ScopeAccess =>
  scope === null
    ? SYSTEM_ACCESS
    : { read: [scope], write: [scope], active: scope === EVERY_SCOPE ? null : scope }

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

/** What a person may reach, working in `wanted`: from what `Scopes` says they hold and the config's roles. */
export const accessOf = Effect.fn('scopes.accessOf')(function* (
  user: CrmUser,
  wanted?: string | null,
) {
  const grants = yield* (yield* Scopes).grants(user)
  return accessFrom(crmConfig().scopes?.roles ?? {}, grants, wanted)
})

/**
 * Runs a program as a person: with what `Scopes` says they hold, narrowed to
 * the scope they asked to work in (`wanted`: a scope key, or null for all of
 * theirs). A scope they don't hold is never taken on their word: they get the
 * first one they do hold. The boundary does this for every signed-in request.
 * In a Spool without scopes there is nothing to narrow, and nobody is asked.
 */
export const asUser =
  (user: CrmUser, wanted?: string | null) =>
  <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E | Failure, R | Scopes> =>
    scopesOn()
      ? Effect.flatMap(accessOf(user, wanted), (access) => withAccess(access)(program))
      : program

/** The cookie that says which scope a person asked to work in. A preference, never proof: `asUser` checks it against what they hold. */
export const SCOPE_COOKIE = 'spools-scope'

/**
 * The scope a request asks to work in, from its `SCOPE_COOKIE`: a scope's key,
 * null for "all of mine" (`*`), undefined when it doesn't say.
 */
export const wantedScope = (headers: Headers): string | null | undefined => {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')

    if (at < 0 || part.slice(0, at).trim() !== SCOPE_COOKIE) {
      continue
    }

    const raw = part.slice(at + 1).trim()

    try {
      const value = decodeURIComponent(raw)
      return value === EVERY_SCOPE ? null : value || undefined
    } catch {
      return undefined
    }
  }

  return undefined
}

/**
 * What the browser is told about a person's scopes, with the session: the ones
 * they may switch between, the one that is active, and whether they can write.
 * Null in a Spool without scopes.
 */
export const scopeSession = Effect.fn('scopes.scopeSession')(function* (
  user: CrmUser,
  wanted?: string | null,
) {
  const roles = crmConfig().scopes?.roles

  if (!roles) {
    return null
  }

  const scopes = yield* Scopes
  const grants = yield* scopes.grants(user)
  const access = accessFrom(roles, grants, wanted)
  const known = yield* scopes.list
  const named = (key: string): ScopeInfo => known.find((s) => s.key === key) ?? { key, label: key }
  // Every scope this person could work in: all of them for a role that reaches all, else the ones held.
  const all = accessFrom(roles, grants, null)

  const session: ScopeSession = {
    held: all.read === 'all' ? [...known] : all.read.map(named),
    active: access.active,
    key: scopeKey(access),
    canWrite: access.write === 'all' || access.write.length > 0,
  }

  return session
})

/** The header a call to the tool API carries its grant in. */
export const GRANT_HEADER = 'x-spools-grant'

/** How long a grant is good for unless its maker says otherwise. */
const GRANT_TTL_MS = 60 * 60 * 1000

/** What a grant says, as it is signed: what can be read and written, the active scope, who it was made for, when it ends. */
const grantPayload = z.object({
  r: z.union([z.literal('all'), z.array(z.string()).max(500)]),
  w: z.union([z.literal('all'), z.array(z.string()).max(500)]),
  a: z.string().nullable(),
  u: z.string().optional(),
  e: z.number(),
})

/** The key grants are signed with. A deployment without one makes and takes none. */
const grantSecret = Effect.gen(function* () {
  const secret = yield* config.variable('APP_SECRET')

  if (!secret || secret.length < 32) {
    return yield* new Invalid({
      message: 'APP_SECRET must be set (32+ characters) to sign scope grants',
    })
  }

  return secret
})

const signed = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(`scope-grant:${payload}`).digest('base64url')

/**
 * A signed, short-lived statement of an access, for a call that has nobody
 * signed in: the tool API. The server makes one when it starts a workflow, and
 * the workflow sends it back in `GRANT_HEADER` with each call it makes.
 * Signed with `APP_SECRET`, like an unsubscribe link, so neither a workflow nor
 * a model can widen it; and nothing but this header carries a scope, so nothing
 * a model can put in a tool call switches one. It never carries the system's
 * own access.
 */
export const mintGrant = Effect.fn('scopes.mintGrant')(function* (
  access: ScopeAccess,
  options: { userId?: string; ttlMs?: number } = {},
) {
  const secret = yield* grantSecret
  const now = yield* Clock.currentTimeMillis

  const payload = Buffer.from(
    JSON.stringify({
      r: access.read,
      w: access.write,
      a: access.active,
      u: options.userId,
      e: now + (options.ttlMs ?? GRANT_TTL_MS),
    }),
  ).toString('base64url')

  return `${payload}.${signed(secret, payload)}`
})

/** The access a grant states, or null when it isn't one this server signed, or has run out. */
export const readGrant = Effect.fn('scopes.readGrant')(function* (grant: string | null) {
  const [payload, signature, ...rest] = (grant ?? '').split('.')

  if (!payload || !signature || rest.length > 0) {
    return null
  }

  const secret = yield* Effect.option(grantSecret)

  if (secret._tag === 'None') {
    return null
  }

  const expected = Buffer.from(signed(secret.value, payload))
  const given = Buffer.from(signature)

  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null
  }

  const said = yield* Effect.sync(() => {
    try {
      return grantPayload.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString())).data
    } catch {
      return undefined
    }
  })

  if (!said || said.e <= (yield* Clock.currentTimeMillis)) {
    return null
  }

  const access: ScopeAccess = { read: said.r, write: said.w, active: said.a }
  return access
})

/** The scope of a record of an object, as its row holds it: null for a shared object's, and for one with none. */
export const recordScope = (objectKey: string, record: CrmRecord) => {
  const marker = Object.hasOwn(crmConfig().objects, objectKey)
    ? objectTable(objectKey).scope
    : undefined

  const value = marker?.kind === 'own' ? record[marker.column] : null
  return Predicate.isString(value) && value !== '' ? value : null
}

/**
 * The grant a workflow started for a record is handed: the record's scope, to
 * read, and to write only if whoever started it could. Null in a Spool without
 * scopes, and when nobody said whose work this is: a workflow then has no
 * grant, and its calls to the tool API reach no scoped record.
 */
export const grantFor = Effect.fn('scopes.grantFor')(function* (
  objectKey: string,
  record: CrmRecord,
  options: { userId?: string; ttlMs?: number } = {},
) {
  const access = yield* CurrentAccess

  if (!scopesOn() || !access) {
    return null
  }

  const scope = recordScope(objectKey, record)
  const reads = scope !== null && (access.read === 'all' || access.read.includes(scope))
  const writes = scope !== null && (access.write === 'all' || access.write.includes(scope))

  return yield* mintGrant(
    { read: reads && scope ? [scope] : [], write: writes && scope ? [scope] : [], active: scope },
    options,
  )
})
