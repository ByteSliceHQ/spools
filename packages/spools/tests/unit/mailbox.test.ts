import { describe, expect, test } from 'bun:test'

import {
  canRead,
  canSend,
  grants,
  providerOf,
  requestedScopes,
  splitScopes,
} from '../../src/crm/mailbox'
import { buildMime } from '../../src/server/mailbox'
import { isCronAuthorized } from '../../src/server/runtime/bearer'

describe('what an account has granted', () => {
  test('space-separated scopes are split', () => {
    expect(splitScopes('email profile  openid')).toEqual(['email', 'profile', 'openid'])
    expect(splitScopes(null)).toEqual([])
  })

  test('sign-in accounts map to the mailboxes the CRM reads, and others are ignored', () => {
    expect(providerOf('google')).toBe('google')
    expect(providerOf('microsoft')).toBe('microsoft')
    expect(providerOf('github')).toBeNull()
  })

  test('a plain sign-in can neither read nor send', () => {
    const signIn = splitScopes('email profile openid')
    expect(canRead('google', signIn)).toBe(false)
    expect(canSend('google', signIn)).toBe(false)
  })

  test('reading needs mail and calendar; sending is separate', () => {
    const read = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]

    expect(canRead('google', read)).toBe(true)
    expect(canRead('google', read.slice(0, 1))).toBe(false)
    expect(canSend('google', read)).toBe(false)
    expect(canSend('google', [...read, 'https://www.googleapis.com/auth/gmail.send'])).toBe(true)
  })

  test('Microsoft scopes match with or without the Graph prefix, in any case', () => {
    expect(canRead('microsoft', ['https://graph.microsoft.com/Mail.Read', 'calendars.read'])).toBe(
      true,
    )

    expect(canSend('microsoft', ['MAIL.SEND'])).toBe(true)
    expect(canSend('microsoft', ['Mail.Read'])).toBe(false)
  })

  test('a broader scope covers the narrower one', () => {
    expect(canRead('microsoft', ['Mail.ReadWrite', 'Calendars.ReadWrite'])).toBe(true)

    expect(
      grants(['https://mail.google.com/'], ['https://www.googleapis.com/auth/gmail.send']),
    ).toBe(true)
  })

  test('the scopes asked for cover reading and sending for both providers', () => {
    const asked = requestedScopes()
    expect(canRead('google', asked.google) && canSend('google', asked.google)).toBe(true)

    expect(canRead('microsoft', asked.microsoft) && canSend('microsoft', asked.microsoft)).toBe(
      true,
    )
  })
})

describe('the message Gmail is given', () => {
  const part = (mime: string, type: string) => {
    const [, body = ''] = mime.split(
      `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n`,
    )

    return Buffer.from(body.split('\r\n--')[0]!.replace(/\r\n/g, ''), 'base64').toString('utf8')
  }

  test('carries both bodies and plain headers', () => {
    const mime = buildMime(
      { name: 'Ada Lovelace', email: 'ada@acme.example.com' },
      {
        to: 'sam@example.com',
        subject: 'Revised quote',
        text: 'Hello Sam',
        html: '<p>Hello Sam</p>',
      },
    )

    expect(mime).toContain('From: "Ada Lovelace" <ada@acme.example.com>\r\n')
    expect(mime).toContain('To: <sam@example.com>\r\n')
    expect(mime).toContain('Subject: Revised quote\r\n')
    expect(part(mime, 'text/plain')).toBe('Hello Sam')
    expect(part(mime, 'text/html')).toBe('<p>Hello Sam</p>')
  })

  test("a subject can't add a header, and non-ASCII text is encoded", () => {
    const mime = buildMime(
      { name: 'Zoë', email: 'zoe@acme.example.com' },
      {
        to: 'sam@example.com',
        subject: 'Hi\r\nBcc: evil@example.com',
        text: 'Café ☕',
        html: '<p>Café ☕</p>',
      },
    )

    const headers = mime.split('\r\n\r\n')[0]!
    expect(headers).not.toContain('\r\nBcc:')
    expect(headers).toContain('Subject: Hi Bcc: evil@example.com')

    expect(headers).toContain(
      `From: =?UTF-8?B?${Buffer.from('Zoë').toString('base64')}?= <zoe@acme.example.com>`,
    )

    expect(part(mime, 'text/plain')).toBe('Café ☕')
  })

  test('long bodies are wrapped at 76 characters', () => {
    const mime = buildMime(
      { name: 'Ada', email: 'ada@acme.example.com' },
      { to: 'sam@example.com', subject: 's', text: 'x'.repeat(500), html: '<p>y</p>' },
    )

    const encoded = mime.split('\r\n').filter((line) => /^[A-Za-z0-9+/=]{20,}$/.test(line))
    expect(encoded.length).toBeGreaterThan(5)
    expect(encoded.every((line) => line.length <= 76)).toBe(true)
  })
})

describe('the cron entry point', () => {
  const request = (token?: string) =>
    new Request('https://crm.example.com/api/cron/mail-sync', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })

  test('fails closed without a secret, and with a short one', () => {
    delete process.env['CRON_SECRET']
    expect(isCronAuthorized(request('anything'))).toBe(false)
    process.env['CRON_SECRET'] = 'short'
    expect(isCronAuthorized(request('short'))).toBe(false)
  })

  test('accepts only the exact secret', () => {
    process.env['CRON_SECRET'] = 'c'.repeat(32)
    expect(isCronAuthorized(request('c'.repeat(32)))).toBe(true)
    expect(isCronAuthorized(request('c'.repeat(31)))).toBe(false)
    expect(isCronAuthorized(request())).toBe(false)
    delete process.env['CRON_SECRET']
  })
})
