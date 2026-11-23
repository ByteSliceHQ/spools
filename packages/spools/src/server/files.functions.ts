import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'

import {
  changeFile,
  changeFolder,
  createFolder,
  deleteFile,
  deleteFolder,
  finishUpload,
  listFolder,
  recordFolder,
  searchFiles,
  setupProblems,
  startUpload,
} from './files'
import { crmHandler } from './runtime/boundary'
import type { FilesError, StaffError } from './runtime/errors'
import { crmConfig } from './spool'

/**
 * Server functions for the file browser (the Files page and a record's Files
 * tab). Anyone who may use the CRM may see and change everything in the file
 * store, as they may notes and tasks. The store's key stays on the server: the
 * browser only ever gets a transfer URL for the one file it is sending.
 */

const id = z.string().uuid()
const folderId = id.nullable()
const objectKey = z.string().refine((k) => Object.hasOwn(crmConfig().objects, k), 'Unknown object')
const recordRef = z.object({ objectKey, recordId: id })
const name = z.string().min(1).max(400)

/** Errors a teammate can act on travel as data, so the browser can show them where they happened. */
const told = <A, E extends StaffError, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catchIf(
      (error): error is Extract<E, FilesError> => error._tag === 'FilesError',
      (error) => Effect.succeed({ ok: false as const, error: error.message }),
    ),
  )

/** A folder's contents; `folderId: null` is the store's top level. `problems` says why files can't be used yet. */
export const listFolderFn = createServerFn({ method: 'GET' })
  .validator(z.object({ folderId }))
  .handler(
    crmHandler('files.listFolder', ({ data }) =>
      Effect.gen(function* () {
        const problems = yield* setupProblems

        if (problems.length > 0) {
          return { problems, listing: null, error: null }
        }

        const res = yield* told(listFolder(data.folderId))
        return { problems, listing: res.ok ? res.value : null, error: res.ok ? null : res.error }
      }),
    ),
  )

/** A record's own folder, made on first use. `null` when the store isn't set up. */
export const recordFolderFn = createServerFn({ method: 'POST' })
  .validator(recordRef)
  .handler(
    crmHandler('files.recordFolder', ({ data }) =>
      Effect.gen(function* () {
        if ((yield* setupProblems).length > 0) {
          return { ok: true as const, value: null }
        }

        return yield* told(recordFolder(data.objectKey, data.recordId))
      }),
    ),
  )

export const searchFilesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string().max(200) }))
  .handler(crmHandler('files.searchFiles', ({ data }) => told(searchFiles(data.q))))

export const createFolderFn = createServerFn({ method: 'POST' })
  .validator(z.object({ parentId: folderId, name }))
  .handler(
    crmHandler('files.createFolder', ({ data }) => told(createFolder(data.parentId, data.name))),
  )

const item = z.object({ kind: z.enum(['folder', 'file']), id })

export const renameItemFn = createServerFn({ method: 'POST' })
  .validator(item.extend({ name }))
  .handler(
    crmHandler('files.renameItem', ({ data }) =>
      told(
        data.kind === 'folder'
          ? changeFolder(data.id, { name: data.name })
          : changeFile(data.id, { name: data.name }),
      ),
    ),
  )

/** Move a file or a folder into `to` (`null` for the store's top level). */
export const moveItemFn = createServerFn({ method: 'POST' })
  .validator(item.extend({ to: folderId }))
  .handler(
    crmHandler('files.moveItem', ({ data }) =>
      told(
        data.kind === 'folder'
          ? changeFolder(data.id, { parentId: data.to })
          : changeFile(data.id, { folderId: data.to }),
      ),
    ),
  )

export const deleteItemFn = createServerFn({ method: 'POST' })
  .validator(item)
  .handler(
    crmHandler('files.deleteItem', ({ data }) =>
      told(data.kind === 'folder' ? deleteFolder(data.id) : deleteFile(data.id)),
    ),
  )

export const startUploadFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      folderId,
      name,
      sizeBytes: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      /** The record whose Files tab this is added from, for its timeline. */
      record: recordRef.nullish(),
    }),
  )
  .handler(crmHandler('files.startUpload', ({ data, user }) => told(startUpload(data, user))))

/** `value` is the file once the store has it, or `null` while the store is still working: ask again. */
export const finishUploadFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id }))
  .handler(crmHandler('files.finishUpload', ({ data, user }) => told(finishUpload(data.id, user))))
