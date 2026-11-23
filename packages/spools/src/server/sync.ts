import { Cause, Effect, type Fiber, Schedule } from 'effect'
import { z } from 'zod'

import { canRead, canSend, PROVIDERS, type ProviderId } from '../crm/mailbox'
import {
  accessToken,
  apiGet,
  listMailboxAccounts,
  type MailboxAccount,
  mailboxAccountsOf,
  sameMailbox,
} from './mailbox'
import { addActivityOnce, adoptSentEmail, emailSummary, listRecords } from './records'
import { runtime } from './runtime/app'
import * as config from './runtime/config'
import { crmConfig } from './spool'
import { Store } from './store/store'
import { MailboxSync } from './store/tables'
import type { CrmUser } from './users'

declare global {
  /**
   * The sync schedule's fiber. It lives on the global object because a
   * dev-server reload loads this module again, and must not start a second schedule.
   */
  var spoolsSyncFiber: Fiber.Fiber<unknown, unknown> | undefined
}

/**
 * Ingestion: read each teammate's mail and calendar, through the Google or
 * Microsoft account they sign in with and any mailbox they connected on the
 * Integrations page, and put what involves a known contact on that contact's
 * timeline, credited to the teammate whose mailbox it came from.
 *
 * Only messages and meetings with an address that is already on a CRM record are
 * kept, and only their subject, a short preview and the time. Everything else in
 * the mailbox is read past and never stored. Where the tokens come from is
 * src/server/mailbox.ts's business.
 *
 * Env:
 *   MAILBOX_SYNC_MINUTES   how often the built-in schedule runs (default 5; 0 turns it off)
 *   MAILBOX_LOOKBACK_DAYS  how far back the first sync of an account reads (default 30)
 */

// ── What a provider gives us, in one shape ──────────────────────────────────

export type MailItem = {
  /** The email's Message-ID where there is one: the same for every mailbox holding a copy. */
  id: string
  from: string
  /** To and Cc. */
  to: string[]
  subject: string
  preview: string
  at: Date
  /**
   * Whether the mailbox itself says its owner sent this. Left out when the
   * provider doesn't say; the From address decides then.
   */
  sent?: boolean
}

export type MeetingItem = {
  /** The event's iCalendar UID where there is one: the same on every attendee's calendar. */
  id: string
  subject: string
  start: Date
  /** Everyone invited, the account owner included. */
  attendees: string[]
}

const ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i

/** A header value's mailboxes: split at each comma or semicolon that is outside quotes and angle brackets. */
function mailboxes(value: string): string[] {
  const found: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  let angled = false

  for (const c of value) {
    if (escaped) {
      escaped = false
    } else if (quoted) {
      escaped = c === '\\'
      quoted = c !== '"'
    } else if (c === '"') {
      quoted = true
    } else if (c === '<') {
      angled = true
    } else if (c === '>') {
      angled = false
    } else if ((c === ',' || c === ';') && !angled) {
      found.push(current)
      current = ''
      continue
    }

    current += c
  }

  return [...found, current]
}

/**
 * The address a mailbox (`"Ada" <ada@x.com>`, `ben@y.com`) stands for, or null.
 * The name beside an address is whatever the sender typed, another address
 * included, so only the address itself is read: what is in the angle brackets,
 * or else the whole of it without quoted text and comments. A mailbox with two
 * bracketed addresses is nobody's.
 */
function addressOf(mailbox: string): string | null {
  const bare = mailbox.replace(/"(?:[^"\\]|\\.)*"?/g, ' ').replace(/\([^()]*\)/g, ' ')
  const bracketed = [...bare.matchAll(/<([^<>]*)>/g)].map((m) => m[1] ?? '')

  if (bracketed.length > 1) {
    return null
  }

  // A group's name ends in a colon: `Team: ada@x.com`.
  const candidate = (bracketed[0] ?? bare.slice(bare.lastIndexOf(':') + 1)).trim()
  return ADDRESS.test(candidate) ? candidate.toLowerCase() : null
}

/** Every email address in a header value such as `"Ada" <ada@x.com>, ben@y.com`, lower-cased. */
export function addresses(value: string | null | undefined): string[] {
  return [...new Set(mailboxes(value ?? '').flatMap((m) => addressOf(m) ?? []))]
}

