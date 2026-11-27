import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { Deferred, Effect, Predicate } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { z } from 'zod'

import { PROVIDERS as MAILBOXES, type ProviderId as MailboxProviderId } from '../crm/mailbox'
import { marketingProviders } from './marketing-providers'
import * as config from './runtime/config'
import { type ExtensionError, fromHook, IntegrationError, type StaffError } from './runtime/errors'
import { type Json, parseJson } from './runtime/json'
import { policies, withPolicy } from './runtime/policies'
import { Vault, VaultError } from './runtime/vault'
import { spool } from './spool'
import { asc, neq, oneOf, or } from './store/query'
import { Store } from './store/store'
import { Integration } from './store/tables'
import { type CrmUser, Users } from './users'

/**
 * Integrations: accounts a teammate connects on the Integrations page, on top of
 * the one they sign in with.
 *
 * Two kinds of provider:
 * - Google and Microsoft are built in, so a teammate can connect a mailbox that
 *   is not their sign-in (a shared inbox, a second address). A connected mailbox
 *   is read and sent from exactly like the sign-in one (src/server/mailbox.ts).
 * - Anything else is added by the app in `integrations` in src/app/extensions.ts
 *   (an accounting system, a phone system). The framework runs the OAuth flow and
 *   keeps the tokens; the app's handlers ask for a token with `getAccessToken`.
 *
 * Unlike the sign-in, where the auth provider holds the tokens, these tokens are the CRM's to
 * keep. They are sealed by the vault before they are stored (runtime/vault.ts)
 * and never leave this module except as a current access token.
 *
 * Whose a connection is:
 * - The teammate's who connected it, unless its provider says otherwise. Nobody
 *   else sees it, uses it or removes it.
 * - The team's (`shared: 'team'`) or one group's (`shared: 'group'`), when the
 *   provider says so: one accounting system for the company, or one per branch.
 *   Everyone on the access list may use it, the provider's `canManage` says who
 *   may connect, replace and disconnect it, and none of that depends on whoever
 *   connected it still being here. The accounts marketing posts through are
 *   shared this way (marketing-providers.ts).
 * The row says which (`shared`, `groupKey`), the tokens are sealed for it, and
 * the signed `state` of a connection in progress carries it.
 *
 * Env (a provider is offered once its client id and secret are set; all need
 * APP_URL, APP_SECRET and a vault):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID (default "common")
 */

export { IntegrationError }

type Env = Record<string, string | undefined>

/** A group of the business a connection can be made for: a branch, a region. */
export type ConnectionGroup = {
  /** What is stored and asked for. A plain string of your choosing: a slug, a record's id. */
  key: string
  /** What people read. */
  label: string
}

type GroupList = readonly (string | { key: string; label?: string })[]

/** A service teammates can connect with OAuth 2 (authorization code with PKCE). */
export type IntegrationProvider = {
  label: string
  /** What connecting gives the CRM, as a short phrase for the Integrations page. */
  description: string
  /** Names of the environment variables that hold the OAuth client id and secret. */
  clientId: string
  clientSecret: string
  authUrl: string | ((env: Env) => string)
  tokenUrl: string | ((env: Env) => string)
  scopes: string[]
  /** Extra query parameters on the authorization request. */
  authParams?: Record<string, string>
  /** How the client proves itself to the token endpoint: in the form body (default) or with HTTP Basic. */
  tokenAuth?: 'body' | 'basic'
  /**
   * Which account was connected: an email address, a company id, whatever tells
   * two connections to this provider apart. `query` is the callback's query
   * string, for providers that name the account there.
   */
  account: (ctx: {
    accessToken: string
    query: URLSearchParams
    /** GET a JSON API with the new access token. */
    get: <T>(url: string) => Promise<T>
  }) => Promise<string | undefined>
  /**
   * Whether a connection needs a refresh token. Most providers issue one, and
   * a connection without it is refused. `optional` is for a provider that
   * gives most apps a long-lived access token and nothing to renew it with:
   * the connection works until that token runs out, then needs reconnecting.
   */
  refreshToken?: 'required' | 'optional'
  /** Endpoint that invalidates a token (RFC 7009), if the provider has one. */
  revokeUrl?: string
  /** Set on the built-in mailboxes: read and send through this mailbox API. */
  mailbox?: MailboxProviderId
  /**
   * Whose a connection to this provider is. Left out, it is the teammate's who
   * connected it, and nobody else's. `team`: everyone's on the access list,
   * whoever connected it (there can be more than one, for different accounts).
   * `group`: one group's, chosen when connecting from `groups`.
   */
  shared?: 'team' | 'group'
  /**
   * For `shared: 'group'`: the groups a connection can be made for, or a function
   * that lists them (your branches, read from wherever you keep them). A key
   * alone is its own label.
   */
  groups?: GroupList | (() => GroupList | Promise<GroupList>)
  /**
   * Who may connect, replace and disconnect a shared connection: their email
   * addresses, or a function asked about one person (and, for a group's
   * connection, the group). Left out, anyone on the access list may. A function
   * that throws lets nobody in. Using a shared connection is never limited by this.
   */
  canManage?:
    | readonly string[]
    | ((user: CrmUser, on: { group: string | null }) => boolean | Promise<boolean>)
  /**
   * For `shared: 'team'`, when connections to this provider were already used by
   * everyone before it said so (as the accounts marketing posts through were):
   * the ones made before are the team's too. Without it they stay with whoever
   * connected them, and connecting the account again is what shares it.
   */
  adoptExisting?: boolean
}

/** Whose a connection is, when it is not one person's. */
type Sharing = 'team' | 'group'

