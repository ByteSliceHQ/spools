import { createHash, randomUUID } from 'node:crypto'

import { Config, Context, Effect, Layer, Option, Redacted, Schema, Semaphore } from 'effect'
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from 'effect/http'
import type { HttpMethod } from 'effect/http/HttpMethod'

import * as config from '../../../server/runtime/config'
import { FilesError } from '../../../server/runtime/errors'
import { policies, withPolicy } from '../../../server/runtime/policies'

/**
 * FlashDrive's HTTP API (https://flashdrive.space): its settings, calls and the
 * shapes of its answers. The adapter (server.ts) builds the file store on it.
 *
 * Every call has a time limit and, when repeating it is safe (a read, or a
 * write that carries an idempotency key), up to two retries on a network
 * failure, 429 or 502–504 (policies.ts). At most 8 calls (4 byte transfers)
 * run at once per process. Every answer is checked against the shape this
 * code expects; one that doesn't fit is an error naming the store, not an
 * `undefined` three calls later.
 */

export const FILES_ENV = ['FLASHDRIVE_API_KEY', 'FLASHDRIVE_DRIVE_ID'] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What is missing before files can be used; empty when the store is set up. */
export function filesProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = FILES_ENV.filter((name) => !env[name]?.trim()).map(
    (name) => `${name} is not set`,
  )

  const drive = env['FLASHDRIVE_DRIVE_ID']?.trim()

  if (drive && !UUID.test(drive)) {
    problems.push('FLASHDRIVE_DRIVE_ID is not a drive id')
  }

  return problems
}

/** Without the key and drive id, files are off. */
const variables = Config.all({
  apiKey: Config.option(Config.Redacted('FLASHDRIVE_API_KEY')),
  driveId: Config.option(Config.String('FLASHDRIVE_DRIVE_ID')),
  baseUrl: Config.String('FLASHDRIVE_BASE_URL').pipe(
    Config.withDefault('https://api.flashdrive.space'),
  ),
})

/** The store's settings as they are now (they're read on every call, so a test or a fix takes effect at once). */
const settings = Effect.map(config.read(variables), (s) => {
  const key = Option.getOrUndefined(Option.map(s.apiKey, Redacted.value))?.trim() ?? ''
  const drive = Option.getOrUndefined(s.driveId)?.trim() ?? ''
  return {
    key,
    drive,
    origin: (s.baseUrl.trim() || 'https://api.flashdrive.space').replace(/\/+$/, ''),
    problems: filesProblems({ FLASHDRIVE_API_KEY: key, FLASHDRIVE_DRIVE_ID: drive }),
  }
})

/** What is missing before files can be used, from the CRM's own environment. */
export const setupProblems: Effect.Effect<string[]> = Effect.map(settings, (s) => s.problems)

// ── What the store answers ──────────────────────────────────────────────────

const Nullable = <S extends Schema.Top>(s: S) => Schema.optional(Schema.NullOr(s))

export const StoreFolder = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parent_folder_id: Schema.NullOr(Schema.String),
  etag: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  item_count: Schema.optional(Schema.Finite),
})
export type StoreFolder = typeof StoreFolder.Type

/** A file as the documents listing describes it: with who added it and when. */
export const StoreDocument = Schema.Struct({
  id: Schema.String,
  filename: Schema.NullOr(Schema.String),
  source_bytes: Schema.NullOr(Schema.Finite),
  folder_id: Schema.NullOr(Schema.String),
  metadata: Nullable(Schema.Record(Schema.String, Schema.Unknown)),
  created_at: Nullable(Schema.String),
})

export const StoreFile = Schema.Struct({
  document_id: Schema.String,
  path: Schema.String,
  filename: Schema.NullOr(Schema.String),
  folder_id: Schema.NullOr(Schema.String),
  format: Schema.NullOr(Schema.String),
  size_bytes: Schema.NullOr(Schema.Finite),
  revision: Schema.String,
})
export type StoreFile = typeof StoreFile.Type

export const StoreUpload = Schema.Struct({
  id: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  document_id: Nullable(Schema.String),
  error_code: Nullable(Schema.String),
  error_message: Nullable(Schema.String),
  finalization: Nullable(
    Schema.Struct({
      outcome: Schema.optional(Schema.String),
      original: Nullable(Schema.Struct({ id: Schema.optional(Schema.String) })),
      recovery: Nullable(Schema.Struct({ id: Schema.optional(Schema.String) })),
    }),
  ),
})

/** An answer whose body this code doesn't read (a rename, a delete). */
export const Ignored = Schema.Unknown