/**
 * Who a message says it is from: the address of a From header with exactly one
 * mailbox, or null. Anything else is not a message a mail server would have
 * delivered as that person's.
 */
export function sender(value: string | null | undefined): string | null {
  const all = mailboxes(value ?? '').filter((m) => m.trim())
  return all.length === 1 ? addressOf(all[0] ?? '') : null
}

const entities = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['#39', "'"],
  ['nbsp', ' '],
])

/** Gmail's snippets are HTML-escaped; turn the common entities back into text. */
export const decodeEntities = (text: string) =>
  text.replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (entity, name: string) => entities.get(name) ?? entity,
  )

// ── Reading a provider's answers ────────────────────────────────────────────

/**
 * A field of a provider's answer the sync can do without: what it should be,
 * or left out when it is missing or something else.
 */
const maybe = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)

/**
 * A list in a provider's answer, keeping the items that are what they should
 * be: one odd message or event doesn't hide the rest.
 */
const listOf = <T extends z.ZodType>(item: T) =>
  maybe(
    z.array(z.json()).transform((items) =>
      items.flatMap((each) => {
        const read = item.safeParse(each)
        return read.success ? [read.data] : []
      }),
    ),
  )

/** Most messages read from one account in one run. The first sync of a busy mailbox stops here. */
const MAIL_LIMIT = 2000

/** Says that a mailbox had more than one run reads: its older mail in this window is not logged. */
const stoppedAtLimit = (mailbox: string, since: Date) =>
  Effect.logWarning(
    `[sync] ${mailbox} has more than ${MAIL_LIMIT} messages since ${since.toISOString()}: only the newest ${MAIL_LIMIT} were read, and the older ones will not be logged`,
  )

// ── Gmail ───────────────────────────────────────────────────────────────────

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

const GmailMessage = z.object({
  id: z.string(),
  /** Gmail's own labels. It puts SENT on what the account sent, and on nothing that arrived. */
  labelIds: maybe(z.array(z.string())),
  internalDate: maybe(z.string()),
  snippet: maybe(z.string()),
  payload: maybe(z.object({ headers: listOf(z.object({ name: z.string(), value: z.string() })) })),
})

type GmailMessage = z.infer<typeof GmailMessage>

const GmailPage = z.object({
  messages: listOf(z.object({ id: z.string() })),
  nextPageToken: maybe(z.string()),
})

export function fromGmail(message: GmailMessage): MailItem | null {
  const header = (name: string) =>
    message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value

  const from = sender(header('From'))

  if (!from) {
    return null
  }

  return {
    id: header('Message-ID')?.trim() || `gmail:${message.id}`,
    from,
    to: [...addresses(header('To')), ...addresses(header('Cc'))],
    subject: header('Subject')?.trim() ?? '',
    preview: decodeEntities(message.snippet ?? '').trim(),
    at: new Date(Number(message.internalDate ?? Date.now())),
    // A From header is the sender's to write, the account owner's address included.
    sent: (message.labelIds ?? []).includes('SENT'),
  }
}

const gmailMail = Effect.fn('sync.gmailMail')(function* (token: string, since: Date) {
  const ids: string[] = []
  let pageToken: string | undefined

  do {
    const query = new URLSearchParams({
      maxResults: '100',
      q: `after:${Math.floor(since.getTime() / 1000)} -in:chats -in:spam -in:trash -in:drafts`,
    })

    if (pageToken) {
      query.set('pageToken', pageToken)
    }

    // An answer that isn't even an object reads as an empty page.
    const page = GmailPage.safeParse(yield* apiGet(`${GMAIL}/messages?${query}`, token)).data ?? {}

    ids.push(...(page.messages ?? []).map((m) => m.id))
    pageToken = page.nextPageToken
  } while (pageToken && ids.length < MAIL_LIMIT)

  if (pageToken) {
    yield* stoppedAtLimit('A Gmail mailbox', since)
  }

  // Headers only: the body of a message is never fetched. Ten at a time.
  const fields = ['From', 'To', 'Cc', 'Subject', 'Message-ID']
    .map((h) => `metadataHeaders=${h}`)
    .join('&')

  const messages = yield* Effect.forEach(
    ids.slice(0, MAIL_LIMIT),
    (id) =>
      Effect.map(
        apiGet(`${GMAIL}/messages/${id}?format=metadata&${fields}`, token),
        (body) => GmailMessage.safeParse(body).data,
      ),
    { concurrency: 10 },
  )

  return messages.flatMap((m) => (m ? (fromGmail(m) ?? []) : []))
})

