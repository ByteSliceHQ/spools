import { expect, test } from 'bun:test'

import { Effect, Layer } from 'effect'

import { fileHandlers } from '../../src/api/file'
import { sequencesHandlers } from '../../src/api/sequences'
import { toolsHandlers } from '../../src/api/tools'
import type { ScopeAccess } from '../../src/crm/scopes'
import { runTarget } from '../../src/server/actions'
import { activeRuns, enroll } from '../../src/server/campaigns'
import * as api from '../../src/server/extension-api'
import * as files from '../../src/server/files'
import * as records from '../../src/server/records'
import { Agents } from '../../src/server/runtime/agents'
import * as boundary from '../../src/server/runtime/boundary'
import {
  asSystem,
  GRANT_HEADER,
  grantFor as workflowGrant,
  mintGrant,
  readGrant,
} from '../../src/server/scopes'
import * as service from '../../src/server/service'
import { Store } from '../../src/server/store/store'
import { Activity, Note, SequenceRun } from '../../src/server/store/tables'
import { buildContactIndex } from '../../src/server/sync'
import {
  as,
  column,
  CRON_TOKEN,
  drive,
  ids,
  installWorld,
  northIn,
  people,
  requestFrom,
  scopedWorld,
  sent,
  sightings,
  southIn,
  sys,
  TOOL_TOKEN,
  unattended,
  type Who,
} from './scopes-world'

// Record scopes where nobody is signed in, or where the app's own code runs:
// sequences and their cron tick, hooks, automations and run targets, the tool
// API the agent engine calls back into, and the file store.

scopedWorld()

const { nora, sam } = people

const sweep = async (objectKey: string, q: string) => {
  for (const row of await sys(records.listRecords({ objectKey, q, limit: 500 }))) {
    await sys(records.deleteRecord(objectKey, row.id))
  }
}

const record = async (objectKey: string, id: string) => {
  const found = await sys(records.getRecord(objectKey, id))

  if (!found) {
    throw new Error(`The world has no ${objectKey} ${id}`)
  }

  return found
}

// ── Sequences ───────────────────────────────────────────────────────────────

/** Both branches' contacts in the welcome sequence, each enrolled by its own people. */
const enrolBoth = async () => {
  await as('nora', enroll('welcome', 'contacts', await record('contacts', ids.north.contact), nora))
  await as('sam', enroll('welcome', 'contacts', await record('contacts', ids.south.contact), sam))
}

test('sequences: a record of another scope can’t be enrolled, and runs are counted per scope', async () => {
  await enrolBoth()
  expect(await as('hana', activeRuns(), null)).toEqual({ welcome: 2 })
  expect(await as('nora', activeRuns())).toEqual({ welcome: 1 })

  // A run target is handed the record by its caller. One of another scope is not there for Nora.
  const { id } = await sys(
    records.createRecord('contacts', { name: 'Birch unenrolled', branch: 'south' }, 'seed'),
  )

  try {
    const theirs = await record('contacts', id)
    await expect(as('nora', enroll('welcome', 'contacts', theirs, nora))).rejects.toThrow()

    await expect(
      as(
        'nora',
        runTarget('campaign:welcome', {
          objectKey: 'contacts',
          record: theirs,
          actor: nora,
          trigger: 'action:welcome',
        }),
      ),
    ).rejects.toThrow()

    expect(
      await sys(Store.use((store) => store.count(SequenceRun, { where: { recordId: id } }))),
    ).toBe(0)
  } finally {
    await sys(Store.use((store) => store.remove(SequenceRun, { where: { recordId: id } })))
    await sys(records.deleteRecord('contacts', id))
  }
})

test('sequences: the cron tick sends for every scope, and what it writes stays in the record’s scope', async () => {
  await enrolBoth()
  sent.length = 0

  // The welcome email waits a day. Bring both runs forward, as a day passing would.
  await sys(
    Store.use((store) =>
      store.update(
        SequenceRun,
        { where: { campaignKey: 'welcome', status: 'active' } },
        { dueAt: new Date(Date.now() - 60_000) },
      ),
    ),
  )

  // The scheduler calls the cron route: nobody is signed in, and nothing says whose work this is.
  const request = new Request('http://crm.test/api/cron/sequences', {
    headers: { authorization: `Bearer ${CRON_TOKEN}` },
  })

  const result = await (await sequencesHandlers.GET({ request })).json()
  expect(result).toMatchObject({ ok: true, sent: 2 })
  expect(sent.map((e) => e.to).toSorted()).toEqual(['nina@alder.test', 'sofia@birch.test'])

  // The email to Sofia is on her timeline, which is South's.
  const south = await as('sam', records.listActivities('contacts', ids.south.contact))
  expect(JSON.stringify(south)).toContain('Welcome, Sofia Birch')

  const recent = await as('nora', records.recentActivities(200))
  expect(JSON.stringify(recent)).toContain('Welcome, Nina Alder')
  expect(southIn(recent)).toEqual([])
})

