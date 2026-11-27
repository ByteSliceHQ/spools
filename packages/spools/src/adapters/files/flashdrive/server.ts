import { Effect, Layer, Schema } from 'effect'

import { storeFormat } from '../../../crm/files'
import { FilesError } from '../../../server/runtime/errors'
import {
  FileStore,
  type FilesAdapter,
  type StoredFile,
  type StoredFolder,
} from '../../../server/runtime/files'
import {
  FILES_ENV,
  FlashDrive,
  Ignored,
  key,
  once,
  StoreDeletion,
  StoreDocument,
  StoreEnsured,
  StoreFile,
  StoreFolder,
  StoreLink,
  StorePlace,
  StoreRevision,
  StoreTransfer,
  StoreUpload,
  setupProblems,
} from './client'

/**
 * Files in a FlashDrive drive (https://flashdrive.space): a shared drive with an
 * HTTP API that also mounts as a folder, so the team can open the same files in
 * Finder. The drive is the source of truth: whatever is in it is what the CRM
 * shows, however it got there.
 *
 *   FLASHDRIVE_API_KEY    a read-write key for the workspace that holds the drive
 *   FLASHDRIVE_DRIVE_ID   the drive
 *   FLASHDRIVE_BASE_URL   optional: another address for the API
 *
 * The browser sends bytes straight to a transfer URL the store signs for one
 * upload, and opens a file by a link it signs for one file. The key never
 * leaves the server.
 */

const fail = (message: string, code?: string) => Effect.fail(new FilesError({ message, code }))

const toFolder = (f: StoreFolder): StoredFolder => ({
  id: f.id,
  name: f.name,
  parentId: f.parent_folder_id,
  items: f.item_count ?? null,
})

const toFile = (f: StoreFile): StoredFile => ({
  id: f.document_id,
  name: f.filename ?? f.path.split('/').at(-1) ?? 'File',
  sizeBytes: f.size_bytes,
  path: f.path,
  folderId: f.folder_id,
  addedBy: null,
  addedAt: null,
})

/** Who added a file, as the CRM wrote it in the file's metadata. */
const isName = Schema.is(Schema.NonEmptyString)

const fromDocument = (d: typeof StoreDocument.Type): StoredFile => {
  const by = d.metadata?.['added_by']
  return {
    id: d.id,
    name: d.filename ?? 'File',
    sizeBytes: d.source_bytes,
    path: null,
    folderId: d.folder_id,
    addedBy: isName(by) ? by : null,
    addedAt: d.created_at ?? null,
  }
}

const etagOf = (folder: StoreFolder) => {
  const etag = folder.etag ?? (folder.version ? `"${folder.version}"` : undefined)
  return etag ? Effect.succeed(etag) : fail('The file store did not describe that folder.')
}

/** An upload whose bytes come through this server says so in its id: the store is told when it is completed. */
const RELAYED = 'relay:'

/** A new folder, in the store's words. */
type NewFolder = { name: string; parent_folder_id?: string }

/** A change to a folder: only what changes is sent. */
type FolderChange = { name?: string; parent_folder_id?: string | null }

/** A change to a file: only what changes is sent. */
type FileChange = { filename?: string; folder_id?: string | null }

const uploadOf = (uploadId: string) =>
  uploadId.startsWith(RELAYED)
    ? { id: uploadId.slice(RELAYED.length), relayed: true }
    : { id: uploadId, relayed: false }

