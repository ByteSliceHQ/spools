import { expect, test } from 'bun:test'

import { Effect, Layer } from 'effect'

import * as files from '../../src/server/files'
import * as records from '../../src/server/records'
import { DatabaseError } from '../../src/server/runtime/errors'
import { FileStore } from '../../src/server/runtime/files'
import { httpLayer } from '../../src/server/runtime/http'
import { Scopes, scopeSession } from '../../src/server/scopes'
import { spool } from '../../src/server/spool'
import { Store } from '../../src/server/store/store'
import { RecordFolder } from '../../src/server/store/tables'
import {
  as,
  branches,
  drive,
  grants,
  ids,
  installWorld,
  people,
  scopedWorld,
  sys,
} from './scopes-world'

// Record scopes and the file store, where the two can fall out of step: a
// folder is made in one place and the row that says whose it is in another.

scopedWorld()

/** The world's own database, with a write to `record_folders` failing while `failing` names it. */
const shakyStore = (failing: () => 'insert' | 'update' | null) =>
  Layer.effect(
    Store,
    Effect.gen(function* () {
      const real = yield* Store
      const gone = Effect.fail(new DatabaseError({ cause: 'The database went away' }))

      return Store.of({
        ...real,
        insert: (table, values) =>
          table.name === RecordFolder.name && failing() === 'insert'
            ? gone
            : real.insert(table, values),
        update: (table, which, changes) =>
          table.name === RecordFolder.name && failing() === 'update'
            ? gone
            : real.update(table, which, changes),
      })
    }),
  ).pipe(Layer.provide(spool().database.layer), Layer.provide(httpLayer()))

/** The folders directly inside the shared "Companies" folder, as this person is shown them. */
const companyFolders = async (who: 'nora' | 'hana') => {
  const top = await as(who, files.listFolder(null), null)
  const shared = top.folders.find((f) => f.name === 'Companies')
  return shared ? (await as(who, files.listFolder(shared.id), null)).folders : []
}

test('a record’s folder is never left without an owner when the database fails while it is made', async () => {
  // So "Companies" is there to look in, whatever ran before.
  await as('sam', files.recordFolder('companies', ids.south.depot))

  const id = (
    await sys(records.createRecord('companies', { name: 'Gum Shaky', branch: 'south' }, 'seed'))
  ).id

  let failing: 'insert' | 'update' | null = 'insert'
  await installWorld({ store: shakyStore(() => failing) })

  try {
    // The row can't be written: nothing is made in the file store.
    await expect(as('sam', files.recordFolder('companies', id))).rejects.toThrow('went away')
    expect((await companyFolders('hana')).filter((f) => f.name.includes('Gum Shaky'))).toEqual([])

    // The row is written and the folder made, and the database fails before the row learns the folder's id.
    failing = 'update'
    await expect(as('sam', files.recordFolder('companies', id))).rejects.toThrow('went away')
    failing = null

    const [made] = (await companyFolders('hana')).filter((f) => f.name.includes('Gum Shaky'))
    expect(made).toBeDefined()

    // It is in the file store, and it is still South's: North is neither shown it nor given it by its id.
    expect((await companyFolders('nora')).filter((f) => f.name.includes('Gum Shaky'))).toEqual([])
    await expect(as('nora', files.listFolder(made?.id ?? ''))).rejects.toThrow('Not found')
    await expect(as('nora', files.createFolder(made?.id ?? '', 'Planted'))).rejects.toThrow()
    await expect(as('otto', files.listFolder(made?.id ?? ''))).rejects.toThrow('Not found')

    // The next visit finishes what the first began: the same folder, now the record's own.
    const kept = await as('sam', files.recordFolder('companies', id))
    expect(kept.folderId).toBe(made?.id ?? '')
    expect((await as('sam', files.listFolder(kept.folderId))).record?.recordId).toBe(id)
    await expect(as('nora', files.listFolder(kept.folderId))).rejects.toThrow('Not found')
  } finally {
    await installWorld()
    await sys(records.deleteRecord('companies', id))
  }
})

/** A small file put into a folder by one of the people, as the browser does it. */
const upload = async (who: 'nora' | 'sam', folderId: string, name: string) => {
  const ticket = await as(
    who,
    files.startUpload({ folderId, name, sizeBytes: 5, sha256: 'a'.repeat(64) }, people[who]),
  )

  await drive.handle(ticket.url, { method: 'PUT', body: new TextEncoder().encode('hello').buffer })
  const kept = await as(who, files.finishUpload(ticket.id, people[who]))
  // Taken away again when the test is done: the other tests count what these folders hold.
  return () => as(who, files.deleteFile(kept?.id ?? '', folderId))
}

