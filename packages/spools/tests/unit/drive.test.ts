import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { Effect, Layer } from 'effect'

import { pglite } from '../../src/adapters/database/pglite/server'
import {
  type Blobs,
  drive,
  FileNode,
  localBlobs,
  s3Blobs,
} from '../../src/adapters/files/drive/server'
import { generatePrisma } from '../../src/crm/codegen'
import {
  finishUpload,
  listFolder,
  recordFolder,
  relayContent,
  searchFiles,
  startUpload,
} from '../../src/server/files'
import { createRecord } from '../../src/server/records'
import { appLayer } from '../../src/server/runtime/app'
import { Auth } from '../../src/server/runtime/auth'
import { FilesError } from '../../src/server/runtime/errors'
import { FileStore } from '../../src/server/runtime/files'
import { httpLayer } from '../../src/server/runtime/http'
import { crmConfig } from '../../src/server/spool'
import { eq, or } from '../../src/server/store/query'
import { schemaSql } from '../../src/server/store/schema-sql'
import { Store, type StoreShape } from '../../src/server/store/store'
import { testRuntime } from '../../src/testing/run'

// The drive: folders and files in the Spool's own database, with the bytes in a
// blob store. On Postgres in this process, with the bytes in a folder made for
// the tests (and a bucket played by a server on this machine).

const dir = mkdtempSync(join(tmpdir(), 'spools-drive-'))
const client = await PGlite.create()

for (const statement of schemaSql([FileNode])) {
  await client.exec(statement)
}

const store = pglite({ client }).layer.pipe(Layer.provide(httpLayer()))

type Files = FileStore['Service']

/** A server with the drive on this database: its own runtime, as another server's would be. */
function server(blobs: Blobs = localBlobs({ dir })) {
  const rt = testRuntime(
    drive({ blobs }).layer.pipe(Layer.provideMerge(store), Layer.provideMerge(httpLayer())),
  )

  return {
    rt,
    ok: <A, E>(work: (files: Files) => Effect.Effect<A, E>) => rt.runPromise(FileStore.use(work)),
    fail: <A, E>(work: (files: Files) => Effect.Effect<A, E>) =>
      rt.runPromise(FileStore.use((f) => Effect.flip(work(f)))),
    db: <A, E>(work: (db: StoreShape) => Effect.Effect<A, E>) => rt.runPromise(Store.use(work)),
  }
}

let here = server()

beforeEach(async () => {
  await client.exec('DELETE FROM "public"."file_nodes"')
  here = server()
})

afterEach(() => here.rt.dispose())

afterAll(async () => {
  await client.close()
  rmSync(dir, { recursive: true, force: true })
})

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const names = (items: readonly { name: string }[]) => items.map((i) => i.name).sort()

const stream = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(new TextEncoder().encode(part))
      }

      controller.close()
    },
  })

/** Every file under a folder on disk. */
const onDisk = (root = dir): string[] =>
  existsSync(root)
    ? readdirSync(root, { recursive: true, withFileTypes: true }).flatMap((e) =>
        e.isFile() ? [e.name] : [],
      )
    : []

const described = (name: string, folderId: string | null, text: string) => ({
  id: crypto.randomUUID(),
  name,
  folderId,
  sizeBytes: Buffer.byteLength(text),
  sha256: sha(text),
  addedBy: 'Ada',
})

/** Adds a file the way the CRM does, and answers with its id. */
async function add(
  name: string,
  folderId: string | null = null,
  text = `the bytes of ${name}`,
): Promise<string> {
  const { uploadId } = await here.ok((f) => f.startUpload(described(name, folderId, text)))
  await here.ok((f) => f.relay(uploadId, bytesOf(text), Buffer.byteLength(text)))
  const outcome = await here.ok((f) => f.finishUpload(uploadId))

  if (outcome.state !== 'kept') {
    throw new Error(`${name} was not kept`)
  }

  return outcome.fileId
}

async function read(id: string): Promise<string> {
  const opened = await here.ok((f) => f.open(id))
  return opened.kind === 'bytes' ? new Response(opened.body).text() : opened.url
}

const folder = async (name: string, parentId: string | null = null) =>
  (await here.ok((f) => f.createFolder(parentId, name))).id

const inside = async (id: string | null) => {
  const { folders, files } = await here.ok((f) => f.list(id))
  return { folders: names(folders), files: names(files) }
}