// The answers below may come with no body at all, which reads as none of their fields.

/** A file's description, for the revision a change must name. */
export const StoreRevision = Schema.NullishOr(
  Schema.Struct({ latest_revision: Nullable(Schema.String) }),
)

/** A folder deletion, or one step of it: the files go a batch at a time. */
export const StoreDeletion = Schema.NullishOr(
  Schema.Struct({ operation_id: Nullable(Schema.String), state: Nullable(Schema.String) }),
)

/** The folders made (or found) for a list of paths. */
export const StoreEnsured = Schema.NullishOr(
  Schema.Struct({
    folders: Nullable(
      Schema.Array(Schema.Struct({ path: Nullable(Schema.String), id: Nullable(Schema.String) })),
    ),
  }),
)

/** A link to one file's bytes. */
export const StoreLink = Schema.NullishOr(Schema.Struct({ url: Nullable(Schema.String) }))

/** Where an upload's bytes go: straight to a signed URL, or through this server. */
export const StoreTransfer = Schema.NullishOr(
  Schema.Struct({
    transport: Nullable(Schema.String),
    url: Nullable(Schema.String),
    headers: Nullable(Schema.Record(Schema.String, Schema.String)),
  }),
)

const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ data: Schema.optional(Schema.Array(item)), next_cursor: Nullable(Schema.String) })

// ── Calls ───────────────────────────────────────────────────────────────────

export type StoreInit = {
  method?: HttpMethod
  body?: unknown
  /** Makes a retry of the same request safe: the store answers it once. */
  idempotencyKey?: string
  ifMatch?: string
  /** Raw bytes to pass through, with their length. A stream can't be sent twice. */
  stream?: { body: ReadableStream<Uint8Array> | ArrayBuffer; length: number }
}

/** The store wants keys of visible ASCII, at most 128 characters; a hash is both. */
export const key = (...parts: string[]) =>
  createHash('sha256').update(parts.join(':')).digest('hex')
/** A key for something done once, now. */
export const once = (what: string) => key(what, randomUUID())

/**
 * What every request tells the store about its caller. The store refuses a
 * caller it takes for an outdated client with 426, on two counts:
 *
 * - `Flashdrive-Client: name/version`. The version is read as the version of the
 *   store's client contract, not of the app calling it. This code is written
 *   against the contract of FlashDrive's SDK 1.1.2, so that is what it states.
 *   Move it when this file is brought up to a newer contract.
 * - `Flashdrive-Write-Protocol`. The SDK sends it with every request; a write
 *   without it is refused, whatever version is stated.
 *
 * None of this is in the store's public documentation: it is read from the SDK
 * and from what the store refused. So there are two profiles, tried in order.
 * The first is this client under its own name. The second sends exactly what
 * the SDK sends, in case the store wants more of it than is known; whichever is
 * accepted is kept, and a refusal is logged with what the store said.
 */
const STORE_CONTRACT = '1.1.2'
const WRITE_PROTOCOL = 'server-v1'

/** How a request names its client to the store (see above). */
type ClientProfile = {
  'flashdrive-client': string
  'flashdrive-write-protocol': string
  'flashdrive-source'?: string
  'user-agent'?: string
}

const CLIENT_PROFILES: ClientProfile[] = [
  {
    'flashdrive-client': `swirls-crm/${STORE_CONTRACT}`,
    'flashdrive-write-protocol': WRITE_PROTOCOL,
  },
  {
    'flashdrive-client': `flashdrive-sdk/${STORE_CONTRACT}`,
    'flashdrive-write-protocol': WRITE_PROTOCOL,
    'flashdrive-source': 'sdk',
    'user-agent': `flashdrive/${STORE_CONTRACT}`,
  },
]

/**
 * Effect's fetch client drops a `content-length` header, but the store wants
 * one with a relayed file's bytes (a stream's length can't be read from it).
 * It travels under this name and is put back just before fetch.
 */
const LENGTH = 'x-crm-content-length'

/** Every header a request to the store may carry. */
type StoreHeaders = Partial<ClientProfile> & {
  authorization: string
  accept: string
  'idempotency-key'?: string
  'if-match'?: string
  [LENGTH]?: string
}

const withLength = (fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const length = headers.get(LENGTH)

      if (length === null) {
        return fetch(input, init)
      }

      headers.delete(LENGTH)
      headers.set('content-length', length)
      return fetch(input, { ...init, headers })
    },
    { preconnect: fetch.preconnect },
  )

type Reply = { status: number; ok: boolean; text: string; notice: string | null }