const microsoftBase = (env: Env) =>
  `https://login.microsoftonline.com/${encodeURIComponent(env['MICROSOFT_TENANT_ID'] || 'common')}/oauth2/v2.0`

/** A field of a provider's answer that names the account: a non-empty string, or nothing. */
const accountName = z.string().min(1).optional().catch(undefined)

const GoogleUser = z.object({ email: accountName })
const MicrosoftUser = z.object({ mail: accountName, userPrincipalName: accountName })

const builtIn: Record<MailboxProviderId, IntegrationProvider> = {
  google: {
    label: 'Google',
    description: 'Read Gmail and Google Calendar, and send from this mailbox',
    clientId: 'GOOGLE_CLIENT_ID',
    clientSecret: 'GOOGLE_CLIENT_SECRET',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', ...MAILBOXES.google.read, ...MAILBOXES.google.send],
    // offline + consent: Google only returns a refresh token when both are asked for.
    authParams: { access_type: 'offline', prompt: 'consent' },
    account: async ({ get }) =>
      GoogleUser.safeParse(await get('https://openidconnect.googleapis.com/v1/userinfo')).data
        ?.email,
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    mailbox: 'google',
  },
  microsoft: {
    label: 'Microsoft',
    description: 'Read Outlook mail and calendar, and send from this mailbox',
    clientId: 'MICROSOFT_CLIENT_ID',
    clientSecret: 'MICROSOFT_CLIENT_SECRET',
    authUrl: (env) => `${microsoftBase(env)}/authorize`,
    tokenUrl: (env) => `${microsoftBase(env)}/token`,
    scopes: [
      'openid',
      'email',
      'offline_access',
      'User.Read',
      ...MAILBOXES.microsoft.read,
      ...MAILBOXES.microsoft.send,
    ],
    authParams: { prompt: 'select_account' },
    account: async ({ get }) => {
      const me = MicrosoftUser.safeParse(
        await get('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName'),
      ).data

      return me?.mail ?? me?.userPrincipalName
    },
    mailbox: 'microsoft',
  },
}

/** A provider id is a path segment and a database value: keep it plain. */
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,39}$/

/** A group key is stored, signed into a `state` and shown in an address: no control characters, nothing to trim, not long. */
const GROUP_KEY = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,98}[^\s\p{Cc}])?$/u

/** What is wrong with what a provider says about whose its connections are, or null. */
function sharingProblem(id: string, p: IntegrationProvider): string | null {
  const shared: string | undefined = p.shared

  if (shared !== undefined && shared !== 'team' && shared !== 'group') {
    return `integration "${id}" has \`shared: "${shared}"\`; use "team" or "group", or leave it out`
  }

  if (shared === 'group' && p.groups === undefined) {
    return `integration "${id}" is shared by group and needs \`groups\``
  }

  if (shared !== 'group' && p.groups !== undefined) {
    return `integration "${id}" lists \`groups\` but is not \`shared: "group"\``
  }

  if (shared === undefined && p.canManage !== undefined) {
    return `integration "${id}" has \`canManage\` but is not shared: each person manages their own connection`
  }

  if (shared !== 'team' && p.adoptExisting !== undefined) {
    return `integration "${id}" has \`adoptExisting\`, which is only for \`shared: "team"\``
  }

  return null
}

/**
 * Every provider this app offers: the built-in mailboxes, the accounts its
 * marketing channels post through (marketing-providers.ts), then the app's
 * own. An app's provider replaces a marketing one of the same id.
 */
export function providers() {
  const own = Object.entries(spool().extensions.integrations ?? {}).filter(
    ([id, p]) =>
      PROVIDER_ID.test(id) && !Object.hasOwn(builtIn, id) && sharingProblem(id, p) === null,
  )

  return Object.fromEntries([
    ...Object.entries(builtIn),
    ...Object.entries(marketingProviders()).filter(([id]) => !Object.hasOwn(builtIn, id)),
    ...own,
  ])
}

export const providerIds = (): string[] => Object.keys(providers())
export const isProvider = (id: string): boolean => Object.hasOwn(providers(), id)

/** Problems with the app's own providers, for start-up. Empty when there are none. */
export function validateIntegrations(): string[] {
  return Object.entries(spool().extensions.integrations ?? {}).flatMap(([id, p]) => {
    if (Object.hasOwn(builtIn, id)) {
      return [`integration "${id}" is built in and can't be replaced`]
    }

    if (!PROVIDER_ID.test(id)) {
      return [`integration "${id}" needs an id of lower-case letters, digits, "-" or "_"`]
    }

    return sharingProblem(id, p) ?? []
  })
}

const refuse = (message: string, reconnect = false) =>
  Effect.fail(new IntegrationError({ message, reconnect }))

const provider = (id: string) => {
  const found = Object.hasOwn(providers(), id) ? providers()[id] : undefined
  return found ? Effect.succeed(found) : refuse(`"${id}" is not an integration this CRM offers`)
}

const urlOf = (value: string | ((env: Env) => string), env: Env) =>
  Predicate.isFunction(value) ? value(env) : value

// ── Whose a connection is ───────────────────────────────────────────────────

/**
 * Someone a connection is made, replaced or removed by: the CRM user the
 * boundary checked, or their id alone from a caller that has nothing more. An
 * id alone can't pass a provider's `canManage`, which is a rule about people.
 */
export type Who = string | CrmUser

const idOf = (who: Who) => (Predicate.isString(who) ? who : who.id)
const personOf = (who: Who) => (Predicate.isString(who) ? null : who)