describe('an upload', () => {
  test("is nobody's until its bytes are confirmed, then opens as it was sent", async () => {
    const photos = await folder('Photos')
    const upload = described('site.png', photos, 'pixels')
    const { uploadId, target } = await here.ok((f) => f.startUpload(upload))
    expect(target).toEqual({ transport: 'relay' })

    const hidden = async () => {
      expect(await inside(photos)).toEqual({ folders: [], files: [] })
      expect((await here.ok((f) => f.search('site'))).files).toEqual([])
      expect((await here.fail((f) => f.open(uploadId))).status).toBe(404)
      expect((await here.ok((f) => f.list(null))).folders[0]?.items).toBe(0)
    }

    await hidden()

    // Asked too soon: the bytes haven't come, and it can still be finished.
    expect(await here.fail((f) => f.finishUpload(uploadId))).toMatchObject({
      code: 'upload_transfer_incomplete',
    })

    await here.ok((f) => f.relay(uploadId, stream('pix', 'els'), 6))
    await hidden()

    expect(await here.ok((f) => f.finishUpload(uploadId))).toEqual({
      state: 'kept',
      fileId: upload.id,
    })

    expect((await here.ok((f) => f.list(photos))).files).toEqual([
      {
        id: upload.id,
        name: 'site.png',
        sizeBytes: 6,
        path: null,
        folderId: photos,
        addedBy: 'Ada',
        addedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
    ])

    expect((await here.ok((f) => f.list(null))).folders[0]?.items).toBe(1)

    expect(await here.ok((f) => f.open(upload.id))).toMatchObject({
      kind: 'bytes',
      name: 'site.png',
      sizeBytes: 6,
    })

    expect(await read(upload.id)).toBe('pixels')

    // Finishing it again is the same answer, and nothing more may be sent to it.
    expect(await here.ok((f) => f.finishUpload(uploadId))).toEqual({
      state: 'kept',
      fileId: upload.id,
    })

    expect((await here.fail((f) => f.relay(uploadId, bytesOf('pixels'), 6))).status).toBe(404)
  })

  test('started again with the same id is the same upload', async () => {
    const upload = described('plan.pdf', null, 'plan')
    const first = await here.ok((f) => f.startUpload(upload))
    expect(await here.ok((f) => f.startUpload(upload))).toEqual(first)
    expect(await here.db((db) => db.count(FileNode))).toBe(1)

    // Another file can't take its place.
    expect(
      await here.fail((f) => f.startUpload({ ...upload, sha256: sha('other') })),
    ).toMatchObject({
      code: 'database',
    })
  })

  test("whose bytes aren't the ones it was started for is refused, and leaves nothing on the disk", async () => {
    const before = onDisk()
    const upload = described('plan.pdf', null, 'the plan')
    const { uploadId } = await here.ok((f) => f.startUpload(upload))

    // Too few, too many, and as many but different.
    for (const body of [
      stream('the pla'),
      stream('the', ' plan', '!'),
      stream('the plaN'),
      bytesOf('the plaN'),
    ]) {
      const error = await here.fail((f) => f.relay(uploadId, body, 8))
      expect(error.message).toBe('The file changed while it was being added. Add it again.')
    }

    expect((await here.fail((f) => f.relay(uploadId, bytesOf('the plan'), 7))).code).toBe(
      'upload_mismatch',
    )

    expect(onDisk()).toEqual(before)

    expect((await here.fail((f) => f.finishUpload(uploadId))).code).toBe(
      'upload_transfer_incomplete',
    )

    // The right bytes are still welcome.
    await here.ok((f) => f.relay(uploadId, stream('the plan'), 8))
    expect((await here.ok((f) => f.finishUpload(uploadId))).state).toBe('kept')
  })

  test('a blob store says holds something else is refused for good, and its bytes are deleted', async () => {
    for (const found of [{ sizeBytes: 3 }, { sizeBytes: 4, sha256: sha('evil') }]) {
      const removed: string[] = []

      const there = server({
        problems: Effect.succeed([]),
        target: () =>
          Effect.succeed({ transport: 'direct', url: 'https://bucket.example/put', headers: {} }),
        stat: () => Effect.succeed(found),
        open: () => Effect.succeed({ kind: 'link', url: 'https://bucket.example/get' }),
        remove: (key) => Effect.sync(() => void removed.push(key)),
      })

      const { uploadId, target } = await there.ok((f) =>
        f.startUpload(described('a.pdf', null, 'good')),
      )

      expect(target.transport).toBe('direct')

      // A store that takes bytes directly is never handed them by this server.
      expect((await there.fail((f) => f.relay(uploadId, bytesOf('good'), 4))).code).toBe(
        'not_relayed',
      )

      expect(await there.ok((f) => f.finishUpload(uploadId))).toMatchObject({
        state: 'refused',
        error: { message: 'The file changed while it was being added. Add it again.' },
      })

      expect(removed.length).toBe(1)
      expect(await there.db((db) => db.count(FileNode))).toBe(0)
      expect((await there.fail((f) => f.finishUpload(uploadId))).status).toBe(404)
      await there.rt.dispose()
    }
  })

  test('into a folder deleted in the meantime is refused, and its bytes are deleted', async () => {
    const before = onDisk()
    const photos = await folder('Photos')
    const { uploadId } = await here.ok((f) => f.startUpload(described('a.png', photos, 'a')))
    await here.ok((f) => f.relay(uploadId, bytesOf('a'), 1))
    // Deleted behind the drive's back, as another server might.
    await here.db((db) => db.remove(FileNode, { where: { id: photos } }))

    expect(await here.ok((f) => f.finishUpload(uploadId))).toMatchObject({
      state: 'refused',
      error: { status: 404 },
    })

    expect(onDisk()).toEqual(before)
    expect(await here.db((db) => db.count(FileNode))).toBe(0)
  })

  test('abandoned for a day is forgotten, with whatever bytes came; a newer one is left alone', async () => {
    const before = onDisk()
    const old = await here.ok((f) => f.startUpload(described('old.bin', null, 'old')))
    await here.ok((f) => f.relay(old.uploadId, bytesOf('old'), 3))
    const late = await here.ok((f) => f.startUpload(described('late.bin', null, 'late')))
    const kept = await add('kept.bin')
    const daysAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)

    await here.db((db) =>
      db.update(
        FileNode,
        { filter: or(eq('id', old.uploadId), eq('id', kept)) },
        { createdAt: daysAgo },
      ),
    )

    // The next server to start an upload looks for them.
    const next = server()
    await next.ok((f) => f.startUpload(described('new.bin', null, 'new')))
    const rows = await next.db((db) => db.find(FileNode))
    expect(rows.map((r) => r.name).sort()).toEqual(['kept.bin', 'late.bin', 'new.bin'])
    expect(onDisk().length).toBe(before.length + 1)
    expect(late.uploadId).toBeTruthy()
    await next.rt.dispose()
  })
})