// ── The app's own code ──────────────────────────────────────────────────────

test('hooks, automations and run targets are handed the actor, and reach only the actor’s scope', async () => {
  sightings.length = 0

  try {
    // afterCreate lists contacts through `@swirls/spools/extensions`, as an app's hook would.
    const made = await as('nora', service.createRecord('contacts', { name: 'Alder hooked' }, nora))

    // The automation on contacts.updated runs a handler from the app.
    await as('nora', service.updateRecord('contacts', made.id, { status: 'customer' }, nora))

    const ctx = { objectKey: 'contacts', record: made, actor: nora, trigger: 'action:probe' }
    await as('nora', runTarget('local:probe', ctx))
    // A run-target kind the app added.
    await as('nora', runTarget('look:around', ctx))

    expect(sightings.map((s) => s.where)).toEqual([
      'afterCreate',
      'handler:contacts.updated',
      'handler:action:probe',
      'target:around',
    ])

    for (const seen of sightings) {
      expect(seen.actor).toBe(nora.id)
      // Not nothing: the app's code works as Nora does.
      expect(seen.contacts).toContain('Nina Alder')
      expect(southIn(seen.contacts)).toEqual([])
    }

    sightings.length = 0
    await as('sam', service.updateRecord('contacts', ids.south.contact, { status: 'lead' }, sam))
    expect(sightings.map((s) => s.actor)).toEqual([sam.id])
    expect(sightings[0]?.contacts).toEqual(['Sofia Birch'])
  } finally {
    await sweep('contacts', 'hooked')
  }
})

// ── The tool API ────────────────────────────────────────────────────────────

type ToolAnswer = { ok: boolean; data?: unknown; error?: string }