/** The groups a provider's connections can be made for. One whose key can't be stored is left out, as is everything when the app's function fails. */
const groupsOf = Effect.fn('integrations.groupsOf')(function* (id: string, p: IntegrationProvider) {
  const { groups } = p

  if (p.shared !== 'group' || groups === undefined) {
    return []
  }

  const listed = Predicate.isFunction(groups)
    ? yield* fromHook(`integrations.${id}.groups`, () => groups()).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`[integrations] ${id}: its groups could not be listed`, error).pipe(
            Effect.as<GroupList>([]),
          ),
        ),
      )
    : groups

  const found = new Map<string, ConnectionGroup>()

  for (const entry of listed) {
    const group = Predicate.isString(entry)
      ? { key: entry, label: entry }
      : { key: entry.key, label: entry.label || entry.key }

    if (GROUP_KEY.test(group.key) && !found.has(group.key)) {
      found.set(group.key, group)
    }
  }

  return [...found.values()]
})

/**
 * Whether someone may connect, replace or disconnect a provider's shared
 * connection (for a group's, that group's). Everyone the boundary let in may,
 * unless the provider has a rule: then only who it names, and nobody when it
 * can't be asked.
 */
const mayManage = Effect.fn('integrations.mayManage')(function* (
  id: string,
  p: IntegrationProvider | undefined,
  who: Who,
  group: string | null,
) {
  const rule = p?.canManage

  if (rule === undefined) {
    return true
  }

  const person = personOf(who)

  if (!person) {
    return false
  }

  if (!Predicate.isFunction(rule)) {
    const email = person.email.toLowerCase()
    return rule.some((listed) => listed.trim().toLowerCase() === email)
  }

  return yield* fromHook(`integrations.${id}.canManage`, () => rule(person, { group })).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`[integrations] ${id}: canManage failed, so nobody may`, error).pipe(
        Effect.as(false),
      ),
    ),
  )
})

/** The CRM user behind an id, or null: not on the access list, unknown, or the directory can't say. */
const memberOf = (userId: string) =>
  Users.use((users) => users.crmUser(userId)).pipe(Effect.orElseSucceed(() => null))

/** Whether a provider's client id and secret are set in `env`. Unknown providers are not. */
export const providerConfigured = (id: string, env: Env): boolean => {
  const p = Object.hasOwn(providers(), id) ? providers()[id] : undefined
  return !!p && !!env[p.clientId] && !!env[p.clientSecret]
}

/** Whether a provider is set up on this deployment now. */
export const providerReady = (id: string) =>
  Effect.map(config.environment, (env) => providerConfigured(id, env))

/** What stands between a deployment and working integrations, in words. Empty when ready. */
export function problemsIn(env: Env, vaultProblem: string | null): string[] {
  const problems: string[] = []

  if (!env['APP_URL']) {
    problems.push('APP_URL is not set')
  }

  if ((env['APP_SECRET']?.length ?? 0) < 32) {
    problems.push('APP_SECRET must be set (32+ characters)')
  }

  if (vaultProblem) {
    problems.push(vaultProblem)
  }

  return problems
}

/** What stands between this deployment and working integrations, now. */
export const setupProblems = Effect.gen(function* () {
  const vault = yield* Vault
  return problemsIn(yield* config.environment, yield* vault.problem)
})

export const redirectUri = (id: string, env: Env): string =>
  `${(env['APP_URL'] ?? '').replace(/\/+$/, '')}/api/integrations/${id}/callback`

// ── Starting a connection ───────────────────────────────────────────────────

const STATE_TTL_MS = 10 * 60 * 1000
export const OAUTH_COOKIE = 'crm_oauth'

const signer = Effect.gen(function* () {
  const secret = (yield* config.environment)['APP_SECRET']

  if (!secret || secret.length < 32) {
    return yield* refuse('APP_SECRET must be set (32+ characters) to connect accounts')
  }

  return (payload: string) =>
    createHmac('sha256', secret).update(`oauth:${payload}`).digest('base64url')
})

/**
 * What a signed `state` carries: the user, the provider, the nonce and when it
 * expires, and for a shared connection whose it will be (`o`, and the group in
 * `g`). A state that names no owner is for a connection of the user's own.
 */
const State = z.object({
  u: z.string(),
  p: z.string(),
  n: z.string(),
  e: z.number(),
  o: z.enum(['team', 'group']).optional(),
  g: z.string().optional(),
})

type State = z.infer<typeof State>

export type AuthRequest = {
  /** Where to send the browser. */
  url: string
  /** Value for the short-lived, HttpOnly `OAUTH_COOKIE`: ties the callback to this browser. */
  cookie: string
}

/**
 * Checks that a connection may be made for an owner, by this person, now: the
 * provider's connections are that kind, the group is one it lists, and the
 * person may manage it. Asked when a connection is started and again when the
 * provider sends the browser back, because ten minutes pass in between and
 * the answer is the provider's as it stands, not as it was signed.
 */
const checkOwner = Effect.fn('integrations.checkOwner')(function* (
  id: string,
  p: IntegrationProvider,
  who: Who,
  owner: Owner,
) {
  if (owner.shared !== (p.shared ?? null)) {
    return yield* refuse(
      `Who ${p.label} is connected for changed while you were connecting it. Try connecting again.`,
    )
  }

  if (
    owner.shared === 'group' &&
    !(yield* groupsOf(id, p)).some((group) => group.key === owner.group)
  ) {
    return yield* refuse(`That is not a group ${p.label} can be connected for`)
  }

  // A connection of one's own is one's own to make.
  if (owner.shared !== null && !(yield* mayManage(id, p, who, owner.group))) {
    return yield* refuse(`Only the people who manage ${p.label} for this CRM can connect it`)
  }

  return owner
})

