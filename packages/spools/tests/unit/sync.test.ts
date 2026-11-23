import { describe, expect, test } from 'bun:test'

import {
  addresses,
  decodeEntities,
  fromGmail,
  fromGoogleEvent,
  fromGraphEvent,
  fromGraphMessage,
  sender,
} from '../../src/server/sync'

const now = new Date('2026-11-17T18:00:00Z')

describe('reading addresses', () => {
  test('finds every address in a header, lower-cased and without repeats', () => {
    expect(addresses('"Ada Lopez" <Ada@Example.com>, ben@example.co.uk; ADA@example.com')).toEqual([
      'ada@example.com',
      'ben@example.co.uk',
    ])

    expect(addresses("o'brien+crm@shop.example.com")).toEqual(["o'brien+crm@shop.example.com"])
    expect(addresses('undisclosed-recipients:;')).toEqual([])
    expect(addresses(undefined)).toEqual([])
  })

  test('a name is never read as an address, whatever the sender typed in it', () => {
    expect(addresses('"ceo@bigclient.com" <mallory@evil.test>')).toEqual(['mallory@evil.test'])
    expect(addresses('ceo@bigclient.com <mallory@evil.test>')).toEqual(['mallory@evil.test'])
    expect(addresses('mallory@evil.test (ceo@bigclient.com)')).toEqual(['mallory@evil.test'])

    expect(addresses('"Lopez, Ada" <ada@example.com>, ben@example.com')).toEqual([
      'ada@example.com',
      'ben@example.com',
    ])

    expect(addresses('"a \\" quote, <x@evil.test>" <ada@example.com>')).toEqual(['ada@example.com'])

    expect(addresses('Team: ada@example.com, Ben <ben@example.com>;')).toEqual([
      'ada@example.com',
      'ben@example.com',
    ])

    expect(addresses('Ada Lopez ada@example.com')).toEqual([])
  })

  test('a message is from the one mailbox in its From header, or from nobody', () => {
    expect(sender('Ada Lopez <Ada@Example.com>')).toBe('ada@example.com')
    expect(sender('ada@example.com')).toBe('ada@example.com')
    expect(sender('"ceo@bigclient.com" <mallory@evil.test>')).toBe('mallory@evil.test')
    expect(sender('"ceo@bigclient.com <mallory@evil.test>')).toBeNull()
    expect(sender('ceo@bigclient.com, mallory@evil.test')).toBeNull()
    expect(sender('<ceo@bigclient.com> <mallory@evil.test>')).toBeNull()
    expect(sender('ceo@bigclient.com')).toBe('ceo@bigclient.com')
    expect(sender(undefined)).toBeNull()
  })

  test("turns Gmail's escaped snippets back into text", () => {
    expect(decodeEntities('Tom &amp; Ann&#39;s kitchen &lt;3')).toBe("Tom & Ann's kitchen <3")
  })
})

describe('Gmail', () => {
  const headers = (h: Record<string, string>) =>
    Object.entries(h).map(([name, value]) => ({ name, value }))

  test('a message becomes sender, recipients (To and Cc), subject, preview and time', () => {
    const item = fromGmail({
      id: '18c',
      internalDate: '1794931200000',
      snippet: 'Here&#39;s the revised quote',
      payload: {
        headers: headers({
          From: 'Ada Lopez <ada@acme.example.com>',
          To: 'Sam Rivera <sam.rivera@example.com>',
          Cc: 'ben@acme.example.com',
          Subject: ' Revised quote ',
          'Message-ID': '<abc123@mail.gmail.com>',
        }),
      },
    })

    expect(item).toEqual({
      id: '<abc123@mail.gmail.com>',
      from: 'ada@acme.example.com',
      to: ['sam.rivera@example.com', 'ben@acme.example.com'],
      subject: 'Revised quote',
      preview: "Here's the revised quote",
      at: new Date(1794931200000),
      sent: false,
    })
  })

  test("only Gmail's own label says the account sent a message, never its From header", () => {
    const from = (labelIds?: string[]) =>
      fromGmail({
        id: '18f',
        labelIds,
        payload: { headers: headers({ From: 'rep@acme.example.com', To: 'sam@example.com' }) },
      })

    expect(from(['SENT'])?.sent).toBe(true)
    expect(from(['INBOX', 'UNREAD'])?.sent).toBe(false)
    expect(from()?.sent).toBe(false)

    // The sender's name can hold any address; the message is still theirs.
    const spoofed = fromGmail({
      id: '18g',
      labelIds: ['INBOX'],
      payload: { headers: headers({ From: '"rep@acme.example.com" <mallory@evil.test>' }) },
    })

    expect(spoofed?.from).toBe('mallory@evil.test')
  })

  test("falls back to Gmail's own id without a Message-ID, and skips a message with no sender", () => {
    expect(
      fromGmail({ id: '18d', payload: { headers: headers({ from: 'x@example.com' }) } })?.id,
    ).toBe('gmail:18d')

    expect(fromGmail({ id: '18e', payload: { headers: [] } })).toBeNull()
  })

  test('a finished event becomes a meeting with its attendees', () => {
    const event = {
      id: 'ev1',
      iCalUID: 'uid-1@google.com',
      summary: 'Field measure',
      start: { dateTime: '2026-11-17T15:00:00Z' },
      end: { dateTime: '2026-11-17T16:00:00Z' },
      attendees: [
        { email: 'ada@acme.example.com', self: true },
        { email: 'Sam.Rivera@example.com' },
      ],
    }

    expect(fromGoogleEvent(event, now)).toEqual({
      id: 'uid-1@google.com',
      subject: 'Field measure',
      start: new Date('2026-11-17T15:00:00Z'),
      attendees: ['ada@acme.example.com', 'sam.rivera@example.com'],
    })
  })

  test('cancelled, all-day, declined and unfinished events are not meetings', () => {
    const base = {
      id: 'ev',
      start: { dateTime: '2026-11-17T15:00:00Z' },
      end: { dateTime: '2026-11-17T16:00:00Z' },
    }

    expect(fromGoogleEvent({ ...base, status: 'cancelled' }, now)).toBeNull()
    expect(fromGoogleEvent({ id: 'ev', start: {}, end: {} }, now)).toBeNull()

    expect(
      fromGoogleEvent(
        { ...base, attendees: [{ email: 'me@x.com', self: true, responseStatus: 'declined' }] },
        now,
      ),
    ).toBeNull()

    expect(fromGoogleEvent({ ...base, end: { dateTime: '2026-11-17T19:00:00Z' } }, now)).toBeNull()
  })
})