test('a shared folder’s count is of what the reader can see inside it', async () => {
  await as('nora', files.recordFolder('companies', ids.north.company))
  await as('sam', files.recordFolder('companies', ids.south.company))
  await as('sam', files.recordFolder('companies', ids.south.depot))

  const shared = async (who: 'nora' | 'sam' | 'hana') => {
    const top = await as(who, files.listFolder(null), null)
    const folder = top.folders.find((f) => f.name === 'Companies')
    const inside = await as(who, files.listFolder(folder?.id ?? ''), null)
    return { items: folder?.items, shown: inside.folders.length + inside.files.length }
  }

  const [hers, his, all] = [await shared('nora'), await shared('sam'), await shared('hana')]

  // Head office is given the store's own number. Each branch is given the number of its own.
  expect(all.items).toBe(all.shown)
  expect(hers.items).toBe(hers.shown)
  expect(his.items).toBe(his.shown)
  expect(hers.shown).toBeLessThan(all.shown)
  expect(his.shown).toBeLessThan(all.shown)
  expect((hers.items ?? 0) + (his.items ?? 0)).toBe(all.items ?? -1)
})

test('a file search says there is more only of what the reader could be shown', async () => {
  const north = await as('nora', files.recordFolder('companies', ids.north.company))
  const south = await as('sam', files.recordFolder('companies', ids.south.company))
  const removeHers = await upload('nora', north.folderId, 'Alder ledger.txt')
  const removeHis = await upload('sam', south.folderId, 'Birch ledger.txt')

  // A file store that always says its answer was cut short.
  const cutShort = Layer.effect(
    FileStore,
    Effect.gen(function* () {
      const real = yield* FileStore

      return FileStore.of({
        ...real,
        search: (words) =>
          Effect.map(real.search(words), (found) => ({ ...found, truncated: true })),
      })
    }),
  ).pipe(
    Layer.provide(spool().files?.layer ?? FileStore.none),
    Layer.provide(spool().database.layer),
    Layer.provide(httpLayer((url, init) => drive.handle(url, init))),
  )

  try {
    await installWorld({ files: cutShort })
    const names = (found: { files: { name: string }[] }) => found.files.map((f) => f.name)

    // Everything the store found is hers: there may well be more of it.
    const own = await as('nora', files.searchFiles('alder ledger'))
    expect([names(own), own.truncated]).toEqual([['Alder ledger.txt'], true])

    // Some of what it found was held back. "More" would be about files she can't be shown.
    const mixed = await as('nora', files.searchFiles('ledger'))
    expect([names(mixed), mixed.truncated]).toEqual([['Alder ledger.txt'], false])

    const all = await as('hana', files.searchFiles('ledger'), null)
    expect([names(all), all.truncated]).toEqual([['Alder ledger.txt', 'Birch ledger.txt'], true])
  } finally {
    await installWorld()
    await removeHers()
    await removeHis()
  }
})

test('a listing says which folders its reader can change, for the file browser to show its controls by', async () => {
  const north = await as('nora', files.recordFolder('companies', ids.north.company))
  const south = await as('sam', files.recordFolder('companies', ids.south.company))

  const shared = async (who: 'ned' | 'nora' | 'bo') => {
    const top = await as(who, files.listFolder(null), null)
    const folder = top.folders.find((f) => f.name === 'Companies')
    const inside = await as(who, files.listFolder(folder?.id ?? ''), null)
    const can = (id: string) => inside.folders.find((f) => f.id === id)?.canWrite
    return {
      top: top.canWrite,
      shared: folder?.canWrite,
      north: can(north.folderId),
      south: can(south.folderId),
    }
  }

  // Whoever writes nothing changes nothing, the shared folders included.
  expect(await shared('ned')).toEqual({ top: false, shared: false, north: false, south: undefined })
  expect((await as('ned', files.listFolder(north.folderId))).canWrite).toBe(false)

  // Nora writes North. South's folder isn't listed for her at all.
  expect(await shared('nora')).toEqual({ top: true, shared: true, north: true, south: undefined })
  expect((await as('nora', files.listFolder(north.folderId))).canWrite).toBe(true)

  // Bo, writing North and only reading South: both are listed, one can be changed.
  try {
    await installWorld({
      scopes: Scopes.layerTest(
        {
          ...grants,
          [people.bo.id]: [
            { scope: 'north', role: 'member' },
            { scope: 'south', role: 'viewer' },
          ],
        },
        branches,
      ),
    })

    expect(await shared('bo')).toEqual({ top: true, shared: true, north: true, south: false })
    expect((await as('bo', files.listFolder(north.folderId), null)).canWrite).toBe(true)
    expect((await as('bo', files.listFolder(south.folderId), null)).canWrite).toBe(false)

    // And the session tells the page the same of records.
    expect(await sys(scopeSession(people.bo, null))).toMatchObject({
      canWrite: true,
      writes: ['north'],
    })
  } finally {
    await installWorld()
  }
})