const layer = Layer.effect(
  FileStore,
  Effect.gen(function* () {
    const api = yield* FlashDrive
    // Uploads the store has been told are complete and was still working on: it is asked how they are, not told again.
    const told = new Set<string>()

    /** The files in one folder, with who added each. */
    const filesIn = Effect.fn('FlashDrive.filesIn')(function* (folderId: string | null) {
      const base = yield* api.base
      const where = `folder_id=${folderId ?? 'root'}`
      return yield* api.pages(`${base}/documents?${where}`, StoreDocument).pipe(
        Effect.map((docs) => ({ truncated: docs.truncated, items: docs.items.map(fromDocument) })),
        // The plainer listing has no names or dates, but a folder must still open if the fuller one is refused.
        Effect.catchTag('FilesError', (error) =>
          error.status === undefined ||
          error.status === 401 ||
          error.status === 403 ||
          error.status === 404
            ? Effect.fail(error)
            : Effect.logError(
                `[files] the documents listing was refused (${error.code}); listing without who added each file`,
              ).pipe(
                Effect.andThen(api.pages(`${base}/files?${where}`, StoreFile)),
                Effect.map((files) => ({
                  truncated: files.truncated,
                  items: files.items.map((f) => ({ ...toFile(f), path: null })),
                })),
              ),
        ),
      )
    })

    /** The revision a change names, so a newer version isn't overwritten blind. */
    const latestRevision = Effect.fn('FlashDrive.latestRevision')(function* (path: string) {
      const current = yield* api.request(path, StoreRevision)

      if (!current?.latest_revision) {
        return yield* fail('The file store did not describe that file.')
      }

      return `"${current.latest_revision}"`
    })

    return FileStore.of({
      problems: setupProblems,
      drive: api.drive,

      folder: Effect.fn('FlashDrive.folder')(function* (id) {
        return toFolder(yield* api.request(`${yield* api.base}/folders/${id}`, StoreFolder))
      }),

      list: Effect.fn('FlashDrive.list')(function* (folderId) {
        const base = yield* api.base

        const [folders, files] = yield* Effect.all(
          [
            api.pages(
              `${base}/folders${folderId ? `?parent_folder_id=${folderId}` : ''}`,
              StoreFolder,
            ),
            filesIn(folderId),
          ],
          { concurrency: 'unbounded' },
        )

        return {
          folders: folders.items.map(toFolder),
          files: files.items,
          truncated: folders.truncated || files.truncated,
        }
      }),

      search: Effect.fn('FlashDrive.search')(function* (words) {
        // The store searches by glob: keep the words, drop anything that would read as a pattern.
        const plain = words
          .replace(/[*?[\]{}\\/]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()

        if (!plain) {
          return { files: [], truncated: false }
        }

        const pattern = `*${plain.split(' ').join('*')}*`

        const found = yield* api.pages(
          `${yield* api.base}/files?pattern=${encodeURIComponent(pattern)}`,
          StoreFile,
          200,
        )

        return { files: found.items.map(toFile), truncated: found.truncated }
      }),

      createFolder: Effect.fn('FlashDrive.createFolder')(function* (parentId, name) {
        const body: NewFolder = { name }

        if (parentId) {
          body.parent_folder_id = parentId
        }

        const created = yield* api.request(`${yield* api.base}/folders`, StoreFolder, {
          body,
          idempotencyKey: once('folder'),
        })

        return toFolder(created)
      }),

      changeFolder: Effect.fn('FlashDrive.changeFolder')(function* (id, change) {
        const path = `${yield* api.base}/folders/${id}`
        const current = yield* api.request(path, StoreFolder)
        const body: FolderChange = {}

        if (change.name !== undefined) {
          body.name = change.name
        }

        if (change.parentId !== undefined) {
          body.parent_folder_id = change.parentId
        }

        yield* api.request(path, Ignored, {
          method: 'PATCH',
          body,
          ifMatch: yield* etagOf(current),
          idempotencyKey: once('folder-change'),
        })
      }),

      deleteFolder: Effect.fn('FlashDrive.deleteFolder')(function* (id) {
        const base = yield* api.base
        const path = `${base}/folders/${id}`
        const current = yield* api.request(path, StoreFolder)

        const deletion = yield* api.request(`${path}?recursive=true`, StoreDeletion, {
          method: 'DELETE',
          ifMatch: yield* etagOf(current),
          idempotencyKey: once('folder-delete'),
        })

        // The folders are gone at once; their files are deleted 200 at a time.
        const operation = deletion?.operation_id

        if (!operation) {
          return
        }

        let state = deletion.state

        for (let step = 0; state !== 'finished' && step < 50; step++) {
          const next = yield* api.request(
            `${base}/folder-deletions/${operation}/step`,
            StoreDeletion,
            { body: {}, idempotencyKey: once('folder-delete-step') },
          )

          state = next?.state
        }
      }),

      ensureFolders: Effect.fn('FlashDrive.ensureFolders')(function* (paths) {
        const made = yield* api.request(`${yield* api.base}/folders/ensure`, StoreEnsured, {
          body: { paths },
          idempotencyKey: once('ensure'),
        })

        const ids = new Map<string, string>()

        for (const f of made?.folders ?? []) {
          if (f.path && f.id) {
            ids.set(f.path, f.id)
          }
        }

        return ids
      }),

      fileFolder: Effect.fn('FlashDrive.fileFolder')(function* (id) {
        const found = yield* api.request(`${yield* api.base}/documents/${id}`, StorePlace)

        // A file at the top level has `folder_id: null`; an answer without the key says nothing.
        return found && found.folder_id !== undefined
          ? found.folder_id
          : yield* fail('The file store did not describe that file.')
      }),

      changeFile: Effect.fn('FlashDrive.changeFile')(function* (id, change) {
        const path = `${yield* api.base}/documents/${id}`
        const ifMatch = yield* latestRevision(path)
        const body: FileChange = {}

        if (change.name !== undefined) {
          body.filename = change.name
        }

        if (change.folderId !== undefined) {
          body.folder_id = change.folderId
        }

        yield* api.request(path, Ignored, {
          method: 'PATCH',
          body,
          ifMatch,
          idempotencyKey: once('file-change'),
        })
      }),

      /** Moved to the store's trash (kept there for an hour). */
      deleteFile: Effect.fn('FlashDrive.deleteFile')(function* (id) {
        const path = `${yield* api.base}/documents/${id}`

        yield* latestRevision(path).pipe(
          Effect.flatMap((ifMatch) =>
            api.request(path, Ignored, {
              method: 'DELETE',
              ifMatch,
              idempotencyKey: once('file-delete'),
            }),
          ),
          Effect.catchTag('FilesError', (error) =>
            error.status === 404 ? Effect.void : Effect.fail(error),
          ),
        )
      }),

      /** A link to one file's bytes that works without a key until it expires, minutes from now. */
      open: Effect.fn('FlashDrive.open')(function* (id) {
        const link = yield* api.request(
          `${yield* api.base}/documents/${id}/source/link`,
          StoreLink,
          {
            body: { ttl_seconds: 300 },
          },
        )

        // Always https, except against a local stand-in for the store (an http FLASHDRIVE_BASE_URL).
        const scheme = (yield* api.origin).startsWith('http://') ? /^https?:\/\// : /^https:\/\//

        const url = link?.url

        if (!url || !scheme.test(url)) {
          return yield* fail('The file store did not return a link.')
        }

        return { kind: 'link' as const, url }
      }),

      startUpload: Effect.fn('FlashDrive.startUpload')(function* (upload) {
        const base = yield* api.base

        const reserved = yield* api.request(`${base}/uploads`, StoreUpload, {
          body: {
            filename: upload.name,
            format: storeFormat(upload.name),
            size_bytes: upload.sizeBytes,
            sha256: upload.sha256,
            // The CRM's id for the upload: the same upload retried is the same file.
            external_id: upload.id,
            folder_id: upload.folderId,
            metadata: { added_by: upload.addedBy, added_in: 'crm' },
          },
          idempotencyKey: key(upload.id, 'create'),
        })

        const uploadId = reserved.id

        if (!uploadId) {
          return yield* fail('The file store did not accept the upload. Try again.')
        }

        const transfer = yield* api.request(`${base}/uploads/${uploadId}/transfer`, StoreTransfer, {
          body: {},
          idempotencyKey: key(upload.id, 'transfer'),
        })

        const url = transfer?.url

        if (transfer?.transport === 'direct' && url !== undefined && url !== null) {
          const target = {
            transport: 'direct' as const,
            url,
            headers: { ...transfer.headers },
          }

          return { uploadId, target }
        }

        if (transfer?.transport === 'proxy') {
          return { uploadId: `${RELAYED}${uploadId}`, target: { transport: 'relay' as const } }
        }

        return yield* fail("The file store offered a way to upload that this CRM doesn't support.")
      }),

      relay: Effect.fn('FlashDrive.relay')(function* (uploadId, body, sizeBytes) {
        const { id } = uploadOf(uploadId)

        yield* api.request(`${yield* api.base}/uploads/${id}/content`, Ignored, {
          method: 'PUT',
          stream: { body, length: sizeBytes },
          idempotencyKey: key(id, 'content'),
        })
      }),

      finishUpload: Effect.fn('FlashDrive.finishUpload')(function* (uploadId) {
        const { id, relayed } = uploadOf(uploadId)
        const path = `${yield* api.base}/uploads/${id}`

        const upload = told.has(id)
          ? yield* api.request(path, StoreUpload)
          : yield* api.request(`${path}/complete`, StoreUpload, {
              body: relayed ? {} : { transport: 'direct' },
              idempotencyKey: key(id, 'complete'),
            })

        if (upload.state === 'received' || upload.state === 'processing') {
          told.add(id)
          return { state: 'working' as const }
        }

        told.delete(id)

        if (upload.state === 'awaiting_content') {
          return yield* fail(
            "The file didn't finish uploading. Add it again.",
            'upload_transfer_incomplete',
          )
        }

        // A conflict or orphaned outcome keeps the bytes as a separate copy; either way that copy is the file.
        const fileId =
          upload.finalization?.recovery?.id ??
          upload.finalization?.original?.id ??
          upload.document_id

        if (upload.state !== 'accepted' || !fileId) {
          const error = new FilesError({
            message:
              upload.error_message ?? 'The file store could not keep that file. Add it again.',
            code: upload.error_code ?? upload.state,
          })

          return { state: 'refused' as const, error }
        }

        return { state: 'kept' as const, fileId }
      }),
    })
  }),
)

export const flashdrive = (): FilesAdapter => ({
  id: 'flashdrive',
  label: 'FlashDrive',
  features: [{ name: 'Files on records (FlashDrive)', vars: FILES_ENV }],
  layer: layer.pipe(Layer.provide(FlashDrive.layer)),
})
