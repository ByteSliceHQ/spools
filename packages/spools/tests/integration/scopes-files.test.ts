import { expect, test } from 'bun:test'

import { Effect, Layer } from 'effect'

import * as files from '../../src/server/files'
import * as records from '../../src/server/records'
import { DatabaseError } from '../../src/server/runtime/errors'
import { httpLayer } from '../../src/server/runtime/http'
import { spool } from '../../src/server/spool'
import { Store } from '../../src/server/store/store'
import { RecordFolder } from '../../src/server/store/tables'
import { as, ids, installWorld, scopedWorld, sys } from './scopes-world'

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