/**
 * Build the provider's consent URL for a teammate.
 *
 * The `state` is signed and names the user, so a callback can't be replayed for
 * someone else; a nonce and the PKCE verifier stay in a cookie, so the callback
 * only works in the browser that started it. For a shared provider the state
 * also says whose the connection will be: the team's, or the group in
 * `options.group`. Nothing else ever decides that.
 */
export const createAuthRequest = Effect.fn('integrations.createAuthRequest')(function* (
  id: string,
  who: Who,
  now = Date.now(),
  options: { group?: string } = {},
) {
  const p = yield* provider(id)
  const env = yield* config.environment

  if (!providerConfigured(id, env)) {
    return yield* refuse(`${p.label} isn't set up on this CRM yet`)
  }

  const problems = yield* setupProblems

  if (problems.length > 0) {
    return yield* refuse(`Accounts can't be connected yet: ${problems.join('; ')}`)
  }

  if (p.shared !== 'group' && options.group !== undefined) {
    return yield* refuse(`${p.label} is not connected for one group`)
  }

  if (p.shared === 'group' && !options.group) {
    return yield* refuse(`Choose who to connect ${p.label} for`)
  }

  const owner: Owner =
    p.shared === 'group'
      ? { shared: 'group', group: options.group ?? '' }
      : { shared: p.shared ?? null, group: null }

  yield* checkOwner(id, p, who, owner)

  const sign = yield* signer

  const nonce = randomBytes(16).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const state: State = { u: idOf(who), p: id, n: nonce, e: now + STATE_TTL_MS }

  if (owner.shared !== null) {
    state.o = owner.shared
  }

  if (owner.group !== null) {
    state.g = owner.group
  }

  const payload = Buffer.from(JSON.stringify(state)).toString('base64url')

  const params = new URLSearchParams({
    client_id: env[p.clientId] ?? '',
    redirect_uri: redirectUri(id, env),
    response_type: 'code',
    scope: p.scopes.join(' '),
    state: `${payload}.${sign(payload)}`,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...p.authParams,
  })

  const request: AuthRequest = {
    url: `${urlOf(p.authUrl, env)}?${params}`,
    cookie: `${nonce}.${verifier}`,
  }

  return request
})

/**
 * Check a callback's `state` against its signature, expiry, user and cookie.
 * Returns the PKCE verifier and whose the connection is to be, which the
 * signature covers: the callback has no other say in it.
 */
export const readState = Effect.fn('integrations.readState')(function* (
  id: string,
  state: string | null,
  cookie: string | null | undefined,
  userId: string,
  now = Date.now(),
) {
  const expired = refuse(
    'That sign-in link expired or was opened in another browser. Try connecting again.',
  )

  const sign = yield* signer
  const [payload, signature] = (state ?? '').split('.')

  if (!payload || !signature) {
    return yield* expired
  }

  const given = Buffer.from(signature, 'base64url')
  const expected = Buffer.from(sign(payload), 'base64url')

  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return yield* expired
  }

  const read = State.safeParse(parseJson(Buffer.from(payload, 'base64url').toString()))

  if (!read.success) {
    return yield* expired
  }

  const parsed = read.data
  const [nonce, verifier] = (cookie ?? '').split('.')

  if (
    parsed.p !== id ||
    parsed.u !== userId ||
    parsed.e < now ||
    !nonce ||
    !verifier ||
    parsed.n !== nonce ||
    // A group's state names its group, and no other state names one.
    (parsed.o === 'group') !== (parsed.g !== undefined && parsed.g !== '')
  ) {
    return yield* expired
  }

  const owner: Owner = { shared: parsed.o ?? null, group: parsed.g ?? null }
  return { verifier, ...owner }
})

/** Check a callback's `state` against its signature, expiry, user and cookie. Returns the PKCE verifier. */
export const verifyState = Effect.fn('integrations.verifyState')(function* (
  id: string,
  state: string | null,
  cookie: string | null | undefined,
  userId: string,
  now = Date.now(),
) {
  return (yield* readState(id, state, cookie, userId, now)).verifier
})

// ── Talking to the provider ─────────────────────────────────────────────────

/** The provider can't be reached, or took too long: try again later. */
const unreachable = (label: string) =>
  refuse(`${label} could not be reached. Try again in a moment.`)

/** One request to a provider, with the OAuth time limit and one retry if it can't be reached. Never fails on a status. */
const send = (label: string, request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.execute(request).pipe(
      Effect.flatMap((res) =>
        Effect.map(res.text.pipe(Effect.orElseSucceed(() => '')), (body) => ({
          status: res.status,
          ok: res.status >= 200 && res.status < 300,
          body,
        })),
      ),
      withPolicy(policies.oauth, (error) => error._tag === 'HttpClientError'),
      Effect.catchTags({
        HttpClientError: () => unreachable(label),
        Timeout: () => unreachable(label),
      }),
    )
  })

// ── Tokens ──────────────────────────────────────────────────────────────────

/** What the vault holds for a connection. */
const Credentials = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: z.number(),
})

type Credentials = z.infer<typeof Credentials>

/**
 * Who a connection's tokens are sealed for: the row they are stored on, and no
 * other. Exported for tests.
 *
 * One person's row is named as it always was: its teammate, provider and
 * account. A shared row is named for what it is: the provider and account, and
 * the team or which group. So a row that is turned into a shared one in the
 * database, or moved to another group, no longer opens. Who connected a shared
 * row is not in its name: it is history, and may change while a token is
 * being renewed.
 */