/** One call to /api/swirls/tools/<tool>, as the agent engine makes it. */
const call = async (tool: string, body: unknown, grant?: string): Promise<ToolAnswer> => {
  const headers = new Headers({
    authorization: `Bearer ${TOOL_TOKEN}`,
    'content-type': 'application/json',
  })

  if (grant !== undefined) {
    headers.set(GRANT_HEADER, grant)
  }

  const request = new Request(`http://crm.test/api/swirls/tools/${tool}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  return (await toolsHandlers.POST({ request, params: { tool } })).json()
}

const grantFor = (access: ScopeAccess, userId?: string) => sys(mintGrant(access, { userId }))
const northOnly: ScopeAccess = { read: ['north'], write: ['north'], active: 'north' }

test('the tool API answers only the bearer token, scopes or not', async () => {
  const request = new Request('http://crm.test/api/swirls/tools/describe', {
    method: 'POST',
    body: '{}',
  })

  expect((await toolsHandlers.POST({ request, params: { tool: 'describe' } })).status).toBe(401)
})

test('the tool API fails closed: a call that carries no grant reaches no record', async () => {
  // What the objects and fields are is the config, not a record.
  expect((await call('describe', {})).ok).toBe(true)

  for (const answer of [
    await call('search', { objectKey: 'contacts' }),
    await call('get', { objectKey: 'contacts', id: ids.north.contact }),
    // A grant that isn't one the server signed.
    await call('search', { objectKey: 'contacts' }, ''),
    await call('search', { objectKey: 'contacts' }, 'north'),
    await call('search', { objectKey: 'contacts' }, `${await grantFor(northOnly)}x`),
  ]) {
    expect(answer.ok).toBe(false)
    expect(northIn(answer)).toEqual([])
    expect(southIn(answer)).toEqual([])
  }

  try {
    expect(
      (await call('create', { objectKey: 'contacts', values: { name: 'Alder tooled' } })).ok,
    ).toBe(false)

    expect(await sys(records.listRecords({ objectKey: 'contacts', q: 'tooled' }))).toEqual([])
  } finally {
    await sweep('contacts', 'tooled')
  }
})

test('the tool API: a grant reaches its own scope, and writes nowhere else', async () => {
  const grant = await grantFor(northOnly, nora.id)
  const rows = (answer: ToolAnswer) => (Array.isArray(answer.data) ? answer.data : [])

  try {
    const found = await call('search', { objectKey: 'contacts' }, grant)
    expect(found.ok).toBe(true)
    expect(column(rows(found), 'name')).toEqual(['Nell Crossing', 'Nina Alder'])
    expect(southIn(found)).toEqual([])

    // Not found, as for a person: the tool can't tell the agent the record exists.
    const hidden = await call('get', { objectKey: 'contacts', id: ids.south.contact }, grant)
    expect(hidden).toEqual({ ok: false, error: 'Record not found' })

    // What the model puts in a tool call is a value like any other.
    const made = await call(
      'create',
      { objectKey: 'contacts', values: { name: 'Alder tooled' } },
      grant,
    )

    expect(made.ok).toBe(true)
    expect(made.data).toMatchObject({ name: 'Alder tooled', branch: 'north' })

    const strayed = await call(
      'create',
      { objectKey: 'contacts', values: { name: 'Alder tooled south', branch: 'south' } },
      grant,
    )

    expect(strayed.ok).toBe(false)

    const changed = await call(
      'update',
      { objectKey: 'contacts', id: ids.south.contact, values: { status: 'customer' } },
      grant,
    )

    expect(changed).toEqual({ ok: false, error: 'Record not found' })

    const noted = await call(
      'add_note',
      { objectKey: 'contacts', id: ids.south.contact, body: 'planted by a tool' },
      grant,
    )

    expect(noted).toEqual({ ok: false, error: 'Record not found' })

    // A grant to read is not a grant to write.
    const reader = await grantFor({ read: ['north'], write: [], active: 'north' })

    const refused = await call(
      'create',
      { objectKey: 'contacts', values: { name: 'Alder tooled reader' } },
      reader,
    )

    expect(refused.ok).toBe(false)

    const now = await sys(records.listRecords({ objectKey: 'contacts', q: 'tooled' }))
    expect(now.map((r) => [r.name, r.branch])).toEqual([['Alder tooled', 'north']])
    expect((await sys(records.getRecord('contacts', ids.south.contact)))?.status).toBe('lead')

    expect(
      await sys(Store.use((store) => store.count(Note, { where: { body: 'planted by a tool' } }))),
    ).toBe(0)
  } finally {
    await sweep('contacts', 'tooled')
    await sys(records.updateRecord('contacts', ids.south.contact, { status: 'lead' }))
    await sys(Store.use((store) => store.remove(Note, { where: { body: 'planted by a tool' } })))
  }
})

// ── Files ───────────────────────────────────────────────────────────────────

test('record folders and files: another scope’s can’t be listed, found, opened, changed or deleted', async () => {
  const folder = await as('sam', files.recordFolder('companies', ids.south.company))

  const ticket = await as(
    'sam',
    files.startUpload(
      {
        folderId: folder.folderId,
        name: 'Birch contract.txt',
        sizeBytes: 5,
        sha256: 'a'.repeat(64),
      },
      sam,
    ),
  )

  // The browser's part: the bytes go straight to the store.
  await drive.handle(ticket.url, {
    method: 'PUT',
    body: new TextEncoder().encode('hello').buffer,
  })

  await as('sam', files.finishUpload(ticket.id, sam))

  const theirs = await as('sam', files.listFolder(folder.folderId))
  const file = theirs.files.find((f) => f.name === 'Birch contract.txt')
  expect(file).toBeDefined()
  const fileId = file?.id ?? ''

  // The download route, as each person's browser asks it.
  const download = async (who: Who, scopeCookie?: string) => {
    // The link names the folder the file is in, as the file browser's links do.
    const request = requestFrom(who, `/api/files/${fileId}?folder=${folder.folderId}`, scopeCookie)
    return (await fileHandlers.GET({ request, params: { id: fileId } })).status
  }

  expect(await download('sam')).toBe(302)

  // Without the folder it is in, a file can't be told to be within reach: nobody is given it.
  const bare = requestFrom('sam', `/api/files/${fileId}`)
  expect((await fileHandlers.GET({ request: bare, params: { id: fileId } })).status).toBe(404)

  // The record's own folder, asked for by the record or by the folder's id.
  await expect(as('nora', files.recordFolder('companies', ids.south.company))).rejects.toThrow()
  await expect(as('nora', files.listFolder(folder.folderId))).rejects.toThrow()

  // Browsing down from the top: "Companies" holds a folder per company.
  const top = await as('nora', files.listFolder(null))
  expect(southIn(top)).toEqual([])
  const parent = top.folders.find((f) => f.name === 'Companies')

  if (parent) {
    expect(southIn(await as('nora', files.listFolder(parent.id)))).toEqual([])
  }

  expect(southIn(await as('nora', files.searchFiles('contract')))).toEqual([])

  // By its id alone: not found, as a file that was never there, whatever the cookie says.
  expect(await download('nora')).toBe(404)
  expect(await download('nora', 'south')).toBe(404)
  await expect(as('nora', files.openFile(fileId))).rejects.toThrow()
  await expect(as('nora', files.openFile(fileId, folder.folderId))).rejects.toThrow()
  // Naming a folder she can reach doesn't help: the file isn't in it.
  await expect(as('nora', files.openFile(fileId, null))).rejects.toThrow()

  await expect(
    as('nora', files.changeFile(fileId, { name: 'Alder.txt' }, folder.folderId)),
  ).rejects.toThrow()

  await expect(as('nora', files.deleteFile(fileId, folder.folderId))).rejects.toThrow()
  await expect(as('nora', files.deleteFolder(folder.folderId))).rejects.toThrow()

  const kept = await as('sam', files.listFolder(folder.folderId))
  expect(column(kept.files, 'name')).toEqual(['Birch contract.txt'])
})

test('a grant that has run out, or was made with another key, is no grant', async () => {
  const stale = await sys(mintGrant(northOnly, { ttlMs: -1 }))
  expect(await sys(readGrant(stale))).toBeNull()
  expect((await call('search', { objectKey: 'contacts' }, stale)).ok).toBe(false)

  const good = await sys(mintGrant(northOnly))
  expect(await sys(readGrant(good))).toEqual(northOnly)
  // A grant never states the system's own access, whatever was put into it.
  expect((await sys(readGrant(good)))?.system).toBeUndefined()

  const key = process.env['APP_SECRET']
  process.env['APP_SECRET'] = 'another-key-'.repeat(4)

  try {
    expect(await sys(readGrant(good))).toBeNull()
  } finally {
    process.env['APP_SECRET'] = key
  }
})

test('a workflow started for a record is handed a grant for that record’s scope, and no more than its starter had', async () => {
  const inputs: Record<string, unknown>[] = []

  const engine = Layer.succeed(
    Agents,
    Agents.of({
      configured: Effect.succeed(true),
      executeWorkflow: (_name, input) =>
        Effect.sync(() => {
          inputs.push(input)
          return { skipped: false as const, executionId: 'run' }
        }),
      chat: Effect.succeed(null),
    }),
  )

  const nina = await record('contacts', ids.north.contact)
  const ctx = { objectKey: 'contacts', record: nina, actor: nora, trigger: 'action:enrich' }

  const granted = async (input: Record<string, unknown> | undefined) =>
    sys(readGrant(typeof input?.['grant'] === 'string' ? input['grant'] : null))

  try {
    await installWorld({ agents: engine })

    // The built-in `swirls:` target runs as a promise, off the caller's program: the access is carried to it.
    await as('nora', runTarget('swirls:enrich', ctx))

    expect(await granted(inputs.at(-1))).toEqual({
      read: ['north'],
      write: ['north'],
      active: 'north',
    })

    // Head office starts one on the same record: the grant is the record's scope, not every scope.
    await as('hana', runTarget('swirls:enrich', ctx), null)

    expect(await granted(inputs.at(-1))).toEqual({
      read: ['north'],
      write: ['north'],
      active: 'north',
    })

    // Whoever can't write can't have a workflow write for them.
    expect(await sys(readGrant(await as('ned', workflowGrant('contacts', nina))))).toEqual({
      read: ['north'],
      write: [],
      active: 'north',
    })

    // With nobody said, there is nothing to grant.
    expect(await unattended(workflowGrant('contacts', nina))).toBeNull()
  } finally {
    await installWorld()

    await sys(
      Store.use((store) =>
        store.remove(Activity, { where: { recordId: ids.north.contact, kind: 'workflow' } }),
      ),
    )
  }
})

// ── Routes that answer without a signed-in person ───────────────────────────

test('a public route reaches a shared object, and is refused a scoped one unless its code says it is the system', async () => {
  const count = (objectKey: string) => records.countMatching({ objectKey })

  const answer = (program: ReturnType<typeof count>) =>
    boundary.publicRoute('test.public', () => Effect.map(program, (n) => Response.json({ n })))

  const ask = async (route: ReturnType<typeof answer>) => {
    const response = await route({ request: new Request('http://crm.test/api/test/public') })
    return { status: response.status, body: await response.json() }
  }

  expect(await ask(answer(count('products')))).toEqual({ status: 200, body: { n: 1 } })

  // Work a signed-out route really means to do across every scope has to say so.
  expect(await ask(answer(asSystem(count('contacts'))))).toEqual({ status: 200, body: { n: 3 } })

  const refused = await ask(answer(count('contacts')))
  expect(refused.status).toBe(500)
  expect(refused.body.ok).toBe(false)
  expect(refused.body.n).toBeUndefined()
})

test('a script says it is the system, in plain promises, or is refused', async () => {
  const list = () => api.listRecords({ objectKey: 'contacts', limit: 500, relations: 'none' })
  await expect(list()).rejects.toThrow()
  expect(await api.asSystem(list)).toHaveLength(3)
  // Saying so lasts as long as the work it was said for.
  await expect(list()).rejects.toThrow()
})

test('a shared folder that holds another scope’s record folders can’t be renamed, moved or deleted from under them', async () => {
  const theirs = await as('sam', files.recordFolder('companies', ids.south.company))
  const mine = await as('nora', files.recordFolder('companies', ids.north.company))
  const top = await as('nora', files.listFolder(null))
  const shared = top.folders.find((f) => f.name === 'Companies')
  expect(shared).toBeDefined()
  const sharedId = shared?.id ?? ''

  // "Companies" is no record's own folder, but South's company folders are inside it.
  await expect(as('nora', files.deleteFolder(sharedId))).rejects.toThrow()
  await expect(as('nora', files.changeFolder(sharedId, { name: 'Gone' }))).rejects.toThrow()

  await expect(
    as('nora', files.changeFolder(sharedId, { parentId: mine.folderId })),
  ).rejects.toThrow()

  expect((await as('sam', files.listFolder(theirs.folderId))).record?.recordId).toBe(
    ids.south.company,
  )

  // Her own record's folder is hers to change, and head office may change the shared one.
  await as('nora', files.changeFolder(mine.folderId, { name: 'Alder Works' }))
  await as('hana', files.changeFolder(sharedId, { name: 'Companies' }), null)
})

test('two records of the same name in different scopes each get a folder of their own', async () => {
  const twin = async (branch: string) =>
    (await sys(records.createRecord('companies', { name: 'Cedar Twin', branch }, 'seed'))).id

  const north = await twin('north')
  const south = await twin('south')

  try {
    const hers = await as('nora', files.recordFolder('companies', north))
    const his = await as('sam', files.recordFolder('companies', south))
    expect(his.folderId).not.toBe(hers.folderId)
    expect(his.path).not.toBe(hers.path)
    // Each is still within its own people's reach.
    expect((await as('nora', files.listFolder(hers.folderId))).record?.recordId).toBe(north)
    expect((await as('sam', files.listFolder(his.folderId))).record?.recordId).toBe(south)
  } finally {
    await sys(records.deleteRecord('companies', north))
    await sys(records.deleteRecord('companies', south))
  }
})

test('the mailbox sync’s index of addresses holds only what its owner can reach', async () => {
  const index = await as('nora', buildContactIndex(), null)
  expect([...index.keys()].toSorted()).toEqual(['nell@alder.test', 'nina@alder.test'])
  expect([...(await as('sam', buildContactIndex(), null)).keys()]).toEqual(['sofia@birch.test'])
  // With nobody said it is refused: the sync runs each mailbox as its owner.
  await expect(unattended(buildContactIndex())).rejects.toThrow()
})

test('a deleted record’s folder stays its scope’s, and a new record of the same name doesn’t take it over', async () => {
  const south = (
    await sys(records.createRecord('companies', { name: 'Elm Gone', branch: 'south' }, 'seed'))
  ).id

  const kept = await as('sam', files.recordFolder('companies', south))
  await as('sam', service.deleteRecord('companies', south, sam))

  // The folder and its files stay in the file store. They are still South's.
  await expect(as('nora', files.listFolder(kept.folderId))).rejects.toThrow()
  await expect(as('otto', files.listFolder(kept.folderId))).rejects.toThrow()
  expect((await as('sam', files.listFolder(kept.folderId))).files).toEqual([])
  const top = await as('nora', files.listFolder(null))
  const shared = top.folders.find((f) => f.name === 'Companies')
  expect(southIn(await as('nora', files.listFolder(shared?.id ?? '')))).toEqual([])

  expect(JSON.stringify(await as('nora', files.listFolder(shared?.id ?? '')))).not.toContain(
    'Elm Gone',
  )

  // A North record of the same name gets a folder of its own.
  const north = (
    await sys(records.createRecord('companies', { name: 'Elm Gone', branch: 'north' }, 'seed'))
  ).id

  try {
    const fresh = await as('nora', files.recordFolder('companies', north))
    expect(fresh.folderId).not.toBe(kept.folderId)
  } finally {
    await sys(records.deleteRecord('companies', north))
  }
})

test('a read-only person opening a record’s files makes no folder, and changes none', async () => {
  const id = (
    await sys(records.createRecord('companies', { name: 'Fir Fresh', branch: 'north' }, 'seed'))
  ).id

  try {
    const before = drive.calls.length
    await expect(as('ned', files.recordFolder('companies', id))).rejects.toThrow('no folder yet')
    // Nothing was asked of the file store: no folder named after the record was left behind.
    expect(drive.calls.length).toBe(before)

    // Once someone who can change the record has made it, he is shown it.
    const made = await as('nora', files.recordFolder('companies', id))
    expect((await as('ned', files.recordFolder('companies', id))).folderId).toBe(made.folderId)

    // Whoever writes nothing changes no folder and no file: a shared one, the top level, or his own scope's.
    const refused = 'You can look at these files, but not change them.'
    await expect(as('ned', files.createFolder(null, 'Planted'))).rejects.toThrow(refused)
    await expect(as('otto', files.createFolder(null, 'Planted'))).rejects.toThrow(refused)
    await expect(as('ned', files.createFolder(made.folderId, 'Planted'))).rejects.toThrow(refused)

    await expect(as('ned', files.changeFolder(made.folderId, { name: 'Renamed' }))).rejects.toThrow(
      refused,
    )

    await expect(as('ned', files.deleteFolder(made.folderId))).rejects.toThrow(refused)

    await expect(
      as(
        'ned',
        files.startUpload(
          { folderId: null, name: 'a.txt', sizeBytes: 5, sha256: 'a'.repeat(64) },
          people.ned,
        ),
      ),
    ).rejects.toThrow(refused)

    expect(JSON.stringify(await as('nora', files.listFolder(null)))).not.toContain('Planted')
  } finally {
    await sys(records.deleteRecord('companies', id))
  }
})

test('whoever can write nothing changes nothing, a shared object’s records included', async () => {
  const product = () => sys(records.getRecord('products', ids.product))

  try {
    for (const who of ['ned', 'otto'] as const) {
      const person = people[who]

      await expect(
        as(who, service.createRecord('products', { name: 'Planted' }, person)),
      ).rejects.toThrow()

      await expect(
        as(who, records.createRecord('products', { name: 'Planted' }, person.id)),
      ).rejects.toThrow()

      await expect(
        as(who, service.updateRecord('products', ids.product, { sku: 'CHANGED' }, person)),
      ).rejects.toThrow()

      await expect(as(who, service.deleteRecord('products', ids.product, person))).rejects.toThrow()
    }

    expect((await product())?.sku).toBe('CR-1')
    expect(await sys(records.listRecords({ objectKey: 'products', q: 'Planted' }))).toEqual([])

    // Reading a shared object is what "shared" means: both still can.
    expect(
      column(await as('otto', records.listRecords({ objectKey: 'products' })), 'name'),
    ).toEqual(['Crate'])

    // And a person who writes somewhere may change a shared record.
    const changed = await as(
      'nora',
      service.updateRecord('products', ids.product, { sku: 'CR-2' }, nora),
    )

    expect(changed?.sku).toBe('CR-2')
  } finally {
    await sweep('products', 'Planted')
    await sys(records.updateRecord('products', ids.product, { sku: 'CR-1' }))
  }
})
