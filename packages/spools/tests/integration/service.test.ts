import { afterAll, beforeAll, expect } from 'bun:test'

import { runTarget, validateRunTargets } from '../../src/server/actions'
import * as records from '../../src/server/records'
import { Email } from '../../src/server/runtime/email'
import { Invalid } from '../../src/server/runtime/errors'
import * as service from '../../src/server/service'
import { installLiveServices, installStandIns, run } from '../support/run'
import { exampleTest, isExampleApp } from './example-app'

// Integration test against a Postgres with the schema pushed (`bun run db:push`).
const tag = `svc${Date.now()}`
const user = { id: 'user_test', email: 'tester@example.com', name: 'Test User' }
const ids: string[] = []
let sent = 0

beforeAll(async () => {
  process.env['APP_SECRET'] = 's'.repeat(40)
  // A sequence email needs somewhere for its unsubscribe link to lead.
  process.env['APP_URL'] = 'https://crm.example.com'

  await installStandIns({
    email: Email.layerTest(async () => {
      sent++
      return { id: null, sent: true }
    }),
  })
})

afterAll(async () => {
  await installLiveServices()

  if (!isExampleApp) {
    return
  }

  for (const id of ids) {
    await run(records.deleteRecord('contacts', id))
  }
})

exampleTest("the shipped config's run targets all resolve", () => {
  expect(validateRunTargets()).toEqual([])
})

exampleTest('unknown run-target kinds and handlers fail with a clear message', async () => {
  const record = await run(service.createRecord('contacts', { name: `Kind ${tag}` }, user))
  ids.push(record.id)
  const ctx = { objectKey: 'contacts', record, actor: user, trigger: 'test' }

  await expect(run(runTarget('carrierPigeon:coo', ctx))).rejects.toThrow(
    'Unknown run target kind "carrierPigeon"',
  )

  await expect(run(runTarget('local:missing', ctx))).rejects.toThrow('No handler "missing"')
  expect((await run(runTarget('local:logTouch', ctx))).message).toBe('Logged')
})

exampleTest(
  'create runs the beforeCreate hook, writes the timeline and records the actor',
  async () => {
    const record = await run(
      service.createRecord(
        'contacts',
        { name: `Hook ${tag}`, email: `MiXed.${tag}@Example.COM` },
        user,
      ),
    )

    ids.push(record.id)
    expect(record.email).toBe(`mixed.${tag}@example.com`) // lower-cased by src/app/extensions.ts
    expect(record.createdBy).toBe(user.id)

    const summaries = (await run(records.listActivities('contacts', record.id))).map(
      (a) => a.summary,
    )

    expect(summaries).toContain('created this contact')

    const created = (await run(records.listActivities('contacts', record.id))).find(
      (a) => a.summary === 'created this contact',
    )

    expect(created?.actor).toBe('Test User')
  },
)

exampleTest('a public (null actor) create is attributed to the website', async () => {
  const record = await run(
    service.createRecord('contacts', { name: `Public ${tag}` }, null, {
      summary: 'Submitted the website contact form',
    }),
  )

  ids.push(record.id)
  expect(record.createdBy).toBe('website')
  const summaries = (await run(records.listActivities('contacts', record.id))).map((a) => a.summary)
  expect(summaries).toContain('Submitted the website contact form')
})

exampleTest('update and delete report missing records instead of throwing', async () => {
  const missing = '00000000-0000-4000-8000-000000000000'
  expect(await run(service.updateRecord('contacts', missing, { status: 'lead' }, user))).toBeNull()
  expect(await run(service.deleteRecord('contacts', missing, user))).toBe(false)
})

exampleTest('invalid values fail with a readable message', async () => {
  const attempt = run(service.createRecord('contacts', { name: '', email: 'nope' }, user))
  await expect(attempt).rejects.toBeInstanceOf(Invalid)
  await expect(attempt).rejects.toThrow('name: Required')
})

exampleTest('an import reports a bad row by its line and still creates the rest', async () => {
  const missing = '00000000-0000-4000-8000-000000000000'

  const result = await run(
    service.importRecords(
      'contacts',
      [
        { name: `Import one ${tag}` },
        { name: `Import two ${tag}`, companyId: missing },
        { name: `Import three ${tag}`, email: 'not an address' },
        { name: `Import four ${tag}` },
      ],
      user,
    ),
  )

  const made = await run(records.listRecords({ objectKey: 'contacts', q: `Import ${tag}` }))
  ids.push(...made.map((r) => r.id))

  expect(result.created).toBe(2)
  expect(result.failed).toBe(2)
  expect(result.errors.map((e) => e.row)).toEqual([3, 4])

  expect(made.map((r) => r['name']).toSorted()).toEqual([`Import four ${tag}`, `Import one ${tag}`])
})

exampleTest('enrolling the same record in a campaign twice starts one run', async () => {
  const record = await run(
    service.createRecord(
      'contacts',
      { name: `Drip ${tag}`, email: `drip.${tag}@example.com` },
      user,
    ),
  )

  ids.push(record.id)
  const ctx = { objectKey: 'contacts', record, actor: user, trigger: 'action:startOnboarding' }

  const first = await run(runTarget('campaign:onboarding', ctx))
  const second = await run(runTarget('campaign:onboarding', ctx))
  expect(first.message).toContain('Enrolled')
  expect(second.message).toContain('Already enrolled')

  await Bun.sleep(300)
  expect(sent).toBe(1) // the first step (wait 0m) sent once, not twice

  const enrolled = (await run(records.listActivities('contacts', record.id))).filter((a) =>
    a.summary.startsWith('enrolled this record'),
  )

  expect(enrolled.length).toBe(1)
})

exampleTest('updates are logged to the timeline, one sentence per changed field', async () => {
  const company = await run(
    records.createRecord('companies', { name: `Log co ${tag}` }, 'user_test'),
  )

  const contact = await run(
    service.createRecord('contacts', { name: `Log ${tag}`, email: `log.${tag}@example.com` }, user),
  )

  ids.push(contact.id)

  await run(
    service.updateRecord(
      'contacts',
      contact.id,
      { status: 'qualified', companyId: company.id },
      user,
    ),
  )

  await run(service.updateRecord('contacts', contact.id, { email: `new.${tag}@example.com` }, user))
  await run(service.updateRecord('contacts', contact.id, { status: 'qualified' }, user)) // no change: nothing logged

  // One timeline entry per changed field, written as a sentence after the actor's name.
  const changes = (await run(records.listActivities('contacts', contact.id))).filter(
    (a) => a.kind === 'change',
  )

  const summaries = changes.map((c) => c.summary)

  expect(summaries.sort()).toEqual([
    `changed Company to Log co ${tag}`,
    'changed Status to Qualified',
    'updated Email',
  ])

  expect(changes.every((c) => c.actor === 'Test User')).toBe(true)
  // Encrypted fields are logged without their values.
  expect(summaries.join('\n')).not.toContain(`new.${tag}@example.com`)

  await run(service.updateRecord('contacts', contact.id, { companyId: null }, user))
  const after = (await run(records.listActivities('contacts', contact.id))).map((a) => a.summary)
  expect(after).toContain('cleared Company')

  await run(records.deleteRecord('contacts', contact.id))
  ids.splice(ids.indexOf(contact.id), 1)
  await run(records.deleteRecord('companies', company.id))
})
