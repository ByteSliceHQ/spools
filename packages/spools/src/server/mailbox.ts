import { Effect, Schedule } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import { canRead, canSend, PROVIDERS, type ProviderId } from '../crm/mailbox'
import { getAccessToken, listMailboxConnections, type MailboxConnection } from './integrations'
import { MailboxError } from './runtime/errors'
import { type Json, jsonValue } from './runtime/json'
import { policies } from './runtime/policies'
import { type MailboxAccount, SignIns } from './sign-ins'
import { spool } from './spool'
import type { CrmUser } from './users'

/**
 * A teammate's mailboxes. There are two ways the CRM reaches one:
 *
 * - The Google or Microsoft account they sign in with. The CRM stores no tokens
 *   for it: the auth provider holds them, and `SignIns` (src/server/sign-ins.ts) asks it
 *   for a current access token each time one is needed.
 * - A mailbox they connected on the Integrations page (a second address, or the
 *   only one when they sign in some other way). Its tokens are the CRM's to keep,
 *   encrypted (src/server/integrations.ts).
 *
 * Either way, what an account may do is decided by the scopes it was granted
 * (src/crm/mailbox.ts lists the ones the CRM needs), and everything past this
 * module treats the two alike.
 */

export type { MailboxAccount }
export { MailboxError }

type Kind = 'setup' | 'account' | 'api'

/** An error that carries a provider's status only when there was one. */
const mailboxError = (message: string, kind: Kind, status?: number) =>
  status === undefined
    ? new MailboxError({ message, kind })
    : new MailboxError({ message, kind, status })

const failWith = (message: string, kind: Kind = 'api', status?: number) =>
  Effect.fail(mailboxError(message, kind, status))

// ── Whose mailboxes ─────────────────────────────────────────────────────────

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** True when two accounts are the same person's same mailbox. */
export const sameMailbox = (
  a: { userId: string; provider: string; accountEmail: string },
  b: { userId: string; provider: string; accountEmail: string },
) =>
  a.userId === b.userId && a.provider === b.provider && sameAddress(a.accountEmail, b.accountEmail)

const fromConnection = (c: MailboxConnection, name: string): MailboxAccount => {
  const account: MailboxAccount = {
    userId: c.userId,
    name,
    provider: c.mailbox,
    accountEmail: c.account,
    scopes: c.scopes,
    connectionId: c.id,
  }

  // A connection that has to be made again can do nothing until it is.
  return c.status === 'error' ? { ...account, scopes: [], needsReconnect: true } : account
}

const reach = (a: MailboxAccount) =>
  (canRead(a.provider, a.scopes) ? 2 : 0) + (canSend(a.provider, a.scopes) ? 1 : 0)

/**
 * Sign-in accounts first, then connected ones. A mailbox that is both (someone
 * connected the address they sign in with) is kept once: whichever of the two
 * can do more, and the sign-in when they can do the same.
 */
function merge(signIn: MailboxAccount[], connected: MailboxAccount[]): MailboxAccount[] {
  const accounts = [...signIn]

  for (const c of connected) {
    const i = accounts.findIndex((a) => sameMailbox(a, c))
    const existing = accounts[i]

    if (existing === undefined) {
      accounts.push(c)
    } else if (reach(c) > reach(existing)) {
      accounts[i] = c
    }
  }

  return accounts
}

/** Every mailbox the sync should look at: each teammate's sign-in accounts and connected mailboxes. */
export const listMailboxAccounts = Effect.fn('mailbox.listMailboxAccounts')(function* () {
  const signIns = yield* SignIns

  const [signIn, connections] = yield* Effect.all([signIns.all, listMailboxConnections()], {
    concurrency: 2,
  })

  if (connections.length === 0) {
    return signIn
  }

  const names = new Map((yield* signIns.people).map((u) => [u.id, u.name]))

  // A connection whose owner may no longer use the CRM is left unread.
  const connected = connections.flatMap((c) => {
    const name = names.get(c.userId)
    return name === undefined ? [] : [fromConnection(c, name)]
  })

  return merge(signIn, connected)
})