export const ownerOf = (row: {
  userId: string
  provider: string
  account: string
  shared?: string | null
  groupKey?: string
}) =>
  JSON.stringify(
    row.shared
      ? ['shared integration', row.provider, row.account, row.shared, row.groupKey ?? '']
      : ['integration', row.userId, row.provider, row.account],
  )

/**
 * A token endpoint's answer. A field that isn't what it should be is left out
 * on its own; a lifetime some providers send as text still counts.
 */
const TokenResponse = z.object({
  access_token: z.string().optional().catch(undefined),
  refresh_token: z.string().optional().catch(undefined),
  expires_in: z
    .union([z.number(), z.string().transform(Number)])
    .optional()
    .catch(undefined),
  scope: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
})

type TokenResponse = z.infer<typeof TokenResponse>

const tokenRequest = Effect.fn('integrations.tokenRequest')(function* (
  id: string,
  form: Record<string, string>,
) {
  const p = yield* provider(id)
  const env = yield* config.environment
  const clientId = env[p.clientId] ?? ''
  const clientSecret = env[p.clientSecret] ?? ''
  const basic = p.tokenAuth === 'basic'

  const request = HttpClientRequest.post(urlOf(p.tokenUrl, env)).pipe(
    // The client proves itself with HTTP Basic, or else in the form body.
    HttpClientRequest.setHeaders(
      basic
        ? {
            accept: 'application/json',
            authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          }
        : { accept: 'application/json' },
    ),
    HttpClientRequest.bodyUrlParams(
      basic ? { ...form } : { client_id: clientId, client_secret: clientSecret, ...form },
    ),
  )

  const response = yield* send(p.label, request)
  const body: TokenResponse = TokenResponse.safeParse(parseJson(response.body)).data ?? {}

  if (!response.ok || !body.access_token) {
    // The provider's error code is safe to show; its description can echo request details, so it isn't.
    return yield* refuse(
      `${p.label} refused the request${body.error ? ` (${body.error})` : ''}`,
      // A 4xx is an answer about the grant; anything else is the provider having a bad moment.
      response.status >= 400 && response.status < 500,
    )
  }

  return body
})

const toCredentials = (
  token: TokenResponse,
  previous?: Credentials,
  now = Date.now(),
): Credentials => ({
  accessToken: token.access_token ?? '',
  // Google only sends a refresh token on first consent; keep the one we have.
  refreshToken: token.refresh_token ?? previous?.refreshToken ?? null,
  expiresAt: now + (token.expires_in ?? 3600) * 1000,
})

export type Connection = {
  id: string
  /** Who connected it. For a connection that isn't shared, also whose it is. */
  userId: string
  provider: string
  /** Which account at the provider: an email address for a mailbox. */
  account: string
  scopes: string[]
  status: 'connected' | 'error'
  lastError: string | null
  connectedAt: Date
  /** Whose it is, when not `userId`'s alone: everyone's, or one group's. */
  shared: Sharing | null
  /** The group a `group` connection is for. */
  group: string | null
  /**
   * For a shared connection, the name of whoever connected it, as it was then.
   * Null for one made before names were kept (the Integrations page looks those up).
   */
  connectedBy: string | null
}

type Row = {
  id: string
  userId: string
  provider: string
  account: string
  scopes: string
  status: string
  lastError: string | null
  createdAt: Date
  shared: string
  groupKey: string
  connectedByName: string | null
  connectedAt: Date | null
}

type Owner = { shared: Sharing | null; group: string | null }

const PERSONAL: Owner = { shared: null, group: null }

/**
 * Whose a stored connection is, or null for a row that says something this
 * code doesn't know (it is then nobody's: not listed, not used).
 *
 * The row says. One that says nothing is its connector's, except at a provider
 * whose connections were everyone's before rows said so (`adoptExisting`).
 */
function sharingOf(row: Pick<Row, 'provider' | 'shared' | 'groupKey'>): Owner | null {
  if (row.shared === 'team') {
    return { shared: 'team', group: null }
  }

  if (row.shared === 'group') {
    return { shared: 'group', group: row.groupKey }
  }

  if (row.shared !== '') {
    return null
  }

  const p = Object.hasOwn(providers(), row.provider) ? providers()[row.provider] : undefined
  return p?.shared === 'team' && p.adoptExisting === true
    ? { shared: 'team', group: null }
    : PERSONAL
}

const toConnection = (row: Row, owner: Owner, names?: ReadonlyMap<string, string>): Connection => ({
  id: row.id,
  userId: row.userId,
  provider: row.provider,
  account: row.account,
  scopes: row.scopes.split(/\s+/).filter(Boolean),
  status: row.status === 'error' ? 'error' : 'connected',
  lastError: row.lastError,
  connectedAt: (owner.shared && row.connectedAt) || row.createdAt,
  shared: owner.shared,
  group: owner.group,
  connectedBy: owner.shared ? (row.connectedByName ?? names?.get(row.userId) ?? null) : null,
})

/** Rows as connections: those of a provider this CRM still offers, each with whose it is. */
const owned = (rows: readonly Row[]) =>
  rows.flatMap((row) => {
    const owner = isProvider(row.provider) ? sharingOf(row) : null
    return owner ? [{ row, owner }] : []
  })

/**
 * Names for shared connections that don't carry their connector's (ones made
 * before rows did): whoever is on the team now. The directory is only asked
 * when such a row is there, and a connection is shown without a name when it can't say.
 */
const namesFor = Effect.fn('integrations.namesFor')(function* (
  connections: readonly { row: Row; owner: Owner }[],
) {
  if (!connections.some(({ row, owner }) => owner.shared && row.connectedByName === null)) {
    return new Map<string, string>()
  }

  const team = yield* Users.use((users) => users.team).pipe(
    Effect.orElseSucceed((): CrmUser[] => []),
  )

  return new Map(team.map((u) => [u.id, u.name]))
})

