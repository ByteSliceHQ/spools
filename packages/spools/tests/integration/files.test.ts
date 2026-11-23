import { afterAll, beforeAll, expect } from 'bun:test'

import { Effect } from 'effect'

import extensions from '../../../../apps/starter/src/app/extensions'
import {
  changeFile,
  changeFolder,
  createFolder,
  deleteFile,
  deleteFolder,
  FilesError,
  finishUpload,
  listFolder,
  openFile,
  recordFolder,
  relayContent,
  searchFiles,
  shareRecordFolder,
  startUpload,
} from '../../src/server/files'
import * as records from '../../src/server/records'
import { crmConfig } from '../../src/server/spool'
import { FileUpload, RecordFolder } from '../../src/server/store/tables'
import type { CrmUser } from '../../src/server/users'
import { createFakeStore } from '../support/fake-file-store'
import { db, installLiveServices, installStandIns, run } from '../support/run'
import { isExampleApp, exampleTest as test } from './example-app'

// The file browser against a real database, with the file store's HTTP API
// played by an in-memory stand-in. The example app's companies and deals take
// files; a deal's folder is made inside its company's. Contacts don't take files.
const tag = `files${Date.now()}`
const user: CrmUser = { id: `user_${tag}`, email: `ada.${tag}@example.com`, name: 'Ada' }
const other: CrmUser = { id: `other_${tag}`, email: `bo.${tag}@example.com`, name: 'Bo' }
const drive = '6eb2d950-7a37-4e6d-a637-765600c2da62'
const sha = 'a'.repeat(64)
const saved = { ...process.env }
const savedFiles = extensions.files
const savedLibrary = crmConfig().files
const fake = createFakeStore()
let companyId = ''
let dealId = ''
let contactId = ''

beforeAll(async () => {
  process.env['FLASHDRIVE_API_KEY'] = 'test-key'
  process.env['FLASHDRIVE_DRIVE_ID'] = drive
  delete process.env['FLASHDRIVE_BASE_URL']
  await installStandIns({ fetch: (url, init) => fake.handle(url, init) })
  crmConfig().files = { label: 'Company files', folders: ['Templates'] }

  // An app with other objects skips these tests; it mustn't make example records either.
  if (!isExampleApp) {
    return
  }

  companyId = (
    await run(records.createRecord('companies', { name: `Acme: North / ${tag}` }, user.id))
  ).id

  dealId = (await run(records.createRecord('deals', { title: `Roof ${tag}`, companyId }, user.id)))
    .id

  contactId = (await run(records.createRecord('contacts', { name: `Con ${tag}` }, user.id))).id
})

afterAll(async () => {
  await installLiveServices()
  extensions.files = savedFiles
  crmConfig().files = savedLibrary

  for (const name of ['FLASHDRIVE_API_KEY', 'FLASHDRIVE_DRIVE_ID', 'FLASHDRIVE_BASE_URL']) {
    if (saved[name] === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = saved[name]
    }
  }

  await db.remove(FileUpload, { where: { uploadedBy: user.id } })
  await db.remove(RecordFolder, { where: { driveId: drive } })

  if (dealId) {
    await run(records.deleteRecord('deals', dealId))
  }

  if (contactId) {
    await run(records.deleteRecord('contacts', contactId))
  }

  if (companyId) {
    await run(records.deleteRecord('companies', companyId))
  }
})

const upload = async (
  name: string,
  folderId: string | null,
  extra: Partial<Parameters<typeof startUpload>[0]> = {},
) => {
  const ticket = await run(
    startUpload({ folderId, name, sizeBytes: 5, sha256: sha, ...extra }, user),
  )

  // The browser's part: the bytes go straight to the store.
  await fake.handle(ticket.url, {
    method: 'PUT',
    body: new TextEncoder().encode('hello').buffer,
  })

  return run(finishUpload(ticket.id, user))
}

const names = (items: { name: string }[]) => items.map((i) => i.name)

const downloadLink = (id: string) =>
  Effect.map(openFile(id), (file) => (file.kind === 'link' ? file.url : null))