/** When an event starts or ends. All-day ones have a date and no dateTime. */
const EventTime = z.object({ dateTime: maybe(z.string()) })

const GoogleEvent = z.object({
  id: z.string(),
  iCalUID: maybe(z.string()),
  status: maybe(z.string()),
  summary: maybe(z.string()),
  start: maybe(EventTime),
  end: maybe(EventTime),
  attendees: listOf(
    z.object({
      email: maybe(z.string()),
      self: maybe(z.boolean()),
      responseStatus: maybe(z.string()),
    }),
  ),
})

type GoogleEvent = z.infer<typeof GoogleEvent>

const GooglePage = z.object({ items: listOf(GoogleEvent), nextPageToken: maybe(z.string()) })

export function fromGoogleEvent(event: GoogleEvent, now: Date): MeetingItem | null {
  // All-day entries have a date, not a dateTime: they are reminders and time off, not meetings.
  if (event.status === 'cancelled' || !event.start?.dateTime || !event.end?.dateTime) {
    return null
  }

  if (new Date(event.end.dateTime) > now) {
    return null
  } // hasn't finished yet

  if (event.attendees?.some((a) => a.self && a.responseStatus === 'declined')) {
    return null
  }

  return {
    id: event.iCalUID ?? `google:${event.id}`,
    subject: event.summary?.trim() ?? '',
    start: new Date(event.start.dateTime),
    attendees: (event.attendees ?? []).flatMap((a) => (a.email ? [a.email.toLowerCase()] : [])),
  }
}