/** Which account a new access token belongs to, asked of the provider through its own `account` function. */
const accountOf = Effect.fn('integrations.accountOf')(function* (
  p: IntegrationProvider,
  accessToken: string,
  query: URLSearchParams,
) {
  const context = yield* Effect.context<HttpClient.HttpClient>()

  const get = <T = Json>(url: string): Promise<T> =>
    Effect.runPromiseWith(context)(
      send(
        p.label,
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json',
          }),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? // SAFETY: `get<T>` is part of the app's provider contract: the app names the shape of
              // the answer it asked for and reads it in its own `account` function. Built-in
              // providers ask for `Json` and parse it with a schema.
              Effect.succeed(parseJson(response.body) as T)
            : refuse(`Could not read the ${p.label} account`),
        ),
      ),
    )

  const account: string | undefined = yield* fromHook(`integrations.${p.label}.account`, () =>
    p.account({ accessToken, query, get }),
  ).pipe(
    // The provider's own words for a failed read are already written for the teammate.
    Effect.catchTag(
      'ExtensionError',
      (error): Effect.Effect<never, IntegrationError | ExtensionError> =>
        error.cause instanceof IntegrationError ? Effect.fail(error.cause) : Effect.fail(error),
    ),
  )

  return account?.trim().toLowerCase()
})

/**
 * Finish a connection: trade the code for tokens, find out which account it is,
 * encrypt the tokens and store them. Connecting the same account again replaces
 * its stored tokens.
 *
 * Whose the connection is comes from the signed state alone. A shared one
 * replaces the team's (or that group's) connection to the same account whoever
 * made it, keeping its id, and records who connected it now. If there is none
 * but this person connected the account for themselves before the provider was
 * shared, that connection becomes the shared one.
 */
export const completeAuth = Effect.fn('integrations.completeAuth')(function* (
  id: string,
  input: {
    code: string
    state: string | null
    cookie: string | null | undefined
    query?: URLSearchParams
  },
  who: Who,
  now = Date.now(),
) {
  const p = yield* provider(id)
  const env = yield* config.environment
  const userId = idOf(who)
  const { verifier, ...owner } = yield* readState(id, input.state, input.cookie, userId, now)
  // Before the code is spent: a flow that may not finish asks the provider for nothing.
  yield* checkOwner(id, p, who, owner)

  const token = yield* tokenRequest(id, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: redirectUri(id, env),
    code_verifier: verifier,
  })

  if (!token.refresh_token && p.refreshToken !== 'optional') {
    return yield* refuse(
      `${p.label} didn't grant ongoing access. Remove this CRM from your ${p.label} account's connected apps, then connect again.`,
    )
  }

  const account = yield* accountOf(
    p,
    token.access_token ?? '',
    input.query ?? new URLSearchParams(),
  )

  if (!account) {
    return yield* refuse(`Could not tell which ${p.label} account was connected`)
  }

  // Sealed before anything is written: if encryption fails, nothing is stored.
  const where = {
    userId,
    provider: id,
    account,
    shared: owner.shared ?? '',
    groupKey: owner.group ?? '',
  }

  const vault = yield* Vault
  const credentials = yield* vault.seal(toCredentials(token, undefined, now), ownerOf(where))
  const store = yield* Store

  const row = {
    credentials,
    scopes: token.scope ?? p.scopes.join(' '),
    status: 'connected',
    lastError: null,
  }

  if (owner.shared === null) {
    const existing = yield* store.first(Integration, { where })

    if (existing) {
      yield* store.update(Integration, { where: { id: existing.id } }, row)
    } else {
      yield* store.insert(Integration, { ...where, ...row })
    }
  } else {
    const connected = owned(
      yield* store.find(Integration, {
        where: { provider: id, account },
        order: [asc('createdAt')],
      }),
    )

    // The team's (or the group's) connection to this account, whoever connected it, and
    // whether its row says so or it is one of a provider whose rows were always the team's.
    const candidates = connected.filter(
      (c) => c.owner.shared === owner.shared && c.owner.group === owner.group,
    )

    // Failing that, this person's own connection to the account, from before the provider was
    // shared: connecting it for the team is how they hand it over, and nobody else's is touched.
    const mine = connected.find((c) => c.owner.shared === null && c.row.userId === userId)
    const existing = (candidates.find((c) => c.row.userId === userId) ?? candidates[0] ?? mine)?.row

    const shared = {
      ...row,
      connectedByName: personOf(who)?.name ?? null,
      connectedAt: new Date(now),
    }

    if (existing) {
      // The row becomes this person's connection for the team: the tokens were sealed for exactly that.
      yield* store.update(Integration, { where: { id: existing.id } }, { ...where, ...shared })
    } else {
      yield* store.insert(Integration, { ...where, ...shared })
    }
  }

  const saved = yield* store.first(Integration, { where })

  if (!saved) {
    return yield* refuse('The connection could not be saved')
  }

  return toConnection(saved, owner)
})

/** A teammate's own connections. Tokens never leave this module. */
export const listConnections = Effect.fn('integrations.listConnections')(function* (
  userId: string,
) {
  const store = yield* Store
  const rows = yield* store.find(Integration, { where: { userId }, order: [asc('createdAt')] })

  // What they connected for the team is the team's, and listed with it.
  return owned(rows)
    .filter(({ owner }) => owner.shared === null)
    .map(({ row, owner }) => toConnection(row, owner))
})

