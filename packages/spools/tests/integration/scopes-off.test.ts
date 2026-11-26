import { afterAll, beforeAll, expect } from 'bun:test'

import { toolsHandlers } from '../../src/api/tools'
import { NO_ACCESS } from '../../src/crm/scopes'
import * as records from '../../src/server/records'
import { asUser, Scopes, scopeSession, scopesOn, withAccess } from '../../src/server/scopes'
import * as search from '../../src/server/search'
import * as service from '../../src/server/service'
import { crmConfig } from '../../src/server/spool'
import { Users } from '../../src/server/users'
import * as workspace from '../../src/server/workspace'
import { installLiveServices, installStandIns, run } from '../../src/testing/run'
import { exampleTest, isExampleApp } from './example-app'

// A Spool without `scopes` in its config is as it always was: every allowed
// user reads and writes every record, whatever a resolver says and whatever
// access a program is given. These hold today and must go on holding once
// scopes are enforced. They run on the Spool the other integration tests use.

const tag = `off${Date.now()}`
const TOKEN = 't'.repeat(40)
const someone = { id: `user_${tag}`, email: `someone.${tag}@example.com`, name: 'Someone' }
const made: { objectKey: string; id: string }[] = []
let savedToken: string | undefined

beforeAll(async () => {
  savedToken = process.env['SWIRLS_APP_TOKEN']
  process.env['SWIRLS_APP_TOKEN'] = TOKEN
  // A resolver that says this person holds nothing. Without `scopes` in the config it is never asked.
  await installStandIns({ scopes: Scopes.layerTest({ [someone.id]: [] }) })
})

afterAll(async () => {
  if (isExampleApp) {
    for (const r of made.reverse()) {
      await run(records.deleteRecord(r.objectKey, r.id))
    }
  }

  if (savedToken === undefined) {
    delete process.env['SWIRLS_APP_TOKEN']
  } else {
    process.env['SWIRLS_APP_TOKEN'] = savedToken
  }

  await installLiveServices()
})

exampleTest('the starter has no scopes', () => {
  expect(crmConfig().scopes).toBeUndefined()
  expect(scopesOn()).toBe(false)
})

exampleTest(
  'unscoped: records are made, listed, counted, changed and deleted as before',
  async () => {
    // Nobody said anything about access: a script, a cron job, a test.
    const company = await run(service.createRecord('companies', { name: `Acme ${tag}` }, someone))
    made.push({ objectKey: 'companies', id: company.id })

    // As a person who holds no scope, and with an access that reaches nothing.
    const asNobody = asUser(someone)
    const reachesNothing = withAccess(NO_ACCESS)
    const list = records.listRecords({ objectKey: 'companies', q: tag })

    for (const rows of [
      await run(list),
      await run(asNobody(list)),
      await run(reachesNothing(list)),
    ]) {
      expect(rows.map((r) => r.id)).toEqual([company.id])
    }

    expect(
      await run(reachesNothing(records.countMatching({ objectKey: 'companies', q: tag }))),
    ).toBe(1)

    const contact = await run(
      reachesNothing(
        service.createRecord('contacts', { name: `Ada ${tag}`, companyId: company.id }, someone),
      ),
    )

    made.push({ objectKey: 'contacts', id: contact.id })

    const changed = await run(
      reachesNothing(
        service.updateRecord('contacts', contact.id, { status: 'qualified' }, someone),
      ),
    )

    expect(changed?.status).toBe('qualified')
    // The related record comes back with the row.
    expect(records.relatedField(changed?.company, 'name')).toBe(`Acme ${tag}`)

    expect(await run(reachesNothing(service.deleteRecord('contacts', contact.id, someone)))).toBe(
      true,
    )

    made.pop()
    expect(await run(records.getRecord('contacts', contact.id))).toBeNull()
  },
)

exampleTest('unscoped: what sits beside records, search and the team are as before', async () => {
  const reachesNothing = withAccess(NO_ACCESS)
  const company = await run(service.createRecord('companies', { name: `Beside ${tag}` }, someone))
  made.push({ objectKey: 'companies', id: company.id })
  const on = { objectKey: 'companies', recordId: company.id }

  const task = await run(
    reachesNothing(workspace.createTask({ title: `Task ${tag}`, ...on }, someone.id)),
  )

  const note = await run(
    reachesNothing(workspace.createNote({ title: `Note ${tag}`, body: 'text', ...on }, someone)),
  )

  expect((await run(reachesNothing(workspace.listTasks(on)))).map((t) => t.id)).toEqual([task.id])
  expect((await run(reachesNothing(workspace.listNotes(on)))).map((n) => n.id)).toEqual([note.id])
  expect(await run(reachesNothing(records.listActivities('companies', company.id)))).not.toEqual([])

  const index = await run(reachesNothing(search.quickIndex(undefined, someone.id)))
  expect(index.objects['companies']?.rows.some((r) => r[0] === company.id)).toBe(true)
  // An index of a Spool without scopes is not stamped with one.
  expect(index.scope).toBeUndefined()

  const hits = await run(reachesNothing(search.deepSearch(`Beside ${tag}`)))
  expect(hits.map((h) => h.id)).toContain(company.id)

  // Everyone on the access list, whoever is asking.
  const everyone = await run(Users.use((users) => users.team))
  expect(await run(reachesNothing(Users.use((users) => users.team)))).toEqual(everyone)

  // There is nothing to switch between.
  expect(await run(scopeSession(someone))).toBeNull()

  await run(workspace.deleteTask(task.id))
  await run(workspace.deleteNote(note.id))
})

exampleTest('unscoped: the tool API needs its bearer token and no grant', async () => {
  const company = await run(service.createRecord('companies', { name: `Tool ${tag}` }, someone))
  made.push({ objectKey: 'companies', id: company.id })

  const request = new Request('http://crm.test/api/swirls/tools/search', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ objectKey: 'companies', query: `Tool ${tag}` }),
  })

  const answer = await (await toolsHandlers.POST({ request, params: { tool: 'search' } })).json()
  expect(answer.ok).toBe(true)
  expect(answer.data.map((r: { id: string }) => r.id)).toEqual([company.id])
})