test("a company gets its own folder the first time it is asked for, and a deal's folder goes inside it", async () => {
  const company = await run(recordFolder('companies', companyId))
  // The name is made safe for a drive that also mounts as a folder.
  expect(company.path).toBe(`Companies/Acme- North - ${tag}`)
  // Asking again is the same folder: the store is only asked whether it is still there, and not every time.
  fake.calls.length = 0
  expect(await run(recordFolder('companies', companyId))).toEqual(company)
  expect(await run(recordFolder('companies', companyId))).toEqual(company)
  expect(fake.calls.map((c) => c.method)).toEqual(['GET'])

  const deal = await run(recordFolder('deals', dealId))
  expect(deal.path).toBe(`${company.path}/Roof ${tag}`)

  // The folders the config names for a deal are made inside it.
  expect(fake.tree().filter((p) => p.startsWith(deal.path))).toEqual([
    deal.path,
    `${deal.path}/Contracts`,
    `${deal.path}/Proposals`,
  ])

  // The company's folder shows the deal's, marked as a record's own.
  const inside = await run(listFolder(company.folderId))
  expect(inside.trail.map((c) => c.name)).toEqual(['Companies', `Acme- North - ${tag}`])

  expect(inside.record).toMatchObject({
    objectKey: 'companies',
    recordId: companyId,
    label: 'Company',
  })

  expect(inside.folders).toEqual([
    {
      id: deal.folderId,
      name: `Roof ${tag}`,
      items: 2,
      record: { objectKey: 'deals', recordId: dealId },
    },
  ])

  await expect(run(recordFolder('contacts', contactId))).rejects.toThrow(
    "Contacts don't take files.",
  )

  await expect(run(recordFolder('companies', crypto.randomUUID()))).rejects.toThrow(
    'That record no longer exists.',
  )
})

test("two records with the same name don't share a folder, and an app can lay the drive out its own way", async () => {
  const twin = await run(
    records.createRecord('companies', { name: `Acme: North / ${tag}` }, user.id),
  )

  const folder = await run(recordFolder('companies', twin.id))
  expect(folder.path).toBe(`Companies/Acme- North - ${tag} (${twin.id.slice(0, 8)})`)

  extensions.files = { location: ({ record }) => `Clients/2026//../${record.name}` }
  const custom = await run(records.createRecord('companies', { name: `Custom ${tag}` }, user.id))
  expect((await run(recordFolder('companies', custom.id))).path).toBe(`Clients/2026/Custom ${tag}`)
  extensions.files = savedFiles

  // Deleting a record forgets which folder was its own; the folder stays in the drive.
  await run(records.deleteRecord('companies', twin.id))
  await run(records.deleteRecord('companies', custom.id))

  expect(
    await db.first(RecordFolder, { where: { objectKey: 'companies', recordId: twin.id } }),
  ).toBeNull()

  expect(fake.tree()).toContain(folder.path)
})

test("the top level has the shared library beside the records' folders", async () => {
  const top = await run(listFolder(null))
  expect(top.trail).toEqual([])
  expect(names(top.folders)).toEqual(['Clients', 'Companies', 'Company files'])
  const library = top.folders.find((f) => f.name === 'Company files')
  expect(names((await run(listFolder(String(library?.id)))).folders)).toEqual(['Templates'])
})

test('folders can be made, renamed, moved and deleted', async () => {
  const company = await run(recordFolder('companies', companyId))
  const photos = await run(createFolder(company.folderId, 'Site photos'))

  await expect(run(createFolder(company.folderId, 'Site photos'))).rejects.toThrow(
    'Something with that name is already there.',
  )

  await expect(run(createFolder(company.folderId, ' .. '))).rejects.toThrow(
    'Give the folder a name.',
  )

  // A name is cleaned the same way wherever it is typed.
  expect((await run(createFolder(photos.id, 'Before / after'))).name).toBe('Before - after')

  await run(changeFolder(photos.id, { name: 'Photos' }))
  const deal = await run(recordFolder('deals', dealId))
  await run(changeFolder(photos.id, { parentId: deal.folderId }))

  expect((await run(listFolder(photos.id))).trail.map((c) => c.name)).toEqual([
    'Companies',
    `Acme- North - ${tag}`,
    `Roof ${tag}`,
    'Photos',
  ])

  await expect(run(changeFolder(photos.id, { parentId: photos.id }))).rejects.toThrow(
    "can't be moved into itself",
  )

  // Deleting takes everything inside with it.
  await upload('gone.pdf', photos.id)
  await run(deleteFolder(photos.id))
  expect(names((await run(listFolder(deal.folderId))).folders)).toEqual(['Contracts', 'Proposals'])
})