/**
 * Whether a person may use each of these connections: their own, or a shared
 * one when they are on the access list. This is the one place that decides it.
 *
 * A group's connection is anyone's on the access list. When people come to
 * hold groups, whether this person holds `owner.group` is asked here.
 */
const usableBy = Effect.fn('integrations.usableBy')(function* <
  T extends { row: Row; owner: Owner },
>(who: Who, connections: readonly T[]) {
  const userId = idOf(who)

  // Someone the boundary let in is on the access list. For an id alone the directory says,
  // and it is only asked when the answer depends on it.
  const member =
    personOf(who) ??
    (connections.some(({ owner }) => owner.shared !== null) ? yield* memberOf(userId) : null)

  return connections.filter(({ row, owner }) =>
    owner.shared === null ? row.userId === userId : member !== null,
  )
})

export type ConnectionFilter = {
  provider?: string
  /** One teammate's own connections. Never a shared one, whoever connected it. */
  userId?: string
  /** The team's connections, or every group's. */
  shared?: Sharing
  /** One group's connections. */
  group?: string
  /** Only what this person may use: their own, and shared ones if they are on the access list. */
  usableBy?: string
}

/**
 * Connections across the team, for server code that acts on someone's behalf:
 * the mailbox sync, or an extension that creates an invoice with the company's
 * accounting connection. With no filter, every connection there is, as it
 * always was. Never return these to a browser.
 */
export const findConnections = Effect.fn('integrations.findConnections')(function* (
  filter: ConnectionFilter = {},
) {
  const store = yield* Store

  // Whose a connection is can depend on its provider, so that is decided on the rows, not by the database.
  const where: Pick<ConnectionFilter, 'provider' | 'userId'> = {}

  if (filter.provider !== undefined) {
    where.provider = filter.provider
  }

  if (filter.userId !== undefined) {
    where.userId = filter.userId
  }

  const rows = yield* store.find(Integration, { where, order: [asc('createdAt')], limit: 1000 })

  const wanted = owned(rows).filter(
    ({ owner }) =>
      (filter.userId === undefined || owner.shared === null) &&
      (filter.shared === undefined || owner.shared === filter.shared) &&
      (filter.group === undefined || (owner.shared === 'group' && owner.group === filter.group)),
  )

  const allowed = filter.usableBy === undefined ? wanted : yield* usableBy(filter.usableBy, wanted)

  // No names are looked up here: this runs on every post, sync and schedule, and must not ask the directory.
  return allowed.map(({ row, owner }) => toConnection(row, owner))
})

/** A connected mailbox: a connection to one of the built-in Google or Microsoft providers. */
export type MailboxConnection = Connection & { mailbox: MailboxProviderId }

export const listMailboxConnections = Effect.fn('integrations.listMailboxConnections')(function* (
  userId?: string,
) {
  const all = yield* findConnections(userId ? { userId } : {})
  return all.flatMap((c): MailboxConnection[] => {
    const mailbox = providers()[c.provider]?.mailbox
    return mailbox ? [{ ...c, mailbox }] : []
  })
})

const REFRESH_MARGIN_MS = 60 * 1000
/** One refresh at a time per connection: some providers retire a refresh token the moment it is used. */
const refreshing = new Map<string, Deferred.Deferred<string, StaffError>>()

/**
 * A valid access token for a connection, refreshed when it is about to expire.
 * A refresh the provider turns down marks the connection as needing to be
 * connected again.
 *
 * With `as`, the token is only given if that person may use the connection:
 * it is their own, or it is shared and they are on the access list.
 */
export const getAccessToken = Effect.fn('integrations.getAccessToken')(function* (
  connectionId: string,
  now = Date.now(),
  /** The person this is for. Left out by code with nobody behind it (a schedule, an automation), which is trusted. */
  as?: string,
) {
  const store = yield* Store
  const vault = yield* Vault
  const row = yield* store.first(Integration, { where: { id: connectionId } })
  const [connection] = row ? owned([row]) : []

  if (!row || !connection) {
    return yield* refuse('That account is no longer connected', true)
  }

  const { label } = yield* provider(row.provider)

  if (as !== undefined && (yield* usableBy(as, [connection])).length === 0) {
    return yield* refuse(`That ${label} account is not yours to use`)
  }

  const owner = ownerOf(row)
  const { value: current, bound } = yield* vault.open(row.credentials, owner, Credentials)

  // Only a personal row can be older than tokens being tied to their row. On any other, tokens that name no row were put there.
  if (!bound && row.shared !== '') {
    return yield* new VaultError({ message: 'Stored secret belongs to something else' })
  }

  if (current.expiresAt - REFRESH_MARGIN_MS > now) {
    // Sealed before tokens were tied to their row: tie them now, unless a refresh just replaced them.
    if (!bound) {
      yield* store.update(
        Integration,
        { where: { id: row.id, credentials: row.credentials } },
        { credentials: yield* vault.seal(current, owner) },
      )
    }

    return current.accessToken
  }

  const { refreshToken } = current

  if (!refreshToken) {
    return yield* refuse(`Reconnect ${row.account} on the Integrations page`, true)
  }

  const inFlight = refreshing.get(row.id)

  if (inFlight) {
    return yield* Deferred.await(inFlight)
  }

  const done = yield* Deferred.make<string, StaffError>()
  refreshing.set(row.id, done)

  const refresh = Effect.gen(function* () {
    const token = yield* tokenRequest(row.provider, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })

    const next = toCredentials(token, current, now)
    const sealed = yield* vault.seal(next, owner)

    yield* store.update(
      Integration,
      { where: { id: row.id } },
      { credentials: sealed, status: 'connected', lastError: null },
    )

    return next.accessToken
  }).pipe(
    Effect.catchTag('IntegrationError', (error) => {
      if (!error.reconnect) {
        return Effect.fail(error)
      }

      const message = `${label} no longer accepts this connection. Reconnect ${row.account} on the Integrations page.`
      return store
        .update(Integration, { where: { id: row.id } }, { status: 'error', lastError: message })
        .pipe(Effect.andThen(refuse(message, true)))
    }),
  )

  const result = yield* Effect.exit(refresh)
  refreshing.delete(row.id)
  yield* Deferred.done(done, result)
  return yield* result
})

