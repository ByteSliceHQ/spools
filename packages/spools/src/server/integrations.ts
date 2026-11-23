import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { Deferred, Effect, Predicate } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { z } from 'zod'

import { PROVIDERS as MAILBOXES, type ProviderId as MailboxProviderId } from '../crm/mailbox'
import * as config from './runtime/config'
import { type ExtensionError, fromHook, IntegrationError, type StaffError } from './runtime/errors'
import { type Json, parseJson } from './runtime/json'
import { policies, withPolicy } from './runtime/policies'
import { Vault } from './runtime/vault'
import { spool } from './spool'
import { asc } from './store/query'
import { Store } from './store/store'
import { Integration } from './store/tables'

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
 * Env (a provider is offered once its client id and secret are set; all need
 * APP_URL, APP_SECRET and a vault):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID (default "common")
 */

export { IntegrationError }

type Env = Record<string, string | undefined>

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
  /** Endpoint that invalidates a token (RFC 7009), if the provider has one. */
  revokeUrl?: string
  /** Set on the built-in mailboxes: read and send through this mailbox API. */
  mailbox?: MailboxProviderId
}

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

/** Every provider this app offers: the built-in mailboxes, then the app's own. */
export function providers() {
  const own = Object.entries(spool().extensions.integrations ?? {}).filter(
    ([id]) => PROVIDER_ID.test(id) && !Object.hasOwn(builtIn, id),
  )

  return Object.fromEntries([...Object.entries(builtIn), ...own])
}

export const providerIds = (): string[] => Object.keys(providers())
export const isProvider = (id: string): boolean => Object.hasOwn(providers(), id)

/** Problems with the app's own providers, for start-up. Empty when there are none. */
export function validateIntegrations(): string[] {
  return Object.keys(spool().extensions.integrations ?? {}).flatMap((id) =>
    Object.hasOwn(builtIn, id)
      ? [`integration "${id}" is built in and can't be replaced`]
      : PROVIDER_ID.test(id)
        ? []
        : [`integration "${id}" needs an id of lower-case letters, digits, "-" or "_"`],
  )
}

const refuse = (message: string, reconnect = false) =>
  Effect.fail(new IntegrationError({ message, reconnect }))

const provider = (id: string) => {
  const found = Object.hasOwn(providers(), id) ? providers()[id] : undefined
  return found ? Effect.succeed(found) : refuse(`"${id}" is not an integration this CRM offers`)
}

const urlOf = (value: string | ((env: Env) => string), env: Env) =>
  Predicate.isFunction(value) ? value(env) : value

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

/** What a signed `state` carries: the user, the provider, the nonce and when it expires. */
const State = z.object({ u: z.string(), p: z.string(), n: z.string(), e: z.number() })
type State = z.infer<typeof State>

export type AuthRequest = {
  /** Where to send the browser. */
  url: string
  /** Value for the short-lived, HttpOnly `OAUTH_COOKIE`: ties the callback to this browser. */
  cookie: string
}

/**
 * Build the provider's consent URL for a teammate.
 *
 * The `state` is signed and names the user, so a callback can't be replayed for
 * someone else; a nonce and the PKCE verifier stay in a cookie, so the callback
 * only works in the browser that started it.
 */