test("a record's own folder can be deleted, and the record gets a new one when it is next opened", async () => {
  const before = await run(recordFolder('deals', dealId))
  await upload('old-quote.pdf', before.folderId)
  await run(deleteFolder(before.folderId))
  expect(fake.tree()).not.toContain(before.path)

  expect(
    await db.first(RecordFolder, { where: { objectKey: 'deals', recordId: dealId } }),
  ).toBeNull()

  const after = await run(recordFolder('deals', dealId))
  expect(after.path).toBe(before.path)
  expect(after.folderId).not.toBe(before.folderId)
  const fresh = await run(listFolder(after.folderId))
  expect([names(fresh.folders), fresh.files]).toEqual([['Contracts', 'Proposals'], []])

  // The same when a folder is deleted in the drive itself, behind the CRM's back.
  const company = await run(recordFolder('companies', companyId))
  const gone = await run(createFolder(null, `Scratch ${tag}`))
  await run(changeFolder(after.folderId, { parentId: gone.id }))
  const etag = `"${fake.folders.get(gone.id)?.version}"`

  await fake.handle(
    `https://api.flashdrive.space/v1/drives/${drive}/folders/${gone.id}?recursive=true`,
    {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-key',
        'flashdrive-client': 'swirls-crm/1.1.2',
        'flashdrive-write-protocol': 'server-v1',
        'if-match': etag,
      },
    },
  )

  await installStandIns({ fetch: (url, init) => fake.handle(url, init) })
  const healed = await run(recordFolder('deals', dealId))
  expect(healed.path).toBe(`${company.path}/Roof ${tag}`)
  expect(healed.folderId).not.toBe(after.folderId)
})

test("a file goes from the browser to the store, and onto the record's timeline when added from its tab", async () => {
  const deal = await run(recordFolder('deals', dealId))

  const proposals = (await run(listFolder(deal.folderId))).folders.find(
    (f) => f.name === 'Proposals',
  )

  fake.calls.length = 0

  const ticket = await run(
    startUpload(
      {
        folderId: String(proposals?.id),
        name: 'Kitchen: plan v2.pdf',
        sizeBytes: 5,
        sha256: sha,
        record: { objectKey: 'deals', recordId: dealId },
      },
      user,
    ),
  )

  // The browser is handed the store's transfer URL and nothing else.
  expect(ticket).toMatchObject({
    transport: 'direct',
    headers: { 'Content-Type': 'application/octet-stream' },
  })

  expect(ticket.url.startsWith('https://storage.example/storage/put/')).toBe(true)

  expect(fake.calls[0]?.body).toMatchObject({
    filename: 'Kitchen- plan v2.pdf',
    format: 'pdf',
    size_bytes: 5,
    sha256: sha,
    external_id: ticket.id,
    folder_id: proposals?.id,
  })

  expect(fake.calls[0]?.headers['flashdrive-client']).toMatch(/^swirls-crm\/\d/)

  // Until the store confirms it, the file is not in the folder.
  expect((await run(listFolder(String(proposals?.id)))).files).toEqual([])
  // Someone else can't finish an upload they didn't start.
  await expect(run(finishUpload(ticket.id, other))).rejects.toThrow('That upload was not found.')

  await fake.handle(ticket.url, {
    method: 'PUT',
    body: new TextEncoder().encode('hello').buffer,
  })

  const stored = await run(finishUpload(ticket.id, user))
  expect(stored?.name).toBe('Kitchen- plan v2.pdf')

  const listed = (await run(listFolder(String(proposals?.id)))).files

  // The folder says who added the file and when: the store keeps that with the file itself.
  expect(listed).toEqual([
    {
      id: String(stored?.id),
      name: 'Kitchen- plan v2.pdf',
      sizeBytes: 5,
      path: `${deal.path}/Proposals/Kitchen- plan v2.pdf`,
      folderId: String(proposals?.id),
      addedBy: 'Ada',
      addedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    },
  ])

  // A drive that refuses the fuller listing still shows its files, without the names of who added them.
  fake.state.plainListingOnly = true

  expect((await run(listFolder(String(proposals?.id)))).files).toMatchObject([
    { name: 'Kitchen- plan v2.pdf', sizeBytes: 5, addedBy: null, addedAt: null },
  ])

  fake.state.plainListingOnly = false

  expect((await run(records.listActivities('deals', dealId))).map((a) => a.summary)).toContain(
    'added a file: Kitchen- plan v2.pdf',
  )

  // The upload is forgotten once it is done.
  expect(await db.first(FileUpload, { where: { id: ticket.id } })).toBeNull()

  expect(await run(downloadLink(String(stored?.id)))).toBe(
    `https://storage.example/storage/get/${stored?.id}`,
  )
})