/**
 * Remove a connection and its stored tokens: one of a teammate's own, or a
 * shared one they may manage. The provider is asked to revoke the token where
 * it offers that, but the local copy is deleted either way.
 *
 * False when there is no such connection of theirs. A shared one they can see
 * but may not manage is refused in words.
 */
export const disconnect = Effect.fn('integrations.disconnect')(function* (
  who: Who,
  connectionId: string,
) {
  const store = yield* Store
  const vault = yield* Vault
  const row = yield* store.first(Integration, { where: { id: connectionId } })

  if (!row) {
    return false
  }

  const p = isProvider(row.provider) ? providers()[row.provider] : undefined
  // A row whose provider is gone, or that says something unknown, is its connector's to clear away.
  const owner = (p && sharingOf(row)) || PERSONAL

  if (owner.shared === null) {
    if (row.userId !== idOf(who)) {
      return false
    }
  } else if (!(yield* mayManage(row.provider, p, who, owner.group))) {
    return yield* refuse(
      `Only the people who manage ${p?.label ?? row.provider} for this CRM can disconnect it`,
    )
  }

  if (p?.revokeUrl) {
    const revokeUrl = p.revokeUrl

    // Revocation is a courtesy; a vault or network failure must not keep the tokens around.
    yield* vault.open(row.credentials, ownerOf(row), Credentials).pipe(
      Effect.flatMap(({ value: { refreshToken, accessToken } }) =>
        send(
          p.label,
          HttpClientRequest.post(revokeUrl).pipe(
            HttpClientRequest.bodyUrlParams({ token: refreshToken ?? accessToken }),
          ),
        ),
      ),
      Effect.ignore,
    )
  }

  yield* store.remove(Integration, { where: { id: row.id } })
  return true
})

// ── The Integrations page ───────────────────────────────────────────────────

/**
 * What the Integrations page shows one person, apart from their mailboxes:
 * what can be connected, their own connections, and every shared one with
 * whether they may manage it. It is sent to a browser, so it is built field by
 * field here: no token, sealed or not, and nobody else's own connection.
 */
export const connectionsOverview = Effect.fn('integrations.connectionsOverview')(function* (
  user: CrmUser,
) {
  const store = yield* Store
  const env = yield* config.environment
  const offered = providers()
  const adopting = Object.keys(offered).filter((id) => offered[id]?.adoptExisting === true)

  const [mine, others] = yield* Effect.all(
    [
      listConnections(user.id),
      // Every row that says it is shared, and every row of a provider whose unmarked rows are.
      store.find(Integration, {
        filter:
          adopting.length > 0
            ? or(neq('shared', ''), oneOf('provider', adopting))
            : neq('shared', ''),
        order: [asc('createdAt')],
        limit: 1000,
      }),
    ],
    { concurrency: 2 },
  )

  // Seeing a shared connection is using it, as far as who may: the same check decides.
  const shared = yield* usableBy(
    user,
    owned(others).filter(({ owner }) => owner.shared !== null),
  )

  const names = yield* namesFor(shared)
  const groups = new Map<string, ConnectionGroup[]>()

  for (const [id, p] of Object.entries(offered)) {
    groups.set(id, yield* groupsOf(id, p))
  }

  return {
    providers: yield* Effect.forEach(Object.entries(offered), ([id, p]) =>
      Effect.gen(function* () {
        return {
          id,
          label: p.label,
          description: p.description,
          /** Whoever runs the CRM has set this provider's client id and secret. */
          available: providerConfigured(id, env),
          mailbox: !!p.mailbox,
          shared: p.shared ?? null,
          /** Whether this person may connect it. Always true of a connection of one's own. */
          canManage: p.shared === 'team' ? yield* mayManage(id, p, user, null) : true,
          groups: yield* Effect.forEach(groups.get(id) ?? [], (group) =>
            Effect.map(mayManage(id, p, user, group.key), (canManage) => ({
              ...group,
              canManage,
            })),
          ),
        }
      }),
    ),
    connections: mine.map((c) => ({
      id: c.id,
      provider: c.provider,
      label: offered[c.provider]?.label ?? c.provider,
      account: c.account,
      status: c.status,
      lastError: c.lastError,
      connectedAt: c.connectedAt.toISOString(),
      mailbox: !!offered[c.provider]?.mailbox,
    })),
    shared: yield* Effect.forEach(shared, ({ row, owner }) =>
      Effect.gen(function* () {
        const c = toConnection(row, owner, names)

        return {
          id: c.id,
          provider: c.provider,
          label: offered[c.provider]?.label ?? c.provider,
          account: c.account,
          shared: c.shared,
          group: c.group,
          /** The group as people know it, or its key once the provider no longer lists it. */
          groupLabel:
            c.group === null
              ? null
              : (groups.get(c.provider)?.find((g) => g.key === c.group)?.label ?? c.group),
          connectedBy: c.connectedBy,
          connectedAt: c.connectedAt.toISOString(),
          status: c.status,
          lastError: c.lastError,
          canManage: yield* mayManage(c.provider, offered[c.provider], user, c.group),
        }
      }),
    ),
  }
})
