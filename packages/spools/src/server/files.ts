import { randomUUID } from 'node:crypto'

import { Clock, Effect, Predicate } from 'effect'
import { z } from 'zod'

import { LIBRARY_LABEL, MAX_UPLOAD_BYTES, safeName } from '../crm/files'
import { EVERY_SCOPE, type ScopeAccess } from '../crm/scopes'
import { addActivity, getRecord, valueText } from './records'
import { CurrentAccess } from './runtime/access'
import { FilesError, fromHook, type StaffError } from './runtime/errors'
import { type FileChange, FileStore, type FolderChange, type StoredFolder } from './runtime/files'
import { asSystem, recordScope, scopesOn } from './scopes'
import { crmConfig, getObject, objectTable, spool } from './spool'
import { neq, oneOf } from './store/query'
import { Store } from './store/store'
import { FileUpload, RecordFolder } from './store/tables'
import type { CrmUser } from './users'

/**
 * Files.
 *
 * Folders and files live in a file store (the port in runtime/files.ts; which
 * one is the Spool's choice), and the store is the source of truth. The Files
 * page and a record's Files tab are a file browser over it: whatever is in the
 * store is what they show, however it got there.
 *
 * The CRM's own part is two small tables. `record_folders` says which folder is
 * a record's own, so its Files tab opens there. `file_uploads` tracks a file on
 * its way in, until the store confirms it.
 *
 * The browser asks for an upload (`startUpload`), sends the bytes where the
 * store says, then asks the server to confirm (`finishUpload`). Where a store
 * can take them directly the bytes don't pass through this server, which keeps
 * large drawings and photos clear of request-size limits on serverless hosts;
 * a store that can't has them relayed (`relayContent`). Opening a file is
 * src/api/file.ts.
 *
 * Every call here is made for a signed-in teammate by the server functions in
 * files.functions.ts.
 */

export { FilesError }

const fail = (message: string, code?: string) => Effect.fail(new FilesError({ message, code }))

/** Fails with `message` when `refused` holds: a check before work that gives nothing back. */
const refuseWhen = (refused: boolean, message: string) => (refused ? fail(message) : Effect.void)

/** A relation's stored id. */
const relationId = z.string()

/** What is missing before files can be used; empty when the store is set up. */
export const setupProblems = FileStore.use((files) => files.problems)

// ── Folders and files in the store ──────────────────────────────────────────

export type RecordRef = { objectKey: string; recordId: string }
export type Crumb = { id: string; name: string }
export type DriveFolder = {
  id: string
  name: string
  /** How many folders and files are directly inside; `null` when the store doesn't say. */
  items: number | null
  /** The record this folder belongs to, when it is one's own folder. */
  record: RecordRef | null
  /** Whether whoever asked may rename, move, delete or add to it. Always true in a Spool without record scopes. */
  canWrite: boolean
}
export type DriveFile = {
  /** The store's id for the file: what opens, renames, moves and removes it. */
  id: string
  name: string
  sizeBytes: number | null
  /** Where it is, from the store's top level, with its name. */
  path: string
  folderId: string | null
  /** The teammate who added it through the CRM; `null` for a file put in the store another way. */
  addedBy: string | null
  /** When it was added, as an ISO date; `null` when the store doesn't say. */
  addedAt: string | null
}

export type Listing = {
  /** The folder being shown, with the folders above it from the top; empty at the store's top level. */
  trail: Crumb[]
  folders: DriveFolder[]
  files: DriveFile[]
  /** The record this folder belongs to, with its title, when it is one's own folder. */
  record: (RecordRef & { title: string; label: string }) | null
  /** The folder holds more than could be listed. */
  truncated: boolean
  /**
   * Whether whoever asked may add to this folder and change what is in it. The
   * file browser shows its controls by it; the server checks every change
   * again. Always true in a Spool without record scopes.
   */
  canWrite: boolean
}

const KNOWN_MS = 60_000

/** What has been learned about a store, for as long as it runs: folders seen lately, and whether the library is there. */
type Known = {
  /** So breadcrumbs don't ask the store about each level every time. */
  folders: Map<string, { name: string; parentId: string | null; at: number }>
  /** The library folders that have been made, as `<drive>:<paths>`. */
  library: string
}
const knowledge = new WeakMap<FileStore['Service'], Known>()

const knownOf = (files: FileStore['Service']): Known => {
  const known = knowledge.get(files) ?? { folders: new Map(), library: '' }
  knowledge.set(files, known)
  return known
}

