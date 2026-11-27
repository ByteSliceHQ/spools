import { expect, test } from 'bun:test'

import { Effect, Layer } from 'effect'

import { toolsHandlers } from '../../src/api/tools'
import type { ScopeAccess } from '../../src/crm/scopes'
import { runTarget } from '../../src/server/actions'
import * as records from '../../src/server/records'
import { Agents } from '../../src/server/runtime/agents'
import { Auth } from '../../src/server/runtime/auth'
import { GRANT_HEADER, grantFor, mintGrant, openGrant, withGrant } from '../../src/server/scopes'
import { spool } from '../../src/server/spool'
import { Store } from '../../src/server/store/store'
import { Activity, Note } from '../../src/server/store/tables'
import {
  as,
  ids,
  installWorld,
  northIn,
  people,
  scopedWorld,
  southIn,
  sys,
  TOOL_TOKEN,
  unattended,
} from './scopes-world'

// The signed grant a call to the tool API carries: who it stands for, which
// record it is for, and how long it lasts.

scopedWorld()

const { nora } = people

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

const northOnly: ScopeAccess = { read: ['north'], write: ['north'], active: 'north' }

const nina = async () => {
  const found = await sys(records.getRecord('contacts', ids.north.contact))

  if (!found) {
    throw new Error('The world has no Nina')
  }

  return found
}

/** How long a grant has left, in minutes, as it says itself. */
const minutesLeft = async (grant: string | null) => {
  const [payload = ''] = (grant ?? '').split('.')
  const said: { e?: number } = JSON.parse(Buffer.from(payload, 'base64url').toString())
  return Math.round(((said.e ?? 0) - Date.now()) / 60_000)
}

test('a grant made for a person is no grant once that person is off the access list', async () => {
  const grant = await sys(mintGrant(northOnly, { userId: nora.id }))
  const search = () => call('search', { objectKey: 'contacts' }, grant)
  expect((await search()).ok).toBe(true)

  // A grant made for someone the directory has never heard of.
  expect(
    (
      await call(
        'search',
        { objectKey: 'contacts' },
        await sys(mintGrant(northOnly, { userId: 'user_never' })),
      )
    ).ok,
  ).toBe(false)

  const everyoneElse = Object.values(people)
    .filter((person) => person.id !== nora.id)
    .map((person) => ({ ...person, accounts: [] }))

  try {
    // Nora leaves: the sign-in provider no longer has her.
    await installWorld({ auth: Auth.layerTest(everyoneElse) })
    const gone = await search()
    expect(gone.ok).toBe(false)
    expect(northIn(gone)).toEqual([])

    // Or she is still there, and off the access list: her address is no longer one the config allows.
    await installWorld({
      auth: Auth.layerTest([
        ...everyoneElse,
        { ...nora, email: 'nora@elsewhere.test', accounts: [] },
      ]),
    })

    const refused = await search()
    expect(refused.ok).toBe(false)
    expect(northIn(refused)).toEqual([])

    // A grant made for nobody in particular (the server's own work) still stands.
    expect(
      (await call('search', { objectKey: 'contacts' }, await sys(mintGrant(northOnly)))).ok,
    ).toBe(true)
  } finally {
    await installWorld()
  }
})

test('a grant made for one record reaches that record, and no other of its scope', async () => {
  const record = await nina()
  const grant = (await as('nora', grantFor('contacts', record, { trigger: 'action:enrich' }))) ?? ''

  expect(await sys(openGrant(grant))).toEqual({
    access: northOnly,
    userId: nora.id,
    record: { objectKey: 'contacts', recordId: record.id },
    trigger: 'action:enrich',
  })

  const mine = { objectKey: 'contacts', id: record.id }
  // Nell is a North contact too: the same scope, another record.
  const other = { objectKey: 'contacts', id: ids.north.cross }

  try {
    expect((await call('get', mine, grant)).ok).toBe(true)
    expect((await call('add_note', { ...mine, body: 'Bound note' }, grant)).ok).toBe(true)
    expect((await call('update', { ...mine, values: { status: 'lead' } }, grant)).ok).toBe(true)
    // What the objects are is the config, not a record.
    expect((await call('describe', {}, grant)).ok).toBe(true)

    for (const answer of [
      await call('get', other, grant),
      await call('add_note', { ...other, body: 'Planted note' }, grant),
      await call('update', { ...other, values: { status: 'customer' } }, grant),
      await call('get', { objectKey: 'companies', id: ids.north.company }, grant),
      await call('get', { objectKey: 'companies', id: record.id }, grant),
      // Tools that reach the rest of the scope.
      await call('search', { objectKey: 'contacts' }, grant),
      await call('create', { objectKey: 'contacts', values: { name: 'Alder bound' } }, grant),
    ]) {
      expect(answer.ok).toBe(false)
      expect(answer.error).toContain('one record')
      expect(northIn(answer)).toEqual([])
      expect(southIn(answer)).toEqual([])
    }

    const nell = await sys(records.getRecord('contacts', ids.north.cross))
    expect(nell?.status).toBe('lead')
    expect(await sys(records.listRecords({ objectKey: 'contacts', q: 'bound' }))).toEqual([])

    expect(
      await sys(Store.use((store) => store.count(Note, { where: { recordId: ids.north.cross } }))),
    ).toBe(0)
  } finally {
    const here = { objectKey: 'contacts', recordId: record.id }

    await sys(Store.use((store) => store.remove(Note, { where: { ...here, body: 'Bound note' } })))
    await sys(Store.use((store) => store.remove(Activity, { where: { ...here, kind: 'agent' } })))
  }
})

test('a grant lasts a quarter of an hour unless the config says, and a workflow’s is the person’s who started it', async () => {
  expect(await minutesLeft(await sys(mintGrant(northOnly)))).toBe(15)

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

  const record = await nina()
  const { scopes } = spool().config

  try {
    await installWorld({ agents: engine })

    await as(
      'nora',
      runTarget('swirls:enrich', {
        objectKey: 'contacts',
        record,
        actor: nora,
        trigger: 'action:enrich',
      }),
    )

    const first = inputs.at(-1)?.['grant']
    const grant = typeof first === 'string' ? first : null
    expect(await minutesLeft(grant)).toBe(15)

    expect(await sys(openGrant(grant))).toEqual({
      access: northOnly,
      userId: nora.id,
      record: { objectKey: 'contacts', recordId: record.id },
      trigger: 'action:enrich',
    })

    // Work done under her grant (a tool call that starts another workflow) hands on a grant that
    // is still hers, whoever the change is put down to: it stops when she leaves, as the first does.
    const opened = await sys(openGrant(grant))

    const handedOn = opened
      ? await unattended(
          withGrant(opened)(grantFor('contacts', record, { trigger: 'contacts.updated' })),
        )
      : null

    expect((await sys(openGrant(handedOn)))?.userId).toBe(nora.id)

    if (scopes) {
      scopes.grantMinutes = 90
    }

    expect(await minutesLeft(await sys(mintGrant(northOnly)))).toBe(90)
    expect(await minutesLeft(await sys(mintGrant(northOnly, { ttlMs: 60_000 })))).toBe(1)
  } finally {
    if (scopes) {
      scopes.grantMinutes = 15
    }

    await installWorld()

    await sys(
      Store.use((store) =>
        store.remove(Activity, { where: { recordId: ids.north.contact, kind: 'workflow' } }),
      ),
    )
  }
})
