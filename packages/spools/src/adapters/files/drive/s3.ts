import { Effect, Schema } from 'effect'

import { servedAs } from '../../../server/downloads'
import type { Feature } from '../../../server/runtime/adapter'
import * as config from '../../../server/runtime/config'
import { FilesError } from '../../../server/runtime/errors'
import { policies, withPolicy } from '../../../server/runtime/policies'
import { type Blobs, gone, isKey } from './blobs'

/**
 * Files' bytes in any S3-compatible bucket: Amazon S3, Cloudflare R2, Supabase
 * Storage, MinIO. Through Bun's own S3 client, so there is nothing to install.
 *
 *   S3_BUCKET              the bucket. Keep it private: files are opened by signed links
 *   S3_ENDPOINT            where the store is, e.g. https://<account>.r2.cloudflarestorage.com. Not needed for Amazon S3
 *   S3_REGION              the bucket's region. Needed for Amazon S3 and Supabase
 *   S3_ACCESS_KEY_ID       a key that may read, write and delete the bucket's objects
 *   S3_SECRET_ACCESS_KEY
 *
 * The browser sends bytes straight to the bucket with a link signed for one
 * object, and opens a file by one that lasts five minutes. The bucket's CORS
 * rules must let the CRM's own address PUT with a content-type header.
 *
 * A signed link can't hold the browser to a size or a hash, and a bucket can't
 * be asked an object's SHA-256 this way: an upload is checked by its size.
 */

const VARIABLES = {
  bucket: 'S3_BUCKET',
  endpoint: 'S3_ENDPOINT',
  region: 'S3_REGION',
  accessKeyId: 'S3_ACCESS_KEY_ID',
  secretAccessKey: 'S3_SECRET_ACCESS_KEY',
} as const

type Setting = keyof typeof VARIABLES

/** Any setting given here is used as it is; the rest are read from the environment. */
export type S3Options = { readonly [S in Setting]?: string } & {
  /** Other variables to read them from, e.g. `{ bucket: "R2_BUCKET" }`. */
  readonly env?: { readonly [S in Setting]?: string }
}

const UPLOAD_SECONDS = 15 * 60
const OPEN_SECONDS = 5 * 60

/** What the bucket said, when it wasn't yes. */
class Refused {
  readonly _tag = 'Refused'
  constructor(readonly code: string) {}
}

/** Answers that a later try won't change. */
const DEFINITE = new Set([
  'NoSuchKey',
  'NoSuchBucket',
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AuthorizationHeaderMalformed',
])

/** An error that names what went wrong in a word, as Bun's S3 client's do. */
const isCoded = Schema.is(Schema.Struct({ code: Schema.String }))

const codeOf = (cause: unknown): string =>
  cause instanceof Error && isCoded(cause) ? cause.code : 'unknown'

const refusal = ({ code }: Refused) =>
  new FilesError({
    message: DEFINITE.has(code)
      ? "The file store refused this CRM's key. Ask whoever runs the CRM to check the bucket and its key."
      : "The file store didn't do that. Try again in a moment; if it keeps happening, ask whoever runs the CRM to check the bucket.",
    code,
  })

/** Says what the bucket refused, then fails with the refusal in words a teammate can act on. */
const told = (name: string) => (error: Refused) =>
  Effect.logError(`[files] the bucket refused ${name}: ${error.code}`).pipe(
    Effect.andThen(Effect.fail(refusal(error))),
  )