describe('names', () => {
  test("two folders in one place can't share one; in different places they can", async () => {
    const photos = await folder('Photos')
    const error = await here.fail((f) => f.createFolder(null, 'Photos'))
    expect(error.message).toBe('Something with that name is already there.')
    const again = await folder('Photos', photos)
    const plans = await folder('Plans')

    expect((await here.fail((f) => f.changeFolder(plans, { name: 'Photos' }))).code).toBe(
      'duplicate_name',
    )

    expect((await here.fail((f) => f.changeFolder(again, { parentId: null }))).code).toBe(
      'duplicate_name',
    )

    // Its own name is no one else's.
    await here.ok((f) => f.changeFolder(photos, { name: 'Photos' }))
    expect(await inside(null)).toEqual({ folders: ['Photos', 'Plans'], files: [] })
  })

  test('a file whose name is taken gets a number before its extension', async () => {
    const photos = await folder('Photos')

    for (let i = 0; i < 3; i++) {
      await add('plan.pdf', photos)
    }

    await add('archive.tar.gz', photos)
    await add('archive.tar.gz', photos)
    await add('README', photos)
    await add('README', photos)

    expect((await inside(photos)).files).toEqual([
      'README',
      'README (2)',
      'archive.tar (2).gz',
      'archive.tar.gz',
      'plan (2).pdf',
      'plan (3).pdf',
      'plan.pdf',
    ])

    // The same when one is moved in, or renamed.
    const moved = await add('plan.pdf')
    await here.ok((f) => f.changeFile(moved, { folderId: photos }))
    expect((await inside(photos)).files).toContain('plan (4).pdf')
    await here.ok((f) => f.changeFile(moved, { name: 'README' }))
    expect((await inside(photos)).files).toContain('README (3)')
    // A name that is being uploaded isn't taken yet, and a file keeps its own.
    await here.ok((f) => f.startUpload(described('later.pdf', photos, 'x')))
    await here.ok((f) => f.changeFile(moved, { name: 'later.pdf' }))
    await here.ok((f) => f.changeFile(moved, { name: 'later.pdf' }))
    expect((await inside(photos)).files).toContain('later.pdf')
  })

  test('are only ever words in the database: none becomes a path', async () => {
    const before = onDisk()
    const odd = '../../../etc/passwd'
    const id = await add(odd, null, 'nothing to see')
    expect(await read(id)).toBe('nothing to see')
    const [written, ...others] = onDisk().filter((name) => !before.includes(name))
    expect(others).toEqual([])
    expect(written).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('folders', () => {
  test('keep their id when they are renamed or moved', async () => {
    const a = await folder('A')
    const b = await folder('B')
    const file = await add('in a.txt', a)
    await here.ok((f) => f.changeFolder(a, { name: 'Renamed', parentId: b }))

    expect(await here.ok((f) => f.folder(a))).toEqual({
      id: a,
      name: 'Renamed',
      parentId: b,
      items: null,
    })

    expect(await inside(a)).toEqual({ folders: [], files: ['in a.txt'] })
    expect((await here.ok((f) => f.search('in a'))).files[0]?.path).toBe('B/Renamed/in a.txt')
    await here.ok((f) => f.changeFolder(a, { parentId: null }))
    expect((await here.ok((f) => f.folder(a))).parentId).toBeNull()
    expect(await read(file)).toBe('the bytes of in a.txt')
  })

  test("can't be moved into themselves, or into anything inside them", async () => {
    const top = await folder('Top')
    const middle = await folder('Middle', top)
    const bottom = await folder('Bottom', middle)

    for (const into of [top, middle, bottom]) {
      const error = await here.fail((f) => f.changeFolder(top, { parentId: into }))
      expect(error.message).toBe("A folder can't be moved into itself.")
    }
  })

  test('moved into each other at once, on two servers, are never lost from sight', async () => {
    const there = server()

    for (let round = 0; round < 10; round++) {
      const one = await folder(`One ${round}`)
      const two = await folder(`Two ${round}`)

      await Promise.all([
        here.ok((f) => Effect.exit(f.changeFolder(one, { parentId: two }))),
        there.ok((f) => Effect.exit(f.changeFolder(two, { parentId: one }))),
      ])

      const top = (await here.ok((f) => f.list(null))).folders.map((f) => f.id)

      const shown = [
        ...top,
        ...(await Promise.all(top.map((id) => here.ok((f) => f.list(id))))).flatMap((l) =>
          l.folders.map((f) => f.id),
        ),
      ]

      expect(shown).toContain(one)
      expect(shown).toContain(two)
    }

    await there.rt.dispose()
  })

  test('are deleted with everything in them, hidden uploads and all, and nothing else is touched', async () => {
    const top = await folder('Top')
    const deep = await folder('Deep', await folder('Middle', top))
    const beside = await add('beside.txt')
    const before = onDisk().length
    await add('one.txt', top)
    await add('two.txt', deep)
    const pending = await here.ok((f) => f.startUpload(described('coming.txt', deep, 'coming')))
    await here.ok((f) => f.relay(pending.uploadId, bytesOf('coming'), 6))
    expect(onDisk().length).toBe(before + 3)

    await here.ok((f) => f.deleteFolder(top))
    expect(onDisk().length).toBe(before)
    expect((await here.db((db) => db.find(FileNode))).map((r) => r.name)).toEqual(['beside.txt'])
    expect(await read(beside)).toBe('the bytes of beside.txt')
    expect((await here.fail((f) => f.finishUpload(pending.uploadId))).status).toBe(404)
    expect((await here.fail((f) => f.deleteFolder(top))).status).toBe(404)
  })

  test('hold their first 1,000 folders and files, and say when there are more', async () => {
    const full = await folder('Full')

    await client.exec(`INSERT INTO "public"."file_nodes" (id, name, kind, parent_id, created_at, updated_at, pending)
      SELECT gen_random_uuid()::text, 'f' || n, 'file', '${full}', now(), now(), false FROM generate_series(1, 1001) n`)

    const listing = await here.ok((f) => f.list(full))
    expect([listing.files.length, listing.truncated]).toEqual([1000, true])
    expect((await here.ok((f) => f.list(null))).folders[0]?.items).toBe(1001)
    expect((await here.ok((f) => f.list(null))).truncated).toBe(false)
  })
})

describe('ensuring folders', () => {
  test("makes what isn't there, finds what is, and says which folder each path is", async () => {
    const paths = ['Deals/Globex', 'Deals/Globex/Proposals', 'Deals/Initech']
    const first = await here.ok((f) => f.ensureFolders(paths))
    expect([...first.keys()]).toEqual(paths)
    expect(await here.ok((f) => f.ensureFolders(paths))).toEqual(first)
    expect(await here.db((db) => db.count(FileNode))).toBe(4)

    // Ids are what links and pages take.
    for (const id of first.values()) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }

    expect((await here.ok((f) => f.ensureFolders([]))).size).toBe(0)
  })

  test('a folder that was renamed or moved away is left where it is, and a new one is made', async () => {
    const ensure = async () =>
      (await here.ok((f) => f.ensureFolders(['Deals/Globex']))).get('Deals/Globex')

    const made: (string | undefined)[] = []

    // More often than the ids tried at once.
    for (let i = 0; i < 40; i++) {
      const id = await ensure()
      made.push(id)
      await here.ok((f) => f.changeFolder(String(id), { name: `Globex ${i}` }))
    }

    expect(new Set(made).size).toBe(40)
    expect((await here.ok((f) => f.folder(String(made[0])))).name).toBe('Globex 0')
    // One that was deleted is made again.
    await here.ok((f) => f.deleteFolder(String(made[3])))
    expect(await ensure()).toBeTruthy()
  })

  test('by two servers at once makes each folder once, and both are told the same', async () => {
    const there = server()

    for (let round = 0; round < 25; round++) {
      const paths = [`Round ${round}/Globex/Proposals`, `Round ${round}/Globex/Contracts`]

      // Every other round the first id is already used, by a folder that was renamed.
      if (round % 2) {
        const [id] = (await here.ok((f) => f.ensureFolders([`Round ${round}`]))).values()
        await here.ok((f) => f.changeFolder(String(id), { name: `Before ${round}` }))
      }

      const [one, two, made] = await Promise.all([
        here.ok((f) => f.ensureFolders(paths)),
        there.ok((f) => f.ensureFolders(paths)),
        there.ok((f) => Effect.exit(f.createFolder(null, `Round ${round}`))),
      ])

      expect(two).toEqual(one)

      expect(await here.db((db) => db.count(FileNode, { where: { name: `Round ${round}` } }))).toBe(
        1,
      )

      // The one who was only making a folder is told it is there, or made it before either of them.
      if (made._tag === 'Success') {
        expect((await here.ok((f) => f.folder(made.value.id))).name).toBe(`Round ${round}`)
      }
    }

    for (const name of ['Globex', 'Proposals', 'Contracts']) {
      expect(await here.db((db) => db.count(FileNode, { where: { name } }))).toBe(25)
    }

    await there.rt.dispose()
  })
})

describe('search', () => {
  test('finds files by the words of their names, in order, any case, wherever they are', async () => {
    const plans = await folder('Kitchen plans')
    await add('Kitchen Plan v2.pdf', plans)
    await add('plan of the kitchen.pdf')
    await add('bathroom.pdf')
    const found = async (words: string) => names((await here.ok((f) => f.search(words))).files)
    expect(await found('kitchen plan')).toEqual(['Kitchen Plan v2.pdf'])
    expect(await found('PLAN kitchen')).toEqual(['plan of the kitchen.pdf'])

    expect(await found('pdf')).toEqual([
      'Kitchen Plan v2.pdf',
      'bathroom.pdf',
      'plan of the kitchen.pdf',
    ])

    expect(await found('nothing')).toEqual([])
    // Folders aren't files.
    expect(await found('kitchen plans')).toEqual([])
    const [deep] = (await here.ok((f) => f.search('v2'))).files

    expect(deep).toMatchObject({
      path: 'Kitchen plans/Kitchen Plan v2.pdf',
      folderId: plans,
      addedBy: 'Ada',
    })

    expect((await here.ok((f) => f.search('bathroom'))).files[0]?.path).toBe('bathroom.pdf')
  })

  test('takes what is typed as text, not as a pattern', async () => {
    await add('100% done_final [v1].txt')
    await add('100 percent donexfinal.txt')
    const found = async (words: string) => names((await here.ok((f) => f.search(words))).files)
    expect(await found('100%')).toEqual(['100% done_final [v1].txt'])
    expect(await found('done_final')).toEqual(['100% done_final [v1].txt'])
    expect(await found('[v1]')).toEqual(['100% done_final [v1].txt'])

    // No name can have these in it, so they are only the space between words.
    expect(await found('*100*done*')).toEqual([
      '100 percent donexfinal.txt',
      '100% done_final [v1].txt',
    ])

    expect(await found('*?"<>|/\\:')).toEqual([])
  })
})

describe('deleting a file', () => {
  test('deletes its bytes, and one already gone is fine', async () => {
    const before = onDisk().length
    const id = await add('gone.txt')
    await here.ok((f) => f.deleteFile(id))
    expect(onDisk().length).toBe(before)
    await here.ok((f) => f.deleteFile(id))

    expect((await here.fail((f) => f.open(id))).message).toBe(
      'That is no longer in the file store.',
    )
  })

  test('that fails partway leaves something to delete again', async () => {
    const id = await add('stuck.txt')

    const broken = server({
      ...localBlobs({ dir }),
      remove: () => Effect.fail(new FilesError({ message: 'The disk is away' })),
    })

    expect((await broken.fail((f) => f.deleteFile(id))).message).toBe('The disk is away')
    expect(await read(id)).toBe('the bytes of stuck.txt')
    await here.ok((f) => f.deleteFile(id))
    expect(await inside(null)).toEqual({ folders: [], files: [] })
    await broken.rt.dispose()
  })
})

test('anything that is gone says so, and a file is not a folder', async () => {
  const file = await add('a.txt')

  for (const id of [crypto.randomUUID(), file]) {
    for (const work of [
      (f: Files) => f.folder(id),
      (f: Files) => f.list(id),
      (f: Files) => f.createFolder(id, 'In nowhere'),
      (f: Files) => f.changeFolder(id, { name: 'x' }),
      (f: Files) => f.deleteFolder(id),
      (f: Files) => f.startUpload(described('x.txt', id, 'x')),
      (f: Files) => f.changeFile(file, { folderId: id }),
    ]) {
      const error = await here.fail<unknown, FilesError>(work)
      expect([error.message, error.status]).toEqual(['That is no longer in the file store.', 404])
    }
  }

  const dir = await folder('A folder')

  for (const id of [crypto.randomUUID(), dir]) {
    for (const work of [
      (f: Files) => f.open(id),
      (f: Files) => f.changeFile(id, { name: 'x' }),
      (f: Files) => f.relay(id, bytesOf('x'), 1),
      (f: Files) => f.finishUpload(id),
    ]) {
      expect((await here.fail<unknown, FilesError>(work)).status).toBe(404)
    }
  }
})

describe("a drive that isn't set up", () => {
  test('says what is missing and refuses everything', async () => {
    const there = server(
      s3Blobs({
        env: {
          bucket: 'NO_BUCKET',
          endpoint: 'NO_ENDPOINT',
          region: 'NO_REGION',
          accessKeyId: 'NO_KEY',
          secretAccessKey: 'NO_SECRET',
        },
      }),
    )

    expect(await there.ok((f) => f.problems)).toEqual([
      'NO_BUCKET is not set',
      'NO_KEY is not set',
      'NO_SECRET is not set',
      'NO_ENDPOINT is not set (or NO_REGION, for Amazon S3)',
    ])

    for (const work of [
      (f: Files) => f.drive,
      (f: Files) => f.list(null),
      (f: Files) => f.createFolder(null, 'A'),
      (f: Files) => f.startUpload(described('x.txt', null, 'x')),
    ]) {
      expect((await there.fail<unknown, FilesError>(work)).message).toBe(
        "Files haven't been set up for this CRM yet.",
      )
    }

    expect(await there.db((db) => db.count(FileNode))).toBe(0)
    await there.rt.dispose()
  })

  test("the store's id doesn't change with where the bytes are", async () => {
    expect(await here.ok((f) => f.drive)).toBe('drive')
  })
})

describe('the disk', () => {
  const blobs = localBlobs({ dir: join(dir, 'disk') })
  const run = <A, E>(work: Effect.Effect<A, E>) => Effect.runPromise(work)

  const put = (key: string, text: string) =>
    blobs.put?.(key, bytesOf(text), { sizeBytes: Buffer.byteLength(text), sha256: sha(text) }) ??
    Effect.die('no put')

  test('only takes keys the server could have made: nothing else is ever a path', async () => {
    const secret = join(dir, 'secret.txt')
    writeFileSync(secret, 'not for you')
    const before = onDisk()

    for (const key of [
      '../secret.txt',
      '../../etc/passwd',
      '/etc/passwd',
      '..',
      '',
      '.',
      'secret.txt',
      '..%2fsecret.txt',
      '..\\secret.txt',
      `${crypto.randomUUID()}/../../secret.txt`,
      `${crypto.randomUUID()}\0`,
      `${crypto.randomUUID()}\n`,
      crypto.randomUUID().toUpperCase(),
    ]) {
      for (const work of [
        put(key, 'x'),
        blobs.stat(key),
        blobs.open(key, 'x'),
        blobs.remove(key),
      ]) {
        const error = await run(Effect.flip<unknown, { status?: number }, never>(work))
        expect(error.status).toBe(404)
      }
    }

    expect(onDisk()).toEqual(before)
    rmSync(secret)
  })

  test('keeps bytes whole: a body that stops halfway, or one that is dropped, leaves nothing', async () => {
    const key = crypto.randomUUID()
    const root = join(dir, 'disk')

    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('half'))
        controller.error(new Error('the connection dropped'))
      },
    })

    const error = await run(
      Effect.flip(
        blobs.put?.(key, broken, { sizeBytes: 8, sha256: sha('halfhalf') }) ?? Effect.die(''),
      ),
    )

    expect(error.message).toBe('The upload was interrupted. Add the file again.')
    expect(onDisk(root)).toEqual([])

    // The browser goes away: the program is interrupted, the body let go, and what was written removed.
    let cancelled = false

    const endless = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        controller.enqueue(new Uint8Array(16))
        await Bun.sleep(5)
      },
      cancel: () => {
        cancelled = true
      },
    })

    await run(
      (
        blobs.put?.(key, endless, { sizeBytes: 1_000_000_000, sha256: sha('') }) ?? Effect.die('')
      ).pipe(Effect.timeout('60 millis'), Effect.exit),
    )

    for (let i = 0; i < 50 && onDisk(root).length > 0; i++) {
      await Bun.sleep(10)
    }

    expect([cancelled, onDisk(root)]).toEqual([true, []])
    expect(await run(blobs.stat(key))).toBeNull()
  })

  test('forgets a key with what a stopped server left beside it, and nothing else', async () => {
    const key = crypto.randomUUID()
    const other = `${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`
    await run(put(key, 'mine'))
    await run(put(other, 'theirs'))
    const root = join(dir, 'disk')
    writeFileSync(join(root, key.slice(0, 2), `${key}.${crypto.randomUUID()}.part`), 'half')
    await run(blobs.remove(key))
    expect(onDisk(root)).toEqual([other])
    // One already gone is fine, and so is one in a place that was never made.
    await run(blobs.remove(key))
    await run(blobs.remove(crypto.randomUUID()))
    await run(blobs.remove(other))
  })

  test("doesn't do where a server's disk doesn't last", async () => {
    const saved = process.env['SERVERLESS']
    process.env['SERVERLESS'] = '1'
    const problems = await run(blobs.problems)

    if (saved === undefined) {
      delete process.env['SERVERLESS']
    } else {
      process.env['SERVERLESS'] = saved
    }

    expect(problems).toEqual([
      "localBlobs() keeps files on the server's disk, and a serverless host has none that lasts: use s3Blobs()",
    ])

    expect(await run(blobs.problems)).toEqual([])
  })
})