/** A transient answer (429, 502–504) to a request that is safe to repeat: try again. */
class Busy {
  readonly _tag = 'Busy'
  constructor(readonly reply: Reply) {}
}

const isStream = (init: StoreInit) => !!init.stream && !(init.stream.body instanceof ArrayBuffer)

/** What the store says about a request it refused: only the parts this code reads. */
const StoreRefusal = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      details: Schema.optional(Schema.Json),
    }),
  ),
})

type RefusalDetail = NonNullable<typeof StoreRefusal.Type.error>

/** The store's own wording is written for whoever holds the key; say what the teammate can act on. */
function refusal(reply: Reply, error: RefusalDetail | undefined): FilesError {
  const code = error?.code ?? `http_${reply.status}`
  const status = reply.status

  const message =
    status === 401 || status === 403
      ? "The file store refused this CRM's key. Ask whoever runs the CRM to check FLASHDRIVE_API_KEY and the drive."
      : status === 426
        ? 'The file store needs a newer client than this CRM speaks. Ask whoever runs the CRM to update it.'
        : status === 404
          ? 'That is no longer in the file store.'
          : code === 'duplicate_name' || code === 'already_exists'
            ? 'Something with that name is already there.'
            : status === 412 || code === 'stale_version'
              ? 'That changed while you were looking at it. Try again.'
              : error?.type === 'quota' || error?.type === 'payment_required'
                ? 'The file store is full or over its plan. Ask whoever runs the CRM to add storage.'
                : status === 429 || status >= 500
                  ? 'The file store is busy. Try again in a moment.'
                  : (error?.message ?? 'The file store refused the request.')

  return new FilesError({ message, code, status })
}

const JsonText = Schema.fromJsonString(Schema.Json)

/** An answer's body as JSON; an empty body, or one that isn't JSON, is no body. */
const parse = (text: string) => Option.getOrUndefined(Schema.decodeOption(JsonText)(text))

export class FlashDrive extends Context.Service<
  FlashDrive,
  {
    /** The drive's API path (`/v1/drives/<id>`), or `FilesError` when files aren't set up. */
    readonly base: Effect.Effect<string, FilesError>
    /** The drive id, or `FilesError` when files aren't set up. */
    readonly drive: Effect.Effect<string, FilesError>
    /** Where the store is (`FLASHDRIVE_BASE_URL`, or the real one). */
    readonly origin: Effect.Effect<string>
    /** One call. Fails with `FilesError` for anything but a 2xx, or an answer that doesn't fit `schema`. */
    readonly request: <S extends Schema.Top>(
      path: string,
      schema: S,
      init?: StoreInit,
    ) => Effect.Effect<S['Type'], FilesError, S['DecodingServices']>
    /** Every page of a listing, up to `max` items. */
    readonly pages: <S extends Schema.Top>(
      path: string,
      item: S,
      max?: number,
    ) => Effect.Effect<
      { items: S['Type'][]; truncated: boolean },
      FilesError,
      S['DecodingServices']
    >
  }
