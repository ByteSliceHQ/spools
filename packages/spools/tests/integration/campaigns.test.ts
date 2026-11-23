import { afterAll, beforeAll, expect } from 'bun:test'

import { crmConfigSchema } from '../../src/crm/config-schema'
import { withinHours } from '../../src/crm/sequences'
import { activeRuns, enroll, tick } from '../../src/server/campaigns'
import { type OutboundEmail, suppress } from '../../src/server/email'
import {
  createRecord,
  deleteRecord,
  getRecord,
  listActivities,
  updateRecord,
} from '../../src/server/records'
import { Email } from '../../src/server/runtime/email'
import { type SequenceSource, Sequences } from '../../src/server/sequences'
import { crmConfig } from '../../src/server/spool'
import { SequenceRun } from '../../src/server/store/tables'
import { db, run as go, installLiveServices, installStandIns } from '../support/run'
import { exampleTest, isExampleApp } from './example-app'

// Email sequences against the local Supabase database (`bun run db:start`), with
// a fake email transport. Time is moved by handing `tick` a later `now`.

const tag = `seq${Date.now()}`
const sent: OutboundEmail[] = []
const ids: string[] = []
let failing = 0

const baseConfig = await Bun.file(
  new URL('../fixtures/example.config.json', import.meta.url),
).json()

const campaigns = crmConfigSchema.parse({
  ...baseConfig,
  campaigns: {
    ...baseConfig.campaigns,
    // Two emails with no wait.
    quick: {
      label: 'Test drip',
      object: 'contacts',
      emailField: 'email',
      stopWhen: { status: ['customer'] },
      steps: [
        { id: 'one', wait: '0m', subject: 'Hello {{name}}', body: 'First {{name}}' },
        { id: 'two', wait: '0m', subject: 'Again', body: 'Second' },
      ],
    },
    // One now, one two days later, one a day after that.
    slow: {
      label: 'Slow drip',
      object: 'contacts',
      emailField: 'email',
      stopWhen: { status: ['customer'] },
      steps: [
        { id: 'first', wait: '0m', subject: 'One', body: '1' },
        { id: 'second', wait: '2d', subject: 'Two', body: '2' },
        { id: 'third', wait: '1d', subject: 'Three', body: '3' },
      ],
    },
  },
}).campaigns

// The config's own sequences stay, so a run of one that falls due is not taken for removed.
const all = { ...crmConfig().campaigns, ...campaigns }

const DAY = 86_400_000
const later = (ms: number) => new Date(Date.now() + ms)

const runOf = (campaignKey: string, recordId: string) =>
  db.first(SequenceRun, { where: { campaignKey, objectKey: 'contacts', recordId } })

const to = (address: string) => sent.filter((e) => e.to === address)
const staff = { id: 'user_test', email: 'tester@example.com', name: 'Tester' }

/** The sequences these tests run; a test that changes them puts them back. */
const base = () => ({ campaigns: all, hours: undefined, zone: 'UTC' })
let sequences: Partial<SequenceSource> = base()

const setSequenceSource = (next?: Partial<SequenceSource>) => {
  sequences = next ?? base()
}

async function contact(name: string, extra: Record<string, unknown> = {}) {
  const email = `${name.toLowerCase()}.${tag}@example.com`

  const record = await go(
    createRecord('contacts', { name: `${name} ${tag}`, email, ...extra }, 'test'),
  )

  ids.push(record.id)
  return { record, email }
}

beforeAll(async () => {
  process.env['APP_SECRET'] = 's'.repeat(40)

  await installStandIns({
    sequences: Sequences.layerTest(() => sequences),
    email: Email.layerTest(async (e) => {
      if (failing > 0) {
        failing--
        throw new Error('provider is down')
      }

      sent.push(e)
      return { id: `fake_${sent.length}`, sent: true }
    }),
  })
})

afterAll(async () => {
  await installLiveServices()

  if (!isExampleApp) {
    return
  }

  for (const id of ids) {
    await db.remove(SequenceRun, { where: { objectKey: 'contacts', recordId: id } })
    await go(deleteRecord('contacts', id))
  }
})