const googleMeetings = Effect.fn('sync.googleMeetings')(function* (
  token: string,
  since: Date,
  now: Date,
) {
  const items: MeetingItem[] = []
  let pageToken: string | undefined

  do {
    const query = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      timeMin: since.toISOString(),
      timeMax: now.toISOString(),
    })

    if (pageToken) {
      query.set('pageToken', pageToken)
    }

    const body = yield* apiGet(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`,
      token,
    )

    const page = GooglePage.safeParse(body).data ?? {}

    items.push(...(page.items ?? []).flatMap((e) => fromGoogleEvent(e, now) ?? []))
    pageToken = page.nextPageToken
  } while (pageToken && items.length < MAIL_LIMIT)

  return items
})

// ── Microsoft Graph ─────────────────────────────────────────────────────────

const GRAPH = 'https://graph.microsoft.com/v1.0/me'

const GraphAddress = z.object({ emailAddress: maybe(z.object({ address: maybe(z.string()) })) })
type GraphAddress = z.infer<typeof GraphAddress>

const GraphMessage = z.object({
  id: z.string(),
  internetMessageId: maybe(z.string()),
  subject: maybe(z.string()),
  bodyPreview: maybe(z.string()),
  receivedDateTime: maybe(z.string()),
  isDraft: maybe(z.boolean()),
  /** The folder the message is in. */
  parentFolderId: maybe(z.string()),
  from: maybe(GraphAddress),
  toRecipients: listOf(GraphAddress),
  ccRecipients: listOf(GraphAddress),
})

type GraphMessage = z.infer<typeof GraphMessage>

/** A page of a Graph list: its items, and where the next page is. */
const graphPage = <T extends z.ZodType>(item: T) =>
  z.object({ value: listOf(item), '@odata.nextLink': maybe(z.string()) })

const GraphMessagePage = graphPage(GraphMessage)
const GraphFolder = z.object({ id: maybe(z.string()) })

/**
 * The folders of a Microsoft mailbox that decide how a message is read: the
 * one holding what its owner sent, and the ones holding junk and what was
 * thrown away, which are read past.
 */
export type GraphFolders = { sent: string | null; ignored: ReadonlySet<string> }

const graphAddress = (a: GraphAddress | undefined) => a?.emailAddress?.address?.toLowerCase()

export function fromGraphMessage(message: GraphMessage, folders?: GraphFolders): MailItem | null {
  const from = graphAddress(message.from)

  if (!from || message.isDraft) {
    return null
  }

  if (message.parentFolderId && folders?.ignored.has(message.parentFolderId)) {
    return null
  }

  const item: MailItem = {
    id: message.internetMessageId?.trim() || `graph:${message.id}`,
    from,
    to: [...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])].flatMap(
      (a) => graphAddress(a) ?? [],
    ),
    subject: message.subject?.trim() ?? '',
    preview: (message.bodyPreview ?? '').trim(),
    at: new Date(message.receivedDateTime ?? Date.now()),
  }

  // A From address is the sender's to write, the mailbox owner's own included. Only
  // being in Sent Items says the owner sent a message.
  if (folders) {
    item.sent = folders.sent !== null && message.parentFolderId === folders.sent
  }

  return item
}

/** Graph pages with a full URL; only follow it back to Graph, so the token can't be sent anywhere else. */
const nextGraphPage = (link: string | undefined) =>
  link && new URL(link).hostname === 'graph.microsoft.com' ? link : undefined

/** Graph's own names for the folders every mailbox has, whatever language it is in. */
const graphFolders = Effect.fn('sync.graphFolders')(function* (token: string) {
  const idOf = (name: string) =>
    Effect.map(
      apiGet(`${GRAPH}/mailFolders/${name}?$select=id`, token),
      (body) => GraphFolder.safeParse(body).data?.id ?? null,
    )

  const [sent, junk, deleted] = yield* Effect.all(
    [idOf('sentitems'), idOf('junkemail'), idOf('deleteditems')],
    { concurrency: 3 },
  )

  return {
    sent,
    ignored: new Set([junk, deleted].flatMap((id) => id ?? [])),
  } satisfies GraphFolders
})

const graphMail = Effect.fn('sync.graphMail')(function* (token: string, since: Date) {
  const folders = yield* graphFolders(token)

  const query = new URLSearchParams({
    $select:
      'id,internetMessageId,subject,bodyPreview,receivedDateTime,isDraft,parentFolderId,from,toRecipients,ccRecipients',
    $filter: `receivedDateTime ge ${since.toISOString()}`,
    $orderby: 'receivedDateTime desc',
    $top: '100',
  })

  const items: MailItem[] = []
  let url: string | undefined = `${GRAPH}/messages?${query}`

  while (url && items.length < MAIL_LIMIT) {
    const page = GraphMessagePage.safeParse(yield* apiGet(url, token)).data ?? {}
    items.push(...(page.value ?? []).flatMap((m) => fromGraphMessage(m, folders) ?? []))
    url = nextGraphPage(page['@odata.nextLink'])
  }

  if (url) {
    yield* stoppedAtLimit('A Microsoft mailbox', since)
  }

  return items
})

const GraphEvent = z.object({
  id: z.string(),
  iCalUId: maybe(z.string()),
  subject: maybe(z.string()),
  isCancelled: maybe(z.boolean()),
  isAllDay: maybe(z.boolean()),
  start: maybe(EventTime),
  end: maybe(EventTime),
  responseStatus: maybe(z.object({ response: maybe(z.string()) })),
  attendees: listOf(GraphAddress),
})

type GraphEvent = z.infer<typeof GraphEvent>

const GraphEventPage = graphPage(GraphEvent)

/** Graph returns times without a zone; they are UTC because the request asks for UTC. */
const utc = (dateTime: string) =>
  new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dateTime) ? dateTime : `${dateTime}Z`)

export function fromGraphEvent(event: GraphEvent, now: Date): MeetingItem | null {
  if (event.isCancelled || event.isAllDay || !event.start?.dateTime || !event.end?.dateTime) {
    return null
  }

  if (utc(event.end.dateTime) > now) {
    return null
  }

  if (event.responseStatus?.response === 'declined') {
    return null
  }

  return {
    id: event.iCalUId ?? `graph:${event.id}`,
    subject: event.subject?.trim() ?? '',
    start: utc(event.start.dateTime),
    attendees: (event.attendees ?? []).flatMap((a) => graphAddress(a) ?? []),
  }
}

const graphMeetings = Effect.fn('sync.graphMeetings')(function* (
  token: string,
  since: Date,
  now: Date,
) {
  const query = new URLSearchParams({
    startDateTime: since.toISOString(),
    endDateTime: now.toISOString(),
    $select: 'id,iCalUId,subject,isCancelled,isAllDay,start,end,responseStatus,attendees',
    $top: '100',
  })

  const items: MeetingItem[] = []
  let url: string | undefined = `${GRAPH}/calendarView?${query}`

  while (url && items.length < MAIL_LIMIT) {
    const body = yield* apiGet(url, token, { prefer: 'outlook.timezone="UTC"' })
    const page = GraphEventPage.safeParse(body).data ?? {}

    items.push(...(page.value ?? []).flatMap((e) => fromGraphEvent(e, now) ?? []))
    url = nextGraphPage(page['@odata.nextLink'])
  }

  return items
})

/** How the sync reads one provider's mail and meetings. */
type Reader = { mail: typeof gmailMail; meetings: typeof googleMeetings }

const readers = {
  google: { mail: gmailMail, meetings: googleMeetings },
  microsoft: { mail: graphMail, meetings: graphMeetings },
} satisfies Record<ProviderId, Reader>

// ── Matching mail to records ────────────────────────────────────────────────

export type RecordRef = { objectKey: string; recordId: string }
export type ContactIndex = Map<string, RecordRef[]>

const INDEX_LIMIT = 20_000

/** What an email field must hold to be matched against mail. */
const storedAddress = z.string()

/** Every email address on a CRM record, and the records that carry it. */
export const buildContactIndex = Effect.fn('sync.buildContactIndex')(function* () {
  const index: ContactIndex = new Map()

  for (const [objectKey, obj] of Object.entries(crmConfig().objects)) {
    const fields = Object.keys(obj.fields).filter((k) => obj.fields[k]?.type === 'email')

    if (fields.length === 0) {
      continue
    }

    for (let offset = 0; offset < INDEX_LIMIT; offset += 500) {
      const page = yield* listRecords({ objectKey, limit: 500, offset, relations: 'none' })

      for (const row of page) {
        for (const field of fields) {
          const value = storedAddress.safeParse(row[field]).data

          if (value === undefined || !value.includes('@')) {
            continue
          }

          const key = value.trim().toLowerCase()
          const refs = index.get(key) ?? []
          refs.push({ objectKey, recordId: row.id })
          index.set(key, refs)
        }
      }

      if (page.length < 500) {
        break
      }
    }
  }

  return index
})

/** The records a set of addresses belongs to, without repeats. A message is put on at most ten. */
function recordsFor(index: ContactIndex, addrs: string[]): RecordRef[] {
  const seen = new Map<string, RecordRef>()

  for (const a of addrs) {
    for (const ref of index.get(a) ?? []) {
      seen.set(`${ref.objectKey}:${ref.recordId}`, ref)
    }
  }

  return [...seen.values()].slice(0, 10)
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export type SyncCounts = { emails: number; meetings: number }

/**
 * Put mail and meetings on the timelines of the records they involve.
 *
 * - An email the teammate sent is logged on every recipient that is a record.
 * - An email they received is logged only when its sender is a record.
 * - Mail between colleagues that merely copies a contact is left to the sender's
 *   own mailbox, so it is logged once, as sent by the person who sent it.
 * - A meeting is logged for each teammate who had it on their calendar, so each
 *   of them gets credit for it.
 */
export const ingest = Effect.fn('sync.ingest')(function* (
  who: { userId: string; name: string; accountEmail: string },
  mail: MailItem[],
  meetings: MeetingItem[],
  index: ContactIndex,
) {
  const counts: SyncCounts = { emails: 0, meetings: 0 }
  const me = who.accountEmail.toLowerCase()

  for (const item of mail) {
    const sent = item.sent ?? item.from === me
    const refs = recordsFor(index, sent ? item.to.filter((a) => a !== me) : [item.from])

    for (const ref of refs) {
      const summary = emailSummary(sent ? 'sent' : 'received', item.subject)
      const externalId = `email:${item.id}`

      // Sent from the CRM a moment ago: it is on the timeline already, without an id.
      if (
        sent &&
        (yield* adoptSentEmail({ ...ref, actorId: who.userId, summary, at: item.at, externalId }))
      ) {
        continue
      }

      const added = yield* addActivityOnce({
        ...ref,
        kind: 'email',
        summary,
        body: item.preview ? clip(item.preview, 500) : null,
        actor: who.name,
        actorId: who.userId,
        occurredAt: item.at,
        outcome: sent ? 'sent' : 'received',
        externalId,
      })

      if (added) {
        counts.emails++
      }
    }
  }

  for (const item of meetings) {
    const refs = recordsFor(
      index,
      item.attendees.filter((a) => a !== me),
    )

    for (const ref of refs) {
      const added = yield* addActivityOnce({
        ...ref,
        kind: 'meeting',
        summary: `had a meeting: ${clip(item.subject || '(no title)', 200)}`,
        actor: who.name,
        actorId: who.userId,
        occurredAt: item.start,
        outcome: 'completed',
        externalId: `meeting:${item.id}:${who.userId}`,
      })

      if (added) {
        counts.meetings++
      }
    }
  }

  return counts
})

// ── Running a sync ──────────────────────────────────────────────────────────

const running = new Set<string>()
type Mailbox = Pick<MailboxAccount, 'userId' | 'provider' | 'accountEmail'>
const key = (a: Mailbox) => `${a.userId}:${a.provider}:${a.accountEmail.toLowerCase()}`

/** True while a teammate's mailbox is being synced by this server. */
export const isSyncing = (account: Mailbox): boolean => running.has(key(account))

/** A whole number of days (or minutes) from the environment, or `fallback` when unset or not positive. */
const positive = (name: string, fallback: number) =>
  Effect.map(config.variable(name), (value) => {
    const n = Number(value)
    return value !== undefined && Number.isFinite(n) && n > 0 ? n : fallback
  })

/** Mail is re-read from a little before the last sync, so nothing that arrived mid-sync is missed. */
const OVERLAP_MS = 10 * 60 * 1000
/** A meeting counts once it has ended; look back a day so one that ran across a sync is still seen. */
const MEETING_OVERLAP_MS = 24 * 3_600_000

/** Where the sync has got to for a mailbox, creating the row the first time. */
const stateOf = Effect.fn('sync.stateOf')(function* (account: MailboxAccount) {
  const store = yield* Store
  const where = { userId: account.userId, provider: account.provider }

  // A person has a handful of mailboxes at most; compare addresses without regard to case.
  const find = store
    .find(MailboxSync, { where })
    .pipe(Effect.map((rows) => rows.find((row) => sameMailbox(row, account))))

  const row = yield* find

  if (row) {
    return row
  }

  return yield* store
    .insert(MailboxSync, { ...where, accountEmail: account.accountEmail.toLowerCase() })
    .pipe(
      // Two syncs started together; the unique index kept one row.
      Effect.catchTag('DatabaseError', (error) =>
        Effect.filterOrFail(
          find,
          (existing) => existing !== undefined,
          () => error,
        ),
      ),
    )
})

/**
 * Sync one of a teammate's mailboxes. Never fails, except when the auth provider can't hand
 * out tokens at all (`MailboxError` of kind `setup`): any other failure is
 * recorded on the mailbox, where its owner sees it. Returns null when the
 * mailbox was skipped (it lacks the read scopes, or is already being synced) or
 * the sync failed.
 */
export const syncMailbox = Effect.fn('sync.syncMailbox')(function* (
  account: MailboxAccount,
  options: { index?: ContactIndex; now?: Date } = {},
) {
  if (!canRead(account.provider, account.scopes)) {
    return null
  }

  const id = key(account)

  if (running.has(id)) {
    return null
  }

  running.add(id)
  const store = yield* Store
  return yield* Effect.gen(function* () {
    const row = yield* stateOf(account)
    const now = options.now ?? new Date()
    const lookbackDays = yield* positive('MAILBOX_LOOKBACK_DAYS', 30)

    const since = row.lastSyncedAt
      ? new Date(row.lastSyncedAt.getTime() - OVERLAP_MS)
      : new Date(now.getTime() - lookbackDays * 86_400_000)

    const record = (lastError: string) =>
      store.update(MailboxSync, { where: { id: row.id } }, { lastError }).pipe(Effect.ignore)

    return yield* Effect.gen(function* () {
      const token = yield* accessToken(account)
      const reader = readers[account.provider]

      const [mail, meetings, index] = yield* Effect.all(
        [
          reader.mail(token, since),
          reader.meetings(token, new Date(since.getTime() - MEETING_OVERLAP_MS), now),
          options.index ? Effect.succeed(options.index) : buildContactIndex(),
        ],
        { concurrency: 'unbounded' },
      )

      const counts = yield* ingest(
        { userId: account.userId, name: account.name, accountEmail: account.accountEmail },
        mail,
        meetings,
        index,
      )

      yield* store.update(
        MailboxSync,
        { where: { id: row.id } },
        { lastSyncedAt: now, lastError: null },
      )

      return counts
    }).pipe(
      Effect.catchCause((cause) => {
        // An interrupted sync (shutdown, the request gone) isn't a failure of the mailbox.
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause)
        }

        const failure = Cause.findErrorOption(cause)

        const mailboxError =
          failure._tag === 'Some' && failure.value._tag === 'MailboxError' ? failure.value : null

        if (mailboxError) {
          return record(mailboxError.message).pipe(
            // The auth provider can't hand out tokens at all: every other account would fail the same way.
            Effect.andThen(
              mailboxError.kind === 'setup' ? Effect.fail(mailboxError) : Effect.succeed(null),
            ),
          )
        }

        return Effect.logError(
          `[sync] ${PROVIDERS[account.provider].label} for ${account.userId} failed`,
          Cause.pretty(cause),
        ).pipe(
          Effect.andThen(record('The last sync failed. It will be tried again.')),
          Effect.as(null),
        )
      }),
    )
  }).pipe(Effect.ensuring(Effect.sync(() => running.delete(id))))
})

export type SyncRun = {
  /** Mailboxes that have granted the read scopes. */
  accounts: number
  synced: number
  emails: number
  meetings: number
  /** Accounts left for the next run because this one ran out of time. */
  deferred: number
  /** Set when the auth provider could not provide tokens at all (see docs/mailbox.md). */
  problem?: string
}

/**
 * Sync every teammate's account, one after another, sharing one look at the
 * CRM's contacts. Accounts that have waited longest go first, so a run that is
 * cut short by `budgetMs` (a serverless function's time limit) still reaches
 * everyone over a few runs.
 */
export const syncAll = Effect.fn('sync.syncAll')(function* (
  options: { budgetMs?: number; now?: Date } = {},
) {
  const started = Date.now()
  const store = yield* Store
  const accounts = (yield* listMailboxAccounts()).filter((a) => canRead(a.provider, a.scopes))
  const run: SyncRun = { accounts: accounts.length, synced: 0, emails: 0, meetings: 0, deferred: 0 }

  if (accounts.length === 0) {
    return run
  }

  const states = yield* store.find(MailboxSync, { limit: 1000 })

  const lastSynced = (a: MailboxAccount) =>
    states.find((s) => sameMailbox(s, a))?.lastSyncedAt?.getTime() ?? 0

  accounts.sort((a, b) => lastSynced(a) - lastSynced(b))

  const index = yield* buildContactIndex()

  for (const [i, account] of accounts.entries()) {
    if (options.budgetMs !== undefined && Date.now() - started > options.budgetMs) {
      run.deferred = accounts.length - i
      break
    }

    const outcome = yield* Effect.result(syncMailbox(account, { index, now: options.now }))

    if (outcome._tag === 'Failure') {
      run.problem = outcome.failure.message
      break
    }

    const counts = outcome.success

    if (!counts) {
      continue
    }

    run.synced++
    run.emails += counts.emails
    run.meetings += counts.meetings
  }

  return run
})

/**
 * The built-in schedule: a sync of every mailbox every MAILBOX_SYNC_MINUTES
 * (default 5; 0 turns it off). Runs never overlap, and a setup problem is
 * reported once, not every few minutes.
 */
export const syncSchedule = Effect.gen(function* () {
  const minutes = yield* Effect.map(config.variable('MAILBOX_SYNC_MINUTES'), (v) => Number(v ?? 5))

  if (!Number.isFinite(minutes) || minutes <= 0) {
    return
  }

  let reported = ''

  const tick = syncAll().pipe(
    Effect.tap(({ problem }) =>
      Effect.sync(() => {
        if (problem && problem !== reported) {
          console.warn(`[sync] ${problem}`)
        }

        reported = problem ?? ''
      }),
    ),
    Effect.catchCause((cause) => Effect.logError('[sync] run failed', Cause.pretty(cause))),
  )

  yield* Effect.sleep(`${minutes} minutes`).pipe(
    Effect.andThen(tick),
    Effect.repeat(Schedule.forever),
  )
})

/**
 * Start the built-in schedule. Called once when the server boots; a second call
 * (a dev-server reload) is a no-op. A serverless host has no long-lived process
 * to keep a timer in, so with SERVERLESS=1 the schedule is a cron job that calls
 * /api/cron/mail-sync instead (docs/mailbox.md).
 */
export const startSync = Effect.fn('sync.startSync')(function* () {
  if (yield* config.flag('SERVERLESS')) {
    return
  }

  if (globalThis.spoolsSyncFiber) {
    return
  }

  globalThis.spoolsSyncFiber = runtime().runFork(syncSchedule)
})

// ── For the signed-in teammate ──────────────────────────────────────────────

export type MailboxStatus = {
  provider: ProviderId
  label: string
  accountEmail: string
  /** Set when the mailbox was connected on the Integrations page; null for the sign-in account. */
  connectionId: string | null
  /** A connected mailbox that has to be connected again before it can do anything. */
  needsReconnect: boolean
  /** Mail and calendar can be read, so they are logged on timelines. */
  canRead: boolean
  /** Emails written in the CRM go out from this mailbox. */
  canSend: boolean
  lastSyncedAt: string | null
  lastError: string | null
  syncing: boolean
}

/** The teammate's mailboxes (their sign-in and any they connected) and how the sync is doing on each. */
export const mailboxStatus = Effect.fn('sync.mailboxStatus')(function* (user: CrmUser) {
  const store = yield* Store

  const [accounts, states] = yield* Effect.all(
    [mailboxAccountsOf(user), store.find(MailboxSync, { where: { userId: user.id } })],
    { concurrency: 2 },
  )

  return accounts.map((a): MailboxStatus => {
    const state = states.find((s) => sameMailbox(s, a))
    return {
      provider: a.provider,
      label: PROVIDERS[a.provider].label,
      accountEmail: a.accountEmail,
      connectionId: a.connectionId ?? null,
      needsReconnect: a.needsReconnect ?? false,
      canRead: canRead(a.provider, a.scopes),
      canSend: canSend(a.provider, a.scopes),
      lastSyncedAt: state?.lastSyncedAt?.toISOString() ?? null,
      lastError: state?.lastError ?? null,
      syncing: isSyncing(a),
    }
  })
})

/** What syncing a teammate's mailboxes logged, and the last thing that went wrong. */
export type SyncTotals = { emails: number; meetings: number; problem: string | null }

/** Sync the teammate's own mailboxes now, without waiting for the schedule. */
export const syncMine = Effect.fn('sync.syncMine')(function* (user: CrmUser) {
  const total: SyncTotals = { emails: 0, meetings: 0, problem: null }

  for (const account of yield* mailboxAccountsOf(user)) {
    const outcome = yield* Effect.result(syncMailbox(account))

    if (outcome._tag === 'Failure') {
      total.problem = outcome.failure.message
      continue
    }

    total.emails += outcome.success?.emails ?? 0
    total.meetings += outcome.success?.meetings ?? 0
  }

  return total
})