>()('spools/FlashDrive') {
  static readonly layer = Layer.effect(
    FlashDrive,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const calls = yield* Semaphore.make(8)
      const transfers = yield* Semaphore.make(4)
      let profile = 0

      const ready = Effect.gen(function* () {
        const s = yield* settings

        if (s.problems.length > 0) {
          return yield* new FilesError({ message: "Files haven't been set up for this CRM yet." })
        }

        return s
      })

      /** One exchange with the store, with the policy's limit and retries. Never fails on an HTTP status. */
      const exchange = (path: string, init: StoreInit, used: number) =>
        Effect.gen(function* () {
          const s = yield* settings

          const headers: StoreHeaders = {
            authorization: `Bearer ${s.key}`,
            // Required by the API: which client is calling, and the contract it speaks.
            ...CLIENT_PROFILES[used],
            accept: 'application/json',
          }

          if (init.idempotencyKey) {
            headers['idempotency-key'] = init.idempotencyKey
          }

          if (init.ifMatch) {
            headers['if-match'] = init.ifMatch
          }

          let body: HttpBody.HttpBody = HttpBody.empty

          if (init.stream) {
            // Passed through as it is: a stream goes to fetch unread, with its length (see `withLength`).
            body = HttpBody.raw(init.stream.body, {
              contentType: 'application/octet-stream',
              contentLength: init.stream.length,
            })

            headers[LENGTH] = String(init.stream.length)
          } else if (init.body !== undefined) {
            body = HttpBody.text(JSON.stringify(init.body), 'application/json')
          }

          const method: HttpMethod =
            init.method ?? (init.body === undefined && !init.stream ? 'GET' : 'POST')

          const replayable = !isStream(init) && (method === 'GET' || !!init.idempotencyKey)

          const request = HttpClientRequest.make(method)(`${s.origin}${path}`, { headers }).pipe(
            HttpClientRequest.setBody(body),
          )

          const fetchNow = yield* FetchHttpClient.Fetch

          const attempt = client.execute(request).pipe(
            Effect.flatMap((res) =>
              Effect.map(res.text, (text): Reply => ({
                status: res.status,
                ok: res.status >= 200 && res.status < 300,
                text,
                notice: res.headers['flashdrive-client-notice'] ?? null,
              })),
            ),
            Effect.provideService(FetchHttpClient.Fetch, withLength(fetchNow)),
            Effect.filterOrFail(
              (reply) => !(replayable && [429, 502, 503, 504].includes(reply.status)),
              (reply) => new Busy(reply),
            ),
          )

          const policy = init.stream ? policies.fileTransfer : policies.files

          const reply = yield* Semaphore.withPermit(init.stream ? transfers : calls, attempt).pipe(
            withPolicy(policy, () => replayable),
            Effect.catchTags({
              Busy: (busy) => Effect.succeed(busy.reply),
              HttpClientError: () =>
                Effect.fail(
                  new FilesError({
                    message: 'The file store could not be reached. Try again in a moment.',
                    code: 'unreachable',
                  }),
                ),
              Timeout: (timeout) =>
                Effect.fail(new FilesError({ message: timeout.message, code: 'timeout' })),
            }),
          )

          return { reply, method, headers }
        })

      const request = Effect.fn('FlashDrive.request')(function* <S extends Schema.Top>(
        path: string,
        schema: S,
        init: StoreInit = {},
      ) {
        for (;;) {
          const used = profile
          const { reply, method, headers } = yield* exchange(path, init, used)
          const parsed = parse(reply.text)

          if (reply.ok) {
            return yield* Schema.decodeEffect(schema)(parsed).pipe(
              Effect.catchTag('SchemaError', (error) =>
                Effect.logError(
                  `[files] ${method} ${path.split('?')[0]} answered in an unexpected shape`,
                  error,
                ).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new FilesError({
                        message:
                          "The file store answered in a way this CRM doesn't understand. Ask whoever runs the CRM to update it.",
                        code: 'unexpected_answer',
                      }),
                    ),
                  ),
                ),
              ),
            )
          }

          // The store refused the request unread because of what the caller said about itself. A body
          // that is a stream can't be sent twice; anything else is asked again as the next profile, and that kept.
          if (reply.status === 426) {
            yield* Effect.logError(
              `[files] the store refused client profile ${used} (${headers['flashdrive-client']}) on ${method} ` +
                `${path.split('?')[0]}: ${reply.text.slice(0, 300)}${reply.notice ? ` notice: ${reply.notice}` : ''}`,
            )

            if (!isStream(init)) {
              if (profile === used && used < CLIENT_PROFILES.length - 1) {
                profile = used + 1
              }

              if (profile !== used) {
                continue
              }
            }
          }

          const refused = Option.getOrUndefined(
            Schema.decodeUnknownOption(StoreRefusal)(parsed),
          )?.error

          const error = refusal(reply, refused)

          if (reply.status !== 404) {
            const details = refused?.details

            yield* Effect.logError(
              `[files] ${method} ${path.split('?')[0]} -> ${reply.status} ${error.code}` +
                (details ? ` ${JSON.stringify(details).slice(0, 300)}` : ''),
            )
          }

          return yield* error
        }
      })

      const pages = <S extends Schema.Top>(path: string, item: S, max = 1000) =>
        Effect.gen(function* () {
          const items: S['Type'][] = []
          let cursor: string | null = null

          do {
            const sep = path.includes('?') ? '&' : '?'

            const page: { data?: readonly S['Type'][]; next_cursor?: string | null } =
              yield* request(
                `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
                Page(item),
              )

            items.push(...(page.data ?? []))
            cursor = page.next_cursor ?? null
          } while (cursor && items.length < max)

          return { items, truncated: cursor !== null }
        })

      return FlashDrive.of({
        drive: Effect.map(ready, (s) => s.drive),
        base: Effect.map(ready, (s) => `/v1/drives/${s.drive}`),
        origin: Effect.map(settings, (s) => s.origin),
        request,
        pages,
      })
    }),
  )
}
