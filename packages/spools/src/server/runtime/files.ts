import { Context, Effect, Layer } from 'effect'

import type { Adapter } from './adapter'
import { FilesError } from './errors'

/**
 * The file store: folders and files, kept outside the CRM's own tables. The
 * Files page and a record's Files tab are a file browser over it
 * (src/server/files.ts builds breadcrumbs, record folders and uploads on top).
 * Adapters are in src/adapters/files/.
 *
 * Every folder and file has an id that stays the same when it is renamed or
 * moved. It is a UUID: links, pages and server functions take nothing else.
 * `null` as a folder is the top level. Names have been made safe (`safeName` in
 * src/crm/files.ts) before they get here.
 *
 * Failures are `FilesError`s whose message a teammate can act on; `status` 404
 * means the thing is no longer there.
 */

export { FilesError }

export type StoredFolder = {
  id: string
  name: string
  parentId: string | null
  /** How many folders and files are directly inside; `null` when the store doesn't say. */
  items: number | null
}

export type StoredFile = {
  id: string
  name: string
  sizeBytes: number | null
  folderId: string | null
  /** Where it is, from the top level, with its name. `null` when the store doesn't say. */
  path: string | null
  /** The teammate who added it through the CRM; `null` for a file put there another way. */
  addedBy: string | null
  /** When it was added, as an ISO date; `null` when the store doesn't say. */
  addedAt: string | null
}

/** Where an upload's bytes go: straight from the browser to the store, or through this server. */
export type UploadTarget =
  | { transport: 'direct'; url: string; headers: Record<string, string> }
  | { transport: 'relay' }

/** What opening a file comes to: a link good for a few minutes, or its bytes. */
export type OpenedFile =
  | { kind: 'link'; url: string }
  | { kind: 'bytes'; body: ReadableStream<Uint8Array>; name: string; sizeBytes: number | null }

/**
 * `working` when the store has the bytes and isn't done with them: ask again.
 * `refused` when it won't keep them, and asking again won't change that.
 */
export type UploadOutcome =
  | { state: 'kept'; fileId: string }
  | { state: 'working' }
  | { state: 'refused'; error: FilesError }

type Call<A> = Effect.Effect<A, FilesError>

/** A rename, a move into another folder (`parentId: null` for the top level), or both. A key left out is left as it is. */
export type FolderChange = { name?: string; parentId?: string | null }

/** A rename, a move to another folder (`folderId: null` for the top level), or both. A key left out is left as it is. */
export type FileChange = { name?: string; folderId?: string | null }

export class FileStore extends Context.Service<
  FileStore,
  {
    /**
     * What is missing before files can be used, in words for whoever runs the CRM; empty when ready.
     * Read from the settings alone: an app's hooks ask it without waiting (`filesConfigured`).
     */
    readonly problems: Effect.Effect<string[]>
    /** Names the store in use, so a record's folder in another one isn't mistaken for one here. */
    readonly drive: Call<string>
    readonly folder: (id: string) => Call<StoredFolder>
    /** What is directly in a folder, in no particular order. */
    readonly list: (
      folderId: string | null,
    ) => Call<{ folders: StoredFolder[]; files: StoredFile[]; truncated: boolean }>
    /** Files anywhere whose name contains these words, in order, any case. */
    readonly search: (words: string) => Call<{ files: StoredFile[]; truncated: boolean }>
    /**
     * The folder a file is in (`null` for the top level), asked of the file
     * itself. A listing stops at a limit (`truncated`), so it can't say that a
     * file is not in a folder: this can. Fails with `status` 404 when the file
     * is gone.
     */
    readonly fileFolder: (id: string) => Call<string | null>
    readonly createFolder: (parentId: string | null, name: string) => Call<StoredFolder>
    /** Rename a folder, move it into another, or both. */
    readonly changeFolder: (id: string, change: FolderChange) => Call<void>
    /** Delete a folder with everything in it. */
    readonly deleteFolder: (id: string) => Call<void>
    /** Make sure these paths exist from the top level ("Deals/Globex"), and say which folder each is. */
    readonly ensureFolders: (paths: readonly string[]) => Call<Map<string, string>>
    /** Rename a file, move it to another folder, or both. */
    readonly changeFile: (id: string, change: FileChange) => Call<void>
    /** Delete a file. One already gone is fine. */
    readonly deleteFile: (id: string) => Call<void>
    readonly open: (id: string) => Call<OpenedFile>
    /** Reserve an upload. `id` is the CRM's own for it: the same one again is the same upload. */
    readonly startUpload: (upload: {
      id: string
      name: string
      folderId: string | null
      sizeBytes: number
      /** Of the bytes, in hex. */
      sha256: string
      addedBy: string
    }) => Call<{ uploadId: string; target: UploadTarget }>
    /** Pass a relayed upload's bytes on. Only for an upload whose target is `relay`. */
    readonly relay: (
      uploadId: string,
      body: ReadableStream<Uint8Array> | ArrayBuffer,
      sizeBytes: number,
    ) => Call<void>
    /** Confirm the bytes arrived. Fails when they haven't, or the store couldn't be asked; the upload can still be finished. */
    readonly finishUpload: (uploadId: string) => Call<UploadOutcome>
  }
>()('spools/FileStore') {
  /** A Spool with no file store: the Files pages say so. */
  static readonly none = Layer.sync(FileStore, () => {
    const problem = 'No file store is set up'

    const off = Effect.fail(
      new FilesError({ message: "Files haven't been set up for this CRM yet." }),
    )

    const refuse = () => off
    return FileStore.of({
      problems: Effect.succeed([problem]),
      drive: off,
      folder: refuse,
      list: refuse,
      search: refuse,
      fileFolder: refuse,
      createFolder: refuse,
      changeFolder: refuse,
      deleteFolder: refuse,
      ensureFolders: refuse,
      changeFile: refuse,
      deleteFile: refuse,
      open: refuse,
      startUpload: refuse,
      relay: refuse,
      finishUpload: refuse,
    })
  })
}

export type FilesAdapter = Adapter<FileStore>