test('files can be renamed, moved, found by name and deleted', async () => {
  const company = await run(recordFolder('companies', companyId))
  const file = await upload(`Price list ${tag}.pdf`, company.folderId)
  const id = String(file?.id)

  await run(changeFile(id, { name: `Prices ${tag}.pdf` }))
  const archive = await run(createFolder(company.folderId, 'Archive'))
  await run(changeFile(id, { folderId: archive.id }))
  expect(names((await run(listFolder(archive.id))).files)).toEqual([`Prices ${tag}.pdf`])
  await expect(run(changeFile(id, { name: ' ' }))).rejects.toThrow('Give the file a name.')

  // Search is by name across the whole drive, any case; pattern characters are just text.
  expect(names((await run(searchFiles(`prices ${tag}`))).files)).toEqual([`Prices ${tag}.pdf`])
  expect((await run(searchFiles(`*[${tag}`))).files.length).toBeGreaterThan(0)
  expect((await run(searchFiles('   '))).files).toEqual([])
  expect(fake.calls.at(-1)?.path).toContain('pattern=')

  await run(deleteFile(id))
  expect((await run(listFolder(archive.id))).files).toEqual([])
  // One already gone is fine; opening it says so.
  await run(deleteFile(id))
  await expect(run(downloadLink(id))).rejects.toThrow('That is no longer in the file store.')
})

test('a slow or relayed upload still lands, and a refused one says why', async () => {
  const company = await run(recordFolder('companies', companyId))

  // The store is still checking the file: the caller is told to ask again, and nothing is lost.
  fake.state.complete = ['processing', 'processing', 'accepted']

  const slow = await run(
    startUpload(
      { folderId: company.folderId, name: 'photos.zip', sizeBytes: 5, sha256: sha },
      user,
    ),
  )

  expect(await run(finishUpload(slow.id, user, { waitMs: 0 }))).toBeNull()
  expect((await run(finishUpload(slow.id, user, { pollMs: 1 })))?.name).toBe('photos.zip')
  fake.state.complete = ['accepted']

  // The store asks for the bytes to come through this server.
  fake.state.transport = 'proxy'

  const relayed = await run(
    startUpload({ folderId: null, name: 'small.txt', sizeBytes: 5, sha256: sha }, user),
  )

  expect(relayed).toMatchObject({ transport: 'relay', url: `/api/files/uploads/${relayed.id}` })
  const bytes = new TextEncoder().encode('hello').buffer

  await expect(run(relayContent(relayed.id, bytes, 4, user))).rejects.toThrow(
    'The file changed while it was being added',
  )

  await expect(run(relayContent(relayed.id, bytes, 5, other))).rejects.toThrow(
    'That upload was not found.',
  )

  await run(relayContent(relayed.id, bytes, 5, user))
  expect((await run(finishUpload(relayed.id, user)))?.name).toBe('small.txt')
  expect(names((await run(listFolder(null))).files)).toContain('small.txt')
  fake.state.transport = 'direct'

  const start = (extra: Partial<Parameters<typeof startUpload>[0]>) =>
    run(
      startUpload(
        { folderId: company.folderId, name: 'x.pdf', sizeBytes: 5, sha256: sha, ...extra },
        user,
      ),
    )

  await expect(start({ sizeBytes: 0 })).rejects.toThrow('That file is empty.')
  await expect(start({ sizeBytes: 2_000_000_000 })).rejects.toThrow('too large')
  await expect(start({ sha256: 'nope' })).rejects.toThrow('could not be read')

  await expect(start({ name: 'full.pdf' })).rejects.toThrow(
    'The file store is full or over its plan.',
  )

  await expect(start({ folderId: crypto.randomUUID() })).rejects.toThrow(
    'That is no longer in the file store.',
  )

  // A store that never got the bytes says so, and the upload is forgotten.
  const lost = await start({})
  fake.state.complete = ['failed']
  await expect(run(finishUpload(lost.id, user))).rejects.toThrow('could not keep that file')
  expect(await db.first(FileUpload, { where: { id: lost.id } })).toBeNull()
  fake.state.complete = ['accepted']

  // A wrong key is reported as a setup problem, not in the store's own words.
  process.env['FLASHDRIVE_API_KEY'] = 'wrong'
  await expect(start({})).rejects.toThrow("The file store refused this CRM's key.")
  process.env['FLASHDRIVE_API_KEY'] = 'test-key'

  // Without the store configured nothing is attempted.
  delete process.env['FLASHDRIVE_DRIVE_ID']
  fake.calls.length = 0
  await expect(run(listFolder(null))).rejects.toBeInstanceOf(FilesError)
  expect(fake.calls.length).toBe(0)
  process.env['FLASHDRIVE_DRIVE_ID'] = drive
})

