import { describe, expect, test } from 'bun:test'

import raw from '../../../../apps/starter/crm.config.json'
import { crmConfigSchema } from '../../src/crm/config-schema'
import {
  deferToHours,
  dueAt,
  durationMs,
  type SendingHours,
  stepAfter,
  withinHours,
} from '../../src/crm/sequences'
import { sequencesTick, templateValues } from '../../src/server/campaigns'

const at = (iso: string) => new Date(iso)
const office: SendingHours = { from: '08:00', to: '18:00', weekdaysOnly: true }
const everyDay: SendingHours = { ...office, weekdaysOnly: false }

describe('durations', () => {
  test('minutes, hours and days', () => {
    expect(durationMs('0m')).toBe(0)
    expect(durationMs('30m')).toBe(30 * 60_000)
    expect(durationMs('12h')).toBe(12 * 3_600_000)
    expect(durationMs('3d')).toBe(3 * 86_400_000)
    expect(() => durationMs('soon')).toThrow('Invalid duration')
  })
})

describe('when a step is due', () => {
  // 2026-11-23 is a Monday.
  const monday9 = at('2026-11-23T09:00:00Z')

  test('a step with no wait is due at once, whatever the hour', () => {
    const night = at('2026-11-22T03:12:45Z') // Sunday, 03:12
    expect(dueAt({ id: 'a', wait: '0m' }, night)).toEqual(night)
    expect(dueAt({ id: 'a', wait: '0m' }, night, office, 'UTC')).toEqual(night)
  })

  test('without sending hours, a step is due exactly its wait later', () => {
    expect(dueAt({ id: 'b', wait: '2d' }, monday9)).toEqual(at('2026-11-25T09:00:00Z'))
    expect(dueAt({ id: 'b', wait: '90m' }, monday9)).toEqual(at('2026-11-23T10:30:00Z'))
  })

  test('with sending hours, a step due inside them is left alone', () => {
    expect(dueAt({ id: 'b', wait: '2d' }, monday9, office, 'UTC')).toEqual(
      at('2026-11-25T09:00:00Z'),
    )
  })

  test('a step due before opening waits for opening that day', () => {
    // Monday 03:30 + 1 day = Tuesday 03:30 -> Tuesday 08:00.
    expect(dueAt({ id: 'b', wait: '1d' }, at('2026-11-23T03:30:20Z'), office, 'UTC')).toEqual(
      at('2026-11-24T08:00:00Z'),
    )
  })

  test('a step due after closing waits for the next morning', () => {
    // Monday 19:00 + 1 day = Tuesday 19:00 -> Wednesday 08:00.
    expect(dueAt({ id: 'b', wait: '1d' }, at('2026-11-23T19:00:00Z'), office, 'UTC')).toEqual(
      at('2026-11-25T08:00:00Z'),
    )

    // Closing time itself is closed.
    expect(withinHours(at('2026-11-23T18:00:00Z'), office, 'UTC')).toBe(false)
    expect(withinHours(at('2026-11-23T17:59:00Z'), office, 'UTC')).toBe(true)
  })

  test('a step due at the weekend waits for Monday, unless weekends are allowed', () => {
    // Thursday 10:00 + 2 days = Saturday 10:00.
    const thursday = at('2026-11-26T10:00:00Z')

    expect(dueAt({ id: 'b', wait: '2d' }, thursday, office, 'UTC')).toEqual(
      at('2026-11-30T08:00:00Z'),
    )

    expect(dueAt({ id: 'b', wait: '2d' }, thursday, everyDay, 'UTC')).toEqual(
      at('2026-11-28T10:00:00Z'),
    )

    // Friday 19:00 -> Monday 08:00.
    expect(deferToHours(at('2026-11-27T19:00:00Z'), office, 'UTC')).toEqual(
      at('2026-11-30T08:00:00Z'),
    )
  })

  test("the hours are on the business's clock, not the server's", () => {
    // 13:30 UTC is 08:30 in New York in winter: open there, and 05:30 in Los Angeles: closed.
    const t = at('2026-11-23T13:30:00Z')
    expect(withinHours(t, office, 'America/New_York')).toBe(true)
    expect(withinHours(t, office, 'America/Los_Angeles')).toBe(false)
    expect(deferToHours(t, office, 'America/Los_Angeles')).toEqual(at('2026-11-23T16:00:00Z'))
  })

  test('the night the clocks change, opening time is still opening time', () => {
    // New York springs forward on Sunday 2026-03-08. Saturday 23:30 EST -> Sunday 08:00 EDT (12:00 UTC).
    expect(deferToHours(at('2026-03-08T04:30:00Z'), everyDay, 'America/New_York')).toEqual(
      at('2026-03-08T12:00:00Z'),
    )

    // And falls back on Sunday 2026-11-01. Saturday 23:30 EDT -> Sunday 08:00 EST (13:00 UTC).
    expect(deferToHours(at('2026-11-01T03:30:00Z'), everyDay, 'America/New_York')).toEqual(
      at('2026-11-01T13:00:00Z'),
    )
  })
})

