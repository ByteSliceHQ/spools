/**
 * Which Google and Microsoft permissions the CRM needs to read a teammate's
 * mailbox and calendar and to send as them. Pure and shared: the server uses it
 * to decide what an account can do, the browser to ask for what is missing.
 *
 * For the account a teammate signs in with, the CRM runs no OAuth flow of its
 * own: they sign in with Google or Microsoft through the auth provider, which
 * holds the tokens. Add these scopes to the provider's Google and Microsoft
 * connections (see docs/mailbox.md).
 */

export type ProviderId = 'google' | 'microsoft'

export type MailboxProvider = {
  label: string
  /** Read mail and calendar, to log them on timelines. */
  read: string[]
  /** Send mail as the teammate. */
  send: string[]
}

export const PROVIDERS: Record<ProviderId, MailboxProvider> = {
  google: {
    label: 'Google',
    read: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
    send: ['https://www.googleapis.com/auth/gmail.send'],
  },
  microsoft: {
    label: 'Microsoft',
    read: ['Mail.Read', 'Calendars.Read'],
    send: ['Mail.Send'],
  },
}

export const isProvider = (value: string): value is ProviderId => Object.hasOwn(PROVIDERS, value)
export const providerIds = Object.keys(PROVIDERS).filter(isProvider)

/** The mailbox provider a sign-in account is with, or null for one the CRM can't read mail from. */
export const providerOf = (signInProvider: string): ProviderId | null =>
  isProvider(signInProvider) ? signInProvider : null

/** The scopes to ask a sign-in account for, per provider. */
export const requestedScopes = (): Record<ProviderId, string[]> => ({
  google: [...PROVIDERS.google.read, ...PROVIDERS.google.send],
  microsoft: [...PROVIDERS.microsoft.read, ...PROVIDERS.microsoft.send],
})

/** Microsoft reports a scope with or without the Graph prefix, in any case. */
const normalize = (scope: string) =>
  scope
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/graph\.microsoft\.com\//, '')

/** Broader scopes that include a narrower one we ask for. */
const COVERED_BY = new Map([
  ['mail.read', ['mail.readwrite']],
  ['calendars.read', ['calendars.readwrite']],
  [
    'https://www.googleapis.com/auth/gmail.readonly',
    ['https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'],
  ],
  ['https://www.googleapis.com/auth/gmail.send', ['https://mail.google.com/']],
  [
    'https://www.googleapis.com/auth/calendar.readonly',
    [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ],
  ],
])

/** True when `granted` includes every scope in `needed`, directly or through a broader one. */
export function grants(granted: string[], needed: string[]): boolean {
  const have = new Set(granted.map(normalize))
  return needed.every((scope) => {
    const want = normalize(scope)
    return have.has(want) || (COVERED_BY.get(want) ?? []).some((broader) => have.has(broader))
  })
}

export const canRead = (provider: ProviderId, granted: string[]) =>
  grants(granted, PROVIDERS[provider].read)
export const canSend = (provider: ProviderId, granted: string[]) =>
  grants(granted, PROVIDERS[provider].send)

/** An account's granted scopes, from the one space-separated string providers keep them in. */
export const splitScopes = (approved: string | null | undefined): string[] =>
  (approved ?? '').split(/[\s,]+/).filter(Boolean)