test("a record can be given another record's folder", async () => {
  const next = await run(
    records.createRecord('deals', { title: `Phase two ${tag}`, companyId }, user.id),
  )

  await run(
    shareRecordFolder(
      { objectKey: 'deals', recordId: dealId },
      { objectKey: 'deals', recordId: next.id },
    ),
  )

  expect(await run(recordFolder('deals', next.id))).toEqual(
    await run(recordFolder('deals', dealId)),
  )

  await expect(
    run(
      shareRecordFolder(
        { objectKey: 'deals', recordId: dealId },
        { objectKey: 'contacts', recordId: contactId },
      ),
    ),
  ).rejects.toThrow("Contacts don't take files.")

  await run(records.deleteRecord('deals', next.id))
})

test('the store is told what it needs to hear about its caller, and a refusal is explained', async () => {
  // The contract version stated is the store's, not this app's own, and writes name the write protocol:
  // the store refuses a write without it, whatever version is stated.
  await installStandIns({ fetch: (url, init) => fake.handle(url, init) })
  fake.calls.length = 0
  const made = await run(createFolder(null, `Gate ${tag}`))

  expect(fake.calls[0]?.headers).toMatchObject({
    'flashdrive-client': 'swirls-crm/1.1.2',
    'flashdrive-write-protocol': 'server-v1',
  })

  // A store that wants its own SDK and nothing else is answered exactly as the SDK would, once, and that sticks.
  fake.state.sdkOnly = true
  fake.calls.length = 0
  await run(changeFolder(made.id, { name: `Gate two ${tag}` }))

  expect(fake.calls.at(-1)?.headers).toMatchObject({
    'flashdrive-client': 'flashdrive-sdk/1.1.2',
    'flashdrive-source': 'sdk',
    'flashdrive-write-protocol': 'server-v1',
  })

  fake.calls.length = 0
  await run(listFolder(null))

  expect(new Set(fake.calls.map((c) => c.headers['flashdrive-client']))).toEqual(
    new Set(['flashdrive-sdk/1.1.2']),
  )

  fake.state.sdkOnly = false

  // A store that has moved past this contract can't be talked round: the teammate is told what to do.
  await installStandIns({ fetch: (url, init) => fake.handle(url, init) })
  fake.state.minimumClient = '9.0.0'

  await expect(run(listFolder(null))).rejects.toThrow(
    'The file store needs a newer client than this CRM speaks.',
  )

  fake.state.minimumClient = '1.1.1'
  await installStandIns({ fetch: (url, init) => fake.handle(url, init) })
  await run(deleteFolder(made.id))
})