export function s3Blobs(options: S3Options = {}): Blobs {
  const nameOf = (setting: Setting) => options.env?.[setting] ?? VARIABLES[setting]

  /** The settings as they are now (they're read on every call, so a test or a fix takes effect at once). */
  const settings = Effect.map(config.environment, (env) => {
    const value = (setting: Setting) =>
      (options[setting] ?? env[nameOf(setting)])?.trim() || undefined

    const region = value('region')

    // Always spelled out: Bun's client would otherwise look for one in variables of its own.
    const endpoint =
      value('endpoint') ?? (region ? `https://s3.${region}.amazonaws.com` : undefined)

    const problems = (['bucket', 'accessKeyId', 'secretAccessKey'] as const)
      .filter((setting) => !value(setting))
      .map((setting) => `${nameOf(setting)} is not set`)

    if (!endpoint) {
      problems.push(`${nameOf('endpoint')} is not set (or ${nameOf('region')}, for Amazon S3)`)
    } else if (!/^https?:$/.test(URL.parse(endpoint)?.protocol ?? '')) {
      problems.push(`${nameOf('endpoint')} is not a web address (https://...)`)
    }

    // Bun signs with this one whatever key it is given, and there is no telling it not to.
    if (
      env['AWS_SESSION_TOKEN'] &&
      !env['S3_SESSION_TOKEN'] &&
      value('accessKeyId') !== env['AWS_ACCESS_KEY_ID']
    ) {
      problems.push("AWS_SESSION_TOKEN is set, for another key than this bucket's: unset it")
    }

    return {
      bucket: value('bucket'),
      endpoint: endpoint?.replace(/\/+$/, ''),
      region: region ?? 'auto',
      accessKeyId: value('accessKeyId'),
      secretAccessKey: value('secretAccessKey'),
      problems,
    }
  })

  const client = Effect.flatMap(settings, ({ problems, ...s }) =>
    problems.length > 0
      ? Effect.fail(new FilesError({ message: "Files haven't been set up for this CRM yet." }))
      : Effect.sync(() => new Bun.S3Client(s)),
  )

  /** A link to one object, signed here: nothing is asked of the bucket. */
  const signed = (key: string, how: Bun.S3FilePresignOptions) =>
    isKey(key) ? Effect.map(client, (bucket) => bucket.presign(key, how)) : Effect.fail(gone())

  /** One call to the bucket. Each one this makes is safe to repeat. */
  const call = <A>(name: string, key: string, work: (bucket: Bun.S3Client) => Promise<A>) =>
    Effect.flatMap(isKey(key) ? client : Effect.fail(gone()), (bucket) =>
      Effect.tryPromise({
        try: () => work(bucket),
        catch: (cause) => new Refused(codeOf(cause)),
      }).pipe(
        withPolicy(policies.files, (error) => !DEFINITE.has(error.code)),
        Effect.catchTag('Timeout', (timeout) =>
          Effect.fail(new FilesError({ message: timeout.message, code: 'timeout' })),
        ),
        Effect.withSpan(`S3.${name}`),
      ),
    )

  const feature: Feature = {
    name: 'Files on records (S3)',
    vars: (['bucket', 'accessKeyId', 'secretAccessKey'] as const)
      .filter((s) => !options[s])
      .map(nameOf),
    check: (env) =>
      options.endpoint || options.region || env[nameOf('endpoint')] || env[nameOf('region')]
        ? null
        : `set ${nameOf('endpoint')} (or ${nameOf('region')}, for Amazon S3)`,
  }

  return {
    features: [feature],
    problems: Effect.map(settings, (s) => s.problems),
    target: (key) =>
      Effect.map(signed(key, { method: 'PUT', expiresIn: UPLOAD_SECONDS }), (url) => ({
        transport: 'direct',
        url,
        headers: { 'content-type': 'application/octet-stream' },
      })),
    stat: (key) =>
      call('stat', key, (bucket) => bucket.stat(key)).pipe(
        Effect.map((found): { sizeBytes: number } | null => ({ sizeBytes: found.size })),
        Effect.catchTag('Refused', (error) =>
          error.code === 'NoSuchKey' ? Effect.succeed(null) : told('to describe a file')(error),
        ),
      ),
    open: (key, name) => {
      const served = servedAs(name)
      return Effect.map(
        signed(key, {
          method: 'GET',
          expiresIn: OPEN_SECONDS,
          // What the bucket answers with, whatever the browser that sent the file called it.
          type: served.contentType,
          contentDisposition: served.disposition,
        }),
        (url) => ({ kind: 'link', url }),
      )
    },
    remove: (key) =>
      call('remove', key, (bucket) => bucket.delete(key)).pipe(
        Effect.catchTag('Refused', (error) =>
          error.code === 'NoSuchKey' ? Effect.void : told('to delete a file')(error),
        ),
      ),
  }
}