export const createAuthRequest = Effect.fn('integrations.createAuthRequest')(function* (
  id: string,
  userId: string,
  now = Date.now(),
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

  const sign = yield* signer

  const nonce = randomBytes(16).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')

  const payload = Buffer.from(
    JSON.stringify({ u: userId, p: id, n: nonce, e: now + STATE_TTL_MS } satisfies State),
  ).toString('base64url')

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

/** Check a callback's `state` against its signature, expiry, user and cookie. Returns the PKCE verifier. */
export const verifyState = Effect.fn('integrations.verifyState')(function* (
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
    parsed.n !== nonce
  ) {
    return yield* expired
  }

  return verifier
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

/** Who a connection's tokens are sealed for: the row they are stored on, and no other. Exported for tests. */
export const ownerOf = (row: { userId: string; provider: string; account: string }) =>
  JSON.stringify(['integration', row.userId, row.provider, row.account])

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
  userId: string
  provider: string
  /** Which account at the provider: an email address for a mailbox. */
  account: string
  scopes: string[]
  status: 'connected' | 'error'
  lastError: string | null
  connectedAt: Date
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
}

const toConnection = (row: Row): Connection => ({
  id: row.id,
  userId: row.userId,
  provider: row.provider,
  account: row.account,
  scopes: row.scopes.split(/\s+/).filter(Boolean),
  status: row.status === 'error' ? 'error' : 'connected',
  lastError: row.lastError,
  connectedAt: row.createdAt,
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
 */
export const completeAuth = Effect.fn('integrations.completeAuth')(function* (
  id: string,
  input: {
    code: string
    state: string | null
    cookie: string | null | undefined
    query?: URLSearchParams
  },
  userId: string,
) {
  const p = yield* provider(id)
  const env = yield* config.environment
  const verifier = yield* verifyState(id, input.state, input.cookie, userId)

  const token = yield* tokenRequest(id, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: redirectUri(id, env),
    code_verifier: verifier,
  })

  if (!token.refresh_token) {
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
  const where = { userId, provider: id, account }
  const vault = yield* Vault
  const credentials = yield* vault.seal(toCredentials(token), ownerOf(where))
  const store = yield* Store

  const row = {
    credentials,
    scopes: token.scope ?? p.scopes.join(' '),
    status: 'connected',
    lastError: null,
  }

  const existing = yield* store.first(Integration, { where })

  if (existing) {
    yield* store.update(Integration, { where: { id: existing.id } }, row)
  } else {
    yield* store.insert(Integration, { ...where, ...row })
  }

  const saved = yield* store.first(Integration, { where })

  if (!saved) {
    return yield* refuse('The connection could not be saved')
  }

  return toConnection(saved)
})

/** A teammate's own connections. Tokens never leave this module. */
export const listConnections = Effect.fn('integrations.listConnections')(function* (
  userId: string,
) {
  const store = yield* Store
  const rows = yield* store.find(Integration, { where: { userId }, order: [asc('createdAt')] })
  return rows.filter((r) => isProvider(r.provider)).map(toConnection)
})

/**
 * Connections across the team, for server code that acts on someone's behalf:
 * the mailbox sync, or an extension that uses whichever teammate connected the
 * accounting system. Never return these to a browser.
 */
export const findConnections = Effect.fn('integrations.findConnections')(function* (
  filter: { provider?: string; userId?: string } = {},
) {
  const store = yield* Store

  const rows = yield* store.find(Integration, {
    where: filter,
    order: [asc('createdAt')],
    limit: 1000,
  })

  return rows.filter((r) => isProvider(r.provider)).map(toConnection)
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
 */
export const getAccessToken = Effect.fn('integrations.getAccessToken')(function* (
  connectionId: string,
  now = Date.now(),
) {
  const store = yield* Store
  const vault = yield* Vault
  const row = yield* store.first(Integration, { where: { id: connectionId } })

  if (!row || !isProvider(row.provider)) {
    return yield* refuse('That account is no longer connected', true)
  }

  const { label } = yield* provider(row.provider)
  const owner = ownerOf(row)
  const { value: current, bound } = yield* vault.open(row.credentials, owner, Credentials)

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
 * Remove one of a teammate's connections and its stored tokens. The provider is
 * asked to revoke the token where it offers that, but the local copy is deleted
 * either way.
 */
export const disconnect = Effect.fn('integrations.disconnect')(function* (
  userId: string,
  connectionId: string,
) {
  const store = yield* Store
  const vault = yield* Vault
  const row = yield* store.first(Integration, { where: { id: connectionId, userId } })

  if (!row) {
    return false
  }

  const p = isProvider(row.provider) ? providers()[row.provider] : undefined

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
