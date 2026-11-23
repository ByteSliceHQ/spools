import type { Effect } from 'effect'

import type { Feature } from '../../../server/runtime/adapter'
import { FilesError } from '../../../server/runtime/errors'
import type { OpenedFile, UploadTarget } from '../../../server/runtime/files'

/**
 * Where the drive keeps files' bytes: a disk (local.ts), a bucket (s3.ts). The
 * drive itself knows names and folders; this knows only bytes under a key. A
 * key is a UUID the server made, never anything a person typed.
 *
 * A failure is a `FilesError` whose message a teammate can act on.
 */

type Call<A> = Effect.Effect<A, FilesError>

/** What an upload's bytes must be, as the browser described them before sending any. */
export type Expected = { readonly sizeBytes: number /** In hex. */; readonly sha256: string }

export type Blobs = {
  /** What the environment switches on, for the boot report. */
  readonly features?: readonly Feature[]
  /** What is missing before bytes can be kept, in words for whoever runs the CRM; empty when ready. Read from the settings alone. */
  readonly problems: Effect.Effect<string[]>
  /** Where the browser sends an upload's bytes. */
  readonly target: (key: string, expected: Expected) => Call<UploadTarget>
  /** Keep a relayed upload's bytes, all of them or none: it fails when they aren't the ones expected. Left out by a store that only takes them directly. */
  readonly put?: (
    key: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer,
    expected: Expected,
  ) => Call<void>
  /** What is kept under a key, or null. A store that can't tell the hash leaves it out. */
  readonly stat: (key: string) => Call<{ sizeBytes: number; sha256?: string } | null>
  /** Open the bytes under a key, as a file of this name. */
  readonly open: (key: string, name: string) => Call<OpenedFile>
  /** Delete the bytes under a key. A key with none is fine. */
  readonly remove: (key: string) => Call<void>
}

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Whether this is a key the drive could have made. */
export const isKey = (key: string): boolean => KEY.test(key)

/** What was asked for isn't there (any more). */
export const gone = () =>
  new FilesError({
    message: 'That is no longer in the file store.',
    code: 'not_found',
    status: 404,
  })

/** The bytes that came aren't the ones the upload was started for. */
export const changed = () =>
  new FilesError({
    message: 'The file changed while it was being added. Add it again.',
    code: 'upload_mismatch',
  })