const remember = Effect.fnUntraced(function* (folder: StoredFolder) {
  const { folders } = knownOf(yield* FileStore)

  folders.set(folder.id, {
    name: folder.name,
    parentId: folder.parentId,
    at: yield* Clock.currentTimeMillis,
  })
})

const folderInfo = Effect.fn('files.folderInfo')(function* (id: string) {
  const files = yield* FileStore
  const now = yield* Clock.currentTimeMillis
  const hit = knownOf(files).folders.get(id)

  if (hit && now - hit.at < KNOWN_MS) {
    return hit
  }

  const folder = yield* files.folder(id)
  yield* remember(folder)
  return { name: folder.name, parentId: folder.parentId }
})

/** The folders from the store's top level down to `id`, inclusive. */
const trailTo = Effect.fn('files.trailTo')(function* (id: string) {
  const trail: Crumb[] = []
  let at: string | null = id

  // A longer trail is no use to anyone, and a store that answered in a circle would never end.
  for (let depth = 0; at && depth < 64; depth++) {
    const info: { name: string; parentId: string | null } = yield* folderInfo(at)
    trail.unshift({ id: at, name: info.name })
    at = info.parentId
  }

  return trail
})

const sortByName = <T extends { name: string }>(items: readonly T[]) =>
  items.toSorted((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  )

// ── Record scopes ───────────────────────────────────────────────────────────
//
// The file store knows nothing of record scopes (src/crm/scopes.ts): it is a
// second place records' things are kept, which the guard on the database can't
// see into. So every call here that names a folder or a file checks it first.
// A folder is within reach when every record's folder on the way down to it is
// one of a record within reach; folders that are no record's (the library, what
// the team made) are everyone's. A file is reached through the folder it is
// in, which the caller has to name: the store can't say where a file is from
// its id alone. What is out of reach reads as what isn't there.

const notThere = () => new FilesError({ message: 'Not found', status: 404 })

const within = (held: ScopeAccess['read'], scope: string | null) =>
  held === 'all' || scope === EVERY_SCOPE || (scope !== null && held.includes(scope))

/**
 * What a record's row holds in place of a folder's id while its folder is being
 * made (`recordFolder`): where the folder is going. No store gives out an id
 * like it: theirs are UUIDs. Until the row learns the folder's id it owns the
 * folder at that path.
 */
const RESERVED = 'reserved:'
const isReserved = (folderId: string) => folderId.startsWith(RESERVED)
const reservation = (drive: string, path: string) => `${RESERVED}${drive}:${path}`

/** A folder by its id and where it is from the store's top level, which is how a row still being made knows it. */
type Placed = { id: string; path: string }

/** The folders of a trail, each with its path. */
const placed = (trail: readonly Crumb[]): Placed[] =>
  trail.map((crumb, i) => ({
    id: crumb.id,
    path: trail
      .slice(0, i + 1)
      .map((c) => c.name)
      .join('/'),
  }))

/**
 * The scopes of the records these folders belong to, by folder: none for a
 * folder that is no record's. Asked as the system, since a record out of reach
 * has a row the person asking can't see.
 */
const ownersOf = Effect.fn('files.ownersOf')(function* (folders: readonly Placed[]) {
  const owners = new Map<string, (string | null)[]>()

  if (folders.length === 0) {
    return owners
  }

  const db = yield* Store
  const drive = yield* (yield* FileStore).drive

  for (let at = 0; at < folders.length; at += 250) {
    const batch = folders.slice(at, at + 250)
    const byPath = new Map(batch.map((f) => [reservation(drive, f.path), f.id]))

    const rows = yield* asSystem(
      db.find(RecordFolder, {
        select: ['folderId', 'scope'],
        filter: oneOf('folderId', [...batch.map((f) => f.id), ...byPath.keys()]),
      }),
    )

    for (const row of rows) {
      const id = byPath.get(row.folderId) ?? row.folderId
      owners.set(id, [...(owners.get(id) ?? []), row.scope])
    }
  }

  return owners
})

/** Fails as a missing folder would unless `folderId` is within reach. Nothing to check in a Spool without scopes. */
const folderInReach = Effect.fn('files.folderInReach')(function* (
  folderId: string | null,
  mode: 'read' | 'write',
) {
  if (!scopesOn()) {
    return undefined
  }

  const access = yield* CurrentAccess

  if (!access) {
    return yield* notThere()
  }

  // Whoever can write nothing changes no folder and no file, the shared ones included.
  if (mode === 'write' && access.write !== 'all' && access.write.length === 0) {
    return yield* fail('You can look at these files, but not change them.')
  }

  if (folderId === null) {
    return undefined
  }

  const owners = yield* ownersOf(placed(yield* trailTo(folderId)))

  return [...owners.values()].flat().every((scope) => within(access[mode], scope))
    ? undefined
    : yield* notThere()
})

/** Of these folders, the ones that are the folder of a record out of reach. */
const foldersOutOfReach = Effect.fn('files.foldersOutOfReach')(function* (
  folders: readonly Placed[],
) {
  const hidden = new Set<string>()

  if (!scopesOn() || folders.length === 0) {
    return hidden
  }

  const access = yield* CurrentAccess

  for (const [id, scopes] of yield* ownersOf(folders)) {
    if (!access || !scopes.every((scope) => within(access.read, scope))) {
      hidden.add(id)
    }
  }

  return hidden
})

/** A listing with more folders than this gives a reader who can't reach every record no counts, rather than list each one. */
const COUNTED_LIMIT = 50

/**
 * How many things are directly inside each of these folders, for whoever is
 * asking. The store's own number counts the folders of records out of reach
 * (how many customers another branch has, under "Companies"), so for a reader
 * who can't reach every record each folder is listed and counted again without
 * them. `null`, as when the store doesn't say, for a folder too large to
 * list at once and for a listing of more folders than `COUNTED_LIMIT`.
 */
const itemsInReach = Effect.fn('files.itemsInReach')(function* (
  folders: readonly (Placed & { items: number | null })[],
) {
  const access = scopesOn() ? yield* CurrentAccess : null

  if (!scopesOn() || access?.read === 'all') {
    return new Map(folders.map((folder) => [folder.id, folder.items]))
  }

  if (folders.length > COUNTED_LIMIT) {
    return new Map(folders.map((folder) => [folder.id, null]))
  }

  const files = yield* FileStore

  const counted = yield* Effect.forEach(
    folders,
    (folder) =>
      Effect.gen(function* () {
        // Nothing inside: nothing to leave out.
        if (folder.items === 0) {
          return [folder.id, 0] as const
        }

        const inside = yield* files.list(folder.id)

        if (inside.truncated) {
          return [folder.id, null] as const
        }

        const hidden = yield* foldersOutOfReach(
          inside.folders.map((f) => ({ id: f.id, path: `${folder.path}/${f.name}` })),
        )

        const shown = inside.folders.filter((f) => !hidden.has(f.id)).length
        return [folder.id, inside.files.length + shown] as const
      }).pipe(
        // A folder that went away while it was counted has no number, and the listing still answers.
        Effect.catchTag('FilesError', () => Effect.succeed([folder.id, null] as const)),
      ),
    { concurrency: 8 },
  )

  return new Map<string, number | null>(counted)
})

/** How many folders are looked through before a folder is changed. One larger than this is left to someone who holds every scope. */
const BENEATH_LIMIT = 2000

/**
 * Before a folder is renamed, moved or deleted: nothing beneath it may be the
 * folder of a record out of reach. "Companies" is nobody's own, but every
 * company's folder is inside it. The folders beneath are walked in the store
 * itself, so one that was moved there by hand is found too.
 */
const nothingBeneathOutOfReach = Effect.fn('files.nothingBeneathOutOfReach')(function* (
  folderId: string,
) {
  const access = scopesOn() ? yield* CurrentAccess : null

  if (!scopesOn() || access?.write === 'all') {
    return undefined
  }

  if (!access) {
    return yield* notThere()
  }

  const files = yield* FileStore
  const beneath: Placed[] = []
  const [top] = placed(yield* trailTo(folderId)).slice(-1)

  for (let queue = top ? [top] : []; queue.length > 0;) {
    const next: Placed[] = []

    for (const { id, path } of queue) {
      const inside = yield* files.list(id)
      next.push(...inside.folders.map((f) => ({ id: f.id, path: `${path}/${f.name}` })))

      if (inside.truncated || beneath.length + next.length > BENEATH_LIMIT) {
        return yield* fail(
          'This folder holds too much to check here. Ask someone who can reach every record to change it.',
        )
      }
    }

    beneath.push(...next)
    queue = next
  }

  const owners = yield* ownersOf(beneath)

  if (![...owners.values()].flat().every((scope) => within(access.write, scope))) {
    return yield* fail(
      "This folder holds the folders of records you can't change, so it can't be renamed, moved or deleted by you.",
    )
  }

  return undefined
})

/**
 * Fails as a missing file would unless the file is in `folderId` and that
 * folder is within reach. In a Spool with scopes a file can't be reached by its
 * id alone.
 */
const fileInReach = Effect.fn('files.fileInReach')(function* (
  id: string,
  folderId: string | null | undefined,
  mode: 'read' | 'write',
) {
  if (!scopesOn()) {
    return undefined
  }

  if (folderId === undefined) {
    return yield* notThere()
  }

  yield* folderInReach(folderId, mode)
  const inside = yield* (yield* FileStore).list(folderId)
  return inside.files.some((file) => file.id === id) ? undefined : yield* notThere()
})

const describeRecord = Effect.fn('files.describeRecord')(function* (ref: RecordRef) {
  if (!Object.hasOwn(crmConfig().objects, ref.objectKey)) {
    return null
  }

  const obj = getObject(ref.objectKey)
  const record = yield* getRecord(ref.objectKey, ref.recordId)

  if (!record) {
    return null
  }

  return {
    objectKey: ref.objectKey,
    recordId: ref.recordId,
    title: valueText(record[obj.titleField] ?? 'Untitled'),
    label: obj.label,
  }
})

/** What is in a folder (`null` for the store's top level): its folders, then its files, by name. */
export const listFolder = Effect.fn('files.listFolder')(function* (folderId: string | null) {
  const files = yield* FileStore
  const db = yield* Store
  const drive = yield* files.drive

  if (folderId === null) {
    yield* ensureLibrary()
  }

  yield* folderInReach(folderId, 'read')

  // Everything the page needs is asked for at once: the way here, what is inside, and whose folder this is.
  const [trail, inside, record] = yield* Effect.all(
    [
      folderId ? trailTo(folderId) : Effect.succeed<Crumb[]>([]),
      files.list(folderId),
      folderId
        ? db
            .first(RecordFolder, { where: { folderId } })
            .pipe(Effect.flatMap((mine) => (mine ? describeRecord(mine) : Effect.succeed(null))))
        : Effect.succeed(null),
    ],
    { concurrency: 'unbounded' },
  )

  for (const folder of inside.folders) {
    yield* remember(folder)
  }

  const under = trail.map((c) => c.name).join('/')

  // A record's folder is listed only for those who can reach the record, and can be changed
  // only by those who can change it.
  const access = scopesOn() ? yield* CurrentAccess : null

  const owners = scopesOn()
    ? yield* ownersOf(
        inside.folders.map((f) => ({ id: f.id, path: under ? `${under}/${f.name}` : f.name })),
      )
    : new Map<string, (string | null)[]>()

  const reaches = (id: string, mode: 'read' | 'write') =>
    !scopesOn() ||
    (!!access && (owners.get(id) ?? []).every((scope) => within(access[mode], scope)))

  const shownFolders = inside.folders.filter((f) => reaches(f.id, 'read'))

  const canWrite = yield* folderInReach(folderId, 'write').pipe(
    Effect.as(true),
    Effect.catchTag('FilesError', () => Effect.succeed(false)),
  )

  const items = yield* itemsInReach(
    shownFolders.map((f) => ({
      id: f.id,
      path: under ? `${under}/${f.name}` : f.name,
      items: f.items,
    })),
  )

  // Which of the folders shown are a record's own, for their badge.
  const badges = new Map<string, RecordRef>()
  const shown = shownFolders.map((f) => f.id)

  for (let at = 0; at < shown.length; at += 500) {
    const batch = shown.slice(at, at + 500)

    const mapped = yield* db.find(RecordFolder, {
      where: { driveId: drive },
      filter: oneOf('folderId', batch),
    })

    for (const m of mapped) {
      if (!badges.has(m.folderId)) {
        badges.set(m.folderId, { objectKey: m.objectKey, recordId: m.recordId })
      }
    }
  }

  const listing: Listing = {
    trail,
    folders: sortByName(
      shownFolders.map((f) => ({
        id: f.id,
        name: f.name,
        items: items.get(f.id) ?? null,
        record: badges.get(f.id) ?? null,
        canWrite: canWrite && reaches(f.id, 'write'),
      })),
    ),
    files: sortByName(
      inside.files.map((f) => ({ ...f, path: under ? `${under}/${f.name}` : f.name })),
    ),
    record,
    truncated: inside.truncated,
    canWrite,
  }

  return listing
})

/** Files anywhere in the store whose name contains the words of `q`, any case. */
export const searchFiles = Effect.fn('files.searchFiles')(function* (q: string) {
  const words = q.replace(/\s+/g, ' ').trim()

  if (!words) {
    const none: DriveFile[] = []
    return { files: none, truncated: false }
  }

  const files = yield* FileStore
  const found = yield* files.search(words)

  // The store searches every folder. Each folder a match is in is checked once.
  const reachable = new Map<string | null, boolean>()

  for (const folderId of new Set(found.files.map((f) => f.folderId))) {
    reachable.set(
      folderId,
      yield* folderInReach(folderId, 'read').pipe(
        Effect.as(true),
        Effect.catchTag('FilesError', () => Effect.succeed(false)),
      ),
    )
  }

  const reached = found.files.filter((f) => reachable.get(f.folderId) === true)

  return {
    files: sortByName(reached.map((f): DriveFile => ({ ...f, path: f.path ?? f.name }))),
    // "There are more" is only said of what the reader could be shown. When the store cut its
    // answer short and some of it was held back, whether more of theirs exists can't be told
    // (the store has no next page to ask for), and saying so would say how much others have.
    truncated: found.truncated && reached.length === found.files.length,
  }
})

const folderName = (name: string) => {
  const clean = safeName(name, '')
  return clean ? Effect.succeed(clean) : fail('Give the folder a name.')
}

export const createFolder = Effect.fn('files.createFolder')(function* (
  parentId: string | null,
  name: string,
) {
  yield* folderInReach(parentId, 'write')
  const files = yield* FileStore
  const created = yield* files.createFolder(parentId, yield* folderName(name))
  yield* remember(created)
  return { id: created.id, name: created.name } satisfies Crumb
})

/** Rename a folder, move it into another (`parentId: null` for the top level), or both. */
export const changeFolder = Effect.fn('files.changeFolder')(function* (
  id: string,
  change: { name?: string; parentId?: string | null },
) {
  yield* refuseWhen(change.parentId === id, "A folder can't be moved into itself.")
  yield* folderInReach(id, 'write')
  yield* folderInReach(change.parentId ?? null, 'write')
  yield* nothingBeneathOutOfReach(id)
  const files = yield* FileStore
  // Only what is given changes.
  const update: FolderChange = {}

  if (change.name !== undefined) {
    update.name = yield* folderName(change.name)
  }

  if (change.parentId !== undefined) {
    update.parentId = change.parentId
  }

  yield* files.changeFolder(id, update)

  knownOf(files).folders.delete(id)
})

/**
 * Delete a folder with everything in it. A record's own folder can go too: the
 * record forgets it, and gets a new, empty one the next time its page is opened.
 */
export const deleteFolder = Effect.fn('files.deleteFolder')(function* (id: string) {
  yield* folderInReach(id, 'write')
  yield* nothingBeneathOutOfReach(id)
  const files = yield* FileStore
  const db = yield* Store

  yield* files.deleteFolder(id).pipe(
    // The folders inside went with it, and they could be any of the ones seen lately.
    Effect.ensuring(Effect.sync(() => knownOf(files).folders.clear())),
  )

  yield* db.remove(RecordFolder, { where: { folderId: id } })
})

/** Rename a file, move it to another folder (`folderId: null` for the top level), or both. */
export const changeFile = Effect.fn('files.changeFile')(function* (
  id: string,
  change: { name?: string; folderId?: string | null },
  /** The folder the file is in. A Spool with record scopes needs it: see `fileInReach`. */
  inFolder?: string | null,
) {
  yield* fileInReach(id, inFolder, 'write')
  yield* folderInReach(change.folderId ?? null, 'write')
  const files = yield* FileStore
  const name = change.name === undefined ? undefined : safeName(change.name, '')
  yield* refuseWhen(name === '', 'Give the file a name.')
  // Only what is given changes.
  const update: FileChange = {}

  if (name !== undefined) {
    update.name = name
  }

  if (change.folderId !== undefined) {
    update.folderId = change.folderId
  }

  yield* files.changeFile(id, update)
})

/** Delete a file. One already gone is fine. */
export const deleteFile = Effect.fn('files.deleteFile')(function* (
  id: string,
  inFolder?: string | null,
) {
  yield* fileInReach(id, inFolder, 'write')
  const files = yield* FileStore
  yield* files.deleteFile(id)
})

/** A link to one file good for a few minutes, or its bytes. */
export const openFile = Effect.fn('files.openFile')(function* (
  id: string,
  inFolder?: string | null,
) {
  yield* fileInReach(id, inFolder, 'read')
  const files = yield* FileStore
  return yield* files.open(id)
})

// ── The shared library ──────────────────────────────────────────────────────

/**
 * The library is a folder at the store's top level for files that belong to the
 * business rather than to one record, with the folders the config names. Made
 * the first time the top level is shown.
 */
const ensureLibrary = Effect.fn('files.ensureLibrary')(function* () {
  const files = yield* FileStore
  const label = safeName(crmConfig().files?.label ?? LIBRARY_LABEL)
  const paths = [label, ...(crmConfig().files?.folders ?? []).map((f) => `${label}/${f}`)]
  const signature = `${yield* files.drive}:${paths.join('|')}`
  const known = knownOf(files)

  if (known.library === signature) {
    return
  }

  yield* files.ensureFolders(paths)
  known.library = signature
})

// ── A record's own folder ───────────────────────────────────────────────────

/** A path from the store's top level, each segment made safe. */
const cleanPath = (path: string): string =>
  path
    .split('/')
    .map((segment) => safeName(segment, ''))
    .filter(Boolean)
    .join('/')

/** An object whose records take files. Fails for one that doesn't. */
const filesObject = (objectKey: string) => {
  if (!Object.hasOwn(crmConfig().objects, objectKey)) {
    return fail('Unknown object.')
  }

  const obj = getObject(objectKey)

  if (!obj.files) {
    return fail(`${obj.labelPlural} don't take files.`)
  }

  return Effect.succeed({ ...obj, files: obj.files })
}

/** Where a record's folder goes when it is first made. */
const plannedPath = Effect.fn('files.plannedPath')(function* (
  objectKey: string,
  recordId: string,
): Effect.fn.Return<string, StaffError, FileStore | Store> {
  const obj = yield* filesObject(objectKey)
  const record = yield* getRecord(objectKey, recordId)

  if (!record) {
    return yield* fail('That record no longer exists.')
  }

  const custom = yield* fromHook('files.location', () =>
    spool().extensions.files?.location?.({ objectKey, record }),
  )

  const chosen = custom ? cleanPath(custom) : ''

  if (chosen) {
    return chosen
  }

  const name = safeName(valueText(record[obj.titleField] ?? '').trim() || obj.label, obj.label, 100)
  // `under`: inside the folder of the record a relation points to, e.g. a deal inside its company.
  const under = obj.files.under
  const field = under ? obj.fields[under] : undefined
  const parentId = under ? relationId.safeParse(record[`${under}Id`]).data : undefined

  if (parentId !== undefined && field?.type === 'relation' && getObject(field.to).files) {
    const parent = yield* recordFolder(field.to, parentId)
    return `${parent.path}/${name}`
  }

  return `${safeName(obj.labelPlural)}/${name}`
})

/** What `recordFolder` reads of a record's row. */
type FolderRow = { id: string; driveId: string; folderId: string; path: string }

/**
 * The row that will be a record's folder's, written before the folder is made:
 * it names where the folder goes and, in place of its id, `RESERVED`. A row
 * left that way by a visit that was cut short is taken up again as it is, so
 * the folder is looked for where that visit was making it. Gives back another
 * visit's finished row when there is one.
 */
const reserveFolder = Effect.fn('files.reserveFolder')(function* (
  objectKey: string,
  recordId: string,
  existing: FolderRow | null,
  drive: string,
): Effect.fn.Return<{ id: string; folderId: string; path: string }, StaffError, FileStore | Store> {
  if (existing && existing.driveId === drive && isReserved(existing.folderId)) {
    return existing
  }

  const db = yield* Store
  let path = yield* plannedPath(objectKey, recordId)

  // Two records with the same name each get a folder: the second carries part of its id. In a
  // Spool with record scopes every folder does, so a name never says whether another scope has
  // a record called the same, and a new record never takes over a folder a deleted one left.
  if (
    scopesOn() ||
    (yield* asSystem(
      db.count(RecordFolder, {
        where: { driveId: drive, path },
        // Its own row, whose folder is gone, doesn't make the name taken.
        filter: existing ? neq('id', existing.id) : undefined,
      }),
    )) > 0
  ) {
    path = `${path} (${recordId.slice(0, 8)})`
  }

  const folderId = reservation(drive, path)

  if (existing) {
    // Its folder was deleted, or the CRM was pointed at another store: the record gets a new one.
    yield* db.update(
      RecordFolder,
      { where: { id: existing.id } },
      { driveId: drive, folderId, path },
    )

    return { id: existing.id, folderId, path }
  }

  return yield* db
    .insert(RecordFolder, { objectKey, recordId, driveId: drive, folderId, path })
    .pipe(
      // Two visits at once: the other one's row stands, finished or not.
      Effect.catchTag('DatabaseError', (error) =>
        db
          .first(RecordFolder, { where: { objectKey, recordId } })
          .pipe(Effect.filterOrFail(Predicate.isNotNull, () => error)),
      ),
    )
})

/**
 * The folder that holds a record's files, made the first time it is asked for
 * (with the folders its object's config names inside it). Renaming the record
 * later doesn't move it.
 */
export const recordFolder = Effect.fn('files.recordFolder')(function* (
  objectKey: string,
  recordId: string,
): Effect.fn.Return<{ folderId: string; path: string }, StaffError, FileStore | Store> {
  const obj = yield* filesObject(objectKey)

  // Before the file store is asked for anything: a record out of reach has no folder to make.
  if (scopesOn() && !(yield* getRecord(objectKey, recordId))) {
    return yield* fail('That record no longer exists.')
  }

  const files = yield* FileStore
  const db = yield* Store
  const drive = yield* files.drive
  const existing = yield* db.first(RecordFolder, { where: { objectKey, recordId } })
  const here = existing && existing.driveId === drive ? existing : null

  if (here && !isReserved(here.folderId)) {
    const kept = yield* folderInfo(here.folderId).pipe(
      Effect.as(true),
      Effect.catchTag('FilesError', (error) =>
        error.status === 404 ? Effect.succeed(false) : Effect.fail(error),
      ),
    )

    if (kept) {
      return { folderId: here.folderId, path: here.path }
    }

    // The folder was deleted, here or in the store itself: the record gets a new one below.
  }

  // Whoever can't write the row is stopped here, with nothing made: a read-only person who
  // finds no folder is told there is none yet.
  if (scopesOn()) {
    const access = yield* CurrentAccess
    const record = yield* getRecord(objectKey, recordId)
    const scope = record ? recordScope(objectKey, record) : null
    const shared = objectTable(objectKey).scope === undefined

    const writes =
      !!access &&
      (access.write === 'all' ||
        (shared ? access.write.length > 0 : scope !== null && access.write.includes(scope)))

    if (!writes) {
      return yield* fail('This record has no folder yet. Someone who can change it can add one.')
    }
  }

  // The row is written before the folder is made, and learns the folder's id after. The file
  // store and the database can't be changed together, and a folder with no row is everyone's
  // (see "Record scopes" above), so there must be no moment a failure could leave one. Until the
  // row holds the id it owns the folder by its path, which `ownersOf` reads; a visit that was
  // cut short anywhere after this is finished by the next one, at the same path.
  const reserved = yield* reserveFolder(objectKey, recordId, existing, drive)

  if (!isReserved(reserved.folderId)) {
    return { folderId: reserved.folderId, path: reserved.path }
  }

  const { path } = reserved
  const ids = yield* files.ensureFolders([path, ...obj.files.folders.map((f) => `${path}/${f}`)])
  const folderId = ids.get(path)

  if (!folderId) {
    return yield* fail('The file store did not create the folder. Try again.')
  }

  const confirmed = yield* db.update(
    RecordFolder,
    { where: { id: reserved.id, folderId: reserved.folderId } },
    { folderId },
  )

  if (confirmed > 0) {
    return { folderId, path }
  }

  // Two visits at once: the other one's row stands.
  const other = yield* db.first(RecordFolder, { where: { objectKey, recordId } })

  return other && !isReserved(other.folderId)
    ? { folderId: other.folderId, path: other.path }
    : yield* fail('The folder could not be kept for this record. Try again.')
})

/**
 * Give one record another record's folder, for apps where a record hands over
 * to the next (a won deal becoming a job): both then open the same folder.
 */
export const shareRecordFolder = Effect.fn('files.shareRecordFolder')(function* (
  from: RecordRef,
  to: RecordRef,
) {
  yield* filesObject(to.objectKey)
  const source = yield* recordFolder(from.objectKey, from.recordId)
  const files = yield* FileStore
  const db = yield* Store
  const drive = yield* files.drive

  const existing = yield* db.first(RecordFolder, {
    where: { objectKey: to.objectKey, recordId: to.recordId },
  })

  if (existing) {
    yield* db.update(RecordFolder, { where: { id: existing.id } }, { driveId: drive, ...source })
  } else {
    yield* db.insert(RecordFolder, { ...to, driveId: drive, ...source })
  }
})

// ── Uploading ───────────────────────────────────────────────────────────────

export type UploadInput = {
  /** The folder the file goes into; `null` for the store's top level. */
  folderId: string | null
  name: string
  sizeBytes: number
  /** Hex SHA-256 of the whole file, for the store to check the bytes it receives against. */
  sha256: string
  /** The record whose Files tab this is added from, for its timeline. */
  record?: RecordRef | null
}

export type UploadTicket = {
  id: string
  /**
   * How the browser sends the bytes: `direct` is a PUT straight to the store,
   * `relay` a PUT to this server (`/api/files/uploads/<id>`), which passes them on.
   */
  transport: 'direct' | 'relay'
  url: string
  headers: Record<string, string>
}

/** Uploads that never finished are forgotten after this long (the store drops its side after a day). */
const ABANDONED_MS = 60 * 60 * 1000

/** Reserve an upload for a file the browser is about to send. Nothing is in the folder until `finishUpload`. */
export const startUpload = Effect.fn('files.startUpload')(function* (
  input: UploadInput,
  user: CrmUser,
) {
  const files = yield* FileStore
  const db = yield* Store
  const drive = yield* files.drive

  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    return yield* fail('The file could not be read. Try adding it again.')
  }

  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    return yield* fail('That file is empty.')
  }

  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    return yield* fail('That file is too large to add here.')
  }

  if (input.record && !Object.hasOwn(crmConfig().objects, input.record.objectKey)) {
    return yield* fail('Unknown object.')
  }

  const name = safeName(input.name, 'File')
  yield* folderInReach(input.folderId, 'write')

  // Tidy up this teammate's uploads that never finished.
  const now = yield* Clock.currentTimeMillis
  const mine = yield* db.find(FileUpload, { where: { uploadedBy: user.id }, limit: 500 })

  for (const row of mine) {
    if (now - row.createdAt.getTime() > ABANDONED_MS) {
      yield* db.remove(FileUpload, { where: { id: row.id } })
    }
  }

  const id = randomUUID()

  const { uploadId, target } = yield* files.startUpload({
    id,
    name,
    folderId: input.folderId,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    addedBy: user.name,
  })

  yield* db.insert(FileUpload, {
    id,
    driveId: drive,
    uploadId,
    folderId: input.folderId,
    name,
    sizeBytes: input.sizeBytes,
    transport: target.transport,
    objectKey: input.record?.objectKey ?? null,
    recordId: input.record?.recordId ?? null,
    uploadedBy: user.id,
    uploadedByName: user.name,
  })

  const ticket: UploadTicket =
    target.transport === 'direct'
      ? { id, ...target }
      : {
          id,
          transport: 'relay',
          url: `/api/files/uploads/${id}`,
          headers: { 'content-type': 'application/octet-stream' },
        }

  return ticket
})