describe('a bucket', () => {
  const settings = {
    bucket: 'crm-files',
    endpoint: 'https://acct.r2.cloudflarestorage.com/',
    region: 'auto',
    accessKeyId: 'AKEXAMPLE',
    secretAccessKey: 'a-secret',
  }

  const key = '7f3f6a0e-5f0a-4f6e-9d2e-0f6f1d9f3c11'
  const run = <A, E>(work: Effect.Effect<A, E>) => Effect.runPromise(work)

  const link = async (name: string) => {
    const opened = await run(s3Blobs(settings).open(key, name))
    return new URL(opened.kind === 'link' ? opened.url : '')
  }

  test("gives the browser a link to put one object's bytes at, good for a quarter of an hour", async () => {
    const target = await run(s3Blobs(settings).target(key, { sizeBytes: 4, sha256: sha('good') }))

    expect(target).toMatchObject({
      transport: 'direct',
      headers: { 'content-type': 'application/octet-stream' },
    })

    const url = new URL(target.transport === 'direct' ? target.url : '')

    expect(`${url.origin}${url.pathname}`).toBe(
      `https://acct.r2.cloudflarestorage.com/crm-files/${key}`,
    )

    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-Credential')).toStartWith('AKEXAMPLE/')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.href).not.toContain('a-secret')
  })

  test("gives a link to open one object that lasts five minutes, under the file's name", async () => {
    const url = await link('Plan für Küche.pdf')
    expect(url.pathname).toBe(`/crm-files/${key}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf')

    expect(url.searchParams.get('response-content-disposition')).toBe(
      'inline; filename="Plan f_r K_che.pdf"; filename*=UTF-8\'\'Plan%20f%C3%BCr%20K%C3%BCche.pdf',
    )

    // What could run is downloaded, here as anywhere.
    const page = await link('page.html')
    expect(page.searchParams.get('response-content-type')).toBe('application/octet-stream')
    expect(page.searchParams.get('response-content-disposition')).toStartWith('attachment; ')
  })

  test('takes its settings from the variables it is told, or the values it is given', async () => {
    const names = [
      'S3_BUCKET',
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'R2_BUCKET',
    ]

    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]))

    for (const n of names) {
      delete process.env[n]
    }

    try {
      expect(await run(s3Blobs().problems)).toEqual([
        'S3_BUCKET is not set',
        'S3_ACCESS_KEY_ID is not set',
        'S3_SECRET_ACCESS_KEY is not set',
        'S3_ENDPOINT is not set (or S3_REGION, for Amazon S3)',
      ])

      Object.assign(process.env, {
        S3_REGION: 'eu-west-1',
        S3_ACCESS_KEY_ID: 'AK',
        S3_SECRET_ACCESS_KEY: 'SK',
        R2_BUCKET: 'from-r2',
      })

      const blobs = s3Blobs({ env: { bucket: 'R2_BUCKET' } })
      expect(await run(blobs.problems)).toEqual([])
      const opened = await run(blobs.open(key, 'a.txt'))

      expect(opened.kind === 'link' && opened.url).toStartWith(
        `https://s3.eu-west-1.amazonaws.com/from-r2/${key}?`,
      )

      // The boot report asks for the variables that are needed, and only those.
      expect(blobs.features?.[0]?.vars).toEqual([
        'R2_BUCKET',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
      ])

      expect(blobs.features?.[0]?.check?.(process.env)).toBeNull()
      expect(blobs.features?.[0]?.check?.({})).toBe('set S3_ENDPOINT (or S3_REGION, for Amazon S3)')
      expect(s3Blobs(settings).features?.[0]?.vars).toEqual([])

      expect(await run(s3Blobs({ ...settings, endpoint: 'acct.example.com' }).problems)).toEqual([
        'S3_ENDPOINT is not a web address (https://...)',
      ])
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) {
          delete process.env[n]
        } else {
          process.env[n] = saved[n]
        }
      }
    }
  })

  test("says so when another key's session token is set, which Bun would sign with", async () => {
    const saved = process.env['AWS_SESSION_TOKEN']
    process.env['AWS_SESSION_TOKEN'] = 'belongs-to-another-key'
    const problems = await run(s3Blobs(settings).problems)

    if (saved === undefined) {
      delete process.env['AWS_SESSION_TOKEN']
    } else {
      process.env['AWS_SESSION_TOKEN'] = saved
    }

    expect(problems).toEqual([
      "AWS_SESSION_TOKEN is set, for another key than this bucket's: unset it",
    ])
  })

  test('only ever signs for keys the server could have made', async () => {
    for (const bad of ['../other-bucket/x', '', 'a/b', key.toUpperCase()]) {
      for (const work of [
        s3Blobs(settings).target(bad, { sizeBytes: 1, sha256: sha('x') }),
        s3Blobs(settings).open(bad, 'x'),
        s3Blobs(settings).stat(bad),
        s3Blobs(settings).remove(bad),
      ]) {
        const error = await run(Effect.flip<unknown, { status?: number }, never>(work))
        expect(error.status).toBe(404)
      }
    }
  })

  describe('played by a server on this machine', () => {
    const objects = new Map<string, string>()
    const asked: string[] = []
    let answer: ((request: Request) => Response | undefined) | undefined

    const bucket = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url)
        asked.push(`${request.method} ${pathname}`)
        const instead = answer?.(request)

        if (instead) {
          return instead
        }

        if (request.method === 'PUT') {
          objects.set(pathname, await request.text())
          return new Response(null, { headers: { etag: '"1"' } })
        }

        if (request.method === 'DELETE') {
          objects.delete(pathname)
          return new Response(null, { status: 204 })
        }

        const found = objects.get(pathname)

        if (found === undefined) {
          return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
        }

        return new Response(request.method === 'HEAD' ? null : found, {
          headers: {
            'content-length': String(found.length),
            etag: '"1"',
            'last-modified': new Date().toUTCString(),
          },
        })
      },
    })

    const blobs = s3Blobs({ ...settings, endpoint: `http://localhost:${bucket.port}` })
    afterAll(() => bucket.stop(true))

    afterEach(() => {
      answer = undefined
    })

    test('a file goes straight to it, is checked there, opens by a link and is deleted with its folder', async () => {
      const there = server(blobs)
      const plans = await there.ok((f) => f.createFolder(null, 'Plans'))

      const { uploadId, target } = await there.ok((f) =>
        f.startUpload(described('plan.pdf', plans.id, 'the plan')),
      )

      if (target.transport !== 'direct') {
        throw new Error('A bucket takes bytes directly')
      }

      expect((await there.fail((f) => f.finishUpload(uploadId))).code).toBe(
        'upload_transfer_incomplete',
      )

      // The browser's part.
      await fetch(target.url, { method: 'PUT', headers: target.headers, body: 'the plan' })

      expect(await there.ok((f) => f.finishUpload(uploadId))).toEqual({
        state: 'kept',
        fileId: uploadId,
      })

      const opened = await there.ok((f) => f.open(uploadId))
      expect(opened.kind === 'link' && (await (await fetch(opened.url)).text())).toBe('the plan')
      await there.ok((f) => f.deleteFolder(plans.id))
      expect(objects.size).toBe(0)

      // Bytes of another size than the upload was started for aren't kept.
      const short = await there.ok((f) => f.startUpload(described('short.pdf', null, 'all of it')))

      if (short.target.transport !== 'direct') {
        throw new Error('A bucket takes bytes directly')
      }

      await fetch(short.target.url, { method: 'PUT', body: 'all of' })
      expect((await there.ok((f) => f.finishUpload(short.uploadId))).state).toBe('refused')
      expect(objects.size).toBe(0)
      await there.rt.dispose()
    })

    test("one having a bad moment is asked again; one that refuses the key isn't, and neither is in its own words", async () => {
      objects.set(`/crm-files/${key}`, 'x')
      asked.length = 0
      answer = () => (asked.length < 3 ? new Response(null, { status: 503 }) : undefined)
      expect(await run(blobs.stat(key))).toEqual({ sizeBytes: 1 })
      expect(asked.length).toBe(3)

      asked.length = 0

      answer = () =>
        new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', {
          status: 403,
        })

      const error = await run(Effect.flip(blobs.remove(key)))

      expect(error.message).toBe(
        "The file store refused this CRM's key. Ask whoever runs the CRM to check the bucket and its key.",
      )

      expect(asked.length).toBe(1)
      answer = undefined
      // A key with nothing under it is fine to delete, however the bucket puts it.
      answer = () => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
      await run(blobs.remove(key))
    })
  })
})

