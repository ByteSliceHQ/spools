import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { Effect, Schema } from 'effect'

import * as config from '../../../server/runtime/config'
import { FilesError } from '../../../server/runtime/errors'
import { type Blobs, changed, type Expected, gone, isKey } from './blobs'

/**
 * Files' bytes on this machine's disk, for one server with a disk that lasts.
 * The browser sends them to this server, which writes them.
 *
 * A file is written beside where it will be and moved into place only once all
 * of it is there and its size and hash are right, so a file that can be opened
 * is whole. The folder is laid out by key (`ab/ab12...`), and only keys the
 * server made are ever turned into paths.
 */
export type LocalOptions = {
  /** Where the files are kept. Default `.data/files`. Keep it out of anything served as static files. */
  dir?: string
}

const interrupted = () =>
  new FilesError({
    message: 'The upload was interrupted. Add the file again.',
    code: 'upload_interrupted',
  })

/** The chunks of a body, as they arrive. Stops taking them when the signal says so. */
async function* chunksOf(body: ReadableStream<Uint8Array> | ArrayBuffer, signal: AbortSignal) {
  if (body instanceof ArrayBuffer) {
    yield new Uint8Array(body)
    return
  }

  const reader = body.getReader()
  const stop = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', stop, { once: true })

  try {
    for (;;) {
      const next = await reader.read().catch(() => null)

      if (!next || signal.aborted) {
        throw interrupted()
      }

      if (next.done) {
        return
      }

      yield next.value
    }
  } finally {
    signal.removeEventListener('abort', stop)
    stop()
  }
}

/** Writes a body to a new file, refusing one that isn't what was expected. */
async function write(
  path: string,
  body: ReadableStream<Uint8Array> | ArrayBuffer,
  expected: Expected,
  signal: AbortSignal,
) {
  const file = await open(path, 'wx', 0o600)

  try {
    const hash = createHash('sha256')
    let size = 0

    for await (const chunk of chunksOf(body, signal)) {
      size += chunk.byteLength

      if (size > expected.sizeBytes) {
        throw changed()
      }

      hash.update(chunk)

      for (let at = 0; at < chunk.byteLength;) {
        at += (await file.write(chunk, at)).bytesWritten
      }
    }

    if (size !== expected.sizeBytes || hash.digest('hex') !== expected.sha256) {
      throw changed()
    }

    await file.sync()
  } finally {
    await file.close()
  }
}

/** An error from a system call, which names what went wrong in a word (ENOSPC). */
const isCoded = Schema.is(Schema.Struct({ code: Schema.String }))

const errno = (cause: unknown): string =>
  cause instanceof Error && isCoded(cause) ? cause.code : 'unknown'

const failed = (cause: unknown): FilesError => {
  if (cause instanceof FilesError) {
    return cause
  }

  const code = errno(cause)

  const message =
    code === 'ENOSPC' || code === 'EDQUOT'
      ? 'The file store is full. Ask whoever runs the CRM to make room.'
      : 'The file store could not use its disk. Ask whoever runs the CRM to check the folder files are kept in.'

  return new FilesError({ message, code })
}

/** Disk work, with a failure in words for staff and the cause in the log. */
const disk = <A>(work: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, FilesError> =>
  Effect.tryPromise({
    try: (signal) => work(signal),
    catch: (cause) => ({ cause, error: failed(cause) }),
  }).pipe(
    Effect.tapError(({ cause }) =>
      cause instanceof FilesError
        ? Effect.void
        : Effect.logError('[files] the disk refused', cause),
    ),
    Effect.mapError(({ error }) => error),
  )

/** How big the file at a path is, or null when there is none. */
async function sizeOf(path: string): Promise<number | null> {
  try {
    const found = await stat(path)
    return found.isFile() ? found.size : null
  } catch (cause) {
    if (errno(cause) === 'ENOENT') {
      return null
    }

    throw cause
  }
}

export function localBlobs({ dir = '.data/files' }: LocalOptions = {}): Blobs {
  const root = resolve(dir)

  const pathOf = (key: string): Effect.Effect<string, FilesError> =>
    isKey(key) ? Effect.succeed(join(root, key.slice(0, 2), key)) : Effect.fail(gone())

  return {
    features: [{ name: "Files on records (this machine's disk)", vars: [] }],
    problems: Effect.map(config.environment, (env) =>
      config.isOn(env['SERVERLESS'])
        ? [
            "localBlobs() keeps files on the server's disk, and a serverless host has none that lasts: use s3Blobs()",
          ]
        : [],
    ),
    target: () => Effect.succeed({ transport: 'relay' }),
    put: (key, body, expected) =>
      Effect.flatMap(pathOf(key), (path) =>
        disk(async (signal) => {
          const part = `${path}.${randomUUID()}.part`
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })

          try {
            await write(part, body, expected, signal)
            await rename(part, path)
          } catch (cause) {
            await rm(part, { force: true })
            throw cause
          }
        }),
      ),
    // Only bytes whose hash was right are ever under a key, so it isn't worked out again.
    stat: (key) =>
      Effect.flatMap(pathOf(key), (path) => disk(() => sizeOf(path))).pipe(
        Effect.map((sizeBytes) => (sizeBytes === null ? null : { sizeBytes })),
      ),
    open: (key, name) =>
      Effect.gen(function* () {
        const path = yield* pathOf(key)
        const sizeBytes = yield* disk(() => sizeOf(path))

        if (sizeBytes === null) {
          return yield* gone()
        }

        return { kind: 'bytes', body: Bun.file(path).stream(), name, sizeBytes }
      }),
    remove: (key) =>
      Effect.flatMap(pathOf(key), (path) =>
        disk(async () => {
          await rm(path, { force: true })
          // And what a server that stopped in the middle of an upload left behind.
          const beside = await readdir(dirname(path)).catch(() => [])

          for (const name of beside) {
            if (name.startsWith(`${key}.`) && name.endsWith('.part')) {
              await rm(join(dirname(path), name), { force: true })
            }
          }
        }),
      ),
  }
}
