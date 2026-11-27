import { createHash, randomUUID } from 'node:crypto'

import { Clock, Effect, Layer, Predicate, Semaphore } from 'effect'

import {
  type DatabaseError,
  FilesError,
  type ScopeRefused,
  type Timeout,
} from '../../../server/runtime/errors'
import {
  FileStore,
  type FilesAdapter,
  type StoredFile,
  type StoredFolder,
} from '../../../server/runtime/files'
import { and, asc, contains, lt, oneOf } from '../../../server/store/query'
import { Store } from '../../../server/store/store'
import { type Blobs, changed, gone } from './blobs'
import { FileNode, type FileNodeRow } from './table'

export type { Blobs, Expected } from './blobs'
export { type LocalOptions, localBlobs } from './local'
export { type S3Options, s3Blobs } from './s3'
export { FileNode } from './table'

/**
 * A file store of the Spool's own: the folders and files are rows in its
 * database (`file_nodes`), and the bytes are in a blob store (blobs.ts), a disk
 * or a bucket.
 *
 *   files: drive({ blobs: s3Blobs() })
 *
 * An upload is a row nobody is shown (`pending`) until its bytes are confirmed.
 * Deleting is for good: there is no trash.
 *
 * The database interface has no transactions, so changes to the tree are made
 * one at a time in this process, and what two processes could do to each other
 * is settled by the table: a folder's id follows from where it is made and its
 * name, so of two that make the same folder at once one is told it exists.
 */
export type DriveOptions = {
  /** Where the bytes are kept: `localBlobs()`, `s3Blobs()`, or your own. */
  blobs: Blobs
}

/** There is one drive in a Spool's database, whichever blob store it uses. */
const DRIVE = 'drive'
/** The most folders, and the most files, shown in one folder. */
const LISTED = 1000
/** The most files a search answers with, and the most it looks through for them. */
const FOUND = 200
const LOOKED_THROUGH = 2000
/** Ids are looked up this many at a time, to keep a statement's parameters within bounds. */
const CHUNK = 500
/** How many of the ids a new folder could have are tried at once. One is nearly always enough. */
const TRIED = 32
/** An upload that isn't finished by then never will be. */
const ABANDONED_MS = 24 * 60 * 60 * 1000
/** How often abandoned uploads are looked for. */
const SWEEP_MS = 60 * 60 * 1000

type Call<A> = Effect.Effect<A, FilesError>

const taken = () =>
  new FilesError({ message: 'Something with that name is already there.', code: 'duplicate_name' })

const nested = () =>
  new FilesError({ message: "A folder can't be moved into itself.", code: 'nested' })

const toFolder = (row: FileNodeRow, items: number | null): StoredFolder => ({
  id: row.id,
  name: row.name,
  parentId: row.parentId,
  items,
})

const toFile = (row: FileNodeRow, path: string | null): StoredFile => ({
  id: row.id,
  name: row.name,
  sizeBytes: row.sizeBytes,
  folderId: row.parentId,
  path,
  addedBy: row.addedBy,
  addedAt: row.createdAt.toISOString(),
})

const chunks = <A>(items: readonly A[]): A[][] =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) =>
    items.slice(i * CHUNK, (i + 1) * CHUNK),
  )

/** "plan.pdf" the second time is "plan (2).pdf". */
const numbered = (name: string, n: number): string => {
  if (n === 1) {
    return name
  }

  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}

/** The id of the nth folder made in this place with this name, as a UUID: the same for everyone who works it out. */
function folderId(parentId: string | null, name: string, n: number): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['spools-drive-folder', parentId, name, n]))
    .digest('hex')

  // The version and variant of a UUID made from a hash (RFC 9562, version 8).
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Whether a name contains every word, in order, any case. */
function hasInOrder(name: string, words: readonly string[]): boolean {
  const text = name.toLowerCase()
  let at = 0

  for (const word of words) {
    const found = text.indexOf(word.toLowerCase(), at)

    if (found < 0) {
      return false
    }

    at = found + word.length
  }

  return true
}

/** What the database refused, as the file store's own failure. */
const settled = <A>(
  work: Effect.Effect<A, FilesError | DatabaseError | Timeout | ScopeRefused>,
): Call<A> =>
  work.pipe(
    Effect.catchTags({
      Timeout: (timeout) =>
        Effect.fail(new FilesError({ message: timeout.message, code: 'timeout' })),
      // The record-scope guard's words are written for staff: they are passed on as they are.
      ScopeRefused: (refused) =>
        Effect.fail(new FilesError({ message: refused.message, code: 'scope' })),
      DatabaseError: (error) =>
        Effect.logError(`[files] the database refused: ${error.message}`).pipe(
          Effect.andThen(
            Effect.fail(
              new FilesError({
                message: 'The file store could not do that. Try again.',
                code: 'database',
              }),
            ),
          ),
        ),
    }),
  )