describe('under the CRM', () => {
  test('its table is made with the rest, whatever the environment', () => {
    const { schema } = generatePrisma(crmConfig(), [drive({ blobs: localBlobs({ dir }) })])
    expect(schema).toContain('model FileNode {')
    expect(schema).toContain('@@map("file_nodes")')
    expect(schema).toContain('pending Boolean @default(false)')
    expect(drive({ blobs: s3Blobs() }).tables).toEqual([FileNode])
  })

  test("records get their folders, and an upload goes through this server and onto the timeline's page", async () => {
    const rt = testRuntime(
      appLayer({
        store,
        auth: Auth.layerTest([]),
        files: drive({ blobs: localBlobs({ dir }) }).layer.pipe(
          Layer.provide(store),
          Layer.provide(httpLayer()),
        ),
      }),
    )

    const ada = { id: 'user_ada', email: 'ada@example.com', name: 'Ada' }
    const [objectKey] = Object.entries(crmConfig().objects).find(([, o]) => o.files) ?? ['']
    const titled = crmConfig().objects[objectKey]?.titleField ?? 'name'

    const record = await rt.runPromise(
      createRecord(objectKey, { [titled]: 'Globex: North' }, ada.id),
    )

    const own = await rt.runPromise(recordFolder(objectKey, record.id))
    expect(own.path).toEndWith('/Globex- North')
    expect(await rt.runPromise(recordFolder(objectKey, record.id))).toEqual(own)

    const text = 'a small plan'

    const ticket = await rt.runPromise(
      startUpload(
        { folderId: own.folderId, name: 'Plan.pdf', sizeBytes: text.length, sha256: sha(text) },
        ada,
      ),
    )

    expect(ticket).toEqual({
      id: ticket.id,
      transport: 'relay',
      url: `/api/files/uploads/${ticket.id}`,
      headers: { 'content-type': 'application/octet-stream' },
    })

    await rt.runPromise(relayContent(ticket.id, stream(text), text.length, ada))

    expect(await rt.runPromise(finishUpload(ticket.id, ada))).toEqual({
      id: ticket.id,
      name: 'Plan.pdf',
    })

    const listing = await rt.runPromise(listFolder(own.folderId))

    expect(listing.files).toMatchObject([
      { name: 'Plan.pdf', path: `${own.path}/Plan.pdf`, addedBy: 'Ada' },
    ])

    expect(listing.record).toMatchObject({ objectKey, recordId: record.id, title: 'Globex: North' })
    const top = await rt.runPromise(listFolder(null))
    expect(names(top.folders)).toContain('Company files')

    expect((await rt.runPromise(searchFiles(' plan '))).files.map((f) => f.path)).toEqual([
      `${own.path}/Plan.pdf`,
    ])

    await rt.dispose()
  })
})