/** One teammate's mailboxes. */
export const mailboxAccountsOf = Effect.fn('mailbox.mailboxAccountsOf')(function* (user: CrmUser) {
  const signIns = yield* SignIns

  const [signIn, connections] = yield* Effect.all(
    [signIns.of(user), listMailboxConnections(user.id)],
    {
      concurrency: 2,
    },
  )

  return merge(
    signIn,
    connections.map((c) => fromConnection(c, user.name)),
  )
})

// ── Tokens ──────────────────────────────────────────────────────────────────

/** A current access token for a teammate's mailbox. Fails with a MailboxError when there isn't one. */
export const accessToken = Effect.fn('mailbox.accessToken')(function* (
  account: Pick<MailboxAccount, 'userId' | 'provider' | 'connectionId'>,
) {
  if (account.connectionId) {
    const connectionId = account.connectionId
    return yield* getAccessToken(connectionId).pipe(
      Effect.catchTags({
        IntegrationError: (error) => failWith(error.message, error.reconnect ? 'account' : 'api'),
        VaultError: (error) => failWith(error.message),
      }),
    )
  }

  const signIns = yield* SignIns
  const token = yield* signIns.token(account.userId, account.provider)

  if (!token) {
    return yield* failWith(
      `${spool().auth.label} has no ${PROVIDERS[account.provider].label} token for this account. Reconnect it from your profile.`,
      'account',
    )
  }

  return token
})

// ── Provider APIs ───────────────────────────────────────────────────────────

/** A provider API said no. 401 and 403 mean the grant is gone or too narrow. */
const refused = (status: number, host: string) =>
  mailboxError(
    status === 401 || status === 403
      ? `${host} denied access (${status}). Reconnect the account.`
      : `${host} answered ${status}. It will be tried again.`,
    status === 401 || status === 403 ? 'account' : 'api',
    status,
  )

const refusal = (status: number, host: string) => Effect.fail(refused(status, host))

const succeeded = (res: { status: number }) => res.status >= 200 && res.status < 300

/** A busy answer (429, 5xx) to a read: wait as long as the provider asks (up to 10 s), then ask again. */
class Busy {
  readonly _tag = 'Busy'
  constructor(
    readonly status: number,
    readonly waitMs: number,
  ) {}
}

const retryAfterMs = (value: string | undefined) => {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 10_000) : 0
}

const call = (request: HttpClientRequest.HttpClientRequest, repeatable: boolean) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const host = new URL(request.url).hostname
    const unreachable = failWith(`${host} could not be reached. It will be tried again.`)

    const attempt = client.execute(request).pipe(
      Effect.filterOrFail(
        (res) => !repeatable || (res.status !== 429 && res.status < 500),
        (res) => new Busy(res.status, retryAfterMs(res.headers['retry-after'])),
      ),
    )

    return yield* attempt.pipe(
      Effect.tapError((error) =>
        error._tag === 'Busy' && error.waitMs > 0 ? Effect.sleep(error.waitMs) : Effect.void,
      ),
      Effect.retry({
        schedule: Schedule.exponential('500 millis').pipe(Schedule.jittered),
        times: repeatable ? policies.mailApi.retries : 0,
      }),
      Effect.timeoutOrElse({ duration: policies.mailApi.timeout, orElse: () => unreachable }),
      Effect.catchTags({
        Busy: (busy) => refusal(busy.status, host),
        HttpClientError: () => unreachable,
      }),
    )
  })

/**
 * GET a provider API as JSON with a teammate's access token. The caller reads
 * the answer with a schema of what it asked for.
 */