describe('Microsoft Graph', () => {
  const person = (address: string) => ({ emailAddress: { address } })

  test("a message becomes the same shape as Gmail's", () => {
    const item = fromGraphMessage({
      id: 'AAMk',
      internetMessageId: '<xyz@outlook.com>',
      subject: 'Countertop samples',
      bodyPreview: 'They arrive Thursday',
      receivedDateTime: '2026-11-17T14:30:00Z',
      from: person('Sam.Rivera@example.com'),
      toRecipients: [person('ben@acme.example.com')],
      ccRecipients: [person('ada@acme.example.com')],
    })

    expect(item).toEqual({
      id: '<xyz@outlook.com>',
      from: 'sam.rivera@example.com',
      to: ['ben@acme.example.com', 'ada@acme.example.com'],
      subject: 'Countertop samples',
      preview: 'They arrive Thursday',
      at: new Date('2026-11-17T14:30:00Z'),
    })
  })

  test('only being in Sent Items says the mailbox owner sent a message', () => {
    const folders = { sent: 'sent-id', ignored: new Set(['junk-id', 'deleted-id']) }

    const message = (parentFolderId: string) =>
      fromGraphMessage({ id: 'm', parentFolderId, from: person('ben@acme.example.com') }, folders)

    expect(message('sent-id')?.sent).toBe(true)
    // Ben's own address in From, in the inbox: somebody else wrote that header.
    expect(message('inbox-id')?.sent).toBe(false)
    // Junk and what was thrown away are read past.
    expect(message('junk-id')).toBeNull()
    expect(message('deleted-id')).toBeNull()

    // A mailbox that wouldn't say which folder is Sent Items has sent nothing, as far as this goes.
    expect(
      fromGraphMessage(
        { id: 'm', parentFolderId: 'x', from: person('ben@acme.example.com') },
        { sent: null, ignored: new Set() },
      )?.sent,
    ).toBe(false)
  })

  test('drafts and messages without a sender are skipped', () => {
    expect(
      fromGraphMessage({ id: 'd', isDraft: true, from: person('ben@acme.example.com') }),
    ).toBeNull()

    expect(fromGraphMessage({ id: 'n' })).toBeNull()
  })

  test('event times come back without a zone and are read as UTC', () => {
    const event = {
      id: 'ev9',
      iCalUId: 'uid-9',
      subject: 'Showroom visit',
      start: { dateTime: '2026-11-17T15:00:00.0000000' },
      end: { dateTime: '2026-11-17T16:00:00.0000000' },
      attendees: [person('Sam.Rivera@example.com')],
    }

    expect(fromGraphEvent(event, now)).toEqual({
      id: 'uid-9',
      subject: 'Showroom visit',
      start: new Date('2026-11-17T15:00:00Z'),
      attendees: ['sam.rivera@example.com'],
    })
  })

  test('cancelled, all-day, declined and unfinished events are not meetings', () => {
    const base = {
      id: 'ev',
      start: { dateTime: '2026-11-17T15:00:00.0000000' },
      end: { dateTime: '2026-11-17T16:00:00.0000000' },
    }

    expect(fromGraphEvent({ ...base, isCancelled: true }, now)).toBeNull()
    expect(fromGraphEvent({ ...base, isAllDay: true }, now)).toBeNull()
    expect(fromGraphEvent({ ...base, responseStatus: { response: 'declined' } }, now)).toBeNull()

    expect(
      fromGraphEvent({ ...base, end: { dateTime: '2026-11-17T19:00:00.0000000' } }, now),
    ).toBeNull()
  })
})