exampleTest('sends every step with rendered content, unsubscribe link and headers', async () => {
  const { record, email } = await contact('Ada')
  const result = await go(enroll('quick', 'contacts', record, staff))
  expect(result.message).toBe('Enrolled in Test drip')
  // The first email has no wait, so it went with the enrolment; the tick sends the one behind it.
  expect(to(email).map((e) => e.subject)).toEqual([`Hello Ada ${tag}`])
  await go(tick())

  const mine = to(email)
  expect(mine.map((e) => e.subject)).toEqual([`Hello Ada ${tag}`, 'Again'])
  expect(mine[0]!.text).toContain(`First Ada ${tag}`)
  expect(mine[0]!.text).toContain('/unsubscribe?t=')
  expect(mine[0]!.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')

  const acts = await go(listActivities('contacts', record.id))
  expect(acts.filter((a) => a.kind === 'email').length).toBe(2)
  expect(acts.map((a) => a.summary)).toContain('enrolled this record in Test drip (2 emails)')

  expect(await runOf('quick', record.id)).toMatchObject({
    status: 'finished',
    nextStep: null,
    dueAt: null,
  })
})

exampleTest('a record is enrolled in a sequence once, for good', async () => {
  const { record, email } = await contact('Once')

  const [a, b] = await Promise.all([
    go(enroll('quick', 'contacts', record, staff)),
    go(enroll('quick', 'contacts', record, staff)),
  ])

  expect([a.message, b.message].sort()).toEqual([
    'Already enrolled in Test drip',
    'Enrolled in Test drip',
  ])

  expect(a.runId).toBe(b.runId)
  await go(tick())

  // Finished, and still not enrolled again.
  expect((await go(enroll('quick', 'contacts', record, staff))).message).toBe(
    'Already enrolled in Test drip',
  )

  expect(to(email).length).toBe(2)
})

exampleTest('each email waits its turn, and nothing is sent early', async () => {
  const { record, email } = await contact('Wait')
  await go(enroll('slow', 'contacts', record, staff))
  expect(to(email).map((e) => e.subject)).toEqual(['One'])

  await go(tick())
  await go(tick({ now: later(2 * DAY - 60_000) }))
  expect(to(email).map((e) => e.subject)).toEqual(['One'])

  await go(tick({ now: later(2 * DAY + 60_000) }))
  expect(to(email).map((e) => e.subject)).toEqual(['One', 'Two'])
  // The third is counted from when the second went out, not from the enrolment.
  const run = await runOf('slow', record.id)
  expect(run?.nextStep).toBe('third')
  expect(run!.dueAt!.getTime()).toBeGreaterThan(Date.now() + 3 * DAY)

  await go(tick({ now: later(2 * DAY + 120_000) }))
  expect(to(email).length).toBe(2)
  await go(tick({ now: later(3 * DAY + 180_000) }))
  expect(to(email).map((e) => e.subject)).toEqual(['One', 'Two', 'Three'])
  expect((await runOf('slow', record.id))?.status).toBe('finished')
})

exampleTest('two ticks at once send an email once', async () => {
  const people = await Promise.all(['Twin', 'Pair', 'Both'].map((n) => contact(n)))

  for (const p of people) {
    await go(enroll('slow', 'contacts', p.record, staff))
  }

  const now = later(2 * DAY + 60_000)
  await Promise.all([go(tick({ now })), go(tick({ now })), go(tick({ now }))])

  for (const p of people) {
    expect(to(p.email).map((e) => e.subject)).toEqual(['One', 'Two'])
  }
})

exampleTest(
  'a stop condition ends the run; a missing or suppressed address skips one email',
  async () => {
    const customer = await contact('Cust')
    const unsub = await contact('Unsub')
    const noAddress = await go(createRecord('contacts', { name: `Blank ${tag}` }, 'test'))
    ids.push(noAddress.id)
    await go(updateRecord('contacts', customer.record.id, { status: 'customer' }))
    await go(suppress(`UNSUB.${tag}@example.com`, 'unsubscribed'))

    await go(
      enroll('quick', 'contacts', (await go(getRecord('contacts', customer.record.id)))!, staff),
    )

    await go(enroll('quick', 'contacts', unsub.record, staff))
    await go(enroll('quick', 'contacts', noAddress, staff))
    await go(tick())

    expect(sent.some((e) => e.to === customer.email || e.to === unsub.email)).toBe(false)
    // Stopped once, with the reason, instead of skipping every email in turn.
    const stopped = (await go(listActivities('contacts', customer.record.id))).map((a) => a.summary)
    expect(stopped).toContain('stopped Test drip before "one" (status is customer)')
    expect(stopped.filter((s) => s.includes('skipped')).length).toBe(0)

    expect(await runOf('quick', customer.record.id)).toMatchObject({
      status: 'stopped',
      note: 'status is customer',
    })

    // Each email is skipped on its own: the address could be allowed again before the next one.
    const skipped = (await go(listActivities('contacts', unsub.record.id))).filter((a) =>
      a.summary.includes('skipped'),
    )

    expect(skipped.map((a) => a.summary).sort()).toEqual([
      'skipped "one" of Test drip (address is suppressed)',
      'skipped "two" of Test drip (address is suppressed)',
    ])

    const blank = (await go(listActivities('contacts', noAddress.id))).map((a) => a.summary)
    expect(blank).toContain('skipped "one" of Test drip (no email address)')
    expect((await runOf('quick', unsub.record.id))?.status).toBe('finished')
  },
)

exampleTest('a stop condition met part-way stops the emails still to come', async () => {
  const { record, email } = await contact('Midway')
  await go(enroll('slow', 'contacts', record, staff))
  await go(updateRecord('contacts', record.id, { status: 'customer' }))
  await go(tick({ now: later(5 * DAY) }))
  expect(to(email).map((e) => e.subject)).toEqual(['One'])
  expect((await runOf('slow', record.id))?.status).toBe('stopped')
})

exampleTest('a deleted record ends its run quietly', async () => {
  const { record, email } = await contact('Gone')
  await go(enroll('slow', 'contacts', record, staff))
  await go(deleteRecord('contacts', record.id))
  await go(tick({ now: later(5 * DAY) }))
  expect(to(email).length).toBe(1)

  expect(await runOf('slow', record.id)).toMatchObject({
    status: 'stopped',
    note: 'record deleted',
  })
})

exampleTest(
  'a failed send is tried again later with the same key, so the provider can drop a repeat',
  async () => {
    const { record, email } = await contact('Retry')
    failing = 1

    // The enrolment stands even though its first email could not be sent, and says so.
    expect((await go(enroll('quick', 'contacts', record, staff))).message).toBe(
      'Enrolled in Test drip, but the first email could not be sent. It will be tried again in a few minutes.',
    )

    expect(to(email).length).toBe(0)

    expect(await runOf('quick', record.id)).toMatchObject({
      status: 'active',
      nextStep: 'one',
      attempts: 1,
    })

    expect((await runOf('quick', record.id))?.note).toContain('provider is down')

    // Held for a few minutes, so a tick straight after leaves it alone.
    await go(tick())
    expect(to(email).length).toBe(0)
    await go(tick({ now: later(11 * 60_000) }))
    const mine = to(email)
    expect(mine.map((e) => e.subject)).toEqual([`Hello Retry ${tag}`, 'Again'])
    const run = await runOf('quick', record.id)
    expect(mine[0]!.idempotencyKey).toBe(`sequence-${run!.id}-one`)
    expect(mine[1]!.idempotencyKey).toBe(`sequence-${run!.id}-two`)
    expect(run).toMatchObject({ status: 'finished', attempts: 0, note: null })
  },
)

exampleTest('a send that keeps failing stops the run and says so on the record', async () => {
  const { record, email } = await contact('Dead')
  failing = 99

  try {
    await go(enroll('quick', 'contacts', record, staff))

    for (let i = 1; i <= 6; i++) {
      await go(tick({ now: later(i * 11 * 60_000) }))
    }
  } finally {
    failing = 0
  }

  expect(to(email).length).toBe(0)
  const run = await runOf('quick', record.id)
  expect(run?.status).toBe('stopped')
  expect(run?.note).toContain('gave up after 5 tries: provider is down')
  const timeline = (await go(listActivities('contacts', record.id))).map((a) => a.summary)
  expect(timeline).toContain('stopped Test drip: an email could not be sent after 5 tries')
  // And it stays stopped.
  await go(tick({ now: later(DAY) }))
  expect(to(email).length).toBe(0)
})

exampleTest(
  'with sending hours, a waited-for email is held to them; one with no wait is not',
  async () => {
    const hours = { from: '08:00', to: '18:00', weekdaysOnly: true }
    setSequenceSource({ campaigns: all, hours, zone: 'America/New_York' })

    try {
      const { record, email } = await contact('Hours')
      await go(enroll('slow', 'contacts', record, staff))
      // Sent at once, whatever the time is while this test runs.
      expect(to(email).map((e) => e.subject)).toEqual(['One'])
      const due = (await runOf('slow', record.id))!.dueAt!
      expect(due.getTime()).toBeGreaterThanOrEqual(Date.now() + 2 * DAY - 5000)
      expect(due.getTime()).toBeLessThan(Date.now() + 5 * DAY)
      expect(withinHours(due, hours, 'America/New_York')).toBe(true)
    } finally {
      setSequenceSource({ campaigns: all, hours: undefined, zone: 'UTC' })
    }
  },
)

exampleTest('a run whose step or sequence was taken out of the config stops', async () => {
  const stepGone = await contact('StepGone')
  const allGone = await contact('AllGone')
  await go(enroll('slow', 'contacts', stepGone.record, staff))
  await go(enroll('slow', 'contacts', allGone.record, staff))
  const slow = all['slow']!

  setSequenceSource({
    campaigns: { ...all, slow: { ...slow, steps: slow.steps.filter((s) => s.id !== 'second') } },
  })

  try {
    await db.update(
      SequenceRun,
      { where: { recordId: allGone.record.id } },
      { campaignKey: 'retired' },
    )

    await go(tick({ now: later(3 * DAY) }))
  } finally {
    setSequenceSource({ campaigns: all, hours: undefined, zone: 'UTC' })
  }

  expect(await runOf('slow', stepGone.record.id)).toMatchObject({
    status: 'stopped',
    note: 'step "second" was removed',
  })

  expect(await runOf('retired', allGone.record.id)).toMatchObject({
    status: 'stopped',
    note: 'sequence was removed',
  })

  expect(to(stepGone.email).length + to(allGone.email).length).toBe(2)
})

exampleTest('a tick that runs out of time says so and leaves the rest for the next', async () => {
  const { record, email } = await contact('Budget')
  await go(enroll('slow', 'contacts', record, staff))
  const now = later(2 * DAY + 60_000)
  const first = await go(tick({ now, budgetMs: -1 }))
  expect(first.more).toBe(true)
  expect(to(email).length).toBe(1)
  const second = await go(tick({ now }))
  expect(second.more).toBe(false)
  expect(to(email).map((e) => e.subject)).toEqual(['One', 'Two'])
})

exampleTest(
  'the Workflows page can say how many records are part-way through each sequence',
  async () => {
    const { record } = await contact('Count')
    const before = (await go(activeRuns()))['slow'] ?? 0
    await go(enroll('slow', 'contacts', record, staff))
    expect((await go(activeRuns()))['slow']).toBe(before + 1)
  },
)

exampleTest(
  "enrolling in a sequence that isn't there, or for the wrong object, is refused",
  async () => {
    const { record } = await contact('Wrong')

    await expect(go(enroll('nope', 'contacts', record, staff))).rejects.toThrow(
      'Unknown campaign "nope"',
    )

    await expect(go(enroll('quick', 'deals', record, staff))).rejects.toThrow(
      'enrolls contacts, not deals',
    )
  },
)