describe('the step after', () => {
  const steps = [
    { id: 'a', wait: '0m' },
    { id: 'b', wait: '2d' },
  ]

  test('the next one, then none', () => {
    expect(stepAfter(steps, 'a')).toEqual({ id: 'b', wait: '2d' })
    expect(stepAfter(steps, 'b')).toBeNull()
  })

  test('a step the sequence no longer has', () => {
    expect(stepAfter(steps, 'removed')).toBeUndefined()
  })
})

describe('what calls the tick', () => {
  test('a server that stays up ticks itself; a serverless host needs the cron secret', () => {
    expect(sequencesTick({})).toBe(true)
    expect(sequencesTick({ SERVERLESS: '1' })).toBe(false)
    expect(sequencesTick({ SERVERLESS: '1', CRON_SECRET: 'short' })).toBe(false)
    expect(sequencesTick({ SERVERLESS: '1', CRON_SECRET: 'x'.repeat(32) })).toBe(true)
  })

  test('only "1" or "true" says the host is serverless', () => {
    expect(sequencesTick({ SERVERLESS: 'true' })).toBe(false)
    expect(sequencesTick({ SERVERLESS: '0' })).toBe(true)
    expect(sequencesTick({ SERVERLESS: 'false' })).toBe(true)
    expect(sequencesTick({ SERVERLESS: '' })).toBe(true)
  })
})

describe("a record's values in an email", () => {
  const closing = at('2026-12-04T00:00:00Z')
  const made = at('2026-11-23T15:04:00Z')
  const row = { id: 'c1', createdAt: made, updatedAt: made }

  test('a related record is its title, a choice its label, a date a date', () => {
    const contact = templateValues('contacts', {
      ...row,
      name: 'Ada Lopez',
      status: 'customer',
      companyId: 'co1',
      company: { id: 'co1', name: 'Acme Kitchens' },
      phone: null,
    })

    expect(contact['name']).toBe('Ada Lopez')
    expect(contact['company']).toBe('Acme Kitchens')
    expect(contact['status']).toBe('Customer')
    expect(contact['phone']).toBe('')
    expect(contact['createdAt']).not.toContain('GMT')

    const deal = templateValues('deals', { ...row, closeDate: closing, value: 4200 }, 'UTC')
    expect(deal['closeDate']).toBe('December 4, 2026')
    expect(deal['value']).toBe('4200')
  })

  test('a moment is told in the time zone the sequences keep', () => {
    const moment = { ...row, createdAt: at('2026-11-23T23:30:00Z') }

    expect(templateValues('contacts', moment, 'UTC')['createdAt']).toContain('November 23, 2026')

    expect(templateValues('contacts', moment, 'Australia/Sydney')['createdAt']).toContain(
      'November 24, 2026',
    )
  })

  test('nothing prints as an object', () => {
    const values = templateValues('contacts', {
      ...row,
      company: null,
      tags: ['a', 'b'],
      extra: { nested: true },
    })

    expect(Object.values(values).join(' ')).not.toContain('[object')
  })
})

describe('sending hours in the config', () => {
  const withHours = (sendingHours: unknown) =>
    crmConfigSchema.safeParse({ ...raw, app: { ...raw.app, sendingHours } })

  test('a window on a 24-hour clock, weekdays unless said otherwise', () => {
    const parsed = withHours({ from: '08:00', to: '18:00' })
    expect(parsed.success).toBe(true)

    expect(parsed.data?.app.sendingHours).toEqual({
      from: '08:00',
      to: '18:00',
      weekdaysOnly: true,
    })

    expect(withHours({ from: '08:00', to: '18:00', weekdaysOnly: false }).success).toBe(true)
  })

  test('mistakes are refused', () => {
    expect(withHours({ from: '18:00', to: '08:00' }).success).toBe(false)
    expect(withHours({ from: '8am', to: '18:00' }).success).toBe(false)
    expect(withHours({ from: '08:00', to: '24:00' }).success).toBe(false)
    expect(withHours({ from: '08:00' }).success).toBe(false)
  })

  test('left out, every email goes out when it is due', () => {
    expect(crmConfigSchema.parse(raw).app.sendingHours).toBeUndefined()
  })
})