export const apiGet = Effect.fn('mailbox.apiGet')(function* (
  url: string,
  token: string,
  headers: Record<string, string> = {},
) {
  const host = new URL(url).hostname
  const notJson = `${host} answered with something that isn't JSON. It will be tried again.`

  const res = yield* call(
    HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...headers,
      }),
    ),
    true,
  ).pipe(Effect.filterOrFail(succeeded, (answered) => refused(answered.status, host)))

  const body = yield* res.json.pipe(Effect.catch(() => failWith(notJson)))
  const answer: Json | undefined = jsonValue.safeParse(body).data

  if (answer === undefined) {
    return yield* failWith(notJson)
  }

  return answer
})

/** POST JSON to a provider API. Some calls answer with no body (Graph's sendMail). Never sent twice. */
export const apiPost = Effect.fn('mailbox.apiPost')(function* (
  url: string,
  token: string,
  body: Json,
) {
  yield* call(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      }),
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
    false,
  ).pipe(Effect.filterOrFail(succeeded, (res) => refused(res.status, new URL(url).hostname)))
})

// ── Sending as the teammate ─────────────────────────────────────────────────

export type MailboxMessage = { to: string; subject: string; text: string; html: string }
export type SentFrom = { provider: ProviderId; accountEmail: string }

/** One address, nothing that could start a second header or recipient. */
const plainAddress = /^[^\s<>,;:"()[\]\\]+@[^\s<>,;:"()[\]\\]+$/

const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()
const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')
const wrapped = (value: string) => (base64(value).match(/.{1,76}/g) ?? []).join('\r\n')

/** A header value as an RFC 2047 encoded word when it isn't plain ASCII. */
const encodedWord = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64(value)}?=`

/** The message as RFC 822 text with a plain and an HTML part, for Gmail's send API. */
export function buildMime(from: { name: string; email: string }, message: MailboxMessage): string {
  const boundary = `crm-${crypto.randomUUID()}`
  const name = oneLine(from.name).replace(/["\\]/g, '')
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${name}"` : encodedWord(name)
  return [
    `From: ${name ? `${display} ` : ''}<${from.email}>`,
    `To: <${message.to}>`,
    `Subject: ${encodedWord(oneLine(message.subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const GRAPH_SEND = 'https://graph.microsoft.com/v1.0/me/sendMail'

/**
 * Send an email from one of the teammate's own mailboxes, so it sits in their
 * Sent folder and replies come back to them. `from` names the mailbox they
 * picked; without it the CRM chooses.
 *
 * Returns null when they have no mailbox that may send; the caller then uses the
 * app's email provider. Fails with a MailboxError when a mailbox should have
 * worked and didn't.
 */
export const sendFromMailbox = Effect.fn('mailbox.sendFromMailbox')(function* (
  user: CrmUser,
  message: MailboxMessage,
  from?: { provider: ProviderId; accountEmail: string },
) {
  const able = (yield* mailboxAccountsOf(user)).filter((a) => canSend(a.provider, a.scopes))

  const chosen =
    from &&
    able.find((a) => a.provider === from.provider && sameAddress(a.accountEmail, from.accountEmail))

  if (from && !chosen) {
    return yield* failWith(`${from.accountEmail} can't send for you right now.`, 'account')
  }

  // Left to the CRM: the address it knows them by, then their sign-in, then a connected mailbox.
  const account = chosen ?? able.find((a) => sameAddress(a.accountEmail, user.email)) ?? able[0]

  if (!account) {
    return null
  }

  if (!plainAddress.test(message.to)) {
    return yield* failWith(`"${message.to}" is not an address a mailbox can send to.`)
  }

  const token = yield* accessToken(account)

  if (account.provider === 'google') {
    const mime = buildMime({ name: user.name, email: account.accountEmail }, message)
    yield* apiPost(GMAIL_SEND, token, { raw: Buffer.from(mime, 'utf8').toString('base64url') })
  } else {
    yield* apiPost(GRAPH_SEND, token, {
      message: {
        subject: oneLine(message.subject),
        body: { contentType: 'HTML', content: message.html },
        toRecipients: [{ emailAddress: { address: message.to } }],
      },
      saveToSentItems: true,
    })
  }

  const sent: SentFrom = { provider: account.provider, accountEmail: account.accountEmail }
  return sent
})