/** An abandoned upload that couldn't be removed is tried again at the next sweep. */
const leftForNextTime = (error: FilesError | DatabaseError | Timeout | ScopeRefused) =>
  Effect.logWarning('[files] an abandoned upload could not be removed', error)

const make = (blobs: Blobs) =>
  Effect.gen(function* () {
    const db = yield* Store
    const tree = yield* Semaphore.make(1)
    let sweptAt = 0

    const ready = Effect.flatMap(blobs.problems, (problems) =>
      problems.length > 0
        ? Effect.fail(new FilesError({ message: "Files haven't been set up for this CRM yet." }))
        : Effect.void,
    )

    /** One operation of the store: refused until it is set up, with the database's failures put as the store's. */
    const call = <A>(
      name: string,
      work: Effect.Effect<A, FilesError | DatabaseError | Timeout | ScopeRefused>,
    ): Call<A> => settled(Effect.andThen(ready, work)).pipe(Effect.withSpan(`Drive.${name}`))

    /** An operation that changes where things are or what they're called. */
    const change = <A>(
      name: string,
      work: Effect.Effect<A, FilesError | DatabaseError | Timeout | ScopeRefused>,
    ): Call<A> => call(name, tree.withPermit(work))

    /** A folder or file people can see. */
    const node = Effect.fn('Drive.node')(function* (id: string, kind: 'folder' | 'file') {
      const row = yield* db.first(FileNode, { where: { id, kind, pending: false } })
      return row ?? (yield* gone())
    })

    /** Fails when the folder something is going into is no longer there. */
    const landing = (parentId: string | null) =>
      parentId === null ? Effect.void : node(parentId, 'folder')

    const folderNamed = (parentId: string | null, name: string) =>
      // Should there ever be two, everyone means the older.
      db.first(FileNode, {
        where: { parentId, kind: 'folder', name },
        order: [asc('createdAt'), asc('id')],
      })

    /** The folder and the ones above it, from the inside out. */
    const upFrom = Effect.fn('Drive.upFrom')(function* (id: string) {
      const above = new Set<string>()
      let at: string | null = id

      while (at && !above.has(at)) {
        const row: FileNodeRow = yield* node(at, 'folder')
        above.add(row.id)
        at = row.parentId
      }

      return above
    })

    /** Fails when a folder is another one, or somewhere inside it. */
    const apart = (inner: string, id: string) =>
      Effect.flatMap(upFrom(inner), (above) =>
        above.has(id) ? Effect.fail(nested()) : Effect.void,
      )

    /** The first id a folder made here with this name can have: ones made before may since have been moved or renamed. */
    const freeFolderId = Effect.fn('Drive.freeFolderId')(function* (
      parentId: string | null,
      name: string,
    ) {
      for (let from = 0; ; from += TRIED) {
        const ids = Array.from({ length: TRIED }, (_, i) => folderId(parentId, name, from + i))
        const used = yield* db.find(FileNode, { filter: oneOf('id', ids), select: ['id'] })
        const inUse = new Set(used.map((row) => row.id))
        const free = ids.find((id) => !inUse.has(id))

        if (free) {
          return free
        }
      }
    })

    /** A folder with this name in this place: the one that is there, or a new one. */
    const folderAt = Effect.fn('Drive.folderAt')(function* (parentId: string | null, name: string) {
      const there = yield* folderNamed(parentId, name)

      if (there) {
        return { row: there, made: false }
      }

      const id = yield* freeFolderId(parentId, name)
      // Looked for again after the ids were: one made since the first look may be why an id wasn't free.
      const since = yield* folderNamed(parentId, name)

      if (since) {
        return { row: since, made: false }
      }

      return yield* db.insert(FileNode, { id, kind: 'folder', name, parentId }).pipe(
        Effect.map((row) => ({ row, made: true })),
        // Someone else is making it too, under the same id: the one who got there first made it.
        Effect.catchTag('DatabaseError', (error) =>
          Effect.flatMap(folderNamed(parentId, name), (row) =>
            row ? Effect.succeed({ row, made: false }) : Effect.fail(error),
          ),
        ),
      )
    })

    /** The name a file gets in a folder: its own, or with a number when another file there has it. */
    const freeName = Effect.fn('Drive.freeName')(function* (
      parentId: string | null,
      name: string,
      id: string,
    ) {
      const beside = yield* db.find(FileNode, {
        where: { parentId, kind: 'file', pending: false },
        select: ['id', 'name'],
      })

      const names = new Set(beside.flatMap((row) => (row.id === id ? [] : [row.name])))
      let n = 1

      while (names.has(numbered(name, n))) {
        n++
      }

      return numbered(name, n)
    })

    /** A file's bytes, then the file: should the second fail, deleting it again finishes the job. */
    const discard = (row: Pick<FileNodeRow, 'id' | 'blobKey'>) =>
      Effect.gen(function* () {
        if (row.blobKey) {
          yield* blobs.remove(row.blobKey)
        }

        yield* db.remove(FileNode, { where: { id: row.id } })
      }).pipe(Effect.uninterruptible)

    /** Everything in a folder, however deep, hidden uploads included. Folders come before what is in them. */
    const below = Effect.fn('Drive.below')(function* (id: string) {
      const folders = [id]
      const files: Pick<FileNodeRow, 'id' | 'blobKey'>[] = []
      const seen = new Set(folders)
      let level = [id]

      while (level.length > 0) {
        const inside = yield* Effect.forEach(chunks(level), (ids) =>
          db.find(FileNode, { filter: oneOf('parentId', ids), select: ['id', 'kind', 'blobKey'] }),
        )

        level = []

        for (const row of inside.flat()) {
          if (row.kind !== 'folder') {
            files.push(row)
          } else if (!seen.has(row.id)) {
            seen.add(row.id)
            folders.push(row.id)
            level.push(row.id)
          }
        }
      }

      return { folders, files }
    })

    /** The paths of folders from the top level, for the ones that lead there. */
    const pathsOf = Effect.fn('Drive.pathsOf')(function* (ids: readonly string[]) {
      const known = new Map<string, { name: string; parentId: string | null }>()
      let wanted = [...new Set(ids)]

      while (wanted.length > 0) {
        const rows = yield* Effect.forEach(chunks(wanted), (some) =>
          db.find(FileNode, {
            where: { kind: 'folder' },
            filter: oneOf('id', some),
            select: ['id', 'name', 'parentId'],
          }),
        )

        for (const row of rows.flat()) {
          known.set(row.id, row)
        }

        const above = rows.flat().flatMap((row) => (row.parentId ? [row.parentId] : []))
        wanted = [...new Set(above)].filter((id) => !known.has(id))
      }

      const pathOf = (id: string): string | null => {
        const names: string[] = []
        let at: string | null = id

        for (let depth = 0; at !== null; depth++) {
          const folder = known.get(at)

          if (!folder || depth > known.size) {
            return null
          }

          names.unshift(folder.name)
          at = folder.parentId
        }

        return names.join('/')
      }

      return new Map(ids.map((id) => [id, pathOf(id)]))
    })

    /** Forget uploads that were started and never finished, now and then. */
    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis

      if (now - sweptAt < SWEEP_MS) {
        return
      }

      sweptAt = now

      const old = yield* db.find(FileNode, {
        where: { pending: true },
        filter: lt('createdAt', new Date(now - ABANDONED_MS)),
        limit: 100,
      })

      yield* Effect.forEach(old, (row) => Effect.catch(discard(row), leftForNextTime), {
        concurrency: 8,
        discard: true,
      })
    }).pipe(Effect.catch(leftForNextTime))

    return FileStore.of({
      problems: blobs.problems,
      drive: Effect.as(ready, DRIVE),

      folder: (id) =>
        call(
          'folder',
          Effect.map(node(id, 'folder'), (row) => toFolder(row, null)),
        ),

      list: (parentId) =>
        call(
          'list',
          Effect.gen(function* () {
            const inside = (kind: 'folder' | 'file') =>
              db.find(FileNode, {
                where: { parentId, kind, pending: false },
                order: [asc('name'), asc('id')],
                limit: LISTED + 1,
              })

            const [, folders, files] = yield* Effect.all(
              [landing(parentId), inside('folder'), inside('file')],
              {
                concurrency: 'unbounded',
              },
            )

            const shown = folders.slice(0, LISTED)

            const counts = yield* Effect.forEach(chunks(shown.map((row) => row.id)), (ids) =>
              db.countValues(FileNode, 'parentId', {
                where: { pending: false },
                filter: oneOf('parentId', ids),
                atLeast: 1,
              }),
            )

            const items = new Map(counts.flat().map(({ value, count }) => [value, count]))
            return {
              folders: shown.map((row) => toFolder(row, items.get(row.id) ?? 0)),
              files: files.slice(0, LISTED).map((row) => toFile(row, null)),
              truncated: folders.length > LISTED || files.length > LISTED,
            }
          }),
        ),

      search: (typed) =>
        call(
          'search',
          Effect.gen(function* () {
            // No name has these characters in it (`safeName`), so they are read as spaces.
            const words = typed.split(/[\s/\\:*?"<>|]+/).filter(Boolean)

            if (words.length === 0) {
              return { files: [], truncated: false }
            }

            const rows = yield* db.find(FileNode, {
              where: { kind: 'file', pending: false },
              filter: and(...words.map((word) => contains('name', word))),
              order: [asc('name'), asc('id')],
              limit: LOOKED_THROUGH,
            })

            const matches = rows.filter((row) => hasInOrder(row.name, words))
            const shown = matches.slice(0, FOUND)

            const paths = yield* pathsOf(
              shown.flatMap((row) => (row.parentId ? [row.parentId] : [])),
            )

            return {
              files: shown.map((row) => {
                const folder = row.parentId === null ? '' : (paths.get(row.parentId) ?? null)
                return toFile(
                  row,
                  folder === null ? null : folder ? `${folder}/${row.name}` : row.name,
                )
              }),
              truncated: matches.length > FOUND || rows.length === LOOKED_THROUGH,
            }
          }),
        ),

      createFolder: (parentId, name) =>
        change(
          'createFolder',
          Effect.gen(function* () {
            yield* landing(parentId)
            const { row, made } = yield* folderAt(parentId, name)

            if (!made) {
              return yield* taken()
            }

            return toFolder(row, 0)
          }),
        ),

      changeFolder: (id, wanted) =>
        change(
          'changeFolder',
          Effect.gen(function* () {
            const row = yield* node(id, 'folder')
            const name = wanted.name ?? row.name
            const parentId = wanted.parentId === undefined ? row.parentId : wanted.parentId
            const moves = parentId !== null && parentId !== row.parentId

            if (moves) {
              yield* apart(parentId, id)
            }

            const other = yield* folderNamed(parentId, name)

            if (other && other.id !== id) {
              return yield* taken()
            }

            const count = yield* db.update(
              FileNode,
              { where: { id, kind: 'folder' } },
              { name, parentId },
            )

            if (count === 0) {
              return yield* gone()
            }

            // Looked at again now that it is there: another server may have moved or deleted a folder above it
            // in the meantime, and nobody could reach it.
            if (moves) {
              const back = db.update(
                FileNode,
                { where: { id } },
                { name: row.name, parentId: row.parentId },
              )

              yield* apart(parentId, id).pipe(Effect.tapError(() => back))
            }

            return undefined
          }),
        ),

      deleteFolder: (id) =>
        call(
          'deleteFolder',
          Effect.gen(function* () {
            yield* node(id, 'folder')
            let emptied = false

            while (!emptied) {
              yield* Effect.forEach((yield* below(id)).files, discard, {
                concurrency: 8,
                discard: true,
              })

              // Only once it holds no files, so none added in the meantime is left with nowhere to be.
              emptied = yield* tree.withPermit(
                Effect.gen(function* () {
                  const { folders, files } = yield* below(id)

                  if (files.length > 0) {
                    return false
                  }

                  // The innermost first: should it stop, what is left can still be reached and deleted.
                  yield* Effect.forEach(
                    chunks(folders.toReversed()),
                    (ids) => db.remove(FileNode, { filter: oneOf('id', ids) }),
                    { discard: true },
                  )

                  return true
                }),
              )
            }
          }),
        ),

      ensureFolders: (paths) =>
        change(
          'ensureFolders',
          Effect.gen(function* () {
            const ids = new Map<string, string>()
            const made = new Map<string, string>()

            for (const path of paths) {
              let parent: string | null = null
              let at = ''

              for (const name of path.split('/').filter(Boolean)) {
                at = `${at}/${name}`
                const known = made.get(at)
                const id: string = known ?? (yield* folderAt(parent, name)).row.id
                made.set(at, id)
                parent = id
              }

              if (parent) {
                ids.set(path, parent)
              }
            }

            return ids
          }),
        ),

      fileFolder: (id) =>
        call(
          'fileFolder',
          Effect.map(node(id, 'file'), (row) => row.parentId),
        ),

      changeFile: (id, wanted) =>
        change(
          'changeFile',
          Effect.gen(function* () {
            const row = yield* node(id, 'file')
            const parentId = wanted.folderId === undefined ? row.parentId : wanted.folderId

            if (parentId !== row.parentId) {
              yield* landing(parentId)
            }

            const name = yield* freeName(parentId, wanted.name ?? row.name, id)

            const count = yield* db.update(
              FileNode,
              { where: { id, kind: 'file' } },
              { name, parentId },
            )

            if (count === 0) {
              return yield* gone()
            }

            return undefined
          }),
        ),

      deleteFile: (id) =>
        call(
          'deleteFile',
          Effect.gen(function* () {
            const row = yield* db.first(FileNode, { where: { id, kind: 'file', pending: false } })

            if (row) {
              yield* discard(row)
            }
          }),
        ),

      open: (id) =>
        call(
          'open',
          Effect.gen(function* () {
            const row = yield* node(id, 'file')

            if (!row.blobKey) {
              return yield* gone()
            }

            return yield* blobs.open(row.blobKey, row.name)
          }),
        ),

      startUpload: ({ id, name, folderId: parentId, sizeBytes, sha256, addedBy }) =>
        call(
          'startUpload',
          Effect.gen(function* () {
            yield* sweep
            yield* landing(parentId)
            const blobKey = randomUUID()

            const row = yield* db
              .insert(FileNode, {
                id,
                kind: 'file',
                name,
                parentId,
                sizeBytes,
                blobKey,
                sha256,
                addedBy,
                pending: true,
              })
              .pipe(
                // Asked for before, with the same id: the same upload, if it is the same file and still on its way.
                Effect.catchTag('DatabaseError', (error) =>
                  Effect.filterOrFail(
                    db.first(FileNode, {
                      where: { id, kind: 'file', pending: true, sizeBytes, sha256 },
                    }),
                    Predicate.isNotNullish,
                    () => error,
                  ),
                ),
              )

            const target = yield* blobs.target(row.blobKey ?? blobKey, { sizeBytes, sha256 })
            return { uploadId: row.id, target }
          }),
        ),

      relay: (uploadId, body, sizeBytes) =>
        call(
          'relay',
          Effect.gen(function* () {
            const row = yield* db.first(FileNode, {
              where: { id: uploadId, kind: 'file', pending: true },
            })

            if (!row?.blobKey || row.sizeBytes === null || row.sha256 === null) {
              return yield* gone()
            }

            if (!blobs.put) {
              return yield* new FilesError({
                message: 'That upload is not waiting for its file.',
                code: 'not_relayed',
              })
            }

            if (sizeBytes !== row.sizeBytes) {
              return yield* changed()
            }

            return yield* blobs.put(row.blobKey, body, {
              sizeBytes: row.sizeBytes,
              sha256: row.sha256,
            })
          }),
        ),

      finishUpload: (uploadId) =>
        call(
          'finishUpload',
          Effect.gen(function* () {
            const row = yield* db.first(FileNode, { where: { id: uploadId, kind: 'file' } })

            if (!row?.blobKey) {
              return yield* gone()
            }

            if (!row.pending) {
              return { state: 'kept' as const, fileId: row.id }
            }

            const blob = yield* blobs.stat(row.blobKey)

            if (!blob) {
              return yield* new FilesError({
                message: "The file didn't finish uploading. Add it again.",
                code: 'upload_transfer_incomplete',
              })
            }

            if (
              blob.sizeBytes !== row.sizeBytes ||
              (blob.sha256 !== undefined && blob.sha256 !== row.sha256)
            ) {
              yield* discard(row)
              return { state: 'refused' as const, error: changed() }
            }

            return yield* tree.withPermit(
              Effect.gen(function* () {
                const there = yield* landing(row.parentId).pipe(
                  Effect.as(true),
                  Effect.catchTag('FilesError', (error) =>
                    error.status === 404 ? Effect.succeed(false) : Effect.fail(error),
                  ),
                )

                if (!there) {
                  yield* discard(row)
                  return { state: 'refused' as const, error: gone() }
                }

                const name = yield* freeName(row.parentId, row.name, row.id)

                const count = yield* db.update(
                  FileNode,
                  { where: { id: row.id, pending: true } },
                  { pending: false, name },
                )

                // Deleted with its folder while it was being confirmed.
                if (count === 0 && (yield* db.count(FileNode, { where: { id: row.id } })) === 0) {
                  return yield* gone()
                }

                return { state: 'kept' as const, fileId: row.id }
              }),
            )
          }),
        ),
    })
  })

export const drive = ({ blobs }: DriveOptions): FilesAdapter => ({
  id: 'drive',
  label: 'The file store',
  features: blobs.features ?? [],
  tables: [FileNode],
  layer: Layer.effect(FileStore, make(blobs)),
})
