import { createHmac, timingSafeEqual } from 'node:crypto'

import { Effect } from 'effect'

import * as config from './runtime/config'
import { Invalid } from './runtime/errors'
import { Store } from './store/store'
import { Suppression } from './store/tables'

/**
 * Outbound email for campaigns (Swirls workflows send their own email through
 * the Swirls `email` node): templates, unsubscribe links and the suppression
 * list. Sending is the `Email` service (runtime/email.ts, Resend). Env:
 *   APP_URL          public base URL, used for unsubscribe links
 *   APP_SECRET       >= 32 chars; signs unsubscribe tokens
 */

export type { EmailSender, OutboundEmail } from './runtime/email'

// ── Templates ───────────────────────────────────────────────────────────────

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

/**
 * Replace `{{field}}` with values; missing values become an empty string. Only
 * the values' own keys count: `{{constructor}}` is a missing value, not the
 * text of a built-in function.
 */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9]+)\s*\}\}/g, (_, key: string) =>
    Object.hasOwn(values, key) ? (values[key] ?? '') : '',
  )
}

/** Plain text -> minimal, safe HTML (paragraphs and line breaks; values are escaped). */
export function textToHtml(text: string, unsubscribeUrl?: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')

  const footer = unsubscribeUrl
    ? `<p style="margin:32px 0 0;font-size:12px;color:#71717a"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#71717a">Unsubscribe</a></p>`
    : ''

  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#18181b;max-width:560px">${paragraphs}${footer}</div>`
}

// ── Unsubscribe tokens ──────────────────────────────────────────────────────

/** The key that signs unsubscribe links. A deployment without one can't send campaign email. */
const secret = Effect.gen(function* () {
  const s = yield* config.variable('APP_SECRET')

  if (!s || s.length < 32) {
    return yield* new Invalid({
      message: 'APP_SECRET must be set (32+ characters) to sign unsubscribe links',
    })
  }

  return s
})

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export const unsubscribeToken = Effect.fn('email.unsubscribeToken')(function* (email: string) {
  const payload = b64url(email.toLowerCase())

  const sig = createHmac('sha256', yield* secret)
    .update(`unsubscribe:${payload}`)
    .digest('base64url')

  return `${payload}.${sig}`
})

/** The email address if the token is authentic, otherwise null. */
export const verifyUnsubscribeToken = Effect.fn('email.verifyUnsubscribeToken')(function* (
  token: string,
) {
  const [payload, sig] = token.split('.')

  if (!payload || !sig) {
    return null
  }

  const expected = createHmac('sha256', yield* secret)
    .update(`unsubscribe:${payload}`)
    .digest()

  const given = Buffer.from(sig, 'base64url')

  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null
  }

  return Buffer.from(payload, 'base64url').toString('utf8')
})

/**
 * The link in a campaign email that takes its reader off the list. Without
 * `APP_URL` there is nowhere for it to lead, and email with a dead unsubscribe
 * link must not go out, so this fails and the email is not sent.
 */
export const unsubscribeUrl = Effect.fn('email.unsubscribeUrl')(function* (email: string) {
  const base = (yield* config.variable('APP_URL'))?.replace(/\/+$/, '')

  if (!base) {
    return yield* new Invalid({
      message: "APP_URL must be set (the CRM's public address) to make unsubscribe links",
    })
  }

  return `${base}/unsubscribe?t=${encodeURIComponent(yield* unsubscribeToken(email))}`
})

// ── Suppression list ────────────────────────────────────────────────────────

export const isSuppressed = Effect.fn('email.isSuppressed')(function* (email: string) {
  const store = yield* Store
  return (yield* store.count(Suppression, { where: { email: email.toLowerCase() } })) > 0
})

export const suppress = Effect.fn('email.suppress')(function* (
  email: string,
  reason: 'unsubscribed' | 'bounced' | 'complained',
) {
  const address = email.toLowerCase()

  if (yield* isSuppressed(address)) {
    return
  }

  const store = yield* Store

  yield* store.insert(Suppression, { email: address, reason }).pipe(
    // Two webhooks for the same bounce: the unique index kept one row.
    Effect.catchTag('DatabaseError', (error) =>
      Effect.flatMap(isSuppressed(address), (done) => (done ? Effect.void : Effect.fail(error))),
    ),
  )
})
