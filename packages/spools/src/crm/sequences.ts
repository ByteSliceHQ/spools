/**
 * When each email of a sequence (a campaign in crm.config.json) is due.
 *
 * Pure: no server imports, so it can be tested on its own. The engine that
 * stores enrolments and sends is `src/server/campaigns.ts`.
 */

/** "0m", "30m", "12h", "3d". */
export const durationPattern = /^(\d+)(m|h|d)$/

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

export function durationMs(d: string): number {
  const [, count, unit] = durationPattern.exec(d) ?? []

  // The pattern only matches with one of the three units, so anything else didn't match.
  if (unit !== 'm' && unit !== 'h' && unit !== 'd') {
    throw new Error(`Invalid duration "${d}"`)
  }

  return Number(count) * UNIT_MS[unit]
}

export type SequenceStep = { id: string; wait: string }

/** The hours email may be sent in, on the business's own clock. */
export type SendingHours = {
  /** "08:00" */
  from: string
  /** "18:00": the last minute is the one before. */
  to: string
  /** Monday to Friday only. */
  weekdaysOnly: boolean
}

const minutesOf = (clock: string): number => {
  const [h = '0', m = '0'] = clock.split(':')
  return Number(h) * 60 + Number(m)
}

/** Whether it is the weekend, and how many minutes past midnight it is, somewhere. */
type LocalClock = { weekend: boolean; minutes: number }

/** The day of the week and the minutes past midnight at an instant, in a time zone. */
function localClock(at: Date, zone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)

  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    weekend: part('weekday') === 'Sat' || part('weekday') === 'Sun',
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  }
}

/** Whether an instant is inside the sending hours. */
export function withinHours(at: Date, hours: SendingHours, zone: string): boolean {
  const { weekend, minutes } = localClock(at, zone)
  return (
    !(hours.weekdaysOnly && weekend) &&
    minutes >= minutesOf(hours.from) &&
    minutes < minutesOf(hours.to)
  )
}

/**
 * The instant itself when it is inside the sending hours, otherwise the start
 * of the next stretch that is: later the same day, the next morning, or Monday.
 */
export function deferToHours(at: Date, hours: SendingHours, zone: string): Date {
  const from = minutesOf(hours.from)
  let t = at

  // Ten steps is more than a week of closed days; the clock changing overnight costs one extra step.
  for (let i = 0; i < 10; i++) {
    if (withinHours(t, hours, zone)) {
      return t
    }

    const { weekend, minutes } = localClock(t, zone)
    const today = !(hours.weekdaysOnly && weekend) && minutes < from
    const wait = today ? from - minutes : 24 * 60 - minutes + from
    // On the minute: nobody needs a deferred email to leave at 08:00:37.
    t = new Date(Math.floor(t.getTime() / 60_000) * 60_000 + wait * 60_000)
    // The clocks changed on the way: land on the opening time, not an hour either side of it.
    const drift = from - localClock(t, zone).minutes

    if (drift !== 0 && Math.abs(drift) <= 120) {
      t = new Date(t.getTime() + drift * 60_000)
    }
  }

  return t
}

/**
 * When a step is due, counted from `from` (the enrolment, or the step before
 * it going out). A step with no wait is due at once, whatever the hour: someone
 * just asked for it. A step that was waited for is held to the sending hours.
 */
export function dueAt(step: SequenceStep, from: Date, hours?: SendingHours, zone = 'UTC'): Date {
  const wait = durationMs(step.wait)

  if (wait === 0) {
    return from
  }

  const due = new Date(from.getTime() + wait)
  return hours ? deferToHours(due, hours, zone) : due
}

/** The step that follows `stepId`: `null` when that was the last, `undefined` when the sequence no longer has `stepId`. */
export function stepAfter<S extends SequenceStep>(
  steps: readonly S[],
  stepId: string,
): S | null | undefined {
  const at = steps.findIndex((s) => s.id === stepId)

  if (at < 0) {
    return undefined
  }

  return steps[at + 1] ?? null
}