/** An upload this teammate started and hasn't finished. */
const pendingUpload = Effect.fn('files.pendingUpload')(function* (id: string, user: CrmUser) {
  const db = yield* Store
  const row = yield* db.first(FileUpload, { where: { id } })

  if (!row || row.uploadedBy !== user.id) {
    return yield* fail('That upload was not found.')
  }

  return row
})

/** Pass a relayed upload's bytes on to the store. Only for uploads the store asked to have relayed. */
export const relayContent = Effect.fn('files.relayContent')(function* (
  id: string,
  body: ReadableStream<Uint8Array> | ArrayBuffer,
  length: number,
  user: CrmUser,
) {
  const row = yield* pendingUpload(id, user)

  yield* refuseWhen(row.transport !== 'relay', 'That upload is not waiting for its file.')

  yield* refuseWhen(
    length !== row.sizeBytes,
    'The file changed while it was being added. Add it again.',
  )

  const files = yield* FileStore
  yield* files.relay(row.uploadId, body, length)
})

/**
 * Confirm the store holds the file. Returns the file, or `null` when the store
 * is still working on it: call again shortly.
 */
export const finishUpload = Effect.fn('files.finishUpload')(function* (
  id: string,
  user: CrmUser,
  options: { waitMs?: number; pollMs?: number } = {},
) {
  const row = yield* pendingUpload(id, user)
  const files = yield* FileStore
  const db = yield* Store

  let outcome = yield* files.finishUpload(row.uploadId)
  const deadline = (yield* Clock.currentTimeMillis) + (options.waitMs ?? 20_000)

  while (outcome.state === 'working') {
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return null
    }

    yield* Effect.sleep(options.pollMs ?? 700)
    outcome = yield* files.finishUpload(row.uploadId)
  }

  yield* db.remove(FileUpload, { where: { id } })

  if (outcome.state === 'refused') {
    return yield* outcome.error
  }

  if (row.objectKey && row.recordId) {
    const ref = { objectKey: row.objectKey, recordId: row.recordId }

    yield* addActivity({
      ...ref,
      kind: 'file',
      summary: `added a file: ${row.name}`,
      actor: user.name,
      actorId: user.id,
    })
  }

  return { id: outcome.fileId, name: row.name }
})
